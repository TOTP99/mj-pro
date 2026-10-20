// Node-only unit tests for the adaptive trait layer; no browser dependencies required.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', '22-ai-adaptive.js'), 'utf8');
const baselineTraits = {
  conservative: { riskDefenseAt: .75, wallCautionAt: 16, honorHoldBias: -1, cannonHoldTier: 2, blockXiajiaTier: 2, ukeireKeepAt: .5, chaseSpecialSlack: 0 },
  aggressive: { riskDefenseAt: 1.15, wallCautionAt: 6, honorHoldBias: 1, cannonHoldTier: 0, blockXiajiaTier: 0, ukeireKeepAt: .25, chaseSpecialSlack: 2 },
  shrewd: { riskDefenseAt: .95, wallCautionAt: 10, honorHoldBias: 0, cannonHoldTier: 1, blockXiajiaTier: 1, ukeireKeepAt: .45, chaseSpecialSlack: 1 }
};

function createGame({ scores, deckLen = 40, threats = {}, tenpai = false } = {}) {
  const Game = {
    aiPersonality: { left: 'conservative', right: 'aggressive', top: 'shrewd' },
    scores: scores || { bottom: 0, left: 0, right: 0, top: 0 },
    turnOrder: ['bottom', 'right', 'top', 'left'],
    deck: Array(deckLen).fill('tile'),
    exposedMelds: { bottom: [], left: [], right: [], top: [] },
    estimateOppTenpai: p => threats[p] || .1,
    isTenpai: () => tenpai,
    aiTraitOf: p => baselineTraits[({ left: 'conservative', right: 'aggressive', top: 'shrewd' })[p] || 'shrewd']
  };
  vm.runInNewContext(source, { Game, Math, Object, Number, Array });
  return Game;
}

// Leader, late wall, and threatening opponent: adapt toward defense.
{
  const game = createGame({
    scores: { bottom: 0, left: 4000, right: 500, top: 700 }, deckLen: 10,
    threats: { bottom: .8, right: .1, top: .75, left: .1 }
  });
  const result = game.getAiAdaptiveSnapshot('left');
  assert(result.adaptive.riskDefenseAt < result.baseline.riskDefenseAt);
  assert(result.adaptive.wallCautionAt > result.baseline.wallCautionAt);
  assert(result.adaptive.cannonHoldTier > result.baseline.cannonHoldTier);
}

// Far behind: take calculated risks to improve comeback potential.
{
  const game = createGame({ scores: { bottom: 0, left: -4000, right: 1000, top: 500 }, deckLen: 10 });
  const result = game.getAiAdaptiveSnapshot('left');
  assert(result.adaptive.riskDefenseAt > result.baseline.riskDefenseAt);
  assert(result.adaptive.ukeireKeepAt < result.baseline.ukeireKeepAt);
  assert(result.adaptive.chaseSpecialSlack > result.baseline.chaseSpecialSlack);
}

// An AI that is already tenpai gets a small offensive nudge, bounded by threat response.
{
  const game = createGame({ tenpai: true });
  const result = game.getAiAdaptiveSnapshot('top');
  assert(result.adaptive.riskDefenseAt > result.baseline.riskDefenseAt);
}

// Human player's coach parameters remain the original baseline.
{
  const game = createGame();
  const result = game.getAiAdaptiveSnapshot('bottom');
  assert.strictEqual(result.adaptive.riskDefenseAt, result.baseline.riskDefenseAt);
  assert.strictEqual(result.adaptive.wallCautionAt, result.baseline.wallCautionAt);
}

console.log('AI adaptive tests passed (4 scenarios).');
