'use strict';

/* bridge experemental for pc client, lib webmaxsocket */
/* tellarion.dev */


const path = require('path');

const fs = require('fs');

const readline = require('readline');

const { downloadUrlToTempFile, extFromAttachType } = require('./lib/downloadMedia');


function jsonSafeMessageId(id) {
  if (id == null || id === '') return null;
  if (typeof id === 'bigint') return id.toString();
  return String(id);
}



function redirectConsoleToStderr() {

  const line = (prefix, args) => {

    const s = args

      .map((x) => {

        if (x instanceof Error) return x.message;

        if (typeof x === 'object') try { return JSON.stringify(x); } catch (_) { return String(x); }

        return String(x);

      })

      .join(' ');

    process.stderr.write((prefix || '') + s + '\n');

  };

  console.log = (...a) => line('', a);

  console.error = (...a) => line('[err] ', a);

  console.warn = (...a) => line('[warn] ', a);

}



function emit(obj) {
  try {
    process.stdout.write(
      JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n'
    );
  } catch (e) {
    try {
      process.stderr.write('[emit-json-error] ' + (e && e.message ? e.message : String(e)) + '\n');
    } catch (_) {}
  }
}



redirectConsoleToStderr();



const { WebMaxClient } = require('./index');

const { EventTypes } = require('./lib/constants');

const { Opcode } = require('./lib/opcodes');



let sessionName = 'max_win_client';

let dataRoot = null;

let client = null;

let pendingAuth = null;

let pending2fa = null;



function createClient() {

  return new WebMaxClient({

    name: sessionName,

    deviceType: 'ANDROID',

    logIncoming: false,

    sessionRefreshIntervalMs: 15 * 60 * 1000,

    debug: process.env.WEBMAX_DEBUG === '1'

  });

}



function summarizeAttachments(list) {

  if (!list || !list.length) return [];

  return list.map((a, i) => {

    const url =

      (a && (a.baseUrl || a.url || (a.photo && (a.photo.baseUrl || a.photo.url)))) || '';

    return {

      idx: i,

      type: (a && (a._type || a.type)) || '',

      url: url ? String(url) : ''

    };

  });

}



function pickAttachmentFileName(a) {

  if (!a || typeof a !== 'object') return '';

  if (a.file && a.file.name) return String(a.file.name);

  if (a.fileName) return String(a.fileName);

  if (a.name) return String(a.name);

  if (a.filename) return String(a.filename);

  if (a.title) return String(a.title);

  return '';

}



function extractUrlFromDownloadPayload(p) {

  if (!p || typeof p !== 'object') return '';

  return (

    p.url ||

    p.baseUrl ||

    p.downloadUrl ||

    p.href ||

    (p.info && (p.info.url || p.info.baseUrl || p.info.downloadUrl)) ||

    (p.data && (p.data.url || p.data.baseUrl)) ||

    (p.file && (p.file.url || p.file.baseUrl || p.file.downloadUrl)) ||

    ''

  );

}



function normalizeFileIdForRpc(v) {

  if (v == null || v === '') return null;

  if (typeof v === 'bigint') {

    const s = v.toString();

    const n = Number(s);

    if (Number.isSafeInteger(n)) return n;

    return s;

  }

  if (typeof v === 'number' && Number.isFinite(v)) return v;

  if (typeof v === 'string') {

    const t = v.trim();

    if (/^-?\d+$/.test(t)) {

      const n = Number(t);

      if (Number.isSafeInteger(n)) return n;

    }

    return t;

  }

  return v;

}



/** Поля fileId в протоколе и сыром JSON различаются; без них FILE_DOWNLOAD даёт «Файл не найден». */

function extractAttachFileId(a) {

  if (!a || typeof a !== 'object') return null;

  const cands = [

    a.fileId,

    a.attachId,

    a.attachmentId,

    a.file && a.file.fileId,

    a.file && a.file.id,

    a.attach && a.attach.fileId,

    a.attach && a.attach.id,

    a.document && a.document.fileId,

    a.document && a.document.id

  ];

  for (let i = 0; i < cands.length; i++) {

    const v = cands[i];

    if (v != null && v !== '') return v;

  }

  const t = String(a._type || a.type || '').toUpperCase();

  if (t === 'FILE' && a.id != null && a.id !== '') return a.id;

  return null;

}



