# WebMaxSocket - Node.js Client for Max Messenger

## 📖 Описание / Description

**WebMaxSocket** — async Node.js библиотека для работы с внутренним API мессенджера Max. Поддерживает **QR-код авторизацию**, **Token авторизацию**, **SMS-вход** с опциональным **2FA-паролем** (как в приложении Max), и работу через **WebSocket** (WEB) или **TCP Socket** (ANDROID).

**Текущая версия пакета: 1.2.7**

Сводка всех методов: **[api.package.md](./api.package.md)**.

### Журнал изменений (выдержка)

#### 1.2.7

- **Fingerprint 26.19.2 (6733):** актуальные `APP_VERSION` / `BUILD_NUMBER` (фикс «Приложение устарело» на SMS).
- **`getUserByPhone` / `getUserIdByPhone`:** поиск пользователя по номеру (`CONTACT_INFO_BY_PHONE`).

#### 1.2.6

- **`client.lastSyncPayload`** — сохраняется последний успешный ответ **`LOGIN`/`sync()`** (в т.ч. массив `chats`). На **TCP** список **`getChats()`** иногда пустой, тогда чаты брать из **`lastSyncPayload.chats`**.
- **Скачивание документов `FILE` без `baseUrl` в истории:** **`requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, … })`** — сервер возвращает временный HTTPS-**`url`** для скачивания.
- **`message.downloadAttachment()`** — для **`_type: FILE`** без URL сам вызывает **`requestFileDownloadUrl`** (нужны корректный **`chatId`** сообщения и **`messageId`**).
- **`getHistory`**: в каждое сообщение подмешивается **`chatId`** из аргумента запроса (в сырых сообщениях его часто нет).
- **`Message`**: корректно обрабатывается **`chatId === 0`** (например «Избранное к себе»).
- **TCP + msgpack:** при наличии **`BigInt`** в исходящем payload включается **`useBigInt64`** при кодировании; входящие пакеты декодируются с **`useBigInt64`**, чтобы **`message.id`** и другие int64 не терялись (выше **`Number.MAX_SAFE_INTEGER`**).
- **`downloadMedia`:** расширена карта MIME → расширение (`text/plain`, `application/pdf`, …).
- Новый пример: **`example-download-files.js`** (история чата → папка `downloads/`).

## ✨ Особенности / Features

- ✅ **QR-код авторизация** / QR code authentication  
- ✅ **QR для привязки устройства** (`showLinkDeviceQR`) после входа по SMS/TCP — тот же сценарий, что «Профиль → Устройства → Подключить устройство» в приложении
- ✅ **Token авторизация** / Token authentication
- ✅ **SMS + 2FA по паролю** (ANDROID): после кода из SMS при необходимости второй шаг `AUTH_LOGIN_CHECK_PASSWORD` (opcode `0x73`); сохранение пароля в сессии опционально (`saveTwofaPassword`)
- ✅ **Два транспорта:** WebSocket (WEB) и TCP Socket (ANDROID)
- ✅ **Автоматическое сохранение сессий** / Automatic session storage
- ✅ **Ротация токена после `sync()`:** если сервер возвращает новый `token` в ответе `LOGIN`, он сохраняется в `sessions/*.json` (как при SMS/QR)
- ✅ **Периодический `sync()`** (`sessionRefreshIntervalMs` / `autoSyncIntervalMs`) для продления сессии: на **TCP** после первого `LOGIN` каждый следующий `sync()` — **новое TLS и снова `LOGIN` (19)** (на сокете нельзя второй `LOGIN` подряд; **`SYNC` (21)** с TCP сервер не принимает — см. «Сессии»)
- ✅ **Автовыбор транспорта** после QR-авторизации (переход на TCP)
- ✅ **Отправка и получение сообщений** / Send and receive messages
- ✅ **Загрузка медиа с диска:** `uploadPhoto`, `uploadVideo`, `uploadFile`, `uploadAudio` → `attachments` в `sendMessage` / `sendMessageChannel` / `reply`
- ✅ **Скачивание вложений:** по **`baseUrl`/`url`** — `downloadUrlToTempFile`, `message.downloadAttachment()`; документы **`FILE`** без URL в истории — **`requestFileDownloadUrl()`**
- ✅ **Группы и каналы:** создание, инвайты, админы, участники, ссылки, mute, подписка — см. раздел API
- ✅ **Реакции, пины, настройки профиля и приватности, контакты / блокировка**
- ✅ **Список устройств (сессий)** и **завершение других сеансов** (`getSessionsInfo`, `closeAllSessionsExceptCurrent`) — как «Профиль → Устройства» в Max
- ✅ **Сведения о 2FA и установка пароля по trackId** (`getTwoFADetails`, `setTwoFAPassword`)
- ✅ **Редактирование и удаление сообщений** / Edit and delete messages
- ✅ **Event-driven архитектура** / Event-driven architecture
- ✅ **Входящие звонки (TCP):** опкод **`NOTIF_INCOMING_CALL` (137)**, событие **`incoming_call`** / **`onIncomingCall`**, хелперы **`summarizeIncomingCall`** и др.
- ✅ **Итог звонка в чате:** в **`NOTIF_MESSAGE`** приходит вложение `_type: "CALL"` (`hangupType`, `duration`, `conversationId`) — событие **`call_log`** / **`onCallLog`**, утилиты **`extractCallAttachesFromNotifPayload`**, **`formatCallLogLine`**
- ✅ **Встроенный лог входящих** (`logIncoming`, `WEBMAX_DEBUG`, `WEBMAX_SILENT`) — JSON в консоль без ручных обработчиков
- ✅ **TypeScript-ready** структура / TypeScript-ready structure

## 📦 Установка / Installation

```bash
npm install webmaxsocket
```

### Зависимости для Socket транспорта (ANDROID) / Socket transport dependencies

Ответы сервера по TCP содержат полезную нагрузку в **LZ4**-блоках (поверх **msgpack**). Для распаковки используется **`lz4js`** — чистый JavaScript, **без node-gyp** и нативной сборки, в том числе на Windows без Visual Studio C++. Он входит в зависимости `webmaxsocket` и ставится вместе с пакетом. При необходимости можно доустановить вручную:

```bash
npm install lz4js
```

Дополнительно можно установить нативный модуль **`lz4`**, если в окружении доступна сборка C++:

```bash
npm install lz4
```

