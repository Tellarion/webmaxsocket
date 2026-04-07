# WebMaxSocket — справочник API

Краткий перечень возможностей для работы с библиотекой. Подробности и примеры — в `README.md`.

**Версия пакета (справочник синхронизирован с):** 1.2.2+

**Зависимости TCP (IOS/ANDROID):** ответы по сокету сжаты **LZ4**; для распаковки используется **`lz4js`**. См. `README.md` → «Зависимости для Socket транспорта».

---

## Экспорт пакета (`require('webmaxsocket')`)

| Символ | Описание |
|--------|----------|
| `WebMaxClient` | Основной клиент |
| `MaxSocketTransport` | Низкоуровневый TCP-транспорт |
| `User`, `Message`, `ChatAction` | Сущности |
| `ChatActions`, `EventTypes`, `MessageTypes` | Константы |
| `Opcode`, `getOpcodeName` | Опкоды протокола |
| `UserAgentPayload` | User-Agent для handshake |
| `downloadUrlToTempFile`, `extFromContentType`, `extFromAttachType` | Скачивание медиа по URL |
| `resolveIncomingLogMode`, `printIncomingLog` | Режим лога входящих |

---

## `WebMaxClient`

Клиент наследует `EventEmitter`: `on`, `once`, `emit`, `off` (в т.ч. событие `connected`, `raw_message`).

### Свойства (полезные)

| Свойство | Описание |
|----------|----------|
| `me` | Профиль после авторизации |
| `session` | Менеджер сессий: `get` / `set` / `clear` / `destroy` / `copyToLastOk`, поле `sessionFile` и др. |
| `isConnected`, `isAuthorized` | Состояние |
| `userAgent` | Текущий User-Agent |
| `deviceId` | ID устройства |
| `incomingLogMode` | `'off'` \| `'messages'` \| `'verbose'` |

### Опции конструктора (выборочно)

| Опция | Описание |
|-------|----------|
| `name` / `session` | Имя файла сессии в `sessions/` |
| `token` | Явный токен (приоритет над файлом сессии; см. `README` → приоритет токена) |
| `configPath` / `config` | Путь к JSON-конфигу с `token`, `agent`, `device_type` и т.д. |
| `deviceType`, `deviceId`, `ua`, `appVersion`, … | User-Agent и устройство — см. `README` |
| `saveToken` | По умолчанию `true` — писать токен в сессию после входа |
| `saveTwofaPassword` | По умолчанию `true` — писать пароль 2FA в сессию после `sendPassword` |
| `sessionBackup` | По умолчанию `true` — после успешного `sync` копия в `*.last_ok.json` |
| `sessionRefreshIntervalMs` | Интервал (мс) периодического `sync()` в работающем клиенте; `0` — выкл. Минимум **10000** мс. Алиас: `autoSyncIntervalMs` |
| `clearSessionOnFailedSync` | По умолчанию `false`. Для `connectWithSession`: при ошибке `sync` вызвать `session.clear()` перед `authorize()` |
| `debug`, `authDebug` | Логи; также `WEBMAX_DEBUG`, `WEBMAX_AUTH_DEBUG` |
| `logIncoming`, `logIncomingVerbose` | Режим лога входящих — см. `README` |
| `maxReconnectAttempts`, `reconnectDelay` | Переподключение WebSocket |

После успешного **`sync()`** при ответе `LOGIN` с полем `tokenAttrs.LOGIN.token`, отличным от текущего, токен обновляется в памяти и в файле сессии (если `saveToken !== false`).

### Запуск и соединение

| Метод | Описание |
|-------|----------|
| `start()` | Подключение, авторизация, обработчики `onStart`; при ошибке `sync` с токеном из config/options файл сессии **не** очищается; при успехе — опциональный таймер `sessionRefreshIntervalMs` |
| `connect()` | Только соединение (низкоуровнево) |
| `connectWithSession()` | Подключение, токен из `sessions/*.json`, `sync()`. При ошибке `sync` — повторная авторизация; очистка файла сессии перед `authorize()` только если `clearSessionOnFailedSync: true` |
| `handshake()` | Handshake (WebSocket-путь) |
| `sync()` | `LOGIN` по токену; при новом токене в ответе — сохранение в сессию |
| `fetchMyProfile()` | Загрузка `me` |
| `stop()` | Снять таймер периодического `sync` (если был), закрыть транспорт |
| `logout()` | Остановка + удаление сессии |

