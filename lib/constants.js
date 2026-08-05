/**
 * Константы для библиотеки WebMax
 */

/**
 * Актуальные appVersion / buildNumber официального клиента Max.
 * Обновлять при выходе новой версии — иначе сервер отвечает
 * «Приложение устарело, пожалуйста, обновитесь» на SMS/SESSION_INIT.
 */
const APP_VERSION = '26.19.2';
const BUILD_NUMBER = 6733;

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
  ChatActions,
  EventTypes,
  MessageTypes
};

