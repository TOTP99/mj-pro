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

(async () => {
  // ---- 纯函数 ----
  const code = Game.netGenCode();
  assert(Game.netValidCode(code) && code.length === 6, '房间码应为 6 位');
  assert(!/[IO01]/.test(code), '房间码不含易混字符');
  assert(Game.netValidCode('k7m2qx') && !Game.netValidCode('K7M2Q') && !Game.netValidCode('K7M2QI'));
  assert.strictEqual(Game.netCleanName('  <b>阿猫</b>\n\t"x"  '), 'b阿猫/b x'.replace('/b x','/bx'));
  assert(!/[<>"\n\t]/.test(Game.netCleanName('<script>"a"\n</script>')), '名字不含危险字符');
  assert.strictEqual(Game.netCleanName('一二三四五六七八九十甲乙丙丁').length, 12, '名字限 12 字');
  assert.strictEqual(Game.netCleanName('   ', '默认'), '默认');
  const V = Game.netValidIntent;
  assert(V({ t: 'intent', id: 'p1', kind: 'discard', tile: '3万' }));
  assert(V({ t: 'intent', id: 'p1', kind: 'claim', choice: 'chi', combo: 1 }));
  assert(V({ t: 'intent', id: 'p1', kind: 'selfgang', tile: '5筒', gangKind: 'an' }));
  assert(V({ t: 'intent', id: 'p1', kind: 'reveal', accept: true }));
  for (const bad of [null, 1, {}, { t: 'intent' }, { t: 'intent', id: 'p1', kind: 'hack' }, { t: 'intent', id: 'p1', kind: 'discard', tile: 'x'.repeat(50) },
    { t: 'intent', id: 'p1', kind: 'claim', choice: 'rm -rf' }, { t: 'intent', id: 'p1', kind: 'claim', choice: 'chi', combo: -1 }, { t: 'intent', id: 'p1', kind: 'claim', choice: 'chi', combo: 1.5 },
    { t: 'intent', id: 'p1', kind: 'selfgang', gangKind: 'zz' }, { t: 'intent', id: 'p1', kind: 'reveal', accept: 'yes' }, { t: 'intent', id: 'x'.repeat(40), kind: 'discard' }])
    assert(!V(bad), '应拒绝 ' + JSON.stringify(bad));

  // ---- 房主：握手/入座/令牌 ----
  Game.netTimeouts.ping = 40; Game.netTimeouts.reserve = 300; Game.netTimeouts.hello = 500;
  const r = await Game.netCreateRoom('ABC234', '房主<x>');
  assert(r.ok && r.role === 'host' && Game.net.name === '房主x');
  const peer = FakePeer.last;
  const join = (msg) => { const c = mkConn(); peer.emit('connection', c); c.recv(Object.assign({ t: 'hello', v: 2, name: '客' }, msg)); return c; };

  let c = join({ v: 1 });
  assert(c.sent[0].t === 'deny' && c.sent[0].fatal, '版本不一致应拒绝');
  const g1 = join({ name: '<i>阿龙</i>\n' });
  const w1 = g1.sent[0];
  assert(w1.t === 'welcome' && w1.seat === 'top' && w1.token && !w1.resumed, JSON.stringify(w1));
  assert(!JSON.stringify(w1.seats).includes(w1.token), '座位表不得含令牌');
  assert(!/[<>\n]/.test(Game.net.seats.find(s => s.seat === 'top').name), '入座名字已净化');
  g1.recv({ t: 'hello', v: 2, name: 'dup' }); // 重复 hello 不得多占座
  assert.strictEqual(Game.net.seats.length, 2, '重复 hello 不应再占座');
  const g2 = join({ name: 'B' }), g3 = join({ name: 'C' });
  assert.deepStrictEqual([g2.sent[0].seat, g3.sent[0].seat], ['left', 'right']);
  const g4 = join({ name: 'D' });
  assert(g4.sent[0].t === 'deny' && /已满/.test(g4.sent[0].text), '满座应拒绝');

  // ---- 限流/畸形消息 ----
  const g2c = Game.net.conns.left;
  for (let i = 0; i < 80; i++) g2c.recv({ t: 'intent', id: 'p' + i, kind: 'discard', tile: '1万' }); // 超过 5 秒 60 条
  await sleep(10);
  assert(g2c.closed && !Game.net.conns.left, '刷屏的连接应被踢');
  Game.net.started = true; // 之后算已开局
  const g3c = Game.net.conns.right;
  for (let i = 0; i < 12; i++) g3c.recv({ t: 'intent', id: 'x', kind: 'nope' });
  assert(g3c.closed && !Game.net.conns.right, '连续畸形消息应被踢');

  // ---- 断线保座 + 令牌重连 ----
  const tokenTop = w1.token;
  Game.net.conns.top.close(); // 意外掉线
  let m = Game.net.seats.find(s => s.seat === 'top');
  assert(m.kind === 'ai' && m.away && m.token === tokenTop, '已开局掉线：AI 暂代并保留令牌');
  const bad = join({ token: 'wrong', resume: true });
  assert(bad.sent[0].t === 'deny' && bad.sent[0].fatal, '错误令牌的重连应被拒');
  const back = join({ token: tokenTop, resume: true });
  assert(back.sent[0].t === 'welcome' && back.sent[0].resumed && back.sent[0].seat === 'top', '令牌重连应回原座');
  m = Game.net.seats.find(s => s.seat === 'top');
  assert(m.kind === 'human' && !m.away && Game.net.conns.top === back);
  // 旧连接未超时，新连接带令牌顶替
  const take = join({ token: tokenTop, resume: true });
  assert(take.sent[0].resumed && Game.net.conns.top === take && back.closed, '令牌顶替旧连接');

  // ---- 保留座位不可被新客人顶掉；过期后可 ----
  Game.net.conns.top.close();
  const n1 = join({ name: 'N1' }), n2 = join({ name: 'N2' });
  assert(n1.sent[0].t === 'welcome' && n2.sent[0].t === 'welcome', '其余 AI 座位可被顶掉');
  const n3 = join({ name: 'N3' });
  assert(n3.sent[0].t === 'deny', '保留中的座位不能被顶掉');
  await sleep(450); // reserve=300ms，心跳 40ms 释放
  m = Game.net.seats.find(s => s.seat === 'top');
  assert(!m.away && !m.token, '保留期过后释放令牌');
  const late = join({ token: tokenTop, resume: true });
  assert(late.sent[0].t === 'deny', '过期令牌不可再用');

  // ---- 手动请出：发 kicked，不保留 ----
  const target = Game.net.conns.left;
  Game.netHostDropSeat('left', '被房主请出');
  assert(target.sent.some(x => x.t === 'kicked'), '被请出者应收到 kicked');
  assert(!Game.net.seats.find(s => s.seat === 'left').token, '被请出不保留令牌');
  Game.netLeave();
  console.log('net protocol tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