/** @param {{ chatId?: number|string, messageId?: string|null }} [ctx] */

function buildFileDownloadRpcPayload(fidRaw, ctx) {

  const fileId = normalizeFileIdForRpc(fidRaw);

  if (fileId == null || fileId === '') return null;

  const body = { fileId };

  if (

    ctx &&

    ctx.chatId != null &&

    ctx.chatId !== '' &&

    Number.isFinite(Number(ctx.chatId)) &&

    Number(ctx.chatId) !== 0

  ) {

    body.chatId = Number(ctx.chatId);

  }

  const midRaw = ctx && ctx.messageId != null && ctx.messageId !== '' ? String(ctx.messageId).trim() : '';

  if (midRaw) {

    if (/^-?\d+$/.test(midRaw)) {

      const n = Number(midRaw);

      body.messageId = Number.isSafeInteger(n) ? n : midRaw;

    } else body.messageId = midRaw;

  }

  return body;

}



function attachDebugShape(a) {

  if (!a || typeof a !== 'object') return '{}';

  try {

    const o = {};

    const keys = Object.keys(a);

    for (let i = 0; i < keys.length; i++) {

      const k = keys[i];

      const v = a[k];

      if (v != null && typeof v === 'object' && !Array.isArray(v)) o[k] = 'obj';

      else if (Array.isArray(v)) o[k] = 'arr';

      else o[k] = typeof v;

    }

    return JSON.stringify(o);

  } catch (_) {

    return '{}';

  }

}



/**

 * Прямой URL из вложения или FILE_DOWNLOAD по fileId.

 * ctx (chatId, messageId) часто нужен серверу для документов без публичного url.

 */

async function resolveAttachDownloadUrl(cl, a, ctx) {

  if (!a || typeof a !== 'object') return '';

  let url =

    a.baseUrl ||

    a.url ||

    (a.photo && (a.photo.baseUrl || a.photo.url));

  if (url) return String(url);

  if (a.file && (a.file.baseUrl || a.file.url))

    return String(a.file.baseUrl || a.file.url);



  const fid = extractAttachFileId(a);

  if (!cl || fid == null || fid === '') return '';

  const withCtx = buildFileDownloadRpcPayload(fid, ctx || null);

  const minimal = buildFileDownloadRpcPayload(fid, null);

  const attempts = [];

  if (withCtx) attempts.push(withCtx);

  if (minimal && JSON.stringify(minimal) !== JSON.stringify(withCtx)) attempts.push(minimal);

  if (!attempts.length) return '';



  let lastErr = null;

  for (let ai = 0; ai < attempts.length; ai++) {

    try {

      const r = await cl.sendAndWait(Opcode.FILE_DOWNLOAD, attempts[ai]);

      const got = extractUrlFromDownloadPayload(r && r.payload);

      if (got) return String(got);

    } catch (e) {

      lastErr = e;

    }

  }



  if (lastErr) {

    try {

      process.stderr.write(

        '[attach-url] FILE_DOWNLOAD: ' +

          (lastErr.message ? lastErr.message : String(lastErr)) +

          ' fileId=' +

          String(fid) +

          ' shape=' +

          attachDebugShape(a) +

          '\n'

      );

    } catch (_) {}

  }

  return '';

}



/** @param {{ chatId?: number|string, messageId?: string|null }} [ctx] */

async function buildAttachmentUiList(cl, list, ctx) {

  if (!list || !list.length) return [];

  const out = [];

  for (let i = 0; i < list.length; i++) {

    const a = list[i];

    const url = await resolveAttachDownloadUrl(cl, a, ctx);

    out.push({

      idx: i,

      type: (a && (a._type || a.type)) || '',

      url: url ? String(url) : '',

      fileName: pickAttachmentFileName(a)

    });

  }

  return out;

}



