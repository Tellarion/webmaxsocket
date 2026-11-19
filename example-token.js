/**
 * Пример входа по токену (token auth)
 *
 * Конфиг: config/default.json — token, agent
 *   node example-token.js
 *   node example-token.js other  — config/other.json
 * Вариант 3 — TOKEN в env: TOKEN="..." node example-token.js
 */

const { WebMaxClient } = require('./index');

const CONFIG_NAME = process.argv[2] || process.env.CONFIG || 'default';

async function main() {
  let client;
  try {
    client = new WebMaxClient({
      name: 'token_session',
      configPath: CONFIG_NAME,
      token: process.env.TOKEN,
      saveToken: true,
      debug: process.env.DEBUG === '1'
    });
  } catch (e) {
    console.error('❌ Не удалось загрузить конфиг:', e.message);
    console.error('   Создайте config/default.json (см. config/example.json)');
    process.exit(1);
  }

  if (!client._providedToken || client._providedToken.length < 50) {
    console.error('❌ Укажите токен в config/default.json (поле "token")');
    console.error('   Или: TOKEN="ваш_токен" node example-token.js');
    process.exit(1);
  }

  client.onStart(async () => {
    if (client.me) {
      console.log('\n📋 ДАННЫЕ ПОЛЬЗОВАТЕЛЯ:');
      console.log('─'.repeat(40));
      console.log(`👤 Имя: ${client.me.fullname || client.me.firstname}`);
      console.log(`🆔 ID: ${client.me.id}`);
      console.log(`📱 Телефон: +${client.me.phone || '—'}`);
      console.log(`🖼  Avatar: ${client.me.avatar ? 'есть' : 'нет'}`);
    }

    try {
      const chats = await client.getChats();
      console.log('\n📂 ДИАЛОГИ (' + chats.length + '):');
      console.log('─'.repeat(40));
      chats.slice(0, 15).forEach((chat, i) => {
        const chatId = chat.id ?? chat.chatId;
        const title = chat.title || chat.name || `Chat ${chatId}`;
        const lastMsg = chat.lastMessage?.text || chat.lastMessage?.message || '—';
        const preview = String(lastMsg).slice(0, 40) + (String(lastMsg).length > 40 ? '…' : '');
        console.log(`${i + 1}. [${chatId}] ${title}`);
        console.log(`   Последнее: ${preview}`);
      });
      if (chats.length > 15) console.log(`   ... и ещё ${chats.length - 15}`);

      if (chats.length > 0) {
        const firstChat = chats[0];
        const firstChatId = firstChat.id ?? firstChat.chatId;
        const history = await client.getHistory(firstChatId, Date.now(), 5, 0);
        console.log(`\n💬 Последние 5 сообщений в «${firstChat.title || firstChat.id}»:`);
        console.log('─'.repeat(40));
        history.reverse().forEach((m, i) => {
          const from = m.senderId === client.me?.id ? 'Вы' : `User ${m.senderId}`;
          console.log(`   ${i + 1}. ${from}: ${String(m.text || '').slice(0, 50)}`);
        });
      }
      console.log('\n');
    } catch (e) {
      console.log('⚠️ Не удалось загрузить диалоги:', e.message);
    }
  });

  client.onMessage(async (message) => {
    if (message.senderId === client.me?.id) return;
    console.log(`💬 ${message.getSenderName()}: ${message.text}`);
    await message.reply({ text: 'Получено!' });
  });

  client.onError(async (err) => console.error('❌', err.message));

  try {
    await client.start();
    console.log('🤖 Токен-авторизация успешна. Бот работает.\n');
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
main().catch(console.error);