**Примечание:** Для обычной QR-авторизации (WEB) дополнительные зависимости не нужны. Socket транспорт используется только после сохранения сессии или при явном указании `deviceType: 'ANDROID'`.

## 📞 Входящие звонки (TCP / ANDROID)

При входящем вызове сервер шлёт **`NOTIF_INCOMING_CALL`** (**opcode 137**): `callerId`, `conversationId`, `type` (`AUDIO` / `VIDEO`), `vcp` (параметры медиа — не логируйте публично).

После ответа / отбоя в том же диалоге часто приходит обычное **`NOTIF_MESSAGE`** с пустым текстом и вложением **`_type: "CALL"`**:

| `hangupType` | `duration` | Наблюдаемый смысл |
|--------------|------------|-------------------|
| `REJECTED` | `0` | Дозвон не завершился разговором (отклонение, сброс до ответа и т.п.) |
| `HUNGUP` | `> 0` | Был разговор, затем положили трубку (мс) |

Связать события одного звонка удобно по **`conversationId`**.

**События `EventEmitter`:** `incoming_call` (payload как с сервера), `call_log` (`{ chatId, message, callAttaches, summaries }`).

**Парные методы (как `onMessage`):** `onIncomingCall(handler)`, `onCallLog(handler)`.

**Отклонение входящего:** экспериментальные методы **`rejectIncomingCall(payload)`** и **`hangupCall(conversationIdOrPayload, { reason? })`** вызывают OK API **`vchat.hangupConversation`** (`conversationId`, `reason`, `anonymToken?`). Для входящего дозвона используйте `reason: 'REJECTED'` (по умолчанию в `rejectIncomingCall`).

**Утилиты:** `summarizeIncomingCall`, `extractCallAttachesFromNotifPayload`, `summarizeCallAttach`, `formatCallLogLine`, `isCallAttach`.

```javascript
const {
  WebMaxClient,
  summarizeIncomingCall,
  formatCallLogLine,
} = require('webmaxsocket');

async function main() {
  const client = new WebMaxClient({ name: 'sms_session', deviceType: 'ANDROID' });

  client.onIncomingCall(async (payload) => {
    console.log('Звонок:', summarizeIncomingCall(payload));

    // Экспериментально: сбросить входящий вызов.
    // Если OK API вернёт ошибку авторизации, передайте okApiSessionKey/okApiSessionSecret
    // в конструктор или в options метода.
    await client.rejectIncomingCall(payload);
  });

  client.onCallLog(({ summaries }) => {
    summaries.forEach((s) => console.log(formatCallLogLine(s)));
  });

  await client.start();
}

main().catch(console.error);
```

## 🚀 Быстрый старт / Quick Start

### Базовый пример / Basic Example

```javascript
const { WebMaxClient } = require('webmaxsocket');

async function main() {
  // Инициализация клиента / Initialize client
  const client = new WebMaxClient({
    name: 'my_session'  // Имя сессии / Session name
  });

  // Обработчик запуска / Start handler
  client.onStart(async () => {
    console.log('✅ Бот запущен!');
    console.log(`👤 Вы вошли как: ${client.me.fullname}`);
  });

  // Обработчик сообщений / Message handler
  client.onMessage(async (message) => {
    // Не отвечаем на свои сообщения / Don't reply to own messages
    if (message.senderId === client.me.id) return;
    
    console.log(`💬 ${message.getSenderName()}: ${message.text}`);
    
    // Автоответ / Auto-reply
    await message.reply({
      text: `Привет! Я получил: "${message.text}"`
    });
  });

  // Запуск / Start
  await client.start();
}

main().catch(console.error);
```

### Авторизация / Authentication

#### Способ 1: QR-код (рекомендуется для первого запуска)

При первом запуске вы увидите QR-код в консоли:

```
🔐 АВТОРИЗАЦИЯ ЧЕРЕЗ QR-КОД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 На телефоне: Профиль → Устройства / Безопасность → Подключить устройство
📸 Отсканируйте QR-код

█████████████████████████████
...
```

После сканирования:
- Токен и clientSessionId сохраняются автоматически
- При следующем запуске клиент **автоматически переключится на TCP Socket** для стабильности
- Повторная авторизация не требуется

#### Способ 2: SMS авторизация (ANDROID)

Авторизация по номеру телефона с кодом из SMS. Если на аккаунте включена **двухфакторная защита паролем**, после верного SMS-кода сервер возвращает **`passwordChallenge`**; тогда нужен второй шаг — **`sendPassword`** (протокол `AUTH_LOGIN_CHECK_PASSWORD`, как в официальном клиенте).

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  deviceType: 'ANDROID', // Обязательно для SMS
  // saveTwofaPassword: true  // по умолчанию: сохранить пароль 2FA в sessions/*.json
});

await client.connect();

const authSession = await client.authorizeBySMS('+79001234567');
const code = '123456'; // код из SMS

const result = await authSession.sendCode(code);

if (result && typeof result === 'object' && result.needsPassword) {
  // Подсказка/почта могут быть в result.passwordChallenge
  await result.sendPassword('ваш_пароль_2FA');
  // после успеха в сессии появится token; при saveTwofaPassword !== false — поле twofaPassword
} else {
  // Обычный вход без пароля: result — строка-токен (уже выполнен sync внутри sendCode)
}

await client.triggerHandlers(client.handlers.START);
```

**Сессия:** для повторных запусков достаточно **токена** в `sessions/<имя>.json` — SMS и пароль 2FA не нужны, пока токен действителен. Поле **`twofaPassword`** (если включено сохранение) используется при **полном** повторном входе (истёк токен): можно подставить пароль без ручного ввода (в примерах учитываются переменные **`TWOFA_PASSWORD`**, **`ASK_TWOFA=1`** для принудительного запроса в консоль).

Или запустите готовый пример:

```bash
node example-sms.js
node example-sms.js +79001234567  # с номером в аргументе
```

#### QR после входа: привязка второго устройства (ANDROID)

Когда вы уже авторизованы по **TCP** (SMS и сохранённая сессия), запрос **`GET_QR` на том же соединении недоступен** (ответ сервера: недопустимое состояние сессии). Для сценария как в приложении — **показать QR, телефон сканирует** — используйте метод **`showLinkDeviceQR()`**: библиотека открывает **отдельное краткоживущее WebSocket-подключение** (как у [web.max.ru](https://web.max.ru)), запрашивает QR, печатает его в консоль и при необходимости ждёт сканирования.

Требования: активное соединение и **`isAuthorized`** (обычно после `await client.start()`).

```javascript
await client.start();