async function saveAttachmentsForIncomingMessage(msg, cl) {

  const dir = process.env.MAXCLIENT_DOWNLOADS;

  if (!dir || !msg.attachments || msg.attachments.length === 0) return;

  const midRaw = jsonSafeMessageId(msg.id) || 'x';
  const safeMsgIdBase = midRaw.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const sock = cl || client;

  for (let i = 0; i < msg.attachments.length; i++) {

    const a = msg.attachments[i];

    const attachCtx = { chatId: msg.chatId, messageId: jsonSafeMessageId(msg.id) };

    const url = await resolveAttachDownloadUrl(sock, a, attachCtx);

    if (!url) continue;

    try {

      const ext = extFromAttachType(a._type || a.type) || '.bin';

      const fname = `chat-${msg.chatId}-msg-${safeMsgIdBase}-a${i}${ext}`;

      const r = await downloadUrlToTempFile(String(url), {

        dir,

        filename: fname,

        extFallback: ext

      });

      emit({

        evt: 'media_saved',

        chatId: msg.chatId,

        messageId: midRaw,

        path: r.path,

        contentType: r.contentType || ''

      });

    } catch (e) {

      emit({

        evt: 'media_error',

        chatId: msg.chatId,

        messageId: midRaw,

        error: e && e.message ? e.message : String(e),

        urlPreview: String(url).slice(0, 180)

      });

    }

  }

}



function wireHandlers() {

  client.onMessage(async (msg) => {

    try {

      if (client.me && msg.senderId === client.me.id) return;

      const attachCtx = { chatId: msg.chatId, messageId: jsonSafeMessageId(msg.id) };

      const attUi = await buildAttachmentUiList(client, msg.attachments || [], attachCtx);

      const preview =

        msg.text ||

        (msg.attachments && msg.attachments.length ? '[вложение]' : '');

      emit({

        evt: 'message',

        senderName: msg.getSenderName(),

        text: preview,

        chatId: msg.chatId,

        senderId: msg.senderId,

        timestamp: msg.timestamp,

        messageId: jsonSafeMessageId(msg.id),

        id: jsonSafeMessageId(msg.id),

        attachments: attUi

      });

      try {

        await saveAttachmentsForIncomingMessage(msg, client);

      } catch (_) {

        /* уже залогировано media_error */

      }

    } catch (e) {

      emit({ evt: 'error', message: e.message });

    }

  });

  client.onError(async (err) => {

    emit({

      evt: 'error',

      message: err && err.message ? err.message : String(err)

    });

  });

}



async function cmdConfigure(payload) {

  payload = payload || {};

  dataRoot =

    (process.env.MAXCLIENT_DATA_ROOT &&

      String(process.env.MAXCLIENT_DATA_ROOT).trim()) ||

    payload.dataRoot;

  sessionName =

    (process.env.MAXCLIENT_SESSION_NAME &&

      String(process.env.MAXCLIENT_SESSION_NAME).trim()) ||

    payload.sessionName ||

    sessionName;

  if (!dataRoot || String(dataRoot).trim() === '') {

    throw new Error('Задайте MAXCLIENT_DATA_ROOT (из C#) или поле dataRoot в configure');

  }

  dataRoot = path.resolve(String(dataRoot).trim());

  if (!fs.existsSync(dataRoot)) {

    fs.mkdirSync(dataRoot, { recursive: true });

  }

  process.chdir(dataRoot);



  const dl = process.env.MAXCLIENT_DOWNLOADS && String(process.env.MAXCLIENT_DOWNLOADS).trim();

  if (dl && !fs.existsSync(dl)) {

    fs.mkdirSync(dl, { recursive: true });

  }



  emit({

    evt: 'configured',

    dataRoot,

    sessionDir: path.join(dataRoot, 'sessions'),

    sessionName,

    downloadsDir: dl || ''

  });

}



async function stopClientQuiet() {

  if (!client) return;

  try {

    await client.stop();

  } catch (_) {

    /* ignore */

  }

  client = null;

}



async function cmdLoginResume() {

  pendingAuth = null;

  pending2fa = null;

  await stopClientQuiet();



  client = createClient();

  wireHandlers();



  await client.connect();



  const tok = client.session.get('token');

  if (tok && String(tok).trim() !== '') {

    try {

      client._token = String(tok).trim();

      await client.sync();

      client.isAuthorized = true;

      await client.triggerHandlers(EventTypes.START);

      const me = client.me

        ? {

            id: client.me.id,

            fullname: client.me.fullname,

            phone: client.me.phone

          }

        : null;

      emit({ evt: 'ready', me });

    } catch (e) {

      emit({

        evt: 'session_invalid',

        message: e && e.message ? e.message : String(e)

      });

      await stopClientQuiet();

    }

    return;

  }



  emit({ evt: 'need_phone' });

}



