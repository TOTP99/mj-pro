/** 向听缓存：向听数只取决于「暗牌多重集 + 还缺几个面子」，同一手牌在一次 AI 决策里会被反复计算，
 *  这里按 排序后暗牌 + 副露数 缓存，结果与 estimateShanten 完全一致，只是不重复跑 DFS */
const _shantenCache = new Map();
function estimateShantenCached(concealed, exposed) {
    const key = concealed.slice().sort().join(',') + '|' + (exposed ? exposed.length : 0);
    let v = _shantenCache.get(key);
    if (v === undefined) {
        v = estimateShanten(concealed, exposed);
        if (_shantenCache.size > 4000) _shantenCache.clear();
        _shantenCache.set(key, v);
    }
    return v;
}

function removeTilesFromHand(hand, tilesToRemove) {
    const next = hand.slice();
    for (const t of tilesToRemove) {
        const i = next.indexOf(t);
        if (i >= 0) next.splice(i, 1);
    }
    return next;
}

/** 三门齐相关：吃/碰后是否仍覆盖三门（或至少不比现在更差） */
function suitDiversity(hand, exposed) {
    const suits = new Set();
    for (const t of hand) {
        if (tileSuit(t) !== '字') suits.add(tileSuit(t));
    }
    for (const m of (exposed || [])) {
        for (const t of m.tiles) {
            if (tileSuit(t) !== '字') suits.add(tileSuit(t));
        }
    }
    return suits.size;
}

/** 评估一种吃法：向听下降优先，其次三门齐，再次不拆对子 */
function scoreChiCombo(hand, tile, combo, exposed, player) {
    const style = aiPersonality[player] || 'shrewd';
    const before = estimateShantenCached(hand, exposed);
    const handAfter = removeTilesFromHand(hand, combo);
    const expAfter = exposed.concat([{ type: 'chi', tiles: [...combo, tile].sort(tileCompare) }]);
    const after = estimateShantenCached(handAfter, expAfter);
    let score = (before - after) * 10; // 向听改善越大越好
    // 未开门时，吃能开门有额外价值：没开门自摸要被单独×2惩罚、没开门点炮也×2，
    // 未开门代价比以前更高，这里把权重从 4 调到 6，让AI更愿意为了开门吃这口
    if (!isKaimen(exposed)) score += 6;
    // 三门齐
    const divBefore = suitDiversity(hand, exposed);
    const divAfter = suitDiversity(handAfter, expAfter);
    score += (divAfter - divBefore) * 3;
    if (divAfter >= 3) score += 2;
    // 穷胡专属条件（三门齐/幺九/刻子）完整度：标准向听改善之外，额外奖励真正推进胡牌资格的吃法
    const qhBefore = analyzeHu(hand, exposed, player);
    const qhAfter = analyzeHu(handAfter, expAfter, player);
    if (!qhBefore.sanmenqi && qhAfter.sanmenqi) score += 3;
    if (!qhBefore.yaojiu && qhAfter.yaojiu) score += 3;
    if (!qhBefore.kezi && qhAfter.kezi) score += 2;
    // 尽量不拆对子：combo 里若拆了对子则扣分
    for (const t of combo) {
        if (hand.filter(x => x === t).length >= 2) score -= 2;
    }
    // 性格：保守要求至少不升高向听；激进可略接受持平
    if (style === 'conservative' && after > before) score -= 20;
    if (style === 'shrewd' && after > before + 1) score -= 20;
    if (style === 'aggressive' && after > before + 1) score -= 12;
    return score;
}

/** 是否应该吃：有正收益（或未开门且不太亏）。学习偏好：这个性格最近战绩好就放宽门槛，战绩差就收紧 */
function shouldAiChi(player, tile, combo) {
    if (isTenpai(player)) return false;
    const exposed = exposedMelds[player];
    if (exposed.length >= 3) return false;
    const score = scoreChiCombo(hands[player], tile, combo, exposed, player);
    const style = aiPersonality[player] || 'shrewd';
    const conf = (aiLearn.confidence[style] && aiLearn.confidence[style].callAggr) || 0;
    const open = isKaimen(exposed);
    // 开门：要有明显收益；未开门：新规则下没开门自摸/点炮都要多罚一倍，门槛降到 1，更愿意开门
    const baseThreshold = open ? 4 : 1;
    const actual = score >= baseThreshold - conf * 0.6;
    // 轴1归因：跟"没学过(conf=0)"时会不会选得不一样比一比，选得不一样说明这条轴真的起作用了
    if (actual !== (score >= baseThreshold)) markAxisUsed(player, 'callAggr');
    return actual;
}

