# AI 自对弈测试（当前版）

## 运行方式

在项目根目录执行：

```bash
node tests/ai-adaptive.test.cjs
node tests/ai-adaptive-property.test.cjs
node tests/ai-decision-coordination.test.cjs
node tests/ai-opponent-inference.test.cjs
node tests/ai-selfplay.cjs --hands 10 --seed 12345
```

`--hands` 指每个版本模拟的局数；基线版与自适应版使用相同的初始牌序列。建议先运行 10 局烟雾测试，再用多组种子和更大样本评估。

## 本次对手推断与决策协调改动

- `js/11-ai-discard-claim.js`：保听弃牌不再“只要存在安全牌就把所有危险候选硬过滤掉”。改为综合比较 `discardEV`、听张数量、旧听口重叠度；保留听牌优先原则，危险度通过 EV 参与比较。
- `js/20-ai-danger-ev.js`：对手听牌概率只按目标玩家自己的弃牌序列与巡数估计，不再误用全桌巡数；新增 `Game.getOppTenpaiFeatures(opp)` 供诊断。
- `js/11-ai-discard-claim.js`：危险度模型中的近期弃牌趋势只读取目标对手自己的最近弃牌，修复跨玩家混淆。
- `js/20-ai-danger-ev.js`：`discardEV` 对不在手牌中的弃牌请求返回无效结果，避免 `splice(-1, 1)` 误删最后一张牌。
- `js/20-ai-danger-ev.js`：把领先/落后与残局信息纳入点炮风险定价和攻守门槛；领先者残局提高风险成本，落后者适度增加可计算的风险容忍度。
- `js/20-ai-danger-ev.js`：将动态防守性格映射到候选牌危险权重；对吃碰杠的 EV 增加轻量的局势偏置，避免领先者残局为小收益随意副露，也让大幅落后时保留追分机会。
- `js/20-ai-danger-ev.js`：攻击模式下选择更安全替代牌时，同时检查穷胡惩罚和有效进张，避免为躲危险牌牺牲过多牌效。

## 当前实现范围

此测试器在 Node.js 中复用项目真实的以下模块：

- `07-hu-detection.js`：胡牌结构与穷胡规则判定
- `10-ai-shanten-bench.js`：向听数、可见牌统计
- `02-scoring.js`：番型与结算
- `11-ai-discard-claim.js`：弃牌、吃碰决策接口
- `19-ai-efficiency.js`：进张与手牌效率
- `20-ai-danger-ev.js`：危险度、期望收益、攻守决策
- `22-ai-adaptive.js`：自适应策略层

测试器自行提供确定性的发牌与无界面回合调度，并在每次弃牌/副露后检查 136 张牌守恒、单牌最多四张、动作合法性及分数零和。

## 验证结果

- `ai-adaptive.test.cjs`：4 组自适应定向测试通过。
- `ai-adaptive-property.test.cjs`：5,000 组随机 AI 局势 + 100 组人类教练场景通过。
- `ai-decision-coordination.test.cjs`：验证领先残局风险成本更高、落后时风险容忍度适度增加，以及无效弃牌输入被拒绝。
- `ai-opponent-inference.test.cjs`：验证听牌推断只使用目标玩家自己的弃牌、巡数和副露信号。
- 全部 JS 模块通过 `node --check`。
- 固定种子烟雾测试 `node tests/ai-selfplay.cjs --hands 10 --seed 12345`：本次运行基线版与自适应版均为 9 胡、1 流局，非法动作数均为 0，分数总和为 0。由于两个版本在这组小样本中的结果完全相同，不能据此宣称自适应策略提高了胜率。

## 重要限制

这是**无界面自对弈诊断工具**，并非浏览器完整运行时的逐行复刻。第一版采用项目日常模式的胡牌规则；暂不模拟亮牌提示 UI、骰子仪式、完整浏览器存档流程及所有高级模式开关。自摸/点炮、吃碰杠、胡牌判定和计分复用真实项目模块，但回合调度和牌张转移由测试器实现。因此结果适合发现明显回归与比较方向，不应单独作为上线前完整验收。

10 局样本不足以判断胜率提升。应扩展多组固定种子和更大样本，增加置信区间与逐决策差异统计，再判断长期实力变化。


## 第四阶段听牌推断测试补充

本轮额外通过 `node tests/ai-opponent-inference.test.cjs`：对同一目标玩家保持弃牌序列不变、仅改变其他玩家的弃牌数量时，目标玩家听牌概率保持不变；该玩家自身巡数增加或公开副露增加时，估计值按预期温和上升。