async function cmdSmsRequest(payload) {

  const phone = payload.phone;

  if (!phone || !String(phone).trim()) {

    throw new Error('Укажите номер телефона');

  }

  if (!client || !client.isConnected) {

    throw new Error('Нет соединения: выполните login_resume');

  }

  pendingAuth = await client.authorizeBySMS(String(phone).trim());

  pending2fa = null;

  emit({ evt: 'sms_sent', phone: pendingAuth.phone });

}



async function cmdSmsCode(payload) {

  const code = payload.code;

  if (!pendingAuth) {

    throw new Error('Сначала запросите код (sms_request)');

  }

  if (!code || !/^\d{6}$/.test(String(code).trim())) {

    throw new Error('Нужен код из 6 цифр');

  }



  const out = await pendingAuth.sendCode(String(code).trim());



  if (

    out &&

    typeof out === 'object' &&

    out.needsPassword &&

    typeof out.sendPassword === 'function'

  ) {

    pending2fa = out.sendPassword;

    const pc = out.passwordChallenge || {};

    emit({

      evt: 'need_2fa',

      hint: pc.hint != null ? String(pc.hint) : '',

      email: pc.email != null ? String(pc.email) : ''

    });

    return;

  }



  pendingAuth = null;

  pending2fa = null;

  await client.triggerHandlers(EventTypes.START);

  const me = client.me

    ? {

        id: client.me.id,

        fullname: client.me.fullname,

        phone: client.me.phone

      }

    : null;

  emit({ evt: 'ready', me });

}



async function cmdSms2fa(payload) {

  const password = payload.password;

  if (!pending2fa) {

    throw new Error('2FA не ожидается');

  }

  if (!password || !String(password).trim()) {

    throw new Error('Пустой пароль 2FA');

  }

  await pending2fa(String(password).trim());

  pending2fa = null;

  pendingAuth = null;

  await client.triggerHandlers(EventTypes.START);

  const me = client.me

    ? {

        id: client.me.id,

        fullname: client.me.fullname,

        phone: client.me.phone

      }

    : null;

  emit({ evt: 'ready', me });

}



function mapChatRowsFromRaw(chats) {

  return (chats || [])

    .map((c) => {

      const chatId =

        c.id ??

        c.chatId ??

        (c.chat && (c.chat.id ?? c.chat.chatId));

      const title =

        c.title ||

        c.name ||

        (c.chat && (c.chat.title || c.chat.name)) ||

        `Чат ${chatId}`;

      const lm =

        c.lastMessage ||

        c.lastMsg ||

        (c.chat && c.chat.lastMessage) ||

        {};

      const lastText = lm.text || lm.message || '';

      const lastTs =

        lm.timestamp ?? lm.time ?? c.lastTimestamp ?? c.time ?? 0;

      return {

        chatId,

        title: String(title),

        lastText: String(lastText).slice(0, 220),

        lastTimestamp: lastTs

      };

    })

    .filter((r) => r.chatId != null && Number.isFinite(Number(r.chatId)));

}



function extractChatListFromInfoPayload(info) {

  if (!info) return [];

  if (Array.isArray(info)) return info;

  if (Array.isArray(info.chats)) return info.chats;

  if (Array.isArray(info.chatInfos)) return info.chatInfos;

  if (info.payload && Array.isArray(info.payload.chats)) return info.payload.chats;

  if (info.result && Array.isArray(info.result.chats)) return info.result.chats;

  return [];

}



function normalizeKnownChatIds(raw) {

  if (!raw) return [];

  if (!Array.isArray(raw)) return [];

  return raw

    .map((x) => Number(x))

    .filter((n) => Number.isFinite(n));

}



