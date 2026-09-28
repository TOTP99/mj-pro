const windTilesArr = ['1字', '2字', '3字', '4字'];
const dragonTilesArr = ['5字', '6字', '7字'];

// 四归一：某张牌凑齐4张，3张做刻子(或杠)、剩下1张落在一个顺子里
function hasSiGuiYi(decomp, exposed) {
    const tripletCount = {}, sequenceCount = {};
    decomp.forEach(m => {
        const target = m.type === 'triplet' ? tripletCount : (m.type === 'sequence' ? sequenceCount : null);
        if (target) m.tiles.forEach(t => { target[t] = (target[t] || 0) + 1; });
    });
    exposed.forEach(m => {
        if (m.type === 'peng' || m.type === 'gang') {
            const t = m.tiles[0];
            tripletCount[t] = (tripletCount[t] || 0) + 3; // 杠的第4张是"补的"，不算进四归一的顺子那一份
        }
        if (m.type === 'chi') m.tiles.forEach(t => { sequenceCount[t] = (sequenceCount[t] || 0) + 1; });
    });
    for (const t in tripletCount) {
        if (tripletCount[t] >= 3 && sequenceCount[t] >= 1) return true;
    }
    return false;
}

// 分析这次胡牌的番型倍数（倍数部分）；底分在 settleScore：自摸1 / 点炮2，以下每项再翻倍可叠加：
// 杠(每个×2，可多次) / 中发白刻子(三张相同中或发或白；亮中发白明组也算) / 单吊 / 边张 / 夹张 / 海底捞 等
// 仅一对中/发/白做将不算「中发白×2」（只在 analyzeHu 补幺九+刻子）
// 碰碰胡(全部刻子/杠，无顺子)例外：翻8倍代替翻2倍，但仍可与其他项叠加
// concealedBeforeWin: 胡牌前的暗牌(不含winTile)；winTile: 刚好胡的这张
// 在所有能胡的分解方式里取倍数最高的一种（对玩家最有利）
/** 计算和牌番型倍数（不含自摸/点炮/庄家，那些在 settleScore） */
function scoreWinningHand(concealedBeforeWin, winTile, exposed, isSelfDraw, isLastTile) {
    const concealed = [...concealedBeforeWin, winTile].sort(tileCompare);
    const neededSets = 4 - exposed.length;
    let best = { mult: 1, tags: [] };
    const counts = {};
    for (const t of concealed) counts[t] = (counts[t] || 0) + 1;

    for (const pairTile of Object.keys(counts)) {
        if (counts[pairTile] < 2) continue;
        const rest = [];
        let skipped = 0;
        for (const t of concealed) {
            if (t === pairTile && skipped < 2) { skipped++; continue; }
            rest.push(t);
        }
        const decompositions = decompose(rest);
        for (const decomp of decompositions) {
            if (decomp.length !== neededSets) continue;

            // winTile在这套分解里落在哪：单吊(对子) / 边张 / 夹张 / 普通
            let waitType = 'normal';
            if (pairTile === winTile) {
                waitType = 'tanki';
            } else {
                for (const m of decomp) {
                    if (m.type === 'sequence' && m.tiles.includes(winTile)) {
                        const ranks = m.tiles.map(tileRank);
                        if (winTile === m.tiles[1]) waitType = 'kanchan'; // 中间那张：夹张
                        else if (winTile === m.tiles[0] && ranks[2] === 9) waitType = 'bianzhang'; // 7,8,9缺7
                        else if (winTile === m.tiles[2] && ranks[0] === 1) waitType = 'bianzhang'; // 1,2,3缺3
                        break;
                    }
                }
            }

            const isAllTriplets = decomp.every(m => m.type === 'triplet') &&
                exposed.every(m => m.type === 'peng' || m.type === 'gang');
            const hasDragonTriplet =
                decomp.some(m => m.type === 'triplet' && dragonTilesArr.includes(m.tiles[0])) ||
                exposed.some(m => (m.type === 'peng' || m.type === 'gang') && dragonTilesArr.includes(m.tiles[0])) ||
                exposed.some(m => m.type === 'dragons');
            const siGuiYi = hasSiGuiYi(decomp, exposed);

            let mult = 1;
            const tags = [];
            if (isAllTriplets) { mult *= 8; tags.push('碰碰胡×8'); }
            if (hasDragonTriplet) { mult *= 2; tags.push('中发白×2'); }
            // 风刻明组：×1，不再加倍（保留判断但不影响总分）
            if (waitType === 'tanki') { mult *= 2; tags.push('单吊×2'); }
            if (waitType === 'bianzhang') { mult *= 2; tags.push('边张×2'); }
            if (waitType === 'kanchan') { mult *= 2; tags.push('夹张×2'); }
            if (isLastTile) { mult *= 2; tags.push('海底捞×2'); }
            if (siGuiYi) { mult *= 2; tags.push('四归一×2'); }
            for (const m of exposed) {
                if (m.type !== 'gang') continue;
                if (m.concealed) { mult *= 4; tags.push('暗杠×4'); }
                else { mult *= 2; tags.push('明杠×2'); }
            }

            if (mult > best.mult) best = { mult, tags };
        }
    }
    return best;
}


