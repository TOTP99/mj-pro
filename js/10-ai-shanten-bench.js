;(function(){
// ---------- 保牌AI：给每张牌算一个“保留等级”，数值越小越优先被打出 ----------
// 0=孤立字牌 1=孤立中张(2,3,7,8) 2=孤立中张(4,5,6) 3=孤立幺九/嵌张
// 4=刻子(三者中最先舍) 5=连张/搭子/三门齐保护 6=对子(最优先保留)
// ---------- 记牌：统计场面上能看到的牌，判断某个搭子还有没有指望 ----------
// 只数看得见的：弃牌堆 + 各家已经亮出的碰/吃/明杠/亮牌（暗杠盖着，不算"看得见"）
function tileSeenCount(tile) {
    let count = Game.discardPile.filter(d => d.tile === tile).length;
    for (const p of Game.turnOrder) {
        for (const m of Game.exposedMelds[p]) {
            if (m.type === 'gang' && m.concealed) continue; // 暗杠看不见，不计入
            count += m.tiles.filter(t => t === tile).length;
        }
    }
    return count;
}

// ownHand（可选）：做决策的这位 AI 自己的暗牌——自己手里的牌当然看得见，也要算进"已知张数"。
// 不传则和原来一样，只数场面上的牌。
function isTileDead(tile, ownHand) {
    let seen = tileSeenCount(tile);
    if (ownHand) seen += ownHand.filter(t => t === tile).length;
    return seen >= 4; // 4张都已经在看得见的地方了，这张没指望了
}

// ---------- AI：精确结构向听（DFS 拆面子 + 剩余搭子评估） / 吃碰评估 ----------
/** 牌面 → 0..33：万0-8 条9-17 筒18-26 字27-33 */
function tileToIndex(t) {
    const s = Game.tileSuit(t), r = Game.tileRank(t);
    if (s === '万') return r - 1;
    if (s === '条') return 9 + r - 1;
    if (s === '筒') return 18 + r - 1;
    return 26 + r; // 1字..7字 → 27..33（牌码即如此命名，'东'只是显示名）
}

function buildCount34(concealed) {
    const c = new Array(34).fill(0);
    for (const t of concealed) {
        const i = tileToIndex(t);
        if (i >= 0 && i < 34) c[i]++;
    }
    return c;
}
// ---------- AI：精确向听（DFS 穷举面子/搭子/将；替代旧贪心搭子计数） ----------
// 状态=(下标, 已拆面子数, 已拆搭子数, 是否有将)。分支在同一位置 i 递归（while 跳过 0），
// 保证 1111+23 这类"刻子剩一张仍可组顺子"被正确穷举；终点公式 s = 2*needMelds - 2*melds - min(tatsu, needMelds-melds) - pair。
// 13 张手牌微秒级。旧贪心在 3445/4556/多对子等复合牌型上会数错搭子。
function shantenExact34(cnt, needMelds) {
    let best = 20;
    const c = cnt.slice();
    const cap = Math.max(0, needMelds);
    (function dfs(i, melds, tatsu, pair) {
        while (i < 34 && c[i] === 0) i++;
        if (i >= 34) {
            const t = Math.min(tatsu, Math.max(0, cap - melds));
            const s = 2 * cap - 2 * melds - t - pair;
            if (s < best) best = s;
            return;
        }
        const r = i % 9;
        if (c[i] >= 3) { c[i] -= 3; dfs(i, melds + 1, tatsu, pair); c[i] += 3; } // 刻子
        if (i < 27 && r <= 6 && c[i + 1] > 0 && c[i + 2] > 0) { // 顺子
            c[i]--; c[i + 1]--; c[i + 2]--;
            dfs(i, melds + 1, tatsu, pair);
            c[i]++; c[i + 1]++; c[i + 2]++;
        }
        if (!pair && c[i] >= 2) { c[i] -= 2; dfs(i, melds, tatsu, 1); c[i] += 2; } // 将
        if (i < 27 && r <= 7 && c[i + 1] > 0) { // 两面/边张搭子
            c[i]--; c[i + 1]--; dfs(i, melds, tatsu + 1, pair); c[i]++; c[i + 1]++;
        }
        if (i < 27 && r <= 6 && c[i + 2] > 0) { // 嵌张搭子
            c[i]--; c[i + 2]--; dfs(i, melds, tatsu + 1, pair); c[i]++; c[i + 2]++;
        }
        dfs(i + 1, melds, tatsu, pair); // 跳过：此牌作孤张
    })(0, 0, 0, 0);
    return best;
}

/** 七小对向听（闭式）：6 - 对子数 + max(0, 7 - 牌种数)。仅无副露时有效。 */
function shantenChiitoi34(cnt) {
    let pairs = 0, kinds = 0;
    for (let t = 0; t < 34; t++) {
        if (cnt[t] > 0) kinds++;
        if (cnt[t] >= 2) pairs++;
    }
    return 6 - pairs + Math.max(0, 7 - kinds);
}

/**
 * AI 用向听入口：按副露数决定手牌还需几个面子。
 * -1 结构已和；0 结构听牌；正数越大越远。
 * 七小对分支仅在无副露且规则允许时参与取最小。
 */
function estimateShanten(concealed, exposed) {
    const needMelds = 4 - (exposed ? exposed.length : 0);
    if (needMelds < 0) return 8;
    // 张数与目标差太大时先快速裁剪，避免无意义 DFS
    const n = concealed.length;
    const winLen = needMelds * 3 + 2;
    const tenpaiLen = needMelds * 3 + 1;
    if (n === 0) return needMelds * 2 + 1;
    if (n > winLen + 3) return Math.min(8, n - tenpaiLen);
    const cnt = buildCount34(concealed);
    let s = shantenExact34(cnt, needMelds);
    if (needMelds === 4 && typeof Game !== 'undefined' && Game.ruleAllowsSevenPairs) {
        try { if (Game.ruleAllowsSevenPairs()) s = Math.min(s, shantenChiitoi34(cnt)); } catch (e) {}
    }
    return s;
}

// ========== 性能基准（控制台：benchmarkMahjongAI()）==========
/** 统计一组耗时样本：min/max/avg/median/p95/opsPerSec */
function _benchStats(samplesMs, totalMs, ops) {
    const a = samplesMs.slice().sort((x, y) => x - y);
    const n = a.length;
    const sum = a.reduce((s, v) => s + v, 0);
    const mid = n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
    const p95 = a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
    return {
        runs: n,
        totalMs: Math.round(totalMs * 1000) / 1000,
        minMs: Math.round(a[0] * 1000) / 1000,
        maxMs: Math.round(a[n - 1] * 1000) / 1000,
        avgMs: Math.round((sum / n) * 1000) / 1000,
        medianMs: Math.round(mid * 1000) / 1000,
        p95Ms: Math.round(p95 * 1000) / 1000,
        opsPerSec: totalMs > 0 ? Math.round((ops / totalMs) * 1000) : 0
    };
}

function _benchNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** 固定测试牌型（覆盖完成形 / 听牌 / 一向听 / 散牌 / 带副露） */
function _benchHandFixtures() {
    return [
        {
            name: 'complete-14',
            concealed: ['1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','1条','1条','2筒','2筒'],
            exposed: []
        },
        {
            name: 'tenpai-13',
            concealed: ['1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','1条','1条','2筒'],
            exposed: []
        },
        {
            name: 'iishanten-like',
            concealed: ['1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','1条','3条'],
            exposed: []
        },
        {
            name: 'messy-13',
            concealed: ['1万','3万','5万','7万','9万','1条','4条','7条','2筒','5筒','8筒','1字','5字'],
            exposed: []
        },
        {
            name: 'open-peng-11',
            concealed: ['1万','2万','3万','4万','5万','6万','7万','8万','9万','2筒','2筒'],
            exposed: [{ type: 'peng', tiles: ['1条', '1条', '1条'] }]
        }
    ];
}

/**
 * 运行性能基准。
 * @param {object} [opt]
 * @param {number} [opt.iterations=200] 每个用例重复次数
 * @param {boolean} [opt.includeAiDiscard=true] 是否测 AI 舍牌
 * @param {boolean} [opt.includeCheckHu=true] 是否测 checkHu
 * @param {boolean} [opt.log=true] 是否 console.table / logFlow
 * @returns {object} 详细报告
 */
function benchmarkMahjongAI(opt) {
    const iterations = (opt && opt.iterations) || 200;
    const includeAiDiscard = !opt || opt.includeAiDiscard !== false;
    const includeCheckHu = !opt || opt.includeCheckHu !== false;
    const doLog = !opt || opt.log !== false;
    const fixtures = _benchHandFixtures();
    const report = {
        meta: {
            iterations,
            ts: new Date().toISOString(),
            userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : 'node',
            note: '结构向听 DFS；不含渲染。opsPerSec 按单次函数调用计。'
        },
        shanten: {},
        checkHu: null,
        aiDiscard: null
    };

    // —— 1) estimateShanten / calcComplexShanten ——
    for (const fx of fixtures) {
        const samples = [];
        const t0 = _benchNow();
        let last = null;
        for (let i = 0; i < iterations; i++) {
            const s0 = _benchNow();
            last = estimateShanten(fx.concealed, fx.exposed);
            samples.push(_benchNow() - s0);
        }
        const total = _benchNow() - t0;
        report.shanten[fx.name] = {
            result: last,
            needMelds: 4 - fx.exposed.length,
            tileCount: fx.concealed.length,
            timing: _benchStats(samples, total, iterations)
        };
    }

    // —— 2) checkHu（听牌形补一张）——
    if (includeCheckHu) {
        const hand = ['1万','2万','3万','4万','5万','6万','7万','8万','9万','1条','1条','1条','2筒'];
        const winTile = '2筒';
        const samples = [];
        const t0 = _benchNow();
        let ok = false;
        for (let i = 0; i < iterations; i++) {
            const s0 = _benchNow();
            ok = Game.checkHu([...hand, winTile], [], null);
            samples.push(_benchNow() - s0);
        }
        report.checkHu = {
            result: ok,
            timing: _benchStats(samples, _benchNow() - t0, iterations)
        };
    }

    // —— 3) chooseAiDiscardTile（需临时挂手牌环境）——
    if (includeAiDiscard && typeof Game.chooseAiDiscardTile === 'function') {
        const savedHands = Game.hands;
        const savedExposed = Game.exposedMelds;
        const savedWait = Game.aiWaitTiles;
        try {
            const discSamples = {};
            for (const fx of fixtures) {
                if (fx.concealed.length < 2) continue;
                Game.hands = {
                    top: fx.concealed.slice(),
                    left: fx.concealed.slice(),
                    right: fx.concealed.slice(),
                    bottom: fx.concealed.slice()
                };
                Game.exposedMelds = {
                    top: fx.exposed.slice(),
                    left: fx.exposed.slice(),
                    right: fx.exposed.slice(),
                    bottom: fx.exposed.slice()
                };
                Game.aiWaitTiles = { top: [], left: [], right: [] };
                const samples = [];
                const t0 = _benchNow();
                let pick = null;
                const n = Math.min(iterations, 80); // 舍牌含多次向听，次数略降
                for (let i = 0; i < n; i++) {
                    const s0 = _benchNow();
                    pick = Game.chooseAiDiscardTile(fx.concealed.slice(), 'top');
                    samples.push(_benchNow() - s0);
                }
                discSamples[fx.name] = {
                    picked: pick,
                    timing: _benchStats(samples, _benchNow() - t0, n)
                };
            }
            report.aiDiscard = discSamples;
        } finally {
            Game.hands = savedHands;
            Game.exposedMelds = savedExposed;
            Game.aiWaitTiles = savedWait;
        }
    }

    if (doLog) {
        console.log('[Mahjong AI Benchmark]', report.meta);
        console.log('--- estimateShanten ---');
        const shanRows = Object.keys(report.shanten).map(k => {
            const r = report.shanten[k];
            return {
                case: k,
                result: r.result,
                tiles: r.tileCount,
                avgMs: r.timing.avgMs,
                medianMs: r.timing.medianMs,
                p95Ms: r.timing.p95Ms,
                opsPerSec: r.timing.opsPerSec
            };
        });
        console.table(shanRows);
        if (report.checkHu) {
            console.log('--- checkHu ---', report.checkHu);
        }
        if (report.aiDiscard) {
            console.log('--- chooseAiDiscardTile ---');
            const rows = Object.keys(report.aiDiscard).map(k => {
                const r = report.aiDiscard[k];
                return {
                    case: k,
                    picked: r.picked,
                    avgMs: r.timing.avgMs,
                    medianMs: r.timing.medianMs,
                    p95Ms: r.timing.p95Ms,
                    opsPerSec: r.timing.opsPerSec
                };
            });
            console.table(rows);
        }
        try {
            const avgShan = shanRows.reduce((s, r) => s + r.avgMs, 0) / (shanRows.length || 1);
            Game.logFlow('基准：向听均 ' + avgShan.toFixed(3) + 'ms；控制台看 benchmarkMahjongAI 详情');
        } catch (e) { /* ignore */ }
    }
    return report;
}

// 暴露到全局，便于手机远程调试 / 桌面控制台
try { window.benchmarkMahjongAI = benchmarkMahjongAI; } catch (e) { /* non-browser */ }

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.isTileDead = isTileDead;
Game.tileSeenCount = tileSeenCount;
Game.estimateShanten = estimateShanten;

;})();
