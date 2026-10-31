#!/usr/bin/env node
'use strict';
// Headless self-play harness. Uses the project's actual shanten, discard EV,
// danger model, hu detection and scoring modules; only the browser scheduler/UI
// is replaced by a deterministic turn loop.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const MODULES = [
  'js/07-hu-detection.js',
  'js/10-ai-shanten-bench.js',
  'js/02-scoring.js',
  'js/11-ai-discard-claim.js',
  'js/19-ai-efficiency.js',
  'js/20-ai-danger-ev.js'
];
const ADAPTIVE = 'js/22-ai-adaptive.js';
const PLAYERS = ['bottom', 'right', 'top', 'left'];
const STYLES = { top: 'shrewd', left: 'conservative', right: 'aggressive', bottom: 'shrewd' };
const DEAD_WALL = 16;
const SUITS = ['万', '条', '筒'];
const HONORS = ['东', '南', '西', '北', '中', '发', '白'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}
function makeDeck(random) {
  const d = [];
  for (const suit of SUITS) for (let rank = 1; rank <= 9; rank++) for (let n = 0; n < 4; n++) d.push(`${rank}${suit}`);
  for (let rank = 1; rank <= 7; rank++) for (let n = 0; n < 4; n++) d.push(`${rank}字`);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function makeGame(seed, adaptive, root) {
  root = root || ROOT; // 对照臂可指向另一份项目目录（如修改前的版本）
  const aiRandom = rng((seed ^ 0x9e3779b9) >>> 0);
  const math = Object.create(Math); math.random = aiRandom;
  const Game = {
    suits: SUITS, honors: HONORS, turnOrder: PLAYERS.slice(), PLAYERS: ['top','left','right','bottom'],
    hands: { top: [], left: [], right: [], bottom: [] },
    exposedMelds: { top: [], left: [], right: [], bottom: [] },
    discardPile: [], deck: [], scores: { top: 0, left: 0, right: 0, bottom: 0 },
    windDragonBonus: { top: false, left: false, right: false, bottom: false },
    aiWaitTiles: { top: [], left: [], right: [], bottom: [] },
    aiPersonality: { ...STYLES }, aiLearn: { games: 0, confidence: { conservative: {}, aggressive: {}, shrewd: {} }, samples: {} },
    aiAxisUsed: { top: new Set(), left: new Set(), right: new Set() },
    dealer: 'bottom', gameOver: false, winner: null, gameMode: 'daily',
    rulesConfig: { mustYaojiu: true, mustSanmenqi: true, mustPeng: true, mustKaimen: true },
    firstTurnPending: { top: false, left: false, right: false, bottom: false },
    lastDrawnTile: { top: null, left: null, right: null, bottom: null },
    lastDrawWasFinal: { top: false, left: false, right: false, bottom: false },
    lastCallTurn: { top: -1, left: -1, right: -1, bottom: -1 },
    afterKongDrawPlayer: null, afterKongDiscardPlayer: null,
    DEAD_WALL, handTurnCount: 0, flowLog: [],
    isDailyMode: () => true, ruleAllowsSevenPairs: () => false,
    ruleRequiresKaimen: () => true, ruleRequiresPeng: () => true,
    ruleDragonsPairAsPeng: () => true, ruleRequiresYaojiu: () => true,
    ruleRequiresSanmenqi: () => true,
    tileSuit: t => t.slice(-1), tileRank: t => parseInt(t, 10),
    tileCompare(a,b) { const o={'万':0,'条':1,'筒':2,'字':3}; return o[a.slice(-1)]-o[b.slice(-1)] || parseInt(a,10)-parseInt(b,10); },
    nameOf: p => p, logFlow() {}, speak() {}, requestRender() {},
    sfx: { discard(){}, draw(){}, gang(){}, peng(){}, chi(){} },
    feel: { banner(){}, flyAiDiscard(){} }, setPhase() {}, markAxisUsed() {}, trackAiCall() {},
    onFieldGameSettled() {}, learnFromWin() {}, learnFromDraw() {}, showResultModal() {},
    hideIndicator() {}, showIndicator() {}, aiThinkMs: () => 0, scheduleAi: fn => fn(),
    markDealer() {}, resetFlowLog() {}, resetAiAxisUsed() {}, resetLastCallTurn() {}, snapshotRankAtDeal() {},
    validateHandCounts() { return true; }, markKongDraw() {}, clearKongFlags() {}, applyKongBonuses(b) { return b; },
    isKaimen(ex) { return ex.some(m => m.type === 'peng' || m.type === 'chi' || (m.type === 'gang' && !m.concealed)); },
    getAiAdaptiveContext: null
  };
  const context = vm.createContext({ Game, console: { log(){}, warn(){}, error(){} }, Math: math,
    Number, Object, Array, Set, Map, JSON, Date, localStorage: { getItem(){return null}, setItem(){} },
    window: { addEventListener(){} }, document: { addEventListener(){}, getElementById(){return null}, readyState:'complete' },
    Image: function(){}, setTimeout(fn){ fn(); return 1; }, clearTimeout(){} });
  for (const file of MODULES) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  if (adaptive) vm.runInContext(fs.readFileSync(path.join(root, ADAPTIVE), 'utf8'), context, { filename: ADAPTIVE });

  // The app's utility methods normally live in globals/state and turn settlement.
  Game.hasReplacementSlot = () => Array.isArray(Game.deck) && Game.deck.length > DEAD_WALL; // 同 08-game-flow-core.js
  Game.canPeng = (hand, tile) => hand.filter(t => t === tile).length >= 2;
  Game.canGang = (hand, tile) => hand.filter(t => t === tile).length >= 3;
  Game.findChiCombos = (hand, tile) => {
    if (Game.tileSuit(tile) === '字') return [];
    const rank = Game.tileRank(tile), suit = Game.tileSuit(tile), out = [];
    for (const start of [rank-2, rank-1, rank]) {
      if (start < 1 || start > 7) continue;
      const need = [start, start+1, start+2].filter(r => r !== rank).map(r => `${r}${suit}`);
      if (need.every(t => hand.includes(t))) out.push(need);
    }
    return out;
  };
  Game.TileFlow = {
    discard(p,t) { const i=Game.hands[p].indexOf(t); if(i<0) return false; Game.hands[p].splice(i,1); Game.discardPile.push({player:p,tile:t}); return true; },
    claim(p,type,tiles,combo,opts) {
      const entry=Game.discardPile[Game.discardPile.length-1]; if(!entry) return false;
      for(const t of tiles){const i=Game.hands[p].indexOf(t);if(i<0)return false;Game.hands[p].splice(i,1);}
      Game.discardPile.pop();
      const meldTiles = type==='chi' ? [...tiles,entry.tile].sort(Game.tileCompare) : Array(type==='gang'?4:3).fill(entry.tile);
      Game.exposedMelds[p].push({type,tiles:meldTiles,concealed:!!(opts&&opts.concealed)});
      return true;
    }
  };
  return { Game, context, adaptive, seed };
}

function assertConservation(G, handNo, step) {
  const all = [...G.deck];
  for (const p of PLAYERS) { all.push(...G.hands[p]); for (const m of G.exposedMelds[p]) all.push(...m.tiles); }
  for (const d of G.discardPile) all.push(d.tile);
  assert.strictEqual(all.length, 136, `tile count ${all.length} at hand ${handNo}, step ${step}`);
  const counts = new Map(); for (const t of all) counts.set(t, (counts.get(t)||0)+1);
  for (const [t,n] of counts) assert(n <= 4, `more than four copies of ${t} at hand ${handNo}, step ${step}`);
}
function handStats(G, result, winMode) {
  result.hands++;
  result.wins += winMode ? 1 : 0;
  if (winMode === 'selfdraw') result.selfDraws++;
  if (winMode === 'ron') result.rons++;
  result.draws += winMode ? 0 : 1;
  result.scoreDelta += Object.values(G.scores).reduce((a,b)=>a+b,0) - result.scoreSumStart;
  if (G.winner) result.winnerCounts[G.winner]++;
  result.dealIns += G.lastPayer ? 1 : 0;
  result.rounds.push({ winner: G.winner || null, mode: winMode || 'draw', payer: G.lastPayer || null, turns: G.handTurnCount, scores: { ...G.scores } });
}
function simulateHand(G, handNo, maxSteps=500) {
  G.hands = {top:[],left:[],right:[],bottom:[]}; G.exposedMelds = {top:[],left:[],right:[],bottom:[]};
  G.discardPile=[]; G.deck=makeDeck(rng((G._deckSeed + handNo*0x45d9f3b)>>>0));
  G.gameOver=false; G.winner=null; G.lastPayer=null; G.handTurnCount=0; G._calls={chi:0,peng:0,gang:0,selfGang:0};
  G.aiWaitTiles={top:[],left:[],right:[],bottom:[]}; G.afterKongDrawPlayer=null; G.afterKongDiscardPlayer=null;
  // 13 each; the dealer's first turn draws the 14th tile.
  for (let n=0;n<13;n++) for (const p of PLAYERS) G.hands[p].push(G.deck.pop());
  for (const p of PLAYERS) G.hands[p].sort(G.tileCompare);
  let current=PLAYERS.indexOf(G.dealer), steps=0, winnerMode=null;
  assertConservation(G,handNo,steps);
  const scoreBefore={...G.scores};
  function finish(winner, mode, payer, tile, isLast=false) {
    G.gameOver=true; G.winner=winner; G.lastPayer=payer||null; winnerMode=mode;
    const before = G.hands[winner].slice();
    if (mode === 'selfdraw') { const wi = before.indexOf(tile); if (wi >= 0) before.splice(wi, 1); }
    const bonus = G.scoreWinningHand(before, tile, G.exposedMelds[winner], isLast);
    G.applyKongBonuses(bonus,winner,mode==='selfdraw'?'selfdraw':'dianpao',payer);
    G.settleScore(winner,mode==='selfdraw'?'selfdraw':'dianpao',payer,bonus);
  }
  function drawFor(p, replacement=false) {
    if (G.deck.length <= DEAD_WALL) return false;
    const tile=G.deck.pop(); G.hands[p].push(tile); G.hands[p].sort(G.tileCompare);
    G.lastDrawnTile[p]=tile; G.lastDrawWasFinal[p]=G.deck.length===DEAD_WALL;
    if (G.checkHu(G.hands[p],G.exposedMelds[p],p)) { finish(p,'selfdraw',null,tile,G.lastDrawWasFinal[p]); return true; }
    return true;
  }
  // 杠决策：优先走生产代码 Game.aiPickSelfGang；对照臂是旧版代码（没有该函数）时用旧规则：能杠就杠
  function pickSelfGang(p) {
    if (typeof G.aiPickSelfGang === 'function') return G.aiPickSelfGang(p);
    if (!G.hasReplacementSlot()) return null;
    const peng=G.exposedMelds[p].find(m=>m.type==='peng' && G.hands[p].includes(m.tiles[0]));
    if (peng) return { type:'jia', tile:peng.tiles[0] };
    if (G.exposedMelds[p].length>=3) return null;
    const counts={}; for(const t of G.hands[p]) counts[t]=(counts[t]||0)+1;
    const t=Object.keys(counts).find(t=>counts[t]===4);
    return t ? { type:'an', tile:t } : null;
  }
  function maybeSelfGang(p) {
    const sg=pickSelfGang(p);
    if (!sg) return false;
    const t=sg.tile;
    if (sg.type==='jia') {
      // Added kong first; if a legal rob-kong win exists, nearest player wins.
      const peng=G.exposedMelds[p].find(m=>m.type==='peng' && m.tiles[0]===t);
      const rob=ronWinner(p,t);
      if (rob) { finish(rob,'ron',p,t,false); return true; }
      G.hands[p].splice(G.hands[p].indexOf(t),1); peng.type='gang'; peng.tiles=[t,t,t,t];
      G._calls.selfGang++;
      if (!drawFor(p,true)) { G.gameOver=true; return true; }
      if (G.gameOver) return true;
      return false;
    }
    G.hands[p]=G.hands[p].filter(x=>x!==t);G.exposedMelds[p].push({type:'gang',tiles:[t,t,t,t],concealed:true});
    G._calls.selfGang++;
    if (!drawFor(p,true)) { G.gameOver=true; return true; } if(G.gameOver)return true;
    return false;
  }
  function ronWinner(discarder,tile) {
    const idx=PLAYERS.indexOf(discarder);
    for(let k=1;k<4;k++){const p=PLAYERS[(idx+k)%4]; if(G.checkHu([...G.hands[p],tile],G.exposedMelds[p],p)) return p;}
    return null;
  }
  function processDiscard(p) {
    const tile=G.chooseAiDiscardTile(G.hands[p],p);
    assert(tile && G.hands[p].includes(tile),`AI chose illegal discard ${tile} for ${p}`);
    assert(G.TileFlow.discard(p,tile),`discard failed ${p}/${tile}`);
    assertConservation(G,handNo,++steps);
    const ron=ronWinner(p,tile); if(ron){finish(ron,'ron',p,tile,false);return null;}
    // Open meld calls use the production AI's EV/discipline methods.
    for(let k=1;k<4;k++){
      const q=PLAYERS[(PLAYERS.indexOf(p)+k)%4]; if(G.exposedMelds[q].length>=3) continue;
      const cnt=G.hands[q].filter(t=>t===tile).length;
      if(cnt>=2 && G.shouldAiPeng(q,tile)){
        const type=cnt>=3?(typeof G.pickPengKind==='function'?G.pickPengKind(q,tile).kind:(G.hasReplacementSlot()?'gang':'peng')):'peng';
        if(!G.TileFlow.claim(q,type,Array(type==='gang'?3:2).fill(tile),null,{concealed:false})) throw new Error('claim peng/gang failed');
        assertConservation(G,handNo,++steps);
        G._calls[type]++; if(type==='gang'){if(!drawFor(q,true)){G.gameOver=true;return null;} if(G.gameOver)return null;}
        return { next: q, skipDraw: true }; // claimant discards next; gang claimant already drew replacement
      }
    }
    const next=PLAYERS[(PLAYERS.indexOf(p)+1)%4];
    if(G.exposedMelds[next].length<3 && !G.isTenpai(next)){
      const combos=G.findChiCombos(G.hands[next],tile);
      let best=null,bestEV=-Infinity;
      for(const combo of combos){if(!G.shouldAiChi(next,tile,combo))continue; const r=G.meldCallEV(next,tile,'chi',combo);if(r.evCall>bestEV){bestEV=r.evCall;best=combo;}}
      if(best){if(!G.TileFlow.claim(next,'chi',best,null,{}))throw new Error('chi claim failed');G._calls.chi++;assertConservation(G,handNo,++steps);return { next, skipDraw: true };}
    }
    return { next: PLAYERS[(PLAYERS.indexOf(p)+1)%4], skipDraw: false };
  }
  let skipDrawNext = false;
  while(!G.gameOver && steps<maxSteps){
    if(!skipDrawNext && G.deck.length<=DEAD_WALL){G.gameOver=true;winnerMode=null;break;}
    const p=PLAYERS[current];
    if (!skipDrawNext) { G.handTurnCount++; if(!drawFor(p,false)){G.gameOver=true;break;} if(G.gameOver)break; }
    skipDrawNext = false;
    if(maybeSelfGang(p)){if(G.gameOver)break;}
    if(G.gameOver)break;
    const result=processDiscard(p); if(G.gameOver)break;
    current=PLAYERS.indexOf(result.next); skipDrawNext = result.skipDraw;
  }
  if(steps>=maxSteps && !G.gameOver) throw new Error(`step limit exceeded in hand ${handNo}`);
  assertConservation(G,handNo,steps);
  const sumBefore=Object.values(scoreBefore).reduce((a,b)=>a+b,0),sumAfter=Object.values(G.scores).reduce((a,b)=>a+b,0);
  assert.strictEqual(sumAfter,sumBefore,`score is not zero-sum in hand ${handNo}`);
  return {winner:G.winner||null,mode:winnerMode||'draw',payer:G.lastPayer||null,turns:G.handTurnCount,calls:{...G._calls},scoreDelta:Object.fromEntries(PLAYERS.map(p=>[p,G.scores[p]-scoreBefore[p]])),wall:G.deck.length};
}
function runBatch({hands=10,seed=20261019,adaptive=false,root}={}){
  const built=makeGame(seed,adaptive,root),G=built.Game; G._deckSeed=seed; G.dealer='bottom';
  const result={adaptive,seed,hands:0,wins:0,selfDraws:0,rons:0,draws:0,illegalActions:0,scoreByPlayer:{top:0,left:0,right:0,bottom:0},winByPlayer:{top:0,left:0,right:0,bottom:0},calls:{chi:0,peng:0,gang:0,selfGang:0},rounds:[]};
  for(let i=0;i<hands;i++){
    const r=simulateHand(G,i);
    result.hands++; if(r.winner){result.wins++;result.winByPlayer[r.winner]++;if(r.mode==='selfdraw')result.selfDraws++;if(r.mode==='ron')result.rons++;}else result.draws++; for(const k of Object.keys(result.calls)) result.calls[k]+=r.calls[k];
    for(const p of PLAYERS) result.scoreByPlayer[p]+=r.scoreDelta[p];
    result.rounds.push(r);
    G.dealer=PLAYERS[(PLAYERS.indexOf(G.dealer)+1)%4];
  }
  result.winRate=result.wins/result.hands; result.selfDrawRate=result.selfDraws/result.hands; result.ronRate=result.rons/result.hands;
  result.avgTurns=result.rounds.reduce((n,r)=>n+r.turns,0)/result.hands;
  result.avgCallsPerHand=Object.values(result.calls).reduce((a,b)=>a+b,0)/result.hands;
  result.avgScoreDelta=Object.fromEntries(PLAYERS.map(p=>[p,result.scoreByPlayer[p]/result.hands]));
  return result;
}
// ---------- 统计：配对大样本对照 ----------
const T975={1:12.706,2:4.303,3:3.182,4:2.776,5:2.571,6:2.447,7:2.365,8:2.306,9:2.262,10:2.228,11:2.201,12:2.179,13:2.160,14:2.145,15:2.131,16:2.120,17:2.110,18:2.101,19:2.093,20:2.086,24:2.064,29:2.045};
function tCrit(df){ if(df<=0) return NaN; if(T975[df]) return T975[df]; if(df<30){ let d=df; while(!T975[d]) d++; return T975[d]; } return df<120?2.0:1.96; }
function stats(xs){
  const n=xs.length, mean=xs.reduce((a,b)=>a+b,0)/n;
  const sd=n>1?Math.sqrt(xs.reduce((a,b)=>a+(b-mean)**2,0)/(n-1)):NaN, se=sd/Math.sqrt(n), h=tCrit(n-1)*se;
  return {n,mean,sd,se,ci95:[mean-h,mean+h],excludesZero:n>1&&(mean-h>0||mean+h<0)};
}
function wilson(k,n,z=1.96){ if(!n) return [NaN,NaN]; const p=k/n,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)); return [(c-m)/d,(c+m)/d]; }
function metricsOf(r){
  const m={winRate:r.winRate,drawRate:r.draws/r.hands,selfDrawRate:r.selfDrawRate,ronRate:r.ronRate,avgTurns:r.avgTurns,
    meldsPerHand:r.avgCallsPerHand,minggangPerHand:r.calls.gang/r.hands,selfGangPerHand:r.calls.selfGang/r.hands};
  for(const p of PLAYERS) m['score_'+p+'('+STYLES[p]+')']=r.avgScoreDelta[p];
  // 点炮率：按座位的"被点炮"不在结果里，这里用 ron 占比近似；分数分布见 score_*
  return m;
}
/** 两臂（A 对照 / B 实验）× 多个种子，同种子同牌序配对；以"种子批次"为独立单位算 B−A 的均值与 95% CI。 */
function compareArms({hands,seedStart,seeds,armA,armB}){
  const A=[],B=[];
  for(let i=0;i<seeds;i++){
    const seed=(seedStart+i*7919)>>>0;
    A.push(runBatch({hands,seed,...armA})); B.push(runBatch({hands,seed,...armB}));
  }
  const keys=Object.keys(metricsOf(A[0])), paired={}, ma=A.map(metricsOf), mb=B.map(metricsOf);
  for(const k of keys){
    const d=ma.map((x,i)=>mb[i][k]-x[k]), st=stats(d);
    paired[k]={A_mean:stats(ma.map(x=>x[k])).mean,B_mean:stats(mb.map(x=>x[k])).mean,diff:st.mean,ci95:st.ci95,se:st.se,
      significant:st.excludesZero,seedsBetter:d.filter(v=>v>0).length,seedsWorse:d.filter(v=>v<0).length};
  }
  const tot=a=>a.reduce((s,r)=>s+r.hands,0), wins=a=>a.reduce((s,r)=>s+r.wins,0);
  const illegal=A.concat(B).reduce((s,r)=>s+r.illegalActions,0);
  return {config:{hands,seeds,totalHandsPerArm:tot(A),seedStart,armA:{...armA},armB:{...armB}},
    winRateWilson95:{A:wilson(wins(A),tot(A)),B:wilson(wins(B),tot(B))},illegalActions:illegal,paired,
    verdict:Object.keys(paired).filter(k=>paired[k].significant).map(k=>k+': '+(paired[k].diff>0?'+':'')+paired[k].diff.toFixed(4)),
    note:'单位=种子批次（同牌序配对）；95% CI 用 t 分布；"significant"=CI 不含 0。未列入 verdict 的指标视为无显著差异。多指标同时检验会有假阳性，请结合 seedsBetter/seedsWorse 判断。'};
}
if(require.main===module){
  const arg=(name,def)=>{const i=process.argv.indexOf(name);return i>=0?Number(process.argv[i+1]):def;};
  const sarg=(name,def)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:def;};
  const hands=arg('--hands',10),seed=arg('--seed',20261019),seeds=arg('--seeds',1),baseRoot=sarg('--baseline-root',null),outFile=sarg('--out',null);
  let out;
  if(seeds>1||baseRoot){
    // --baseline-root <dir>：A=另一份项目目录（如修改前版本），B=当前目录；否则 A=基线 AI、B=基线+自适应层
    const armA=baseRoot?{adaptive:false,root:path.resolve(baseRoot)}:{adaptive:false};
    const armB=baseRoot?{adaptive:false,root:ROOT}:{adaptive:true};
    out=compareArms({hands,seedStart:seed,seeds,armA,armB});
    out.config.armA.root=out.config.armA.root||'(current)'; out.config.armB.root=out.config.armB.root||'(current)';
  } else {
    const baseline=runBatch({hands,seed,adaptive:false});
    const adaptive=runBatch({hands,seed,adaptive:true});
    out={note:'Actual project AI decision/hu/scoring modules; headless turn scheduler; browser UI/reveal prompts omitted. Results are diagnostic, not statistically conclusive. 大样本请用 --seeds N（可加 --baseline-root <旧版目录>）。',baseline,adaptive,delta:{winRate:adaptive.winRate-baseline.winRate,avgScoreDelta:Object.fromEntries(PLAYERS.map(p=>[p,adaptive.avgScoreDelta[p]-baseline.avgScoreDelta[p]]))}};
  }
  const txt=JSON.stringify(out,null,2);
  if(outFile) fs.writeFileSync(outFile,txt); else console.log(txt);
}
module.exports={runBatch,simulateHand,compareArms,stats,wilson,makeGame};