// Показать QR и ждать, пока отсканируют в приложении Max на телефоне
await client.showLinkDeviceQR();

// Только показать QR и вернуть данные (без ожидания скана)
const data = await client.showLinkDeviceQR({ waitForScan: false });
// data: { qrLink, trackId, pollingInterval, expiresAt }
```

Опции: `waitForScan` (по умолчанию `true`), `small` — компактный QR в терминале.

**Версия клиента:** для выдачи QR сервер ожидает актуальный **`appVersion`** в User-Agent (не ниже **25.12.13**). В конструкторе по умолчанию используется **26.19.2** (`buildNumber: 6733`).

Если сервер отвечает **`qr_login.disabled`**, проверьте версию приложения в опциях, откройте [web.max.ru](https://web.max.ru) в браузере или войдите на втором устройстве по номеру телефона.

#### Устройства (сессии) и 2FA в аккаунте

После **`start()`** (или `connect` + `sync`) доступны:

- **`getSessionsInfo()`** — payload со списком сессий (часто поле **`sessions`**). Удобный разбор: **`WebMaxClient.normalizeSessionsList(payload)`** → массив `{ time, client, info, location, current, raw }`.
- **`closeAllSessionsExceptCurrent()`** — завершить все сессии, кроме текущей (аналог «Завершить другие сеансы»). Отправляется только **явный список `times` (и варианты `sessionTimes` / `ids`) чужих устройств** из `getSessionsInfo`. Флаги вида `allExceptCurrent` **не используются** — на стороне Max они приводили к инвалидации **текущего** токена. Текущая сессия определяется по полю **`current`** и по совпадению **`deviceId`** с клиентом (см. `normalizeSessionsList`).
- **`closeSessions(payload)`** — низкоуровневый вызов `SESSIONS_CLOSE` с произвольным телом.
- **`getTwoFADetails()`** — состояние и параметры 2FA.
- **`setTwoFAPassword({ trackId, password, hint?, email? })`** — включение или смена пароля по **`trackId`** из сценария приложения; до получения **`trackId`** может понадобиться навигация в официальном клиенте.

Пример:

```javascript
await client.start();

const info = await client.getSessionsInfo();
const devices = WebMaxClient.normalizeSessionsList(info);
console.log(devices);

// по желанию — завершить все, кроме этой сессии
// await client.closeAllSessionsExceptCurrent();

const twoFA = await client.getTwoFADetails();
// await client.setTwoFAPassword({ trackId: '...', password: '...', hint: '...' });
```

Готовый скрипт: **`node example-sessions-2fa.js`** (с флагом **`--close-others`** — с подтверждением завершит другие сеансы).

#### Способ 3: Token авторизация

Если у вас уже есть токен (от другого сервиса/приложения):

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  token: 'An_Sx6HQ9HDiftNkVBNf6Q5PG5D8Oyj...',  // Ваш токен
  configPath: 'config/myconfig.json',  // Или из файла
  saveToken: true
});

await client.start();
```

Формат конфига (`config/default.json`):
```json
{
  "token": "An_Sx6HQ9HDiftNk...",
  "ua": "Mozilla/5.0 (Linux; Android 14) ...",
  "device_type": 3,
  "deviceType": "ANDROID",
  "appVersion": "26.19.2",
  "buildNumber": 6733
}
```

#### Транспорты

- **WEB** (`deviceType: 'WEB'` или `device_type: 1`) → WebSocket (ws-api.oneme.ru)
- **ANDROID** (`deviceType: 'ANDROID'` или `device_type: 2/3`) → TCP Socket (api.oneme.ru)

Клиент **автоматически выбирает** правильный транспорт на основе сохраненного deviceType.

## API

### WebMaxClient

Основной класс для работы с API Max.

#### Конструктор

```javascript
const client = new WebMaxClient({
  name: 'session',        // Имя сессии (для сохранения авторизации)
  token: 'An_Sx6H...',    // Токен авторизации (опционально)
  configPath: 'myconfig', // Путь к config файлу (опционально)
  deviceType: 'WEB',      // Тип устройства: 'WEB' или 'ANDROID' (опционально)
  saveToken: true,        // Сохранять токен в сессию (по умолчанию true)
  debug: false,           // TCP/WebSocket: краткий лог opcode; также учитывается WEBMAX_DEBUG=1, DEBUG=1
  // Лог входящих (JSON в консоль), см. ниже:
  logIncoming: undefined, // false | 'messages' | 'verbose' — по умолчанию см. таблицу
  logIncomingVerbose: false, // явно включить verbose (как logIncoming: 'verbose')
  apiUrl: 'wss://...',    // URL WebSocket API (опционально)
  maxReconnectAttempts: 5,// Максимальное количество попыток переподключения
  reconnectDelay: 3000,   // Задержка между попытками переподключения (мс)
  // Сессия и токен (см. раздел «Сессии»):
  sessionRefreshIntervalMs: 0, // Периодический sync (мс), минимум 10_000; 0 — выключено. Алиас: autoSyncIntervalMs
  clearSessionOnFailedSync: false, // connectWithSession: при ошибке sync вызвать session.clear() перед authorize() (по умолчанию false)
  // User-Agent / клиент (важно для GET_QR, см. showLinkDeviceQR):
  appVersion: '26.19.2',  // Актуальная версия Android-клиента
  ua: 'Mozilla/5.0 ...', // или headerUserAgent
  osVersion: '14',
  screen: '360x780 3.0x',
  timezone: 'Europe/Moscow',
  locale: 'ru',
  buildNumber: 6733,      // опционально
  clientSessionId: 1      // опционально
});
```

**Лог входящих (`logIncoming`):** печать блоков `📥 [incoming:…]` с JSON.

| Значение / условие | Поведение |
|--------------------|-----------|
| `logIncoming: false` | Выкл. |
| `logIncoming: 'messages'` | Только входящие сообщения (`message.rawData`). |
| `logIncoming: 'verbose'` или `logIncomingVerbose: true` | Сообщения + `connected`, `raw_message`, `message_removed`, `chat_action`, `error`. |
| не указано | По умолчанию: как `'messages'`; если **`WEBMAX_DEBUG=1`** — как `'verbose'`. Явное **`logIncoming: 'messages'`** отключает расширенный режим даже при `WEBMAX_DEBUG`. |
| **`WEBMAX_SILENT=1`** | Выкл. всех дампов. |

