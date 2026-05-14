/**
 * Скачивание вложений из истории чата (с baseUrl или документы без прямого URL).
 *
 * Использование:
 *   node example-download-files.js <chatId> [backward]
 *   SESSION_NAME=my_session BACKWARD=80 node example-download-files.js 12345
 *   USE_LAST_OK=1 — подмешать sessions/<name>.last_ok.json
 *
 * Из пакета:
 *   npm run example:download -- 0 30
 */

const fs = require('fs');
const path = require('path');
const { WebMaxClient } = require('./index');

const sessionName = process.env.SESSION_NAME || 'sms_session';
const useLastOk =
  process.env.USE_LAST_OK === '1' ||
  process.env.USE_LAST_OK === 'true' ||
  process.env.USE_LAST_OK === 'yes';
const downloadDir = path.join(process.cwd(), 'downloads');

function parseChatId(arg) {
  const s = String(arg).trim();
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`chatId должен быть целым числом, получено: ${arg}`);
  }
  return Number(s);
}

function safeBasename(name, fallback) {
  const base = (name && String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')) || fallback;
  return base.length > 180 ? base.slice(0, 180) : base;
}

async function main() {
  const chatArg = process.argv[2];
  const backward = Math.max(
    1,
    parseInt(process.argv[3] || process.env.BACKWARD || '50', 10) || 50
  );

  if (
    chatArg == null ||
    chatArg === '' ||
    chatArg === '-h' ||
    chatArg === '--help'
  ) {
    console.log('Использование: node example-download-files.js <chatId> [backward]\n');
    console.log('Переменные окружения: SESSION_NAME, BACKWARD, USE_LAST_OK=1, DEBUG=1');
    process.exit(chatArg == null || chatArg === '' ? 1 : 0);
  }

  const chatId = parseChatId(chatArg);

  const client = new WebMaxClient({
    name: sessionName,
    deviceType: 'ANDROID',
    debug: process.env.DEBUG === '1'
  });

  if (useLastOk) {
    const lastOk = path.join(process.cwd(), 'sessions', `${sessionName}.last_ok.json`);
    if (fs.existsSync(lastOk)) {
      const snap = JSON.parse(fs.readFileSync(lastOk, 'utf8'));
      Object.assign(client.session.data, snap);
      console.log('Подмешан снимок сессии:', lastOk);
    } else {
      console.warn('USE_LAST_OK: файл не найден:', lastOk);
    }
  }

  const token = client.session.get('token');
  if (!token) {
    console.error(
      `Нет токена в sessions/${sessionName}.json. Выполните вход (example-sms.js, example-token.js или QR).`
    );
    process.exit(1);
  }

  await client.connect();
  client._token = token;
  await client.sync();

  if (client.me) {
    console.log(`Вошли как: ${client.me.fullname || client.me.firstname} (id ${client.me.id})`);
  }

  console.log(`Загрузка истории chatId=${chatId}, backward=${backward}…`);

  const messages = await client.getHistory(chatId, Date.now(), backward, 0);
  const ordered = [...messages].sort(
    (a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)
  );

  fs.mkdirSync(downloadDir, { recursive: true });

  let ok = 0;
  for (const m of ordered) {
    if (!m.attachments || !m.attachments.length) continue;

    for (let i = 0; i < m.attachments.length; i++) {
      const att = m.attachments[i];
      const kind = String(att._type || att.type || '').toUpperCase() || 'FILE';
      const guessed =
        att.name || att.fileName || att.filename || `msg-${String(m.id)}-${i}`;
      const fname = safeBasename(guessed, `msg-${String(m.id)}-${i}`);
      const filename = fname.includes('.')
        ? fname
        : `${fname}.${
            kind === 'PHOTO' || kind === 'IMAGE'
              ? 'img'
              : kind === 'VIDEO'
                ? 'mp4'
                : 'bin'
          }`;

      try {
        const { path: savedPath, contentType } = await m.downloadAttachment(i, {
          dir: downloadDir,
          filename
        });
        console.log(`✓ [${kind}] ${path.basename(savedPath)}  ${contentType || ''}`);
        ok++;
      } catch (e) {
        console.warn(`⚠ [${kind}] ${filename}: ${e.message}`);
      }
    }
  }

  console.log(`\nГотово: ${ok} файл(ов) → ${downloadDir}`);

  try {
    await client.stop();
  } catch (_) {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
