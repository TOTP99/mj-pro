;(function(){
// 三家AI性格：北(上家)保守 / 南(下家)激进 / 西(对家)精明
const aiPersonality = { left: 'conservative', right: 'aggressive', top: 'shrewd' };

// ---------- AI 7轴静态差异化参数（第一步：先写死三性格的不同倾向，暂不接学习） ----------
// 轴1(吃碰激进度)/轴2(防守让牌) 已经在 shouldAiChi/shouldAiPeng/chooseAiDiscardTile
// 里天然按 style 分支，不需要额外的表；这里只收 3~7 这5条目前代码里没有性格区分的开关
const AI_TRAITS = {
    conservative: {
        chaseSpecialSlack: 0,  // 轴3 特殊牌型追逐：碰碰胡时额外能容忍的向听损失档数
        wallCautionAt: 16,     // 轴4 残局求稳：牌墙剩这么多张开始求稳（越大越早转守）
        honorHoldBias: -1,     // 轴5 字牌保留：孤立字牌保留档加成（越低越想早丢）
        cannonHoldTier: 2,     // 轴6 炮牌截留：为压住炮牌，愿意多容忍几档tier变差
        blockXiajiaTier: 2,    // 轴7a 不喂下家：为不喂下家，愿意多容忍几档tier变差
        riskDefenseAt: 0.75,   // 轴2扩展：对手"看起来要听牌"的风险分到多少就转防守，越低越神经质
        // 调参 2026-09-29：0.5 时 2 组副露（0.7 分）就转守，太频繁 → 0.75（需 2 组副露 + 其它信号）
        ukeireKeepAt: 0.5,     // 吃/碰后进张数至少保留几成（保守：腰斩就 veto）
        // 调参 2026-09-29：0.6 时保守派几乎不碰、做不起牌 → 0.5 放宽
    },
    aggressive: {
        chaseSpecialSlack: 2,
        wallCautionAt: 6,
        honorHoldBias: 1,
        cannonHoldTier: 0,
        blockXiajiaTier: 0,
        riskDefenseAt: 1.15,   // 只有极端信号（比如对家已经3组副露）才会让激进型也收一收
        ukeireKeepAt: 0.25     // 激进：几乎不看进张损失，只看向听
    },
    shrewd: {
        chaseSpecialSlack: 1,
        wallCautionAt: 10,
        honorHoldBias: 0,
        cannonHoldTier: 1,
        blockXiajiaTier: 1,
        riskDefenseAt: 0.95,
        // 调参 2026-09-29：0.85 时稍有风吹草动就转守 → 0.95（需强信号）
        ukeireKeepAt: 0.45     // 精明：进张损失过大也 veto，但比保守宽容
    }
};

// ---------- 公开信息危险牌模型（替代偷看对手暗牌） ----------
// 成熟麻将 AI 的做法：只用看得见的信息——
//   現物（对手打过的牌对他 100% 安全）、筋（suji：他打过 4，则 1/7 的两面听被堵住一侧）、
//   壁（kabe：相邻关键牌死绝则两面听不可能）、已见张数、对手威胁度（副露数/舍牌趋势）。
// 对包括 bottom（人类玩家）在内的所有对手一视同仁，不再读任何一家的暗牌。
function discardsOfSet(player) {
    const s = new Set();
    for (const d of Game.discardPile) if (d.player === player) s.add(d.tile);
    return s;
}
// 筋源头：rank1~3 → [rank+3]；rank7~9 → [rank-3]；rank4~6 → 双侧 [rank-3, rank+3]
function sujiSources(suit, rank) {
    if (rank <= 3) return [(rank + 3) + suit];
    if (rank >= 7) return [(rank - 3) + suit];
    return [(rank - 3) + suit, (rank + 3) + suit];
}
// 壁：这张牌的两面听搭子关键牌（r-1 / r+1）都已死绝 → 两面听不可能
function kabeSafe(tile, ownHand) {
    const suit = Game.tileSuit(tile), rank = Game.tileRank(tile);
    if (suit === '字') return false;
    let sides = 0, blocked = 0;
    if (rank >= 3) { sides++; if (Game.isTileDead((rank - 1) + suit, ownHand)) blocked++; }
    if (rank <= 7) { sides++; if (Game.isTileDead((rank + 1) + suit, ownHand)) blocked++; }
    return sides > 0 && blocked === sides;
}
// 公开信息危险度 0~1：只看牌河/副露/已见牌/对手威胁度
function publicDangerVs(player, tile, opp) {
    const disc = discardsOfSet(opp);
    // 現物：本项目无振听/打过不能胡规则，对手打过的牌仍可能点炮（换听等），
    // 不能按 0 算。给 0.18 基础风险（远低于生张，但非零）。2026-09-29 AI3.0 修正。
    if (disc.has(tile)) return 0.18;
    const threat = estimateTenpaiRisk(opp); // 0~1.2，纯公开信号
    if (threat < 0.15) return 0; // 毫无威胁的对手，不草木皆兵
    const ownHand = Game.hands[player];
    const suit = Game.tileSuit(tile), rank = Game.tileRank(tile);
    // 已见张数 = 公开（弃牌+明副露）+ 自己手牌。自己手里的牌对手不可能有，
    // 这是 AI 对自己信息的合法利用（人类也这么算："我三张 5万，他不可能听 5万"），不是偷看。
    const seen = Game.tileSeenCount(tile) + ownHand.filter(t => t === tile).length;
    let base;
    if (suit === '字') {
        base = seen >= 3 ? 0.15 : seen === 2 ? 0.45 : seen === 1 ? 0.7 : 0.85;
        // 调参 2026-09-29：未见字牌 0.95 太悲观，人类没见过字牌不会默认按 95% 危险算 → 0.85
    } else if (rank === 1 || rank === 9) {
        base = 0.3;
    } else if (rank === 2 || rank === 8) {
        base = seen >= 3 ? 0.2 : 0.5;
    } else {
        base = seen >= 3 ? 0.25 : 0.75; // 中张
    }
    if (suit !== '字') {
        const srcs = sujiSources(suit, rank);
        const hit = srcs.filter(s => disc.has(s)).length;
        if (hit === srcs.length) base *= 0.35; // 双侧筋全中
        else if (hit > 0) base *= 0.65;        // 单侧筋
        if (kabeSafe(tile, ownHand)) base *= 0.5;
    }
    return base * Math.min(1, 0.2 + threat * 0.8); // 对手越像听牌，危险越实在
    // 调参 2026-09-29：0.3+threat 在 threat=0.7 时直接拉满 1.0，太悲观 → 0.2+0.8*threat 缓和
}
// 检查某玩家打出这张牌，是否会点炮给别的玩家（公开信息版：不再读对手暗牌，
// 改用危险度模型；给"这一刻打出去是否危险"一个诚实估计）
function isTileDangerousFor(player, tile) {
    return Game.turnOrder.some(p => p !== player && publicDangerVs(player, tile, p) >= 0.5);
}

// 轴2扩展：对手"看起来要听牌了"的启发式风险分（不是读心，纯看得见的信号）——
// 跟 isTileDangerousFor 互补：那个查的是"这一刻打出去必死"，这个查的是"这家开始有听牌相"，
// 用来提前收一收，而不是等对方真听了才后知后觉
function estimateTenpaiRisk(opponent) {
    let risk = 0;
    const melds = Game.exposedMelds[opponent] ? Game.exposedMelds[opponent].length : 0;
    risk += melds * 0.35;
    if (melds >= 3) risk += 0.4; // 穷胡规则最多3组副露，到顶了基本就是在等最后一口
    const recent = Game.discardPile.filter(d => d.player === opponent).slice(-4);
    if (recent.length >= 3) {
        const midCount = recent.filter(d => {
            const s = Game.tileSuit(d.tile), r = Game.tileRank(d.tile);
            return s !== '字' && r >= 4 && r <= 6;
        }).length;
        if (midCount === recent.length) risk += 0.3; // 连续切中张：该扔的边张/字牌早扔完了，牌型收紧
    }
    return Math.min(risk, 1.2);
}

// 给定手牌+副露，若已是听牌形态，返回可胡的牌列表，否则 []
// 听牌缓存：结果只取决于 暗牌 + 副露(含类型/是否暗杠) + 该玩家的亮牌加成，按这三样做键。
// render 每次都要给四家算听牌提示、给手牌算危险标记，命中缓存后不再重复扫 34 种牌
const _winTilesCache = new Map();
function getWinningTilesOf(concealed, exposed, player) {
    const neededLen = (4 - exposed.length) * 3 + 2;
    if (concealed.length !== neededLen - 1) return [];
    const key = (player || '') + (player && Game.windDragonBonus[player] ? '+' : '-') + '|'
        + concealed.slice().sort().join(',') + '|'
        + exposed.map(m => m.type + (m.concealed ? 'c' : '') + m.tiles.join('')).join(';');
    let res = _winTilesCache.get(key);
    if (res === undefined) {
        res = Game.allTileTypes().filter(t => Game.checkHu([...concealed, t], exposed, player));
        if (_winTilesCache.size > 3000) _winTilesCache.clear();
        _winTilesCache.set(key, res);
    }
    return res.slice(); // 返回副本，调用方随便改也不会污染缓存
}

function chooseAiDiscardTile(hand, player) {
    const exposed = Game.exposedMelds[player];
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
        const prev = Game.aiWaitTiles[player] || [];
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
        Game.aiWaitTiles[player] = chosen.wins;
        return chosen.tile;
    }
    // 已无法保听（或尚未上听）→ 清空听口记忆；按「向听优先 + 安全 + 保留档」舍牌
    Game.aiWaitTiles[player] = [];

    // AI 3.0：字典序（向听→穷胡→进张→保留→危险）+ EV 攻守 + 7轴微调
    // 保听段已在上方处理；这里处理未听牌/无法保听的一般弃牌
    return Game.chooseDiscard3(hand, exposed, player, style);
}

function aiDiscard(player) {
    if (Game.gameOver) return;
    const hand = Game.hands[player];
    if (hand.length === 0) { advanceTurn(); return; } // 防御性检查：正常情况下不会发生
    // AI 加杠 / 暗杠：未听牌时执行（加杠需处理抢杠；暗杠不计抢杠）
    if (!Game.isTenpai(player)) {
        for (const meld of Game.exposedMelds[player]) {
            if (meld.type === 'peng' && hand.includes(meld.tiles[0])) {
                const gTile = meld.tiles[0];
                const robber = findRonPriority(player, gTile);
                if (robber) {
                    if (robber === 'bottom') {
                        // 抢杠的牌直接转给 bottom（offerHu 内原子完成），不在此先拆
                        Game.offerHu({ mode: 'dianpao', tile: gTile, fromPlayer: player, robGang: true });
                        return;
                    }
                    Game.TileFlow.transfer(player, robber, gTile);
                    Game.gameOver = true;
                    Game.winner = robber;
                    const before = [...Game.hands[robber]];
                    before.splice(before.indexOf(gTile), 1);
                    const bonus = Game.scoreWinningHand(before, gTile, Game.exposedMelds[robber], false);
                    const result = Game.settleScore(robber, 'dianpao', player, bonus);
                    Game.clearKongFlags();
                    Game.logFlow(Game.nameOf(robber) + ' 抢杠胡了 ' + Game.nameOf(player) + '！' + result.detail);
                    Game.speak('胡了，' + Game.voiceName(player) + '点炮');
                    Game.learnFromWin(robber, player, { fan: bonus.mult, turns: Game.handTurnCount });
                    Game.requestRender('aiDiscard/rob');
                    Game.showResultModal(robber, 'dianpao', player, bonus, result, gTile);
                    return;
                }
                Game.TileFlow.addGang(player, gTile);
                Game.logFlow(Game.nameOf(player) + ' 加杠 ' + Game.tileGlyph(gTile));
                Game.speak('杠' + Game.tileName(gTile));
                Game.sfx.gang(); Game.feel.banner('杠！');
                Game.requestRender('aiDiscard/jia');
                aiDrawReplacement(player);
                return;
            }
        }
        if (Game.exposedMelds[player].length < 3) {
            const counts = {};
            for (const t of hand) counts[t] = (counts[t] || 0) + 1;
            let gangTile = null;
            for (const t of Object.keys(counts)) {
                if (counts[t] >= 4) { gangTile = t; break; }
            }
            if (gangTile) {
                Game.TileFlow.meld(player, 'gang', [gangTile, gangTile, gangTile, gangTile], { concealed: true });
                Game.logFlow(Game.nameOf(player) + ' 暗杠 ' + Game.tileGlyph(gangTile));
                Game.speak('杠' + Game.tileName(gangTile));
                Game.sfx.gang(); Game.feel.banner('杠！');
                Game.requestRender('aiDiscard/an');
                aiDrawReplacement(player);
                return;
            }
        }
    }
    // 保牌策略：孤立字牌 > 孤立中张(非4/5/6优先) > ... > 对子最后才拆，同等级优先选不点炮的
    const tile = chooseAiDiscardTile(hand, player);
    Game.TileFlow.discard(player, tile);
    Game.markKongDiscardIfNeeded(player);
    Game.validateHandCounts('aiDiscard');
    Game.requestRender('aiDiscard/discard');
    Game.sfx.discard(); // 手感：AI 出牌脆响 + 从座位飞牌
    Game.feel.flyAiDiscard(player, Game.tileImg(tile));
    Game.speak(Game.tileName(tile));

    // 多家可以胡的话，按下家方向离出牌人最近的先胡
    const ronPlayer = findRonPriority(player, tile);
    if (ronPlayer === 'bottom') {
        Game.offerHu({ mode: 'dianpao', tile, fromPlayer: player });
        return;
    }
    if (ronPlayer) {
        Game.TileFlow.takeDiscardToHand(ronPlayer);
        Game.gameOver = true;
        Game.winner = ronPlayer;
        const before = [...Game.hands[ronPlayer]];
        before.splice(before.indexOf(tile), 1);
        const bonus = Game.scoreWinningHand(before, tile, Game.exposedMelds[ronPlayer], false);
        Game.applyKongBonuses(bonus, ronPlayer, 'dianpao', player);
        const result = Game.settleScore(ronPlayer, 'dianpao', player, bonus);
        Game.clearKongFlags();
        Game.logFlow(Game.nameOf(player) + ' 点炮，' + Game.nameOf(ronPlayer) + ' 胡了！' + result.detail);
        Game.speak('胡了，' + Game.voiceName(player) + '点炮');
        Game.learnFromWin(ronPlayer, player, { fan: bonus.mult, turns: Game.handTurnCount });
        Game.requestRender('aiDiscard/ron');
        Game.showResultModal(ronPlayer, 'dianpao', player, bonus, result, tile);
        return;
    }

    // 无人点炮：杠后点炮标记失效
    if (Game.afterKongDiscardPlayer === player) Game.afterKongDiscardPlayer = null;
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
        const suit = Game.tileSuit(t), rank = Game.tileRank(t);
        if (suit === '字') continue;
        if (hand.includes((rank + 1) + suit)) return false;
    }
    return true;
}

