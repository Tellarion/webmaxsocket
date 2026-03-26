/**
 * Режим логирования входящих событий для WebMaxClient.
 */

/**
 * @param {object} [options] опции конструктора WebMaxClient (`logIncoming`, `logIncomingVerbose`, …)
 * @returns {{ mode: 'off' | 'messages' | 'verbose' }}
 *
 * - `logIncoming: false` — выкл.
 * - `logIncoming: 'verbose'` или `logIncomingVerbose: true` — JSON сообщений + connected, raw_message, removed, chat_action, error.
 * - `logIncoming: 'messages'` — только JSON входящих сообщений (даже при WEBMAX_DEBUG).
 * - `WEBMAX_SILENT=1` — выкл. дампов.
 * - `WEBMAX_DEBUG=1` — режим verbose, если не задано явно `logIncoming: 'messages'`.
 */
function resolveIncomingLogMode(options = {}) {
  const silent = process.env.WEBMAX_SILENT === '1';
  const envVerbose = process.env.WEBMAX_DEBUG === '1';

  const li = options.logIncoming;

  if (li === false) {
    return { mode: 'off' };
  }
  if (li === 'verbose' || options.logIncomingVerbose === true) {
    return { mode: 'verbose' };
  }
  if (silent) {
    return { mode: 'off' };
  }
  if (li === 'messages') {
    return { mode: 'messages' };
  }
  if (envVerbose) {
    return { mode: 'verbose' };
  }
  return { mode: 'messages' };
}

/**
 * @param {string} label
 * @param {unknown} payload
 */
function printIncomingLog(label, payload) {
  try {
    const s = JSON.stringify(
      payload,
      (k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    );
    console.log(`\n📥 [incoming:${label}]\n${s}\n`);
  } catch (_) {
    console.log(`\n📥 [incoming:${label}]`, payload, '\n');
  }
}

module.exports = {
  resolveIncomingLogMode,
  printIncomingLog
};