function tileKeepTier(hand, tile, style, neutralHonor) {
    const suit = tileSuit(tile);
    const rank = tileRank(tile);
    const sameCount = hand.filter(t => t === tile).length;
    let tier;

    if (sameCount >= 3) tier = 4; // 刻子
    else if (sameCount === 2) tier = 6; // 对子：不要轻易拆
    else if (suit === '字') {
        // 轴5 字牌保留倾向：孤立字牌原本一律tier 0（最先丢），按性格+学习加一点保留倾向
        // （aggressive更愿意赌字牌刻子，conservative维持原来的0，不倒扣成负数）
        // neutralHonor=true 时强制当作没有这条轴（bias=0），给归因用的"没学过会怎么选"对照
        const learn = aiLearn.confidence[style] || {};
        const learnedBias = neutralHonor ? 0 : (learn.honorHold >= 1.5 ? 1 : (learn.honorHold <= -1.5 ? -1 : 0));
        const bias = neutralHonor ? 0 : (AI_TRAITS[style] || AI_TRAITS.shrewd).honorHoldBias;
        tier = Math.max(0, bias + learnedBias);
    }
    else {
        // 同花色±1/±2内是否还有别的牌，用来判断是不是“完全孤立”
        let hasNear = false;
        for (let d = 1; d <= 2; d++) {
            if (hand.includes((rank - d) + suit) || hand.includes((rank + d) + suit)) { hasNear = true; break; }
        }
        const inRun = hand.includes((rank - 1) + suit) || hand.includes((rank + 1) + suit);
        if (!hasNear) {
            tier = (rank === 1 || rank === 9) ? 3 : ([4, 5, 6].includes(rank) ? 2 : 1);
        } else if (inRun) {
            // 连张/搭子（如45、56、67）：默认高优先级保留；但若是边张（12等3 / 89等7）
            // 且那张已经死绝（记牌确认4张都看得见了），就不用死守这个没指望的等张
            let edgeDeadWait = false;
            if (rank === 1 && hand.includes(2 + suit) && isTileDead(3 + suit, hand)) edgeDeadWait = true;
            if (rank === 2 && hand.includes(1 + suit) && isTileDead(3 + suit, hand)) edgeDeadWait = true;
            if (rank === 8 && hand.includes(9 + suit) && isTileDead(7 + suit, hand)) edgeDeadWait = true;
            if (rank === 9 && hand.includes(8 + suit) && isTileDead(7 + suit, hand)) edgeDeadWait = true;
            tier = edgeDeadWait ? 1 : 5;
        } else {
            // 嵌张（如4_6空档等5）：记牌检查缺的那张是不是已经死了，死了就不用留着盼了
            let deadWait = false;
            if (hand.includes((rank - 2) + suit) && isTileDead((rank - 1) + suit, hand)) deadWait = true;
            if (hand.includes((rank + 2) + suit) && isTileDead((rank + 1) + suit, hand)) deadWait = true;
            tier = deadWait ? 1 : 3;
        }
    }

    // 三门齐保护：这是本门(万/条/筒)僅剩的一张，且三门都还在，打了就彻底断这门了 —— 提高保留优先级
    if (tier < 5 && protectsThreeSuits(hand, tile)) tier = 5;
    return tier;
}

// 三家AI性格：北(上家)保守 / 南(下家)激进 / 西(对家)精明
const aiPersonality = { left: 'conservative', right: 'aggressive', top: 'shrewd' };

// ---------- AI 7轴静态差异化参数（第一步：先写死三性格的不同倾向，暂不接学习） ----------
// 轴1(吃碰激进度)/轴2(防守让牌) 已经在 scoreChiCombo/shouldAiChi/shouldAiPeng/chooseAiDiscardTile
// 里天然按 style 分支，不需要额外的表；这里只收 3~7 这5条目前代码里没有性格区分的开关
const AI_TRAITS = {
    conservative: {
        chaseSpecialSlack: 0,  // 轴3 特殊牌型追逐：碰碰胡时额外能容忍的向听损失档数
        wallCautionAt: 16,     // 轴4 残局求稳：牌墙剩这么多张开始求稳（越大越早转守）
        honorHoldBias: -1,     // 轴5 字牌保留：孤立字牌保留档加成（越低越想早丢）
        cannonHoldTier: 2,     // 轴6 炮牌截留：为压住炮牌，愿意多容忍几档tier变差
        blockXiajiaTier: 2,    // 轴7a 不喂下家：为不喂下家，愿意多容忍几档tier变差
        riskDefenseAt: 0.5     // 轴2扩展：对手"看起来要听牌"的风险分到多少就转防守，越低越神经质
    },
    aggressive: {
        chaseSpecialSlack: 2,
        wallCautionAt: 6,
        honorHoldBias: 1,
        cannonHoldTier: 0,
        blockXiajiaTier: 0,
        riskDefenseAt: 1.15    // 只有极端信号（比如对家已经3组副露）才会让激进型也收一收
    },
    shrewd: {
        chaseSpecialSlack: 1,
        wallCautionAt: 10,
        honorHoldBias: 0,
        cannonHoldTier: 1,
        blockXiajiaTier: 1,
        riskDefenseAt: 0.85
    }
};

function prevPlayerOf(p) {
    const idx = turnOrder.indexOf(p);
    return turnOrder[(idx + turnOrder.length - 1) % turnOrder.length];
}
function acrossPlayerOf(p) {
    const idx = turnOrder.indexOf(p);
    return turnOrder[(idx + 2) % turnOrder.length];
}
// 轴6兜底用：这张牌有几家能靠它胡（而不只是"有没有"），候选全是炮牌时挑数字最小的那张
function dangerCount(player, tile) {
    return turnOrder.filter(p => p !== player && checkHu([...hands[p], tile], exposedMelds[p], p)).length;
}
// 轴7a：这张牌会不会让下家吃/碰（下家是"你"时不受此轴约束——喂不喂你不算AI的"位置感"问题）
function feedsXiajia(player, tile) {
    const next = nextPlayerOf(player);
    if (next === 'bottom') return false;
    if (isTenpai(next)) return false; // 下家已听牌，危险度已经由 isTileDangerousFor 覆盖，这里不重复算
    if (exposedMelds[next].length >= 3) return false;
    if (canPeng(hands[next], tile)) return true;
    return findChiCombos(hands[next], tile).length > 0;
}

// 检查某玩家打出这张牌，是否会点炮给别的玩家（用于AI出牌时的危险牌回避）
function isTileDangerousFor(player, tile) {
    return turnOrder.some(p => p !== player && checkHu([...hands[p], tile], exposedMelds[p], p));
}