/** 是否应该碰/杠：EV 统一比较为主（叫后状态期望 vs 不叫期望，取高者）。
 *  手里 3 张暗 + 这张时按"明杠"算 EV（含补牌期望），否则按"碰"算。
 *  中发白刻子×2番、补穷胡缺项的价值已进 EV（winValue 龙刻加成 / qhDiscount），不再另行加分。
 *  学习偏好（轴1 吃碰激进度 / 轴3 冲特殊牌型）以 EV 点数偏移参与；归因由 findAiPeng 做。 */
function shouldAiPeng(p, tile, overrides) {
    overrides = overrides || {};
    if (Game.isTenpai(p)) return false; // 已上听不碰，避免拆听
    const style = aiPersonality[p] || 'shrewd';
    const learn = Game.aiLearn.confidence[style] || {};
    // conf=轴1(吃碰激进度)的学习值；chaseConf=轴3(特殊牌型追逐)的学习值；两条轴分开学，互不影响
    const conf = overrides.callAggr !== undefined ? overrides.callAggr : (learn.callAggr || 0);
    const chaseConf = overrides.chaseSpecial !== undefined ? overrides.chaseSpecial : (learn.chaseSpecial || 0);
    const exposed = Game.exposedMelds[p];
    if (exposed.length >= 3) return false; // 穷胡：不能手把一

    const hand = Game.hands[p];
    const cnt = hand.filter(x => x === tile).length;
    const kind = cnt >= 3 ? 'gang' : 'peng';
    let r;
    try { r = Game.meldCallEV(p, tile, kind, null); }
    catch (e) { return false; }

    // 向听硬轨 + 特殊牌型追逐（AI 3.0 性格引擎）：
    // 静态 chaseSpecialSlack 是"冲碰碰胡时额外容忍的向听损失档数"，学习轴 chaseSpecial 是增量
    const trait = Game.aiTraitOf(p);
    const chasing = isGoingForTriplets(hand) ? 1 : 0;
    const baseSlack = style === 'conservative' ? 0 : 1;
    const chaseSlack = chasing ? Math.max(0, Math.min(2, (trait.chaseSpecialSlack || 0) + (chaseConf || 0))) : 0;
    if (r.shanAfter > r.shanBefore + baseSlack + chaseSlack) return false;

    // 进张保留 veto（ukeireKeepAt）：碰/杠后进张掉得太多就别叫（保守：腰斩就 veto）
    const keepAt = trait.ukeireKeepAt;
    if (keepAt > 0 && r.ukBefore > 0 && r.ukAfter < r.ukBefore * keepAt) return false;

    // 将保护：碰掉唯一的对子等于拆将（中发白对子本身可作将，不在此限）
    const pairCount = h => {
        const c = {};
        for (const t of h) c[t] = (c[t] || 0) + 1;
        return Object.values(c).filter(n => n >= 2).length;
    };
    const afterSim = hand.slice();
    afterSim.splice(afterSim.indexOf(tile), 1);
    afterSim.splice(afterSim.indexOf(tile), 1);
    const isDragon = Game.dragonTilesArr.includes(tile);
    if (pairCount(afterSim) === 0 && pairCount(hand) > 0 && !isDragon) return false;

    // EV 偏移：轴1 + 轴3（冲碰碰胡时）− 副露数量成本（保守最忌多副露）
    const meldCost = exposed.length * (style === 'conservative' ? 80 : style === 'shrewd' ? 50 : 30);
    const off = conf * 60 + (chasing ? chaseConf * 40 : 0) - meldCost;
    return (r.evCall + off) > r.evPass;
}

