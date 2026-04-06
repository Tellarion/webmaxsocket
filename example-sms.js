/**
 * Пример авторизации по SMS (IOS/ANDROID)
 * 
 * Использование:
 *   node example-sms.js
 *   node example-sms.js +79001234567  # с номером в аргументе
 */

const readline = require('readline');
const { WebMaxClient } = require('./index');

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
  // Получаем номер телефона из аргумента или запрашиваем
  let phone = process.argv[2];
  
  if (!phone) {
    phone = await ask('📱 Введите номер телефона (+79001234567): ');
  }

  // Валидация номера
  if (!/^\+?\d{10,15}$/.test(phone.replace(/\s/g, ''))) {
    console.error('❌ Неверный формат номера телефона');
    process.exit(1);
  }

  console.log('\n🚀 Запуск клиента с SMS авторизацией...\n');

  // Создаем клиент с IOS deviceType для SMS авторизации
  const client = new WebMaxClient({
    name: 'sms_session',
    deviceType: 'IOS',  // Обязательно для SMS авторизации
    debug: process.env.DEBUG === '1'
  });

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

    // Проверяем есть ли сохраненный токен
    const savedToken = client.session.get('token');
    
    if (savedToken) {
      console.log('✅ Найдена сохраненная сессия, вход по токену...\n');
      client._token = savedToken;
      await client.sync();
      client.isAuthorized = true;
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
