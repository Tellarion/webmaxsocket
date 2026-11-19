/**
 * WebMaxSocket - Node.js библиотека для работы с API мессенджера Max
 * tellarion.dev
 * 
 * @module webmaxsocket
 */

const WebMaxClient = require('./lib/client');
const { MaxSocketTransport } = require('./lib/socketTransport');
const { User, Message, ChatAction } = require('./lib/entities');
const { ChatActions, EventTypes, MessageTypes, APP_VERSION, BUILD_NUMBER, WEB_APP_VERSION, WS_API_URL } = require('./lib/constants');
const { packWebFrame, unpackWebFrame } = require('./lib/webCodec');
const { Opcode, getOpcodeName } = require('./lib/opcodes');
const { UserAgentPayload } = require('./lib/userAgent');
const { downloadUrlToTempFile, extFromContentType, extFromAttachType } = require('./lib/downloadMedia');
const { resolveIncomingLogMode, printIncomingLog } = require('./lib/incomingLog');
const { parseQrTrackId } = require('./lib/qrWebLogin');
const {
  summarizeIncomingCall,
  isCallAttach,
  extractCallAttachesFromNotifPayload,
  summarizeCallAttach,
  formatCallLogLine,
} = require('./lib/callHelpers');

module.exports = {
  WebMaxClient,
  MaxSocketTransport,
  User,
  Message,
  ChatAction,
  ChatActions,
  EventTypes,
  MessageTypes,
  APP_VERSION,
  BUILD_NUMBER,
  WEB_APP_VERSION,
  WS_API_URL,
  packWebFrame,
  unpackWebFrame,
  Opcode,
  getOpcodeName,
  UserAgentPayload,
  downloadUrlToTempFile,
  extFromContentType,
  extFromAttachType,
  resolveIncomingLogMode,
  printIncomingLog,
  parseQrTrackId,
  summarizeIncomingCall,
  isCallAttach,
  extractCallAttachesFromNotifPayload,
  summarizeCallAttach,
  formatCallLogLine,
};

