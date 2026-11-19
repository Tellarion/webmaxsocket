/**
 * Пример использования WebMax клиента
 * Демонстрирует основные возможности библиотеки
 */

const { WebMaxClient } = require('./index');

let client;

async function main() {
  // Инициализация клиента
  client = new WebMaxClient({
    name: 'example_session' // Имя сессии (appVersion по умолчанию — под транспорт)
  });

  // Обработчик запуска
  client.onStart(async () => {
    
    if (client.me) {
      console.log(`👤 Вы вошли как: ${client.me.fullname || client.me.firstname}`);
      console.log(`🆔 ID: ${client.me.id}`);
      console.log(`📱 Телефон: +${client.me.phone}\n`);
    }
  });

  // Обработчик входящих сообщений
  client.onMessage(async (message) => {
    const senderName = message.getSenderName();
    console.log(`\n💬 Сообщение от ${senderName}:`);
    console.log(`📝 ${message.text}`);
    console.log(`🕐 ${new Date(message.timestamp).toLocaleString()}`);
    
    // Не отвечаем на свои сообщения
    if (message.senderId === client.me?.id) {
      return;
    }

    // Обработка команд
    const text = message.text.trim().toLowerCase();
    
    if (text === '/start' || text === '/help') {
      await message.reply({
        text: '🤖 Доступные команды:\n' +
              '/start - Показать это меню\n' +
              '/info - Информация о боте\n' +
              '/ping - Проверка связи\n' +
              '/echo <текст> - Повторить текст',
      });
      console.log('✅ Отправлено меню команд');
    }
    else if (text === '/info') {
      await message.reply({
        text: '📊 WebMax Node.js Client\n' +
              `Версия: ${require('./package.json').version}\n` +
              'GitHub: https://github.com/Tellarion/webmaxsocket',
      });
      console.log('✅ Отправлена информация');
    }
    else if (text === '/ping') {
      await message.reply({
        text: '🏓 Pong!',
      });
      console.log('✅ Отправлен pong');
    }
    else if (text.startsWith('/echo ')) {
      const echoText = message.text.substring(6);
      await message.reply({
        text: echoText,
      });
      console.log('✅ Отправлено эхо');
    }
    else {
      // Обычный автоответ
      await message.fetchSender();
      const name = message.sender ? (message.sender.firstname || 'друг') : 'друг';
      
      await message.reply({
        text: `Привет, ${name}! 👋\nНапиши /help чтобы увидеть доступные команды.`,
      });
      console.log(`✅ Отправлен приветственный ответ`);
    }
  });

  // Обработчик удаленных сообщений
  client.onMessageRemoved(async (message) => {
    console.log(`\n🗑️  Сообщение удалено (ID: ${message.id})`);
  });

  // Обработчик действий в чате
  client.onChatAction(async (action) => {
    console.log(`\n👁️  Действие в чате:`, action);
  });

  // Обработчик ошибок
  client.onError(async (error) => {
    console.error('\n❌ Ошибка:', error.message);
  });

  // Запуск клиента
  try {
    await client.start();
    console.log('🤖 Бот готов к работе. Нажмите Ctrl+C для выхода.\n');
  } catch (error) {
    console.error('❌ Ошибка запуска:', error);
    process.exit(1);
  }
}

// Обработка завершения
process.on('SIGINT', async () => {
  console.log('\n\n👋 Завершение работы...');
  if (client) await client.stop().catch(() => {});
  console.log('\n💝 Нравится библиотека? Поддержите разработку:');
  console.log('   USDT (TRC20): TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE');
  process.exit(0);
});

// Запуск
main().catch(console.error);
