# AI 自对弈测试（当前版）

## 运行方式

在项目根目录执行：

```bash
node tests/ai-adaptive.test.cjs
node tests/ai-adaptive-property.test.cjs
node tests/ai-decision-coordination.test.cjs
node tests/ai-opponent-inference.test.cjs
node tests/ai-gang-decision.test.cjs
node tests/ai-selfplay.cjs --hands 10 --seed 12345

# 大样本配对对照（同种子同牌序；A=基线 AI，B=基线+自适应层）
node tests/ai-selfplay.cjs --hands 20 --seeds 10 --seed 777 --out result.json
# 改动前后对照（A=旧版项目目录，B=当前目录；例如比较杠决策改动）
node tests/ai-selfplay.cjs --hands 20 --seeds 10 --baseline-root /path/to/old-project --out result.json
```

`--seeds N` 输出每个指标的 A/B 均值、B−A 差值、95% CI（t 分布，以种子批次为独立单位）、`seedsBetter/seedsWorse`，并给出胜率 Wilson 区间与非法动作总数。约 1.5 秒/局，请按需控制样本量。

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


## 杠决策改动（明杠 / 加杠 / 暗杠）

- `Game.pickPengKind(p, tile)`：被叫牌是碰还是杠的唯一决策点，`shouldAiPeng` 与 `aiPengClaim` 共用。手里≥3 张且有补牌位时比较「明杠」与「碰」的 EV，且杠不得比碰更伤牌型；无补牌位直接碰（旧版 `shouldAiPeng` 按杠估值、执行时却降成碰）。
- `Game.aiPickSelfGang(player)`：加杠/暗杠统一入口。要求有补牌位、杠后向听不退步（避免拆顺子）、加杠时按性格（保守 0.2 / 精明 0.3 / 激进不限）用公开信息危险度回避抢杠风险。
- 听牌中：旧 `shouldAiPeng` 一刀切拒绝；现允许「手里已有暗刻、明杠后听口完全不变且 EV 不低于不叫」的明杠（`Game.mingGangKeepsWaits`）。旧 `aiDiscard` 里的 `!isTenpai(player)` 在摸牌后 14 张手牌下恒为真（`getWinningTilesOf` 只认 13 张），属死条件，已由向听比较取代。
- 自对弈测试器改走上述生产函数，不再自带「能杠就杠」的简化逻辑；对照臂若是旧版目录（没有这两个函数），退回旧规则。

### 杠改动前后配对对照（10 种子 × 20 局 × 2 臂 = 各 200 局，A=改动前、B=改动后）

- 非法动作 0；胜率 A 66.0% / B 65.0%（差 −1.0pp，95% CI −2.5..+0.5pp）；流局率、自摸/点炮率、平均巡数、明杠/加杠频率、四家场均得分差的 95% CI 均包含 0。
- 唯一"显著"项是每局吃碰杠次数 +0.075（CI 0.009..0.141），属多指标检验下可能的假阳性，且量级很小。
- 多数种子两臂的牌谱完全相同（杠只在约 0.3 次/局出现），样本不足以判断杠改动对强弱的影响；这次改动的价值在于**判断与执行一致、不拆顺子、不白送抢杠、听牌时可安全杠**，而非可测量的胜率提升。若要检出 ±1 分/局量级的得分差，需要远大于现在的样本（数千局以上）。