// 轴2扩展：对手"看起来要听牌了"的启发式风险分（不是读心，纯看得见的信号）——
// 跟 isTileDangerousFor 互补：那个查的是"这一刻打出去必死"，这个查的是"这家开始有听牌相"，
// 用来提前收一收，而不是等对方真听了才后知后觉
function estimateTenpaiRisk(opponent) {
    let risk = 0;
    const melds = exposedMelds[opponent] ? exposedMelds[opponent].length : 0;
    risk += melds * 0.35;
    if (melds >= 3) risk += 0.4; // 穷胡规则最多3组副露，到顶了基本就是在等最后一口
    const recent = discardPile.filter(d => d.player === opponent).slice(-4);
    if (recent.length >= 3) {
        const midCount = recent.filter(d => {
            const s = tileSuit(d.tile), r = tileRank(d.tile);
            return s !== '字' && r >= 4 && r <= 6;
        }).length;
        if (midCount === recent.length) risk += 0.3; // 连续切中张：该扔的边张/字牌早扔完了，牌型收紧
    }
    return Math.min(risk, 1.2);
}

// 轴：速度 vs 牌值——粗略估一下这手牌大概能算多大，不追求精确，只用来在"求快"和"求大"间做取舍
function estimateHandValue(hand, exposed) {
    let mult = 1;
    const allTiles = [...hand, ...exposed.flatMap(m => m.tiles)];
    const suits = new Set(allTiles.map(tileSuit));
    if (isGoingForTriplets(hand)) mult += 1; // 碰碰胡苗头
    const numSuits = [...suits].filter(s => s !== '字');
    if (numSuits.length === 1 && !suits.has('字')) mult += 2; // 清一色苗头
    else if (numSuits.length === 1) mult += 1; // 混一色苗头
    mult += exposed.filter(m => m.type === 'gang').length; // 已经杠过的，牌越来越大
    const yaojiuCount = allTiles.filter(t => { const r = tileRank(t), s = tileSuit(t); return s === '字' || r === 1 || r === 9; }).length;
    if (allTiles.length && yaojiuCount / allTiles.length >= 0.5) mult += 0.5; // 幺九多，字牌/幺九加成有戏
    return mult;
}

// 在保留等级最低（最优先舍弃）的档位里，优先选不会点炮的牌；避炮的松紧度按性格调整：
// 保守=不惜多跳档也要找安全牌；激进=只在最该舍弃那档找，找不到就照打求效率；精明=折中，最多跳3档
// 牌墙剩余量的紧迫感：越接近荒牌墙，大家都更求稳（多跳几档也要找安全牌）
function wallUrgencyBonus(style, wcConfOverride) {
    const remaining = deck.length - DEAD_WALL;
    const learn = aiLearn.confidence[style] || {};
    const wcConf = wcConfOverride !== undefined ? wcConfOverride : (learn.wallCaution || 0);
    const wcDelta = wcConf >= 1.5 ? 2 : (wcConf <= -1.5 ? -2 : 0); // 学习部分：在静态阈值上再多/少2张
    const at = Math.max(2, (AI_TRAITS[style] || AI_TRAITS.shrewd).wallCautionAt + wcDelta);
    if (remaining <= Math.round(at / 2)) return 3;
    if (remaining <= at) return 1;
    return 0;
}

// 给定手牌+副露，若已是听牌形态，返回可胡的牌列表，否则 []
// 听牌缓存：结果只取决于 暗牌 + 副露(含类型/是否暗杠) + 该玩家的亮牌加成，按这三样做键。
// render 每次都要给四家算听牌提示、给手牌算危险标记，命中缓存后不再重复扫 34 种牌
const _winTilesCache = new Map();
function getWinningTilesOf(concealed, exposed, player) {
    const neededLen = (4 - exposed.length) * 3 + 2;
    if (concealed.length !== neededLen - 1) return [];
    const key = (player || '') + (player && windDragonBonus[player] ? '+' : '-') + '|'
        + concealed.slice().sort().join(',') + '|'
        + exposed.map(m => m.type + (m.concealed ? 'c' : '') + m.tiles.join('')).join(';');
    let res = _winTilesCache.get(key);
    if (res === undefined) {
        res = allTileTypes().filter(t => checkHu([...concealed, t], exposed, player));
        if (_winTilesCache.size > 3000) _winTilesCache.clear();
        _winTilesCache.set(key, res);
    }
    return res.slice(); // 返回副本，调用方随便改也不会污染缓存
}

// 进张数：打出这张后，还有多少种（未死绝的）牌摸到能让向听数继续下降
// 用于同保留档位打平时的 tie-break，取代纯随机，让AI优先留住选择面更宽的牌
function ukeireCount(hand, exposed) {
    const shan = estimateShantenCached(hand, exposed);
    let count = 0;
    for (const t of allTileTypes()) {
        if (isTileDead(t, hand)) continue; // 已经死绝的牌（含自己手里的）摸不到，没有实际意义
        if (estimateShantenCached([...hand, t], exposed) < shan) count++;
    }
    return count;
}

