#!/usr/bin/env node
'use strict';
// 联机协议测试：版本握手、消息校验/限流、名字净化、令牌重连、保留座位、顶替规则。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const J = x => JSON.parse(JSON.stringify(x)); // 跨 vm realm 比较用

class FakePeer {
  constructor(id) { this.id = id; this.h = {}; FakePeer.last = this; setTimeout(() => this.emit('open'), 0); }
  on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
  emit(e, a) { (this.h[e] || []).forEach(f => f(a)); }
  destroy() {} reconnect() {}
}
function mkConn() {
  const c = { sent: [], closed: false, h: {}, on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; },
    send(m) { if (this.closed) throw new Error('closed'); this.sent.push(m); }, close() { if (this.closed) return; this.closed = true; (this.h.close || []).forEach(f => f()); },
    recv(m) { (this.h.data || []).forEach(f => f(m)); } };
  return c;
}
const Game = { turnOrder: ['bottom', 'right', 'top', 'left'], PHASE: {}, setPhase() {}, logFlow() {}, requestRender() {}, gameEpoch: 1, scheduleAi: f => f(), aiThinkMs: () => 0,
  $: () => ({ classList: { add() {}, remove() {}, contains: () => false } }), hideIndicator() {}, showIndicator() {} };
const ctx = { Game, window: { addEventListener() {} }, document: { querySelector: () => null, addEventListener() {} }, localStorage: { getItem: () => null },
  Peer: FakePeer, setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Object, Array, Date, Number, String, JSON, Math, RegExp, Uint32Array, crypto: require('crypto').webcrypto };
vm.createContext(ctx);
for (const f of ['js/23-net.js', 'js/24-net-host.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const sleep = ms => new Promise(r => setTimeout(r, ms));

Game.continueAfterFirstTurnCheck = () => {}; Game.applyReveal = () => true;
(async () => {
  Game.netTimeouts.ping = 5000; Game.netTimeouts.hello = 2000; Game.netTimeouts.dead = 60000;

  // ---- UTF-8 字节计数：中文 3 字节/字，JSON.length 会少估 ----
  const zh = { t: 'hello', name: '龙'.repeat(1500) };       // JSON 约 1.5K 字符，实际约 4.5KB
  assert(JSON.stringify(zh).length < 4096, '前提：字符数在限内');
  assert(Game.netMsgBytes(zh) > 4096, 'UTF-8 字节数应超限：' + Game.netMsgBytes(zh));
  assert.strictEqual(Game.netMsgBytes({ a: '龙' }), Buffer.byteLength('{"a":"龙"}', 'utf8'));
  assert.strictEqual(Game.netMsgBytes({ a: '😀' }), Buffer.byteLength('{"a":"😀"}', 'utf8'), 'emoji 4 字节');
  const circ = {}; circ.self = circ;
  assert(Game.netMsgBytes(circ) > 4096, '循环引用按超限处理');
  assert(Game.netMsgBytes(undefined) > 4096, '不可序列化按超限处理');

  // ---- intent 原型名不得放行 ----
  const ok = { t: 'intent', id: 'a1', kind: 'discard', tile: '1万' };
  assert(Game.netValidIntent(ok), '合法 intent 应通过');
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert(!Game.netValidIntent(Object.assign({}, ok, { kind: bad })), 'kind=' + bad + ' 必须被拒');
    assert(!Game.netValidIntent({ t: 'intent', id: 'a2', kind: 'claim', choice: bad }), 'choice=' + bad + ' 必须被拒');
  }
  assert(Game.netValidIntent({ t: 'intent', id: 'a3', kind: 'claim', choice: 'peng' }));
  assert(!Game.netValidIntent([ok]), '数组不是合法消息');
  assert(!Game.netValidIntent(Object.create({ t: 'intent', id: 'a4', kind: 'discard' })) , '继承来的字段不算');

  // ---- 房主入站：类型白名单 + 数组/原型名/超大中文消息都计违规并最终踢出 ----
  const r = await Game.netCreateRoom('MSG234', '房主');
  assert(r.ok);
  const peer = FakePeer.last;
  const c = mkConn(); peer.emit('connection', c);
  c.recv({ t: 'hello', v: 2, name: '阿龙' });
  assert(c.sent[0] && c.sent[0].t === 'welcome', '正常入座');
  Game.net.started = true;
  const before = c.sent.length;
  const evil = [['intent'], { t: 'constructor' }, { t: '__proto__' }, { t: 'toString' }, { t: 'hasOwnProperty' }, zh, { t: 'valueOf' }, { t: 'nope' }];
  for (const m of evil) { if (c.closed) break; c.recv(m); }
  assert(c.closed, '累计 8 次违规应被踢出（原型名/数组/超大中文消息都计违规）');
  Game.netLeave();
  console.log('net message validation tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