// 除discarder外，检查是否有AI能碰（或杠）这张牌，且局势上值得碰
function findAiPeng(discarder, tile) {
    for (const p of ['top', 'left', 'right']) {
        if (p === discarder) continue;
        if (Game.exposedMelds[p].length >= 3) continue; // 穷胡规则：不能手把一，最多3组面子在外
        if (!Game.canPeng(Game.hands[p], tile)) continue;
        const actual = shouldAiPeng(p, tile);
        // 归因：把轴1/轴3的学习值分别归零，看这个决定是不是因为学到的东西才变了
        // （分别只归零一条、另一条保持实际值，这样才是这条轴自己的影响，不会互相混)
        if (shouldAiPeng(p, tile, { callAggr: 0 }) !== actual) Game.markAxisUsed(p, 'callAggr');
        if (shouldAiPeng(p, tile, { chaseSpecial: 0 }) !== actual) Game.markAxisUsed(p, 'chaseSpecial');
        if (actual) return p;
    }
    return null;
}

// 多家能胡这张牌时，按下家方向（离出牌人最近的下家优先）找第一个能胡的玩家，找不到返回null
function findRonPriority(discarder, tile) {
    const idx = Game.turnOrder.indexOf(discarder);
    for (let step = 1; step <= 3; step++) {
        const p = Game.turnOrder[(idx + step) % Game.turnOrder.length];
        const hand = p === 'bottom' ? [...Game.hands.bottom, tile] : [...Game.hands[p], tile];
        if (Game.checkHu(hand, Game.exposedMelds[p], p)) return p;
    }
    return null;
}

