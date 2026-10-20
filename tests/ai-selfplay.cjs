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
function makeGame(seed, adaptive) {
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
  for (const file of MODULES) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  if (adaptive) vm.runInContext(fs.readFileSync(path.join(ROOT, ADAPTIVE), 'utf8'), context, { filename: ADAPTIVE });

  // The app's utility methods normally live in globals/state and turn settlement.
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
  G.gameOver=false; G.winner=null; G.lastPayer=null; G.handTurnCount=0; G._calls={chi:0,peng:0,gang:0};
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
  function maybeSelfGang(p) {
    if (G.exposedMelds[p].length>=3 || G.isTenpai(p)) return false;
    // Added kong first; if a legal rob-kong win exists, nearest player wins.
    const peng=G.exposedMelds[p].find(m=>m.type==='peng' && G.hands[p].includes(m.tiles[0]));
    if (peng) {
      const t=peng.tiles[0];
      const rob=ronWinner(p,t);
      if (rob) { finish(rob,'ron',p,t,false); return true; }
      G.hands[p].splice(G.hands[p].indexOf(t),1); peng.type='gang'; peng.tiles=[t,t,t,t];
      if (!drawFor(p,true)) { G.gameOver=true; return true; }
      if (G.gameOver) return true;
      return false;
    }
    const counts={}; for(const t of G.hands[p]) counts[t]=(counts[t]||0)+1;
    const t=Object.keys(counts).find(t=>counts[t]===4);
    if(t){G.hands[p]=G.hands[p].filter(x=>x!==t);G.exposedMelds[p].push({type:'gang',tiles:[t,t,t,t],concealed:true});
      if (!drawFor(p,true)) { G.gameOver=true; return true; } if(G.gameOver)return true; }
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
        const type=cnt>=3?'gang':'peng';
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
function runBatch({hands=10,seed=20261019,adaptive=false}={}){
  const built=makeGame(seed,adaptive),G=built.Game; G._deckSeed=seed; G.dealer='bottom';
  const result={adaptive,seed,hands:0,wins:0,selfDraws:0,rons:0,draws:0,illegalActions:0,scoreByPlayer:{top:0,left:0,right:0,bottom:0},winByPlayer:{top:0,left:0,right:0,bottom:0},calls:{chi:0,peng:0,gang:0},rounds:[]};
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
if(require.main===module){
  const arg=(name,def)=>{const i=process.argv.indexOf(name);return i>=0?Number(process.argv[i+1]):def;};
  const hands=arg('--hands',10),seed=arg('--seed',20261019);
  const baseline=runBatch({hands,seed,adaptive:false});
  const adaptive=runBatch({hands,seed,adaptive:true});
  console.log(JSON.stringify({note:'Actual project AI decision/hu/scoring modules; headless turn scheduler; browser UI/reveal prompts omitted. Results are diagnostic, not statistically conclusive.',baseline,adaptive,delta: {winRate:adaptive.winRate-baseline.winRate,avgScoreDelta:Object.fromEntries(PLAYERS.map(p=>[p,adaptive.avgScoreDelta[p]-baseline.avgScoreDelta[p]]))}},null,2));
}
module.exports={runBatch,simulateHand};
