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
    let token = options.token || null;
    let agent = options.ua || options.agent || options.headerUserAgent || null;
    let configObj = {};
    const configPath = options.configPath || options.config;
    if (configPath) {
      configObj = loadSessionConfig(configPath);
      token = token || configObj.token || null;
      agent = agent || configObj.agent || configObj.ua || configObj.headerUserAgent || null;
    }
    
    this._providedToken = token;
    this._saveTokenToSession = options.saveToken !== false;
    this.origin = 'https://web.max.ru';
    this.session = new SessionManager(this.sessionName);
    
    const deviceTypeMap = { 1: 'WEB', 2: 'IOS', 3: 'ANDROID' };
    const rawDeviceType = options.deviceType ?? configObj.device_type ?? configObj.deviceType ?? this.session.get('deviceType');
    const deviceType = deviceTypeMap[rawDeviceType] || rawDeviceType || 'WEB';
    const uaString = agent || configObj.headerUserAgent || configObj.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const webDefaults = {
      deviceType: deviceType,
      locale: options.locale || configObj.locale || 'ru',
      deviceLocale: options.deviceLocale || configObj.deviceLocale || configObj.locale || 'ru',
      osVersion:
        options.osVersion ||
        configObj.osVersion ||
        (deviceType === 'IOS' ? '18.6.2' : deviceType === 'ANDROID' ? '14' : 'Windows 11'),
      deviceName:
        options.deviceName ||
        configObj.deviceName ||
        (deviceType === 'IOS' ? 'Safari' : deviceType === 'ANDROID' ? 'Chrome' : 'Chrome'),
      headerUserAgent: options.headerUserAgent || options.ua || uaString,
      // Ниже 25.12.13 сервер может отвечать qr_login.disabled на GET_QR (см. PyMax _login).
      appVersion: options.appVersion || configObj.appVersion || '25.12.14',
      screen:
        options.screen ||
        configObj.screen ||
        (deviceType === 'IOS' ? '390x844 3.0x' : deviceType === 'ANDROID' ? '360x780 3.0x' : '1080x1920 1.0x'),
      timezone: options.timezone || configObj.timezone || 'Europe/Moscow',
      buildNumber: options.buildNumber ?? configObj.buildNumber,
      clientSessionId: options.clientSessionId ?? configObj.clientSessionId ?? this.session.get('clientSessionId'),
      release: options.release ?? configObj.release
    };
    this._handshakeUserAgent = new UserAgentPayload(webDefaults);
    this.userAgent = this._handshakeUserAgent;
    
    this.deviceId = options.deviceId || this.session.get('deviceId') || uuidv4();
    if (!this.session.get('deviceId')) {
      this.session.set('deviceId', this.deviceId);
    }
    
    // Определяем тип транспорта: Socket для IOS/ANDROID, WebSocket для WEB
    this._useSocketTransport = (deviceType === 'IOS' || deviceType === 'ANDROID');
    this._socketTransport = null;
    
    this.ws = null;
    this.me = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 3000;
    
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
    /** Режим JSON-лога входящих: off | messages | verbose (см. logIncoming в README) */
    this._incomingLogMode = resolveIncomingLogMode(options);
    this._wireIncomingLogListeners();
    /** client id локальных исходящих сообщений (int32, часто ждут валидацию на сервере) */
    this._clientSendCid = 1 + Math.floor(Math.random() * 0xfffff);
    /** После HTTP POST видео/файла — ждём NOTIF_ATTACH */
    this._uploadPendingVideo = new Map();
    this._uploadPendingFile = new Map();
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
      
      // Приоритет: 1) переданный токен, 2) сохранённая сессия, 3) QR-авторизация
      const tokenToUse = this._providedToken || this.session.get('token');
      
      if (tokenToUse) {
        if (this._providedToken) {
          console.log('✅ Вход по токену (token auth)');
          if (this._saveTokenToSession) {
            this.session.set('token', this._providedToken);
            this.session.set('deviceId', this.deviceId);
          }
        } else {
          console.log('✅ Найдена сохраненная сессия');
        }
        this._token = tokenToUse;
        
        try {
          await this.sync();
          this.isAuthorized = true;
        } catch (error) {
          const wasTokenAuth = !!this._providedToken;
          this.session.clear();
          this._providedToken = null;
          if (wasTokenAuth) {
            throw new Error(`Токен недействителен или сессия истекла. Обновите токен в config. (${error.message})`);
          }
          console.log('⚠️ Сессия истекла, требуется повторная авторизация');
          await this.authorize();
        }
      } else {
        console.log('📱 Требуется авторизация');
        await this.authorize();
      }

      // Запускаем обработчики start
      await this.triggerHandlers(EventTypes.START);
      
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
    
    const response = await this.sendAndWait(Opcode.GET_QR, {});

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
   * Завершение авторизации по QR-коду
   */
  async loginByQR(trackId) {
    const response = await this.sendAndWait(Opcode.LOGIN_BY_QR, { trackId });
    
    if (response.payload && response.payload.error) {
      throw new Error(`QR login error: ${JSON.stringify(response.payload.error)}`);
    }
    
    return response.payload;
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
    const response = await this.sendAndWait(Opcode.GET_QR, {});

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
   * QR для привязки устройства при основой сессии на TCP (IOS/ANDROID): кратковременный WEB-клиент без LOGIN.
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

      const response = await webQr.sendAndWait(Opcode.GET_QR, {});
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
      this.session.set('deviceType', 'IOS'); // Переключаемся на IOS для TCP при следующем запуске
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
   * Авторизация по номеру телефона через SMS (для IOS/ANDROID)
   */
  async authorizeBySMS(phone) {
    if (!this._useSocketTransport) {
      throw new Error('SMS авторизация доступна только для IOS/ANDROID (используйте deviceType: "IOS" или "ANDROID")');
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
          
          if (authResponse?.passwordChallenge) {
            throw new Error('2FA не поддерживается');
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
   * Авторизация пользователя (QR-код для WEB, SMS для IOS/ANDROID)
   */
  async authorize(phone = null) {
    if (this._useSocketTransport && phone) {
      // SMS авторизация для IOS/ANDROID
      console.log('🔐 Авторизация через SMS');
      return await this.authorizeBySMS(phone);
    } else if (this._useSocketTransport && !phone) {
      throw new Error('Для IOS/ANDROID требуется номер телефона. Используйте: authorize("+79001234567")');
    } else {
      // QR авторизация для WEB
      console.log('🔐 Авторизация через QR-код');
      await this.authorizeByQR();
    }
  }


  /**
   * Синхронизация с сервером (получение данных о пользователе, чатах и т.д.)
   */
  async sync() {
    console.log('🔄 Синхронизация с сервером...');
    
    const token = this._token || this.session.get('token');
    
    if (!token) {
      throw new Error('Токен не найден, требуется авторизация');
    }
    
    const payload = {
      interactive: true,
      token: token,
      chatsSync: 0,
      contactsSync: 0,
      presenceSync: 0,
      draftsSync: 0,
      chatsCount: 40
    };
    payload.userAgent = this.userAgent.toJSON();

    const response = await this.sendAndWait(Opcode.LOGIN, payload);
    
    if (response.payload && response.payload.error) {
      const err = response.payload.error;
      const msg = typeof err === 'string' ? err : (response.payload.localizedMessage || JSON.stringify(err));
      throw new Error(msg);
    }
    
    // Сохраняем информацию о пользователе
    const responsePayload = response.payload || {};
    
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
    } else {
      console.log('⚠️ Данные пользователя не найдены в ответе sync');
    }
    
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
      
      try {
        await this.sync();
        this.isAuthorized = true;
        console.log('Подключение с сохраненной сессией успешно');
      } catch (error) {
        console.log('Сессия истекла, требуется повторная авторизация');
        this.session.clear();
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
   * Подключение через TCP Socket (для IOS/ANDROID)
   */
  async _connectSocket() {
    if (this._socketTransport && this._socketTransport.socket && !this._socketTransport.socket.destroyed) {
      this.isConnected = true;
      return;
    }

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
        'Origin': this.origin,
        'User-Agent': this._handshakeUserAgent.headerUserAgent
      };

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

      this.ws.on('close', () => {
        console.log('WebSocket соединение закрыто');
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
      
      // Обработка ответов на запросы по seq
      if (message.seq && this.pendingRequests.has(message.seq)) {
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
   */
  makeMessage(opcode, payload, cmd = 0) {
    this.seq += 1;
    
    return {
      ver: this.ver,
      cmd: cmd,
      seq: this.seq,
      opcode: opcode,
      payload: payload
    };
  }

  /**
   * Отправка запроса и ожидание ответа
   */
  async sendAndWait(opcode, payload, cmd = 0, timeout = 20000) {
    if (!this.isConnected) {
      throw new Error('Соединение не установлено');
    }

    // Используем Socket транспорт для IOS/ANDROID
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