/** 杠上开花 / 杠后点炮：在 settleScore 前调用，就地改 bonus.mult/tags */
function applyKongBonuses(bonus, winner, mode, payer) {
    if (!bonus) return bonus;
    if (mode === 'selfdraw' && afterKongDrawPlayer === winner) {
        bonus.mult *= 2;
        if (!bonus.tags.includes('杠上开花×2')) bonus.tags.push('杠上开花×2');
    }
    if (mode === 'dianpao' && payer && afterKongDiscardPlayer === payer) {
        bonus.mult *= 2;
        if (!bonus.tags.includes('杠后点炮×2')) bonus.tags.push('杠后点炮×2');
    }
    return bonus;
}

function clearKongFlags() {
    afterKongDrawPlayer = null;
    afterKongDiscardPlayer = null;
}

/** 杠后补牌完成 */
function markKongDraw(player) {
    afterKongDrawPlayer = player;
    afterKongDiscardPlayer = null;
}

/** 该玩家若刚杠过补牌，出牌后改为「杠后点炮」待结算 */
function markKongDiscardIfNeeded(player) {
    if (afterKongDrawPlayer === player) {
        afterKongDiscardPlayer = player;
        afterKongDrawPlayer = null;
    }
}

/**
 * 期望暗牌张数：
 * - 待出牌（摸后/吃碰杠后）: (4-副露数)*3+2
 * - 已出牌等待: (4-副露数)*3+1
 */
function expectedConcealedLen(player, mustDiscard) {
    const n = 4 - ((exposedMelds[player] && exposedMelds[player].length) || 0);
    return mustDiscard ? n * 3 + 2 : n * 3 + 1;
}

/** 实时检查四家暗牌张数；异常时写流程提示 + console */
function validateHandCounts(reason) {
    if (gameOver) return true;
    let ok = true;
    for (const p of PLAYERS) {
        const len = (hands[p] && hands[p].length) || 0;
        const expN = (exposedMelds[p] && exposedMelds[p].length) || 0;
        const needDiscard = (len % 3 === 2);
        const expect = expectedConcealedLen(p, needDiscard);
        // 允许「待出牌」或「已出牌」两种合法态；其它一律异常
        const alt = expectedConcealedLen(p, !needDiscard);
        if (len !== expect && len !== alt) {
            ok = false;
            const msg = '【异常】手牌张数异常 ' + nameOf(p) + ' 暗牌' + len + '张/副露' + expN
                + '（期望' + expect + '或' + alt + '）' + (reason ? ' @' + reason : '');
            try { logFlow(msg); } catch (e) {}
            try { console.warn('[hand-check]', msg, hands[p], exposedMelds[p]); } catch (e2) {}
        }
    }
    return ok;
}

