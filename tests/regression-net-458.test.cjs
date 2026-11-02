#!/usr/bin/env node
'use strict';
// v4.5.9 联机回归：令牌随机源、客人快照校验 + 原子提交、要约/结算校验与幂等、
// 房主意图与要约匹配、等待任务取消/跨局超时、ready 去重、重连补发。
// 每一条都对应一个「修之前会出错」的具体场景（见各段注释）。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = x => JSON.parse(JSON.stringify(x));
process.on('unhandledRejection', e => { console.error('unhandledRejection', e); process.exit(1); });

const T13 = ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万', '9万', '1条', '2条', '3条', '4条'];
const SEATS = ['top', 'left', 'right', 'bottom'];
const emptyMelds = () => ({ top: [], left: [], right: [], bottom: [] });
const zeroScores = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
const counts13 = () => ({ top: 13, left: 13, right: 13, bottom: 13 });

// ============================================================ 客人侧（23/24/25，最小桩）
function makeGuestCtx() {
  const calls = { indicator: 0, results: [], banner: 0, toast: [] };
  const Game = {
    turnOrder: ['bottom', 'right', 'top', 'left'], PHASE: {}, setPhase() {}, logFlow() {}, requestRender() {},
    $: () => ({ classList: { add() {}, remove() {}, contains: () => false } }), hideIndicator() {}, showIndicator() { calls.indicator++; },
    baseNames: { bottom: 'a' }, statAvatar: {}, scheduleAi: f => f(), aiThinkMs: () => 0, gameEpoch: 1,
    showResultModal(...a) { calls.results.push(a); }, nameOf: p => p, feel: { banner() { calls.banner++; } },
  };
  const ctx = { Game, window: { addEventListener() {} }, document: { querySelector: () => null, readyState: 'complete', addEventListener() {} },
    location: { reload() {} }, setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Object, Array, Date, Number, String, JSON, Math, RegExp, Uint8Array, Uint32Array, Peer: function () {},
    crypto: require('crypto').webcrypto };
  vm.createContext(ctx);
  for (const f of ['js/23-net.js', 'js/24-net-host.js', 'js/25-net-guest.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  const sent = [];
  Game.net = { role: 'guest', seat: 'top', seats: [], seq: 0, guestConn: { send: m => sent.push(m) } };
  Game.netGuestInit({ seat: 'top' });
  Game.net.lastHostMsg = Date.now() + 3.6e6; // 屏蔽「房主静默」看门狗，避免测试期间触发重连
  return { Game, calls, sent };
}
function goodSnap(extra) {
  return Object.assign({ v: 2, seq: 1, epoch: 3, currentPlayer: 'top', dealer: 'bottom', deckCount: 70,
    discards: [{ tile: '1万', player: 'bottom' }], handCounts: counts13(), melds: emptyMelds(), scores: zeroScores(), names: {},
    hand: T13.slice(), drawnIdx: null, gameOver: false, winner: null, started: true }, extra || {});
}

(async () => {
  // ---------- 1. 令牌：只能用 CSPRNG，没有就拒绝入座（不再退回 Math.random） ----------
  {
    const { Game } = makeGuestCtx();
    const tok = Game.netGenToken();
    assert(/^[0-9a-f]{32}$/.test(tok), '令牌应为 128 位十六进制：' + tok);
    assert.notStrictEqual(tok, Game.netGenToken(), '两次令牌不得相同');
  }
  {
    // 无 crypto 的环境：genToken 必须抛错，且房主入座被拒、座位表不变
    const conn = () => { const c = { sent: [], closed: false, h: {}, on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }, send(m) { this.sent.push(m); }, close() { this.closed = true; }, recv(m) { (this.h.data || []).forEach(f => f(m)); } }; return c; };
    class FakePeer { constructor() { this.h = {}; FakePeer.last = this; setTimeout(() => (this.h.open || []).forEach(f => f()), 0); } on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; } destroy() {} reconnect() {} }
    const Game = { turnOrder: ['bottom', 'right', 'top', 'left'], PHASE: {}, setPhase() {}, logFlow() {}, requestRender() {}, gameEpoch: 1, $: () => ({ classList: { add() {}, remove() {}, contains: () => false } }) };
    const mathNoRandom = Object.create(Math); mathNoRandom.random = () => { throw new Error('Math.random 不得用于令牌'); };
    const ctx = { Game, window: { addEventListener() {} }, document: { querySelector: () => null, addEventListener() {} }, localStorage: { getItem: () => null },
      Peer: FakePeer, setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Object, Array, Date, Number, String, JSON, Math: mathNoRandom, RegExp, Uint32Array /* 故意不提供 crypto */ };
    vm.createContext(ctx);
    for (const f of ['js/23-net.js', 'js/24-net-host.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    assert.throws(() => Game.netGenToken(), /no-secure-random/, '无 CSPRNG 必须抛错，不得降级');
    const r = await Game.netCreateRoom('NOCRY2', '房主');
    assert(r.ok);
    const c = conn(); FakePeer.last.h.connection.forEach(f => f(c));
    c.recv({ t: 'hello', v: 2, name: '阿龙' });
    const deny = c.sent.find(m => m.t === 'deny');
    assert(deny && deny.fatal, '无安全随机源应拒绝入座：' + JSON.stringify(c.sent));
    assert.strictEqual(Game.net.seats.length, 1, '拒绝时座位表不得被改动');
    assert(!c.sent.some(m => m.t === 'welcome'));
    Game.netLeave();
  }

  // ---------- 2. 客人快照：校验 → 整体提交；坏快照不污染状态、不推进 seq ----------
  {
    const { Game } = makeGuestCtx();
    assert.strictEqual(Game.netGuestApplyState(goodSnap()), true, '合法快照应应用');
    assert.strictEqual(Game.net.seq, 1);
    assert.strictEqual(Game.hands.bottom.length, 13);
    const keep = { hands: Game.hands, melds: Game.exposedMelds, deck: Game.deck, scores: Game.scores, pile: Game.discardPile, epoch: Game.gameEpoch };
    const bad = {
      '牌墙张数超大（旧：new Array(1e9).fill 卡死客人）': goodSnap({ seq: 2, deckCount: 1e9 }),
      '手牌张数超大': goodSnap({ seq: 2, handCounts: Object.assign(counts13(), { left: 1e9 }) }),
      '手牌是字符串（旧：字符串也有 slice，会被当数组）': goodSnap({ seq: 2, hand: 'abcdefghijklm' }),
      '手牌含非法牌码': goodSnap({ seq: 2, hand: ['<img src=x onerror=alert(1)>'].concat(T13.slice(1)) }),
      '手牌张数与 handCounts 不符': goodSnap({ seq: 2, hand: T13.slice(0, 5) }),
      '同一种牌 5 张': goodSnap({ seq: 2, discards: Array(5).fill({ tile: '9筒', player: 'top' }) }),
      '弃牌人座位非法': goodSnap({ seq: 2, discards: [{ tile: '1万', player: 'evil' }] }),
      '副露类型非法': goodSnap({ seq: 2, melds: Object.assign(emptyMelds(), { left: [{ type: 'hax', tiles: ['1万', '1万', '1万'] }] }) }),
      '副露牌非法': goodSnap({ seq: 2, melds: Object.assign(emptyMelds(), { bottom: [{ type: 'peng', tiles: ['9万', '9万', 'x'] }] }) }),
      '分数 NaN': goodSnap({ seq: 2, scores: Object.assign(zeroScores(), { top: NaN }) }),
      '分数是字符串': goodSnap({ seq: 2, scores: Object.assign(zeroScores(), { top: '100' }) }),
      '座位非法': goodSnap({ seq: 2, currentPlayer: 'x' }),
      'epoch 非整数': goodSnap({ seq: 2, epoch: 'abc' }),
      'seq 伪造成巨大值（旧：之后所有真快照都被当过期丢弃）': goodSnap({ seq: 1e15 }),
      'seq NaN': goodSnap({ seq: NaN }),
      '摊牌手牌张数不符': goodSnap({ seq: 2, gameOver: true, allHands: { top: ['1万'], left: T13, right: T13, bottom: T13 } }),
      '最后一个座位的副露非法（前面都合法：验证不会更新一半）': goodSnap({ seq: 2, hand: T13.slice(), melds: { top: [], left: [], right: [], bottom: [{ type: 'peng', tiles: ['1万', '1万'] }] } }),
      '整个快照不是对象': 'oops',
    };
    for (const k of Object.keys(bad)) {
      assert.strictEqual(Game.netGuestApplyState(bad[k]), false, '应拒绝：' + k);
      assert.strictEqual(Game.net.seq, 1, 'seq 不得被坏快照推进：' + k);
      assert.strictEqual(Game.hands, keep.hands, '状态引用不得被替换：' + k);
      assert.strictEqual(Game.exposedMelds, keep.melds, k); assert.strictEqual(Game.deck, keep.deck, k);
      assert.strictEqual(Game.scores, keep.scores, k); assert.strictEqual(Game.discardPile, keep.pile, k);
      assert.strictEqual(Game.gameEpoch, keep.epoch, k);
      assert.strictEqual(Game.hands.bottom.length, 13, k);
    }
    // 房主 lastIndexOf 找不到刚摸的牌时发 -1（碰/吃之后很常见）：这是合法快照，必须应用
    assert.strictEqual(Game.netGuestApplyState(goodSnap({ seq: 1.5 })), false);
    assert.strictEqual(Game.netGuestApplyState(goodSnap({ seq: 2, epoch: 3, drawnIdx: -1 })), true, 'drawnIdx=-1 是合法值');
    assert.strictEqual(Game.lastDrawnIndex, null);
    assert.strictEqual(Game.netGuestApplyState(goodSnap({ seq: 3, epoch: 3, drawnIdx: 13 })), false, '下标超出手牌范围的快照仍应拒绝');
    Game.net.seq = 1;
    // 过期/重复快照：正常丢弃（不是错误，但也不改状态）
    assert.strictEqual(Game.netGuestApplyState(goodSnap({ seq: 1 })), false, '重复 seq 丢弃');
    // 坏快照之后，正常的下一份快照仍能应用（seq 没被毒化）
    assert.strictEqual(Game.netGuestApplyState(goodSnap({ seq: 2, epoch: 4 })), true);
    assert.strictEqual(Game.net.seq, 2); assert.strictEqual(Game.gameEpoch, 4);
    // 提交是整体的：所有字段同时更新
    assert.notStrictEqual(Game.hands, keep.hands);
    assert.strictEqual(Game.deck.length, 70);
    // 结算摊牌 + 合法副露
    const full = goodSnap({ seq: 3, gameOver: true, winner: 'top', allHands: { top: T13, left: T13.map(() => '5筒').slice(0, 13).map((t, i) => ['1字', '2字', '3字', '4字', '5字', '6字', '7字', '1筒', '2筒', '3筒', '4筒', '5筒', '6筒'][i]), right: T13, bottom: T13 } });
    // 注意：allHands 里同一种牌合计超 4 张会被拒（T13 重复了 3 次 → 每种 3~4 张 + 其它），这里只验证「合法摊牌可通过」
    const legalAll = { top: T13, left: ['1字', '2字', '3字', '4字', '5字', '6字', '7字', '1筒', '2筒', '3筒', '4筒', '5筒', '6筒'], right: T13, bottom: T13 };
    assert.strictEqual(Game.netGuestApplyState(goodSnap({ seq: 3, gameOver: true, winner: 'top', allHands: legalAll, discards: [] })), true, '合法摊牌快照应通过');
    assert.strictEqual(Game.gameOver, true);
  }

  // ---------- 3. 要约校验 / 幂等 / 过期 ----------
  {
    const { Game, calls } = makeGuestCtx();
    Game.netGuestApplyState(goodSnap());
    const junk = [
      { t: 'prompt' }, { t: 'prompt', id: 'p1', kind: 'nope' }, { t: 'prompt', id: 'p1', kind: 'turn', gangs: 'x' },
      { t: 'prompt', id: 'p1', kind: 'turn', gangs: [{ tile: 'bad', kind: 'an' }] },
      { t: 'prompt', id: 'p1', kind: 'claim', tile: '3万', from: 'bottom', opts: { peng: false, gang: false, chi: [] } }, // 没有任何可选项
      { t: 'prompt', id: 'p1', kind: 'claim', tile: '<b>', from: 'bottom', opts: { peng: true } },
      { t: 'prompt', id: 'p1', kind: 'claim', tile: '3万', from: 'evil', opts: { peng: true } },
      { t: 'prompt', id: 'p1', kind: 'claim', tile: '3万', from: 'bottom', opts: { peng: true, chi: [['1万']] } },
      { t: 'prompt', id: 'p1', kind: 'reveal', revealKind: 'zzz' },
      { t: 'prompt', id: 'x'.repeat(40), kind: 'turn' }, { t: 'prompt', id: 'p1', kind: 'turn', ms: -5 }, { t: 'prompt', id: 'p1', kind: 'turn', ms: 1e12 },
    ];
    for (const m of junk) { Game.netGuestOnMsg(m); assert.strictEqual(Game.netPrompt, null, '畸形要约不得生效：' + JSON.stringify(m)); }
    Game.netGuestOnMsg({ t: 'prompt', id: 'p7', kind: 'claim', tile: '3万', from: 'bottom', ms: 20, opts: { peng: true, gang: false, chi: [['1万', '2万']], extra: 'x' } });
    assert(Game.netPrompt && Game.netPrompt.id === 'p7');
    assert.strictEqual(Game.netPrompt.opts.extra, undefined, '只保留已知字段');
    const n1 = calls.indicator;
    Game.netGuestOnMsg({ t: 'prompt', id: 'p7', kind: 'claim', tile: '3万', from: 'bottom', ms: 20, opts: { peng: true, gang: false, chi: [] } });
    assert.strictEqual(calls.indicator, n1, '同一要约重复到达：幂等，不重复弹 UI');
    await sleep(1700); // ms + 1500 宽限后，已作废的要约自动收起
    assert.strictEqual(Game.netPrompt, null, '超过房主倒计时的要约应自动收起，不再接受点击');
  }

  // ---------- 4. 结算消息：校验、转义前提、去重 ----------
  {
    const { Game, calls } = makeGuestCtx();
    Game.netGuestApplyState(goodSnap({ seq: 1, gameOver: true, winner: 'top', discards: [], allHands: { top: T13, left: ['1字', '2字', '3字', '4字', '5字', '6字', '7字', '1筒', '2筒', '3筒', '4筒', '5筒', '6筒'], right: T13, bottom: T13 } }));
    const res = (o) => Object.assign({ t: 'result', epoch: 3, winner: 'top', mode: 'selfdraw', payer: null, tile: '4条', bonus: { mult: 2, tags: [] },
      result: { payouts: { top: 6, left: -2, right: -2, bottom: -2 }, tags: ['自摸×2'], total: 6, noKaimenPlayers: [], detail: '' } }, o || {});
    const evil = [
      res({ result: { payouts: { top: '<img src=x onerror=alert(1)>', left: 0, right: 0, bottom: 0 }, tags: [], total: 0 } }),
      res({ result: { payouts: { top: NaN, left: 0, right: 0, bottom: 0 }, tags: [], total: 0 } }),
      res({ result: { payouts: { top: 1, left: 0, right: 0, bottom: 0 }, tags: 'x', total: 0 } }),
      res({ result: { payouts: { top: 1, left: 0, right: 0, bottom: 0 }, tags: [{ a: 1 }], total: 0 } }),
      res({ winner: 'evil' }), res({ mode: 'weird' }), res({ tile: 'zzz' }), res({ mode: 'dianpao', payer: null }), 'str',
    ];
    for (const m of evil) { Game.netGuestOnMsg(m); }
    assert.strictEqual(calls.results.length, 0, '畸形结算一律不弹窗');
    Game.netGuestOnMsg(res());
    assert.strictEqual(calls.results.length, 1, '合法结算弹窗一次');
    const args = calls.results[0];
    for (const p of SEATS) assert.strictEqual(typeof args[4].payouts[p], 'number', '弹窗拿到的 payouts 必为数字');
    Game.netGuestOnMsg(res()); // 重复到达（例如重连补发）
    assert.strictEqual(calls.results.length, 1, '同一局结算重复到达只处理一次');
    Game.netGuestOnMsg(res({ epoch: 4 }));
    assert.strictEqual(calls.results.length, 2, '下一局的结算照常处理');
    // 流局
    Game.netGuestOnMsg({ t: 'result', draw: true, epoch: 5, detail: '牌墙已尽，流局' });
    assert.strictEqual(calls.banner, 1); Game.netGuestOnMsg({ t: 'result', draw: true, epoch: 5, detail: '牌墙已尽，流局' });
    assert.strictEqual(calls.banner, 1, '流局重复到达也只处理一次');
  }

  // ---------- 5. 座位表：只留已知字段（不泄令牌）、名字再净化 ----------
  {
    const { Game } = makeGuestCtx();
    const out = Game.netSanitizeSeats([
      { seat: 'top', kind: 'human', name: '<img src=x onerror=alert(1)>', token: 'SECRET', away: true, evil: 1 },
      { seat: 'top', kind: 'ai' }, // 重复座位丢弃
      { seat: '__proto__', kind: 'human' }, { seat: 'left', kind: 'constructor', name: 123 }, 'x', null,
    ]);
    assert.strictEqual(out.length, 2);
    assert(!/[<>"']/.test(out[0].name), '名字不得带尖括号/引号：' + out[0].name);
    assert.strictEqual(out[0].token, undefined); assert.strictEqual(out[0].evil, undefined);
    assert.strictEqual(out[1].kind, 'ai', '未知 kind 降级为 ai'); assert.strictEqual(out[1].name, '');
    Game.netGuestOnMsg({ t: 'seats', seats: [{ seat: 'right', kind: 'human', name: '<b>x</b>', token: 't' }] });
    assert.strictEqual(Game.net.seats.length, 1); assert(!('token' in Game.net.seats[0]));
    assert.strictEqual(J(Game.netSanitizeSeats('nope')).length, 0);
  }

  // ---------- 6. intent 校验：牌码严格、出牌/自杠必须带牌 ----------
  {
    const { Game } = makeGuestCtx();
    assert(Game.netValidIntent({ t: 'intent', id: 'a', kind: 'discard', tile: '5万' }));
    for (const t of ['<img>', '0万', '8字', '10万', '5万 ', 'x', '']) assert(!Game.netValidIntent({ t: 'intent', id: 'a', kind: 'discard', tile: t }), '牌码应被拒：' + t);
    assert(!Game.netValidIntent({ t: 'intent', id: 'a', kind: 'discard' }), '出牌不带牌应被拒');
    assert(!Game.netValidIntent({ t: 'intent', id: 'a', kind: 'selfgang', gangKind: 'an' }), '自杠不带牌应被拒');
  }

  // ============================================================ 房主侧（真 01/02/06/08 + 23/24）
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const hctx = {
    window: { addEventListener() {} }, document: { getElementById: () => null, querySelector: () => null, readyState: 'complete', addEventListener() {}, body: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { reload() {} }, Peer: function () {}, alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, console: quiet, Promise, Object, Array, Date, Number, String, JSON, Math, RegExp, Uint8Array, Uint32Array, crypto: require('crypto').webcrypto,
  };
  vm.createContext(hctx);
  for (const f of ['js/01-globals-state.js', 'js/02-scoring.js', 'js/06-tiles-utils.js', 'js/08-game-flow-core.js', 'js/23-net.js', 'js/24-net-host.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), hctx, { filename: f });
  const H = hctx.Game; H.quietTileCheck = true;
  let aiDiscards = 0;
  Object.assign(H, {
    isDailyMode: () => false, checkHu: () => false, requestRender() {}, validateHandCounts() {}, logFlow() {}, setPhase() {}, speak() {},
    sfx: { gang() {}, discard() {}, draw() {}, win() {}, peng() {} }, feel: { banner() {}, flyAiDiscard() {} }, nameOf: p => p, netToast() {}, netLog() {},
    scheduleAi() {}, markKongDiscardIfNeeded() {}, canPeng: () => false, canGang: () => false, findChiCombos: () => [], advanceTurn() {}, nextPlayerOf: p => H.turnOrder[(H.turnOrder.indexOf(p) + 1) % 4],
    chooseAiDiscardTile: h => { aiDiscards++; return h[0]; }, afterKongDiscardPlayer: null,
  });
  const HAND14 = ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万', '1条', '2条', '3条', '5筒', '6筒', '5筒'];
  function hsetup() {
    const sent = [];
    const conn = { send: m => sent.push(m), close() {} };
    H.net = { role: 'host', code: 'T', seat: 'bottom', started: true, seq: 0, lastSeen: {}, ready: {}, rtt: {}, peer: {},
      seats: [{ seat: 'bottom', kind: 'human', name: 'h' }, { seat: 'top', kind: 'human', name: 'g', token: 'a'.repeat(32), timeouts: 0 },
              { seat: 'left', kind: 'ai', name: '' }, { seat: 'right', kind: 'ai', name: '' }], conns: { top: conn } };
    H.netCancelAwaits('test-reset'); H.netOffers = {};
    H.gameOver = false; H.winner = null; H.gameEpoch = 10; H.deck = Array(60).fill('1条');
    H.hands = { top: HAND14.slice(), left: [], right: [], bottom: [] };
    H.exposedMelds = { top: [], left: [], right: [], bottom: [] }; H.discardPile = [];
    H.lastDrawnTile = { top: null, left: null, right: null, bottom: null }; H.lastDrawWasFinal = { top: false, left: false, right: false, bottom: false };
    H.currentIndex = H.turnOrder.indexOf('top'); aiDiscards = 0;
    return { sent, conn, meta: H.net.seats.find(s => s.seat === 'top') };
  }
  const lastPrompt = (sent, kind) => sent.filter(m => m.t === 'prompt' && m.kind === kind).pop();

  // ---------- 7. 房主：意图必须匹配当前要约（旧：错类型意图会立刻结束等待，让 AI 替他出牌） ----------
  {
    let { sent, conn, meta } = hsetup();
    assert.strictEqual(H.netOnSeatTurn('top'), true);
    await sleep(5);
    const p = lastPrompt(sent, 'turn'); assert(p);
    assert.strictEqual(H.netPendingAwaitCount(), 1);
    const reject = (intent, why) => {
      H.netHostOnGuestMsg(conn, Object.assign({ t: 'intent', id: p.id }, intent));
      assert.strictEqual(H.netPendingAwaitCount(), 1, '应忽略、要约仍有效：' + why);
      assert.strictEqual(aiDiscards, 0, 'AI 不得替他出牌：' + why);
      assert.strictEqual(H.discardPile.length, 0, why);
    };
    reject({ kind: 'claim', choice: 'pass' }, '出牌要约收到吃碰杠意图');
    reject({ kind: 'reveal', accept: true }, '出牌要约收到亮牌意图');
    reject({ kind: 'discard', tile: '9筒' }, '出的牌不在手里');
    reject({ kind: 'selfgang', tile: '5筒', gangKind: 'an' }, '没有被提供的杠');
    reject({ kind: 'selfgang', tile: '1万', gangKind: 'jia' }, '没有被提供的加杠');
    // 别人的 id、过期 id
    H.netHostOnGuestMsg(conn, { t: 'intent', id: 'p99999', kind: 'discard', tile: '1万' });
    assert.strictEqual(H.netPendingAwaitCount(), 1);
    // 合法出牌：生效一次；重复发同一个意图（重连重发/网络重复）幂等
    H.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'discard', tile: '8万' });
    await sleep(5);
    assert.strictEqual(H.discardPile.length, 1); assert.strictEqual(H.discardPile[0].tile, '8万');
    assert.strictEqual(H.hands.top.length, 13);
    H.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'discard', tile: '1万' });
    H.netHostOnGuestMsg(conn, { t: 'intent', id: p.id, kind: 'discard', tile: '8万' });
    await sleep(5);
    assert.strictEqual(H.discardPile.length, 1, '同一要约的重复意图只执行一次');
    assert.strictEqual(H.hands.top.length, 13);
    assert.strictEqual(aiDiscards, 0);
  }

  // ---------- 8. 要约撤销 / 跨局超时不计挂机 ----------
  {
    let { sent, meta } = hsetup();
    H.netTimeouts.turn = 40;
    H.netOnSeatTurn('top'); await sleep(5);
    assert.strictEqual(H.netPendingAwaitCount(), 1);
    H.netCancelAwaits('test');
    assert.strictEqual(H.netPendingAwaitCount(), 0, '撤销后没有悬空等待');
    await sleep(80);
    assert.strictEqual(aiDiscards, 0, '被撤销的要约不得再触发 AI 代打'); assert(!meta.timeouts, '撤销不计挂机');

    // 旧缺陷：上一局遗留的要约超时，会给这位玩家记一次挂机；连续两局就被误托管
    ({ sent, meta } = hsetup());
    H.netOnSeatTurn('top'); await sleep(5);
    H.gameEpoch++; // 局换了（不经过 initGame 的最坏情形：只有计时器兜底）
    await sleep(90);
    assert(!meta.timeouts, '跨局的超时不得计入挂机：' + meta.timeouts);
    assert(!meta.auto, '不得因遗留要约被托管'); assert.strictEqual(aiDiscards, 0);
    assert.strictEqual(H.netPendingAwaitCount(), 0, '超时后等待表已清空');

    // 对照：本局内真正超时仍然照常计挂机并由 AI 代打
    ({ sent, meta } = hsetup());
    H.netOnSeatTurn('top'); await sleep(90);
    assert.strictEqual(meta.timeouts, 1, '本局内超时应计 1 次'); assert.strictEqual(aiDiscards, 1, '本局内超时仍由 AI 代打');

    // 同一座位新要约顶替旧要约：旧的作废、不会二次执行
    ({ sent, meta } = hsetup());
    H.netTimeouts.turn = 5000;
    H.netOnSeatTurn('top'); await sleep(5);
    H.netOnSeatTurn('top'); await sleep(5);
    assert.strictEqual(H.netPendingAwaitCount(), 1, '同一座位同一时刻只有一个有效要约'); assert.strictEqual(aiDiscards, 0);
    H.netCancelAwaits('done');
    H.netTimeouts.turn = 45000;
  }

  // ---------- 9. ready：只认当前局（旧：迟到的上一局 ready 会替本局确认） ----------
  {
    const { conn } = hsetup();
    H.netHostOnGuestMsg(conn, { t: 'ready', epoch: H.gameEpoch - 1 });
    assert.strictEqual(H.net.ready.top, undefined, '上一局的 ready 不得生效');
    H.netHostOnGuestMsg(conn, { t: 'ready', epoch: H.gameEpoch });
    assert.strictEqual(H.net.ready.top, H.gameEpoch);
    H.net.ready = {}; H.netHostOnGuestMsg(conn, { t: 'ready' });
    assert.strictEqual(H.net.ready.top, H.gameEpoch, '不带 epoch 的 ready（旧客户端）仍按当前局处理');
  }

  // ---------- 10. 重连：补发结算 / 补发要约（同 id）；结算阶段不再补要约 ----------
  {
    let { sent, conn } = hsetup();
    H.netTimeouts.turn = 5000;
    H.netOnSeatTurn('top'); await sleep(5);
    const p = lastPrompt(sent, 'turn');
    sent.length = 0;
    H.netHostSyncGuest('top', true);
    assert.strictEqual(sent[0].t, 'state');
    const again = sent.find(m => m.t === 'prompt');
    assert(again && again.id === p.id && again.kind === 'turn' && again.ms > 1000, '重连后补发同一个要约（同 id，剩余时间）：' + JSON.stringify(again));
    H.netCancelAwaits('x');

    ({ sent, conn } = hsetup());
    H.gameOver = true; H.winner = 'top';
    H.net.lastResult = { epoch: H.gameEpoch, msg: { t: 'result', epoch: H.gameEpoch, winner: 'top', mode: 'selfdraw', payer: null, tile: '1万', result: {}, detail: '' } };
    H.netHostSyncGuest('top', true);
    assert(sent.some(m => m.t === 'result' && m.epoch === H.gameEpoch), '结算阶段重连要补发本局结算');
    sent.length = 0; H.net.lastResult.epoch = H.gameEpoch - 1; // 上一局的结算不得补发
    H.netHostSyncGuest('top', true);
    assert(!sent.some(m => m.t === 'result'), '上一局的结算不得补发');
  }

  console.log('regression-net-458: all cases passed');
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
