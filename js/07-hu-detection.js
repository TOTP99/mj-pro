;(function(){
// ---------- 胡牌判断 ----------
// concealed: 手中暗牌数组；exposed: 已亮出的碰/吃/杠组合 [{type:'peng'|'chi'|'gang', tiles:[...]}]
// player: 可选，传入后会应用该玩家的“亮牌”加成（东南西北/中发白亮牌 -> 算幺九+刻子但不算开门）
// structuralOk: 能否拆成完整面子+对将（胡牌的基本前提）
// kaimen: 是否真正“开过门”——本局至少碰/吃过一次（不能纯暗手自摸算开门；亮牌不算开门）
// 特殊：中发白的对子做将，幺九自动满足；刻子是否满足看“中发白作将相当于碰牌”开关（默认是；不影响开门，需另外满足）
/** 是否开过门：吃/碰/明杠（暗杠、亮风/亮箭不算） */
function isKaimen(exposed) {
    return (exposed || []).some(m =>
        m.type === 'peng' || m.type === 'chi' || (m.type === 'gang' && !m.concealed)
    );
}

/**
 * 胡牌结构分析（穷胡）：
 * structuralOk 能拆成面子+将；kaimen 开过门；sanmenqi 三门齐；
 * yaojiu 有幺九/字；kezi 有刻子。
 *
 * 中/发/白：
 * - 三张相同（暗刻/碰/杠）= 一套面子，同时满足幺九+刻子；计分另见 scoreWinningHand 的「中发白×2」
 * - 一对做将 = 同时满足幺九+刻子，计分不 ×2
 * - 亮出的中发白/东南西北明组：补幺九+刻子，不算开门
 * 胡牌者必须开门（含点炮、自摸）；「没开门点炮×2」罚的是点炮者未开门。
 */
function analyzeHu(concealed, exposed = [], player = null) {
    const neededSets = 4 - exposed.length;
    const requiredLen = neededSets * 3 + 2;
    let structuralOk = false;
    // 明刻/明杠/暗杠/亮风箭都算有刻子
    let kezi = exposed.some(m =>
        m.type === 'peng' || m.type === 'gang' || m.type === 'dragons' || m.type === 'winds'
    );
    let dragonPairAsJiang = false;
    if (concealed.length === requiredLen) {
        const sorted = [...concealed].sort(Game.tileCompare);
        // 用计数表找对子，避免反复 filter
        const counts = {};
        for (const t of sorted) counts[t] = (counts[t] || 0) + 1;
        for (const pairTile of Object.keys(counts)) {
            if (counts[pairTile] < 2) continue;
            const rest = [];
            let skipped = 0;
            for (const t of sorted) {
                if (t === pairTile && skipped < 2) { skipped++; continue; }
                rest.push(t);
            }
            for (const decomp of decompose(rest)) {
                if (decomp.length !== neededSets) continue;
                structuralOk = true;
                if (decomp.some(m => m.type === 'triplet')) kezi = true;
                // 一对中/发/白做将：补刻子条件（不计分 ×2）
                if (Game.dragonTilesArr.includes(pairTile)) dragonPairAsJiang = true;
            }
        }
    }
    const allTiles = [...concealed, ...exposed.flatMap(m => m.tiles)];
    // 字牌（含中发白）或数牌 1/9 即满足幺九
    let yaojiu = allTiles.some(t => Game.tileSuit(t) === '字' || Game.tileRank(t) === 1 || Game.tileRank(t) === 9);
    const numberSuitsUsed = new Set(allTiles.filter(t => Game.tileSuit(t) !== '字').map(Game.tileSuit));
    const sanmenqi = numberSuitsUsed.size === 3;
    const kaimen = isKaimen(exposed);

    // 2026-09-28：中发白作将是否相当于碰牌，高阶可配置（默认是），日常恒为是
    // 注意：字牌作将本身满足幺九（yaojiu 按字牌判定，不受此开关影响），此开关只影响“碰牌/刻子”要求
    const dragonsAsPeng = typeof Game.ruleDragonsPairAsPeng === 'function' ? Game.ruleDragonsPairAsPeng() : true;
    if (dragonPairAsJiang && dragonsAsPeng) kezi = true;
    // 亮牌加成：只补幺九+刻子，不算开门
    if (player && Game.windDragonBonus[player]) { yaojiu = true; kezi = true; }

    return { structuralOk, kaimen, sanmenqi, yaojiu, kezi };
}

function checkHu(concealed, exposed = [], player = null) {
    // 日常模式：旧版逻辑，一字不改
    if (typeof Game.isDailyMode === 'function' && Game.isDailyMode()) {
        const a = analyzeHu(concealed, exposed, player);
        return a.structuralOk && a.kaimen && a.sanmenqi && a.yaojiu && a.kezi;
    }
    // 高阶模式：按规则配置判定
    return checkHuAdvanced(concealed, exposed, player);
}

/** 七小对特例：手里 7 对 14 张即胡，不要求开门/亮牌 */
function isSevenPairs(concealed) {
    if (!concealed || concealed.length !== 14) return false;
    const counts = {};
    for (const t of concealed) counts[t] = (counts[t] || 0) + 1;
    return Object.values(counts).every(c => c === 2);
}

/** 高阶胡牌判定：按 9 开关组合（默认配置 ≡ 日常旧版） */
function checkHuAdvanced(concealed, exposed = [], player = null) {
    // 七小对优先：手里 7 对 14 张即胡，开门/亮牌都不要求
    if (Game.ruleAllowsSevenPairs() && isSevenPairs(concealed)) {
        return true;
    }
    const a = analyzeHu(concealed, exposed, player);
    if (!a.structuralOk) return false;
    // 默认时：须开门/须幺九/须三门齐/须刻子，与日常旧版分支完全一致
    if (Game.ruleRequiresKaimen() && !a.kaimen) return false;
    if (Game.ruleRequiresYaojiu() && !a.yaojiu) return false;
    if (Game.ruleRequiresSanmenqi() && !a.sanmenqi) return false;
    // 必须有碰牌=是 → 须有刻子；否 → 平胡可胡（无刻子也行）
    if (Game.ruleRequiresPeng() && !a.kezi) return false;
    return true;
}

// 递归拆解为 刻子/顺子 组合，返回所有可能的组合方案
/** 将已去掉将牌的有序暗牌拆成刻子/顺子；tiles 须已按 tileCompare 排好 */
function decompose(tiles) {
    if (tiles.length === 0) return [[]];
    const results = [];
    const t = tiles[0];
    const suit = Game.tileSuit(t);
    const rank = Game.tileRank(t);

    // 尝试刻子
    const sameCount = tiles.filter(x => x === t).length;
    if (sameCount >= 3) {
        const rest = [...tiles];
        for (let i = 0, removed = 0; i < rest.length && removed < 3; i++) {
            if (rest[i] === t) { rest.splice(i, 1); i--; removed++; }
        }
        for (const sub of decompose(rest)) {
            results.push([{ type: 'triplet', tiles: [t, t, t] }, ...sub]);
        }
    }
    // 尝试顺子（同花色连续三张，字牌没有顺子）
    const t2 = (rank + 1) + suit;
    const t3 = (rank + 2) + suit;
    if (suit !== '字' && tiles.includes(t2) && tiles.includes(t3)) {
        const rest = [...tiles];
        rest.splice(rest.indexOf(t), 1);
        rest.splice(rest.indexOf(t2), 1);
        rest.splice(rest.indexOf(t3), 1);
        for (const sub of decompose(rest)) {
            results.push([{ type: 'sequence', tiles: [t, t2, t3] }, ...sub]);
        }
    }
    return results;
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.isKaimen = isKaimen;
Game.analyzeHu = analyzeHu;
Game.checkHu = checkHu;
Game.decompose = decompose;
Game.isSevenPairs = isSevenPairs;

;})();
