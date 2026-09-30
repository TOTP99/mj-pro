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

// ---------- 和牌价值（AI 4.0 提强3：分值意识） ----------
// 估计这手牌"如果胡了"能值多少。AI 用它权衡"快胡便宜的" vs "慢做贵的"。
// 只看自己的手牌+副露，不读对手。
function winValue(hand, exposed, player) {
    let mult = 1;
    const cnt = {};
    try {
        for (const t of hand) cnt[t] = (cnt[t] || 0) + 1;
        for (const m of (exposed || [])) for (const t of m.tiles) cnt[t] = (cnt[t] || 0) + 1;
    } catch (e) {}
    // 中发白：刻子 ×2；对子有潜力 ×1.4
    try {
        if (Game.dragonTilesArr) {
            const hasTrip = Game.dragonTilesArr.some(d => (cnt[d] || 0) >= 3);
            const hasPair = Game.dragonTilesArr.some(d => (cnt[d] || 0) === 2);
            if (hasTrip) mult *= 2;
            else if (hasPair) mult *= 1.4;
        }
    } catch (e) {}
    // 碰碰胡潜力：刻子/对子结构
    const vals = Object.values(cnt);
    const triplets = vals.filter(n => n >= 3).length;
    const pairs = vals.filter(n => n >= 2).length;
    if (triplets >= 3) mult *= 5;       // 很像碰碰胡（×8 的潜力）
    else if (triplets >= 2 && pairs >= 4) mult *= 2.5;
    else if (pairs >= 5) mult *= 1.6;   // 七小对/多对子潜力
    // 门清：没副露，对手难读，有隐藏价值
    if (!exposed || exposed.length === 0) mult *= 1.25;
    // 杠：每个杠都是实打实的番
    try {
        const gangs = (exposed || []).filter(m => m.type === 'gang').length;
        if (gangs) mult *= Math.pow(1.8, gangs);
    } catch (e) {}
    // 七小对进行中（规则允许时）
    try {
        if (Game.ruleAllowsSevenPairs && Game.ruleAllowsSevenPairs() && pairs >= 5 && hand.length >= 10) {
            mult = Math.max(mult, 4); // 七小对 ×8，至少给 4
        }
    } catch (e) {}
    return 1000 * mult;
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
// pWin 用打出后的手牌算；pDealIn 用打出的牌算。
// AI 4.0：pDealIn 要乘以"对手真在听牌"的概率——没听牌时打危险牌也不点炮。
function discardEV(hand, exposed, player, discard) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(discard), 1);
    const pw = pWin(rest, exposed, player);
    const wv = winValue(rest, exposed, player);
    let pd = pDealIn(player, discard);
    // 对手听牌概率调整：取最大听牌概率作为点炮的前提概率
    try {
        let maxTenpai = 0;
        for (const opp of Game.turnOrder) {
            if (opp === player) continue;
            maxTenpai = Math.max(maxTenpai, Game.estimateOppTenpai(opp));
        }
        // 点炮 = 对手在听 × 打出被抓。用平方根缓和（别太悲观）
        pd = pd * Math.sqrt(Math.max(0.1, maxTenpai));
    } catch (e) {}
    const dl = dealLoss(player, discard);
    return {
        ev: pw * wv - pd * dl,
        pWin: pw, winValue: wv,
        pDeal: pd, dealLoss: dl,
    };
}

