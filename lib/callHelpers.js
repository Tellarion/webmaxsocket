/**
 * Парсинг уведомлений о звонках (op. 137 и служебные сообщения NOTIF_MESSAGE с вложением CALL).
 */

/**
 * Краткое описание payload входящего звонка (NOTIF_INCOMING_CALL / opcode 137).
 * Поле vcp не включается (чувствительные WebRTC/медиа‑параметры).
 * @param {object} [payload]
 */
function summarizeIncomingCall(payload = {}) {
  return {
    callerId: payload.callerId,
    chatId: payload.chatId ?? null,
    conversationId: payload.conversationId,
    type: payload.type,
    isContact: payload.isContact,
    country: payload.country,
    hasVcp: Boolean(payload.vcp),
  };
}

/**
 * @param {object} [attach]
 */
function isCallAttach(attach) {
  if (!attach || typeof attach !== 'object') return false;
  const t = attach._type ?? attach.type;
  return String(t || '').toUpperCase() === 'CALL';
}

/**
 * Извлекает вложения‑звонки из payload уведомления NOTIF_MESSAGE (128).
 * Ожидается `payload.message.attaches` или `payload.attaches`.
 * @param {object} [notifPayload]
 * @returns {object[]}
 */
function extractCallAttachesFromNotifPayload(notifPayload = {}) {
  const msg = notifPayload.message || notifPayload;
  const raw = msg.attaches || msg.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCallAttach);
}

/**
 * Нормализованное описание одного вложения CALL (итог звонка в чате).
 * @param {object} [attach]
 */
function summarizeCallAttach(attach = {}) {
  const duration = attach.duration;
  const durationMs =
    typeof duration === 'number' && Number.isFinite(duration)
      ? duration
      : Number(duration) || 0;
  return {
    conversationId: attach.conversationId,
    hangupType: attach.hangupType,
    callType: attach.callType,
    durationMs,
    contactIds: Array.isArray(attach.contactIds) ? attach.contactIds : [],
  };
}

/**
 * Одна строка для логов.
 * @param {object} summary — результат summarizeCallAttach
 */
function formatCallLogLine(summary) {
  if (!summary || typeof summary !== 'object') return '[call] (no summary)';
  const ht = summary.hangupType || '?';
  const cid = summary.conversationId || '?';
  const d = summary.durationMs;
  const durPart = d > 0 ? ` duration=${d}ms` : '';
  return `[call] ${ht} conv=${cid}${durPart}`;
}

module.exports = {
  summarizeIncomingCall,
  isCallAttach,
  extractCallAttachesFromNotifPayload,
  summarizeCallAttach,
  formatCallLogLine,
};
