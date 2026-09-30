;(function(){
// ============ 19-ai-efficiency.js：有效进张（剩余张数加权）+ 字典序弃牌评分 ============
// AI 3.0 P0-2。只用公开信息 + 自己的手牌做决策，不读对手暗牌。
// 字典序：向听（小好）→ 一阶进张（大好）→ 二阶进张（大好）→ 保留价值（小好=该打）→ 危险度（小好）

function indexToTile(i) {
    if (i < 9) return (i + 1) + '万';
    if (i < 18) return (i - 9 + 1) + '条';
    if (i < 27) return (i - 18 + 1) + '筒';
    return (i - 27 + 1) + '字';
}

// 剩余可摸张数 = 4 - 公开已见（弃牌+明副露）- 自己手牌持有
// 对手暗牌看不见，按"还在牌墙里"计（公平：不偷看，只按公开信息算）
function remainingCount(tile, ownHand) {
    let n = 4 - Game.tileSeenCount(tile);
    if (ownHand) for (const t of ownHand) if (t === tile) n--;
    return n > 0 ? n : 0;
}

// 一阶有效进张（加权）：打出后手牌的向听能被哪些牌改善，按剩余张数加权求和
// hand = 打出后的手牌（13 张或更少，副露另计）
function ukeire1Raw(hand, exposed) {
    const s0 = Game.estimateShanten(hand, exposed);
    let sum = 0;
    for (let i = 0; i < 34; i++) {
        const t = indexToTile(i);
        const rem = remainingCount(t, hand);
        if (!rem) continue;
        if (Game.estimateShanten(hand.concat([t]), exposed) < s0) sum += rem;
    }
    return sum;
}

// 二阶有效进张：摸到一张一阶进张后，手牌进张数的剩余加权平均（衡量"下下手"的厚度）
function ukeire2Raw(hand, exposed, discard) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(discard), 1);
    const s0 = Game.estimateShanten(rest, exposed);
    let wSum = 0, wTot = 0;
    for (let i = 0; i < 34; i++) {
        const t = indexToTile(i);
        const rem = remainingCount(t, rest);
        if (!rem) continue;
        const after = rest.concat([t]);
        if (Game.estimateShanten(after, exposed) >= s0) continue;
        wSum += rem * ukeire1Raw(after, exposed);
        wTot += rem;
    }
    return wTot ? wSum / wTot : 0;
}

// 保留价值：这张牌"值得留下"的程度（高=不该打）。只是并列时的微调，主力是进张。
function tileKeepValue(tile, rest, exposed) {
    const suit = Game.tileSuit(tile), rank = Game.tileRank(tile);
    let v = 0;
    // 幺九刚需：手牌+副露一张幺九没有时，幺九牌价值拉高
    if (Game.rulesConfig.mustYaojiu) {
        let hasYaojiu = false;
        for (const t of rest) {
            const s = Game.tileSuit(t), r = Game.tileRank(t);
            if (s === '字' || r === 1 || r === 9) { hasYaojiu = true; break; }
        }
        if (!hasYaojiu && exposed.length) {
            for (const m of exposed) for (const t of m.tiles) {
                const s = Game.tileSuit(t), r = Game.tileRank(t);
                if (s === '字' || r === 1 || r === 9) { hasYaojiu = true; break; }
            }
        }
        if (!hasYaojiu && (suit === '字' || rank === 1 || rank === 9)) v += 10;
    }
    if (suit !== '字') {
        if (rank >= 4 && rank <= 6) v += 3;
        else if (rank === 3 || rank === 7) v += 2;
        else v += 1;
    } else {
        v += 1;
        if (rank >= 5) v += 1; // 中发白：役牌候选
    }
    return v;
}

// 综合危险度（多家）：1 - Π(1 - Pdeal)，只用公开信息
function combinedDanger(player, tile) {
    let safe = 1;
    for (const opp of Game.turnOrder) {
        if (opp === player) continue;
        const p = Game.publicDangerVs(player, tile, opp);
        safe *= (1 - Math.min(0.95, Math.max(0, p)));
    }
    return 1 - safe;
}

// 对一张候选弃牌打分（uk1/uk2 懒算：先只算向听+穷胡，剪枝后再算进张）
function scoreDiscard(hand, exposed, player, discard) {
    const rest = hand.slice();
    const di = rest.indexOf(discard);
    if (di < 0) return null;
    rest.splice(di, 1);
    return {
        tile: discard,
        shanten: Game.estimateShanten(rest, exposed),
        uk1: null, // 懒算
        uk2: null, // 懒算
        keepValue: tileKeepValue(discard, rest, exposed),
        danger: combinedDanger(player, discard),
        rest: rest,
    };
}

