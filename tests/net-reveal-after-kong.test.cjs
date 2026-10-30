#!/usr/bin/env node
'use strict';
// 回归：联机房主，远端真人「杠后补牌 → 亮东南西北」路径（js/24-net-host.js gangReplacement/revealAfterReplacement）。
// 旧缺陷：亮牌后补的那张牌不判自摸（错过胡牌）；亮风牌后不清杠上开花标记（后续自摸被误算杠上开花）。
// 走真实流程：暗杠意图 → 补牌 → 亮牌要约 → 接受亮牌 → 再补牌；引擎用真 01/02/06/08/23/24，
// 只桩 checkHu/计分/结算/弹窗（本测试只关心流程与标记）。tile-check 的牌数守恒警告来自桩状态，已静音。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const ctx = {
  window: { addEventListener() {} },
  document: { getElementById: () => null, querySelector: () => null, readyState: 'complete', addEventListener() {}, body: null },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { reload() {} }, Peer: function () {}, alert() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  console: quiet, Promise, Object, Array, Date, Number, String, JSON, Math,
};
vm.createContext(ctx);
for (const f of ['js/01-globals-state.js', 'js/02-scoring.js', 'js/06-tiles-utils.js', 'js/08-game-flow-core.js', 'js/23-net.js', 'js/24-net-host.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const Game = ctx.Game;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 桩 ----
const WIN_TILE = '9筒';
let settled = null;
Game.isDailyMode = () => false; // 高阶：杠后补牌才会提示亮牌
Game.checkHu = (hand, melds, p) => p === 'top' && hand.includes(WIN_TILE);
Game.scoreWinningHand = () => ({ mult: 1, tags: [] });
Game.settleScore = () => ({ detail: '', tags: [], payouts: { top: 0, left: 0, right: 0, bottom: 0 }, total: 0 });
Game.showResultModal = (w, mode, payer, bonus) => { settled = { winner: w, mode, bonus }; };
Game.requestRender = () => {};
Game.validateHandCounts = () => {};
Game.logFlow = () => {};
Game.setPhase = () => {};
Game.speak = () => {};
Game.learnFromWin = () => {};
Game.sfx = { gang() {}, discard() {}, draw() {}, win() {} };
Game.feel = { banner() {}, flyAiDiscard() {}, winCelebration() {} };
Game.nameOf = p => p;
Game.netToast = () => {};
Game.netLog = () => {};
Game.scheduleAi = () => {}; // 不让 AI 自动接着打，断言只看房主这一段

function setup(deckTop) {
  // deckTop：从牌墙顶开始依次被摸到的牌（先摸的在前）
  const sent = [];
  const conn = { send: m => sent.push(m), close() {} };
  Game.net = {
    role: 'host', code: 'T', seat: 'bottom', started: true, seq: 0, lastSeen: {}, ready: {}, peer: {},
    seats: [{ seat: 'bottom', kind: 'human', name: 'h' }, { seat: 'top', kind: 'human', name: 'g' },
            { seat: 'left', kind: 'ai', name: '' }, { seat: 'right', kind: 'ai', name: '' }],
    conns: { top: conn },
  };
  Game.netOffers = {};
  Game.gameOver = false; Game.winner = null; settled = null;
  Game.gameEpoch = 1;
  Game.clearKongFlags();
  Game.deck = Array(40).fill('1条').concat([...deckTop].reverse()); // pop 从末尾摸
  Game.hands = { top: ['5万', '5万', '5万', '5万', '1字', '2字', '3字', '1万', '2万', '3万', '4万', '6万', '7万', '8万'], left: [], right: [], bottom: [] };
  Game.exposedMelds = { top: [], left: [], right: [], bottom: [] };
  Game.discardPile = [];
  Game.lastDrawnTile = { top: null, left: null, right: null, bottom: null };
  Game.lastDrawWasFinal = { top: false, left: false, right: false, bottom: false };
  Game.revealDeclined = { top: {}, left: {}, right: {}, bottom: {} };
  Game.revealPatternSeen = { top: {}, left: {}, right: {}, bottom: {} };
  Game.windDragonBonus = { top: false, left: false, right: false, bottom: false };
  Game.currentIndex = Game.turnOrder.indexOf('top');
  return { sent, conn };
}
const lastPrompt = (sent, kind) => sent.filter(m => m.t === 'prompt' && m.kind === kind).pop();

(async () => {
  // ===== 场景 A：亮风牌后补的牌正好能胡 → 必须结算自摸，且不算杠上开花 =====
  let { sent, conn } = setup(['4字', WIN_TILE]); // 杠后补 4字（凑齐东南西北），亮牌后再补 9筒（胡）
  assert.strictEqual(Game.netOnSeatTurn('top'), true, '远端真人座位应由房主接管');
  await sleep(10);
  let p = lastPrompt(sent, 'turn');
  assert.ok(p && p.gangs.some(g => g.tile === '5万' && g.kind === 'an'), '应提供暗杠选项');
  Game.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'selfgang', tile: '5万', gangKind: 'an' });
  await sleep(10);
  p = lastPrompt(sent, 'reveal');
  assert.ok(p && p.revealKind === 'winds', '杠后补到 4字 凑齐东南西北，应发亮牌要约');
  assert.strictEqual(Game.afterKongDrawPlayer, 'top', '亮牌前仍是杠后补牌状态');
  Game.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'reveal', accept: true });
  await sleep(10);
  assert.strictEqual(Game.gameOver, true, '亮牌后补到的牌能胡，必须结算自摸（旧缺陷：被跳过）');
  assert.ok(settled && settled.winner === 'top' && settled.mode === 'selfdraw', '应为 top 自摸');
  assert.ok(!settled.bonus.tags.includes('杠上开花×2'), '亮风牌又补牌后，自摸不应再算杠上开花（旧缺陷）');

  // ===== 场景 B：亮风牌后补的牌不能胡 → 清标记，继续等该座位出牌 =====
  ({ sent, conn } = setup(['4字', '2条']));
  Game.netOnSeatTurn('top');
  await sleep(10);
  p = lastPrompt(sent, 'turn');
  Game.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'selfgang', tile: '5万', gangKind: 'an' });
  await sleep(10);
  p = lastPrompt(sent, 'reveal');
  Game.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'reveal', accept: true });
  await sleep(10);
  assert.strictEqual(Game.gameOver, false, '补牌不能胡时不应结束');
  assert.strictEqual(Game.afterKongDrawPlayer, null, '亮风牌后应清除杠上开花标记');
  assert.strictEqual(Game.exposedMelds.top.length, 2, '应有 暗杠 + 亮牌 两组副露');
  const turns = sent.filter(m => m.t === 'prompt' && m.kind === 'turn');
  assert.ok(turns.length >= 2, '亮牌结算后应再发一次出牌要约');

  // ===== 场景 C：拒绝亮牌 → 保持杠上开花标记（没补第二张牌，仍是杠后补牌） =====
  ({ sent, conn } = setup(['4字']));
  Game.netOnSeatTurn('top');
  await sleep(10);
  p = lastPrompt(sent, 'turn');
  Game.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'selfgang', tile: '5万', gangKind: 'an' });
  await sleep(10);
  p = lastPrompt(sent, 'reveal');
  Game.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'reveal', accept: false });
  await sleep(10);
  assert.strictEqual(Game.gameOver, false);
  assert.strictEqual(Game.afterKongDrawPlayer, 'top', '拒绝亮牌不补牌，杠上开花标记应保留');

  process.stdout.write('net-reveal-after-kong: all cases passed\n');
  process.exit(0);
})().catch(e => { process.stderr.write((e && e.stack || e) + '\n'); process.exit(1); });
