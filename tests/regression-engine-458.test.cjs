#!/usr/bin/env node
'use strict';
// v4.5.9 引擎/AI/存档回归：七小对副露与牌张合法性、听口分类、旧版存档兼容、结算文本转义。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const { makeGame } = require('./ai-selfplay.cjs');
const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

function loadCore(storage, files) {
  const store = Object.assign({}, storage || {});
  const ctx = { window: { addEventListener() {} }, document: { getElementById: () => null, querySelector: () => null, readyState: 'complete', addEventListener() {}, body: null },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    location: { reload() {} }, Peer: function () {}, setTimeout, clearTimeout, setInterval, clearInterval, console: quiet, Promise, Object, Array, Date, Number, String, JSON, Math, Set, Map, RegExp, Image: function () {} };
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  ctx.Game.quietTileCheck = true;
  return { Game: ctx.Game, store };
}
const AI_KEY = 'qionghu_mahjong_new_ai_learn_v1', SAVE_KEY = 'qionghu_mahjong_new_progress_v2';

// ================= 1. 七小对 / 牌张合法性 =================
{
  const { Game: G } = loadCore({}, ['js/01-globals-state.js', 'js/06-tiles-utils.js', 'js/07-hu-detection.js', 'js/02-scoring.js']);
  const permissive = () => { G.isDailyMode = () => false; G.ruleRequiresKaimen = G.ruleRequiresPeng = G.ruleRequiresYaojiu = G.ruleRequiresSanmenqi = () => false; G.ruleDragonsPairAsPeng = () => true; G.ruleAllowsSevenPairs = () => true; };
  permissive();
  const pairs = ['1万', '1万', '3万', '3万', '5条', '5条', '7条', '7条', '2筒', '2筒', '9筒', '9筒', '1字', '1字'];
  assert.strictEqual(G.isSevenPairs(pairs), true, '纯暗手七对');
  assert.strictEqual(G.isSevenPairs(pairs, []), true);
  assert.strictEqual(G.isSevenPairs(pairs, [{ type: 'peng', tiles: ['4万', '4万', '4万'] }]), false, '有副露不可能是七小对（旧：只看 14 张暗牌）');
  assert.strictEqual(G.isSevenPairs(pairs, [{ type: 'winds', tiles: ['1字', '2字', '3字', '4字'] }]), false, '亮牌也算副露');
  assert.strictEqual(G.isSevenPairs(pairs.slice(0, 12).concat(['0万', '0万'])), false, '非法牌码');
  assert.strictEqual(G.isSevenPairs(pairs.slice(0, 13)), false);
  assert.strictEqual(G.checkHu(pairs, []), true);
  assert.strictEqual(G.checkHu(pairs, [{ type: 'peng', tiles: ['4万', '4万', '4万'] }]), false, '14 张暗牌 + 副露的非法状态不得胡');
  const sc = G.scoreWinningHand(pairs.slice(0, 13).filter((t, i) => i !== 12), '1字', [{ type: 'peng', tiles: ['4万', '4万', '4万'] }], false);
  assert(!sc.tags.includes('七小对×8'), '有副露不得算七小对番：' + sc.tags);
  const sc2 = G.scoreWinningHand(pairs.slice(0, 13), '1字', [], false);
  assert(sc2.tags.includes('七小对×8') && sc2.mult === 8, '纯暗手七小对照常 ×8');
  // 牌张：同一种牌（暗牌 + 副露合计）最多 4 张；未知牌码一律不可胡
  const five = ['1万', '1万', '1万', '1万', '1万', '4万', '5万', '6万', '7万', '8万', '9万', '1条', '2条', '3条'];
  assert.strictEqual(G.checkHu(five, []), false, '五张同牌不可能胡');
  assert.strictEqual(G.checkHu(['1万', '1万', '1万', '4万', '5万', '6万', '7万', '8万', '9万', '1条', '2条', '3条', '2万', '2万'], []), true, '对照：合法的同形牌照常可胡');
  assert.strictEqual(G.checkHu(['1万', '1万', '1万', '1万'].concat(['4万', '5万', '6万', '7万', '8万', '9万', '1条', '2条', '3条']).slice(0, 10), [{ type: 'gang', tiles: ['1万', '1万', '1万', '1万'] }]), false, '杠 4 张 + 暗牌再有 1万 = 超过 4 张');
  assert.strictEqual(G.checkHu(['1万', '1万', '1万', '4万', '5万', '6万', '7万', '8万', '9万', 'zz', 'zz', '3条', '2万', '2万'], []), false, '未知牌码');
  assert.strictEqual(G.tileGroupsLegal(['1万'], 'x'), false); assert.strictEqual(G.isValidTile('7字'), true); assert.strictEqual(G.isValidTile('8字'), false);
}

