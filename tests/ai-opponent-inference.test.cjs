// Regression tests for per-opponent public discard inference.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', '20-ai-danger-ev.js'), 'utf8');

function makeGame(discardPile, deckLength = 40) {
  const Game = {
    turnOrder: ['bottom', 'right', 'top', 'left'],
    exposedMelds: { bottom: [], right: [], top: [], left: [] },
    hands: { bottom: [], right: [], top: [], left: [] },
    discardPile,
    deck: Array(deckLength).fill('x'),
    scores: { bottom: 0, right: 0, top: 0, left: 0 },
    aiPersonality: { left: 'shrewd' },
    aiLearn: { confidence: { shrewd: {} }, games: 0 },
    combinedDanger: () => 0.2,
    tileSuit: t => t.slice(-1),
    tileRank: t => parseInt(t, 10),
    tileSeenCount: () => 0,
    decompose: () => [],
    estimateShanten: () => 1,
    ukeire1Raw: () => 4,
    analyzeHu: () => ({ sanmenqi: true, yaojiu: true, kezi: true }),
    dragonTilesArr: []
  };
  vm.runInNewContext(source, { Game, Math, Number, Object, Array, Map, Set });
  return Game;
}
const d = (player, tile) => ({ player, tile });
const targetOwn = ['1万','9条','东','2筒','5万','6条','4万','8筒'].map(t => d('left', t));
const interleavedA = [...targetOwn];
for (let i = 0; i < 16; i++) interleavedA.push(d('right', i % 2 ? '3万' : '7条'));
const interleavedB = [...targetOwn];
for (let i = 0; i < 2; i++) interleavedB.push(d('right', i % 2 ? '3万' : '7条'));
const a = makeGame(interleavedA);
const b = makeGame(interleavedB);
assert.strictEqual(a.estimateOppTenpai('left'), b.estimateOppTenpai('left'),
  'opponent tenpai estimate must not count other players’ discards as this player’s turns');
assert.strictEqual(a.getOppTenpaiFeatures('left').ownTurns, 8,
  'features should count only the target opponent’s own discards');
const early = makeGame([d('left','1万'), d('right','5万'), d('left','9条')]);
const late = makeGame(Array.from({length: 8}, (_, i) => d('left', ['1万','9条','东','2筒','5万','6条','4万','8筒'][i])));
assert(late.estimateOppTenpai('left') > early.estimateOppTenpai('left'),
  'later own discard count should modestly raise tenpai probability');
const exposed = makeGame(targetOwn);
exposed.exposedMelds.left = [{ type: 'peng', tiles: ['5万','5万','5万'] }, { type: 'chi', tiles: ['2条','3条','4条'] }];
assert(exposed.estimateOppTenpai('left') > a.estimateOppTenpai('left'),
  'visible melds should increase estimated tenpai probability');
console.log('AI opponent inference tests passed: per-player discard isolation, own-turn counting, late-turn and meld signals.');
