#!/usr/bin/env node
'use strict';
// 联机回归测试：用最小桩加载 23/24/25，验证评审发现的问题已修复。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
let alerts = 0, sent = [];
const Game = {
  turnOrder: ['bottom', 'right', 'top', 'left'], PHASE: {}, setPhase() {}, logFlow() {}, requestRender() {},
  $: () => ({ classList: { add() {}, remove() {}, contains: () => false } }), hideIndicator() {}, showIndicator() {},
  baseNames: { bottom: 'a' }, statAvatar: {}, scheduleAi: f => f(), aiThinkMs: () => 0, gameEpoch: 1,
};
const ctx = { Game, window: { addEventListener() {} }, document: { querySelector: () => null, readyState: 'complete', addEventListener() {} },
  alert() { alerts++; }, location: { reload() {} }, setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Object, Array, Date, Number, String, JSON, Math, Peer: function () {} };
vm.createContext(ctx);
for (const f of ['js/23-net.js', 'js/24-net-host.js', 'js/25-net-guest.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });

// 1. 客人：快照晚于 prompt 到达，不得清掉 pendingClaim；点确认能发出 peng 意图
Game.net = { role: 'guest', seat: 'top', seats: [], guestConn: { send: m => sent.push(m) } };
Game.netGuestInit({ seat: 'top' });
Game.netGuestOnMsg({ t: 'prompt', id: 'p1', kind: 'claim', tile: '3万', from: 'bottom', opts: { peng: true, gang: false, chi: [] } });
Game.netGuestApplyState({ epoch: 1, currentPlayer: 'top', dealer: 'bottom', deckCount: 50, discards: [{ tile: '1万', player: 'bottom' }],
  handCounts: { top: 13, left: 13, right: 13, bottom: 13 }, melds: {}, scores: { top: 0, left: 0, right: 0, bottom: 0 }, names: {}, hand: ['1万'] });
assert(Game.pendingClaim, 'pendingClaim 应被保留');
assert.strictEqual(Game.discardPile[0].player, Game.netViewSeatOf('bottom', 'top'), '弃牌出牌人应映射为 view 座位');
assert(Game.netClaimIntent('accept'), '确认应被联机钩子接管');
assert.strictEqual(JSON.stringify(sent.pop()), JSON.stringify({ t: 'intent', id: 'p1', kind: 'claim', choice: 'peng' }));

// 2. 发送失败时不吞掉 prompt
Game.netGuestOnMsg({ t: 'prompt', id: 'p2', kind: 'turn', gangs: [] });
Game.net.guestConn.send = () => { throw new Error('x'); };
assert(Game.netGuestTurnIntent('1万') === true && Game.netPrompt && Game.netPrompt.id === 'p2', '发送失败应保留 prompt');

// 3. 主动离开不弹"房主离开了"；cleanup 不清空房主钩子
Game.net.guestConn = { send() {}, close() {} }; Game.net.peer = { destroy() {} };
Game.netLeave();
Game.netGuestOnHostLeft();
assert.strictEqual(alerts, 0, '主动离开不应 alert');
assert.strictEqual(typeof Game.netClaimIntent, 'function', '房主 netClaimIntent 不得被置空');
assert.strictEqual(Game.netNoSave, true, '客人离开后镜像状态保持禁写，等刷新');

// 4. 房主：掉线座位保留为 AI；重复 hello 不占多座
const conns = {}; const mk = n => (conns[n] = { sent: [], send(m) { this.sent.push(m); }, close() {} });
Game.net = { role: 'host', code: '1', seat: 'bottom', seats: [{ seat: 'bottom', kind: 'human', name: 'h' }], conns: {}, lastSeen: {}, peer: {} };
Game.netHostInit();
assert(Game.netNoSave === true && Game.net.seats.length === 4);
const c1 = mk('a'); Game.net.conns.top = c1;
Game.net.seats.find(s => s.seat === 'top').kind = 'human';
Game.netHostDropSeat('top', '掉线');
assert.strictEqual(Game.net.seats.find(s => s.seat === 'top').kind, 'ai', '掉线座位应转 AI 并保留');
assert(c1.sent.some(m => m.t === 'kicked'));
console.log('net fixes tests passed');