function nextPlayerOf(p) {
    const idx = Game.turnOrder.indexOf(p);
    return Game.turnOrder[(idx + 1) % Game.turnOrder.length];
}

// 只有出牌者的下家能吃；如果下家是AI，检查AI是否能吃
/** 是否应该吃：EV 统一比较为主（吃后状态期望 vs 不吃期望，取高者），
 *  向听硬轨 + 转守门槛作安全轨。学习偏好（轴1 吃碰激进度）以 EV 点数偏移参与，
 *  偏移改变决策时记归因。 */
function shouldAiChi(player, tile, combo) {
    if (Game.isTenpai(player)) return false;
    const exposed = Game.exposedMelds[player];
    if (exposed.length >= 3) return false;
    const style = aiPersonality[player] || 'shrewd';
    const conf = (Game.aiLearn.confidence[style] && Game.aiLearn.confidence[style].callAggr) || 0;
    let r;
    try { r = Game.meldCallEV(player, tile, 'chi', combo); }
    catch (e) { return false; }
    // 向听硬轨：吃不能把牌打烂（保守最严；沿用旧性格线）
    if (style === 'conservative' && r.shanAfter > r.shanBefore) return false;
    if (style !== 'conservative' && r.shanAfter > r.shanBefore + 1) return false;
    // 进张保留 veto（ukeireKeepAt）：吃后进张掉得太多就别吃（保守：腰斩就 veto）
    const trait = Game.aiTraitOf(player);
    const keepAt = trait.ukeireKeepAt;
    if (keepAt > 0 && r.ukBefore > 0 && r.ukAfter < r.ukBefore * keepAt) return false;
    const open = Game.isKaimen(exposed);
    // EV 偏移：未开门时开门本身值钱（没开门自摸/点炮×2惩罚）→ +120；
    // 已有副露越多，再吃的信息代价越大 → 按性格扣减（保守最忌多副露）
    const meldCost = exposed.length * (style === 'conservative' ? 80 : style === 'shrewd' ? 50 : 30);
    const off = conf * 60 + (open ? 0 : 120) - meldCost;
    const evTake = r.evCall + off;
    // 找门模式：combo 里的牌上家打出过（将来吃到的机会大）→ slight bonus。
    // 吃的牌一定来自上家（规则），这里看的是 combo 另两张：同牌 +30，同花色 +15（权重减半）。
    // 只动 chi 路径，peng/gang 不动。
    let seekBonus = 0;
    try {
        if (typeof Game.isMeldSeeking === 'function' && Game.isMeldSeeking(player)) {
            const kc = Game.kamichaDiscardCounts(player);
            for (const t of (combo || [])) {
                if ((kc[t] || 0) > 0) seekBonus += 30;
                else {
                    const s = Game.tileSuit(t);
                    if (s !== '字') {
                        for (const k in kc) {
                            if (Game.tileSuit(k) === s) { seekBonus += 15; break; }
                        }
                    }
                }
            }
        }
    } catch (e) {}
    // 转守：EV 必须明显为正（>120 净胜）才吃
    const take = (evTake + seekBonus) > r.evPass;
    // 轴1归因：跟"没学过(conf=0)"时会不会选得不一样比一比
    if (take !== (r.evCall > r.evPass)) Game.markAxisUsed(player, 'callAggr');
    return take;
}

