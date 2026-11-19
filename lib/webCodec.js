/**
 * Бинарный протокол WebSocket web.max.ru (с 19.11.2026; раньше был JSON).
 *
 * Кадр: 10 байт заголовка + msgpack payload
 *   [0] ver (10)  [1] cmd  [2..3] seq int16  [4..5] opcode int16
 *   [6] LZ4-фактор (0 — без сжатия; иначе буфер распаковки = len * фактор)
 *   [7..9] длина payload, uint24 BE
 * int64 передаются msgpack-расширением type 1 (внутри — обычный msgpack int).
 */

const { encode, decode, ExtensionCodec } = require('@msgpack/msgpack');
const { lz4Uncompress } = require('./lz4');

const WEB_PROTO_VERSION = 10;
const HEADER_LEN = 10;
/** seq — int16; веб-клиент переподключается на 32767, мы просто заворачиваем по кругу */
const WEB_SEQ_MODULO = 0x8000;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: 1,
  encode(value) {
    return typeof value === 'bigint' ? encode(value, { useBigInt64: true }) : null;
  },
  decode(data) {
    const v = decode(data, { useBigInt64: true });
    if (typeof v === 'bigint' && v >= -MAX_SAFE && v <= MAX_SAFE) return Number(v);
    return v;
  },
});

function packWebFrame({ cmd = 0, seq, opcode, payload }) {
  const body =
    payload === undefined || payload === null
      ? Buffer.alloc(0)
      : Buffer.from(encode(payload, { extensionCodec, ignoreUndefined: true }));
  if (body.length > 0xffffff) throw new Error(`Payload слишком большой: ${body.length} байт`);
  const buf = Buffer.alloc(HEADER_LEN + body.length);
  buf.writeUInt8(WEB_PROTO_VERSION, 0);
  buf.writeUInt8(cmd & 0xff, 1);
  buf.writeInt16BE(((seq % WEB_SEQ_MODULO) + WEB_SEQ_MODULO) % WEB_SEQ_MODULO, 2);
  buf.writeInt16BE(opcode, 4);
  buf.writeUInt8(0, 6);
  buf.writeUIntBE(body.length, 7, 3);
  body.copy(buf, HEADER_LEN);
  return buf;
}

function unpackWebFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < HEADER_LEN) throw new Error(`Короткий кадр: ${buf.length} байт`);
  const frame = {
    ver: buf.readUInt8(0),
    cmd: buf.readUInt8(1),
    seq: buf.readInt16BE(2),
    opcode: buf.readInt16BE(4),
    payload: undefined,
  };
  const factor = buf.readUInt8(6);
  const len = buf.readUIntBE(7, 3);
  if (len === 0) return frame;
  let body = buf.subarray(HEADER_LEN, HEADER_LEN + len);
  if (body.length !== len) throw new Error(`Длина payload ${body.length} != ${len}`);
  if (factor > 0) {
    const out = Buffer.alloc(len * factor);
    const n = lz4Uncompress(body, out);
    body = out.subarray(0, n);
  }
  // Как web.max.ru: большие int64 сервер шлёт через ext type 1, остальные — обычные number
  frame.payload = decode(body, { extensionCodec });
  return frame;
}

module.exports = { packWebFrame, unpackWebFrame, WEB_PROTO_VERSION, WEB_SEQ_MODULO, extensionCodec };