Ручной вывод в том же формате: `client.logIncoming('my_label', data)`. Текущий режим: `client.incomingLogMode` (`'off' \| 'messages' \| 'verbose'`). Низкоуровнево: `resolveIncomingLogMode(options)`, `printIncomingLog(label, payload)` из пакета.

#### Методы

##### `start()`

Запускает клиент и устанавливает соединение.

```javascript
await client.start();
```

##### `authorizeBySMS(phone)`

Авторизация по номеру телефона через SMS (только для ANDROID). Возвращает объект с полями **`tempToken`**, **`phone`**, **`sendCode`**.

**`sendCode(code)`** после ввода кода из SMS:

- если пароль 2FA **не** требуется — возвращает **строку-токен** (внутри уже выполнены сохранение сессии и **`sync()`**);
- если требуется 2FA — возвращает объект **`{ needsPassword: true, passwordChallenge, trackId, sendPassword }`**. Вызовите **`await sendPassword(password)`**; при успехе выполняется **`sync()`**, при **`saveTwofaPassword !== false`** (по умолчанию `true`) в файл сессии записывается **`twofaPassword`** для следующих полных входов.

Опция конструктора **`saveTwofaPassword: false`** отключает запись пароля 2FA в `sessions/*.json`.

Низкоуровнево на TCP: **`sendCode`** → `AUTH` (18) с `authTokenType: 'CHECK_CODE'`; **`sendPassword`** → **`AUTH_LOGIN_CHECK_PASSWORD`** (`0x73`) с полями **`trackId`** и **`password`** (см. `MaxSocketTransport.sendLogin2FAPassword`).

```javascript
await client.connect();
const authSession = await client.authorizeBySMS('+79001234567');
const out = await authSession.sendCode('123456');
if (out && out.needsPassword) await out.sendPassword('…');
```

##### `showLinkDeviceQR(options)`

Показать в консоли **QR-код для привязки устройства** (как в приложении Max: телефон сканирует QR). Нужна **уже выполненная авторизация** (`start()` или `connect` + `sync`).

- Для **WEB** запрос выполняется по текущему WebSocket.
- Для **ANDROID** после входа по TCP используется **второе** WebSocket-подключение без повторного `LOGIN` на той сессии (иначе `GET_QR` на том же TCP недоступен).

```javascript
await client.showLinkDeviceQR();
await client.showLinkDeviceQR({ waitForScan: false, small: false });
```

Возвращает `Promise<{ qrLink, trackId, pollingInterval, expiresAt }>`.

##### `requestQR()`, `checkQRStatus(trackId)`, `loginByQR(trackId)`, `authorizeByQR()`

Низкоуровневые шаги QR-авторизации для **WEB** (первый вход без SMS). Обычно достаточно `start()` без токена или `authorizeByQR()`.

##### `sendMessage(options)`

Отправляет сообщение в чат с уведомлением (notify: true).

```javascript
const message = await client.sendMessage({
  chatId: 123,
  text: 'Привет!',
  // cid опционально; на TCP не используйте Date.now() (нужен int32)
  replyTo: null,        // ID сообщения для ответа (опционально)
  attachments: []       // Вложения (опционально)
});
```

##### `sendMessageChannel(options)`

Отправляет сообщение в канал без уведомления (notify: false). Поля **`text`**, **`replyTo`**, **`attachments`** — те же, что у `sendMessage` (вложения из `uploadPhoto` / `uploadVideo` / `uploadFile` / `uploadAudio`).

```javascript
const message = await client.sendMessageChannel({
  chatId: 123,
  text: 'Сообщение в канал',
  replyTo: null,
  attachments: [] // опционально: [attach] после upload*
});
```

##### `editMessage(options)`

Редактирует сообщение.

```javascript
await client.editMessage({
  messageId: 456,
  chatId: 123,
  text: 'Исправленный текст',
  attachments: [] // опционально, после upload*
});
```

##### Пины, реакции

| Метод | Назначение |
|--------|------------|
| `pinMessage({ chatId, messageId, notifyPin })` | Закрепить сообщение |
| `setMessageReaction({ chatId, messageId, emoji })` | Эмодзи-реакция |
| `cancelMessageReaction({ chatId, messageId })` | Снять реакцию |
| `getMessageReactions({ chatId, messageId, count })` | Список реакций |

##### Чаты, каналы, группы

| Метод | Назначение |
|--------|------------|
| `getChatInfo(chatIds)` | Информация по id (массив или одно число) |
| `resolveLink(link)` | Разрешить URL / `join/…` (LINK_INFO) |
| `joinChatByLink(link)` | Вступить по ссылке |
| `setChatSubscription(chatId, subscribe)` | Подписка на канал |
| `createGroup({ title, userIds })` | Новая группа |
| `createChannel({ title })` | Новый канал |
| `muteChat(chatId, mute)` | Уведомления чата (не беспокоить) |
| `getChatMembers({ chatId, marker, count, type })` | Участники (count ≤ 500) |
| `inviteToChat({ chatId, userIds, showHistory })` | Пригласить |
| `removeFromChat({ chatId, userIds, cleanMsgPeriod })` | Исключить |
| `addChatAdmins({ chatId, userIds, permissions })` | Выдать админку (по умолчанию `permissions: 120`) |
| `removeChatAdmins({ chatId, userIds })` | Снять админку |
| `transferChatOwnership({ chatId, newOwnerId })` | Передать владение |
| `setGroupOptions({ chatId, options })` | Настройки группы (`ALL_CAN_PIN_MESSAGE`, …) |
| `resolveChannelByUsername(username)` | Канал по @username |
| `joinChannelByUsername(username)` | Вступить по @username |
| `resolveInviteHash(hash)` | Инвайт по хэшу без префикса `join/` |

##### Контакты и профиль

| Метод | Назначение |
|--------|------------|
| `getContacts(contactIds)` | Несколько контактов (массив id) |
| `addContact(userId)` | В контакты |
| `blockUser(userId)` | Заблокировать |
| `updateProfile({ firstName, lastName, description })` | Своё имя / описание |
| `setHiddenOnline(hidden)` | Скрыть «в сети» |
| `setFindableByPhone(mode)` | `'ALL'` \| `'CONTACTS'` или boolean |
| `setCallsPrivacyMode(mode)` | Кто может звонить |
| `setChatsInvitePrivacy(mode)` | Кто может приглашать в чаты |

