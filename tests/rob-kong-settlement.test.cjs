'use strict';
// BUG-002 regression: robbing an added kong is not a post-kong discard.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const actions = fs.readFileSync(path.join(root, 'js/13-game-actions.js'), 'utf8');
const ai = fs.readFileSync(path.join(root, 'js/11-ai-discard-claim.js'), 'utf8');
const start = actions.indexOf('function offerHu(ctx)');
const end = actions.indexOf('\nfunction callPeng()', start);
assert(start >= 0 && end > start, 'offerHu() must exist');
const body = actions.slice(start, end);
assert(
  /if\s*\(!ctx\.robGang\)\s*Game\.applyKongBonuses\(bonus,\s*'bottom',\s*mode,\s*payer\)/.test(body),
  'rob-kong must not receive post-kong-discard bonus'
);
assert(
  /Game\.settleScore\(robber,\s*'dianpao',\s*player,\s*bonus\)/.test(ai),
  'AI-vs-AI rob-kong must settle as a discard win without kong-discard bonus'
);
console.log('BUG-002 rob-kong settlement regression test passed');
