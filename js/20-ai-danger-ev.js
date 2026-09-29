;(function(){
// ============ 20-ai-danger-ev.js：EV 攻守框架 ============
// AI 3.0 P0-4。EV = P和×和牌价值 − P放铳×损失 − P被自摸×损失 + P流局听牌×价值
// 只用公开信息 + 自己的手牌，不读对手暗牌。

// ---------- 放铳概率 ----------
// 单张弃牌的放铳概率 ≈ 综合危险度（多家）：1 - Π(1 - Pdeal)
function pDealIn(player, tile) {
    return Game.combinedDanger(player, tile);
}

// ---------- 听口分类 + 剩余张数完整建模（AI 3.0 P1） ----------
// 听口类型与基础和率系数（以双面听为锚 1.0）
const WAIT_COEFF = {
    ryanmen: 1.00,  // 双面听
    shanpon: 0.80,  // 双碰听
    kanchan: 0.62,  // 嵌张听
    penchan: 0.55,  // 边张听
    tanki: 0.50,    // 单钓听
    multi: 1.12,    // 三面及以上多面听
};
const WAIT_NAMES = { ryanmen: '双面听', shanpon: '双碰听', kanchan: '嵌张听', penchan: '边张听', tanki: '单钓听', multi: '多面听' };

// 听口分类缓存：同一（暗牌+副露+亮牌加成）在一次决策里反复问，直接命中
const _waitClassCache = new Map();

// 七小对听牌形（6对+1单张）→ 单钓
function isChiitoiTenpaiShape(hand) {
    if (!hand || hand.length !== 13) return false;
    const cnt = {};
    for (const t of hand) cnt[t] = (cnt[t] || 0) + 1;
    const vals = Object.values(cnt);
    return vals.filter(v => v === 2).length === 6 && vals.filter(v => v === 1).length === 1;
}

// 听口分类：对每张可胡牌 w，还原它在和牌结构里的角色（凑将/刻子/顺子及顺子里的位置）。
// 只用 Game.decompose（公开算法）+ 自己的手牌，不读对手暗牌。
function classifyWait(hand, exposed, player) {
    const bonus = (player && Game.windDragonBonus && Game.windDragonBonus[player]) ? '+' : '-';
    const key = bonus + '|' + hand.slice().sort().join(',') + '|'
        + (exposed || []).map(m => m.type + (m.concealed ? 'c' : '') + m.tiles.join('')).join(';');
    let hit = _waitClassCache.get(key);
    if (hit) return hit;
    hit = classifyWaitRaw(hand, exposed, player);
    if (_waitClassCache.size > 2000) _waitClassCache.clear();
    _waitClassCache.set(key, hit);
    return hit;
}

function classifyWaitRaw(hand, exposed, player) {
    const fallback = { type: 'ryanmen', coeff: WAIT_COEFF.ryanmen, tiles: [] };
    let wins = [];
    try {
        if (typeof Game.getWinningTilesOf === 'function') wins = Game.getWinningTilesOf(hand, exposed, player) || [];
    } catch (e) { wins = []; }
    if (!wins.length && typeof Game.checkHu === 'function' && typeof Game.allTileTypes === 'function') {
        try { wins = Game.allTileTypes().filter(t => Game.checkHu([...hand, t], exposed, player)); } catch (e) {}
    }
    if (!wins.length) return fallback;
    if (isChiitoiTenpaiShape(hand)) return { type: 'tanki', coeff: WAIT_COEFF.tanki, tiles: wins };
    const needMelds = 4 - (exposed ? exposed.length : 0);
    const types = new Set();
    const sorted = hand.slice().sort(Game.tileCompare);
    for (const w of wins) {
        const completed = [...sorted, w].sort(Game.tileCompare);
        const counts = {};
        for (const t of completed) counts[t] = (counts[t] || 0) + 1;
        for (const p of Object.keys(counts)) {
            if (counts[p] < 2) continue;
            const rest = [];
            let skipped = 0;
            for (const t of completed) { if (t === p && skipped < 2) { skipped++; continue; } rest.push(t); }
            let decomp = [];
            try { decomp = Game.decompose(rest) || []; } catch (e) {}
            for (const d of decomp) {
                if (d.length !== needMelds) continue;
                if (p === w) {
                    // w 凑成将牌：rest 里 w 若成刻子 → 手里原来是对子（双碰）；否则是单张（单钓）
                    const wInTriplet = d.some(m => m.type === 'triplet' && m.tiles[0] === w);
                    types.add(wInTriplet ? 'shanpon' : 'tanki');
                } else {
                    const meld = d.find(m => m.tiles.includes(w));
                    if (!meld) continue;
                    if (meld.type === 'triplet') { types.add('shanpon'); continue; }
                    const ts = meld.tiles.slice().sort(Game.tileCompare);
                    const wi = ts.indexOf(w);
                    if (wi === 1) { types.add('kanchan'); continue; } // w 在顺子中间 → 嵌张
                    // w 在顺子端头：一般是双面；(1,2,3)听3 / (7,8,9)听7 是边张
                    const suit = Game.tileSuit(w), rank = Game.tileRank(w);
                    if ((rank === 3 && ts[0] === '1' + suit && ts[1] === '2' + suit) ||
                        (rank === 7 && ts[0] === '7' + suit && ts[1] === '8' + suit)) types.add('penchan');
                    else types.add('ryanmen');
                }
            }
        }
    }
    let type = 'ryanmen';
    if (types.size === 1) type = [...types][0];
    else if (types.size > 1 || wins.length >= 3) type = 'multi';
    return { type, coeff: WAIT_COEFF[type], tiles: wins };
}

// 听口质量：类型系数 + 真实剩余张数（4 − 公开已见 − 自己手牌持有）
function waitQuality(hand, exposed, player) {
    // 非听牌形张数（摸牌后的偶数张等）不做分类，给中性值
    if (!hand || (hand.length % 3) !== 1) {
        return { type: 'ryanmen', coeff: 1, tiles: [], remaining: 6, name: WAIT_NAMES.ryanmen };
    }
    const c = classifyWait(hand, exposed, player);
    let remaining = 0;
    for (const w of c.tiles) {
        let r;
        try { r = Game.remainingCount(w, hand); }
        catch (e) {
            r = 4 - (Game.tileSeenCount ? Game.tileSeenCount(w) : 0);
            for (const t of hand) if (t === w) r--;
            r = Math.max(0, r);
        }
        remaining += r;
    }
    return { type: c.type, coeff: c.coeff, tiles: c.tiles, remaining: remaining, name: WAIT_NAMES[c.type] || c.type };
}

// 穷胡资格折扣：缺三门齐/幺九/刻子时和率打折（还能补救，不是直接判死）
function qhDiscount(hand, exposed, player) {
    try {
        if (typeof Game.analyzeHu !== 'function') return 1;
        const qh = Game.analyzeHu(hand, exposed, player);
        let d = 1;
        if (!qh.sanmenqi) d *= 0.6;
        if (!qh.yaojiu) d *= 0.6;
        if (!qh.kezi) d *= 0.7;
        return d;
    } catch (e) { return 1; }
}

// ---------- 和牌概率（听口质量 × 剩余张数 × 穷胡折扣） ----------
function pWin(hand, exposed, player) {
    const s = Game.estimateShanten(hand, exposed);
    if (s < 0) return 1; // 已和（理论上不会到这里）
    const deckLen = Game.deck ? Game.deck.length : 70;
    const wallF = Math.min(1, deckLen / 40); // 牌墙越浅，和牌概率越低
    const qh = qhDiscount(hand, exposed, player);
    if (s === 0) {
        // 听牌：听口类型 × 真实剩余张数。
        // 锚定：双面听 / 6张剩余 / 满墙 / 资格全 ≈ 0.35，与旧公式同量级，不打破攻守平衡
        const wq = waitQuality(hand, exposed, player);
        const remF = Math.min(1.3, Math.max(0.15, wq.remaining / 6));
        return Math.min(0.85, Math.max(0.02, 0.35 * wq.coeff * remF * wallF * qh));
    }
    const uk = Game.ukeire1Raw(hand, exposed);
    // 基础：每远一向听 ×0.45；进张修正（uk 已是剩余张数加权）
    let p = 0.35 * Math.pow(0.45, s);
    // 进张越多，和得越快：uk=0 → ×0.3，uk=20 → ×1.2
    p *= Math.min(1.2, 0.3 + uk / 20);
    p *= wallF * qh;
    return Math.min(0.9, Math.max(0.01, p));
}

// ---------- 和牌价值（粗估） ----------
// 基于手牌结构：幺九/三门/碰牌等规则要求的达成度
function winValue(hand, exposed, player) {
    let v = 1000; // 基础
    // 副露多：可能有高番（简化）
    v += exposed.length * 200;
    // 中发白刻子：稳×2番，硬价值（吃/碰决策时能直接看到这笔账）
    try {
        if (Game.dragonTilesArr) {
            const cnt = {};
            for (const t of hand) cnt[t] = (cnt[t] || 0) + 1;
            for (const m of exposed) for (const t of m.tiles) cnt[t] = (cnt[t] || 0) + 1;
            if (Game.dragonTilesArr.some(d => (cnt[d] || 0) >= 3)) v += 800;
        }
    } catch (e) {}
    // 七小对（如果规则允许且在做）：高价值
    if (Game.ruleAllowsSevenPairs && Game.ruleAllowsSevenPairs()) {
        const cnt = {};
        for (const t of hand) cnt[t] = (cnt[t] || 0) + 1;
        const pairs = Object.values(cnt).filter(n => n >= 2).length;
        if (pairs >= 5) v += 1500;
    }
    return v;
}

// ---------- 放铳损失（粗估） ----------
// 基于对手威胁度：威胁越高，损失越大
function dealLoss(player, tile) {
    let maxThreat = 0;
    for (const opp of Game.turnOrder) {
        if (opp === player) continue;
        // 用公开威胁度（estimateTenpaiRisk 在 11 里，这里用简化版）
        const melds = (Game.exposedMelds[opp] || []).length;
        maxThreat = Math.max(maxThreat, melds * 0.35);
    }
    return 1500 + maxThreat * 2000;
}

// ---------- 弃牌 EV ----------
// EV(discard) = pWin×winValue − pDealIn×dealLoss
// pWin 用打出后的手牌算；pDealIn 用打出的牌算
function discardEV(hand, exposed, player, discard) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(discard), 1);
    const pw = pWin(rest, exposed, player);
    const wv = winValue(rest, exposed, player);
    const pd = pDealIn(player, discard);
    const dl = dealLoss(player, discard);
    return {
        ev: pw * wv - pd * dl,
        pWin: pw, winValue: wv,
        pDeal: pd, dealLoss: dl,
    };
}