Часть методов требует прав в чате; ответы сервера зависят от роли и типа чата.

##### `deleteMessage(options)`

Удаляет сообщение.

```javascript
await client.deleteMessage({
  messageId: 456,
  chatId: 123
});
```

##### `forwardMessage(options)`

Пересылает сообщение.

```javascript
await client.forwardMessage({
  messageId: 456,
  fromChatId: 123,
  toChatId: 789
});
```

##### Загрузка медиа для `attachments`

Все методы ниже возвращают объект(ы), которые передаются в **`attachments`** у `sendMessage`, **`sendMessageChannel`** и **`message.reply`**. Нужен **Node.js 18+** (`fetch`, `FormData`). Схема: опкод загрузки → `UPLOAD_ATTACH_PREP` (65) → HTTP POST на выданный URL. Для **видео** и **файлов** после POST клиент ждёт **`NOTIF_ATTACH` (opcode 136)**.

| Метод | Результат для `attachments` |
|--------|-----------------------------|
| `uploadPhoto(chatId, filePath)` | `{ _type: 'PHOTO', photoToken }` |
| `uploadVideo(chatId, filePath)` | `{ _type: 'VIDEO', videoId, token }` |
| `uploadFile(chatId, filePath, options?)` | `{ _type: 'FILE', fileId }` — документы, архивы; `options`: `{ filename, mimeType }` |
| `uploadAudio(chatId, filePath)` | то же, что `uploadFile` с MIME для `.mp3`, `.ogg`, `.m4a`, `.wav`, … |

```javascript
const photo = await client.uploadPhoto(chatId, './a.png');
const video = await client.uploadVideo(chatId, './b.mp4');
const file = await client.uploadFile(chatId, './doc.pdf');
const audio = await client.uploadAudio(chatId, './track.mp3');

await client.sendMessage({
  chatId,
  text: 'Набор вложений',
  attachments: [photo, video]
});

await client.sendMessageChannel({
  chatId,
  text: 'В канал с файлом',
  attachments: [file]
});
```

##### `sendChatAction(chatId, action)`

Отправляет действие в чате (печатает, выбирает стикер и т.д.).

```javascript
await client.sendChatAction(123, ChatActions.TYPING);
```

##### `getUser(userId)`

Получает информацию о пользователе.

```javascript
const user = await client.getUser(123);
```

##### `getUserByPhone(phone)` / `getUserIdByPhone(phone)`

Поиск пользователя по номеру (`CONTACT_INFO_BY_PHONE`, opcode 46). Номер нормализуется (`+79001234567`). Если пользователь не найден или скрыл поиск по телефону — `null`.

```javascript
const user = await client.getUserByPhone('+79001234567');
// User { id, firstname, lastname, phone, ... } или null

const id = await client.getUserIdByPhone('89001234567');
// 123456789 или null
```

##### `getChats(limit, offset)`

Получает список чатов.

```javascript
const chats = await client.getChats(50, 0);
```

##### `getHistory(chatId, from?, backward?, forward?)`

Получает историю сообщений. У каждого элемента в массиве будет **`chatId`**, совпадающий с запрошенным чатом (в ответе сервера поле часто отсутствует).

```javascript
const messages = await client.getHistory(123, Date.now(), 50, 0);
```

##### `requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, requestId?, attachLocalId? })`

Запрашивает **временный HTTPS URL** для вложения **`FILE`**, если в **`attaches`** нет **`baseUrl`**. Идентификаторы **`messageId`**, **`fileId`**, **`chatId`** должны совпадать с данными сообщения (для больших id используйте **`bigint`** из объекта **`Message`**, не округляйте в обычный **`Number`**).

Возвращает **`Promise<string>`** (URL). Проще вызывать **`message.downloadAttachment()`**, он подставит нужные поля сам.

##### Свойство `lastSyncPayload`

После успешного **`sync()`** — объект последнего ответа сервера (поля вроде **`chats`**, **`profile`**, …). Удобно, если **`getChats()`** на TCP вернул пустой список.

##### `stop()`

Останавливает клиент.

```javascript
await client.stop();
```

##### `logout()`

Выполняет выход из аккаунта и удаляет сессию.

```javascript
await client.logout();
```

#### Обработчики событий

##### `onStart(handler)`

Регистрирует обработчик запуска клиента.

```javascript
client.onStart(async () => {
  console.log('Клиент запущен!');
});
```

##### `onMessage(handler)`

Регистрирует обработчик новых сообщений.

```javascript
client.onMessage(async (message) => {
  console.log('Новое сообщение:', message.text);
});
```

##### `onMessageRemoved(handler)`

Регистрирует обработчик удаленных сообщений.

```javascript
client.onMessageRemoved(async (message) => {
  console.log('Сообщение удалено:', message.text);
});
```

##### `onChatAction(handler)`

Регистрирует обработчик действий в чате.

```javascript
client.onChatAction(async (action) => {
  console.log('Действие в чате:', action.type);
});
```

##### `onError(handler)`

Регистрирует обработчик ошибок.

```javascript
client.onError(async (error) => {
  console.error('Ошибка:', error.message);
});
```

### Message

Класс, представляющий сообщение.

#### Свойства

- `id` - ID сообщения
- `cid` - Client ID сообщения
- `chatId` - ID чата
- `text` - Текст сообщения
- `senderId` - ID отправителя
- `sender` - Объект отправителя (User)
- `timestamp` - Время отправки
- `type` - Тип сообщения
- `isEdited` - Флаг редактирования
- `replyTo` - ID сообщения, на которое это является ответом
- `attachments` - Вложения

#### Методы

##### `reply(options)`

Отправляет текст **в тот же чат**. По умолчанию **без** цитаты исходного сообщения (`link REPLY`), т.к. на TCP-сокете сервер часто возвращает «Ошибка валидации» для ответа-цитаты. Чтобы попробовать ответ с цитатой: `{ text: '...', quote: true }`.

```javascript
await message.reply({ text: 'Ответ на сообщение' });
await message.reply({ text: '...', quote: true });
```

##### `edit(options)`

Редактирует сообщение.

```javascript
await message.edit({
  text: 'Новый текст'
});
```