function chooseAiDiscardTile(hand, player) {
    const exposed = exposedMelds[player];
    const style = aiPersonality[player] || 'shrewd';

    // —— 已上听 / 摸牌后仍可保听：优先打出后仍听的牌，且尽量不换听口 ——
    const keepTenpai = []; // { tile, wins, overlap, safe }
    for (const t of hand) {
        const remain = hand.slice();
        const ix = remain.indexOf(t);
        if (ix < 0) continue;
        remain.splice(ix, 1);
        const wins = getWinningTilesOf(remain, exposed, player);
        if (!wins.length) continue;
        const prev = aiWaitTiles[player] || [];
        const overlap = prev.length ? wins.filter(w => prev.includes(w)).length : wins.length;
        keepTenpai.push({
            tile: t,
            wins,
            overlap,
            waitCount: wins.length,
            safe: !isTileDangerousFor(player, t)
        });
    }
    if (keepTenpai.length) {
        // 1) 有不点炮的保听优先；2) 尽量与原听口重叠；3) 听张数更多
        const pool = keepTenpai.some(x => x.safe) ? keepTenpai.filter(x => x.safe) : keepTenpai;
        pool.sort((a, b) => {
            if (b.overlap !== a.overlap) return b.overlap - a.overlap;
            if (b.waitCount !== a.waitCount) return b.waitCount - a.waitCount;
            return 0;
        });
        const best = pool[0];
        // 在同档最优里随机，避免死板
        const top = pool.filter(x => x.overlap === best.overlap && x.waitCount === best.waitCount);
        const chosen = top[Math.floor(Math.random() * top.length)];
        aiWaitTiles[player] = chosen.wins;
        return chosen.tile;
    }
    // 已无法保听（或尚未上听）→ 清空听口记忆；按「向听优先 + 安全 + 保留档」舍牌
    aiWaitTiles[player] = [];

    const candidates = [];
    for (const t of hand) {
        const remain = removeTilesFromHand(hand, [t]);
        const shan = estimateShantenCached(remain, exposed);
        const tier = tileKeepTier(hand, t, style);
        const safe = !isTileDangerousFor(player, t);
        const feedsNext = feedsXiajia(player, t); // 轴7a：这张牌会不会喂下家吃/碰
        // 穷胡专属条件：打出这张后，三门齐/幺九/刻子还保不保得住（标准向听算法看不到这三条，靠这里补）
        const qh = analyzeHu(remain, exposed, player);
        let qhPenalty = 0;
        if (!qh.sanmenqi) qhPenalty += 2;
        if (!qh.yaojiu) qhPenalty += 2;
        if (!qh.kezi) qhPenalty += 1;
        candidates.push({ tile: t, shan, tier, safe, feedsNext, qhPenalty });
    }
    // 向听越小越好；同向听优先保住三门齐/幺九/刻子；再优先安全；再优先扔掉保留档低的牌
    candidates.sort((a, b) => {
        if (a.shan !== b.shan) return a.shan - b.shan;
        if (a.qhPenalty !== b.qhPenalty) return a.qhPenalty - b.qhPenalty;
        if (a.safe !== b.safe) return a.safe ? -1 : 1;
        if (a.tier !== b.tier) return a.tier - b.tier;
        return 0;
    });
    const bestShan = candidates[0].shan;
    // 性格：可在最佳向听的邻近档里找安全牌
    let shanSlack = style === 'conservative' ? 1 : (style === 'aggressive' ? 0 : 1);
    // 轴：速度vs牌值——保守永远只看上面这套、不受牌值影响；激进平时求快，但牌值真的大了愿意多等一巡；
    // 精明本来就想要大牌，牌值越高越愿意等（跟激进那条一样封顶多等1巡，别真等成流局）
    const handValue = estimateHandValue(hand, exposed);
    if (style === 'aggressive' && handValue >= 2) shanSlack += 1;
    if (style === 'shrewd' && handValue >= 1.5) shanSlack += 1;
    const learn = aiLearn.confidence[style] || {};
    const urgency = wallUrgencyBonus(style);
    let pool = candidates.filter(c => c.shan <= bestShan + shanSlack);
    // 轴2(防守让牌)的学习值
    const defenseConf = learn.defense || 0;
    // 轴7b/7c 位置感：读一眼对家/上家是什么性格，微调自己求稳的门槛
    // 对家凶（激进）→ 收紧（更容易触发cautious）；上家稳（保守）→ 松一点（威胁小，不用太紧张）
    let posSlack = 0;
    if (aiPersonality[acrossPlayerOf(player)] === 'aggressive') posSlack -= 1;
    if (aiPersonality[prevPlayerOf(player)] === 'conservative') posSlack += 1;
    const cautious = defenseConf <= -1.5 - posSlack;
    const confident = defenseConf >= 1.5;
    // 没开门点炮×2：自己还没开门时点炮要多付一倍，安全牌优先级必须更硬，
    // 不受性格/战绩自信影响——哪怕是激进/战绩好的AI，没开门也不能对危险牌掉以轻心
    const notOpen = !isKaimen(exposed);
    // 轴2扩展：对手有没有"看起来要听牌"的信号（副露数/连续切中张），门槛按性格+学习值调
    // （战绩差的更神经质、更容易转防守；战绩好的更迟钝一点）
    const riskAt = Math.max(0.3, (AI_TRAITS[style] || AI_TRAITS.shrewd).riskDefenseAt - Math.round(defenseConf) * 0.15);
    const highRiskNow = turnOrder.some(p => p !== player && estimateTenpaiRisk(p) >= riskAt);
    const safeFilterActive = (u, c, cf, hr) => (u >= 1 || c || notOpen || hr) || (style !== 'aggressive' && !cf);
    const actualFilterOn = safeFilterActive(urgency, cautious, confident, highRiskNow);
    const safePoolNow = pool.filter(c => c.safe);
    // 只有"求稳"这一开关真的能改变候选范围（池子里本来就有安全/危险两种牌混着）时，
    // 归因才有意义——否则开不开都一样，不能算某条轴"起了作用"
    const filterWouldNarrow = safePoolNow.length > 0 && safePoolNow.length < pool.length;
    if (actualFilterOn && filterWouldNarrow) pool = safePoolNow;
    if (filterWouldNarrow) {
        // 归因：defense / wallCaution / 位置感 / 对手风险信号 分别单独归零（只改这一个、其它保持实际值），
        // 看开关会不会翻——翻了说明这条轴自己就能决定这一把的选择
        if (safeFilterActive(urgency, 0 <= -1.5 - posSlack, false, highRiskNow) !== actualFilterOn) {
            markAxisUsed(player, 'defense');
        }
        if (safeFilterActive(wallUrgencyBonus(style, 0), cautious, confident, highRiskNow) !== actualFilterOn) {
            markAxisUsed(player, 'wallCaution');
        }
        if (safeFilterActive(urgency, defenseConf <= -1.5, confident, highRiskNow) !== actualFilterOn) {
            markAxisUsed(player, 'position');
        }
        if (safeFilterActive(urgency, cautious, confident, false) !== actualFilterOn) {
            markAxisUsed(player, 'defense'); // 对手风险信号算在防守这条轴上
        }
    }
    // 轴6 炮牌截留：上面"求稳"已经把pool收紧到安全牌了；这里补的是剩下那种情形——
    // 不在求稳范围内，但当前最优tier里其实没有安全牌——性格+学习允许的话，
    // 宁可退让几档tier也要换一张安全牌（不允许就是cannonHoldTier=0，跟以前行为一样）
    const cannonHoldTier = Math.max(0, (AI_TRAITS[style] || AI_TRAITS.shrewd).cannonHoldTier
        + (learn.cannonHold >= 1.5 ? 1 : (learn.cannonHold <= -1.5 ? -1 : 0)));
    if (cannonHoldTier > 0) {
        const curBestTier = Math.min(...pool.map(c => c.tier));
        const bestTierHasSafe = pool.some(c => c.tier === curBestTier && c.safe);
        if (!bestTierHasSafe) {
            const widened = pool.filter(c => c.tier <= curBestTier + cannonHoldTier && c.safe);
            if (widened.length) { pool = widened; markAxisUsed(player, 'cannonHold'); }
        }
    }
    // 轴7a 不喂下家：跟轴6同样的"退让几档tier"思路，只不过换成躲"会喂下家"的牌而不是"危险牌"
    const blockXiajiaTier = Math.max(0, (AI_TRAITS[style] || AI_TRAITS.shrewd).blockXiajiaTier
        + (learn.position >= 1.5 ? 1 : (learn.position <= -1.5 ? -1 : 0)));
    if (blockXiajiaTier > 0) {
        const curBestTier = Math.min(...pool.map(c => c.tier));
        const bestTierFeedsNext = pool.filter(c => c.tier === curBestTier).every(c => c.feedsNext);
        if (bestTierFeedsNext) {
            const widened = pool.filter(c => c.tier <= curBestTier + blockXiajiaTier && !c.feedsNext);
            if (widened.length) { pool = widened; markAxisUsed(player, 'position'); }
        }
    }
    // 在池内按 tier 升序（先丢不保的）
    pool.sort((a, b) => a.tier - b.tier || (a.safe === b.safe ? 0 : (a.safe ? -1 : 1)));
    const topTier = pool[0].tier;
    let finalPool = pool.filter(c => c.tier === topTier);
    // 轴6兜底：候选（当前tier里）如果一张安全牌都没有——说明真的是"矮子里挑将军"，
    // 全是炮牌——这时候不比tier了，直接按"能胡的家数"挑最少的那几张
    if (finalPool.length > 1 && !finalPool.some(c => c.safe)) {
        finalPool = finalPool.map(c => ({ ...c, danger: dangerCount(player, c.tile) }))
            .sort((a, b) => a.danger - b.danger);
        const minDanger = finalPool[0].danger;
        finalPool = finalPool.filter(c => c.danger === minDanger);
    }
    // 同档打平：改用进张数排序（谁打出去后选择面更宽就先打谁），而不是纯随机
    if (finalPool.length > 1) {
        finalPool = finalPool.map(c => ({
            ...c,
            ukeire: ukeireCount(removeTilesFromHand(hand, [c.tile]), exposed)
        })).sort((a, b) => b.ukeire - a.ukeire);
        const bestUkeire = finalPool[0].ukeire;
        finalPool = finalPool.filter(c => c.ukeire === bestUkeire);
    }
    const chosen = finalPool[Math.floor(Math.random() * finalPool.length)].tile;
    // 轴5归因（事后判定）：如果最终选中的这张恰好是一张"因为性格+学习倾向而被抬过tier"的孤立字牌，
    // 且没有这条倾向时tier会不一样，就算这条轴真的影响了这次的选择
    if (tileSuit(chosen) === '字' && hand.filter(x => x === chosen).length === 1) {
        const withBias = tileKeepTier(hand, chosen, style, false);
        const withoutBias = tileKeepTier(hand, chosen, style, true);
        if (withBias !== withoutBias) markAxisUsed(player, 'honorHold');
    }
    return chosen;
}