### Авторизация

| Метод | Описание |
|-------|----------|
| `authorize(phone?)` | Сценарий авторизации по умолчанию |
| `authorizeByQR()` | QR (WEB) |
| `authorizeBySMS(phone)` | SMS; возвращает `{ tempToken, phone, sendCode }`. `sendCode(code)` — либо токен (строка), либо при 2FA объект `{ needsPassword, passwordChallenge, trackId, sendPassword }` |
| *(опции)* | `saveTwofaPassword` (по умолчанию `true`) — писать пароль 2FA в сессию после успешного `sendPassword` |
| `requestQR()` | Запрос QR |
| `checkQRStatus(trackId)` | Статус QR |
| `loginByQR(trackId)` | Завершение по QR |
| `pollQRStatus(...)` | Ожидание сканирования QR |
| `showLinkDeviceQR(options?)` | QR «подключить устройство» после входа |

### Сообщения

| Метод | Описание |
|-------|----------|
| `sendMessage({ chatId, text, cid?, replyTo?, attachments? })` | С уведомлением |
| `sendMessageChannel({ ... })` | Канал, `notify: false` |
| `editMessage({ chatId, messageId, text, attachments? })` | Редактирование |
| `deleteMessage({ chatId, messageId, forMe? })` | Удаление |
| `uploadPhoto(chatId, filePath)` | Вложение фото → `attachments` |
| `uploadVideo(chatId, filePath)` | Видео |
| `uploadFile(chatId, filePath, options?)` | Файл |
| `uploadAudio(chatId, filePath)` | Аудио как файл |

### Пины и реакции

| Метод | Описание |
|-------|----------|
| `pinMessage({ chatId, messageId, notifyPin? })` | Закрепить |
| `setMessageReaction({ chatId, messageId, emoji })` | Реакция |
| `cancelMessageReaction({ chatId, messageId })` | Снять реакцию |
| `getMessageReactions({ chatId, messageId, count? })` | Список реакций |

### Чаты, каналы, группы

| Метод | Описание |
|-------|----------|
| `getChats(marker?)` | Список чатов |
| `getHistory(chatId, from?, backward?, forward?)` | История |
| `getChatInfo(chatIds)` | Инфо по id |
| `resolveLink(link)` | LINK_INFO |
| `joinChatByLink(link)` | Вступить по ссылке |
| `setChatSubscription(chatId, subscribe)` | Подписка на канал |
| `createGroup({ title, userIds })` | Новая группа |
| `createChannel({ title })` | Новый канал |
| `muteChat(chatId, mute?)` | Не беспокоить для чата |
| `getChatMembers({ chatId, marker?, count?, type? })` | Участники |
| `inviteToChat({ chatId, userIds, showHistory? })` | Пригласить |
| `removeFromChat({ chatId, userIds, cleanMsgPeriod? })` | Исключить |
| `addChatAdmins({ chatId, userIds, permissions? })` | Админы |
| `removeChatAdmins({ chatId, userIds })` | Снять админов |
| `transferChatOwnership({ chatId, newOwnerId })` | Смена владельца |
| `setGroupOptions({ chatId, options })` | Настройки группы |
| `resolveChannelByUsername(username)` | Канал по @ |
| `joinChannelByUsername(username)` | Вступить по @ |
| `resolveInviteHash(hash)` | Инвайт `join/...` |

### Контакты и профиль

| Метод | Описание |
|-------|----------|
| `getUser(userId)` | Один контакт → `User` |
| `getContacts(contactIds)` | Несколько контактов (сырой ответ) |
| `addContact(userId)` | В контакты |
| `blockUser(userId)` | Блокировка |
| `updateProfile({ firstName?, lastName?, description? })` | Профиль |
| `setHiddenOnline(hidden)` | Скрыть онлайн |
| `setFindableByPhone(mode)` | Поиск по телефону |
| `setCallsPrivacyMode(mode)` | Звонки |
| `setChatsInvitePrivacy(mode)` | Приглашения в чаты |