##### `delete()`

Удаляет сообщение.

```javascript
await message.delete();
```

##### `forward(chatId)`

Пересылает сообщение.

```javascript
await message.forward(789);
```

##### `downloadAttachment(index, options?)`

Скачивает вложение в файл (по умолчанию каталог **`os.tmpdir()`**). Логика:

- если у вложения есть **`baseUrl`** или **`url`** (часто **`PHOTO`**, стикеры и т.д.) — обычный HTTPS-запрос;
- если **`_type === 'FILE'`** и URL нет — внутри вызывается **`client.requestFileDownloadUrl()`** (нужны **`message.chatId`** и точный **`message.id`**; после **`getHistory`** они выставлены, **`id` может быть `bigint`**).

Опции: **`dir`**, **`filename`** (basename). Расширение подбирается по **`Content-Type`** и типу вложения.

Возвращает `{ path, contentType }`.

```javascript
if (message.attachments.length) {
  const { path, contentType } = await message.downloadAttachment(0);
  console.log('Сохранено:', path, contentType);
  // после обработки можно удалить: fs.unlinkSync(path)
}

// Свой каталог или имя файла:
await message.downloadAttachment(0, {
  dir: './downloads',
  filename: 'photo.webp'
});
```

### Утилиты скачивания медиа / Media download helpers

Экспортируются из пакета наряду с `WebMaxClient`:

```javascript
const {
  downloadUrlToTempFile,
  extFromContentType,
  extFromAttachType
} = require('webmaxsocket');
```

##### `downloadUrlToTempFile(url, options?)`

HTTP(S)-запрос с следованием редиректам, запись тела ответа в файл.

| Опция | Описание |
|--------|----------|
| `dir` | Каталог (по умолчанию `os.tmpdir()`) |
| `filename` | Имя файла (только basename); если не задано — `max-media-<time>-<random>.<ext>` |
| `extFallback` | Расширение, если по `Content-Type` определить не удалось (например `'.jpg'`) |

```javascript
const { path, contentType } = await downloadUrlToTempFile(
  'https://i.oneme.ru/i?r=...',
  { extFallback: '.jpg' }
);
```

##### `extFromContentType(contentType)` / `extFromAttachType(attachType)`

Вспомогательные функции для подбора расширения по MIME или по `_type` вложения (`PHOTO`, `VIDEO`, …).

### User

Класс, представляющий пользователя.

#### Свойства

- `id` - ID пользователя
- `firstname` - Имя
- `lastname` - Фамилия
- `username` - Имя пользователя
- `phone` - Номер телефона
- `avatar` - URL аватара
- `status` - Статус
- `bio` - Биография
- `fullname` - Полное имя (getter)

### ChatAction

Класс, представляющий действие в чате.

#### Свойства

- `type` - Тип действия
- `chatId` - ID чата
- `userId` - ID пользователя
- `user` - Объект пользователя (User)
- `timestamp` - Время действия

### Константы

#### ChatActions

```javascript
const { ChatActions } = require('webmaxsocket');

ChatActions.TYPING          // Печатает
ChatActions.STICKER         // Выбирает стикер
ChatActions.FILE            // Отправляет файл
ChatActions.RECORDING_VOICE // Записывает голосовое
ChatActions.RECORDING_VIDEO // Записывает видео
```

### MaxSocketTransport

Низкоуровневый TCP Socket транспорт для ANDROID (api.oneme.ru). Входящие пакеты с флагом сжатия распаковываются через **LZ4** (см. раздел **«Зависимости для Socket транспорта»** выше).

#### Прямое использование (advanced)

```javascript
const { MaxSocketTransport } = require('webmaxsocket');

const transport = new MaxSocketTransport({
  deviceType: 'ANDROID',
  ua: 'Mozilla/5.0 (Linux; Android 14) ...',
  deviceId: 'your-device-id',
  debug: true
});

await transport.connect();
await transport.handshake(userAgentPayload);
const syncData = await transport.sync(token, userAgent);
```

**Примечание:** В большинстве случаев используйте `WebMaxClient`, который автоматически выбирает нужный транспорт.

## 📚 Примеры

### Пример 1: QR-авторизация (example.js)

```bash
node example.js
```

Первый запуск - QR-авторизация, повторные запуски - автоматический вход через TCP Socket.

### Пример 2: Token авторизация (example-token.js)

```bash
# Через config файл
node example-token.js
node example-token.js myconfig  # config/myconfig.json

# Через переменную окружения
TOKEN="ваш_токен" node example-token.js
```

### Пример 3: SMS авторизация (example-sms.js)

```bash
# Интерактивный ввод номера
node example-sms.js

# С номером в аргументе
node example-sms.js +79001234567
```

### Пример 5: Скачивание вложений из истории чата (example-download-files.js)

Нужна **сохранённая Android-сессия** (`sessions/<name>.json`). Скрипт вызывает **`sync()`**, читает историю и сохраняет вложения в **`./downloads/`**.

```bash
cd node_modules/webmaxsocket   # или из корня клона репозитория

# chatId — число или 0 (например «Избранное к себе»)
node example-download-files.js 0 30

# Имя сессии и глубина истории через env
SESSION_NAME=sms_session BACKWARD=50 node example-download-files.js 123456

npm run example:download -- 0 20
```

## Структура проекта

```
webmaxsocket/
├── lib/
│   ├── client.js           # Основной клиент
│   ├── socketTransport.js  # TCP Socket транспорт
│   ├── session.js          # Управление сессиями
│   ├── userAgent.js        # UserAgent генератор
│   ├── opcodes.js          # Протокол опкоды
│   ├── constants.js        # Константы
│   ├── downloadMedia.js    # Скачивание медиа по URL во временный файл
│   ├── incomingLog.js      # Режим logIncoming / печать входящих
│   └── entities/
│       ├── User.js         # Класс пользователя
│       ├── Message.js      # Класс сообщения
│       ├── ChatAction.js   # Класс действия в чате
│       └── index.js        # Экспорт сущностей
├── config/                 # Конфигурационные файлы
│   └── example.json        # Пример конфига
├── sessions/               # Директория с сохраненными сессиями
├── index.js                # Точка входа
├── example.js              # QR-авторизация
├── example-token.js        # Token авторизация
├── example-sms.js          # SMS авторизация
├── example-download-files.js  # Скачивание вложений из истории чата
├── package.json
├── api.package.md          # Справочник API (все методы)
└── README.md
```

