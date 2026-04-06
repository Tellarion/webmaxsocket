/** Сессии устройств и 2FA. Нужен токен (example-sms.js / test-sms-2fa.js). WEBMAX_SESSION или имя sms_session. */

const readline = require('readline');
const { WebMaxClient } = require('./index');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const closeOthers = process.argv.includes('--close-others');

  const client = new WebMaxClient({
    name: process.env.WEBMAX_SESSION || 'sms_session',
    deviceType: 'IOS',
    debug: process.env.DEBUG === '1'
  });

  await client.connectWithSession();
  if (!client.isAuthorized) {
    console.error('Нет действующей сессии. Выполните вход: node example-sms.js');
    process.exit(1);
  }

  console.log('\n📱 Активные сессии (устройства)\n');
  const raw = await client.getSessionsInfo();
  const rows = WebMaxClient.normalizeSessionsList(raw || {});

  if (!rows.length && raw && typeof raw === 'object') {
    console.log('Сырой ответ сервера (формат списка может отличаться):');
    console.log(JSON.stringify(raw, null, 2));
  } else {
    rows.forEach((r, i) => {
      const mark = r.current ? ' (текущая)' : '';
      console.log(
        `${i + 1}. ${r.client || '?'}${mark}\n   time=${r.time}  info=${r.info || '—'}  location=${r.location || '—'}`
      );
    });
  }

  console.log('\n🔐 Сведения о 2FA (как отдаёт сервер):');
  try {
    const twoFA = await client.getTwoFADetails();
    console.log(JSON.stringify(twoFA, null, 2));
  } catch (e) {
    console.error('getTwoFADetails:', e.message || e);
  }

  if (closeOthers) {
    const ok = await ask('\nЗавершить все сессии кроме текущей? (yes/no): ');
    if (ok.toLowerCase() === 'yes' || ok.toLowerCase() === 'y' || ok === 'да') {
      try {
        const result = await client.closeAllSessionsExceptCurrent();
        console.log('Результат:', JSON.stringify(result, null, 2));
      } catch (e) {
        console.error('closeAllSessionsExceptCurrent:', e.message || e);
      }
    }
  } else {
    console.log('\nПодсказка: node example-sessions-2fa.js --close-others — завершить другие сеансы.');
    console.log(
      'Установка пароля 2FA: client.setTwoFAPassword({ trackId, password, hint?, email? }) — trackId из сценария в приложении Max.'
    );
  }

  await client.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
