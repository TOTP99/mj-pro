// Property/regression tests for adaptive AI traits. Run with: node tests/ai-adaptive-property.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', '22-ai-adaptive.js'), 'utf8');

const traits = {
  conservative: { riskDefenseAt: .75, wallCautionAt: 16, honorHoldBias: -1, cannonHoldTier: 2, blockXiajiaTier: 2, ukeireKeepAt: .5, chaseSpecialSlack: 0 },
  aggressive: { riskDefenseAt: 1.15, wallCautionAt: 6, honorHoldBias: 1, cannonHoldTier: 0, blockXiajiaTier: 0, ukeireKeepAt: .25, chaseSpecialSlack: 2 },
  shrewd: { riskDefenseAt: .95, wallCautionAt: 10, honorHoldBias: 0, cannonHoldTier: 1, blockXiajiaTier: 1, ukeireKeepAt: .45, chaseSpecialSlack: 1 }
};
const Game = {
  aiPersonality: { left: 'conservative', right: 'aggressive', top: 'shrewd' },
  scores: { bottom: 0, left: 0, right: 0, top: 0 },
  turnOrder: ['bottom', 'right', 'top', 'left'],
  deck: Array(70).fill('tile'),
  exposedMelds: { bottom: [], left: [], right: [], top: [] },
  threats: { bottom: .1, left: .1, right: .1, top: .1 },
  estimateOppTenpai(p) { return this.threats[p]; },
  isTenpai() { return false; },
  aiTraitOf(p) { return traits[this.aiPersonality[p]] || traits.shrewd; }
};
vm.runInNewContext(source, { Game, Math, Object, Number, Array });

// Deterministic PRNG so a failing scenario is reproducible.
let seed = 0x5eed1234;
function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; }
const bounds = {
  riskDefenseAt: [.55, 1.35], wallCautionAt: [4, 24], cannonHoldTier: [0, 3],
  blockXiajiaTier: [0, 3], ukeireKeepAt: [.15, .70], chaseSpecialSlack: [0, 2]
};
const fields = Object.keys(bounds);

for (let i = 0; i < 5000; i++) {
  for (const p of ['bottom', 'left', 'right', 'top']) Game.scores[p] = Math.round((rand() * 2 - 1) * 12000);
  Game.deck = Array(Math.floor(rand() * 85)).fill('tile');
  for (const p of ['bottom', 'left', 'right', 'top']) Game.threats[p] = rand();
  const tenpaiState = rand() < .5;
  Game.isTenpai = () => tenpaiState;
  const p = ['left', 'right', 'top'][i % 3];
  const beforeScores = JSON.stringify(Game.scores);
  const beforeTraits = JSON.stringify(traits);
  const first = Game.getAiAdaptiveSnapshot(p);
  const second = Game.getAiAdaptiveSnapshot(p);
  for (const f of fields) {
    const v = first.adaptive[f];
    assert(Number.isFinite(v), `non-finite ${f} at case ${i}`);
    assert(v >= bounds[f][0] && v <= bounds[f][1], `out of bounds ${f}=${v} at case ${i}`);
    assert.strictEqual(v, second.adaptive[f], `non-deterministic ${f} at case ${i}`);
  }
  assert.strictEqual(JSON.stringify(Game.scores), beforeScores, `scores mutated at case ${i}`);
  assert.strictEqual(JSON.stringify(traits), beforeTraits, `baseline traits mutated at case ${i}`);
}

// Human/player-coach path must never receive dynamic strategy changes.
for (let i = 0; i < 100; i++) {
  Game.scores.bottom = Math.round((rand() * 2 - 1) * 20000);
  Game.deck = Array(Math.floor(rand() * 85)).fill('tile');
  const snap = Game.getAiAdaptiveSnapshot('bottom');
  for (const f of fields) assert.strictEqual(snap.adaptive[f], snap.baseline[f], `human trait changed: ${f}`);
}

console.log('AI adaptive property tests passed: 5,000 randomized AI states + 100 human-coach states; bounds, determinism, and no-mutation invariants hold.');
