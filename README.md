# WebMaxSocket - Node.js Client for Max Messenger

## 📖 Описание / Description

**WebMaxSocket** — async Node.js библиотека для работы с внутренним API мессенджера Max. Поддерживает **QR-код авторизацию**, **Token авторизацию**, и работу через **WebSocket** (WEB) или **TCP Socket** (IOS/ANDROID).

## ✨ Особенности / Features

- ✅ **QR-код авторизация** / QR code authentication  
- ✅ **Token авторизация** / Token authentication
- ✅ **Два транспорта:** WebSocket (WEB) и TCP Socket (IOS/ANDROID)
- ✅ **Автоматическое сохранение сессий** / Automatic session storage
- ✅ **Автовыбор транспорта** после QR-авторизации (переход на TCP)
- ✅ **Отправка и получение сообщений** / Send and receive messages
- ✅ **Редактирование и удаление сообщений** / Edit and delete messages
- ✅ **Event-driven архитектура** / Event-driven architecture
- ✅ **Обработка входящих уведомлений** / Handle incoming notifications
- ✅ **TypeScript-ready** структура / TypeScript-ready structure

## 📦 Установка / Installation

```bash
npm install webmaxsocket
```

### Зависимости для Socket транспорта (IOS/ANDROID)

Для работы с TCP Socket транспортом требуется библиотека `lz4`. Если при установке возникают проблемы с `node-gyp`:

```bash
npm install lz4 --ignore-scripts
```

**Примечание:** Для обычной QR-авторизации (WEB) дополнительные зависимости не нужны. Socket транспорт используется только после сохранения сессии или при явном указании `deviceType: 'IOS'`/`'ANDROID'`.

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
      text: `Привет! Я получил: "${message.text}"`,
      cid: Date.now()
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

📱 Откройте приложение Max на телефоне
➡️  Настройки → Устройства → Подключить устройство
📸 Отсканируйте QR-код

█████████████████████████████
...
```

После сканирования:
- Токен и clientSessionId сохраняются автоматически
- При следующем запуске клиент **автоматически переключится на TCP Socket** для стабильности
- Повторная авторизация не требуется

#### Способ 2: SMS авторизация (IOS/ANDROID)

Авторизация по номеру телефона с кодом из SMS:

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  deviceType: 'IOS'  // Обязательно для SMS авторизации
});

await client.connect();

// Запрос кода
const authSession = await client.authorizeBySMS('+79001234567');

// Получаем код из SMS и отправляем
const code = '123456';  // Код из SMS
await authSession.sendCode(code);

// Завершаем запуск
await client.triggerHandlers(client.handlers.START);
```

Или запустите готовый пример:

```bash
node example-sms.js
node example-sms.js +79001234567  # с номером в аргументе
```

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
  "ua": "Mozilla/5.0 (iPhone...)",
  "device_type": 2,
  "deviceType": "IOS"
}
```

#### Транспорты

- **WEB** (`deviceType: 'WEB'` или `device_type: 1`) → WebSocket (ws-api.oneme.ru)
- **IOS** (`deviceType: 'IOS'` или `device_type: 2`) → TCP Socket (api.oneme.ru)
- **ANDROID** (`deviceType: 'ANDROID'` или `device_type: 3`) → TCP Socket (api.oneme.ru)

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
  deviceType: 'WEB',      // Тип устройства: 'WEB', 'IOS', 'ANDROID' (опционально)
  saveToken: true,        // Сохранять токен в сессию (по умолчанию true)
  debug: false,           // Отладочный режим (опционально)
  apiUrl: 'wss://...',    // URL WebSocket API (опционально)
  maxReconnectAttempts: 5,// Максимальное количество попыток переподключения
  reconnectDelay: 3000    // Задержка между попытками переподключения (мс)
});
```

#### Методы

##### `start()`

Запускает клиент и устанавливает соединение.

```javascript
await client.start();
```

##### `authorizeBySMS(phone)`

Авторизация по номеру телефона через SMS (только для IOS/ANDROID).

```javascript
// Подключаемся
await client.connect();

// Запрашиваем код
const authSession = await client.authorizeBySMS('+79001234567');

// Вводим код из SMS
await authSession.sendCode('123456');
```

##### `sendMessage(options)`

Отправляет сообщение в чат с уведомлением (notify: true).

```javascript
const message = await client.sendMessage({
  chatId: 123,
  text: 'Привет!',
  cid: Date.now(),
  replyTo: null,        // ID сообщения для ответа (опционально)
  attachments: []       // Вложения (опционально)
});
```

##### `sendMessageChannel(options)`

Отправляет сообщение в канал без уведомления (notify: false).

```javascript
const message = await client.sendMessageChannel({
  chatId: 123,
  text: 'Сообщение в канал',
  cid: Date.now(),
  replyTo: null,        // ID сообщения для ответа (опционально)
  attachments: []       // Вложения (опционально)
});
```

##### `editMessage(options)`

Редактирует сообщение.

```javascript
await client.editMessage({
  messageId: 456,
  chatId: 123,
  text: 'Исправленный текст'
});
```

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

##### `getChats(limit, offset)`

Получает список чатов.

```javascript
const chats = await client.getChats(50, 0);
```

##### `getHistory(chatId, limit, offset)`

Получает историю сообщений.

```javascript
const messages = await client.getHistory(123, 50, 0);
```

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

Отвечает на сообщение.

```javascript
await message.reply({
  text: 'Ответ на сообщение',
  cid: Date.now()
});
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

Низкоуровневый TCP Socket транспорт для IOS/ANDROID (api.oneme.ru).

#### Прямое использование (advanced)

```javascript
const { MaxSocketTransport } = require('webmaxsocket');

const transport = new MaxSocketTransport({
  deviceType: 'IOS',
  ua: 'Mozilla/5.0 (iPhone...)',
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

### Пример 4: IOS/ANDROID Socket (example-ios.js)

```bash
# С готовым конфигом
node example-ios.js

# С отладкой
node example-ios.js --debug
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
├── example-ios.js          # IOS/ANDROID Socket
├── package.json
└── README.md
```

## Сессии

Библиотека автоматически сохраняет сессии в директории `sessions/`. При повторном запуске с тем же именем сессии авторизация не требуется.

```javascript
// Создание новой сессии
const client1 = new WebMaxClient({ name: 'account1', phone: '+1234567890' });

// Использование существующей сессии
const client2 = new WebMaxClient({ name: 'account1' }); // phone не требуется
```

## Обработка ошибок

Рекомендуется всегда оборачивать вызовы API в try-catch блоки:

```javascript
try {
  const message = await client.sendMessage({
    chatId: 123,
    text: 'Привет!',
    cid: Date.now()
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

2. **Разница между sendMessage и sendMessageChannel:**
   - `sendMessage()` - отправка с уведомлением (notify: true) для обычных чатов
   - `sendMessageChannel()` - отправка без уведомления (notify: false) для каналов

3. **Автоматический выбор транспорта:** Клиент автоматически определяет какой транспорт использовать на основе `deviceType` в сессии или config файле.

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