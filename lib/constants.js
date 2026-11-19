/**
 * Константы для библиотеки WebMax
 */

/**
 * Актуальные appVersion / buildNumber официального Android-клиента Max (TCP).
 * Обновлять при выходе новой версии — иначе сервер отвечает
 * «Приложение устарело, пожалуйста, обновитесь» на SMS/SESSION_INIT.
 * Без пересборки библиотеки: env WEBMAX_APP_VERSION / WEBMAX_BUILD_NUMBER или options.appVersion / options.buildNumber.
 */
const APP_VERSION = process.env.WEBMAX_APP_VERSION || '26.41.0';
const BUILD_NUMBER = Number(process.env.WEBMAX_BUILD_NUMBER) || 6931;

/** Версия web.max.ru (у веба своя нумерация, buildNumber не передаётся). Env: WEBMAX_WEB_APP_VERSION */
const WEB_APP_VERSION = process.env.WEBMAX_WEB_APP_VERSION || '26.11.9';

/** WebSocket web.max.ru. До 19.11.2026 был wss://ws-api.oneme.ru/websocket (JSON) — сейчас не отвечает. */
const WS_API_URL = 'wss://api.oneme.ru/websocket';

const ChatActions = {
  TYPING: 'typing',
  STICKER: 'sticker',
  FILE: 'file',
  RECORDING_VOICE: 'recording_voice',
  RECORDING_VIDEO: 'recording_video'
};

const EventTypes = {
  START: 'start',
  MESSAGE: 'message',
  MESSAGE_REMOVED: 'message_removed',
  CHAT_ACTION: 'chat_action',
  INCOMING_CALL: 'incoming_call',
  CALL_LOG: 'call_log',
  ERROR: 'error',
  DISCONNECT: 'disconnect'
};

const MessageTypes = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker'
};

module.exports = {
  APP_VERSION,
  BUILD_NUMBER,
  WEB_APP_VERSION,
  WS_API_URL,
  ChatActions,
  EventTypes,
  MessageTypes
};