// ---------- 攻守决策 ----------
// 返回 'attack' | 'fold'。基于整手牌的 EV 比较：全力攻 vs 全力守
function pushFold(hand, exposed, player) {
    // 攻击 EV：按当前向听/进张估算
    const pw = pWin(hand, exposed, player);
    const wv = winValue(hand, exposed, player);
    const attackEV = pw * wv;
    // 守：弃最安全的牌，放铳概率取最小
    let minDanger = 1;
    for (const t of new Set(hand)) {
        minDanger = Math.min(minDanger, pDealIn(player, t));
    }
    // 守的 EV ≈ −minDanger×dealLoss + 流局听牌价值（简化）
    const dl = dealLoss(player, hand[0]);
    const foldEV = -minDanger * dl * 0.5 + 300; // 流局听牌安慰分
    // 顺位修正（P1）：大领先偏守，大落后偏攻
    let bias = 0;
    try {
        bias = Game.positionBias ? Game.positionBias(player) : 0;
    } catch (e) {}
    return (attackEV + bias) >= foldEV ? 'attack' : 'fold';
}

// ---------- 综合弃牌决策（19 字典序 + 20 EV） ----------
// 先用字典序排出效率最优的几张，再用 EV 在其中选攻守平衡点
function chooseDiscard(player) {
    const hand = Game.hands[player];
    const exposed = Game.exposedMelds[player] || [];
    if (!hand || !hand.length) return null;
    const stance = pushFold(hand, exposed, player);
    const lex = Game.chooseDiscardLex(hand, exposed, player);
    if (!lex) return null;
    if (stance === 'attack') return lex.tile;
    // 守：从字典序前 3 中选 EV 最高（最安全且不太损进张）的
    const cands = lex.all.slice(0, 3);
    let best = cands[0], bestEV = -1e18;
    for (const c of cands) {
        const ev = discardEV(hand, exposed, player, c.tile).ev;
        if (ev > bestEV) { bestEV = ev; best = c; }
    }
    return best.tile;
}

