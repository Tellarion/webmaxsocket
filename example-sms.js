/**
 * SMS-авторизация (ANDROID). Сессия сохраняется в sessions/<имя>.json
 * (токен, deviceId, ua-поля; при успешном 2FA — опционально twofaPassword).
 *
*/

const readline = require('readline');
const { WebMaxClient, EventTypes } = require('./index');

const SESSION_NAME =
  process.env.WEBMAX_SESSION || process.argv[3] || 'sms_session';

const SESSION_REFRESH_MS_RAW = process.env.SESSION_REFRESH_MS;
const sessionRefreshIntervalMs =
  SESSION_REFRESH_MS_RAW === undefined || SESSION_REFRESH_MS_RAW === ''
    ? 45 * 60 * 1000
    : Number(SESSION_REFRESH_MS_RAW);

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  let phone = process.argv[2];

  if (!phone) {
    phone = await ask('📱 Введите номер телефона (+79001234567): ');
  }

  const digitsOnly = phone.replace(/\s/g, '');
  if (!/^\+?\d{10,15}$/.test(digitsOnly)) {
    console.error('❌ Неверный формат номера телефона');
    process.exit(1);
  }

  console.log(`\n📁 Сессия: ${SESSION_NAME} → sessions/${SESSION_NAME}.json\n`);
  console.log('🚀 Запуск клиента (SMS / сохранённый токен)...\n');

  const client = new WebMaxClient({
    name: SESSION_NAME,
    deviceType: 'ANDROID',
    saveToken: true,
    saveTwofaPassword: process.env.SAVE_TWOFA_TO_SESSION !== '0',
    debug: process.env.DEBUG === '1',
    sessionRefreshIntervalMs:
      Number.isFinite(sessionRefreshIntervalMs) && sessionRefreshIntervalMs > 0
        ? sessionRefreshIntervalMs
        : 0
  });

  client.onStart(async () => {
    if (client.me) {
      console.log('\n📋 ДАННЫЕ ПОЛЬЗОВАТЕЛЯ:');
      console.log('─'.repeat(40));
      console.log(`👤 Имя: ${client.me.fullname || client.me.firstname}`);
      console.log(`🆔 ID: ${client.me.id}`);
      console.log(`📱 Телефон: +${client.me.phone || '—'}`);
    }

    try {
      const chats = await client.getChats();
      console.log(`\n📂 Диалогов: ${chats.length}`);
    } catch (e) {
      console.log('⚠️ Не удалось загрузить диалоги:', e.message);
    }
  });

  client.onMessage(async (message) => {
    if (message.senderId === client.me?.id) return;
    console.log(`\n💬 ${message.getSenderName()}: ${message.text}`);

    await message.reply({
      text: 'Автоответ: сообщение получено!',
      cid: Date.now()
    });
    console.log('✅ Отправлен автоответ');
  });

  client.onError((err) => console.error('❌', err.message));

  try {
    await client.connect();

    const savedToken = client.session.get('token');

    if (savedToken) {
      console.log('✅ Найдена сохранённая сессия, вход по токену из файла...\n');
      client._token = savedToken;
      await client.sync();
      client.isAuthorized = true;
    } else {
      console.log('📱 Нет токена в сессии — SMS-авторизация\n');
      const authSession = await client.authorizeBySMS(phone);

      const code = await ask('\n📲 Введите код из SMS (6 цифр): ');

      if (!/^\d{6}$/.test(code)) {
        console.error('❌ Неверный формат кода');
        process.exit(1);
      }

      const afterCode = await authSession.sendCode(code);
      if (
        afterCode &&
        typeof afterCode === 'object' &&
        afterCode.needsPassword &&
        typeof afterCode.sendPassword === 'function'
      ) {
        let pwd = process.env.TWOFA_PASSWORD || process.env.TWOFa_PASSWORD;
        const saved = client.session.get('twofaPassword');
        if (
          !pwd &&
          saved &&
          process.env.ASK_TWOFA !== '1' &&
          process.env.ASK_TWOFa !== '1'
        ) {
          pwd = saved;
          console.log('\n🔒 Пароль 2FA взят из сессии (twofaPassword).');
        }
        if (!pwd) {
          pwd = await ask('\n🔒 Введите пароль 2FA: ');
        }
        await afterCode.sendPassword(pwd);
      }
    }

    if (typeof client._scheduleSessionRefreshIfNeeded === 'function') {
      client._scheduleSessionRefreshIfNeeded();
    }

    await client.triggerHandlers(EventTypes.START);

    console.log('\n✅ Клиент запущен успешно!');
    console.log('🤖 Бот работает (Ctrl+C — выход)\n');
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n\n👋 Завершение работы...');
  console.log('\n💝 Нравится библиотека? Поддержите разработку:');
  console.log('   USDT (TRC20): TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE');
  process.exit(0);
});

main().catch((error) => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});
