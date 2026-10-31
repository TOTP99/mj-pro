#!/usr/bin/env node
'use strict';
// AI 杠决策回归：明杠（碰/杠选型）、加杠/暗杠（aiPickSelfGang）。用项目真实 AI 模块，不依赖浏览器。
const assert = require('assert');
const { makeGame } = require('./ai-selfplay.cjs');
const { Game: G } = makeGame(1, false);

function reset(deck = 40) {
  for (const p of ['top', 'left', 'right', 'bottom']) { G.hands[p] = []; G.exposedMelds[p] = []; }
  G.discardPile = []; G.deck = Array(deck).fill('1万');
  G.aiPersonality.top = 'shrewd'; G.aiPersonality.left = 'conservative'; G.aiPersonality.right = 'aggressive';
}

// 1) 补牌位：牌墙 16 张（荒牌墙）时不得加杠/暗杠/明杠；明杠退化为碰，判断与执行一致
reset(16);
G.hands.top = ['东', '东', '东', '东', '2万', '3万', '4万', '5条', '6条', '7条', '8筒', '8筒', '白', '中'];
assert.strictEqual(G.aiPickSelfGang('top'), null, '无补牌位不得暗杠');
G.hands.top = ['1万', '1万', '1万', '4万', '5万', '6万', '2条', '3条', '8筒', '8筒'];
assert.strictEqual(G.pickPengKind('top', '1万').kind, 'peng', '无补牌位明杠必须降为碰');

// 2) 有补牌位：规整手牌的暗杠照常执行
reset(40);
G.hands.top = ['东', '东', '东', '东', '2万', '3万', '4万', '5条', '6条', '7条', '8筒', '8筒', '白', '中'];
assert.deepStrictEqual(JSON.parse(JSON.stringify(G.aiPickSelfGang('top'))), { type: 'an', tile: '东' });

// 3) 杠会拆顺子（向听退步）时不杠：1万×4 + 2万3万，杠掉 1万 就丢了 123
reset(40);
G.hands.top = ['1万', '1万', '1万', '1万', '2万', '3万', '5条', '6条', '7条', '8筒', '8筒', '白', '白', '中'];
const sb = G.estimateShanten(G.hands.top, []);
const sa = G.estimateShanten(['2万', '3万', '5条', '6条', '7条', '8筒', '8筒', '白', '白', '中'], [{ type: 'gang', tiles: Array(4).fill('1万') }]);
assert(sa > sb, '前提：此牌型杠后向听退步 ' + sb + '→' + sa);
assert.strictEqual(G.aiPickSelfGang('top'), null, '杠后向听退步，AI 不应暗杠');

// 4) 加杠防抢杠（公开信息）：有对手三副露（高威胁）时，保守型放弃加杠，激进型照加
reset(40);
G.exposedMelds.left = [{ type: 'peng', tiles: ['南', '南', '南'] }, { type: 'peng', tiles: ['西', '西', '西'] }, { type: 'peng', tiles: ['北', '北', '北'] }];
for (const who of ['top', 'right']) {
  G.exposedMelds[who] = [{ type: 'peng', tiles: ['7条', '7条', '7条'] }];
  G.hands[who] = ['7条', '1万', '2万', '3万', '5万', '6万', '8万', '2筒', '3筒', '9筒', '白'];
}
G.aiPersonality.top = 'conservative'; // top 保守，right 激进
assert.strictEqual(G.aiPickSelfGang('top'), null, '保守型遇高威胁对手应放弃加杠');
const rj = G.aiPickSelfGang('right');
assert(rj && rj.type === 'jia' && rj.tile === '7条', '激进型照常加杠');

// 5) 听牌中的明杠：只在「听口不变」时允许；听口会变则拒绝
reset(40);
G.exposedMelds.top = [{ type: 'peng', tiles: ['白', '白', '白'] }];
G.hands.top = ['1万', '1万', '1万', '2万', '3万', '4万', '8条', '8条', '9条', '9条']; // 听 8条/9条，刻子与听口无关
assert(G.isTenpai('top'));
assert(G.mingGangKeepsWaits('top', '1万'), '听口不变');
assert.strictEqual(G.shouldAiPeng('top', '1万'), true, '听口不变的明杠应允许');
G.hands.top = ['1万', '1万', '1万', '2万', '2万', '3万', '3万', '7条', '8条', '9条']; // 听 1-4万，杠掉刻子会丢听口
assert(G.isTenpai('top'));
assert(!G.mingGangKeepsWaits('top', '1万'), '杠后听口变化');
assert.strictEqual(G.shouldAiPeng('top', '1万'), false, '会改变听口的明杠必须拒绝');
// 听牌且只有 2 张：仍然不碰（不拆听）
G.hands.top = ['1万', '1万', '2万', '3万', '4万', '8条', '8条', '9条', '9条', '白'].slice(0, 10);
G.exposedMelds.top = [{ type: 'peng', tiles: ['中', '中', '中'] }];
if (G.isTenpai('top')) assert.strictEqual(G.shouldAiPeng('top', '1万'), false, '听牌时不碰');

console.log('AI gang decision tests passed: slot guard, structure guard, rob-kong guard, tenpai ming-gang.');
