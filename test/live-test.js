/**
 * Живой тест библиотеки на реальном аккаунте.
 *
 *   node test/live-test.js qr            — WEB (WebSocket), вход по QR (сканировать в приложении МАКС)
 *   node test/live-test.js sms +7900...  — ANDROID (TCP), вход по SMS (+ 2FA, если включена)
 *
 * Сессия: sessions/livetest_<режим>.json (в .gitignore). Повторный запуск войдёт по сохранённому токену.
 * DEBUG=1 — подробный лог протокола.
 *
 * Что проверяется: вход, профиль, список чатов, история, инфо о чате, приём сообщения,
 * ответ / редактирование / реакция / удаление, обрыв соединения и автопереподключение.
 * Всё, что тест отправляет, он же и удаляет (реакцию — снимает).
 */

const readline = require('readline');
const { WebMaxClient, EventTypes } = require('..');

const mode = (process.argv[2] || 'qr').toLowerCase();
if (!['qr', 'sms'].includes(mode)) {
  console.error('Режим: qr | sms');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, info });
    console.log(`  ✅ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0} мс)`);
    return true;
  } catch (e) {
    results.push({ name, ok: false, info: e.message });
    console.log(`  ❌ ${name} — ${e.message}`);
    return false;
  }
}

function waitFor(emitter, event, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      emitter.removeListener(event, on);
      reject(new Error(`нет события «${event}» за ${ms / 1000} с`));
    }, ms);
    const on = (v) => {
      clearTimeout(t);
      resolve(v);
    };
    emitter.once(event, on);
  });
}

async function login(client) {
  if (mode === 'qr') {
    // start(): сохранённый токен → sync, иначе QR в терминале
    await client.start();
    return;
  }
  await client.connect();
  const saved = client.session.get('token');
  if (saved) {
    console.log('Найдена сохранённая сессия — вход по токену');
    client._token = saved;
    await client.sync();
    client.isAuthorized = true;
  } else {
    const phone = process.argv[3] || (await ask('Номер телефона (+79001234567): '));
    const auth = await client.authorizeBySMS(phone);
    let code = await ask(`Код (${auth.codeLength} цифр; r — отправить заново): `);
    while (code.toLowerCase() === 'r') {
      try {
        const info = await auth.resend();
        console.log(`Код отправлен повторно, осталось запросов: ${info.requestCountLeft ?? '?'}`);
      } catch (e) {
        console.log(`Повторная отправка не удалась: ${e.message}`);
      }
      code = await ask('Код: ');
    }
    const after = await auth.sendCode(code);
    if (after && after.needsPassword && typeof after.sendPassword === 'function') {
      const pwd = process.env.TWOFA_PASSWORD || (await ask('Пароль 2FA: '));
      await after.sendPassword(pwd);
    }
  }
  await client.triggerHandlers(EventTypes.START);
}

