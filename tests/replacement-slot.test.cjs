#!/usr/bin/env node
'use strict';
// 补牌位边界测试：杠（明/暗/加）与东南西北亮牌的统一收口检查（Game.hasReplacementSlot）。
// 规则：牌墙剩余 > 16（DEAD_WALL）才有补牌位置；剩 16 张时杠不执行、风牌不动牌、不流局；
// 剩 17 张时补牌允许（补走最后一张可摸牌），补牌者仍正常出牌；中发白亮牌不用补牌，不受影响。
// 只加载 01/06/08（状态 + 牌工具 + 主流程），其余用桩；玩家/AI/房主的 offer 与执行层共用这一个函数。
// 注意：桩里只有 bottom 一家有牌，其余三家为空，TileFlow 的牌数守恒检查会打 [tile-check] 警告，
// 那是桩状态不完整所致，不是断言失败；断言本身只验本家手牌/副露/牌墙。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const ctx = {
  window: { addEventListener() {} },
  document: { getElementById: () => null, addEventListener() {}, body: null },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Promise, Object, Array, Date, Number, String, JSON, Math,
};
vm.createContext(ctx);
for (const f of ['js/01-globals-state.js', 'js/06-tiles-utils.js', 'js/08-game-flow-core.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const Game = ctx.Game;
Game.render = () => {};
Game.nameOf = p => p;
Game.hideIndicator = () => {};
Game.showIndicator = () => {};

const WINDS = ['1字', '2字', '3字', '4字'];
const DRAGONS = ['5字', '6字', '7字'];
const FILL = ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万', '9万'];
function resetSeat(hand, deckCount) {
  Game.gameOver = false;
  Game.pendingClaim = null;
  Game.phase = Game.PHASE.WAIT_DISCARD; // 真实调用路径里 offer 前已是等出牌阶段
  Game.deck = Array(deckCount).fill('1万');
  Game.hands.bottom = [...hand];
  Game.exposedMelds.bottom = [];
  Game.windDragonBonus.bottom = false;
  Game.revealDeclined.bottom = {};
  Game.revealPatternSeen.bottom = {};
  Game.lastDrawnTile.bottom = null;
  Game.lastDrawWasFinal.bottom = false;
}

// 1. 补牌位判定：17 张有、16 张无、0 张无
Game.deck = Array(17).fill('1万');
assert.strictEqual(Game.hasReplacementSlot(), true, '牌墙 17 张应有补牌位');
Game.deck = Array(16).fill('1万');
assert.strictEqual(Game.hasReplacementSlot(), false, '牌墙 16 张（荒牌墙）应无补牌位');
Game.deck = [];
assert.strictEqual(Game.hasReplacementSlot(), false, '牌墙空应无补牌位');

// 2. 风牌亮牌：牌墙 16 张时不动牌、不流局、不记 bonus
resetSeat([...WINDS, ...FILL.slice(0, 9)], 16);
assert.strictEqual(Game.applyReveal('bottom', 'winds'), false, '无补牌位时风牌亮牌应拒绝');
assert.strictEqual(Game.gameOver, false, '风牌被拒时不应流局');
assert.deepStrictEqual(Game.hands.bottom, [...WINDS, ...FILL.slice(0, 9)], '风牌被拒时手牌须原样不动');
assert.strictEqual(Game.exposedMelds.bottom.length, 0, '风牌被拒时不得产生副露');
assert.strictEqual(Game.deck.length, 16, '风牌被拒时牌墙不得变化');
assert.strictEqual(Game.windDragonBonus.bottom, false, '风牌被拒时不得记 bonus');

// 3. 风牌亮牌：牌墙 17 张时补走最后一张可摸牌，之后剩 16 张荒牌，手牌结构完整
resetSeat([...WINDS, ...FILL.slice(0, 9)], 17);
assert.strictEqual(Game.applyReveal('bottom', 'winds'), true, '牌墙 17 张时风牌亮牌应成功');
assert.strictEqual(Game.exposedMelds.bottom.length, 1, '风牌亮牌应产生一组副露');
assert.strictEqual(Game.exposedMelds.bottom[0].type, 'winds', '副露类型应为 winds');
assert.strictEqual(Game.hands.bottom.length, 10, '13 - 4（亮出）+ 1（补牌）= 10 张手牌');
assert.strictEqual(Game.deck.length, 16, '补牌后牌墙应剩 16 张荒牌');
assert.strictEqual(Game.lastDrawWasFinal.bottom, true, '补走最后一张可摸牌应记 final');
assert.strictEqual(Game.gameOver, false, '补牌成功后不应流局');

// 4. 中发白亮牌：牌墙 16 张时照常亮（不用补牌），不摸牌墙
resetSeat([...DRAGONS, ...FILL, '1条'], 16);
assert.strictEqual(Game.applyReveal('bottom', 'dragons'), true, '中发白亮牌不受补牌位影响');
assert.strictEqual(Game.exposedMelds.bottom.length, 1, '中发白亮牌应产生一组副露');
assert.strictEqual(Game.hands.bottom.length, 10, '13 - 3 = 10 张手牌');
assert.strictEqual(Game.deck.length, 16, '中发白亮牌不得摸牌墙');
assert.strictEqual(Game.gameOver, false, '中发白亮牌后不应流局');

// 5. 高阶亮牌提示：牌墙 16 张时不推风牌；凑齐中发白时仍推中发白
// （pickAdvancedRevealKind 未对外导出，走对外接口 revealKindAfterDraw，并桩成高阶模式）
Game.isDailyMode = () => false;
resetSeat([...WINDS, ...FILL.slice(0, 9)], 16);
assert.strictEqual(Game.revealKindAfterDraw('bottom'), null, '无补牌位且只凑齐风牌时不应提示亮牌');
resetSeat([...WINDS, ...DRAGONS, ...FILL.slice(0, 6)], 16);
assert.strictEqual(Game.revealKindAfterDraw('bottom'), 'dragons', '无补牌位但凑齐中发白时应提示中发白');
resetSeat([...WINDS, ...FILL.slice(0, 9)], 17);
assert.strictEqual(Game.revealKindAfterDraw('bottom'), 'winds', '有补牌位时应提示风牌');

// 6. 玩家自杠 offer：牌墙 16 张时不提示暗杠，17 张时提示
resetSeat(['5万', '5万', '5万', '5万', ...FILL.slice(0, 9)], 16);
Game.offerSelfGangIfAny();
assert.strictEqual(Game.pendingClaim, null, '无补牌位时不应提示暗杠');
resetSeat(['5万', '5万', '5万', '5万', ...FILL.slice(0, 9)], 17);
Game.offerSelfGangIfAny();
assert.ok(Game.pendingClaim && Game.pendingClaim.mode === 'selfGang' && Game.pendingClaim.kind === 'an',
  '有补牌位时应提示暗杠');

// 7. 玩家自杠执行：牌墙 16 张时暗杠被拒，手牌与副露原样不动，可继续出牌
resetSeat(['5万', '5万', '5万', '5万', ...FILL.slice(0, 9)], 16);
Game.pendingClaim = { mode: 'selfGang', kind: 'an', tile: '5万' };
Game.executeSelfGang();
assert.strictEqual(Game.pendingClaim, null, '暗杠被拒后提示应清除');
assert.deepStrictEqual(Game.hands.bottom, ['5万', '5万', '5万', '5万', ...FILL.slice(0, 9)], '暗杠被拒时手牌须原样不动');
assert.strictEqual(Game.exposedMelds.bottom.length, 0, '暗杠被拒时不得产生副露');
assert.strictEqual(Game.deck.length, 16, '暗杠被拒时牌墙不得变化');
assert.strictEqual(Game.gameOver, false, '暗杠被拒时不应流局');
assert.strictEqual(Game.phase, Game.PHASE.WAIT_DISCARD, '暗杠被拒后应回到等出牌');

console.log('replacement-slot: all boundary cases passed');