function aiDiscard(player) {
    if (gameOver) return;
    const hand = hands[player];
    if (hand.length === 0) { advanceTurn(); return; } // 防御性检查：正常情况下不会发生
    // AI 加杠 / 暗杠：未听牌时执行（加杠需处理抢杠；暗杠不计抢杠）
    if (!isTenpai(player)) {
        for (const meld of exposedMelds[player]) {
            if (meld.type === 'peng' && hand.includes(meld.tiles[0])) {
                const gTile = meld.tiles[0];
                const robber = findRonPriority(player, gTile);
                if (robber) {
                    const ix = hands[player].indexOf(gTile);
                    if (ix > -1) hands[player].splice(ix, 1);
                    if (robber === 'bottom') {
                        offerHu({ mode: 'dianpao', tile: gTile, fromPlayer: player, robGang: true });
                        return;
                    }
                    hands[robber].push(gTile);
                    gameOver = true;
                    winner = robber;
                    const before = [...hands[robber]];
                    before.splice(before.indexOf(gTile), 1);
                    const bonus = scoreWinningHand(before, gTile, exposedMelds[robber], false, false);
                    const result = settleScore(robber, 'dianpao', player, bonus);
                    clearKongFlags();
                    logFlow(nameOf(robber) + ' 抢杠胡了 ' + nameOf(player) + '！' + result.detail);
                    speak('胡了，' + voiceName(player) + '点炮');
                    learnFromWin(robber, player, { fan: bonus.mult, turns: handTurnCount });
                    render();
                    showResultModal(robber, 'dianpao', player, bonus, result, gTile);
                    return;
                }
                const ix = hands[player].indexOf(gTile);
                if (ix > -1) hands[player].splice(ix, 1);
                meld.type = 'gang';
                meld.tiles.push(gTile);
                meld.concealed = false;
                logFlow(nameOf(player) + ' 加杠 ' + tileGlyph(gTile));
                speak('杠' + tileName(gTile));
                render();
                aiDrawReplacement(player);
                return;
            }
        }
        if (exposedMelds[player].length < 3) {
            const counts = {};
            for (const t of hand) counts[t] = (counts[t] || 0) + 1;
            let gangTile = null;
            for (const t of Object.keys(counts)) {
                if (counts[t] >= 4) { gangTile = t; break; }
            }
            if (gangTile) {
                for (let i = 0; i < 4; i++) {
                    const ix = hands[player].indexOf(gangTile);
                    if (ix > -1) hands[player].splice(ix, 1);
                }
                exposedMelds[player].push({ type: 'gang', tiles: [gangTile, gangTile, gangTile, gangTile], concealed: true });
                logFlow(nameOf(player) + ' 暗杠 ' + tileGlyph(gangTile));
                speak('杠' + tileName(gangTile));
                render();
                aiDrawReplacement(player);
                return;
            }
        }
    }
    // 保牌策略：孤立字牌 > 孤立中张(非4/5/6优先) > ... > 对子最后才拆，同等级优先选不点炮的
    const tile = chooseAiDiscardTile(hand, player);
    hand.splice(hand.indexOf(tile), 1);
    markKongDiscardIfNeeded(player);
    discardPile.push({ player, tile });
    validateHandCounts('aiDiscard');
    render();
    speak(tileName(tile));

    // 多家可以胡的话，按下家方向离出牌人最近的先胡
    const ronPlayer = findRonPriority(player, tile);
    if (ronPlayer === 'bottom') {
        offerHu({ mode: 'dianpao', tile, fromPlayer: player });
        return;
    }
    if (ronPlayer) {
        discardPile.pop();
        hands[ronPlayer].push(tile);
        gameOver = true;
        winner = ronPlayer;
        const before = [...hands[ronPlayer]];
        before.splice(before.indexOf(tile), 1);
        const bonus = scoreWinningHand(before, tile, exposedMelds[ronPlayer], false, false);
        applyKongBonuses(bonus, ronPlayer, 'dianpao', player);
        const result = settleScore(ronPlayer, 'dianpao', player, bonus);
        clearKongFlags();
        logFlow(nameOf(player) + ' 点炮，' + nameOf(ronPlayer) + ' 胡了！' + result.detail);
        speak('胡了，' + voiceName(player) + '点炮');
        learnFromWin(ronPlayer, player, { fan: bonus.mult, turns: handTurnCount });
        render();
        showResultModal(ronPlayer, 'dianpao', player, bonus, result, tile);
        return;
    }

    // 无人点炮：杠后点炮标记失效
    if (afterKongDiscardPlayer === player) afterKongDiscardPlayer = null;
    checkClaimOrAdvance(player, tile);
}