// ---------- 顺位修正 ----------
// 最后两局：第4名强攻（+EV偏向攻击），首位大领先偏守。平时返回 0。
function positionBias(player) {
    const games = (Game.aiLearn && Game.aiLearn.games) || 0;
    if (games < 14) return 0; // 16 局制，最后两局才看顺位
    const scores = Game.turnOrder.map(p => ({ p: p, s: (Game.scores && Game.scores[p]) || 0 }));
    scores.sort((a, b) => b.s - a.s);
    const rank = scores.findIndex(x => x.p === player);
    if (rank === 3) return 800; // 第4名：强攻
    if (rank === 0 && scores[0].s - scores[1].s >= 3000) return -800; // 首位大领先：偏守
    return 0;
}
Game.positionBias = positionBias;

// ---------- 吃/碰/杠统一 EV 比较（AI 3.0 P1） ----------
// bestStateEV：该（手牌，副露）状态下最优弃牌的 EV 期望。
// 候选先按向听剪枝到 3 张再全量算 EV，保证速度。
function bestStateEV(hand, exposed, player) {
    const uniq = [...new Set(hand)];
    const shans = [];
    for (const t of uniq) {
        const rest = hand.slice();
        rest.splice(rest.indexOf(t), 1);
        shans.push({ t: t, s: Game.estimateShanten(rest, exposed) });
    }
    shans.sort((a, b) => a.s - b.s);
    let best = -1e18, detail = null;
    for (const c of shans.slice(0, 3)) {
        const r = discardEV(hand, exposed, player, c.t);
        if (r.ev > best) { best = r.ev; detail = r; }
    }
    return { ev: best, detail: detail };
}

