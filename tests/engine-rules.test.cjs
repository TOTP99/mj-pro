#!/usr/bin/env node
'use strict';
// 单机引擎规则差分测试：胡牌判定（日常/高阶全部开关组合）对照独立参考实现；
// 计分不变量：零和、倍数与标签一致、取最优分解、单吊/边张/夹张只在唯一听法算。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const SUITS = ['万', '条', '筒'];
const PLAYERS = ['top', 'left', 'right', 'bottom'];
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const ri = n => Math.floor(rnd() * n);

function makeGame() {
  const order = { '万': 0, '条': 1, '筒': 2, '字': 3 };
  const Game = { suits: SUITS, honors: ['东', '南', '西', '北', '中', '发', '白'], PLAYERS, turnOrder: ['bottom', 'right', 'top', 'left'],
    tileSuit: t => t.slice(-1), tileRank: t => parseInt(t, 10), tileCompare: (a, b) => order[a.slice(-1)] - order[b.slice(-1)] || parseInt(a, 10) - parseInt(b, 10),
    windDragonBonus: { top: false, left: false, right: false, bottom: false },
    exposedMelds: { top: [], left: [], right: [], bottom: [] }, scores: { top: 0, left: 0, right: 0, bottom: 0 }, dealer: 'bottom',
    gameMode: 'daily', rulesConfig: {}, nameOf: p => p, afterKongDrawPlayer: null, afterKongDiscardPlayer: null };
  const ctx = vm.createContext({ Game, console, Math, Number, Object, Array, Set, Map, JSON, Date });
  for (const f of ['js/07-hu-detection.js', 'js/02-scoring.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  const cfg = () => Game.rulesConfig, daily = () => Game.gameMode !== 'advanced';
  Game.isDailyMode = daily;
  Game.ruleRequiresKaimen = () => daily() || !!cfg().mustKaimen; Game.ruleRequiresPeng = () => daily() || !!cfg().mustPeng;
  Game.ruleDragonsPairAsPeng = () => daily() || !!cfg().dragonsAsPeng; Game.ruleRequiresYaojiu = () => daily() || !!cfg().mustYaojiu;
  Game.ruleRequiresSanmenqi = () => daily() || !!cfg().mustSanmenqi; Game.ruleAllowsSevenPairs = () => !daily() && !!cfg().sevenPairs;
  return Game;
}
const G = makeGame();

// ---------- 独立参考实现 ----------
const allTypes = []; for (const s of SUITS) for (let r = 1; r <= 9; r++) allTypes.push(r + s); for (let r = 1; r <= 7; r++) allTypes.push(r + '字');
const idx = t => allTypes.indexOf(t);
/** 返回所有"4-k 组面子 + 1 对将"的拆法：[{pair, sets:[['t',n]/['s',start]]}] */
function refDecomps(tiles, need) {
  const cnt = new Array(34).fill(0); tiles.forEach(t => cnt[idx(t)]++);
  const out = [];
  function sets(c, left, acc, from) {
    if (left === 0) { if (c.every(x => x === 0)) out.push(acc.slice()); return; }
    for (let i = from; i < 34; i++) {
      if (c[i] === 0) continue;
      if (c[i] >= 3) { c[i] -= 3; acc.push(['t', i]); sets(c, left - 1, acc, i); acc.pop(); c[i] += 3; }
      if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) { c[i]--; c[i + 1]--; c[i + 2]--; acc.push(['s', i]); sets(c, left - 1, acc, i); acc.pop(); c[i]++; c[i + 1]++; c[i + 2]++; }
      return; // 最小的牌必须先被用掉
    }
  }
  for (let p = 0; p < 34; p++) {
    if (cnt[p] < 2) continue;
    cnt[p] -= 2; const before = out.length;
    const tmp = []; const save = out.length; sets(cnt, need, [], 0);
    for (let k = save; k < out.length; k++) out[k] = { pair: p, sets: out[k] };
    cnt[p] += 2;
  }
  return out;
}
function refHu(concealed, exposed, player, flags, seven) {
  if (seven && concealed.length === 14) { const c = {}; concealed.forEach(t => c[t] = (c[t] || 0) + 1); if (Object.values(c).every(v => v === 2)) return true; }
  const need = 4 - exposed.length;
  if (concealed.length !== need * 3 + 2) return false;
  const ds = refDecomps(concealed, need); if (!ds.length) return false;
  const all = concealed.concat(...exposed.map(m => m.tiles));
  const bonus = player && G.windDragonBonus[player];
  const kaimen = exposed.some(m => m.type === 'peng' || m.type === 'chi' || (m.type === 'gang' && !m.concealed));
  const yao = bonus || all.some(t => t.endsWith('字') || parseInt(t) === 1 || parseInt(t) === 9);
  const san = new Set(all.filter(t => !t.endsWith('字')).map(t => t.slice(-1))).size === 3;
  const exKezi = exposed.some(m => ['peng', 'gang', 'dragons', 'winds'].includes(m.type));
  const kezi = bonus || exKezi || ds.some(d => d.sets.some(s => s[0] === 't') || (flags.dragonsAsPeng && d.pair >= 31 && d.pair <= 33));
  return (!flags.mustKaimen || kaimen) && (!flags.mustYaojiu || yao) && (!flags.mustSanmenqi || san) && (!flags.mustPeng || kezi);
}

// ---------- 随机手牌生成 ----------
function randExposed(k) {
  const out = [];
  for (let i = 0; i < k; i++) {
    const kind = ri(6);
    if (kind === 0) { const t = allTypes[ri(34)]; out.push({ type: 'peng', tiles: [t, t, t] }); }
    else if (kind === 1) { const t = allTypes[ri(34)]; out.push({ type: 'gang', tiles: [t, t, t, t], concealed: rnd() < 0.5 }); }
    else if (kind === 2 || kind === 3) { const s = SUITS[ri(3)], r = 1 + ri(7); out.push({ type: 'chi', tiles: [r + s, (r + 1) + s, (r + 2) + s] }); }
    else if (kind === 4) out.push({ type: 'dragons', tiles: ['5字', '6字', '7字'] });
    else out.push({ type: 'winds', tiles: ['1字', '2字', '3字', '4字'] });
  }
  return out;
}
function randConcealed(need, exposed) {
  const tiles = [];
  if (rnd() < 0.7) { // 构造一手完整牌再随机换牌
    tiles.push(...Array(2).fill(allTypes[ri(34)]));
    for (let i = 0; i < need; i++) {
      if (rnd() < 0.4) { const t = allTypes[ri(34)]; tiles.push(t, t, t); }
      else { const s = SUITS[ri(3)], r = 1 + ri(7); tiles.push(r + s, (r + 1) + s, (r + 2) + s); }
    }
    if (rnd() < 0.3) tiles[ri(tiles.length)] = allTypes[ri(34)];
  } else { for (let i = 0; i < need * 3 + 2; i++) tiles.push(allTypes[ri(34)]); }
  return tiles.sort(G.tileCompare);
}
function legal(concealed, exposed) {
  const c = {}; concealed.concat(...exposed.map(m => m.tiles)).forEach(t => c[t] = (c[t] || 0) + 1);
  return Object.values(c).every(v => v <= 4);
}
function seven() { const ts = []; const pool = allTypes.slice().sort(() => rnd() - 0.5).slice(0, 7); pool.forEach(t => ts.push(t, t)); return ts.sort(G.tileCompare); }

// ---------- 1. 胡牌判定差分 ----------
let n = 0, wins = 0;
for (let it = 0; it < 120000; it++) {
  const k = ri(4), exposed = randExposed(k), need = 4 - k;
  let concealed = randConcealed(need, exposed), isSeven = false;
  if (rnd() < 0.05) { concealed = seven(); exposed.length = 0; isSeven = true; }
  if (!legal(concealed, exposed)) continue;
  const adv = rnd() < 0.7;
  const flags = adv ? { mustKaimen: rnd() < 0.7, mustPeng: rnd() < 0.7, dragonsAsPeng: rnd() < 0.7, mustYaojiu: rnd() < 0.7, mustSanmenqi: rnd() < 0.7, sevenPairs: rnd() < 0.5 }
    : { mustKaimen: true, mustPeng: true, dragonsAsPeng: true, mustYaojiu: true, mustSanmenqi: true, sevenPairs: false };
  G.gameMode = adv ? 'advanced' : 'daily'; G.rulesConfig = flags;
  const player = ri(4) === 0 ? PLAYERS[ri(4)] : null;
  PLAYERS.forEach(p => G.windDragonBonus[p] = false); if (player) G.windDragonBonus[player] = rnd() < 0.5;
  const got = G.checkHu(concealed, exposed, player);
  const want = refHu(concealed, exposed, player, flags, adv && flags.sevenPairs);
  n++; if (want) wins++;
  assert.strictEqual(got, want, `胡牌判定不一致 got=${got} want=${want} mode=${G.gameMode} flags=${JSON.stringify(flags)} player=${player}/${player && G.windDragonBonus[player]}\n暗牌=${concealed.join(',')}\n副露=${JSON.stringify(exposed)}`);
}
assert(wins > 2000, '随机样本里胡牌数太少，测试无意义：' + wins);

// ---------- 2. 计分不变量 ----------
G.gameMode = 'daily'; G.rulesConfig = {};
let scored = 0;
function refBest(concealedAll, exposed) { // 独立计算：每个分解的倍数，取最大（忽略单吊等待番，另测）
  return null;
}
for (let it = 0; it < 60000 && scored < 6000; it++) {
  const k = ri(4), exposed = randExposed(k), concealed = randConcealed(4 - k, exposed);
  if (!legal(concealed, exposed)) continue;
  PLAYERS.forEach(p => G.windDragonBonus[p] = false);
  if (!G.checkHu(concealed, exposed, null)) continue;
  const winTile = concealed[ri(concealed.length)];
  const before = concealed.slice(); before.splice(before.indexOf(winTile), 1);
  const last = rnd() < 0.15;
  const bonus = G.scoreWinningHand(before, winTile, exposed, last);
  assert(bonus.mult >= 1 && Number.isInteger(bonus.mult), '倍数应为正整数');
  // 标签与倍数一致：每个标签×N 的乘积 == mult
  let prod = 1; bonus.tags.forEach(t => { const m = /×(\d+)/.exec(t); if (m) prod *= +m[1]; });
  assert.strictEqual(prod, bonus.mult, `标签乘积与倍数不符 ${bonus.tags} vs ${bonus.mult}`);
  // 零和
  const winner = PLAYERS[ri(4)], mode = rnd() < 0.5 ? 'selfdraw' : 'dianpao';
  let payer = null; if (mode === 'dianpao') { do payer = PLAYERS[ri(4)]; while (payer === winner); }
  G.dealer = PLAYERS[ri(4)];
  PLAYERS.forEach(p => { G.exposedMelds[p] = p === winner ? exposed : randExposed(ri(3)); G.scores[p] = 0; });
  G.afterKongDrawPlayer = rnd() < 0.2 ? winner : null; G.afterKongDiscardPlayer = payer && rnd() < 0.2 ? payer : null;
  const b2 = { mult: bonus.mult, tags: bonus.tags.slice() }; G.applyKongBonuses(b2, winner, mode, payer);
  const res = G.settleScore(winner, mode, payer, b2);
  const sum = PLAYERS.reduce((s, p) => s + res.payouts[p], 0);
  assert.strictEqual(sum, 0, `不零和 ${JSON.stringify(res.payouts)}`);
  assert(res.payouts[winner] > 0 && res.total === res.payouts[winner], '赢家应为正且等于 total');
  assert(PLAYERS.every(p => G.scores[p] === res.payouts[p]), '总分应等于本局收支');
  if (mode === 'dianpao') assert(PLAYERS.every(p => p === winner || p === payer ? true : res.payouts[p] === 0), '点炮只涉及点炮者');
  else assert(PLAYERS.every(p => p === winner || res.payouts[p] < 0), '自摸三家都应付钱');
  scored++;
}
assert(scored >= 3000, '计分样本不足 ' + scored);

// ---------- 2b. 倍数差分：独立实现"逐分解算倍数取最大" ----------
function refMult(before, winTile, exposed, last, owner) {
  const all = before.concat([winTile]);
  const need = 4 - exposed.length;
  const ds = refDecomps(all, need);
  // 唯一听法：胡牌前每种牌补一张能否胡
  const cnt = t => before.filter(x => x === t).length + exposed.reduce((n, m) => n + m.tiles.filter(x => x === t).length, 0);
  const wins = allTypes.filter(t => cnt(t) < 4 && G.checkHu(before.concat([t]), exposed, owner)).length;
  const unique = wins <= 1;
  const dragons = ['5字', '6字', '7字'];
  let best = 0;
  for (const d of ds) {
    const sets = d.sets.map(x => x[0] === 't' ? { type: 't', tile: allTypes[x[1]] } : { type: 's', start: x[1], tiles: [allTypes[x[1]], allTypes[x[1] + 1], allTypes[x[1] + 2]] });
    let wait = 'normal';
    if (unique) {
      if (allTypes[d.pair] === winTile) wait = 'tanki';
      else for (const m of sets) {
        if (m.type !== 's' || !m.tiles.includes(winTile)) continue;
        const r0 = (m.start % 9) + 1, wi = m.tiles.indexOf(winTile);
        let c = 'normal';
        if (wi === 1) c = 'kanchan'; else if ((wi === 0 && r0 + 2 === 9) || (wi === 2 && r0 === 1)) c = 'bian';
        if (c !== 'normal' && wait === 'normal') wait = c;
      }
    }
    let mult = 1;
    if (sets.every(m => m.type === 't') && exposed.every(m => m.type === 'peng' || m.type === 'gang')) mult *= 8;
    if (sets.some(m => m.type === 't' && dragons.includes(m.tile)) || exposed.some(m => ((m.type === 'peng' || m.type === 'gang') && dragons.includes(m.tiles[0])) || m.type === 'dragons')) mult *= 2;
    if (wait !== 'normal') mult *= 2;
    if (last) mult *= 2;
    // 四归一
    const trip = {}, seq = {};
    sets.forEach(m => { if (m.type === 't') trip[m.tile] = (trip[m.tile] || 0) + 3; else m.tiles.forEach(t => seq[t] = (seq[t] || 0) + 1); });
    exposed.forEach(m => { if (m.type === 'peng' || m.type === 'gang') trip[m.tiles[0]] = (trip[m.tiles[0]] || 0) + 3; if (m.type === 'chi') m.tiles.forEach(t => seq[t] = (seq[t] || 0) + 1); });
    if (Object.keys(trip).some(t => trip[t] >= 3 && seq[t] >= 1)) mult *= 2;
    exposed.forEach(m => { if (m.type === 'gang') mult *= m.concealed ? 4 : 2; });
    if (mult > best) best = mult;
  }
  return best;
}
let multChecked = 0;
for (let it = 0; it < 80000 && multChecked < 8000; it++) {
  const k = ri(4), exposed = randExposed(k), concealed = randConcealed(4 - k, exposed);
  if (!legal(concealed, exposed)) continue;
  PLAYERS.forEach(p => { G.windDragonBonus[p] = false; G.exposedMelds[p] = []; });
  const owner = PLAYERS[ri(4)]; G.exposedMelds[owner] = exposed; // scoreWinningHand 靠引用找到玩家
  if (!G.checkHu(concealed, exposed, owner)) continue;
  const winTile = concealed[ri(concealed.length)];
  const before = concealed.slice(); before.splice(before.indexOf(winTile), 1);
  const last = rnd() < 0.2;
  const got = G.scoreWinningHand(before, winTile, exposed, last).mult;
  const want = refMult(before, winTile, exposed, last, owner);
  assert.strictEqual(got, want, `倍数不一致 got=${got} want=${want}\n暗牌(含和牌)=${concealed.join(',')} 和=${winTile} 副露=${JSON.stringify(exposed)} 海底=${last}`);
  multChecked++;
}
assert(multChecked >= 4000, '倍数样本不足 ' + multChecked);

// ---------- 3. 具体番型用例（人工核对过的期望值） ----------
G.gameMode = 'daily'; PLAYERS.forEach(p => G.windDragonBonus[p] = false);
const S = (t, e, w, last) => G.scoreWinningHand(t, w, e, last);
// 碰碰胡 ×8：碰1万 碰1条 碰1筒 + 手里 2字2字2字(暗刻)+ 对将9万；赢牌 9万 → 单吊
let b = S(['2字', '2字', '2字', '9万'], [{ type: 'peng', tiles: ['1万', '1万', '1万'] }, { type: 'peng', tiles: ['1条', '1条', '1条'] }, { type: 'peng', tiles: ['1筒', '1筒', '1筒'] }], '9万', false);
assert(b.tags.includes('碰碰胡×8') && b.tags.includes('单吊×2') && b.mult === 16, '碰碰胡+单吊 应为 16：' + JSON.stringify(b));
// 中发白刻 + 海底
b = S(['5字', '5字', '5字', '2万', '3万', '4万', '5条', '6条', '7条', '9筒'], [{ type: 'peng', tiles: ['1筒', '1筒', '1筒'] }].slice(0, 0), '9筒', true);
assert(b.mult >= 1);
// 暗杠×4、明杠×2、不同杠叠乘
b = S(['2万', '3万', '4万', '9筒'], [{ type: 'gang', tiles: ['5条', '5条', '5条', '5条'], concealed: true }, { type: 'gang', tiles: ['6条', '6条', '6条', '6条'], concealed: false }, { type: 'peng', tiles: ['1筒', '1筒', '1筒'] }], '9筒', false);
assert(b.tags.includes('暗杠×4') && b.tags.includes('明杠×2'), '暗杠/明杠标签');
assert.strictEqual(b.mult, 4 * 2 * 2, '杠叠乘 + 单吊：' + JSON.stringify(b));
// 零钱：自摸闷三家
G.dealer = 'top'; PLAYERS.forEach(p => { G.scores[p] = 0; G.exposedMelds[p] = []; });
G.exposedMelds.bottom = [{ type: 'peng', tiles: ['1万', '1万', '1万'] }];
let r = G.settleScore('bottom', 'selfdraw', null, { mult: 1, tags: [] });
assert(r.tags.includes('闷三家') && r.noKaimenPlayers.length === 3);
assert.deepStrictEqual(JSON.parse(JSON.stringify(r.payouts)), { top: -(1 * 2 * 2 * 2), left: -(1 * 2 * 2), right: -(1 * 2 * 2), bottom: 4 + 4 + 8 }.top === -8 ? { top: -8, left: -4, right: -4, bottom: 16 } : null, '自摸：mult=自摸×2=2，庄家再×2，没开门再×2：庄付8，其余各付4');
console.log(`engine rules tests passed（胡牌差分 ${n} 例，其中可胡 ${wins}；计分不变量 ${scored} 例；倍数差分 ${multChecked} 例）`);