## Сессии

Библиотека автоматически сохраняет сессии в директории `sessions/`. При повторном запуске с тем же именем сессии авторизация не требуется.

**Токен после `sync()`:** при успешном `LOGIN` (вызов `sync()`) сервер может вернуть новый токен в `tokenAttrs.LOGIN.token`. Если он отличается от сохранённого, библиотека обновляет `this._token` и файл сессии (если `saveToken !== false`). Так ротация на стороне Max не теряется между перезапусками.

**TCP (ANDROID) и повторный `sync()`:** на одном TLS‑сокете **второй подряд `LOGIN` (19)** сервер отклоняет («Недопустимое состояние сессии»). Запрос **`SYNC` (21)** на том же транспорте стабильно даёт «Что-то пошло не так» (в веб-клиенте повторная синхронизация идёт через **`LOGIN` (19)**, не через 21). Поэтому после первого успешного `LOGIN` каждый следующий **`sync()`** на TCP: **закрыть сокет → новое соединение → полный `LOGIN` (19)** с телом как у веб (`lastLogin`, счётчики, `presenceSync: -1`, `userAgent`). На **WEB** каждый `sync()` по-прежнему идёт как `LOGIN` на том же WebSocket.

**Параллельные RPC на одном TCP:** транспорт сопоставляет ответы по **`seq % 256`**. Не вызывайте **`sendAndWait`** (и методы поверх него: `sync`, `getSessionsInfo`, …) **параллельно** на одном клиенте — возможна путаница ответов и ложные ошибки. Выполняйте запросы **последовательно** или используйте очередь.

**Периодическое обновление:** опция **`sessionRefreshIntervalMs`** (или **`autoSyncIntervalMs`**) — интервал для повторного `sync()` (минимум **10 с**). На **TCP** каждый такой вызов обычно **снова открывает TLS** и шлёт **`LOGIN`**. Таймер снимается в **`stop()`**. Ручная очистка: **`client.session.clear()`**.

**Повторный вход при ошибке токена из config:** при неудачном `sync()` с токеном из **`options.token`** или **`config`** файл `sessions/*.json` **не очищается** (чтобы сохранить актуальный токен из прошлой авторизации). Для **`connectWithSession()`** очистка перед `authorize()` после ошибки `sync()` выключена по умолчанию; включите **`clearSessionOnFailedSync: true`**, если нужно прежнее поведение «чистый лист».

```javascript
// Создание новой сессии
const client1 = new WebMaxClient({ name: 'account1', phone: '+1234567890' });

// Использование существующей сессии
const client2 = new WebMaxClient({ name: 'account1' }); // phone не требуется

// Пример: раз в 45 минут — sync() для продления ротации токена
const client3 = new WebMaxClient({
  name: 'account1',
  sessionRefreshIntervalMs: 45 * 60 * 1000
});
```

## Обработка ошибок

Рекомендуется всегда оборачивать вызовы API в try-catch блоки:

```javascript
try {
  const message = await client.sendMessage({
    chatId: 123,
    text: 'Привет!'
  });
} catch (error) {
  console.error('Ошибка:', error.message);
}
```

## 🔧 Отладка / Debug