// 吃/碰/杠 EV 比较：take=true 表示吃/碰/杠的期望更高。
// kind: 'chi'（combo=吃掉的搭子）/ 'peng' / 'gang'（明杠：手里3张+这张，含补牌期望）
//   EV_call = bestStateEV(叫后状态) − 信息暴露惩罚 − 灵活性惩罚 + 节奏收益（+ 杠的补牌期望）
//   EV_pass = bestStateEV(当前状态)
// 系数说明（EV 量级约 ±3000）：
//   信息暴露：副露后对手更难喂牌、手牌更好读；早巡代价大，随牌墙变浅衰减；吃暴露花色，惩罚×1.2
//   灵活性：碰/杠把暗牌从 13 张压到 10 张（杠后补回 1 张），选择面收窄的固定代价
//   节奏：叫牌后由你出牌，对手少一次中间行动机会，小额收益
//   补牌期望：明杠多一次摸牌机会，按当前进张密度折算
// 只用公开信息 + 自己的手牌，不读对手暗牌。
function meldCallEV(player, tile, kind, combo) {
    const bad = { take: false, evCall: -1e18, evPass: 0, shanBefore: 8, shanAfter: 8 };
    const hand = Game.hands[player] || [];
    const exposed = Game.exposedMelds[player] || [];
    // 张数校验（被叫的那张来自别家弃牌，不在手里）：
    // 吃：combo 两张在手里就行；碰：手里至少 2 张；明杠：手里至少 3 张
    const countInHand = hand.filter(t => t === tile).length;
    if (kind === 'chi') {
        if (!combo || !combo.length) return bad;
    } else if (kind === 'peng') {
        if (countInHand < 2) return bad;
    } else if (kind === 'gang') {
        if (countInHand < 3) return bad;
    } else {
        return bad;
    }
    const evPass = bestStateEV(hand, exposed, player);
    const shanBefore = Game.estimateShanten(hand, exposed);
    let handAfter, meldTiles, meldType;
    if (kind === 'chi') {
        handAfter = hand.slice();
        for (const t of combo) {
            const i = handAfter.indexOf(t);
            if (i < 0) return bad;
            handAfter.splice(i, 1);
        }
        meldTiles = [...combo, tile].sort(Game.tileCompare);
        meldType = 'chi';
    } else if (kind === 'peng') {
        handAfter = hand.slice();
        for (let i = 0; i < 2; i++) {
            const j = handAfter.indexOf(tile);
            if (j < 0) return bad;
            handAfter.splice(j, 1);
        }
        meldTiles = [tile, tile, tile];
        meldType = 'peng';
    } else if (kind === 'gang') {
        handAfter = hand.slice();
        for (let i = 0; i < 3; i++) {
            const j = handAfter.indexOf(tile);
            if (j < 0) return bad;
            handAfter.splice(j, 1);
        }
        meldTiles = [tile, tile, tile, tile];
        meldType = 'gang';
    }
    const exposedAfter = exposed.concat([{ type: meldType, tiles: meldTiles }]);
    const shanAfter = Game.estimateShanten(handAfter, exposedAfter);
    const evCallState = bestStateEV(handAfter, exposedAfter, player);
    const deckLen = Game.deck ? Game.deck.length : 70;
    const deckF = Math.min(1, deckLen / 70); // 牌墙开局 84 张
    const infoPenalty = 60 * deckF * (kind === 'chi' ? 1.2 : 1.0);
    const flexPenalty = (kind === 'peng' || kind === 'gang') ? 30 : 15;
    const tempoBonus = 40;
    let gangDrawBonus = 0;
    if (kind === 'gang') {
        const uk = Game.ukeire1Raw(handAfter, exposedAfter);
        gangDrawBonus = 150 * Math.min(1, uk / 30);
    }
    const evCall = evCallState.ev - infoPenalty - flexPenalty + tempoBonus + gangDrawBonus;
    return {
        take: evCall > evPass.ev,
        evCall: evCall, evPass: evPass.ev,
        shanBefore: shanBefore, shanAfter: shanAfter,
        callDetail: evCallState.detail, passDetail: evPass.detail,
    };
}
Game.meldCallEV = meldCallEV;
Game.bestStateEV = bestStateEV;
Game.waitQuality = waitQuality;
Game.classifyWait = classifyWait;
Game.qhDiscount = qhDiscount;
Game.pDealIn = pDealIn;
Game.pWin = pWin;
Game.discardEV = discardEV;
Game.pushFold = pushFold;
Game.chooseDiscard = chooseDiscard;