// 局势判断：这张牌该不该碰（按性格调整松紧度）
// 还没开门：都想尽快满足开门这个硬性条件，优先碰
// 保守：最多碰2组就收手求稳，且必须碰完还留得住将
// 激进：能碰就碰，追求快速开门或飘(碰碰胡)，上限放宽到快满4组前都碰
// 精明：折中，3组以内且碰完留得住将才碰；中发白/风牌额外值得碰
// 中发白刻子本身带番(×2)，价值高于普通风牌，单独多给一档向听容忍与决策优先级
// 手里还有没有连张(同花色相邻的牌)？没有的话说明这手牌天然在往碰碰胡(飘,8倍)方向走
function isGoingForTriplets(hand) {
    for (const t of hand) {
        const suit = tileSuit(t), rank = tileRank(t);
        if (suit === '字') continue;
        if (hand.includes((rank + 1) + suit)) return false;
    }
    return true;
}

function shouldAiPeng(p, tile, overrides) {
    overrides = overrides || {};
    if (isTenpai(p)) return false; // 已上听不碰，避免拆听
    const style = aiPersonality[p] || 'shrewd';
    const learn = aiLearn.confidence[style] || {};
    // conf=轴1(吃碰激进度)的学习值；chaseConf=轴3(特殊牌型追逐)的学习值；两条轴分开学，互不影响
    const conf = overrides.callAggr !== undefined ? overrides.callAggr : (learn.callAggr || 0);
    const chaseConf = overrides.chaseSpecial !== undefined ? overrides.chaseSpecial : (learn.chaseSpecial || 0);
    const exposed = exposedMelds[p];
    const openCount = exposed.length;
    if (openCount >= 3) return false; // 穷胡：不能手把一

    const hand = hands[p];
    const handAfter = removeTilesFromHand(hand, [tile, tile]);
    const expAfter = exposed.concat([{ type: 'peng', tiles: [tile, tile, tile] }]);
    const shanBefore = estimateShantenCached(hand, exposed);
    const shanAfter = estimateShantenCached(handAfter, expAfter);

    const otherPairs = [...new Set(hand)].filter(t => t !== tile && hand.filter(x => x === t).length >= 2);
    // 中发白可作将，也可直接算有价值字牌
    const isDragon = dragonTilesArr.includes(tile);
    const isWind = windTilesArr.includes(tile);
    const isHonorValue = isDragon || isWind;
    const keepsJiang = otherPairs.length > 0 || isDragon;
    const chasingPengPeng = isGoingForTriplets(hand);

    // 穷胡专属条件：碰完是否补上了原本缺的三门齐/幺九/刻子
    // 缺的条件补上了就值得放宽一档向听要求
    const qhBefore = analyzeHu(hand, exposed, p);
    const qhAfter = analyzeHu(handAfter, expAfter, p);
    const qhGain = (!qhBefore.sanmenqi && qhAfter.sanmenqi)
        || (!qhBefore.yaojiu && qhAfter.yaojiu)
        || (!qhBefore.kezi && qhAfter.kezi);

    // 副露数量上限
    // 激进可略多；冲碰碰胡再按性格+学习给不同额度；学习战绩很好再多给1个名额，很差则少给1个
    // 中发白刻子本身带番，即使已接近上限也允许碰（下面用 isHonorValue 放行）
    const chaseSlack = (AI_TRAITS[style] || AI_TRAITS.shrewd).chaseSpecialSlack
        + (chaseConf >= 1.5 ? 1 : (chaseConf <= -1.5 ? -1 : 0));
    const cap = (style === 'conservative' ? 2 : (style === 'aggressive' ? 3 : 2))
        + (chasingPengPeng ? chaseSlack : 0)
        + (conf >= 1.5 ? 1 : 0) - (conf <= -1.5 ? 1 : 0);
    if (openCount >= cap && !isHonorValue) return false;

    // 向听约束：默认不能明显变差
    // 学习战绩好 / 补上穷胡缺项 / 中发白刻子 → 各可多容忍一档
    const confSlack = conf >= 1.5 ? 1 : (conf <= -1.5 ? -1 : 0);
    const qhSlack = qhGain ? 1 : 0;
    const dragonSlack = isDragon ? 1 : 0; // 中发白刻子×2是稳赚的，比赌三门齐更确定
    const baseSlack = confSlack + qhSlack + dragonSlack;
    // 没开门自摸×2 / 没开门点炮×2：不开门的代价比以前更高，三种性格都该多容忍1档向听去换开门，
    // 保守派也不例外（以前只有精明/激进有这个宽容）
    const openSlack = openCount === 0 ? 1 : 0;

    if (style === 'conservative') {
        if (shanAfter > shanBefore + Math.max(0, openSlack + baseSlack)) return false;
    } else if (style === 'shrewd') {
        if (shanAfter > shanBefore + Math.max(0, openSlack + baseSlack)) return false;
    } else {
        // aggressive：允许为开门或有价值字牌略损向听
        if (shanAfter > shanBefore + Math.max(0, (openSlack || isHonorValue ? 1 : 0) + baseSlack)) return false;
    }

    // 未开门：优先碰（在向听可接受的前提下）
    if (openCount === 0) return true;

    // 已开门：优先级 中发白 > 冲碰碰胡 > 普通有价值字牌(风) > 保住将
    if (isDragon && shanAfter <= shanBefore + 1) return true; // 中发白刻子带番，多容忍1档也碰
    if (chasingPengPeng && shanAfter <= shanBefore + chaseSlack) return true;
    if (isHonorValue && shanAfter <= shanBefore + 1) return true;
    return keepsJiang && shanAfter <= shanBefore;
}