async function cmdGetChats(payload) {

  const p = payload || {};

  if (!client || !client.isAuthorized) {

    throw new Error('Сначала войдите в аккаунт');

  }

  const marker = p.marker != null ? Number(p.marker) : 0;

  let chats = await client.getChats(marker);

  let rows = mapChatRowsFromRaw(chats);

  const known = normalizeKnownChatIds(p.knownChatIds);

  if (rows.length === 0 && known.length > 0) {

    try {

      const info = await client.getChatInfo(known);

      const list = extractChatListFromInfoPayload(info);

      rows = mapChatRowsFromRaw(list);

    } catch (_) {

      /* fallback необязателен для UX */

    }

  }

  emit({ evt: 'chats_list', chats: rows, marker });

}



async function cmdGetHistory(payload) {

  const p = payload || {};

  if (!client || !client.isAuthorized) {

    throw new Error('Сначала войдите в аккаунт');

  }

  const chatId = p.chatId;

  if (chatId == null) {

    throw new Error('Нужен chatId');

  }

  const backward = p.backward != null ? Number(p.backward) : 80;

  const from = p.from != null ? Number(p.from) : Date.now();

  const msgs = await client.getHistory(chatId, from, backward, 0);

  const rows = [];

  for (const m of msgs) {

    const attachCtx = {

      chatId: m.chatId != null ? m.chatId : chatId,

      messageId: jsonSafeMessageId(m.id)

    };

    const attUi = await buildAttachmentUiList(client, m.attachments || [], attachCtx);

    rows.push({

      id: jsonSafeMessageId(m.id),

      messageId: jsonSafeMessageId(m.id),

      chatId: m.chatId != null ? m.chatId : chatId,

      text: m.text || '',

      senderId: m.senderId,

      senderName: m.getSenderName ? m.getSenderName() : '',

      timestamp: m.timestamp,

      attachments: attUi

    });

  }

  emit({ evt: 'history_loaded', chatId, messages: rows, appendOlder: !!p.appendOlder, backwardRequested: backward });

}



async function cmdDownloadAttachment(payload) {

  const p = payload || {};

  const dir = process.env.MAXCLIENT_DOWNLOADS && String(process.env.MAXCLIENT_DOWNLOADS).trim();

  if (!dir) {

    throw new Error('Каталог загрузок не задан (MAXCLIENT_DOWNLOADS). Перезапустите клиент.');

  }

  const url = p.url != null ? String(p.url).trim() : '';

  if (!url) {

    throw new Error('Нужен url');

  }

  const chatId = p.chatId != null ? Number(p.chatId) : 0;

  const messageId = p.messageId != null ? String(p.messageId) : 'x';

  const idx = p.idx != null ? Number(p.idx) : 0;

  const attachType = p.attachType != null ? String(p.attachType) : '';

  const openAfter = !!p.openAfter;

  const ext = extFromAttachType(attachType) || '.bin';

  const safeMsgId = messageId.replace(/[^\w.-]+/g, '_').slice(0, 80);

  const fname = `chat-${chatId}-msg-${safeMsgId}-a${idx}${ext}`;

  try {

    const r = await downloadUrlToTempFile(url, {

      dir,

      filename: fname,

      extFallback: ext

    });

    emit({

      evt: 'media_saved',

      chatId,

      messageId,

      path: r.path,

      contentType: r.contentType || '',

      openAfter

    });

  } catch (e) {

    emit({

      evt: 'media_error',

      chatId,

      messageId,

      error: e && e.message ? e.message : String(e),

      urlPreview: url.slice(0, 180)

    });

  }

}



function messageToChatUiPayload(message, chatIdFallback, textFallback, attachmentsUi) {

  const me = client && client.me;

  if (!message || message.id == null) {

    return {

      evt: 'message',

      chatId: chatIdFallback,

      text: textFallback || '',

      senderId: me ? me.id : null,

      senderName: me && me.fullname ? me.fullname : 'Я',

      timestamp: Date.now(),

      messageId: null,

      id: null,

      attachments: []

    };

  }

  const idStr = jsonSafeMessageId(message.id);

  const att =

    attachmentsUi != null

      ? attachmentsUi

      : summarizeAttachments(message.attachments || []);

  return {

    evt: 'message',

    chatId: message.chatId != null ? message.chatId : chatIdFallback,

    text: message.text || textFallback || '',

    senderId: message.senderId,

    senderName: message.getSenderName ? message.getSenderName() : '',

    timestamp: message.timestamp,

    messageId: idStr,

    id: idStr,

    attachments: att

  };

}



