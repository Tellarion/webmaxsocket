/**
 * Socket transport для Max API (api.oneme.ru:443)
 * Бинарный протокол msgpack с LZ4 компрессией
 * Используется для ANDROID устройств
 */

const tls = require('tls');
const { encode: msgpackEncode, decode: msgpackDecode } = require('@msgpack/msgpack');
const { v4: uuidv4 } = require('uuid');

/**
 * Распаковка LZ4-блока (как в протоколе Max).
 * Сначала нативный `lz4` (нужен node-gyp / VS C++ на Windows), иначе чистый JS `lz4js`.
 */
function resolveLz4Uncompress() {
  try {
    const lz4Binding = require('lz4/lib/binding.js');
    return (inp, out) => lz4Binding.uncompress(inp, out);
  } catch (_) {
    try {
      const lz4js = require('lz4js');
      return (inp, out) => lz4js.decompressBlock(inp, out, 0, inp.length, 0);
    } catch (e) {
      throw new Error(
        'LZ4: установите зависимость `lz4js` (npm i lz4js) или соберите нативный `lz4` (Visual Studio, C++ workload). ' +
          e.message
      );
    }
  }
}
const lz4Uncompress = resolveLz4Uncompress();
const { Opcode, getOpcodeName } = require('./opcodes');
const { UserAgentPayload } = require('./userAgent');
const { APP_VERSION, BUILD_NUMBER } = require('./constants');

const HOST = 'api.oneme.ru';
const PORT = 443;

/**
 * Формирует бинарный пакет
 * Header: 1b ver, 2b cmd, 1b seq, 2b opcode, 4b payload_len
 */
const MSGPACK_INT64_OPTS = { useBigInt64: true };

function payloadNeedsBigInt64(v) {
  if (typeof v === 'bigint') return true;
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(payloadNeedsBigInt64);
  for (const k of Object.keys(v)) {
    if (payloadNeedsBigInt64(v[k])) return true;
  }
  return false;
}

function packPacket(ver, cmd, seq, opcode, payload) {
  const payloadBuf = payload
    ? Buffer.from(
        msgpackEncode(
          payload,
          payloadNeedsBigInt64(payload) ? MSGPACK_INT64_OPTS : undefined
        )
      )
    : Buffer.alloc(0);
  const payloadLen = payloadBuf.length & 0xFFFFFF;
  const buf = Buffer.allocUnsafe(10 + payloadBuf.length);
  buf.writeUInt8(ver, 0);
  buf.writeUInt16BE(cmd, 1);
  buf.writeUInt8(seq % 256, 3);
  buf.writeUInt16BE(opcode, 4);
  buf.writeUInt32BE(payloadLen, 6);
  if (payloadBuf.length) payloadBuf.copy(buf, 10);
  return buf;
}

/**
 * Парсит ответ. compFlag: raw LZ4 block.
 */
function unpackPacket(data) {
  if (data.length < 10) return null;
  const ver = data.readUInt8(0);
  const cmd = data.readUInt16BE(1);
  const seq = data.readUInt8(3);
  const opcode = data.readUInt16BE(4);
  const packedLen = data.readUInt32BE(6);
  const compFlag = packedLen >> 24;
  const payloadLength = packedLen & 0xFFFFFF;
  let payload = null;

  if (payloadLength > 0 && data.length >= 10 + payloadLength) {
    const payloadBytes = Buffer.from(data.subarray(10, 10 + payloadLength));
    try {
      if (compFlag !== 0) {
        const out = Buffer.alloc(Math.max(payloadLength * 20, 256 * 1024));
        const n = lz4Uncompress(payloadBytes, out);
        if (n > 0) payload = msgpackDecode(out.subarray(0, n), MSGPACK_INT64_OPTS);
      } else {
        payload = msgpackDecode(payloadBytes, MSGPACK_INT64_OPTS);
      }
    } catch (_) {
      payload = null;
    }
  }

  return { ver, cmd, seq, opcode, payload };
}