// ================= 2. 听口分类 =================
{
  const { Game: G } = makeGame(1, false);
  const open = () => { G.gameMode = 'advanced'; G.isDailyMode = () => false; G.rulesConfig = {}; G.ruleRequiresKaimen = G.ruleRequiresPeng = G.ruleRequiresYaojiu = () => false; G.ruleRequiresSanmenqi = () => !!G.rulesConfig.mustSanmenqi; G.ruleDragonsPairAsPeng = () => true; G.ruleAllowsSevenPairs = () => !!G.rulesConfig.sevenPairs; };
  open();
  const prep = () => { G.hands.top = []; G.exposedMelds.top = []; G.discardPile = []; G.deck = Array(60).fill('1万'); };
  const T = s => s.split(' ');
  prep();
  // 听 2/5/8万 三张：旧版读成「单钓」（把听口数当成读法数），应为多面听
  let c = G.classifyWait(T('2万 3万 4万 5万 6万 7万 8万 1条 2条 3条 7条 7条 7条'), [], 'top');
  assert.deepStrictEqual(Array.from(c.tiles).sort(), ['2万', '5万', '8万']); assert.strictEqual(c.type, 'multi', '三张听口 = 多面听：' + c.type);
  c = G.classifyWait(T('3万 4万 5万 6万 6万 7万 7万 7万 8万 8万 9万 2筒 2筒'), [], 'top');
  assert.strictEqual(c.tiles.length, 3); assert.strictEqual(c.type, 'multi', '旧版误判为两面：' + c.type);
  // 只听 3条 一张：同一张牌在不同拆法里读法不止一种，不能因此判成「多面听」（系数最高）
  c = G.classifyWait(T('9万 9万 9万 1条 1条 2条 2条 3条 4条 4条 9条 9条 9条'), [], 'top');
  assert.deepStrictEqual(Array.from(c.tiles), ['3条']); assert.notStrictEqual(c.type, 'multi', '单张听口不是多面听');
  assert(G.waitQuality(T('9万 9万 9万 1条 1条 2条 2条 3条 4条 4条 9条 9条 9条'), [], 'top').coeff < 1.1);
  // 六对子 + 单张：只有规则允许七小对时才按单钓
  const six = T('5万 5万 6万 6万 7万 7万 7条 7条 8条 9条 9条 9筒 9筒');
  c = G.classifyWait(six, [], 'top');
  assert.notStrictEqual(c.type, 'tanki', '规则不允许七小对：不按七小对单钓（旧版误判）');
  G.rulesConfig = { sevenPairs: true };
  c = G.classifyWait(six, [], 'top'); assert.strictEqual(c.type, 'tanki', '允许七小对且只听那一张：单钓');
  // 缓存键含规则：同一手牌换规则后重新分类，不读旧结果
  open(); prep();
  const h = T('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 5万 5万');
  G.rulesConfig = { mustSanmenqi: true };
  assert.strictEqual(G.classifyWait(h, [], 'top').tiles.length, 0, '要求三门齐时（只有万条两门）不听');
  G.rulesConfig = { mustSanmenqi: false };
  assert.deepStrictEqual(Array.from(G.classifyWait(h, [], 'top').tiles), ['3条'], '放开规则后应听 3条（旧版缓存未含规则，会读到旧结果）');
  // 不变量（随机）：听口 ≥3 张必为多面；1 张必不是多面
  let seed = 99; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296; const suits = ['万', '条', '筒'];
  let checked = 0;
  for (let it = 0; it < 60000 && checked < 300; it++) {
    const hand = [], cnt = {}; let ok = true;
    const add = t => { cnt[t] = (cnt[t] || 0) + 1; if (cnt[t] > 4) ok = false; hand.push(t); };
    for (let m = 0; m < 4; m++) { const su = suits[Math.floor(rnd() * 3)]; if (rnd() < 0.4) { const t = (1 + Math.floor(rnd() * 9)) + su; add(t); add(t); add(t); } else { const r = 1 + Math.floor(rnd() * 7); add(r + su); add((r + 1) + su); add((r + 2) + su); } }
    const pt = (1 + Math.floor(rnd() * 9)) + suits[Math.floor(rnd() * 3)]; add(pt); add(pt);
    if (!ok) continue; hand.splice(Math.floor(rnd() * 14), 1);
    prep(); G.rulesConfig = {};
    const k = G.classifyWait(hand, [], 'top'); if (!k.tiles.length) continue; checked++;
    if (k.tiles.length >= 3) assert.strictEqual(k.type, 'multi', hand.join(' ') + ' → ' + k.type);
    if (k.tiles.length === 1) assert.notStrictEqual(k.type, 'multi', hand.join(' '));
  }
  assert(checked >= 100, '随机听牌样本不足 ' + checked);
}

