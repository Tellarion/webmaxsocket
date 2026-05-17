/**
 * Пример авторизации по SMS (ANDROID)
 * 
 * Использование:
 *   node example-sms.js
 *   node example-sms.js +79001234567  # с номером в аргументе
 *   USE_LAST_OK=1 — подмешать sessions/sms_session.last_ok.json (см. example-download-files.js)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { WebMaxClient } = require('./index');

const SESSION_NAME = process.env.SESSION_NAME || 'sms_session';
const useLastOk =
  process.env.USE_LAST_OK === '1' ||
  process.env.USE_LAST_OK === 'true' ||
  process.env.USE_LAST_OK === 'yes';

/** Активный клиент для корректного закрытия TCP по Ctrl+C */
let activeClient = null;

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

function validatePhone(phone) {
  return /^\+?\d{10,15}$/.test(String(phone).replace(/\s/g, ''));
}

async function main() {
  console.log('\n🚀 Запуск клиента с SMS авторизацией...\n');

  // Создаем клиент с Android deviceType для SMS авторизации
  const client = new WebMaxClient({
    name: SESSION_NAME,
    deviceType: 'ANDROID',  // Обязательно для SMS авторизации
    debug: process.env.DEBUG === '1',
    /** Периодический sync продлевает/ротирует токен в sessions/*.json (долгий бот без зависаний) */
    sessionRefreshIntervalMs: Number(process.env.SESSION_REFRESH_MS || 3_600_000) || 0
  });

  activeClient = client;

  if (useLastOk) {
    const lastOk = path.join(process.cwd(), 'sessions', `${SESSION_NAME}.last_ok.json`);
    if (fs.existsSync(lastOk)) {
      const snap = JSON.parse(fs.readFileSync(lastOk, 'utf8'));
      Object.assign(client.session.data, snap);
      client.session.save();
      console.log('Подмешан снимок сессии:', lastOk);
    } else {
      console.warn('USE_LAST_OK: файл не найден:', lastOk);
    }
  }

  let phone = process.argv[2];
  const savedToken = client.session.get('token');

  if (!savedToken) {
    if (!phone) {
      phone = await ask('📱 Введите номер телефона (+79001234567): ');
    }
    if (!validatePhone(phone)) {
      console.error('❌ Неверный формат номера телефона');
      process.exit(1);
    }
  } else if (phone && !validatePhone(phone)) {
    console.error('❌ Неверный формат номера телефона');
    process.exit(1);
  }

  // Обработчик запуска
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

  // Обработчик сообщений
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
    // Подключаемся
    await client.connect();

    if (savedToken) {
      console.log('✅ Найдена сохраненная сессия, вход по токену...\n');
      client._token = savedToken;
      await client.sync();
      client.isAuthorized = true;
      client._scheduleSessionRefreshIfNeeded();
    } else {
      // SMS авторизация
      console.log('📱 Требуется SMS авторизация\n');
      const authSession = await client.authorizeBySMS(phone);
      
      // Запрашиваем код
      const code = await ask('\n📲 Введите код из SMS (6 цифр): ');
      
      if (!/^\d{6}$/.test(code)) {
        console.error('❌ Неверный формат кода');
        process.exit(1);
      }

      // Отправляем код; при 2FA по паролю вернётся { needsPassword, sendPassword }
      const afterCode = await authSession.sendCode(code);
      if (afterCode && typeof afterCode === 'object' && afterCode.needsPassword && typeof afterCode.sendPassword === 'function') {
        let pwd = process.env.TWOFA_PASSWORD || process.env.TWOFa_PASSWORD;
        const saved = client.session.get('twofaPassword');
        if (!pwd && saved && process.env.ASK_TWOFA !== '1' && process.env.ASK_TWOFa !== '1') {
          pwd = saved;
          console.log('\n🔒 Пароль 2FA из сессии (twofaPassword).');
        }
        if (!pwd) {
          pwd = await ask('\n🔒 Введите пароль 2FA: ');
        }
        await afterCode.sendPassword(pwd);
      }
      client._scheduleSessionRefreshIfNeeded();
    }

    // Запускаем обработчики start
    await client.triggerHandlers(client.handlers.START);
    
    console.log('\n✅ Клиент запущен успешно!');
    console.log('🤖 Бот работает (Ctrl+C — выход)\n');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\n\n👋 Завершение работы...');
  try {
    if (activeClient) {
      await activeClient.stop();
    }
  } catch (_) {
    /* ignore */
  }
  console.log('\n💝 Нравится библиотека? Поддержите разработку:');
  console.log('   USDT (TRC20): TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE');
  process.exit(0);
});

main().catch((error) => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});