// ---------- AI 3.0 弃牌决策核心（chooseDiscard3 与教练模式共用） ----------
// 返回 { tile, stance, decider, winner, runnerUp, scored }。
// decider：winner 对 runnerUp 第一个分出胜负的排序轴（shanten/qh/uk1/keep/danger），
// 若转守后 EV 推翻了字典序头名则为 'ev'。教练模式用它生成"为什么"。
function chooseDiscardCore(hand, exposed, player, style) {
    const axes = (Game.aiLearn && Game.aiLearn.confidence && Game.aiLearn.confidence[style]) || {};
    const uniq = [...new Set(hand)];
    const scored = [];
    for (const t of uniq) {
        const s = Game.scoreDiscard(hand, exposed, player, t);
        if (!s) continue;
        s.qhPenalty = qhPenaltyFor(s.rest, exposed, player);
        // 7轴微调（只调参数，不碰向听/规则正确性）
        const suit = Game.tileSuit(t);
        let dangerW = 1 + (axes.defense || 0) * 0.4;
        const deckLen = Game.deck ? Game.deck.length : 70;
        if (deckLen < 20) dangerW *= 1 + (axes.wallCaution || 0) * 0.3;
        s.dangerAdj = s.danger * dangerW;
        s.keepAdj = s.keepValue + (suit === '字' ? (axes.honorHold || 0) * 2 : 0);
        scored.push(s);
        try { if (Game.markAxisUsed) {
            if (axes.defense) Game.markAxisUsed(player, 'defense');
            if (axes.honorHold && suit === '字') Game.markAxisUsed(player, 'honorHold');
            if (axes.wallCaution && deckLen < 20) Game.markAxisUsed(player, 'wallCaution');
        } } catch (e) {}
    }
    if (!scored.length) return null;
    // 剪枝：先按（向听，穷胡）粗排，只对最优+1 档算进张
    scored.sort((a, b) => {
        if (a.shanten !== b.shanten) return a.shanten - b.shanten;
        return a.qhPenalty - b.qhPenalty;
    });
    const bestShan = scored[0].shanten, bestQh = scored[0].qhPenalty;
    const pruned = scored.filter(s => s.shanten <= bestShan + 1 && s.qhPenalty <= bestQh + 2);
    // 补算 uk1
    for (const s of pruned) s.uk1 = Game.ukeire1Raw(s.rest, exposed);
    pruned.sort((a, b) => {
        if (a.shanten !== b.shanten) return a.shanten - b.shanten;
        if (a.qhPenalty !== b.qhPenalty) return a.qhPenalty - b.qhPenalty;
        return b.uk1 - a.uk1;
    });
    // 并列组补 uk2（注：ukeire2Raw 单次 ~100ms 太贵，热路径已禁用；保留函数供离线分析）
    // 实际用 uk1 的"进张种类数"作后劲代理（ukeire1Raw 内已算出，不额外花钱）
    // 细排：保留价值 → 危险度（uk2 已从热路径移除）
    pruned.sort((a, b) => {
        if (a.shanten !== b.shanten) return a.shanten - b.shanten;
        if (a.qhPenalty !== b.qhPenalty) return a.qhPenalty - b.qhPenalty;
        if (a.uk1 !== b.uk1) return b.uk1 - a.uk1;
        if (a.keepAdj !== b.keepAdj) return a.keepAdj - b.keepAdj;
        return a.dangerAdj - b.dangerAdj;
    });
    const winner = pruned[0], runnerUp = pruned[1] || null;
    let decider = 'only';
    if (runnerUp) {
        if (winner.shanten !== runnerUp.shanten) decider = 'shanten';
        else if (winner.qhPenalty !== runnerUp.qhPenalty) decider = 'qh';
        else if (winner.uk1 !== runnerUp.uk1) decider = 'uk1';
        else if (winner.keepAdj !== runnerUp.keepAdj) decider = 'keep';
        else if (winner.dangerAdj !== runnerUp.dangerAdj) decider = 'danger';
        else decider = 'tie';
    }
    // EV 攻守调制
    const stance = pushFold(hand, exposed, player);
    let tile = winner.tile;
    if (stance === 'fold') {
        // 守：前 3 名里选 EV 最高
        const cands = pruned.slice(0, 3);
        let best = cands[0], bestEV = -1e18;
        for (const c of cands) {
            const ev = discardEV(hand, exposed, player, c.tile).ev;
            if (ev > bestEV) { bestEV = ev; best = c; }
        }
        tile = best.tile;
        if (best.tile !== winner.tile) decider = 'ev'; // EV 推翻了字典序头名
        try { if (Game.markAxisUsed) Game.markAxisUsed(player, 'defense'); } catch (e) {}
    }
    return { tile: tile, stance: stance, decider: decider, winner: winner, runnerUp: runnerUp, scored: pruned };
}

// ---------- AI 3.0 主弃牌决策（给 11-ai-discard-claim.js 的 chooseAiDiscardTile 用） ----------
// 字典序：向听 → 穷胡惩罚 → 一阶进张 → 二阶进张 → 保留价值 → 危险度
// 再用 EV 攻守调制，最后用 7 学习轴做参数微调
function chooseDiscard3(hand, exposed, player, style) {
    if (!hand || !hand.length) return null;
    const core = chooseDiscardCore(hand, exposed, player, style);
    return core ? core.tile : hand[0];
}

// 穷胡规则惩罚：打出这张后，三门齐/幺九/刻子还保不保得住（标准向听看不到，靠这里补）
function qhPenaltyFor(rest, exposed, player) {
    let penalty = 0;
    try {
        const qh = Game.analyzeHu(rest, exposed, player);
        if (!qh.sanmenqi) penalty += 2;
        if (!qh.yaojiu) penalty += 2;
        if (!qh.kezi) penalty += 1;
    } catch (e) {}
    return penalty;
}
Game.chooseDiscard3 = chooseDiscard3;
Game.chooseDiscardCore = chooseDiscardCore;
})();
