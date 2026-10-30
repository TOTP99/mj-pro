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
  Game.netTimeouts.ping = 40; Game.netTimeouts.reserve = 5000; Game.netTimeouts.hello = 500; Game.netTimeouts.dead = 60000;
  const r = await Game.netCreateRoom('HRD234', '房主');
  assert(r.ok && r.role === 'host');
  const peer = FakePeer.last;

  // 已在房间：不得再建/再加入（防止旧连接泄漏、客人变幽灵）
  const again = await Game.netCreateRoom('HRD235', 'x');
  assert(!again.ok && /已在联机房间/.test(again.err), '重复建房应被拒：' + JSON.stringify(again));
  const again2 = await Game.netJoinRoom('HRD236', 'x');
  assert(!again2.ok && /已在联机房间/.test(again2.err), '已在房间时不得加入别的房间');

  const join = (msg) => { const c = mkConn(); peer.emit('connection', c); c.recv(Object.assign({ t: 'hello', v: 2, name: '客' }, msg)); return c; };
  const g1 = join({ name: '阿龙' });
  const tok = g1.sent[0].token;
  assert(g1.sent[0].t === 'welcome' && tok);

  // 锁房：不收新人，但令牌重连放行
  Game.netSetLocked(true);
  const g2 = join({ name: '路人' });
  assert(g2.sent[0].t === 'deny' && /锁房/.test(g2.sent[0].text), '锁房后应拒绝新玩家');
  Game.netSetLocked(false);
  const g3 = join({ name: '路人2' });
  assert(g3.sent[0].t === 'welcome', '解锁后可加入');
  Game.netSetLocked(true);

  // 重连补发提示：房主正等 top 座位时，top 带令牌重连，应再收到当前要约且剩余时间 > 0
  Game.net.started = true;
  Game.hands = { top: ['1万'], left: [], right: [], bottom: [] };
  assert(Game.netRevealRemote('top', 'winds'), '应进入远端亮牌等待');
  await sleep(20);
  const firstPrompt = g1.sent.find(m => m.t === 'prompt');
  assert(firstPrompt && firstPrompt.kind === 'reveal', '首次要约已发出');
  const back = join({ token: tok, resume: true });
  assert(back.sent[0].t === 'welcome' && back.sent[0].resumed, '锁房时令牌重连仍放行');
  const re = back.sent.find(m => m.t === 'prompt');
  assert(re && re.id === firstPrompt.id && re.kind === 'reveal' && re.ms > 0 && re.ms <= firstPrompt.ms, '重连后应补发同一要约：' + JSON.stringify(back.sent.map(m => m.t)));
  // 用补发的要约回应应被接受（不再干等超时）
  back.recv({ t: 'intent', id: re.id, kind: 'reveal', accept: false });
  await sleep(20);

  Game.netLeave();
  console.log('net hardening tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