async function cmdSendMessage(payload) {

  const p = payload || {};

  if (!client || !client.isAuthorized) {

    emit({ evt: 'send_finished', ok: false, message: 'Сначала войдите' });

    return;

  }

  const chatId = p.chatId != null ? Number(p.chatId) : 0;

  const text = p.text != null ? String(p.text) : '';

  if (!chatId || !text.trim()) {

    emit({ evt: 'send_finished', ok: false, message: 'Нужны чат и текст' });

    return;

  }

  try {

    const message = await client.sendMessage({ chatId, text: text.trim() });

    const attachCtx = { chatId, messageId: jsonSafeMessageId(message.id) };

    const attUi = await buildAttachmentUiList(client, message.attachments || [], attachCtx);

    emit(messageToChatUiPayload(message, chatId, text.trim(), attUi));

    emit({ evt: 'send_finished', ok: true });

  } catch (e) {

    emit({

      evt: 'send_finished',

      ok: false,

      message: e && e.message ? e.message : String(e)

    });

  }

}



async function cmdStop() {

  pendingAuth = null;

  pending2fa = null;

  await stopClientQuiet();

  emit({ evt: 'stopped' });

}



async function cmdLogout(payload) {

  const p = payload || {};

  const remove = p.removeLocalSession !== false;

  pendingAuth = null;

  pending2fa = null;

  if (client) {

    try {

      await client.stop();

      if (remove) client.session.destroy();

    } catch (e) {

      emit({

        evt: 'error',

        message: e && e.message ? e.message : String(e)

      });

    }

    client = null;

  }

  emit({ evt: 'logged_out', keepSession: !remove });

}



async function cmdSwitchSession(payload) {

  const p = payload || {};

  const name = p.sessionName != null ? String(p.sessionName).trim() : '';

  if (!name) {

    throw new Error('Нужен sessionName');

  }

  if (!dataRoot) {

    throw new Error('Сначала выполните configure');

  }

  pendingAuth = null;

  pending2fa = null;

  await stopClientQuiet();

  sessionName = name;

  emit({ evt: 'session_slot', sessionName: name });

  await cmdConfigure({ dataRoot, sessionName: name });

  await cmdLoginResume();

}



async function dispatch(cmd) {

  switch (cmd.cmd) {

    case 'configure':

      await cmdConfigure(cmd);

      return;

    case 'login_resume':

      await cmdLoginResume();

      return;

    case 'sms_request':

      await cmdSmsRequest(cmd);

      return;

    case 'sms_code':

      await cmdSmsCode(cmd);

      return;

    case 'sms_2fa':

      await cmdSms2fa(cmd);

      return;

    case 'get_chats':

      await cmdGetChats(cmd);

      return;

    case 'get_history':

      await cmdGetHistory(cmd);

      return;

    case 'send_message':

      await cmdSendMessage(cmd);

      return;

    case 'download_attachment':

      await cmdDownloadAttachment(cmd);

      return;

    case 'stop':

      await cmdStop();

      return;

    case 'logout':

      await cmdLogout(cmd);

      return;

    case 'switch_session':

      await cmdSwitchSession(cmd);

      return;

    default:

      throw new Error('Неизвестная команда: ' + cmd.cmd);

  }

}



const rl = readline.createInterface({

  input: process.stdin,

  terminal: false

});



rl.on('line', (line) => {

  const trimmed = line.trim();

  if (!trimmed) return;



  let msg;

  try {

    msg = JSON.parse(trimmed);

  } catch (_) {

    emit({ evt: 'error', message: 'Невалидный JSON команды' });

    return;

  }



  Promise.resolve()

    .then(() => dispatch(msg))

    .catch((e) => {

      emit({

        evt: 'error',

        message: e && e.message ? e.message : String(e)

      });

    });

});



setTimeout(() => {

  emit({ evt: 'bridge_ready', node: process.version });

}, 150);