// ================= 3. 旧版存档兼容 =================
{
  // AI 学习数据：旧版（单数字）、脏数据（字符串/超界/非有限）都不得毒化
  let { Game: G } = loadCore({ [AI_KEY]: JSON.stringify({ games: 5, confidence: { conservative: 2, aggressive: -1, shrewd: 0 } }) }, ['js/01-globals-state.js']);
  assert.strictEqual(G.aiLearn.games, 5);
  for (const st of ['conservative', 'aggressive', 'shrewd']) for (const v of Object.values(G.aiLearn.confidence[st])) assert.strictEqual(v, 0, '旧版单数字置零重学');
  ({ Game: G } = loadCore({ [AI_KEY]: '{"games":"7","confidence":{"conservative":{"callAggr":"x","defense":99,"position":null,"wallCaution":-99},"shrewd":{"defense":1e999}}}' }, ['js/01-globals-state.js']));
  assert.strictEqual(G.aiLearn.games, 0, '字符串局数视为 0');
  assert.strictEqual(G.aiLearn.confidence.conservative.callAggr, 0); assert.strictEqual(G.aiLearn.confidence.conservative.defense, 3, '超界夹到 ±3');
  assert.strictEqual(G.aiLearn.confidence.conservative.wallCaution, -3); assert.strictEqual(G.aiLearn.confidence.shrewd.defense, 0, 'Infinity 视为 0');
  ({ Game: G } = loadCore({ [AI_KEY]: '{坏json' }, ['js/01-globals-state.js'])); assert.strictEqual(G.aiLearn.games, 0, '损坏 JSON 用默认值');
  ({ Game: G } = loadCore({}, ['js/01-globals-state.js'])); assert.strictEqual(G.aiLearn.games, 0);

  // 对局存档
  const core = loadCore({}, ['js/01-globals-state.js', 'js/06-tiles-utils.js']);
  G = core.Game;
  G.buildDeck();
  const deck = G.deck.slice();
  const snap = () => ({ v: 2, scores: { top: 10, left: -10, right: 0, bottom: 5 }, dealer: 'right', currentIndex: 1, gameOver: false, winner: null,
    deck: deck.slice(52), hands: { top: deck.slice(0, 13), left: deck.slice(13, 26), right: deck.slice(26, 39), bottom: deck.slice(39, 52) },
    exposedMelds: { top: [], left: [], right: [], bottom: [] }, discardPile: [] });
  G.scores = { top: 0, left: 0, right: 0, bottom: 0 }; G.dealer = 'bottom';
  const before = G.hands;
  assert.strictEqual(G.loadGameProgress(snap()), true, '合法 v2 存档应读入');
  assert.strictEqual(G.hands.top.length, 13); assert.strictEqual(G.dealer, 'right'); assert.strictEqual(G.scores.top, 10);
  // 旧版（无 v / v1）：不恢复牌面，但跨局的分数/庄家照旧恢复（既有行为）
  G.scores = { top: 0, left: 0, right: 0, bottom: 0 }; G.dealer = 'bottom'; let h0 = G.hands;
  const v1 = snap(); delete v1.v;
  assert.strictEqual(G.loadGameProgress(v1), false); assert.strictEqual(G.hands, h0); assert.strictEqual(G.scores.top, 10, '旧存档的分数仍恢复'); assert.strictEqual(G.dealer, 'right');
  // 分数里的非有限数不得写入（旧：typeof NaN === number）
  G.scores = { top: 1, left: 2, right: 3, bottom: 4 };
  const bad = snap(); bad.v = 1; bad.scores = { top: 1e999, left: -1e999, right: 'x', bottom: 7 };
  G.loadGameProgress(bad);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G.scores)), { top: 1, left: 2, right: 3, bottom: 7 });
  // 牌面损坏：五张同牌 / 未知牌码 / 缺字段 → 放弃牌面，状态不被半恢复
  h0 = G.hands;
  const five = snap(); five.hands.top[0] = five.hands.left[0] = five.hands.right[0] = five.hands.bottom[0] = five.deck[0] = five.hands.top[1]; five.hands.top[2] = five.hands.top[1];
  const mutate = [s => { s.hands.top[3] = '99万'; }, s => { delete s.exposedMelds.top; }, s => { s.currentIndex = 9; }, s => { s.discardPile = [{ tile: '1万', player: 'zzz' }]; }];
  for (const m of mutate) { const s = snap(); m(s); assert.strictEqual(G.loadGameProgress(s), false); assert.strictEqual(G.hands, h0, '校验失败不得半恢复'); }
  const dup = snap(); for (let i = 0; i < 5; i++) dup.hands.top[i] = '1万'; // 5 张 1万（外加别处的）
  assert.strictEqual(G.loadGameProgress(dup), false);
  assert.strictEqual(G.loadGameProgress(null), false); assert.strictEqual(G.loadGameProgress('x'), false);
}