function findAiChi(discarder, tile) {
    const next = nextPlayerOf(discarder);
    if (next === 'bottom') return null; // 你的吃已经在别处处理
    if (Game.isTenpai(next)) return null; // 已上听不吃，避免拆听
    if (Game.exposedMelds[next].length >= 3) return null; // 穷胡规则：不能手把一
    const combos = Game.findChiCombos(Game.hands[next], tile);
    if (!combos.length) return null;
    // 多种吃法：先过 EV 决策门槛，再按"吃后状态期望"选最高的吃法（统一 EV 比较）
    let best = null;
    let bestEV = -Infinity;
    for (const combo of combos) {
        if (!shouldAiChi(next, tile, combo)) continue;
        let ev = -Infinity;
        try { ev = Game.meldCallEV(next, tile, 'chi', combo).evCall; } catch (e) {}
        if (ev > bestEV) {
            bestEV = ev;
            best = combo;
        }
    }
    return best ? { player: next, combo: best } : null;
}

function aiPengClaim(p, tile) {
    Game.lastCallTurn[p] = Game.handTurnCount; // 归因细化：记这次碰/杠发生在第几巡
    if (Game.trackAiCall) Game.trackAiCall(p); // AI 3.0 分化度：记一次吃碰
    const cnt = Game.hands[p].filter(x => x === tile).length;
    // 凑齐3张暗的+这张：EV 比较"明杠（补牌期望+番）"vs"碰（手牌灵活）"，取高者；否则碰
    let useGang = cnt >= 3;
    if (useGang) {
        try {
            const rG = Game.meldCallEV(p, tile, 'gang', null);
            const rP = Game.meldCallEV(p, tile, 'peng', null);
            useGang = rG.evCall > rP.evCall;
        } catch (e) { useGang = true; }
    }
    const takeCount = useGang ? 3 : 2;
    Game.TileFlow.claim(p, useGang ? 'gang' : 'peng',
        Array(takeCount).fill(tile), null, useGang ? { concealed: false } : undefined);
    Game.currentIndex = Game.turnOrder.indexOf(p);
    if (useGang) {
        Game.logFlow(Game.nameOf(p) + ' 杠了 ' + Game.tileGlyph(tile));
        Game.speak('杠' + Game.tileName(tile));
        Game.sfx.gang(); Game.feel.banner('杠！');
        Game.requestRender('aiPengClaim/gang');
        aiDrawReplacement(p);
    } else {
        Game.logFlow(Game.nameOf(p) + ' 碰了 ' + Game.tileGlyph(tile));
        Game.speak('碰' + Game.tileName(tile));
        Game.sfx.peng(); Game.feel.banner('碰！');
        Game.requestRender('aiPengClaim/peng');
        Game.setPhase(Game.PHASE.WAIT_DISCARD, 'aiPengClaim');
        Game.scheduleAi(() => aiDiscard(p), Game.aiThinkMs(), 'aiPengClaim/aiDiscard');
    }
}