// ---------- 对手听牌概率（AI 4.0 提强2：读人系统化） ----------
// 综合公开信号估计某对手已听牌的概率 0~1：
//   副露数（最强信号）+ 舍牌趋势（连续切边张/字牌=牌型收紧）+ 巡数（越晚越可能听）
// 只用公开信息，不读暗牌。
function estimateOppTenpai(opp) {
    let p = 0.05; // 基础先验
    try {
        const melds = (Game.exposedMelds[opp] || []).length;
        // 副露：1组 +0.15，2组 +0.35，3组 +0.6（穷胡最多3组，到顶基本在等）
        p += [0, 0.15, 0.35, 0.6][Math.min(3, melds)] || 0;
        // 舍牌趋势：最近 4 张若全是边张/字牌，+0.2（该扔的早扔完了）
        const recent = Game.discardPile.filter(d => d.player === opp).slice(-4);
        if (recent.length >= 3) {
            const edgeCount = recent.filter(d => {
                const s = Game.tileSuit(d.tile), r = Game.tileRank(d.tile);
                return s === '字' || r === 1 || r === 9;
            }).length;
            if (edgeCount === recent.length) p += 0.2;
            else if (edgeCount >= recent.length - 1) p += 0.1;
        }
        // 巡数：每 10 巡 +0.08，上限 +0.3（别人也在往听牌走）
        const turns = Game.handTurnCount || 0;
        p += Math.min(0.3, turns / 10 * 0.08);
        // 危险牌试探：如果他最近打过高危险牌且没人胡，说明他可能还没听（敢打生张）→ -0.1
        // （这个信号较弱，只做微调）
    } catch (e) {}
    return Math.min(0.95, Math.max(0.02, p));
}
Game.estimateOppTenpai = estimateOppTenpai;