// ================= 4. 结算弹窗：网络来的文本转义 =================
{
  const els = {}; const el = id => els[id] || (els[id] = { id, innerHTML: '', innerText: '', textContent: '', style: {}, classList: { add() {}, remove() {}, contains: () => false }, dataset: {} });
  const ctx = { window: { addEventListener() {} }, document: { getElementById: () => null, querySelector: () => null, readyState: 'complete', addEventListener() {} }, console: quiet, Promise, Object, Array, Date, Number, String, JSON, Math, Set, Map, RegExp, setTimeout, clearTimeout };
  const Game = { turnOrder: ['bottom', 'right', 'top', 'left'], PHASE: { SETTLING: 's' }, setPhase() {}, sfx: { win() {} }, feel: { banner() {} }, $: el, tileCompare: (a, b) => (a < b ? -1 : 1),
    tileImg: t => '<img src="tiles/x.webp">', renderMeldGroup: () => '', flushSaveProgress() {}, hands: { top: ['1万'], left: [], right: [], bottom: [] }, exposedMelds: { top: [], left: [], right: [], bottom: [] } };
  ctx.Game = Game; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/09-turn-settlement.js'), 'utf8'), ctx, { filename: '09' });
  const evilTag = '<img src=x onerror=alert(1)>"\'&';
  Game.showResultModal('top', 'selfdraw', null, { mult: 1, tags: [] },
    { tags: ['自摸×2', evilTag], payouts: { top: 6, left: -2, right: '<b>x</b>', bottom: NaN }, total: '<i>', noKaimenPlayers: [] }, '1万');
  const lines = els['result-score-lines'].innerHTML;
  assert(!/<img|onerror=alert\(1\)>/.test(lines.replace(/&lt;img[^]*?&gt;/g, '')) && !lines.includes('<img src=x'), '标签必须转义：' + lines);
  assert(lines.includes('&lt;img') && lines.includes('自摸 ×2'), '正常标签原样显示（×前补空格是原行为）');
  const pay = els['result-payouts'].innerHTML + els['result-payouts-edit'].innerHTML;
  assert(!/<b>x|<i>|NaN/.test(pay), '非数字 payouts 不得进入 HTML：' + pay);
}

console.log('regression-engine-458: all cases passed');
process.exit(0);