function aiChiClaim(p, tile, combo) {
    Game.lastCallTurn[p] = Game.handTurnCount; // 归因细化：记这次吃发生在第几巡
    if (Game.trackAiCall) Game.trackAiCall(p); // AI 3.0 分化度：记一次吃碰
    Game.TileFlow.claim(p, 'chi', combo, Game.tileCompare);
    Game.currentIndex = Game.turnOrder.indexOf(p);
    Game.logFlow(Game.nameOf(p) + ' 吃了 ' + Game.tileGlyph(tile));
    Game.speak('吃' + Game.tileName(tile));
    Game.sfx.chi(); Game.feel.banner('吃！');
    Game.requestRender('aiChiClaim');
    Game.setPhase(Game.PHASE.WAIT_DISCARD, 'aiChiClaim');
    Game.scheduleAi(() => aiDiscard(p), Game.aiThinkMs(), 'aiChiClaim/aiDiscard');
}

// AI杠后摸替补牌，检查杠上开花，否则继续正常出牌
function aiDrawReplacement(p) {
    Game.setPhase(Game.PHASE.REPLACEMENT, 'aiDrawReplacement');
    if (Game.deck.length <= Game.DEAD_WALL) { Game.declareDraw(); return; }
    const drawn = Game.TileFlow.draw(p, 'replacement');
    Game.hands[p].sort(Game.tileCompare);
    Game.lastDrawnTile[p] = drawn;
    Game.lastDrawWasFinal[p] = Game.deck.length === Game.DEAD_WALL;
    Game.markKongDraw(p);
    Game.validateHandCounts('aiDrawReplacement');
    Game.requestRender('aiDrawReplacement');
    // 杠后补牌与普通摸牌一致：先检查亮牌
    const revealKind = Game.revealKindAfterDraw(p);
    if (revealKind) {
        if (!Game.applyReveal(p, revealKind)) return; // 补牌时牌墙已尽，流局已处理
        // 亮出东南西北又补了一张：之后胡牌不再算杠上开花
        if (revealKind === 'winds') Game.clearKongFlags();
        Game.requestRender('aiDrawReplacement/reveal');
    }
    // 亮牌（东南西北）可能又补了一张：以实际最后摸到的牌为准
    const winTile = Game.lastDrawnTile[p];
    const winIsLast = Game.lastDrawWasFinal[p];
    if (Game.checkHu(Game.hands[p], Game.exposedMelds[p], p)) {
        Game.gameOver = true;
        Game.winner = p;
        const before = [...Game.hands[p]];
        before.splice(before.indexOf(winTile), 1);
        const bonus = Game.scoreWinningHand(before, winTile, Game.exposedMelds[p], winIsLast);
        Game.applyKongBonuses(bonus, p, 'selfdraw', null);
        const result = Game.settleScore(p, 'selfdraw', null, bonus);
        Game.clearKongFlags();
        Game.logFlow(Game.nameOf(p) + ' 杠上开花！自摸胡牌！' + result.detail);
        Game.speak('胡了，自摸');
        Game.learnFromWin(p, null, { fan: bonus.mult, turns: Game.handTurnCount });
        Game.requestRender('aiDrawReplacement/hu');
        Game.showResultModal(p, 'selfdraw', null, bonus, result, winTile);
        return;
    }
    Game.setPhase(Game.PHASE.WAIT_DISCARD, 'aiDrawReplacement');
    Game.scheduleAi(() => aiDiscard(p), Game.aiThinkMs(), 'aiDrawReplacement/aiDiscard');
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
    const canClaimMore = Game.exposedMelds.bottom.length < 3;
    const canP = canClaimMore && Game.canPeng(Game.hands.bottom, tile);
    const canG = canClaimMore && Game.canGang(Game.hands.bottom, tile);
    const chiCombos = (canClaimMore && player === 'left') ? Game.findChiCombos(Game.hands.bottom, tile) : []; // 只能吃上家的牌
    if (canP || canG || chiCombos.length) {
        Game.pendingClaim = { tile, fromPlayer: player, canPeng: canP, canGang: canG, chiCombos, mode: 'claim' };
        Game.setPhase(Game.PHASE.CLAIM_PROMPT, 'checkClaimOrAdvance');
        const options = [canG ? '杠' : null, canP ? '碰' : null, chiCombos.length ? '吃' : null].filter(Boolean).join('/');
        Game.showIndicator(options, true);
        Game.logFlow('可以' + options + '，点确认执行 / 点过');
        return;
    }
    resolveAiPengOrAdvance(player, tile);
}

function advanceTurn() {
    if (Game.gameOver) return;
    Game.currentIndex = (Game.currentIndex + 1) % Game.turnOrder.length;
    Game.scheduleAi(() => Game.nextTurn(), 500, 'advanceTurn/nextTurn');
}


/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.aiPersonality = aiPersonality;
// 按玩家取静态性格参数（AI 3.0 性格引擎：静态底色 + 学习增量）
Game.aiTraitOf = function(player) {
    const style = aiPersonality[player] || 'shrewd';
    return AI_TRAITS[style] || AI_TRAITS.shrewd;
};
Game.publicDangerVs = publicDangerVs;
Game.getWinningTilesOf = getWinningTilesOf;
Game.chooseAiDiscardTile = chooseAiDiscardTile;
Game.shouldAiPeng = shouldAiPeng;
Game.shouldAiChi = shouldAiChi;
Game.aiDiscard = aiDiscard;
Game.findRonPriority = findRonPriority;
Game.nextPlayerOf = nextPlayerOf;
Game.resolveAiPengOrAdvance = resolveAiPengOrAdvance;
Game.checkClaimOrAdvance = checkClaimOrAdvance;

;})();