// 补算进张（剪枝后调用）
function fillUkeire(scored, hand, exposed) {
    for (const s of scored) {
        if (s.uk1 === null) s.uk1 = ukeire1Raw(s.rest, exposed);
    }
}
// 字典序比较：返回负数选 a。decider 输出哪一轴定的胜负（给教练理由用）
function cmpDiscard(a, b, wantDecider) {
    let by = '';
    let r = 0;
    if (a.shanten !== b.shanten) { r = a.shanten - b.shanten; by = 'shanten'; }
    else if (a.uk1 !== null && b.uk1 !== null && a.uk1 !== b.uk1) { r = b.uk1 - a.uk1; by = 'uk1'; }
    else if (a.keepValue !== b.keepValue) { r = a.keepValue - b.keepValue; by = 'keep'; }
    else if (a.danger !== b.danger) { r = a.danger - b.danger; by = 'danger'; }
    if (wantDecider) wantDecider.by = by;
    return r;
}

// 字典序选最优弃牌。返回 { tile, scores, decider }
// 剪枝：先按（向听，穷胡）粗排，只对最优向听+1 档内的候选算进张
function chooseDiscardLex(hand, exposed, player) {
    const uniq = [...new Set(hand)];
    const scored = [];
    for (const t of uniq) {
        const s = scoreDiscard(hand, exposed, player, t);
        if (s) scored.push(s);
    }
    if (!scored.length) return null;
    // 先按向听粗排
    scored.sort((a, b) => a.shanten - b.shanten);
    const bestShan = scored[0].shanten;
    // 只保留向听最优+1 档内的候选（性格松紧可调，这里先硬剪枝保证速度）
    const pruned = scored.filter(s => s.shanten <= bestShan + 1);
    fillUkeire(pruned, hand, exposed);
    // 按 (shanten, uk1) 排序（uk2 已从热路径移除：单次 ~100ms 太贵）
    pruned.sort((a, b) => {
        if (a.shanten !== b.shanten) return a.shanten - b.shanten;
        return b.uk1 - a.uk1;
    });
    const decider = { by: '' };
    pruned.sort((a, b) => cmpDiscard(a, b));
    if (pruned.length > 1) cmpDiscard(pruned[0], pruned[1], decider);
    else decider.by = 'only';
    return { tile: pruned[0].tile, scores: pruned[0], decider: decider.by, all: pruned };
}

/* ---- 对外接口 ---- */
Game.indexToTile = indexToTile;
Game.remainingCount = remainingCount;
Game.ukeire1Raw = ukeire1Raw;
Game.ukeire2Raw = ukeire2Raw;
Game.scoreDiscard = scoreDiscard;
Game.chooseDiscardLex = chooseDiscardLex;
Game.combinedDanger = combinedDanger;

// 教练模式：给 bottom（你）推荐一张弃牌 + 一句话理由。只在轮到你弃牌时生效。
// 与 AI 主弃牌路径共用同一最终决策核心（Game.chooseDiscardCore），只是在外层包一层"为什么"的解释。
function coachRecommend() {
    const hand = Game.hands.bottom;
    const ex = Game.exposedMelds.bottom || [];
    if (!hand || !hand.length) return null;
    if (Game.turnOrder[Game.currentIndex] !== 'bottom' || Game.gameOver) return null;
    if (Game.pendingClaim && Game.pendingClaim.mode !== 'selfGang') return null;
    const need = (4 - ex.length) * 3 + 2;
    if (hand.length !== need) return null; // 不是弃牌时机（等吃碰杠亮/已听牌不打扰）
    if (typeof Game.chooseDiscardCore !== 'function') return null;
    const core = Game.chooseDiscardCore(hand, ex, 'bottom', 'shrewd');
    if (!core) return null;
    const s = core.winner;
    const shantenName = n => n < 0 ? '已胡' : n === 0 ? '听牌' : n + '向听';
    let reason;
    // 用决策核心的分项解释"为什么是这张"：看它是在哪一轴上赢了第二名
    if (core.decider === 'shanten') reason = '向听最优（' + shantenName(s.shanten) + '）';
    else if (core.decider === 'qh') reason = '胡牌资格最稳（' + shantenName(s.shanten) + '）';
    else if (core.decider === 'uk1') reason = '进张最多（' + s.uk1 + '张可进）';
    else if (core.decider === 'keep') reason = '这张最没用';
    else if (core.decider === 'danger') reason = '这张最安全';
    else if (core.decider === 'ev') reason = '攻守兼顾的最优解';
    else reason = '综合最优';
    if (core.stance === 'fold') reason += '（已转守，优先避铳）';
    return { tile: core.tile, reason: reason };
}
Game.coachRecommend = coachRecommend;
})();
