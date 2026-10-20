// Regression tests for the coordinated discard-risk policy in js/20-ai-danger-ev.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', '20-ai-danger-ev.js'), 'utf8');

function makeGame(context) {
  const Game = {
    turnOrder: ['bottom', 'right', 'top', 'left'],
    exposedMelds: { bottom: [], right: [], top: [], left: [] },
    hands: { bottom: [], right: [], top: [], left: [] },
    deck: Array(10).fill('tile'),
    scores: { bottom: 0, right: 0, top: 0, left: 0 },
    aiPersonality: { left: 'shrewd' },
    aiLearn: { confidence: { shrewd: {} }, games: 0 },
    combinedDanger: () => 0.5,
    estimateOppTenpai: () => 0.8,
    estimateShanten: () => 1,
    ukeire1Raw: () => 10,
    analyzeHu: () => ({ sanmenqi: true, yaojiu: true, kezi: true }),
    tileSuit: t => t.slice(-1),
    tileRank: t => parseInt(t, 10),
    getAiAdaptiveContext: () => context,
    positionBias: () => 0,
    markAxisUsed() {},
    dragonTilesArr: []
  };
  vm.runInNewContext(source, { Game, Math, Number, Object, Array, Map, Set });
  return Game;
}

const hand = ['1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','2条','3条','东','东'];
const neutral = makeGame({ ahead: false, farBehind: false, lateGame: false, maxThreat: 0.2, ownTenpai: false });
const leader = makeGame({ ahead: true, farBehind: false, lateGame: true, maxThreat: 0.2, ownTenpai: false });
const trailing = makeGame({ ahead: false, farBehind: true, lateGame: true, maxThreat: 0.2, ownTenpai: false });
const baseEV = neutral.discardEV(hand, [], 'left', '东').ev;
const leaderEV = leader.discardEV(hand, [], 'left', '东').ev;
const trailingEV = trailing.discardEV(hand, [], 'left', '东').ev;
assert(leaderEV < baseEV, 'late-game leader should price discard risk more heavily');
assert(trailingEV > baseEV, 'trailing AI should tolerate measured risk slightly more');
assert.strictEqual(neutral.discardEV(hand, [], 'left', '不存在').invalid, true,
  'discardEV must reject a tile not present in hand');
console.log('AI decision coordination tests passed: late-leader risk, trailing risk, invalid discard guard.');