// 除discarder外，检查是否有AI能碰（或杠）这张牌，且局势上值得碰
function findAiPeng(discarder, tile) {
    for (const p of ['top', 'left', 'right']) {
        if (p === discarder) continue;
        if (exposedMelds[p].length >= 3) continue; // 穷胡规则：不能手把一，最多3组面子在外
        if (!canPeng(hands[p], tile)) continue;
        const actual = shouldAiPeng(p, tile);
        // 归因：把轴1/轴3的学习值分别归零，看这个决定是不是因为学到的东西才变了
        // （分别只归零一条、另一条保持实际值，这样才是这条轴自己的影响，不会互相混)
        if (shouldAiPeng(p, tile, { callAggr: 0 }) !== actual) markAxisUsed(p, 'callAggr');
        if (shouldAiPeng(p, tile, { chaseSpecial: 0 }) !== actual) markAxisUsed(p, 'chaseSpecial');
        if (actual) return p;
    }
    return null;
}

// 多家能胡这张牌时，按下家方向（离出牌人最近的下家优先）找第一个能胡的玩家，找不到返回null
function findRonPriority(discarder, tile) {
    const idx = turnOrder.indexOf(discarder);
    for (let step = 1; step <= 3; step++) {
        const p = turnOrder[(idx + step) % turnOrder.length];
        const hand = p === 'bottom' ? [...hands.bottom, tile] : [...hands[p], tile];
        if (checkHu(hand, exposedMelds[p], p)) return p;
    }
    return null;
}

function nextPlayerOf(p) {
    const idx = turnOrder.indexOf(p);
    return turnOrder[(idx + 1) % turnOrder.length];
}

// 只有出牌者的下家能吃；如果下家是AI，检查AI是否能吃
function findAiChi(discarder, tile) {
    const next = nextPlayerOf(discarder);
    if (next === 'bottom') return null; // 你的吃已经在别处处理
    if (isTenpai(next)) return null; // 已上听不吃，避免拆听
    if (exposedMelds[next].length >= 3) return null; // 穷胡规则：不能手把一
    const combos = findChiCombos(hands[next], tile);
    if (!combos.length) return null;
    // 在多种吃法里选评分最高且 shouldAiChi 通过的
    let best = null;
    let bestScore = -Infinity;
    for (const combo of combos) {
        if (!shouldAiChi(next, tile, combo)) continue;
        const sc = scoreChiCombo(hands[next], tile, combo, exposedMelds[next], next);
        if (sc > bestScore) {
            bestScore = sc;
            best = combo;
        }
    }
    return best ? { player: next, combo: best } : null;
}