/** JSON для логов: bigint → string, обрезка длинных строк */
function safeJsonForLog(obj, maxLen = 12000) {
  if (obj === undefined) return '(no payload)';
  try {
    const s = JSON.stringify(
      obj,
      (k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    );
    return s.length > maxLen ? `${s.slice(0, maxLen)}\n… [truncated ${s.length - maxLen} chars]` : s;
  } catch (_) {
    return String(obj);
  }
}

function readExactlyFromBuffer(transport, n) {
  return new Promise((resolve) => {
    const tryResolve = () => {
      if (transport._recvBuffer.length >= n) {
        const result = transport._recvBuffer.subarray(0, n);
        transport._recvBuffer = transport._recvBuffer.subarray(n);
        resolve(Buffer.from(result));
        return true;
      }
      return false;
    };
    if (tryResolve()) return;

    const onData = () => {
      if (tryResolve()) transport.socket.removeListener('data', onData);
    };
    transport.socket.on('data', onData);
  });
}

class MaxSocketTransport {
  constructor(options = {}) {
    this.host = options.host || HOST;
    this.port = options.port || PORT;
    this.deviceId = options.deviceId || uuidv4();
    this.deviceType = options.deviceType || 'ANDROID';
    this.ua = options.ua || options.headerUserAgent || 
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    this.debug = options.debug || false;

    this.socket = null;
    this.seq = 0;
    this.ver = 11;
    this.pending = new Map();
    this._recvBuffer = Buffer.alloc(0);
  }

  _log(...args) {
    if (this.debug) console.log('[Socket]', ...args);
  }

  _debugErr(...args) {
    if (this.debug) console.error('[Socket]', ...args);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = {
        host: this.host,
        port: this.port,
        servername: this.host,
        rejectUnauthorized: true
      };
      const sock = tls.connect(opts, () => {
        this.socket = sock;
        this._recvBuffer = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);
        });
        this._log('Connected to', this.host + ':' + this.port);
        this._startRecvLoop();
        resolve();
      });
      sock.on('error', reject);
      sock.setKeepAlive(true);
    });
  }

  _makeMessage(opcode, payload, cmd = 0) {
    this.seq++;
    return {
      ver: this.ver,
      cmd,
      seq: this.seq,
      opcode,
      // undefined — пустое тело пакета (как GET_QR без payload в web); null/{} — явный объект
      payload: payload === undefined ? undefined : payload || {},
    };
  }

  /**
   * Однонаправленная отправка без ожидания ответа (ответ на серверный PING — как WebSocket sendPong).
   */
  sendOneWay(opcode, payload = {}, cmd = 0) {
    if (!this.socket || this.socket.destroyed) return;
    const msg = this._makeMessage(opcode, payload, cmd);
    const packet = packPacket(msg.ver, msg.cmd, msg.seq, msg.opcode, msg.payload);
    this.socket.write(packet);
  }

  _startRecvLoop() {
    const readNext = async () => {
      if (!this.socket || this.socket.destroyed) return;
      try {
        const header = await readExactlyFromBuffer(this, 10);
        const packedLen = header.readUInt32BE(6);
        const payloadLen = packedLen & 0xFFFFFF;
        let payloadData = Buffer.alloc(0);
        if (payloadLen > 0) {
          payloadData = await readExactlyFromBuffer(this, payloadLen);
        }
        const packet = unpackPacket(Buffer.concat([header, payloadData]));
        if (!packet) return readNext();

        const seqKey = packet.seq % 256;
        const payloads = Array.isArray(packet.payload) ? packet.payload : [packet.payload];
        for (const p of payloads) {
          const data = { ...packet, payload: p };
          const pending = this.pending.get(seqKey);
          if (pending) {
            this.pending.delete(seqKey);
            pending.resolve(data);
            break;
          }
          if (this.onNotification) this.onNotification(data);
        }
      } catch (e) {
        if (this.socket && !this.socket.destroyed) {
          this._log('Recv error:', e.message);
        }
        for (const [, p] of this.pending) p.reject(e);
        this.pending.clear();
        return;
      }
      readNext();
    };
    readNext();
  }

  async sendAndWait(opcode, payload, cmd = 0, timeout = 20000) {
    if (!this.socket || this.socket.destroyed) throw new Error('Socket not connected');

    const outMsg = this._makeMessage(opcode, payload, cmd);
    const seqKey = outMsg.seq % 256;
    const packet = packPacket(outMsg.ver, outMsg.cmd, outMsg.seq, outMsg.opcode, outMsg.payload);

    if (this.debug) {
      this._log('→', getOpcodeName(opcode), `(seq=${outMsg.seq})`, safeJsonForLog(payload));
    }

    let pendingRef;
    const promise = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const p = this.pending.get(seqKey);
        if (p) {
          this.pending.delete(seqKey);
          p.reject(new Error(`Timeout waiting for opcode ${getOpcodeName(opcode)}`));
        }
      }, timeout);
      pendingRef = {
        resolve: (data) => { clearTimeout(t); resolve(data); },
        reject: (err) => { clearTimeout(t); reject(err); }
      };
      this.pending.set(seqKey, pendingRef);
    });

    this.socket.write(packet, (err) => {
      if (err) {
        const p = this.pending.get(seqKey);
        if (p) {
          this.pending.delete(seqKey);
          p.reject(err);
        }
      }
    });

    const result = await promise;
    if (result.payload && result.payload.error) {
      const err = result.payload.error;
      const localized = result.payload.localizedMessage;
      const errText =
        localized ||
        (typeof err === 'string' ? err : err && err.message != null ? String(err.message) : '') ||
        JSON.stringify(err);

      if (this.debug) {
        this._debugErr('RPC error response', {
          opcode: getOpcodeName(opcode),
          opcodeNum: opcode,
          seq: outMsg.seq,
          outgoingPayload: safeJsonForLog(payload),
          fullResponsePayload: safeJsonForLog(result.payload)
        });
      }

      const e = new Error(errText);
      if (this.debug) e.rawPayload = result.payload;
      throw e;
    }
    return result;
  }

  async handshake(userAgentPayload) {
    const ua = userAgentPayload || new UserAgentPayload({
      deviceType: this.deviceType,
      headerUserAgent: this.ua,
      appVersion: APP_VERSION,
      osVersion: '14',
      deviceName: 'Android',
      screen: '360x780 3.0x',
      buildNumber: BUILD_NUMBER
    });
    const payload = {
      deviceId: this.deviceId,
      userAgent: typeof ua.toJSON === 'function' ? ua.toJSON() : ua
    };
    const resp = await this.sendAndWait(Opcode.SESSION_INIT, payload);
    this._log('Handshake OK');
    return resp;
  }

  async requestCode(phone, language = 'ru') {
    const payload = { phone, type: 'START_AUTH', language };
    const data = await this.sendAndWait(Opcode.AUTH_REQUEST, payload);
    return data.payload?.token || null;
  }

  async sendCode(tempToken, code) {
    const payload = {
      token: tempToken,
      verifyCode: code,
      authTokenType: 'CHECK_CODE'
    };
    const data = await this.sendAndWait(Opcode.AUTH, payload);
    return data.payload;
  }

  async sendLogin2FAPassword(trackId, password) {
    const payload = {
      trackId: String(trackId).trim(),
      password: String(password)
    };
    const data = await this.sendAndWait(Opcode.AUTH_LOGIN_CHECK_PASSWORD, payload);
    return data.payload;
  }

  async sync(token, userAgentJson) {
    const payload = {
      interactive: true,
      token,
      chatsSync: 0,
      contactsSync: 0,
      presenceSync: 0,
      draftsSync: 0,
      chatsCount: 40
    };
    if (userAgentJson) payload.userAgent = userAgentJson;
    const data = await this.sendAndWait(Opcode.LOGIN, payload);
    return data.payload;
  }

  async getChats(marker = 0) {
    const data = await this.sendAndWait(Opcode.CHATS_LIST, { marker });
    return data.payload?.chats || [];
  }

  async getHistory(chatId, from = Date.now(), backward = 200, forward = 0) {
    const data = await this.sendAndWait(Opcode.CHAT_HISTORY, {
      chatId,
      from,
      forward,
      backward,
      getMessages: true
    });
    return data.payload?.messages || [];
  }

  async close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [, p] of this.pending) p.reject(new Error('Connection closed'));
    this.pending.clear();
  }
}

module.exports = { MaxSocketTransport, packPacket, unpackPacket, HOST, PORT };