// 结算一局的分数：底分(自摸1/点炮2) × 番型倍数 × 自摸或点炮×2 × 庄家相关，可叠加
// 返回 { detail(文字摘要), payouts(每家+/-), total(赢家总所得), tags(完整标签列表), dealerWinBonus, noKaimenPlayers(未开门被罚的玩家名单) }
function settleScore(winner, mode, payer, bonus) {
    const tags = [...bonus.tags];
    let mult = bonus.mult;

    // 未开门加罚：自摸时，输家里没开门的各自×2（互不影响、影响赢家总分）；
    // 点炮时，只看点炮者一人是否没开门。
    let noKaimenPlayers = [];
    if (mode === 'selfdraw') {
        noKaimenPlayers = turnOrder.filter(p => p !== winner && !isKaimen(exposedMelds[p]));
    } else if (mode === 'dianpao' && payer && !isKaimen(exposedMelds[payer])) {
        noKaimenPlayers = [payer];
    }

    if (mode === 'selfdraw') {
        mult *= 2; tags.push('自摸×2');
        if (noKaimenPlayers.length === 3) tags.push('闷三家');
    } else {
        mult *= 2; tags.push('点炮×2');
        // 「没开门点炮」：点炮者自己还没吃/碰/明杠，就放炮给别人胡 → 多付一倍
        // 赢家必须已开门才能胡（checkHu 要求 kaimen），与此无关
        if (noKaimenPlayers.length) { mult *= 2; tags.push('没开门点炮×2'); }
    }
    const dealerWinBonus = winner === dealer;
    if (dealerWinBonus) { mult *= 2; tags.push('庄家×2'); }
    const dealerPayBonus = mode === 'dianpao' && payer === dealer;
    if (dealerPayBonus) { mult *= 2; tags.push('庄点炮×2'); }

    const baseScore = mode === 'selfdraw' ? 1 : 2; // 自摸底分1，点炮底分2
    let unit = baseScore * mult;
    const tagText = tags.length ? '(' + tags.join('+') + ')' : '';
    const payouts = { top: 0, left: 0, right: 0, bottom: 0 };
    let detail, total;
    if (mode === 'selfdraw') {
        total = 0;
        for (const p of turnOrder) {
            if (p === winner) continue;
            let pay = unit;
            if (p === dealer) pay *= 2; // 自摸时，庄家作为付款方单独再翻倍(只影响这一位的具体金额，不重复计入上面的倍数说明)
            if (noKaimenPlayers.includes(p)) pay *= 2; // 没开门的输家单独再翻倍，只影响这一位
            scores[p] -= pay;
            payouts[p] = -pay;
            total += pay;
        }
        scores[winner] += total;
        payouts[winner] = total;
        detail = '自摸' + tagText + '，合计 ' + total + ' 分';
    } else {
        let pay = unit; // 点炮只出自己这一份，不用把另外两家的份额也包了
        scores[payer] -= pay;
        scores[winner] += pay;
        payouts[payer] = -pay;
        payouts[winner] = pay;
        total = pay;
        detail = nameOf(payer) + ' 点炮' + tagText + '，付 ' + pay + ' 分';
    }
    // 2.0 二期：结算后通知场次管理（更新金额/局数/输光检查）
    if (typeof onFieldGameSettled === 'function') {
        try { onFieldGameSettled(payouts); } catch (e) {}
    }
    return { detail, payouts, total, tags, dealerWinBonus, noKaimenPlayers };
}

// 判断某玩家是否听牌：暗牌数刚好比“完整手牌”少一张，且存在某张牌补上就能胡
// 所有可能的牌种：万条筒1-9 + 字牌1-7（缓存，减轻听牌扫描分配）
let _allTileTypesCache = null;
function allTileTypes() {
    if (_allTileTypesCache) return _allTileTypesCache;
    const types = [];
    for (const s of suits) for (let r = 1; r <= 9; r++) types.push(r + s);
    for (let r = 1; r <= honors.length; r++) types.push(r + '字');
    _allTileTypesCache = types;
    return types;
}

function isTenpai(player) {
    return getWinningTiles(player).length > 0;
}

// 某玩家当前听哪些牌（不听返回空数组）
function getWinningTiles(player) {
    return getWinningTilesOf(hands[player], exposedMelds[player], player);
}
