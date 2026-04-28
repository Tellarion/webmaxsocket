const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode-terminal');
const SessionManager = require('./session');
const { MaxSocketTransport } = require('./socketTransport');
const { Message, ChatAction, User } = require('./entities');
const { EventTypes, ChatActions } = require('./constants');
const { Opcode, DeviceType, getOpcodeName } = require('./opcodes');
const { UserAgentPayload } = require('./userAgent');
const { resolveIncomingLogMode, printIncomingLog } = require('./incomingLog');
const { parseQrTrackId } = require('./qrWebLogin');

/**
 * Загружает конфиг: { token, agent }
 */
function loadSessionConfig(configPath) {
  let resolved;
  if (path.isAbsolute(configPath)) {
    resolved = configPath;
  } else if (!/[\\/]/.test(configPath) && !configPath.endsWith('.json')) {
    resolved = path.join(process.cwd(), 'config', `${configPath}.json`);
  } else {
    resolved = path.join(process.cwd(), configPath);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Конфиг не найден: ${resolved}`);
  }
  const data = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(data);
}

/**
 * Понятная ошибка при отказе сервера отдать QR (часто qr_login.disabled для неофициального WEB-handshake).
 */
function throwIfGetQRRejected(payload) {
  if (!payload || !payload.error) {
    return;
  }
  const err = payload.error;
  const text =
    typeof err === 'string'
      ? err
      : err && typeof err.message === 'string'
        ? err.message
        : JSON.stringify(err);
  if (String(text).includes('qr_login.disabled')) {
    throw new Error(
      'Сервер Max отказал в выдаче QR (qr_login.disabled). Частые причины: устаревший appVersion в User-Agent (нужно ≥ 25.12.13), ' +
      'или отключение QR для данного клиента на стороне VK. Проверьте https://web.max.ru в браузере. ' +
      'Второй телефон к аккаунту можно добавить и обычным входом по номеру в приложении Max.'
    );
  }
  throw new Error(`QR request error: ${text}`);
}

/**
 * Основной клиент для работы с API Max
 */
class WebMaxClient extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.phone = options.phone || null;
    this.sessionName = options.name || options.session || 'default';
    this.apiUrl = options.apiUrl || 'wss://ws-api.oneme.ru/websocket';
    
    // Загрузка из config — token, ua (agent), device_type
    let agent = options.ua || options.agent || options.headerUserAgent || null;
    let configObj = {};
    const configPath = options.configPath || options.config;
    if (configPath) {
      configObj = loadSessionConfig(configPath);
      agent = agent || configObj.agent || configObj.ua || configObj.headerUserAgent || null;
    }

    const optTok = options.token;
    this._explicitOptionToken =
      optTok !== undefined && optTok !== null && String(optTok).trim() !== ''
        ? String(optTok).trim()
        : null;
    this._configFileToken =
      configPath &&
      configObj.token !== undefined &&
      configObj.token !== null &&
      String(configObj.token).trim() !== ''
        ? String(configObj.token).trim()
        : null;
    /** Сырые токены из опций/config (без sessions); приоритет при старте см. _resolveTokenForStart */
    this._providedToken = this._explicitOptionToken || this._configFileToken;
    this._saveTokenToSession = options.saveToken !== false;
    /** Сохранять пароль 2FA в sessions/*.json после успешного входа (для повторного полного входа без ввода). Отключить: saveTwofaPassword: false */
    this._saveTwofaPassword = options.saveTwofaPassword !== false;
    this.origin = options.origin || 'https://web.max.ru';
    /** Доп. заголовок для ws (например Referer при QR с max.ru, пока Origin остаётся web.max.ru — иначе 403). */
    this._wsReferer = options.referer || options.wsReferer || null;
    this.session = new SessionManager(this.sessionName);
    
    const deviceTypeMap = { 1: 'WEB', 2: 'ANDROID', 3: 'ANDROID' };
    const rawDeviceType = options.deviceType ?? configObj.device_type ?? configObj.deviceType ?? this.session.get('deviceType');
    let deviceType = deviceTypeMap[rawDeviceType] || rawDeviceType || 'WEB';
    deviceType = String(deviceType).toUpperCase() === 'IOS' ? 'ANDROID' : String(deviceType).toUpperCase();
    const androidUserAgent =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    const webUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const uaString =
      agent ||
      configObj.headerUserAgent ||
      configObj.ua ||
      this.session.get('headerUserAgent') ||
      (deviceType === 'ANDROID' ? androidUserAgent : webUserAgent);
    const webDefaults = {
      deviceType: deviceType,
      locale: options.locale || configObj.locale || this.session.get('locale') || 'ru',
      deviceLocale:
        options.deviceLocale ||
        configObj.deviceLocale ||
        configObj.locale ||
        this.session.get('deviceLocale') ||
        this.session.get('locale') ||
        'ru',
      osVersion:
        options.osVersion ||
        configObj.osVersion ||
        this.session.get('osVersion') ||
        (deviceType === 'ANDROID' ? '14' : 'Windows 11'),
      deviceName:
        options.deviceName ||
        configObj.deviceName ||
        this.session.get('deviceName') ||
        (deviceType === 'ANDROID' ? 'Android' : 'Chrome'),
      headerUserAgent: options.headerUserAgent || options.ua || uaString,
      // Ниже 25.12.13 сервер может отвечать qr_login.disabled на GET_QR (см. PyMax _login).
      appVersion: options.appVersion || configObj.appVersion || this.session.get('appVersion') || '26.14.1',
      screen:
        options.screen ||
        configObj.screen ||
        this.session.get('screen') ||
        (deviceType === 'ANDROID' ? '360x780 3.0x' : '1080x1920 1.0x'),
      timezone: options.timezone || configObj.timezone || this.session.get('timezone') || 'Europe/Moscow',
      buildNumber: options.buildNumber ?? configObj.buildNumber ?? this.session.get('buildNumber') ?? (deviceType === 'ANDROID' ? 6686 : undefined),
      clientSessionId: options.clientSessionId ?? configObj.clientSessionId ?? this.session.get('clientSessionId'),
      release: options.release ?? configObj.release
    };
    this._handshakeUserAgent = new UserAgentPayload(webDefaults);
    this.userAgent = this._handshakeUserAgent;
    
    this.deviceId = options.deviceId || this.session.get('deviceId') || uuidv4();
    if (!this.session.get('deviceId')) {
      this.session.set('deviceId', this.deviceId);
    }
    
    // Определяем тип транспорта: Socket для ANDROID, WebSocket для WEB
    this._useSocketTransport = (deviceType === 'ANDROID');
    this._socketTransport = null;
    
    this.ws = null;
    this.me = null;
    this.isConnected = false;
    this.isAuthorized = false;
    /** На TCP после первого LOGIN повторный sync — только новое TLS + LOGIN (19); op. 21 на сокете сервер отклоняет. */
    this._tcpLoginCompleted = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelay ?? 3000;
    
    // Protocol fields
    this.seq = 0;
    this.ver = 11;
    
    this.handlers = {
      [EventTypes.START]: [],
      [EventTypes.MESSAGE]: [],
      [EventTypes.MESSAGE_REMOVED]: [],
      [EventTypes.CHAT_ACTION]: [],
      [EventTypes.ERROR]: [],
      [EventTypes.DISCONNECT]: []
    };

    this.messageQueue = [];
    this.pendingRequests = new Map();
    this.debug =
      Boolean(options.debug) ||
      process.env.DEBUG === '1' ||
      process.env.WEBMAX_DEBUG === '1';
    this._authDebug = Boolean(options.authDebug) || process.env.WEBMAX_AUTH_DEBUG === '1';
    /** После успешного sync копировать sessions/<name>.json → <name>.last_ok.json */
    this._sessionBackupOnSuccess = options.sessionBackup !== false;
    /** Режим JSON-лога входящих: off | messages | verbose (см. logIncoming в README) */
    this._incomingLogMode = resolveIncomingLogMode(options);
    this._wireIncomingLogListeners();
    /** client id локальных исходящих сообщений (int32, часто ждут валидацию на сервере) */
    this._clientSendCid = 1 + Math.floor(Math.random() * 0xfffff);
    /** После HTTP POST видео/файла — ждём NOTIF_ATTACH */
    this._uploadPendingVideo = new Map();
    this._uploadPendingFile = new Map();
    /** Периодический sync() для продления/ротации токена (мс). 0 — выключено. Альтернативное имя: autoSyncIntervalMs */
    const refreshMs = Number(options.sessionRefreshIntervalMs ?? options.autoSyncIntervalMs ?? 0);
    this._sessionRefreshIntervalMs = Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : 0;
    this._sessionRefreshTimer = null;
    this._sessionRefreshRunning = false;
    /**
     * TCP (как веб): периодический исходящий PING (opcode 1) с `{ interactive: true }` (~30 с).
     * 0 — выключено. Имя опции: tcpInteractivePingMs.
     */
    const tcpPingRaw = options.tcpInteractivePingMs;
    const tcpPingMs =
      tcpPingRaw === undefined || tcpPingRaw === null ? 30000 : Number(tcpPingRaw);
    this._tcpInteractivePingMs =
      Number.isFinite(tcpPingMs) && tcpPingMs > 0 ? tcpPingMs : 0;
    this._tcpInteractiveTimer = null;
    /**
     * connectWithSession: после неудачного sync вызывать session.clear() перед authorize().
     * По умолчанию false — файл sessions/*.json сохраняется; при true — прежнее поведение «чистый лист».
     */
    this._clearSessionOnFailedSync = options.clearSessionOnFailedSync === true;
  }

  /**
   * Текущий режим лога входящих: `off` | `messages` | `verbose`.
   */
  get incomingLogMode() {
    return this._incomingLogMode;
  }

  /**
   * Ручной вывод в формате `[incoming:label]` (как внутренний лог).
   */
  logIncoming(label, payload) {
    printIncomingLog(label, payload);
  }

  _wireIncomingLogListeners() {
    if (this._incomingLogMode !== 'verbose') return;
    this.once('connected', () => {
      printIncomingLog('connected', { event: 'connected' });
    });
    this.on('raw_message', (data) => {
      printIncomingLog('raw_message', data);
    });
  }

  /**
   * Приоритет токена: явный options.token → сохранённая sessions/<name>.json → token из config.
   * Иначе после SMS в sessions лежит новый токен, а из config подставлялся старый и sync падал с «обновите config».
   */
  _resolveTokenForStart() {
    if (this._explicitOptionToken) {
      return { token: this._explicitOptionToken, source: 'options.token' };
    }
    const sessionTok = this.session.get('token');
    if (sessionTok && String(sessionTok).trim() !== '') {
      return { token: String(sessionTok).trim(), source: 'session_file' };
    }
    if (this._configFileToken) {
      return { token: this._configFileToken, source: 'config_file' };
    }
    return { token: null, source: null };
  }

  _logAuthContext(phase, extra = {}) {
    if (!this.debug && !this._authDebug) return;
    let libVersion = 'unknown';
    try {
      libVersion = require(path.join(__dirname, '..', 'package.json')).version;
    } catch (_) {
      /* ignore */
    }
    const tok = this._token || this.session.get('token');
    const tokenPreview =
      tok && String(tok).length > 14
        ? `${String(tok).slice(0, 8)}…${String(tok).slice(-4)}`
        : tok
          ? '(short)'
          : '(none)';
    const payload = {
      phase,
      libVersion,
      node: process.version,
      cwd: process.cwd(),
      sessionName: this.sessionName,
      sessionPath: this.session.sessionFile,
      backupPath: path.join(this.session.sessionDir, `${this.sessionName}.last_ok.json`),
      tokenPreview,
      deviceId: this.deviceId,
      userAgent: this.userAgent.toJSON(),
      ...extra
    };
    console.log('[webmaxsocket:auth]', JSON.stringify(payload, null, 2));
  }

  /**
   * Регистрация обработчика события start
   */
  onStart(handler) {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.START].push(handler);
      return handler;
    }
    // Поддержка декоратора
    return (fn) => {
      this.handlers[EventTypes.START].push(fn);
      return fn;
    };
  }

  /**
   * Регистрация обработчика сообщений
   */
  onMessage(handler) {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.MESSAGE].push(handler);
      return handler;
    }
    return (fn) => {
      this.handlers[EventTypes.MESSAGE].push(fn);
      return fn;
    };
  }

  /**
   * Регистрация обработчика удаленных сообщений
   */
  onMessageRemoved(handler) {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.MESSAGE_REMOVED].push(handler);
      return handler;
    }
    return (fn) => {
      this.handlers[EventTypes.MESSAGE_REMOVED].push(fn);
      return fn;
    };
  }

  /**
   * Регистрация обработчика действий в чате
   */
  onChatAction(handler) {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.CHAT_ACTION].push(handler);
      return handler;
    }
    return (fn) => {
      this.handlers[EventTypes.CHAT_ACTION].push(fn);
      return fn;
    };
  }

  /**
   * Регистрация обработчика ошибок
   */
  onError(handler) {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.ERROR].push(handler);
      return handler;
    }
    return (fn) => {
      this.handlers[EventTypes.ERROR].push(fn);
      return fn;
    };
  }

  /**
   * Запуск клиента
   */
  async start() {
    try {
      console.log('🚀 Запуск WebMax клиента...');
      
      // Подключаемся к WebSocket или Socket
      await this.connect();
      
      const { token: tokenToUse, source: tokenSource } = this._resolveTokenForStart();

      if (tokenToUse) {
        if (tokenSource === 'session_file') {
          console.log('✅ Найдена сохраненная сессия');
        } else {
          console.log('✅ Вход по токену (token auth)');
          if (this._saveTokenToSession) {
            this.session.set('token', tokenToUse);
            this.session.set('deviceId', this.deviceId);
          }
        }
        this._token = tokenToUse;

        this._logAuthContext('start:before_sync', { tokenSource });

        try {
          await this.sync();
          this.isAuthorized = true;
        } catch (error) {
          const fromConfigOrOptions =
            tokenSource === 'config_file' || tokenSource === 'options.token';
          this._explicitOptionToken = null;
          this._configFileToken = null;
          this._providedToken = null;
          if (fromConfigOrOptions) {
            throw new Error(
              `Токен недействителен или сессия истекла. Обновите token в config или удалите/очистите token в config, чтобы использовалась актуальная сессия из sessions/. (${error.message})`
            );
          }
          console.log('⚠️ Сессия истекла, требуется повторная авторизация');
          if (this.debug || this._authDebug) {
            console.log(
              '[webmaxsocket:auth] Подсказка: для восстановления попробуйте скопировать sessions/' +
                this.sessionName +
                '.last_ok.json поверх sessions/' +
                this.sessionName +
                '.json (если копия есть).'
            );
          }
          await this.authorize();
        }
      } else {
        console.log('📱 Требуется авторизация');
        await this.authorize();
      }

      // Запускаем обработчики start
      await this.triggerHandlers(EventTypes.START);

      this._scheduleSessionRefreshIfNeeded();

      console.log('\n✅ Клиент запущен успешно!');
      
    } catch (error) {
      console.error('❌ Ошибка при запуске клиента:', error);
      await this.triggerHandlers(EventTypes.ERROR, error);
      throw error;
    }
  }


  /**
   * Запрос QR-кода для авторизации (только для device_type="WEB")
   */
  async requestQR() {
    console.log('Запрос QR-кода для авторизации...');
    
    const response = await this.sendAndWait(Opcode.GET_QR, undefined);

    throwIfGetQRRejected(response.payload);

    return response.payload;
  }

  /**
   * Проверка статуса QR-кода
   */
  async checkQRStatus(trackId) {
    const response = await this.sendAndWait(Opcode.GET_QR_STATUS, { trackId });
    
    if (response.payload && response.payload.error) {
      throw new Error(`QR status error: ${JSON.stringify(response.payload.error)}`);
    }
    
    return response.payload;
  }

  /**
   * На TCP после ответа LOGIN сервер может закрыть сокет — перед следующим RPC переподключаемся и снова LOGIN.
   */
  async _ensureTcpSocketReadyForRpc() {
    const st = this._socketTransport;
    if (st && st.socket && !st.socket.destroyed) return;
    const token = this._token || this.session.get('token');
    if (!token) {
      throw new Error('Нет токена для переподключения TCP');
    }
    console.log('Переподключение TCP (сокет закрыт после предыдущего запроса)…');
    this.isConnected = false;
    await this.connect();
    this._token = token;
    await this.sync();
    this.isAuthorized = true;
  }

  /**
   * Завершение авторизации по QR-коду
   * @param {string} trackId — UUID (веб GET_QR) или opaque token `qr_…` (max.ru/qr/v1/auth)
   */
  async loginByQR(trackId) {
    if (this._useSocketTransport) {
      await this._ensureTcpSocketReadyForRpc();
    }
    const id = String(trackId).trim();
    const payload = id.startsWith('qr_') ? { token: id } : { trackId: id };
    const response = await this.sendAndWait(Opcode.LOGIN_BY_QR, payload);

    if (response.payload && response.payload.error) {
      throw new Error(`QR login error: ${JSON.stringify(response.payload.error)}`);
    }

    return response.payload;
  }

  async approveQR(qrLink) {
    if (this._useSocketTransport) {
      await this._ensureTcpSocketReadyForRpc();
    }
    if (!this.isAuthorized) {
      throw new Error('Требуется авторизованная сессия для одобрения QR');
    }
    const link = String(qrLink).trim();
    const response = await this.sendAndWait(Opcode.AUTH_QR_APPROVE, { qrLink: link });
    if (response.payload && response.payload.error) {
      throw new Error(`QR approve error: ${JSON.stringify(response.payload.error)}`);
    }
    return response.payload;
  }

  /**
   * LOGIN_BY_QR: как web.max.ru — сначала только trackId (HAR), затем запасные варианты + токен аккаунта.
   */
  async _loginByQrWebMax(web, trackId, accountToken) {
    const id = String(trackId).trim();
    if (id.startsWith('qr_')) {
      const response = await web.sendAndWait(Opcode.LOGIN_BY_QR, { token: id });
      if (response.payload && response.payload.error) {
        throw new Error(`QR login error: ${JSON.stringify(response.payload.error)}`);
      }
      return response.payload;
    }
    const payloads = [{ trackId: id }, { track: id }, { authTrackId: id }];
    if (accountToken) {
      payloads.push(
        { trackId: id, token: accountToken },
        { track: id, token: accountToken },
        { trackId: id, account_token: accountToken },
        { track: id, account_token: accountToken }
      );
    }

    let lastErr;
    for (const payload of payloads) {
      try {
        const response = await web.sendAndWait(Opcode.LOGIN_BY_QR, payload);
        if (response.payload && response.payload.error) {
          const err = response.payload.error;
          const msg =
            typeof err === 'string'
              ? err
              : err && typeof err.message === 'string'
                ? err.message
                : response.payload.localizedMessage || JSON.stringify(err);
          lastErr = new Error(msg);
          if (/track\.not\.found/i.test(String(msg))) {
            throw new Error(
              `${msg}\n` +
                'Трек QR устарел или уже использован. Откройте web.max.ru, дождитесь нового QR и сразу сохраните qr.png.'
            );
          }
          if (/proto\.payload/i.test(String(msg))) {
            continue;
          }
          continue;
        }
        return response.payload;
      } catch (e) {
        lastErr = e;
        if (e && e.message && /track\.not\.found|Трек QR устарел/i.test(e.message)) {
          throw e;
        }
      }
    }
    throw lastErr || new Error('LOGIN_BY_QR не удался');
  }

  /**
   * Как в web.max.ru (HAR): опрос GET_QR_STATUS, пока status.loginAvailable !== true (после скана в приложении Max).
   * Без этого LOGIN_BY_QR часто даёт track.not.found — трек не «готов» к подтверждению.
   */
  async _waitForWebQrLoginAvailable(web, trackId, options = {}) {
    const pollingInterval = options.pollingInterval ?? 5000;
    const defaultTtlMs = options.defaultTtlMs ?? 180000;
    let expiresAt = Date.now() + defaultTtlMs;

    console.log(
      '\n📱 Нужно подтверждение с телефона (как в официальном web-клиенте):\n' +
        '   Max на телефоне → раздел с входом по QR к веб-версии / устройства — наведите на тот же QR (тот же аккаунт).\n' +
        '   Чтобы вкладка браузера не отправила LOGIN_BY_QR раньше скрипта: после сохранения qr.png закройте вкладку web.max.ru,\n' +
        '   затем запустите этот скрипт и отсканируйте QR с файла/второго монитора.\n' +
        '   Ожидание loginAvailable на сервере…'
    );

    while (true) {
      const now = Date.now();
      if (now >= expiresAt) {
        throw new Error(
          'Нет loginAvailable до истечения времени: отсканируйте QR приложением на тот же аккаунт или обновите qr.png.'
        );
      }

      const statusResponse = await web.checkQRStatus(trackId);
      if (statusResponse.status && statusResponse.status.expiresAt != null) {
        const ex = Number(statusResponse.status.expiresAt);
        if (Number.isFinite(ex)) {
          expiresAt = Math.min(expiresAt, ex);
        }
      }
      if (statusResponse.status && statusResponse.status.loginAvailable) {
        console.log('\n✅ Сервер готов к LOGIN_BY_QR (loginAvailable).');
        return;
      }

      process.stdout.write('.');

      const wait = Math.min(
        pollingInterval,
        Math.max(0, expiresAt - Date.now())
      );
      await new Promise((r) => setTimeout(r, wait || pollingInterval));
    }
  }

  /**
   * Подтверждение входа по QR: новое TCP-соединение (только SESSION_INIT), затем LOGIN_BY_QR — без LOGIN на этом сокете.
   */
  async _approveWebLoginByQrViaEphemeralTcp(trackId) {
    const accountToken = this._token || this.session.get('token');
    const transport = new MaxSocketTransport({
      deviceId: this.deviceId,
      deviceType: this.userAgent.deviceType,
      ua: this.userAgent.headerUserAgent,
      debug: this.debug,
    });
    await transport.connect();
    await transport.handshake(this.userAgent);
    try {
      const id = String(trackId).trim();
      if (id.startsWith('qr_')) {
        const result = await transport.sendAndWait(Opcode.LOGIN_BY_QR, { token: id });
        return result.payload;
      }
      const payloads = [
        { trackId: id },
        { track: id },
        { trackId: id, token: accountToken },
        { track: id, token: accountToken },
      ];
      let lastErr;
      for (const payload of payloads) {
        try {
          const result = await transport.sendAndWait(Opcode.LOGIN_BY_QR, payload);
          return result.payload;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('LOGIN_BY_QR (TCP) не удался');
    } finally {
      await transport.close();
    }
  }

  /**
   * Подтверждение входа в web.max по QR при основной сессии на TCP: отдельный WebSocket + LOGIN + LOGIN_BY_QR.
   * На том же TCP после LOGIN сервер не принимает LOGIN_BY_QR («Недопустимое состояние сессии»).
   * WEB-клиент: не используем TCP deviceId (даёт login.cred); берём webDeviceId из сессии или новый UUID.
   * Сначала пробуем webToken для sync, затем основной token. Без успешного sync LOGIN_BY_QR часто даёт auth_by_track.no.attempts.
   */
  async _approveWebLoginByQrViaEphemeralWeb(trackId, options = {}, qrSource = '') {
    const {
      retry = true,
      saveWebSession = true,
      waitForPhoneScan = true,
      qrPollingInterval = 5000,
    } = options;
    const accountToken = this._token || this.session.get('token');
    if (!accountToken) {
      throw new Error('Нет токена сессии');
    }

    const refererForMaxQr =
      /https?:\/\/max\.ru\//i.test(String(qrSource)) && !/web\.max\.ru/i.test(String(qrSource))
        ? 'https://max.ru/'
        : null;

    const webUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
    const webDeviceId = this.session.get('webDeviceId') || uuidv4();

    const ephemeralName = `_web_qr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const web = new this.constructor({
      name: ephemeralName,
      deviceType: 'WEB',
      deviceId: webDeviceId,
      // Не делим clientSessionId с параллельным TCP — иначе сервер может обрывать WS (1006).
      clientSessionId: Math.floor(Math.random() * 0x7fffffff),
      headerUserAgent: webUa,
      appVersion: '26.3.9',
      screen: '1920x1080 1.0x',
      osVersion: 'Windows 11',
      deviceName: 'Chrome',
      saveToken: false,
      debug: this.debug,
      apiUrl: this.apiUrl,
      origin: 'https://web.max.ru',
      referer: refererForMaxQr,
      maxReconnectAttempts: 0
    });
    web.handleReconnect = () => {};

    const wrapTrackError = (e) => {
      const m = e && e.message ? e.message : String(e);
      if (/auth_by_track|no\.attempts|Недопустимое состояние|track\.not\.found/i.test(m)) {
        return new Error(
          `${m}\n` +
            'Подсказка: WebSocket принимает только Origin web.max.ru; для max.ru/:auth/ добавлен Referer. Сделайте новый скрин qr.png сразу после появления QR; старый трек даёт track.not.found.'
        );
      }
      return e;
    };

    try {
      console.log(
        `Отдельное WebSocket (Origin=web.max.ru${refererForMaxQr ? ', Referer=max.ru' : ''}): ws-api принимает только Origin web.max.ru; при QR с max.ru добавлен Referer.`
      );
      await web.connect();

      const webTok = this.session.get('webToken');
      let syncOk = false;
      // TCP-токен на WEB даёт login.cred и сервер часто рвёт сокет — не вызываем sync с ним.
      // Только отдельный webToken из прошлого входа в web.max.
      if (webTok && webTok !== accountToken) {
        try {
          web._token = webTok;
          await web.sync();
          syncOk = true;
          web.isAuthorized = true;
          if (saveWebSession && web.deviceId) {
            this.session.set('webDeviceId', web.deviceId);
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          console.log(`WEB LOGIN (sync) с webToken: ${msg}`);
        }
      }

      if (waitForPhoneScan) {
        await this._waitForWebQrLoginAvailable(web, trackId, {
          pollingInterval: qrPollingInterval,
        });
      }

      const attempts = retry ? 2 : 1;
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const wsOpen = web.ws && web.ws.readyState === WebSocket.OPEN;
          if (!web.isConnected || !wsOpen) {
            console.log('Переподключение WebSocket перед LOGIN_BY_QR (после ошибки LOGIN сокет часто закрывается)…');
            if (web.ws) {
              try {
                web.ws.removeAllListeners();
              } catch (_) {}
              try {
                web.ws.close();
              } catch (_) {}
              web.ws = null;
            }
            web.isConnected = false;
            web.pendingRequests.clear();
            await web.connect();
          }

          let loginData;
          if (syncOk) {
            loginData = await this._loginByQrWebMax(web, trackId, null);
          } else {
            loginData = await this._loginByQrWebMax(web, trackId, accountToken);
          }

          if (saveWebSession && loginData && typeof loginData === 'object') {
            this.session.set('webQrTrackId', trackId);
            const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
            const wtoken = loginAttrs && loginAttrs.token;
            if (wtoken) {
              this.session.set('webToken', wtoken);
            }
            if (loginData.deviceId != null) {
              this.session.set('webDeviceId', loginData.deviceId);
            }
            if (loginData.clientSessionId != null) {
              this.session.set('webClientSessionId', loginData.clientSessionId);
            }
          }

          console.log('✅ Вход в веб-версию по QR подтверждён (LOGIN_BY_QR через WebSocket)');
          return loginData;
        } catch (e) {
          lastErr = wrapTrackError(e);
          if (attempt < attempts) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          throw lastErr;
        }
      }
      throw lastErr;
    } finally {
      try {
        await web.stop();
        web.session.destroy();
      } catch (_) {}
    }
  }

  /**
   * Подтвердить вход в веб-версию (web.max.ru) по URL из QR или trackId,
   * используя уже авторизованную сессию (в т.ч. TCP после SMS/токена).
   * Аналог сценария с `qr_url` + `account_token` на сторонних сервисах: здесь токен уже в сессии.
   *
   * @param {string} qrUrlOrTrackId — полный URL из QR, либо UUID trackId
   * @param {{ retry?: boolean, saveWebSession?: boolean, waitForPhoneScan?: boolean, qrPollingInterval?: number }} [options]
   * @returns {Promise<object>} payload ответа LOGIN_BY_QR
   */
  async approveWebLoginByQr(qrUrlOrTrackId, options = {}) {
    const { retry = true, saveWebSession = true } = options;

    const trackId = parseQrTrackId(qrUrlOrTrackId);
    if (!trackId) {
      throw new Error(
        'Не удалось извлечь идентификатор из QR: ожидается URL max.ru/qr/v1/auth?token=qr_…, web.max с trackId или UUID'
      );
    }

    const token = this._token || this.session.get('token');
    if (!token) {
      throw new Error('Нет токена в сессии для подтверждения входа');
    }

    if (this._useSocketTransport) {
      if (!this.isAuthorized) {
        throw new Error(
          'Нужна авторизованная сессия: выполните connect() + sync() с действующим токеном'
        );
      }
      if (process.env.MAX_QR_TRY_TCP_FIRST === '1') {
        try {
          const loginData = await this._approveWebLoginByQrViaEphemeralTcp(trackId);
          if (saveWebSession && loginData && typeof loginData === 'object') {
            this.session.set('webQrTrackId', trackId);
            const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
            const wtoken = loginAttrs && loginAttrs.token;
            if (wtoken) {
              this.session.set('webToken', wtoken);
            }
            if (loginData.deviceId != null) {
              this.session.set('webDeviceId', loginData.deviceId);
            }
            if (loginData.clientSessionId != null) {
              this.session.set('webClientSessionId', loginData.clientSessionId);
            }
          }
          console.log('✅ Вход в веб-версию по QR подтверждён (LOGIN_BY_QR, новое TCP-соединение)');
          return loginData;
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          console.log(`LOGIN_BY_QR по новому TCP: ${msg} — пробуем WebSocket (Origin web.max.ru)…`);
        }
      }
      return await this._approveWebLoginByQrViaEphemeralWeb(trackId, options, qrUrlOrTrackId);
    }

    if (!this.isConnected) {
      throw new Error('Нет соединения: сначала await client.connect()');
    }
    if (!this.isAuthorized) {
      throw new Error(
        'Нужна авторизованная сессия: выполните start() или connect() + sync() с действующим токеном'
      );
    }

    let lastErr;
    const attempts = retry ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const loginData = await this.loginByQR(trackId);

        if (saveWebSession && loginData && typeof loginData === 'object') {
          this.session.set('webQrTrackId', trackId);
          const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
          const wtoken = loginAttrs && loginAttrs.token;
          if (wtoken) {
            this.session.set('webToken', wtoken);
          }
          if (loginData.deviceId != null) {
            this.session.set('webDeviceId', loginData.deviceId);
          }
          if (loginData.clientSessionId != null) {
            this.session.set('webClientSessionId', loginData.clientSessionId);
          }
        }

        console.log('✅ Вход в веб-версию по QR подтверждён (LOGIN_BY_QR)');
        return loginData;
      } catch (e) {
        lastErr = e;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  /**
   * Опрос статуса QR-кода
   */
  async pollQRStatus(trackId, pollingInterval, expiresAt) {
    console.log('Ожидание сканирования QR-кода...');
    
    while (true) {
      // Проверяем не истек ли QR-код
      const now = Date.now();
      if (now >= expiresAt) {
        throw new Error('QR-код истек. Перезапустите бот для получения нового.');
      }
      
      // Ждем указанный интервал
      await new Promise(resolve => setTimeout(resolve, pollingInterval));
      
      try {
        const statusResponse = await this.checkQRStatus(trackId);
        
        if (statusResponse.status && statusResponse.status.loginAvailable) {
          console.log('✅ QR-код отсканирован!');
          return true;
        }
        
        // Продолжаем опрос
        process.stdout.write('.');
        
      } catch (error) {
        console.error('\nОшибка при проверке статуса QR:', error.message);
        throw error;
      }
    }
  }

  /**
   * Вывести в консоль QR-код для привязки нового устройства (тот же поток, что и веб-вход).
   * Требуется уже авторизованная сессия (после SMS/QR и sync).
   * На телефоне: Профиль → Устройства / Безопасность → Подключить устройство (QR).
   *
   * @param {object} [options]
   * @param {boolean} [options.waitForScan=true] — ждать, пока QR отсканируют
   * @param {boolean} [options.small=true] — компактный QR в терминале
   * @returns {Promise<{ qrLink: string, trackId: string, pollingInterval: number, expiresAt: number }>}
   */
  async showLinkDeviceQR(options = {}) {
    const { waitForScan = true, small = true } = options;

    if (!this.isConnected) {
      throw new Error('Нет соединения: сначала await client.connect()');
    }
    if (!this.isAuthorized) {
      throw new Error('Нужна авторизация: войдите в аккаунт и выполните sync, затем вызывайте showLinkDeviceQR');
    }

    // После LOGIN по TCP сервер не принимает GET_QR («Недопустимое состояние сессии») — тот же QR, что в веб-клиенте, только до авторизации по WebSocket.
    if (this._useSocketTransport) {
      return await this._showLinkDeviceQRViaEphemeralWeb(options);
    }

    console.log('Запрос QR-кода для привязки устройства...');
    const response = await this.sendAndWait(Opcode.GET_QR, undefined);

    throwIfGetQRRejected(response.payload);

    const qrData = response.payload;
    if (!qrData.qrLink || !qrData.trackId || !qrData.pollingInterval || !qrData.expiresAt) {
      throw new Error('Неполные данные QR-кода от сервера');
    }

    await this._printLinkDeviceQRConsole(qrData.qrLink, small);
    console.log('\n💡 Или откройте ссылку: ' + qrData.qrLink);
    console.log('='.repeat(70) + '\n');

    if (waitForScan) {
      await this.pollQRStatus(qrData.trackId, qrData.pollingInterval, qrData.expiresAt);
      console.log('\n✅ Устройство подключено. Проверьте вход на телефоне.');
    }

    return {
      qrLink: qrData.qrLink,
      trackId: qrData.trackId,
      pollingInterval: qrData.pollingInterval,
      expiresAt: qrData.expiresAt
    };
  }

  _printLinkDeviceQRConsole(qrLink, small = true) {
    console.log('\n' + '='.repeat(70));
    console.log('📱 ПРИВЯЗКА НОВОГО УСТРОЙСТВА');
    console.log('='.repeat(70));
    console.log('\nНа телефоне откройте Max — как при добавлении устройства в приложении:');
    console.log('➡️  Профиль → Устройства / Безопасность → Подключить устройство (вход по QR)');
    console.log('📸 Наведите камеру на QR ниже — это тот же поток, что у веб-клиента:\n');
    return new Promise((resolve) => {
      qrcode.generate(qrLink, { small }, (qrCode) => {
        console.log(qrCode);
        resolve();
      });
    });
  }

  /**
   * QR для привязки устройства при основной сессии на TCP (ANDROID): кратковременный WEB-клиент без LOGIN.
   */
  async _showLinkDeviceQRViaEphemeralWeb(options = {}) {
    const { waitForScan = true, small = true } = options;
    const ephemeralName = `_link_qr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const webQr = new this.constructor({
      name: ephemeralName,
      deviceType: 'WEB',
      debug: this.debug,
      apiUrl: this.apiUrl,
      origin: this.origin,
      maxReconnectAttempts: 0
    });

    try {
      console.log(
        'Отдельное WebSocket-подключение (как у web.max.ru): на уже залогиненном TCP запрос QR другим способом недоступен.'
      );
      await webQr.connect();

      const response = await webQr.sendAndWait(Opcode.GET_QR, undefined);
      throwIfGetQRRejected(response.payload);

      const qrData = response.payload;
      if (!qrData.qrLink || !qrData.trackId || !qrData.pollingInterval || !qrData.expiresAt) {
        throw new Error('Неполные данные QR-кода от сервера');
      }

      await this._printLinkDeviceQRConsole(qrData.qrLink, small);

      console.log('\n💡 Или откройте ссылку: ' + qrData.qrLink);
      console.log('='.repeat(70) + '\n');

      if (waitForScan) {
        await webQr.pollQRStatus(qrData.trackId, qrData.pollingInterval, qrData.expiresAt);
        await webQr.loginByQR(qrData.trackId);
        console.log('\n✅ Устройство подключено. Проверьте телефон.');
      }

      return {
        qrLink: qrData.qrLink,
        trackId: qrData.trackId,
        pollingInterval: qrData.pollingInterval,
        expiresAt: qrData.expiresAt
      };
    } finally {
      try {
        await webQr.stop();
        webQr.session.destroy();
      } catch (_) {}
    }
  }

  /**
   * Авторизация через QR-код
   */
  async authorizeByQR() {
    try {
      console.log('Запрос QR-кода для авторизации...');
      
      const qrData = await this.requestQR();
      
      if (!qrData.qrLink || !qrData.trackId || !qrData.pollingInterval || !qrData.expiresAt) {
        throw new Error('Неполные данные QR-кода от сервера');
      }
      
      console.log('\n' + '='.repeat(70));
      console.log('🔐 АВТОРИЗАЦИЯ ЧЕРЕЗ QR-КОД');
      console.log('='.repeat(70));
      console.log('\n📱 На телефоне: Профиль → Устройства / Безопасность → Подключить устройство');
      console.log('📸 Отсканируйте QR-код ниже:\n');
      
      // Отображаем QR-код в консоли (ждём вывод, затем опрос статуса)
      await new Promise((resolve) => {
        qrcode.generate(qrData.qrLink, { small: true }, (qrCode) => {
          console.log(qrCode);
          resolve();
        });
      });
      
      console.log('\n💡 Или откройте ссылку: ' + qrData.qrLink);
      console.log('='.repeat(70) + '\n');
      
      // Опрашиваем статус
      await this.pollQRStatus(qrData.trackId, qrData.pollingInterval, qrData.expiresAt);
      
      // Получаем токен
      console.log('\n\nПолучение токена авторизации...');
      const loginData = await this.loginByQR(qrData.trackId);
      
      const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
      const token = loginAttrs && loginAttrs.token;
      
      if (!token) {
        throw new Error('Токен не получен из ответа');
      }
      
      // Сохраняем токен и все данные сессии для TCP подключения
      this.session.set('token', token);
      this.session.set('deviceId', this.deviceId);
      this.session.set('clientSessionId', this.userAgent.clientSessionId);
      this.session.set('deviceType', 'ANDROID'); // Переключаемся на Android TCP при следующем запуске
      this.session.set('headerUserAgent', this.userAgent.headerUserAgent);
      this.session.set('appVersion', this.userAgent.appVersion);
      this.session.set('osVersion', this.userAgent.osVersion);
      this.session.set('deviceName', this.userAgent.deviceName);
      this.session.set('screen', this.userAgent.screen);
      this.session.set('timezone', this.userAgent.timezone);
      this.session.set('locale', this.userAgent.locale);
      this.session.set('buildNumber', this.userAgent.buildNumber);
      
      this.isAuthorized = true;
      this._token = token;
      
      console.log('✅ Авторизация через QR-код успешна!');
      console.log('💡 При следующем запуске будет использоваться TCP Socket транспорт');
      
      // Выполняем sync
      await this.sync();
      
    } catch (error) {
      console.error('Ошибка QR авторизации:', error);
      throw error;
    }
  }

  /**
   * Авторизация по номеру телефона через SMS (ANDROID)
   */
  async authorizeBySMS(phone) {
    if (!this._useSocketTransport) {
      throw new Error('SMS авторизация доступна только для ANDROID (используйте deviceType: "ANDROID")');
    }

    try {
      console.log('📱 Авторизация по номеру телефона...');
      
      // Нормализация номера телефона
      let cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.startsWith('8') && cleanPhone.length === 11) {
        cleanPhone = '7' + cleanPhone.slice(1);
      } else if (cleanPhone.startsWith('9') && cleanPhone.length === 10) {
        cleanPhone = '7' + cleanPhone;
      }
      const normalizedPhone = '+' + cleanPhone;

      console.log(`📤 Запрос кода на номер: ${normalizedPhone}`);
      
      if (!this._socketTransport) {
        throw new Error('Socket транспорт не инициализирован');
      }

      // Запрос кода
      const tempToken = await this._socketTransport.requestCode(normalizedPhone);
      
      if (!tempToken) {
        throw new Error('Не получен временный токен');
      }

      console.log('✅ Код отправлен! Ожидаем ввода кода...');
      
      return {
        tempToken,
        phone: normalizedPhone,
        sendCode: async (code) => {
          console.log('🔐 Проверка кода...');

          const authResponse = await this._socketTransport.sendCode(tempToken, code);

          const pc =
            authResponse && authResponse.passwordChallenge != null
              ? authResponse.passwordChallenge
              : null;
          const trackId =
            pc &&
            (() => {
              const t = pc.trackId ?? pc.track_id;
              return t != null && String(t).trim() !== '' ? String(t).trim() : null;
            })();

          if (pc && trackId) {
            const hint = pc.hint != null ? String(pc.hint) : '';
            const email = pc.email != null ? String(pc.email) : '';
            if (this.debug || this._authDebug) {
              console.log('[webmaxsocket:auth] passwordChallenge: trackId=%s hint=%s', trackId, hint || '(empty)');
            }
            console.log('🔒 Требуется пароль 2FA (как в приложении Max).');
            if (hint) console.log('   Подсказка:', hint);
            if (email) console.log('   Email в challenge:', email);

            return {
              needsPassword: true,
              passwordChallenge: pc,
              trackId,
              sendPassword: async (password) => {
                if (!password || !String(password).trim()) {
                  throw new Error('Пустой пароль 2FA');
                }
                console.log('🔐 Проверка пароля 2FA...');
                const afterPwd = await this._socketTransport.sendLogin2FAPassword(trackId, String(password).trim());
                const token = afterPwd?.tokenAttrs?.LOGIN?.token;
                if (!token) {
                  throw new Error('Токен не получен после ввода пароля 2FA');
                }
                this.session.set('token', token);
                this.session.set('deviceId', this.deviceId);
                this.session.set('clientSessionId', this.userAgent.clientSessionId);
                this.session.set('deviceType', this.userAgent.deviceType);
                this.session.set('headerUserAgent', this.userAgent.headerUserAgent);
                this.session.set('appVersion', this.userAgent.appVersion);
                this.session.set('osVersion', this.userAgent.osVersion);
                this.session.set('deviceName', this.userAgent.deviceName);
                this.session.set('screen', this.userAgent.screen);
                this.session.set('timezone', this.userAgent.timezone);
                this.session.set('locale', this.userAgent.locale);
                this.session.set('buildNumber', this.userAgent.buildNumber);
                this.isAuthorized = true;
                this._token = token;
                console.log('✅ Авторизация по SMS + 2FA успешна!');
                this._logAuthContext('sms:after_login', { tokenSource: 'sms_2fa' });
                await this.sync();
                if (this._saveTwofaPassword) {
                  this.session.set('twofaPassword', String(password).trim());
                }
                return token;
              }
            };
          }

          const token = authResponse?.tokenAttrs?.LOGIN?.token;

          if (!token) {
            throw new Error('Токен не получен из ответа');
          }

          // Сохраняем сессию
          this.session.set('token', token);
          this.session.set('deviceId', this.deviceId);
          this.session.set('clientSessionId', this.userAgent.clientSessionId);
          this.session.set('deviceType', this.userAgent.deviceType);
          this.session.set('headerUserAgent', this.userAgent.headerUserAgent);
          this.session.set('appVersion', this.userAgent.appVersion);
          this.session.set('osVersion', this.userAgent.osVersion);
          this.session.set('deviceName', this.userAgent.deviceName);
          this.session.set('screen', this.userAgent.screen);
          this.session.set('timezone', this.userAgent.timezone);
          this.session.set('locale', this.userAgent.locale);
          this.session.set('buildNumber', this.userAgent.buildNumber);

          this.isAuthorized = true;
          this._token = token;

          console.log('✅ Авторизация по SMS успешна!');
          this._logAuthContext('sms:after_login', { tokenSource: 'sms' });

          // Выполняем sync
          await this.sync();

          return token;
        }
      };
      
    } catch (error) {
      console.error('Ошибка SMS авторизации:', error);
      throw error;
    }
  }

  /**
   * Авторизация пользователя (QR-код для WEB, SMS для ANDROID)
   */
  async authorize(phone = null) {
    if (this._useSocketTransport && phone) {
      // SMS авторизация для ANDROID
      console.log('🔐 Авторизация через SMS');
      return await this.authorizeBySMS(phone);
    } else if (this._useSocketTransport && !phone) {
      throw new Error('Для ANDROID требуется номер телефона. Используйте: authorize("+79001234567")');
    } else {
      // QR авторизация для WEB
      console.log('🔐 Авторизация через QR-код');
      await this.authorizeByQR();
    }
  }


  /**
   * Сохранить новый токен сессии, если он отличается от текущего (ротация на сервере).
   */
  _persistSessionTokenIfNew(trimmed) {
    if (!trimmed || typeof trimmed !== 'string') {
      return false;
    }
    const t = trimmed.trim();
    if (!t) {
      return false;
    }
    const prev = this._token || this.session.get('token');
    if (t === prev) {
      return false;
    }
    this._token = t;
    if (this._saveTokenToSession) {
      this.session.set('token', t);
    }
    if (this.debug || this._authDebug) {
      console.log('[webmaxsocket:auth] Сохранён новый токен сессии (ротация)');
    }
    return true;
  }

  /**
   * Рекурсивно собирает строки tokenAttrs.LOGIN.token из msgpack/JSON (как в ответах LOGIN и пушах клиента Max).
   */
  _collectRotatedLoginTokens(value, depth, outSet) {
    if (depth > 24 || value == null) {
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    if (value instanceof Map) {
      for (const v of value.values()) {
        this._collectRotatedLoginTokens(v, depth + 1, outSet);
      }
      return;
    }
    const ta = value.tokenAttrs;
    if (ta && ta.LOGIN && typeof ta.LOGIN.token === 'string') {
      const tok = ta.LOGIN.token.trim();
      if (tok.length > 0) {
        outSet.add(tok);
      }
    }
    if (Array.isArray(value)) {
      for (const el of value) {
        this._collectRotatedLoginTokens(el, depth + 1, outSet);
      }
      return;
    }
    for (const k of Object.keys(value)) {
      this._collectRotatedLoginTokens(value[k], depth + 1, outSet);
    }
  }

  /**
   * Любой входящий payload: ответ LOGIN, уведомление, вложенный массив — подхватываем ротацию токена.
   */
  _applyAnyRotatedSessionToken(payload) {
    const set = new Set();
    this._collectRotatedLoginTokens(payload, 0, set);
    for (const t of set) {
      this._persistSessionTokenIfNew(t);
    }
  }

  /**
   * Если сервер вернул новый LOGIN-токен (ротация), сохраняем как при SMS/QR.
   */
  _applyLoginTokenFromSyncResponse(responsePayload) {
    this._applyAnyRotatedSessionToken(responsePayload);
  }

  _scheduleSessionRefreshIfNeeded() {
    this._clearSessionRefreshTimer();
    const ms = this._sessionRefreshIntervalMs;
    if (!ms) {
      return;
    }
    const minMs = 10_000;
    const interval = ms < minMs ? minMs : ms;
    if (ms < minMs) {
      console.warn(
        `[webmaxsocket] sessionRefreshIntervalMs=${ms} слишком мало, используется минимум ${minMs} мс`
      );
    }
    this._sessionRefreshTimer = setInterval(() => {
      if (!this.isAuthorized || !this.isConnected) {
        return;
      }
      if (this._sessionRefreshRunning) {
        return;
      }
      this._sessionRefreshRunning = true;
      this.sync()
        .catch((e) => {
          console.error('⚠️ Периодический sync не удался:', e.message || e);
        })
        .finally(() => {
          this._sessionRefreshRunning = false;
        });
    }, interval);
  }

  _clearSessionRefreshTimer() {
    if (this._sessionRefreshTimer) {
      clearInterval(this._sessionRefreshTimer);
      this._sessionRefreshTimer = null;
    }
  }

  /** Остановить фоновый периодический sync (`sessionRefreshIntervalMs`). */
  stopSessionRefresh() {
    this._clearSessionRefreshTimer();
  }

  _clearTcpInteractiveTimer() {
    if (this._tcpInteractiveTimer) {
      clearInterval(this._tcpInteractiveTimer);
      this._tcpInteractiveTimer = null;
    }
  }

  /** Периодический «интерактивный» PING на TCP (см. веб: cmd(1, { interactive })). */
  _startTcpInteractivePing() {
    this._clearTcpInteractiveTimer();
    if (!this._useSocketTransport || !this._tcpInteractivePingMs) {
      return;
    }
    this._tcpInteractiveTimer = setInterval(() => {
      if (
        !this._tcpLoginCompleted ||
        !this._socketTransport ||
        !this._socketTransport.socket ||
        this._socketTransport.socket.destroyed
      ) {
        return;
      }
      try {
        this._socketTransport.sendOneWay(Opcode.PING, { interactive: true });
      } catch (_) {
        /* ignore */
      }
    }, this._tcpInteractivePingMs);
  }

  /**
   * TCP: после LOGIN сохраняем поля для следующего LOGIN (lastLogin = time, счётчики — как у веб cmd(19)).
   */
  _persistTcpSyncStateFromResponse(p) {
    if (!this._useSocketTransport || !p || typeof p !== 'object') {
      return;
    }
    const time =
      p.time != null
        ? Number(p.time)
        : p.serverTime != null
          ? Number(p.serverTime)
          : NaN;
    if (Number.isFinite(time)) {
      this.session.set('maxTcpSyncLastLogin', time);
    }
    const pick = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const nums = [
      ['chatsSync', 'maxTcpChatsSync'],
      ['contactsSync', 'maxTcpContactsSync'],
      ['draftsSync', 'maxTcpDraftsSync']
    ];
    for (const [from, sessKey] of nums) {
      const n = pick(p[from]);
      if (n != null) {
        this.session.set(sessKey, n);
      }
    }
    if (p.configHash != null && String(p.configHash).length) {
      this.session.set('maxTcpConfigHash', String(p.configHash));
    }
  }

  /** Поля LOGIN (19) на TCP (как у веб cmd(19): lastLogin, счётчики, presenceSync −1). */
  _buildTcpCompactSyncPayload(token) {
    const sn = (key, def = 0) => {
      const v = this.session.get(key);
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const out = {
      interactive: true,
      token,
      chatsSync: sn('maxTcpChatsSync', 0),
      contactsSync: sn('maxTcpContactsSync', 0),
      presenceSync: -1,
      draftsSync: sn('maxTcpDraftsSync', 0),
      chatsCount: 40
    };
    const ll = Number(this.session.get('maxTcpSyncLastLogin'));
    if (Number.isFinite(ll)) {
      out.lastLogin = ll;
    }
    const ch = this.session.get('maxTcpConfigHash');
    if (ch != null && String(ch).length) {
      out.configHash = String(ch);
    }
    return out;
  }

  /**
   * Синхронизация с сервером (получение данных о пользователе, чатах и т.д.)
   */
  async sync() {
    console.log('🔄 Синхронизация с сервером...');

    this._logAuthContext('sync');

    const token = this._token || this.session.get('token');
    
    if (!token) {
      throw new Error('Токен не найден, требуется авторизация');
    }

    let payload;
    if (this._useSocketTransport) {
      payload = {
        ...this._buildTcpCompactSyncPayload(token),
        userAgent: this.userAgent.toJSON()
      };
    } else {
      payload = {
        interactive: true,
        token: token,
        chatsSync: 0,
        contactsSync: 0,
        presenceSync: 0,
        draftsSync: 0,
        chatsCount: 40,
        userAgent: this.userAgent.toJSON()
      };
    }

    /**
     * TCP: сокет мог оборваться (сервер, сеть), а isConnected ещё true — восстанавливаем транспорт.
     */
    if (this._useSocketTransport) {
      const dead =
        !this._socketTransport ||
        !this._socketTransport.socket ||
        this._socketTransport.socket.destroyed;
      if (dead) {
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket:sync] TCP: сокет недоступен — новое подключение');
        }
        this._clearTcpInteractiveTimer();
        if (this._socketTransport) {
          try {
            await this._socketTransport.close();
          } catch (_) {
            /* ignore */
          }
        }
        this._socketTransport = null;
        this.isConnected = false;
        this._tcpLoginCompleted = false;
        await this._connectSocket();
      }
    }

    /**
     * TCP: повторный LOGIN (19) на том же TLS — «Недопустимое состояние сессии».
     * SYNC (21) на сокете стабильно даёт «Что-то пошло не так» (в веб-клиенте resync — тоже op. 19, не 21).
     * Рабочий путь: закрыть сокет, новое соединение, снова LOGIN с тем же телом.
     */
    let response;
    try {
      if (this._useSocketTransport && this._tcpLoginCompleted) {
        if (this.debug || this._authDebug) {
          const { token: _tok, userAgent: _ua, ...rest } = payload;
          console.log(
            '[webmaxsocket:sync] TCP: повторный синк — новое TLS + LOGIN (19), тело:',
            JSON.stringify(rest)
          );
        }
        this._clearTcpInteractiveTimer();
        if (this._socketTransport) {
          try {
            await this._socketTransport.close();
          } catch (_) {
            /* ignore */
          }
          this._socketTransport = null;
        }
        this.isConnected = false;
        this._tcpLoginCompleted = false;
        await this._connectSocket();
        response = await this.sendAndWait(Opcode.LOGIN, payload);
      } else {
        response = await this.sendAndWait(Opcode.LOGIN, payload);
      }
    } catch (e) {
      if (this._useSocketTransport) {
        this._tcpLoginCompleted = false;
        this._clearTcpInteractiveTimer();
        try {
          if (this._socketTransport) {
            await this._socketTransport.close();
          }
        } catch (_) {
          /* ignore */
        }
        this._socketTransport = null;
        this.isConnected = false;
      }
      throw e;
    }

    if (response.payload && response.payload.error) {
      const err = response.payload.error;
      const msg = typeof err === 'string' ? err : (response.payload.localizedMessage || JSON.stringify(err));
      throw new Error(msg);
    }

    if (this._useSocketTransport) {
      this._tcpLoginCompleted = true;
      this._startTcpInteractivePing();
    }

    // Сохраняем информацию о пользователе
    const responsePayload = response.payload || {};

    this._applyLoginTokenFromSyncResponse(responsePayload);
    this._persistTcpSyncStateFromResponse(responsePayload);

    // Извлекаем данные пользователя из profile.contact
    if (responsePayload.profile && responsePayload.profile.contact) {
      const contact = responsePayload.profile.contact;
      const name = contact.names && contact.names.length > 0 ? contact.names[0] : {};
      
      const userData = {
        id: contact.id,
        firstname: name.firstName || name.name || '',
        lastname: name.lastName || '',
        phone: contact.phone,
        avatar: contact.baseUrl || contact.baseRawUrl,
        photoId: contact.photoId,
        rawData: contact
      };
      
      this.me = new User(userData);
      const fullName = this.me.fullname || this.me.firstname || 'User';
      console.log(`✅ Синхронизация завершена. Вы вошли как: ${fullName} (ID: ${this.me.id})`);
    } else if (!this.me) {
      console.log('Данные пользователя не найдены в ответе sync (норма для короткого SYNC без profile)');
    }

    try {
      let libVersion = 'unknown';
      try {
        libVersion = require(path.join(__dirname, '..', 'package.json')).version;
      } catch (_) {
        /* ignore */
      }
      this.session.set('_authMeta', {
        lastSyncOkAt: new Date().toISOString(),
        webmaxsocket: libVersion,
        node: process.version
      });
    } catch (_) {
      /* ignore */
    }
    if (this._sessionBackupOnSuccess) {
      this.session.copyToLastOk();
    }
    this._logAuthContext('sync:ok', { userId: this.me?.id });

    return responsePayload;
  }

  /**
   * Получение информации о текущем пользователе
   */
  async fetchMyProfile() {
    try {
      console.log('📱 Запрос профиля пользователя...');
      const response = await this.sendAndWait(Opcode.PROFILE, {});
      
      if (response.payload && response.payload.user) {
        this.me = new User(response.payload.user);
        const name = this.me.fullname || this.me.firstname || 'User';
        console.log(`✅ Профиль загружен: ${name} (ID: ${this.me.id})`);
      }
    } catch (error) {
      console.error('⚠️ Не удалось загрузить профиль:', error.message);
    }
  }

  /**
   * Подключение с существующей сессией
   */
  async connectWithSession() {
    try {
      await this.connect();
      
      const token = this.session.get('token');
      
      if (!token) {
        console.log('Токен не найден, требуется авторизация');
        await this.authorize();
        return;
      }
      
      this._token = token;

      this._logAuthContext('connectWithSession:before_sync', { tokenSource: 'session_file' });

      try {
        await this.sync();
        this.isAuthorized = true;
        console.log('Подключение с сохраненной сессией успешно');
        this._scheduleSessionRefreshIfNeeded();
      } catch (error) {
        console.log('Сессия истекла, требуется повторная авторизация');
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket:auth] sync error:', error.message);
        }
        if (this._clearSessionOnFailedSync) {
          this.session.clear();
        }
        await this.authorize();
      }
    } catch (error) {
      throw error;
    }
  }


  /**
   * Установка соединения (WebSocket или Socket)
   */
  async connect() {
    if (this._useSocketTransport) {
      return this._connectSocket();
    } else {
      return this._connectWebSocket();
    }
  }

  /**
   * Подключение через TCP Socket (для ANDROID)
   */
  async _connectSocket() {
    if (this._socketTransport && this._socketTransport.socket && !this._socketTransport.socket.destroyed) {
      this.isConnected = true;
      return;
    }

    this._tcpLoginCompleted = false;
    this._clearTcpInteractiveTimer();
    this._socketTransport = new MaxSocketTransport({
      deviceId: this.deviceId,
      deviceType: this.userAgent.deviceType,
      ua: this.userAgent.headerUserAgent,
      debug: this.debug
    });

    this._socketTransport.onNotification = (data) => {
      this.handleSocketNotification(data);
    };

    await this._socketTransport.connect();
    await this._socketTransport.handshake(this.userAgent);
    
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.emit('connected');
    
    console.log('TCP Socket соединение установлено');
  }

  /**
   * Установка WebSocket соединения (для WEB)
   */
  async _connectWebSocket() {
    if (this.ws && this.isConnected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const headers = {
        Origin: this.origin,
        'User-Agent': this._handshakeUserAgent.headerUserAgent
      };
      if (this._wsReferer) {
        headers.Referer = this._wsReferer;
      }

      this.ws = new WebSocket(this.apiUrl, {
        headers: headers
      });

      this.ws.on('open', async () => {
        console.log('WebSocket соединение установлено');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected');
        
        try {
          await this.handshake();
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error.message);
        this.triggerHandlers(EventTypes.ERROR, error);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        const rs = reason && reason.length ? reason.toString() : '';
        console.log(`WebSocket соединение закрыто (code=${code}${rs ? `, ${rs}` : ''})`);
        this.isConnected = false;
        const err = new Error('Соединение закрыто');
        for (const [, pending] of this.pendingRequests) {
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          pending.reject(err);
        }
        this.pendingRequests.clear();
        this.triggerHandlers(EventTypes.DISCONNECT);
        this.handleReconnect();
      });
    });
  }

  /**
   * Handshake после подключения
   */
  async handshake() {
    console.log('Выполняется handshake...');
    
    const payload = {
      deviceId: this.deviceId,
      userAgent: this._handshakeUserAgent.toJSON()
    };

    const response = await this.sendAndWait(Opcode.SESSION_INIT, payload);
    
    if (response.payload && response.payload.error) {
      throw new Error(`Handshake error: ${JSON.stringify(response.payload.error)}`);
    }
    
    console.log('Handshake выполнен успешно');
    return response;
  }

  /**
   * Обработка уведомлений от Socket транспорта
   */
  async handleSocketNotification(data) {
    try {
      if (this.debug && data.opcode !== Opcode.PING) {
        const payload = data.payload?.error ? ` error=${JSON.stringify(data.payload.error)}` : '';
        console.log(`📥 ${getOpcodeName(data.opcode)} (seq=${data.seq})${payload}`);
      }

      this._applyAnyRotatedSessionToken(data.payload);

      switch (data.opcode) {
        case Opcode.NOTIF_MESSAGE:
          await this.handleNewMessage(data.payload);
          break;
          
        case Opcode.NOTIF_MSG_DELETE:
          await this.handleRemovedMessage(data.payload);
          break;
          
        case Opcode.NOTIF_CHAT:
          await this.handleChatAction(data.payload);
          break;

        case Opcode.PING:
          // Иначе сервер рвёт TCP через ~минуты; WebSocket здесь шлёт sendPong (тот же opcode PING + {})
          if (
            this._socketTransport &&
            this._socketTransport.socket &&
            !this._socketTransport.socket.destroyed
          ) {
            this._socketTransport.sendOneWay(Opcode.PING, {});
          }
          break;

        case Opcode.NOTIF_ATTACH:
          this._handleNotifAttach(data.payload);
          break;

        default:
          this.emit('raw_message', data);
      }
    } catch (error) {
      console.error('Ошибка при обработке Socket уведомления:', error);
      await this.triggerHandlers(EventTypes.ERROR, error);
    }
  }

  /**
   * Обработка переподключения
   */
  handleReconnect() {
    if (this.maxReconnectAttempts <= 0) {
      return;
    }
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Попытка переподключения ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);

      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    } else {
      console.error('Превышено максимальное количество попыток переподключения');
    }
  }

  /**
   * Обработка входящих сообщений (WebSocket)
   */
  async handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      if (this.debug && message.opcode !== Opcode.PING) {
        const payload = message.payload?.error ? ` error=${JSON.stringify(message.payload.error)}` : '';
        console.log(`📥 ${getOpcodeName(message.opcode)} (seq=${message.seq})${payload}`);
      }

      this._applyAnyRotatedSessionToken(message.payload);

      // Обработка ответов на запросы по seq (seq может быть 0 — не использовать truthiness)
      if (
        message.seq !== undefined &&
        message.seq !== null &&
        this.pendingRequests.has(message.seq)
      ) {
        const pending = this.pendingRequests.get(message.seq);
        this.pendingRequests.delete(message.seq);
        
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        
        pending.resolve(message);
        return;
      }

      // Обработка уведомлений
      switch (message.opcode) {
        case Opcode.NOTIF_MESSAGE:
          await this.handleNewMessage(message.payload);
          break;
          
        case Opcode.NOTIF_MSG_DELETE:
          await this.handleRemovedMessage(message.payload);
          break;
          
        case Opcode.NOTIF_CHAT:
          await this.handleChatAction(message.payload);
          break;

        case Opcode.PING:
          await this.sendPong();
          break;

        case Opcode.NOTIF_ATTACH:
          this._handleNotifAttach(message.payload);
          break;

        default:
          this.emit('raw_message', message);
      }
    } catch (error) {
      console.error('Ошибка при обработке сообщения:', error);
      await this.triggerHandlers(EventTypes.ERROR, error);
    }
  }

  /**
   * Отправка pong ответа на ping
   */
  async sendPong() {
    try {
      const message = this.makeMessage(Opcode.PING, {});
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Ошибка при отправке pong:', error);
    }
  }

  /**
   * Обработка нового сообщения
   */
  async handleNewMessage(data) {
    // Извлекаем данные сообщения из правильного места
    // Структура: { chatId, message: { sender, id, text, ... } }
    const messageData = data.message || data;
    
    // Добавляем chatId если его нет в messageData
    if (!messageData.chatId && data.chatId) {
      messageData.chatId = data.chatId;
    }
    
    const message = new Message(messageData, this);

    if (this._incomingLogMode === 'messages' || this._incomingLogMode === 'verbose') {
      printIncomingLog('message', message.rawData);
    }

    // Попытка загрузить информацию об отправителе если её нет
    if (!message.sender && message.senderId && message.senderId !== this.me?.id) {
      await message.fetchSender();
    }

    await this.triggerHandlers(EventTypes.MESSAGE, message);
  }

  /**
   * Обработка удаленного сообщения
   */
  async handleRemovedMessage(data) {
    const message = new Message(data, this);
    if (this._incomingLogMode === 'verbose') {
      printIncomingLog('message_removed', message.rawData);
    }
    await this.triggerHandlers(EventTypes.MESSAGE_REMOVED, message);
  }

  /**
   * Обработка действия в чате
   */
  async handleChatAction(data) {
    const action = new ChatAction(data, this);
    if (this._incomingLogMode === 'verbose') {
      printIncomingLog('chat_action', action.rawData);
    }
    await this.triggerHandlers(EventTypes.CHAT_ACTION, action);
  }

  /**
   * Создает сообщение в протоколе Max API
   * payload не включаем в JSON, если undefined — как web.max.ru для GET_QR (только opcode).
   */
  makeMessage(opcode, payload, cmd = 0) {
    this.seq += 1;

    const message = {
      ver: this.ver,
      cmd: cmd,
      seq: this.seq,
      opcode: opcode,
    };
    if (payload !== undefined) {
      message.payload = payload;
    }
    return message;
  }

  /**
   * Отправка запроса и ожидание ответа
   */
  async sendAndWait(opcode, payload, cmd = 0, timeout = 20000) {
    if (!this.isConnected) {
      throw new Error('Соединение не установлено');
    }

    // Используем Socket транспорт для ANDROID
    if (this._useSocketTransport && this._socketTransport) {
      return await this._socketTransport.sendAndWait(opcode, payload, cmd, timeout);
    }

    // WebSocket транспорт для WEB
    return new Promise((resolve, reject) => {
      const message = this.makeMessage(opcode, payload, cmd);
      const seq = message.seq;

      this.pendingRequests.set(seq, { resolve, reject });

      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(seq)) {
          this.pendingRequests.delete(seq);
          reject(new Error(`Таймаут запроса (seq: ${seq}, opcode: ${opcode})`));
        }
      }, timeout);

      this.pendingRequests.get(seq).timeoutId = timeoutId;

      this.ws.send(JSON.stringify(message));
    });
  }

  _nextClientMessageId() {
    const n = this._clientSendCid;
    this._clientSendCid = (this._clientSendCid % 0x7fffffff) + 1;
    return n;
  }

  /** int32: Date.now() и большие числа ломают валидацию MSG_SEND на TCP */
  _normalizeOutgoingCid(cid) {
    if (cid == null || cid === '') return this._nextClientMessageId();
    const n = Number(cid);
    if (!Number.isFinite(n)) return this._nextClientMessageId();
    const x = Math.trunc(n);
    if (x > 2147483647 || x < -2147483648) {
      return this._nextClientMessageId();
    }
    return x;
  }

  /**
   * messageId для REPLY: int, если безопасно, иначе строка (длинные id).
   */
  _normalizeReplyMessageId(replyTo) {
    if (replyTo == null || replyTo === '') return null;
    if (typeof replyTo === 'number' && Number.isFinite(replyTo)) return replyTo;
    if (typeof replyTo === 'bigint') return Number(replyTo);
    if (typeof replyTo === 'string' && /^-?\d+$/.test(replyTo)) {
      const n = Number(replyTo);
      if (Number.isSafeInteger(n)) return n;
      return replyTo;
    }
    return String(replyTo);
  }

  /**
   * Собирает тело message для MSG_SEND: без link: null; cid в int32; elements для текста.
   */
  _buildOutgoingMessageBody(text, cid, replyTo, attachments) {
    const t = text == null ? '' : String(text);
    const cidVal = this._normalizeOutgoingCid(cid);

    const body = {
      text: t,
      cid: cidVal,
      elements: []
    };

    const att = attachments || [];
    if (att.length) {
      body.attaches = att;
    }

    if (replyTo != null && replyTo !== '') {
      body.link = {
        type: 'REPLY',
        messageId: this._normalizeReplyMessageId(replyTo)
      };
    }
    return body;
  }

  _normalizeChatId(chatId) {
    if (chatId == null) return chatId;
    if (typeof chatId === 'bigint') return Number(chatId);
    const n = Number(chatId);
    return Number.isNaN(n) ? chatId : n;
  }

  /**
   * NOTIF_ATTACH (136): готовность вложения после загрузки видео/файла.
   */
  _handleNotifAttach(payload) {
    if (!payload || typeof payload !== 'object') return;
    const vid = payload.videoId;
    if (vid != null) {
      const k = String(vid);
      const fn = this._uploadPendingVideo.get(k);
      if (fn) {
        this._uploadPendingVideo.delete(k);
        fn();
      }
    }
    const fid = payload.fileId;
    if (fid != null) {
      const k = String(fid);
      const fn = this._uploadPendingFile.get(k);
      if (fn) {
        this._uploadPendingFile.delete(k);
        fn();
      }
    }
  }

  /**
   * @param {Map<string, function(): void>} map
   */
  _waitUploadNotif(map, id, label, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const k = String(id);
      const t = setTimeout(() => {
        map.delete(k);
        reject(new Error(`Таймаут ожидания NOTIF_ATTACH (${label})`));
      }, timeoutMs);
      map.set(k, () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async _postMultipartUpload(uploadUrl, buf, fname, mime) {
    const { Blob } = require('buffer');
    if (typeof fetch !== 'function') {
      throw new Error('upload: нужен Node.js 18+ с глобальным fetch');
    }
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), fname);
    const res = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      headers: {
        Accept: '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Origin: 'https://web.max.ru',
        Referer: 'https://web.max.ru/',
        'User-Agent': this.userAgent.headerUserAgent || 'Mozilla/5.0'
      }
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP загрузка: ${res.status} ${t.slice(0, 300)}`);
    }
    return res;
  }

  /**
   * Отправка сообщения (с уведомлением)
   */
  async sendMessage(options) {
    if (typeof options === 'string') {
      throw new Error('sendMessage требует объект с параметрами: { chatId, text, cid }');
    }

    const { chatId, text, cid, replyTo, attachments } = options;

    const payload = {
      chatId: this._normalizeChatId(chatId),
      message: this._buildOutgoingMessageBody(text, cid, replyTo, attachments),
      notify: true
    };

    const response = await this.sendAndWait(Opcode.MSG_SEND, payload);

    if (response.payload && response.payload.message) {
      return new Message(response.payload.message, this);
    }
    
    return response.payload;
  }

  /**
   * Отправка сообщения в канал (без уведомления)
   */
  async sendMessageChannel(options) {
    if (typeof options === 'string') {
      throw new Error('sendMessageChannel требует объект с параметрами: { chatId, text, cid }');
    }

    const { chatId, text, cid, replyTo, attachments } = options;

    const payload = {
      chatId: this._normalizeChatId(chatId),
      message: this._buildOutgoingMessageBody(text, cid, replyTo, attachments),
      notify: false
    };

    const response = await this.sendAndWait(Opcode.MSG_SEND, payload);

    if (response.payload && response.payload.message) {
      return new Message(response.payload.message, this);
    }
    
    return response.payload;
  }

  /**
   * Загрузка локального изображения на сервер Max; результат передать в `attachments` у sendMessage / reply.
   * Схема: PHOTO_UPLOAD → UPLOAD_ATTACH_PREP → HTTP POST на выданный URL. Нужен Node 18+ (fetch, FormData).
   *
   * @param {number|string|bigint} chatId
   * @param {string} filePath путь к файлу (.png, .jpg, …)
   * @returns {Promise<{ _type: 'PHOTO', photoToken: string }>}
   */
  async uploadPhoto(chatId, filePath) {
    const fsp = require('fs/promises');
    const path = require('path');

    const buf = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/jpeg';
    const fname = path.basename(filePath) || 'image.jpg';

    const r1 = await this.sendAndWait(Opcode.PHOTO_UPLOAD, { count: 1 });
    const p1 = r1.payload;
    if (p1 && p1.error) {
      const e = new Error(
        typeof p1.error === 'string' ? p1.error : JSON.stringify(p1.error)
      );
      e.rawPayload = p1;
      throw e;
    }
    const uploadUrl = p1 && p1.url;
    if (!uploadUrl) {
      throw new Error('PHOTO_UPLOAD: нет url в ответе');
    }

    await this.sendAndWait(Opcode.UPLOAD_ATTACH_PREP, {
      chatId: this._normalizeChatId(chatId),
      type: 'PHOTO'
    });

    const res = await this._postMultipartUpload(uploadUrl, buf, fname, mime);
    const obj = await res.json();
    const photos = obj.photos;
    let first;
    if (Array.isArray(photos)) {
      [first] = photos;
    } else if (photos && typeof photos === 'object') {
      first = Object.values(photos)[0];
    }
    const token = first && first.token;
    if (!token) {
      throw new Error(`PHOTO upload: неожиданный JSON: ${JSON.stringify(obj).slice(0, 400)}`);
    }

    return {
      _type: 'PHOTO',
      photoToken: token
    };
  }

  /**
   * Загрузка видео; результат для `attachments: [{ _type: 'VIDEO', videoId, token }]`.
   * После HTTP POST ждёт NOTIF_ATTACH (opcode 136).
   */
  async uploadVideo(chatId, filePath) {
    const fsp = require('fs/promises');
    const path = require('path');

    const buf = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fname = path.basename(filePath) || 'video.mp4';
    const mime =
      ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';

    const r = await this.sendAndWait(Opcode.VIDEO_UPLOAD, { count: 1 });
    const p = r.payload;
    if (p && p.error) {
      const e = new Error(
        typeof p.error === 'string' ? p.error : JSON.stringify(p.error)
      );
      e.rawPayload = p;
      throw e;
    }
    const info = p && p.info && p.info[0];
    if (!info) {
      throw new Error('VIDEO_UPLOAD: нет info в ответе');
    }
    const { url: uploadUrl, videoId, token } = info;
    if (!uploadUrl || videoId == null || token == null) {
      throw new Error('VIDEO_UPLOAD: нет url, videoId или token');
    }

    const waitReady = this._waitUploadNotif(this._uploadPendingVideo, videoId, 'VIDEO');

    await this.sendAndWait(Opcode.UPLOAD_ATTACH_PREP, {
      chatId: this._normalizeChatId(chatId),
      type: 'VIDEO'
    });

    await this._postMultipartUpload(uploadUrl, buf, fname, mime);

    await waitReady;

    return { _type: 'VIDEO', videoId, token };
  }

  /**
   * Загрузка произвольного файла (документ, архив, **аудио** и т.д.) для `attachments: [{ _type: 'FILE', fileId }]`.
   * После HTTP POST ждёт NOTIF_ATTACH.
   *
   * @param {{ filename?: string, mimeType?: string }} [options]
   */
  async uploadFile(chatId, filePath, options = {}) {
    const fsp = require('fs/promises');
    const path = require('path');

    const buf = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fname = options.filename || path.basename(filePath) || 'file.bin';
    const mime =
      options.mimeType ||
      this._mimeGuessForFile(ext);

    const r = await this.sendAndWait(Opcode.FILE_UPLOAD, { count: 1 });
    const p = r.payload;
    if (p && p.error) {
      const e = new Error(
        typeof p.error === 'string' ? p.error : JSON.stringify(p.error)
      );
      e.rawPayload = p;
      throw e;
    }
    const info = p && p.info && p.info[0];
    if (!info) {
      throw new Error('FILE_UPLOAD: нет info в ответе');
    }
    const { url: uploadUrl, fileId } = info;
    if (!uploadUrl || fileId == null) {
      throw new Error('FILE_UPLOAD: нет url или fileId');
    }

    const waitReady = this._waitUploadNotif(this._uploadPendingFile, fileId, 'FILE');

    await this.sendAndWait(Opcode.UPLOAD_ATTACH_PREP, {
      chatId: this._normalizeChatId(chatId),
      type: 'FILE'
    });

    await this._postMultipartUpload(uploadUrl, buf, fname, mime);

    await waitReady;

    return { _type: 'FILE', fileId };
  }

  /**
   * Загрузка аудио как файла (удобно для .mp3, .ogg, .m4a, .wav).
   * Внутри вызывает uploadFile() с подходящим MIME.
   */
  async uploadAudio(chatId, filePath) {
    const path = require('path');
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.mp3'
        ? 'audio/mpeg'
        : ext === '.ogg' || ext === '.oga'
          ? 'audio/ogg'
          : ext === '.m4a' || ext === '.aac'
            ? 'audio/mp4'
            : ext === '.wav'
              ? 'audio/wav'
              : ext === '.flac'
                ? 'audio/flac'
                : 'audio/mpeg';
    return this.uploadFile(chatId, filePath, { mimeType: mime });
  }

  _mimeGuessForFile(ext) {
    const m = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm'
    };
    return m[ext] || 'application/octet-stream';
  }

  /**
   * Редактирование сообщения
   */
  async editMessage(options) {
    const { messageId, chatId, text, attachments } = options;

    const payload = {
      chatId: chatId,
      messageId: messageId,
      text: text || '',
      elements: [],
      attaches: Array.isArray(attachments) && attachments.length ? attachments : []
    };

    const response = await this.sendAndWait(Opcode.MSG_EDIT, payload);
    
    if (response.payload && response.payload.message) {
      return new Message(response.payload.message, this);
    }
    
    return response.payload;
  }

  /**
   * Удаление сообщения
   */
  async deleteMessage(options) {
    const { messageId, chatId, forMe } = options;

    const payload = {
      chatId: chatId,
      messageIds: Array.isArray(messageId) ? messageId : [messageId],
      forMe: forMe || false
    };

    await this.sendAndWait(Opcode.MSG_DELETE, payload);

    return true;
  }

  /**
   * Получение информации о пользователе по ID
   */
  async getUser(userId) {
    const payload = {
      contactIds: [userId]
    };

    const response = await this.sendAndWait(Opcode.CONTACT_INFO, payload);
    
    if (response.payload && response.payload.contacts && response.payload.contacts.length > 0) {
      const contact = response.payload.contacts[0];
      
      // Преобразуем структуру контакта в понятный User формат
      const name = contact.names && contact.names.length > 0 ? contact.names[0] : {};
      
      const userData = {
        id: contact.id,
        firstname: name.firstName || name.name || '',
        lastname: name.lastName || '',
        phone: contact.phone,
        avatar: contact.baseUrl || contact.baseRawUrl,
        photoId: contact.photoId,
        rawData: contact
      };
      
      return new User(userData);
    }
    
    return null;
  }

  /**
   * Получение списка чатов
   */
  async getChats(marker = 0) {
    if (this._useSocketTransport && this._socketTransport) {
      return await this._socketTransport.getChats(marker);
    }

    const payload = {
      marker: marker
    };

    const response = await this.sendAndWait(Opcode.CHATS_LIST, payload);
    
    return response.payload && response.payload.chats ? response.payload.chats : [];
  }

  /**
   * Получение истории сообщений
   */
  async getHistory(chatId, from = Date.now(), backward = 200, forward = 0) {
    if (this._useSocketTransport && this._socketTransport) {
      const messages = await this._socketTransport.getHistory(chatId, from, backward, forward);
      return messages.map(msg => new Message(msg, this));
    }

    const payload = {
      chatId: chatId,
      from: from,
      forward: forward,
      backward: backward,
      getMessages: true
    };

    const response = await this.sendAndWait(Opcode.CHAT_HISTORY, payload);
    
    const messages = response.payload && response.payload.messages ? response.payload.messages : [];
    return messages.map(msg => new Message(msg, this));
  }

  /**
   * Закрепить сообщение в чате (CHAT_UPDATE).
   */
  async pinMessage({ chatId, messageId, notifyPin = false }) {
    return await this.sendAndWait(Opcode.CHAT_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      messageId: String(messageId),
      notifyPin: !!notifyPin
    });
  }

  /**
   * Поставить реакцию-эмодзи на сообщение.
   */
  async setMessageReaction({ chatId, messageId, emoji }) {
    return await this.sendAndWait(Opcode.MSG_REACTION, {
      chatId: this._normalizeChatId(chatId),
      messageId: String(messageId),
      reaction: {
        reactionType: 'EMOJI',
        id: String(emoji)
      }
    });
  }

  /**
   * Снять свою реакцию с сообщения.
   */
  async cancelMessageReaction({ chatId, messageId }) {
    return await this.sendAndWait(Opcode.MSG_CANCEL_REACTION, {
      chatId: this._normalizeChatId(chatId),
      messageId: String(messageId)
    });
  }

  /**
   * Список реакций на сообщение.
   */
  async getMessageReactions({ chatId, messageId, count = 100 }) {
    return await this.sendAndWait(Opcode.MSG_GET_REACTIONS, {
      chatId: this._normalizeChatId(chatId),
      messageId: String(messageId),
      count
    });
  }

  /**
   * Информация о чатах по id (opcode 48).
   */
  async getChatInfo(chatIds) {
    const ids = Array.isArray(chatIds) ? chatIds : [chatIds];
    const response = await this.sendAndWait(Opcode.CHAT_INFO, { chatIds: ids });
    return response.payload;
  }

  /**
   * Разрешить ссылку: канал, инвайт join/…, URL max.ru (LINK_INFO).
   */
  async resolveLink(link) {
    const response = await this.sendAndWait(Opcode.LINK_INFO, { link: String(link) });
    return response.payload;
  }

  /**
   * Вступить по ссылке (канал, группа и т.д.).
   */
  async joinChatByLink(link) {
    const response = await this.sendAndWait(Opcode.CHAT_JOIN, { link: String(link) });
    return response.payload;
  }

  /**
   * Подписка / отписка на канал.
   */
  async setChatSubscription(chatId, subscribe) {
    return await this.sendAndWait(Opcode.CHAT_SUBSCRIBE, {
      chatId: this._normalizeChatId(chatId),
      subscribe: !!subscribe
    });
  }

  /**
   * Создать групповой чат (CONTROL в MSG_SEND).
   */
  async createGroup({ title, userIds }) {
    const cid = this._nextClientMessageId();
    return await this.sendAndWait(Opcode.MSG_SEND, {
      message: {
        text: '',
        cid,
        elements: [],
        attaches: [
          {
            _type: 'CONTROL',
            event: 'new',
            chatType: 'CHAT',
            title,
            userIds
          }
        ]
      },
      notify: true
    });
  }

  /**
   * Создать канал (CONTROL в MSG_SEND).
   */
  async createChannel({ title }) {
    const cid = this._nextClientMessageId();
    return await this.sendAndWait(Opcode.MSG_SEND, {
      message: {
        text: '',
        cid,
        elements: [],
        attaches: [
          {
            _type: 'CONTROL',
            event: 'new',
            title,
            chatType: 'CHANNEL'
          }
        ]
      },
      notify: true
    });
  }

  /**
   * Отключить уведомления в чате (CONFIG), как «не беспокоить» для чата.
   */
  async muteChat(chatId, mute = true) {
    const id = String(this._normalizeChatId(chatId));
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        chats: {
          [id]: {
            dontDisturbUntil: mute ? -1 : 0
          }
        }
      }
    });
  }

  /**
   * Участники чата (не более 500 за запрос).
   */
  async getChatMembers({ chatId, marker = 0, count = 500, type = 'MEMBER' }) {
    if (count > 500) {
      throw new Error('getChatMembers: count не больше 500');
    }
    return await this.sendAndWait(Opcode.CHAT_MEMBERS, {
      type,
      marker,
      chatId: this._normalizeChatId(chatId),
      count
    });
  }

  /**
   * Пригласить пользователей в чат.
   */
  async inviteToChat({ chatId, userIds, showHistory = true }) {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      showHistory,
      operation: 'add'
    });
  }

  /**
   * Исключить пользователей из чата.
   */
  async removeFromChat({ chatId, userIds, cleanMsgPeriod = 0 }) {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      operation: 'remove',
      cleanMsgPeriod
    });
  }

  /**
   * Назначить администраторов. `permissions` — битовая маска прав (по умолчанию 120).
   */
  async addChatAdmins({ chatId, userIds, permissions = 120 }) {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      type: 'ADMIN',
      operation: 'add',
      permissions
    });
  }

  /**
   * Снять права администратора.
   */
  async removeChatAdmins({ chatId, userIds }) {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      type: 'ADMIN',
      operation: 'remove'
    });
  }

  /**
   * Передать владение группой.
   */
  async transferChatOwnership({ chatId, newOwnerId }) {
    return await this.sendAndWait(Opcode.CHAT_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      changeOwnerId: newOwnerId
    });
  }

  /**
   * Настройки группы: например ONLY_OWNER_CAN_CHANGE_ICON_TITLE, ALL_CAN_PIN_MESSAGE, ONLY_ADMIN_CAN_ADD_MEMBER.
   */
  async setGroupOptions({ chatId, options }) {
    return await this.sendAndWait(Opcode.CHAT_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      options
    });
  }

  /**
   * Несколько контактов по id (сырой ответ CONTACT_INFO).
   */
  async getContacts(contactIds) {
    const ids = Array.isArray(contactIds) ? contactIds : [contactIds];
    const response = await this.sendAndWait(Opcode.CONTACT_INFO, { contactIds: ids });
    return response.payload;
  }

  /**
   * Добавить пользователя в контакты.
   */
  async addContact(userId) {
    return await this.sendAndWait(Opcode.CONTACT_UPDATE, {
      contactId: userId,
      action: 'ADD'
    });
  }

  /**
   * Заблокировать пользователя.
   */
  async blockUser(userId) {
    return await this.sendAndWait(Opcode.CONTACT_UPDATE, {
      contactId: userId,
      action: 'BLOCK'
    });
  }

  /**
   * Изменить своё имя / описание (PROFILE).
   */
  async updateProfile({ firstName, lastName, description } = {}) {
    const payload = {};
    if (firstName !== undefined) payload.firstName = firstName;
    if (lastName !== undefined) payload.lastName = lastName;
    if (description !== undefined) payload.description = description;
    return await this.sendAndWait(Opcode.PROFILE, payload);
  }

  /**
   * Скрыть статус «в сети» для других.
   */
  async setHiddenOnline(hidden) {
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { HIDDEN: !!hidden }
      }
    });
  }

  /**
   * Кто может найти вас по телефону: 'ALL' | 'CONTACTS' или true/false (как ALL/CONTACTS).
   */
  async setFindableByPhone(mode) {
    const v =
      mode === true || mode === 'ALL'
        ? 'ALL'
        : mode === false || mode === 'CONTACTS'
          ? 'CONTACTS'
          : String(mode);
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { SEARCH_BY_PHONE: v }
      }
    });
  }

  /**
   * Кто может звонить: 'ALL' | 'CONTACTS'.
   */
  async setCallsPrivacyMode(mode) {
    const v =
      mode === true || mode === 'ALL'
        ? 'ALL'
        : mode === false || mode === 'CONTACTS'
          ? 'CONTACTS'
          : String(mode);
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { INCOMING_CALL: v }
      }
    });
  }

  /**
   * Кто может приглашать вас в чаты: 'ALL' | 'CONTACTS'.
   */
  async setChatsInvitePrivacy(mode) {
    const v =
      mode === true || mode === 'ALL'
        ? 'ALL'
        : mode === false || mode === 'CONTACTS'
          ? 'CONTACTS'
          : String(mode);
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { CHATS_INVITE: v }
      }
    });
  }

  /**
   * Удобно: канал по @username (resolveLink на https://max.ru/username).
   */
  async resolveChannelByUsername(username) {
    const u = String(username).replace(/^@/, '');
    return this.resolveLink(`https://max.ru/${u}`);
  }

  /**
   * Вступить в канал по @username.
   */
  async joinChannelByUsername(username) {
    const u = String(username).replace(/^@/, '');
    return this.joinChatByLink(`https://max.ru/${u}`);
  }

  /**
   * Инвайт по хэшу из ссылки join/XXXX.
   */
  async resolveInviteHash(hash) {
    const h = String(hash).replace(/^join\//, '');
    return this.resolveLink(`join/${h}`);
  }

  async getSessionsInfo() {
    const r = await this.sendAndWait(Opcode.SESSIONS_INFO, {});
    return r.payload;
  }

  static normalizeSessionsList(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const list = Array.isArray(payload.sessions)
      ? payload.sessions
      : Array.isArray(payload.sessionList)
        ? payload.sessionList
        : [];
    return list
      .map((s) => {
        if (!s || typeof s !== 'object') return null;
        const time = s.time != null ? Number(s.time) : s.ts != null ? Number(s.ts) : NaN;
        const deviceId =
          s.deviceId != null
            ? String(s.deviceId)
            : s.device_id != null
              ? String(s.device_id)
              : s.sessionDeviceId != null
                ? String(s.sessionDeviceId)
                : s.udid != null
                  ? String(s.udid)
                  : '';
        return {
          time: Number.isFinite(time) ? time : 0,
          client: s.client != null ? String(s.client) : '',
          info: s.info != null ? String(s.info) : '',
          location: s.location != null ? String(s.location) : '',
          current: Boolean(s.current || s.isCurrent || s.self),
          deviceId,
          raw: s
        };
      })
      .filter(Boolean);
  }

  /**
   * Строка из SESSIONS_INFO относится к этому клиенту (текущее TCP/устройство).
   */
  _isSessionRowThisDevice(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.current) return true;
    const mine = String(this.deviceId || '').trim().toLowerCase();
    if (!mine) return false;
    const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
    const candidates = [
      row.deviceId,
      raw.deviceId,
      raw.device_id,
      raw.sessionDeviceId,
      raw.udid
    ]
      .filter((x) => x != null && String(x).trim() !== '')
      .map((x) => String(x).trim().toLowerCase());
    return candidates.some((c) => c === mine);
  }

  async closeSessions(payload) {
    return await this.sendAndWait(Opcode.SESSIONS_CLOSE, payload || {});
  }

  async closeAllSessionsExceptCurrent() {
    const info = await this.getSessionsInfo();
    const rows = WebMaxClient.normalizeSessionsList(info || {});

    const byDevice = rows.filter((r) => this._isSessionRowThisDevice(r));
    let selfTimeSet = new Set();
    if (byDevice.length > 0) {
      for (const r of byDevice) {
        if (r.time > 0) selfTimeSet.add(r.time);
      }
    } else {
      const byFlag = rows.filter((r) => r.current);
      if (byFlag.length > 0) {
        for (const r of byFlag) {
          if (r.time > 0) selfTimeSet.add(r.time);
        }
      } else if (rows.length <= 1) {
        if (this.debug || this._authDebug) {
          console.log(
            '[webmaxsocket] closeAllSessionsExceptCurrent: в списке одна или ноль сессий — не вызываем SESSIONS_CLOSE'
          );
        }
        return { skipped: true, reason: 'single_or_empty_session_list', sessionsPayload: info };
      } else {
        throw new Error(
          'closeAllSessionsExceptCurrent: нельзя определить текущую сессию (нет current/deviceId). Завершите устройства в приложении Max.'
        );
      }
    }

    const otherTimes = rows.filter((r) => r.time > 0 && !selfTimeSet.has(r.time)).map((r) => r.time);
    const uniqTimes = [...new Set(otherTimes)];

    if (uniqTimes.length === 0) {
      if (this.debug || this._authDebug) {
        console.log(
          '[webmaxsocket] closeAllSessionsExceptCurrent: других сессий нет — SESSIONS_CLOSE не вызывается'
        );
      }
      return { skipped: true, reason: 'no_other_sessions', sessionsPayload: info };
    }

    /**
     * Не использовать allExceptCurrent / excludeCurrent без списка: на стороне Max
     * это приводило к инвалидации текущего токена после перезапуска. Закрываем
     * только явно перечисленные чужие time (как в списке устройств).
     */
    const attempts = [{ times: uniqTimes }, { sessionTimes: uniqTimes }, { ids: uniqTimes }];
    let lastErr;
    for (const body of attempts) {
      try {
        const r = await this.sendAndWait(Opcode.SESSIONS_CLOSE, body);
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket] SESSIONS_CLOSE ok, body keys:', Object.keys(body).join(','));
        }
        return r.payload;
      } catch (e) {
        lastErr = e;
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket] SESSIONS_CLOSE fail:', e.message, 'body:', JSON.stringify(body));
        }
      }
    }
    throw lastErr || new Error('SESSIONS_CLOSE: не удалось завершить сессии');
  }

  async getTwoFADetails() {
    const r = await this.sendAndWait(Opcode.AUTH_2FA_DETAILS, {});
    return r.payload;
  }

  async setTwoFAPassword({ trackId, password, hint, email }) {
    if (!trackId || !password) {
      throw new Error('setTwoFAPassword: нужны trackId и password');
    }
    const payload = {
      trackId: String(trackId).trim(),
      password: String(password)
    };
    if (hint != null && String(hint).trim() !== '') payload.hint = String(hint).trim();
    if (email != null && String(email).trim() !== '') payload.email = String(email).trim();
    const r = await this.sendAndWait(Opcode.AUTH_SET_2FA, payload);
    return r.payload;
  }

  /**
   * Выполнение зарегистрированных обработчиков
   */
  async triggerHandlers(eventType, data = null) {
    if (
      eventType === EventTypes.ERROR &&
      data !== null &&
      this._incomingLogMode === 'verbose'
    ) {
      printIncomingLog('error', {
        message: data && data.message,
        stack: data && data.stack
      });
    }

    const handlers = this.handlers[eventType] || [];

    for (const handler of handlers) {
      try {
        if (data !== null) {
          await handler(data);
        } else {
          await handler();
        }
      } catch (error) {
        console.error(`Ошибка в обработчике ${eventType}:`, error);
      }
    }
  }

  /**
   * Остановка клиента
   */
  async stop() {
    this._clearSessionRefreshTimer();
    this._clearTcpInteractiveTimer();
    if (this._socketTransport) {
      await this._socketTransport.close();
      this._socketTransport = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthorized = false;
    this._tcpLoginCompleted = false;
    console.log('Клиент остановлен');
  }

  /**
   * Выход из аккаунта
   */
  async logout() {
    await this.stop();
    this.session.destroy();
    console.log('Выход выполнен, сессия удалена');
  }
}

module.exports = WebMaxClient;