### Сессии (устройства) и 2FA

| Метод | Описание |
|-------|----------|
| `getSessionsInfo()` | Список сессий; возвращает **payload** |
| `WebMaxClient.normalizeSessionsList(payload)` | Массив `{ time, client, info, location, current, raw }` |
| `closeSessions(payload)` | Закрыть сессии по телу запроса |
| `closeAllSessionsExceptCurrent()` | Завершить все, кроме текущей; возвращает **payload** |
| `getTwoFADetails()` | Параметры 2FA |
| `setTwoFAPassword({ trackId, password, hint?, email? })` | Установка или смена пароля 2FA |

### Обработчики событий

| Метод | Событие |
|-------|---------|
| `onStart(handler)` | Успешный старт |
| `onMessage(handler)` | Новое сообщение |
| `onMessageRemoved(handler)` | Удалено сообщение |
| `onChatAction(handler)` | Действие в чате |
| `onError(handler)` | Ошибки |

### Прочее

| Метод | Описание |
|-------|----------|
| `logIncoming(label, payload)` | Ручной лог `[incoming:…]` |
| `sendAndWait(opcode, payload, cmd?, timeout?)` | Низкоуровневый RPC |
| `triggerHandlers(eventType, data?)` | Внутренний вызов обработчиков (редко нужен снаружи) |

---

## `MaxSocketTransport` (TCP)

| Метод | Описание |
|-------|----------|
| `requestCode(phone, language?)` | Запрос SMS (`AUTH_REQUEST`) |
| `sendCode(tempToken, code)` | Код из SMS (`AUTH` + `CHECK_CODE`) |
| `sendLogin2FAPassword(trackId, password)` | Пароль 2FA после `passwordChallenge` |
| `handshake(userAgent)`, `sendAndWait`, `sync`, `getChats`, `getHistory`, `close` | См. `lib/socketTransport.js` |

---

## `Message`

| Метод / свойство | Описание |
|------------------|----------|
| `id`, `cid`, `chatId`, `text`, `senderId`, `sender`, `attachments`, `rawData`, … | Поля |
| `fetchSender()` | Подгрузить отправителя |
| `getSenderName()` | Имя для лога |
| `reply({ text, cid?, attachments?, quote? })` | Ответ в чат |
| `edit({ text, … })` | Редактировать |
| `delete()` | Удалить |
| `forward(chatId)` | В `Message` вызывает `client.forwardMessage` — метод на клиенте может отсутствовать, проверьте версию |
| `downloadAttachment(index?, options?)` | Скачать вложение по `baseUrl` во временный файл |
| `toJSON()`, `toString()` | Сериализация |

---

## `ChatAction`

| Свойство | Описание |
|----------|----------|
| `type`, `chatId`, `userId`, `user`, `timestamp`, `rawData` | Данные действия |
| `toString()`, `toJSON()` | Представление |

---

## `User`

Основные поля: `id`, `firstname`, `lastname`, `phone`, `avatar`, `fullname` (getter) и др. — см. `lib/entities/User.js`.

---

## Константы

- **`EventTypes`**: `START`, `MESSAGE`, `MESSAGE_REMOVED`, `CHAT_ACTION`, `ERROR`, `DISCONNECT`
- **`ChatActions`**: `TYPING`, `STICKER`, `FILE`, `RECORDING_VOICE`, `RECORDING_VIDEO`
- **`MessageTypes`**: `TEXT`, `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`, `STICKER`

---

## Утилиты (не методы клиента)

| Функция | Описание |
|---------|----------|
| `downloadUrlToTempFile(url, { dir?, filename?, extFallback? })` | HTTP → временный файл |
| `extFromContentType`, `extFromAttachType` | Подбор расширения |
| `resolveIncomingLogMode(options)` | Режим `logIncoming` из опций конструктора |
| `printIncomingLog(label, payload)` | Печать JSON в консоль |

---

*Файл для быстрой навигации; при расхождении с кодом приоритет у реализации в `lib/`.*