Для включения отладочного вывода:

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  debug: true  // или process.env.DEBUG = '1'
});
```

Или через переменную окружения:

```bash
DEBUG=1 node example.js
```

## 💡 Важные замечания

1. **TCP Socket после QR-авторизации:** После первой успешной QR-авторизации клиент автоматически сохраняет `clientSessionId` и переключается на TCP Socket транспорт при следующем запуске для повышения стабильности.

2. **QR для нового устройства после входа по SMS/TCP:** Используйте `showLinkDeviceQR()`. Это не отдельный опкод в протоколе, а тот же `GET_QR`, что и у веб-клиента; для уже залогиненного TCP-сокета запрос выполняется через **эфемерное WebSocket-подключение** (временный файл сессии `_link_qr_*` удаляется после завершения).

3. **Версия `appVersion` и QR/SMS:** Слишком старая версия в User-Agent даёт `qr_login.disabled` или «Приложение устарело». По умолчанию **26.19.2** / **6733**. Константы: `APP_VERSION`, `BUILD_NUMBER` в `lib/constants.js`.

4. **Разница между sendMessage и sendMessageChannel:**
   - `sendMessage()` - отправка с уведомлением (notify: true) для обычных чатов
   - `sendMessageChannel()` - отправка без уведомления (notify: false) для каналов

5. **Автоматический выбор транспорта:** Клиент автоматически определяет какой транспорт использовать на основе `deviceType` в сессии или config файле.

6. **`cid` при отправке сообщений (TCP/Socket):** сервер проверяет **signed int32**. Не передавайте `Date.now()` (миллисекунды ~1e12) — будет «Ошибка валидации». Либо не указывайте `cid` (клиент подставит свой), либо передайте целое в диапазоне **−2³¹ … 2³¹−1**.

7. **TCP и keep-alive (PING):** сервер периодически шлёт `PING`. На WebSocket клиент отвечает `sendPong`; на **TCP** ответ на серверный `PING` — **`PING` с пустым payload**. Дополнительно клиент может слать исходящий **`PING` с `{ interactive: true }`** раз в **30 с** (как веб), опция **`tcpInteractivePingMs`** ( **`0`** — выключить).

8. **LZ4:** для ANDROID входящие данные распаковываются из LZ4-блоков; **`lz4js`** входит в зависимости пакета. При необходимости можно установить нативный **`lz4`** (см. раздел **«Зависимости для Socket транспорта»**).

9. **Повторный `sync()` на TCP:** см. **«Сессии»** — **новое TLS и снова `LOGIN` (19)**; второй **`LOGIN` (19)** подряд на **том же** сокете сервер не принимает; **`SYNC` (21)** на TCP не использовать.

10. **`closeAllSessionsExceptCurrent`:** не подставляйте в **`closeSessions`** сырые флаги «закрыть все кроме текущего» без явного списка сессий — есть риск инвалидации своего токена; используйте готовый метод.

## 📌 История версий / Changelog

### 1.2.7

- **Fingerprint 26.19.2 (6733):** обновлены `APP_VERSION` / `BUILD_NUMBER` — сервер больше не отвечает «Приложение устарело» на SMS `AUTH_REQUEST`.
- **Старые сессии:** `appVersion`/`buildNumber` больше не читаются из `sessions/*.json` (только options/config/дефолт), чтобы устаревший fingerprint не залипал.
- **`getUserByPhone(phone)` / `getUserIdByPhone(phone)`:** поиск пользователя по номеру через opcode `CONTACT_INFO_BY_PHONE` (46). При `contact.not.found` возвращают `null`.

### 1.2.6

- **`client.lastSyncPayload`** — сохраняется последний успешный ответ **`LOGIN`/`sync()`** (в т.ч. массив `chats`). На **TCP** список **`getChats()`** иногда пустой, тогда чаты брать из **`lastSyncPayload.chats`**.
- **Скачивание документов `FILE` без `baseUrl` в истории:** **`requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, … })`** — сервер возвращает временный HTTPS-**`url`** для скачивания.
- **`message.downloadAttachment()`** — для **`_type: FILE`** без URL сам вызывает **`requestFileDownloadUrl`** (нужны корректный **`chatId`** сообщения и **`messageId`**).
- **`getHistory`**: в каждое сообщение подмешивается **`chatId`** из аргумента запроса (в сырых сообщениях его часто нет).
- **`Message`**: корректно обрабатывается **`chatId === 0`** (например «Избранное к себе»).
- **TCP + msgpack:** при наличии **`BigInt`** в исходящем payload включается **`useBigInt64`** при кодировании; входящие пакеты декодируются с **`useBigInt64`**, чтобы **`message.id`** и другие int64 не терялись (выше **`Number.MAX_SAFE_INTEGER`**).
- **`downloadMedia`:** расширена карта MIME → расширение (`text/plain`, `application/pdf`, …).
- Новый пример: **`example-download-files.js`** (история чата → папка `downloads/`).

### 1.2.5

- **`Opcode.NOTIF_INCOMING_CALL` (137)** — имя опкода в `getOpcodeName`; обработка в TCP/WebSocket: событие **`incoming_call`**, **`onIncomingCall`**, плюс **`raw_message`** как раньше.
- **`onCallLog`** / событие **`call_log`**: при **`NOTIF_MESSAGE`** с вложением **`_type: "CALL"`** (итог звонка: `hangupType`, `duration`, `conversationId`).
- **`rejectIncomingCall`** / **`hangupCall`**: экспериментальная отправка сброса звонка через OK API метод **`vchat.hangupConversation`** (`conversationId`, `reason=REJECTED`).
- Модуль **`lib/callHelpers.js`** (экспорт из пакета): `summarizeIncomingCall`, `extractCallAttachesFromNotifPayload`, `summarizeCallAttach`, `formatCallLogLine`, `isCallAttach`.
- **`EventTypes.INCOMING_CALL`**, **`EventTypes.CALL_LOG`**.

### 1.2.4

- **ANDROID по умолчанию для SMS/TCP:** `device_type: 2/3` нормализуется в `ANDROID`; дефолтный fingerprint обновлён до `appVersion: 26.14.1`, `buildNumber: 6686`.
- **Удалён устаревший socket example:** SMS-примеры и низкоуровневый TCP-путь теперь используют Android-профиль.

### 1.2.3

- **TCP / повторный `sync()`:** после первого `LOGIN` каждый следующий `sync()` — **переподключение и полный `LOGIN` (19)** (op. **21** на TCP сервер отклоняет; тело LOGIN с **`lastLogin`** и счётчиками из сессии).
- **TCP:** периодический исходящий **`PING` `{ interactive: true }`** (~30 с), опция **`tcpInteractivePingMs`**.
- **`closeAllSessionsExceptCurrent`:** закрытие только по **явным `times`** чужих сессий; без флагов `allExceptCurrent` / `excludeCurrent`; учёт **`deviceId`** и **`current`** при выборе «своей» сессии.
- **`normalizeSessionsList`:** поле **`deviceId`**, доп. признаки текущей сессии в ответе.
- **`sync()` / LOGIN:** сохранение нового токена из ответа `tokenAttrs.LOGIN.token` при ротации на сервере.
- **Ротация токена из входящих пакетов:** рекурсивный разбор **`tokenAttrs.LOGIN.token`** в любом **уведомлении TCP** и в **сообщениях WebSocket** (как в официальном клиенте при пушах ротации), плюс вложенные массивы в ответе LOGIN — чтобы файл сессии не оставался со старым токеном после смены на сервере.
- **`sessionRefreshIntervalMs`** / **`autoSyncIntervalMs`:** периодический `sync()` в фоне (минимум 10 с), таймер в `stop()`; на TCP типичен **новый TLS** на каждый тик.
- **`start()`:** при ошибке `sync()` с токеном из config/options вызов **`session.clear()`** убран — файл сессии не теряется.
- **`clearSessionOnFailedSync`** (по умолчанию `false`): для **`connectWithSession()`** — опционально вызывать **`session.clear()`** перед повторной авторизацией после ошибки `sync()`.

### 1.2.1

- Список устройств и завершение других сеансов: **`getSessionsInfo`**, **`normalizeSessionsList`**, **`closeSessions`**, **`closeAllSessionsExceptCurrent`**.
- 2FA в аккаунте: **`getTwoFADetails`**, **`setTwoFAPassword`**. Пример: **`example-sessions-2fa.js`**.

### 1.2.0

- SMS-авторизация: поддержка **2FA по паролю** после кода из SMS (`passwordChallenge`, `AUTH_LOGIN_CHECK_PASSWORD` / opcode `0x73`).
- Опция **`saveTwofaPassword`** (по умолчанию включена): сохранение пароля 2FA в файл сессии **`twofaPassword`**.
- **`MaxSocketTransport`**: метод **`sendLogin2FAPassword(trackId, password)`**.

### 1.1.6 и ранее

- См. коммиты и теги в [репозитории](https://github.com/Tellarion/webmaxsocket).

## 🔗 Ссылки / Links

- [GitHub Repository](https://github.com/Tellarion/webmaxsocket)
- [NPM Package](https://www.npmjs.com/package/webmaxsocket)

## 📄 Лицензия / License

MIT License - see LICENSE file for details

## 👤 Автор / Author

Tellarion - [tellarion.dev](https://tellarion.dev)

## 💝 Поддержка / Support

Если вам нравится эта библиотека и вы хотите поддержать разработку:

**USDT (TRC20):** `TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE`

Спасибо за вашу поддержку!