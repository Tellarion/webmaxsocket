/**
 * Офлайн-тесты протокольных кодеков (без сети и аккаунта): node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');
const { encode } = require('@msgpack/msgpack');
const lz4js = require('lz4js');
const { packWebFrame, unpackWebFrame, WEB_PROTO_VERSION } = require('../lib/webCodec');
const { packPacket, unpackPacket } = require('../lib/socketTransport');
const { WebMaxClient, APP_VERSION, BUILD_NUMBER, WS_API_URL } = require('..');

test('WEB: заголовок кадра как у web.max.ru', () => {
  const buf = packWebFrame({ cmd: 0, seq: 300, opcode: 288, payload: undefined });
  assert.strictEqual(buf.length, 10);
  assert.strictEqual(buf[0], WEB_PROTO_VERSION);
  assert.strictEqual(buf.readInt16BE(2), 300);
  assert.strictEqual(buf.readInt16BE(4), 288);
  assert.strictEqual(buf[6], 0);
  assert.strictEqual(buf.readUIntBE(7, 3), 0);
});

test('WEB: round-trip payload, BigInt через ext type 1', () => {
  const payload = { chatId: 0, messageId: 115634371937510001n, text: 'привет', nested: [1, { a: true }] };
  const frame = unpackWebFrame(packWebFrame({ cmd: 1, seq: 7, opcode: 64, payload }));
  assert.deepStrictEqual(
    { cmd: frame.cmd, seq: frame.seq, opcode: frame.opcode },
    { cmd: 1, seq: 7, opcode: 64 }
  );
  assert.strictEqual(frame.payload.messageId, 115634371937510001n);
  assert.strictEqual(frame.payload.text, 'привет');
  assert.deepStrictEqual(frame.payload.nested, [1, { a: true }]);
});

test('WEB: безопасный int64 из ext type 1 приходит как number', () => {
  const frame = unpackWebFrame(packWebFrame({ seq: 1, opcode: 1, payload: { t: 1700000000000n } }));
  assert.strictEqual(frame.payload.t, 1700000000000);
});

test('WEB: seq заворачивается в int16', () => {
  const frame = unpackWebFrame(packWebFrame({ seq: 0x8000 + 5, opcode: 1 }));
  assert.strictEqual(frame.seq, 5);
});

test('WEB: распаковка LZ4-сжатого кадра', () => {
  const body = Buffer.from(encode({ list: Array.from({ length: 200 }, (_, i) => `item-${i % 3}`) }));
  const out = Buffer.alloc(lz4js.compressBound(body.length));
  const n = lz4js.compressBlock(body, out, 0, body.length, new Uint32Array(1 << 16));
  assert.ok(n > 0 && n < body.length, 'данные должны сжаться');
  const factor = Math.ceil(body.length / n);
  const head = Buffer.alloc(10);
  head[0] = WEB_PROTO_VERSION;
  head[1] = 1;
  head.writeInt16BE(3, 2);
  head.writeInt16BE(53, 4);
  head[6] = factor;
  head.writeUIntBE(n, 7, 3);
  const frame = unpackWebFrame(Buffer.concat([head, out.subarray(0, n)]));
  assert.strictEqual(frame.payload.list.length, 200);
  assert.strictEqual(frame.payload.list[4], 'item-1');
});

test('TCP: round-trip пакета (ver 11, msgpack, BigInt)', () => {
  const buf = packPacket(11, 0, 42, 64, { chatId: 123n, text: 'x' });
  const p = unpackPacket(buf);
  assert.strictEqual(p.ver, 11);
  assert.strictEqual(p.seq, 42);
  assert.strictEqual(p.opcode, 64);
  assert.strictEqual(BigInt(p.payload.chatId), 123n);
  assert.strictEqual(p.payload.text, 'x');
});

test('Клиент: старый ws-api URL переписывается, версии по транспорту', () => {
  const opts = { name: '_unit_test', maxReconnectAttempts: 0 };
  const web = new WebMaxClient({ ...opts, deviceType: 'WEB', apiUrl: 'wss://ws-api.oneme.ru/websocket' });
  assert.strictEqual(web.apiUrl, WS_API_URL);
  assert.notStrictEqual(web.userAgent.appVersion, APP_VERSION);
  const tcp = new WebMaxClient({ ...opts, deviceType: 'ANDROID' });
  assert.strictEqual(tcp.userAgent.appVersion, APP_VERSION);
  assert.strictEqual(tcp.userAgent.buildNumber, BUILD_NUMBER);
  web.session.destroy();
});