async function main() {
  const client = new WebMaxClient({
    name: `livetest_${mode}`,
    deviceType: mode === 'qr' ? 'WEB' : 'ANDROID',
    // Аккаунт с 2FA: при QR-входе сервер запросит пароль — спрашиваем интерактивно
    onTwoFARequest: async (ch) => process.env.TWOFA_PASSWORD || (await ask(`Пароль 2FA${ch && ch.hint ? ` (подсказка: ${ch.hint})` : ''}: `)),
    debug: process.env.DEBUG === '1',
    maxReconnectAttempts: 5,
    reconnectDelay: 2000
  });

  // Приём сообщений: кладём в очередь, тест забирает
  const inbox = [];
  client.onMessage((m) => {
    inbox.push(m);
    client.emit('_test_message', m);
  });
  client.on('disconnected', (r) => console.log(`  ⚡ disconnected: ${r}`));
  client.on('reconnected', () => console.log('  ⚡ reconnected'));

  console.log(`\n=== webmaxsocket live test: ${mode === 'qr' ? 'WEB / QR' : 'ANDROID / SMS'} ===\n`);

  const loggedIn = await check('Вход', async () => {
    await login(client);
    if (!client.isAuthorized && !client.me) throw new Error('не авторизован');
    return client.me ? `${client.me.fullname || client.me.firstname || ''} (id ${client.me.id})` : 'ok';
  });
  if (!loggedIn) return finish(client);

  console.log('\n— Чтение');
  let chats = [];
  await check('Список чатов (CHATS_LIST / LOGIN)', async () => {
    chats = await client.getChats();
    if (!chats.length && client.lastSyncPayload && Array.isArray(client.lastSyncPayload.chats)) {
      chats = client.lastSyncPayload.chats;
    }
    if (!chats.length) throw new Error('пусто');
    return `${chats.length} шт.`;
  });

  const firstChat = chats.find((c) => c && c.id != null);
  if (firstChat) {
    await check('История первого чата', async () => {
      const msgs = await client.getHistory(firstChat.id, Date.now(), 10);
      return `${msgs.length} сообщений`;
    });
    await check('Инфо о чате (CHAT_INFO)', async () => {
      const r = await client.getChatInfo([firstChat.id]);
      return r && typeof r === 'object' ? 'ok' : String(r);
    });
  }

  console.log('\n— Сообщения');
  console.log('  Напиши сообщение со словом «тест» в любой чат этого аккаунта');
  console.log('  (с другого аккаунта или себе в «Избранное» с телефона). Жду 2 минуты, Ctrl+C — выход.');
  let incoming = null;
  await check('Приём NOTIF_MESSAGE', async () => {
    const isTest = (m) => /тест|test/i.test(m.text || '');
    incoming = inbox.find(isTest);
    const deadline = Date.now() + 120000;
    while (!incoming && Date.now() < deadline) {
      const m = await waitFor(client, '_test_message', deadline - Date.now());
      if (isTest(m)) incoming = m;
    }
    if (!incoming) throw new Error('не дождался');
    return `chat ${incoming.chatId}, «${String(incoming.text).slice(0, 40)}»`;
  });

  if (incoming) {
    let sent = null;
    await check('Ответ с цитатой (MSG_SEND)', async () => {
      sent = await incoming.reply({ text: 'webmaxsocket live-test ✅', quote: true });
      if (!sent || sent.id == null) throw new Error('нет id отправленного');
      return `id ${sent.id}`;
    });
    if (sent) {
      await sleep(1000);
      await check('Редактирование (MSG_EDIT)', async () => {
        await sent.edit({ text: 'webmaxsocket live-test ✅ (изменено)' });
      });
    }
    await check('Реакция (MSG_REACTION)', async () => {
      await client.setMessageReaction({ chatId: incoming.chatId, messageId: incoming.id, emoji: '👍' });
    });
    await sleep(1000);
    await check('Снятие реакции', async () => {
      await client.cancelMessageReaction({ chatId: incoming.chatId, messageId: incoming.id });
    });
    if (sent) {
      await sleep(1000);
      await check('Удаление своего ответа (MSG_DELETE)', async () => {
        await sent.delete();
      });
    }
  }

  console.log('\n— Устойчивость');
  await check('Обрыв соединения → автопереподключение + повторный LOGIN', async () => {
    const reconnected = waitFor(client, 'reconnected', 60000);
    if (client._socketTransport && client._socketTransport.socket) {
      client._socketTransport.socket.destroy();
    } else if (client.ws) {
      client.ws.terminate();
    } else {
      throw new Error('нет активного транспорта');
    }
    await reconnected;
    const again = await client.getChats();
    return `после реконнекта чатов: ${again.length}`;
  });

  console.log('\n— Пинг/живучесть: держу соединение 70 с (сервер шлёт PING, клиент обязан ответить)…');
  await check('Соединение живо после 70 с простоя', async () => {
    let dropped = false;
    const onDrop = () => (dropped = true);
    client.on('disconnected', onDrop);
    await sleep(70000);
    client.removeListener('disconnected', onDrop);
    if (dropped) throw new Error('был обрыв во время простоя');
    await client.getChats();
  });

  return finish(client);
}

async function finish(client) {
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n=== Итог: ${ok}/${results.length} ===`);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.info ? ` — ${r.info}` : ''}`);
  try {
    await client.stop();
  } catch (_) {
    /* ignore */
  }
  rl.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error('Критическая ошибка:', e);
  process.exit(1);
});