function aiPengClaim(p, tile) {
    discardPile.pop();
    lastCallTurn[p] = handTurnCount; // 归因细化：记这次碰/杠发生在第几巡
    const cnt = hands[p].filter(x => x === tile).length;
    const useGang = cnt >= 3; // 凑齐3张暗的+这张，直接杠比碰更优
    const takeCount = useGang ? 3 : 2;
    takeTilesFromHand(p, tile, takeCount);
    currentIndex = turnOrder.indexOf(p);
    if (useGang) {
        exposedMelds[p].push({ type: 'gang', tiles: [tile, tile, tile, tile], concealed: false });
        logFlow(nameOf(p) + ' 杠了 ' + tileGlyph(tile));
        speak('杠' + tileName(tile));
        render();
        aiDrawReplacement(p);
    } else {
        exposedMelds[p].push({ type: 'peng', tiles: [tile, tile, tile] });
        logFlow(nameOf(p) + ' 碰了 ' + tileGlyph(tile));
        speak('碰' + tileName(tile));
        render();
        gameTimeout(() => aiDiscard(p), 700);
    }
}

function aiChiClaim(p, tile, combo) {
    discardPile.pop();
    lastCallTurn[p] = handTurnCount; // 归因细化：记这次吃发生在第几巡
    combo.forEach(t => {
        const idx = hands[p].indexOf(t);
        if (idx > -1) hands[p].splice(idx, 1);
    });
    const meldTiles = [...combo, tile].sort(tileCompare);
    exposedMelds[p].push({ type: 'chi', tiles: meldTiles });
    currentIndex = turnOrder.indexOf(p);
    logFlow(nameOf(p) + ' 吃了 ' + tileGlyph(tile));
    speak('吃' + tileName(tile));
    render();
    gameTimeout(() => aiDiscard(p), 700);
}

// AI杠后摸替补牌，检查杠上开花，否则继续正常出牌
function aiDrawReplacement(p) {
    if (deck.length <= DEAD_WALL) { declareDraw(); return; }
    const drawn = deck.pop();
    const isLastTile = deck.length === DEAD_WALL;
    hands[p].push(drawn);
    hands[p].sort(tileCompare);
    lastDrawnTile[p] = drawn;
    lastDrawWasFinal[p] = isLastTile;
    markKongDraw(p);
    validateHandCounts('aiDrawReplacement');
    render();
    if (checkHu(hands[p], exposedMelds[p], p)) {
        gameOver = true;
        winner = p;
        const before = [...hands[p]];
        before.splice(before.indexOf(drawn), 1);
        const bonus = scoreWinningHand(before, drawn, exposedMelds[p], true, isLastTile);
        applyKongBonuses(bonus, p, 'selfdraw', null);
        const result = settleScore(p, 'selfdraw', null, bonus);
        clearKongFlags();
        logFlow(nameOf(p) + ' 杠上开花！自摸胡牌！' + result.detail);
        speak('胡了，自摸');
        learnFromWin(p, null, { fan: bonus.mult, turns: handTurnCount });
        render();
        showResultModal(p, 'selfdraw', null, bonus, result, drawn);
        return;
    }
    gameTimeout(() => aiDiscard(p), 700);
}

// 你放弃碰/吃/杠（或没有机会）之后：先看有没有AI能碰/杠，再看下家AI能不能吃，否则正常进入下一家
function resolveAiPengOrAdvance(discarder, tile) {
    const p = findAiPeng(discarder, tile);
    if (p) { aiPengClaim(p, tile); return; }
    const chi = findAiChi(discarder, tile);
    if (chi) { aiChiClaim(chi.player, tile, chi.combo); return; }
    advanceTurn();
}

function checkClaimOrAdvance(player, tile) {
    // 检查你是否可以碰/杠/吃这张牌（穷胡规则：不能手把一，最多3组面子在外，第4组必须留在手里）
    const canClaimMore = exposedMelds.bottom.length < 3;
    const canP = canClaimMore && canPeng(hands.bottom, tile);
    const canG = canClaimMore && canGang(hands.bottom, tile);
    const chiCombos = (canClaimMore && player === 'left') ? findChiCombos(hands.bottom, tile) : []; // 只能吃上家的牌
    if (canP || canG || chiCombos.length) {
        pendingClaim = { tile, fromPlayer: player, canPeng: canP, canGang: canG, chiCombos, mode: 'claim' };
        const options = [canG ? '杠' : null, canP ? '碰' : null, chiCombos.length ? '吃' : null].filter(Boolean).join('/');
        showIndicator(options, true);
        logFlow('可以' + options + '，点确认执行 / 点过');
        return;
    }
    resolveAiPengOrAdvance(player, tile);
}

/** 从指定玩家手牌里移除最多 count 张指定牌（自家/AI 碰杠共用，从末尾往前找） */
function takeTilesFromHand(player, tile, count) {
    let removed = 0;
    const hand = hands[player];
    for (let i = hand.length - 1; i >= 0 && removed < count; i--) {
        if (hand[i] === tile) { hand.splice(i, 1); removed++; }
    }
    return removed;
}

function advanceTurn() {
    if (gameOver) return;
    currentIndex = (currentIndex + 1) % turnOrder.length;
    gameTimeout(() => nextTurn(), 500);
}