// ---------- 攻守决策 ----------
// 返回 'attack' | 'fold'。基于整手牌的 EV 比较：全力攻 vs 全力守
// 攻守阈值（AI 3.0 性格引擎）：静态 riskDefenseAt 是底色（越低越神经质、越容易转守），
// 学习轴 defense 是增量（学到的防守倾向）；顺位 bias（名次感）照常参与
function pushFold(hand, exposed, player) {
    // 攻击 EV：按当前向听/进张估算
    const pw = pWin(hand, exposed, player);
    const wv = winValue(hand, exposed, player);
    let attackEV = pw * wv;
    // AI 4.0：竞速折扣——对手很可能已听牌时，我们"先胡"的概率要打折。
    // 有人听牌，我们后胡/被截胡的概率大增。
    let oppTenpaiMax = 0;
    try {
        for (const opp of Game.turnOrder) {
            if (opp === player) continue;
            oppTenpaiMax = Math.max(oppTenpaiMax, Game.estimateOppTenpai(opp));
        }
    } catch (e) {}
    // 竞速：如果对手已听，我们先胡的概率 ×(1 - T×0.6)
    attackEV = attackEV * (1 - oppTenpaiMax * 0.6);
    // 守：弃最安全的牌，放铳概率取最小
    let minDanger = 1;
    for (const t of new Set(hand)) {
        minDanger = Math.min(minDanger, pDealIn(player, t));
    }
    // AI 4.0：守的放铳概率也要乘听牌概率（对手没听时，守的牌也不危险）
    // （oppTenpaiMax 上面已算过，直接复用）
    const tenpaiF = Math.sqrt(Math.max(0.1, oppTenpaiMax));
    minDanger = minDanger * tenpaiF;
    // 守的 EV ≈ −minDanger×dealLoss + 流局听牌价值（简化）
    const dl = dealLoss(player, hand[0]);
    const foldEV = -minDanger * dl * 0.5 + 300; // 流局听牌安慰分
    const style = Game.aiPersonality ? (Game.aiPersonality[player] || 'shrewd') : 'shrewd';
    const trait = Game.aiTraitOf ? Game.aiTraitOf(player) : null;
    const learned = (Game.aiLearn && Game.aiLearn.confidence && Game.aiLearn.confidence[style]) || {};
    // riskDefenseAt 越低，攻击侧打折越多，越容易转守（保守 0.75 / 精明 0.95 / 激进 1.15）
    const atkScale = ((trait && trait.riskDefenseAt) || 1) - (learned.defense || 0) * 0.1;
    // 顺位修正（名次感）：大领先偏守，大落后偏攻
    let bias = 0;
    try {
        bias = Game.positionBias ? Game.positionBias(player) : 0;
    } catch (e) {}
    // AI 4.0 提强2：对手听牌概率 → 攻守修正。
    // 有人很可能已听牌时，攻击的期望收益要打折（点炮风险↑）。
    // 性格差异：riskDefenseAt 越低（保守）对听牌信号越敏感，折扣越狠。
    // （oppTenpaiMax 上面已算过，直接复用）
    const riskAt = (trait && trait.riskDefenseAt) || 1;
    // 敏感度：保守 (0.75) → 0.5，精明 (0.95) → 0.3，激进 (1.15) → 0.15
    const tenpaiSens = Math.max(0.1, Math.min(0.6, (1.3 - riskAt) * 0.5));
    const tenpaiDiscount = 1 - oppTenpaiMax * tenpaiSens;
    const stance = (attackEV * atkScale * tenpaiDiscount + bias) >= foldEV ? 'attack' : 'fold';
    // 归因：防守轴 / 名次轴真正参与了这次攻守选择才记
    try { if (Game.markAxisUsed) {
        if (learned.defense) Game.markAxisUsed(player, 'defense');
        if (bias !== 0) Game.markAxisUsed(player, 'position');
    } } catch (e) {}
    return stance;
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

// ---------- 顺位修正（名次感） ----------
// 最后两局：第4名强攻（+EV偏向攻击），首位大领先偏守。平时返回 0。
// AI 3.0 学习轴 position：调整名次感的响应强度（正=更看重名次，负=更无视名次）
function positionBias(player) {
    const games = (Game.aiLearn && Game.aiLearn.games) || 0;
    if (games < 14) return 0; // 16 局制，最后两局才看顺位
    const style = Game.aiPersonality ? (Game.aiPersonality[player] || 'shrewd') : 'shrewd';
    const posLearn = (Game.aiLearn && Game.aiLearn.confidence && Game.aiLearn.confidence[style] && Game.aiLearn.confidence[style].position) || 0;
    const strength = Math.max(0.2, 1 + posLearn * 0.3); // 学到的名次感强度，保底 0.2 不归零
    const scores = Game.turnOrder.map(p => ({ p: p, s: (Game.scores && Game.scores[p]) || 0 }));
    scores.sort((a, b) => b.s - a.s);
    const rank = scores.findIndex(x => x.p === player);
    if (rank === 3) return 800 * strength; // 第4名：强攻
    if (rank === 0 && scores[0].s - scores[1].s >= 3000) return -800 * strength; // 首位大领先：偏守
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
    // 进张保留（AI 3.0 性格轴 ukeireKeepAt 用）：叫前后的一阶进张
    let ukBefore = 0, ukAfter = 0;
    try {
        ukBefore = Game.ukeire1Raw(hand, exposed);
        ukAfter = Game.ukeire1Raw(handAfter, exposedAfter);
    } catch (e) {}
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
    // AI 4.0 提强4：吃碰纪律——知道什么时候不该叫
    let disciplinePenalty = 0;
    try {
        // 纪律1：已听牌时，非明显改善不叫。叫了要换听口，风险大于收益。
        const wasTenpai = shanBefore === 0;
        if (wasTenpai && kind !== 'gang') {
            // 听牌时叫牌：只有向听不变（还是听）且进张/价值明显提升才考虑
            // 这里简化：听牌叫牌一律 +150 惩罚（约等于半个 infoPenalty），除非是杠
            disciplinePenalty += 150;
        }
        // 纪律2：门清贵重手不破。手里没副露且价值高（winValue>2000）时，
        // 吃/碰要额外付出代价——破了门清的隐藏价值。
        const isMenzen = !exposed || exposed.length === 0;
        if (isMenzen && kind !== 'gang') {
            const hv = winValue(hand, exposed, player);
            if (hv > 2500) disciplinePenalty += (hv - 2500) * 0.15;
        }
        // 纪律3：别把龙刻子拆了。碰/吃如果拆掉了手里的龙对子（未来×2的潜力），重罚。
        if ((kind === 'peng' || kind === 'chi') && Game.dragonTilesArr) {
            const cntBefore = {};
            for (const t of hand) cntBefore[t] = (cntBefore[t] || 0) + 1;
            const cntAfter = {};
            for (const t of handAfter) cntAfter[t] = (cntAfter[t] || 0) + 1;
            for (const d of Game.dragonTilesArr) {
                // 如果叫牌前有龙对子/刻子，叫牌后没了 → 价值破坏
                if ((cntBefore[d] || 0) >= 2 && (cntAfter[d] || 0) < 2) {
                    // 但如果叫的就是这个龙本身（碰龙），不算破坏
                    if (!(kind === 'peng' && tile === d)) {
                        disciplinePenalty += 400;
                    }
                }
            }
        }
    } catch (e) {}
    const evCallFinal = evCall - disciplinePenalty;
    return {
        take: evCallFinal > evPass.ev,
        evCall: evCallFinal, evPass: evPass.ev,
        shanBefore: shanBefore, shanAfter: shanAfter,
        ukBefore: ukBefore, ukAfter: ukAfter,
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
Game.winValue = winValue;
Game.discardEV = discardEV;
Game.pushFold = pushFold;
Game.chooseDiscard = chooseDiscard;

// ---------- 2步期望搜索（AI 4.0 提强1） ----------
// 打出 D 后，摸到各种进张 T 后的向听期望。比只看 immediate ukeire 更准：
// 有些牌进张多但都是"死胡同"（摸到后还是难受），2步能看出来。
// 只对 lexicographic 前 5 名算，~20ms 内。只用公开信息+自己手牌。
function twoStepExp(hand, exposed, discard) {
    const hand1 = hand.slice();
    const di = hand1.indexOf(discard);
    if (di < 0) return { exp: 8, totalRem: 0 };
    hand1.splice(di, 1);
    let s1;
    try { s1 = Game.estimateShanten(hand1, exposed); }
    catch (e) { return { exp: 8, totalRem: 0 }; }
    // hand1 的进张（带剩余张数）
    const ukeire = [];
    try {
        for (let i = 0; i < 34; i++) {
            const t = Game.indexToTile(i);
            const rem = Game.remainingCount(t, hand1);
            if (!rem) continue;
            if (Game.estimateShanten(hand1.concat([t]), exposed) < s1) {
                ukeire.push({ tile: t, rem: rem });
            }
        }
    } catch (e) { return { exp: s1, totalRem: 0 }; }
    if (!ukeire.length) return { exp: s1, totalRem: 0 };
    ukeire.sort((a, b) => b.rem - a.rem);
    const top = ukeire.slice(0, 8); // 只看最可能摸到的 8 种
    let wSum = 0, wTot = 0, totalRem = 0;
    for (const u of ukeire) totalRem += u.rem;
    try {
        for (const u of top) {
            const s2 = Game.estimateShanten(hand1.concat([u.tile]), exposed);
            // 上听 (s2==0) 给 -0.5 奖励：能上听的打法优先
            const score = s2 === 0 ? -0.5 : s2;
            wSum += u.rem * score;
            wTot += u.rem;
        }
    } catch (e) { return { exp: s1, totalRem: totalRem }; }
    return { exp: wTot ? wSum / wTot : s1, totalRem: totalRem };
}
Game.twoStepExp = twoStepExp;

// ---------- AI 3.0 弃牌决策核心（chooseDiscard3 与教练模式共用） ----------
// 返回 { tile, stance, decider, winner, runnerUp, scored }。
// decider：winner 对 runnerUp 第一个分出胜负的排序轴（shanten/qh/uk1/keep/danger），
// 若转守后 EV 推翻了字典序头名则为 'ev'。教练模式用它生成"为什么"。
function chooseDiscardCore(hand, exposed, player, style) {
    const axes = (Game.aiLearn && Game.aiLearn.confidence && Game.aiLearn.confidence[style]) || {};
    // AI 3.0 性格引擎：静态底色（AI_TRAITS）+ 学习增量（aiLearn.confidence）
    const trait = Game.aiTraitOf ? Game.aiTraitOf(player) : null;
    const T = trait || { wallCautionAt: 10, honorHoldBias: 0, cannonHoldTier: 1, blockXiajiaTier: 1 };
    const uniq = [...new Set(hand)];
    const scored = [];
    // 下家（顺位下一位）：不喂下家轴只盯他
    const xiajia = Game.nextPlayerOf ? Game.nextPlayerOf(player) : null;
    for (const t of uniq) {
        const s = Game.scoreDiscard(hand, exposed, player, t);
        if (!s) continue;
        s.qhPenalty = qhPenaltyFor(s.rest, exposed, player);
        // 7轴微调（只调参数，不碰向听/规则正确性）
        const suit = Game.tileSuit(t);
        let dangerW = 1 + (axes.defense || 0) * 0.4;
        const deckLen = Game.deck ? Game.deck.length : 70;
        // 残局求稳：静态 wallCautionAt 定"多早开始慌"，学习轴 wallCaution 定"慌多狠"
        const cautionAt = T.wallCautionAt || 10;
        if (deckLen < cautionAt) {
            const urgency = 1 - deckLen / cautionAt; // 0~1，越接近流局越急
            dangerW *= 1 + urgency * 0.3 + (axes.wallCaution || 0) * 0.3;
        }
        // 炮牌截留：静态 cannonHoldTier 是底色，学习轴 cannonHold 是增量
        const cannonTier = (T.cannonHoldTier || 0) + (axes.cannonHold || 0);
        if (cannonTier > 0) dangerW *= 1 + cannonTier * 0.15;
        s.dangerAdj = s.danger * dangerW;
        // 不喂下家：这张牌对下家的危险度，性格越谨慎加成越多（激进 0=不care）
        if (T.blockXiajiaTier > 0 && xiajia) {
            let xd = 0;
            try { xd = Game.publicDangerVs(player, t, xiajia) || 0; } catch (e) {}
            s.dangerAdj += xd * T.blockXiajiaTier * 0.3;
        }
        // 字牌保留：静态 honorHoldBias 是底色（保守-1早丢/激进+1爱留），学习轴 honorHold 是增量
        s.keepAdj = s.keepValue + (suit === '字' ? ((T.honorHoldBias || 0) * 2 + (axes.honorHold || 0) * 2) : 0);
        scored.push(s);
        try { if (Game.markAxisUsed) {
            if (axes.defense) Game.markAxisUsed(player, 'defense');
            if (axes.honorHold && suit === '字') Game.markAxisUsed(player, 'honorHold');
            if (axes.wallCaution && deckLen < cautionAt) Game.markAxisUsed(player, 'wallCaution');
            if (axes.cannonHold) Game.markAxisUsed(player, 'cannonHold');
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
    // AI 4.0 提强1：对前 5 名补算 2 步期望（打出→摸进张→向听期望），比单看 ukeire 更准
    const twoStepN = Math.min(5, pruned.length);
    for (let i = 0; i < twoStepN; i++) {
        try {
            const r = twoStepExp(hand, exposed, pruned[i].tile);
            pruned[i].twoStep = r.exp;
        } catch (e) { pruned[i].twoStep = pruned[i].shanten; }
    }
    for (let i = twoStepN; i < pruned.length; i++) pruned[i].twoStep = pruned[i].shanten;
    // 并列组补 uk2（注：ukeire2Raw 单次 ~100ms 太贵，热路径已禁用；保留函数供离线分析）
    // 实际用 uk1 的"进张种类数"作后劲代理（ukeire1Raw 内已算出，不额外花钱）
    // 细排：保留价值 → 危险度（uk2 已从热路径移除）
    // AI 4.0：2步期望排在 uk1 之后——uk1 看"现在有多少进张"，2步看"摸到后有多舒服"
    pruned.sort((a, b) => {
        if (a.shanten !== b.shanten) return a.shanten - b.shanten;
        if (a.qhPenalty !== b.qhPenalty) return a.qhPenalty - b.qhPenalty;
        if (a.uk1 !== b.uk1) return b.uk1 - a.uk1;
        if (Math.abs(a.twoStep - b.twoStep) > 0.15) return a.twoStep - b.twoStep;
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
    if (stance === 'attack') {
        // AI 4.0 提强2：攻击时也不往枪口撞。若头名危险度极高 (>0.7)，
        // 且前 3 里有向听不差太多 (≤+1) 但安全得多 (<0.4) 的，换打安全的。
        // 性格差异：保守更早换（阈值 0.6），激进更头铁（阈值 0.85）。
        const dangerThresh = 0.6 + ((trait && trait.riskDefenseAt) || 1) * 0.15;
        if (winner.dangerAdj > dangerThresh) {
            for (const c of pruned.slice(1, 3)) {
                if (c.shanten <= winner.shanten + 1 && c.dangerAdj < 0.4) {
                    tile = c.tile;
                    decider = 'danger-avoid';
                    break;
                }
            }
        }
    }
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
