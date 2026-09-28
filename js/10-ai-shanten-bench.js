// ---------- 保牌AI：给每张牌算一个“保留等级”，数值越小越优先被打出 ----------
// 0=孤立字牌 1=孤立中张(2,3,7,8) 2=孤立中张(4,5,6) 3=孤立幺九/嵌张
// 4=刻子(三者中最先舍) 5=连张/搭子/三门齐保护 6=对子(最优先保留)
function protectsThreeSuits(hand, tile) {
    const suit = tileSuit(tile);
    if (suit === '字') return false; // 字牌不影响三门齐
    const suitsPresent = new Set(hand.filter(t => tileSuit(t) !== '字').map(tileSuit));
    if (suitsPresent.size < 3) return false; // 已经不是三门齐了，没必要为了保它牺牲效率
    return hand.filter(t => tileSuit(t) === suit).length === 1; // 这门僅剩的一张，打了就断这门了
}

// ---------- 记牌：统计场面上能看到的牌，判断某个搭子还有没有指望 ----------
// 只数看得见的：弃牌堆 + 各家已经亮出的碰/吃/明杠/亮牌（暗杠盖着，不算"看得见"）
function tileSeenCount(tile) {
    let count = discardPile.filter(d => d.tile === tile).length;
    for (const p of turnOrder) {
        for (const m of exposedMelds[p]) {
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
    const s = tileSuit(t), r = tileRank(t);
    if (s === '万') return r - 1;
    if (s === '条') return 9 + r - 1;
    if (s === '筒') return 18 + r - 1;
    return 26 + r; // 1字..7字 → 27..33
}

function buildCount34(concealed) {
    const c = new Array(34).fill(0);
    for (const t of concealed) {
        const i = tileToIndex(t);
        if (i >= 0 && i < 34) c[i]++;
    }
    return c;
}

/** 在已去掉完整面子、并已取走将牌（或确定无将）的剩余里，贪心数搭子。
 *  搭子 = 连张(45) / 嵌张(46) / 对子(55，可碰)。对子以前漏数了，导致多对子的手牌向听被高估。 */
function countTaatsu34(cnt) {
    const c = cnt.slice();
    let taatsu = 0;
    // 数牌：连张优先，再嵌张，再对子；剩下的是孤张
    for (let base = 0; base < 27; base += 9) {
        for (let i = 0; i < 9; i++) {
            const p = base + i;
            while (c[p] > 0) {
                if (i <= 7 && c[p + 1] > 0) {
                    c[p]--; c[p + 1]--;
                    taatsu++;
                } else if (i <= 6 && c[p + 2] > 0) {
                    c[p]--; c[p + 2]--;
                    taatsu++;
                } else if (c[p] >= 2) {
                    c[p] -= 2; // 对子也是搭子（等碰）
                    taatsu++;
                } else {
                    c[p]--; // 孤张
                }
            }
        }
    }
    // 字牌没有顺子搭子，但对子同样是搭子
    for (let p = 27; p < 34; p++) {
        if (c[p] >= 2) taatsu++;
    }
    return taatsu;
}

/**
 * 已知已拆出 melds 个完整面子后，对剩余牌枚举将牌选择，计算向听。
 * 公式：还缺 m 个面子时，向听 ≈ 2m - (有将?1:0) - 可用搭子数（有上限）。
 */
function shantenFromRest(cnt, melds, needMelds) {
    let best = 20;
    const mNeed = Math.max(0, needMelds - melds);

    const evalWith = (pair, taatsu) => {
        // 搭子最多补 mNeed 个面子（面子+搭子的块数不能超过还缺的面子数）
        let t = taatsu;
        if (t > mNeed) t = mNeed;
        if (t < 0) t = 0;
        // 完成形：melds==needMelds 且 pair→ -1；听牌 → 0
        return 2 * mNeed - (pair ? 1 : 0) - t;
    };

    // 不加将
    best = Math.min(best, evalWith(0, countTaatsu34(cnt)));

    // 枚举一种将牌
    for (let i = 0; i < 34; i++) {
        if (cnt[i] >= 2) {
            cnt[i] -= 2;
            best = Math.min(best, evalWith(1, countTaatsu34(cnt)));
            cnt[i] += 2;
        }
    }
    return best;
}

/**
 * 复杂向听：对「拆出完整面子」的所有分支做 DFS，再评估剩余。
 * 只衡量一般形（面子+将），不含穷胡的开门/三门齐/幺九。
 * 返回：-1 已和（结构），0 听牌，1+ 向听数。
 */
function calcComplexShanten(concealed, needMelds) {
    if (needMelds < 0) return 8;
    if (needMelds === 0) {
        // 只剩将：0～1 张或一对
        if (concealed.length === 0) return 1;
        if (concealed.length === 1) return 0;
        if (concealed.length === 2 && concealed[0] === concealed[1]) return -1;
        return Math.max(0, concealed.length - 1);
    }
    const root = buildCount34(concealed);
    let minS = 20;

    function dfs(cnt, from, melds) {
        // 每个节点都可「停止拆面子」并评估
        const s = shantenFromRest(cnt, melds, needMelds);
        if (s < minS) minS = s;
        if (melds >= needMelds || minS < 0) return;

        for (let i = from; i < 34; i++) {
            if (cnt[i] === 0) continue;
            // 刻子
            if (cnt[i] >= 3) {
                cnt[i] -= 3;
                dfs(cnt, i, melds + 1);
                cnt[i] += 3;
            }
            // 顺子（仅数牌，且起点 rank<=7）
            if (i < 27 && (i % 9) <= 6 && cnt[i] > 0 && cnt[i + 1] > 0 && cnt[i + 2] > 0) {
                cnt[i]--; cnt[i + 1]--; cnt[i + 2]--;
                dfs(cnt, i, melds + 1);
                cnt[i]++; cnt[i + 1]++; cnt[i + 2]++;
            }
        }
    }

    dfs(root, 0, 0);
    if (minS > 8) minS = 8;
    return minS;
}

/**
 * AI 用向听入口：按副露数决定手牌还需几个面子。
 * -1 结构已和；0 结构听牌；正数越大越远。
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
    return calcComplexShanten(concealed, needMelds);
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
            ok = checkHu([...hand, winTile], [], null);
            samples.push(_benchNow() - s0);
        }
        report.checkHu = {
            result: ok,
            timing: _benchStats(samples, _benchNow() - t0, iterations)
        };
    }

    // —— 3) chooseAiDiscardTile（需临时挂手牌环境）——
    if (includeAiDiscard && typeof chooseAiDiscardTile === 'function') {
        const savedHands = hands;
        const savedExposed = exposedMelds;
        const savedWait = aiWaitTiles;
        try {
            const discSamples = {};
            for (const fx of fixtures) {
                if (fx.concealed.length < 2) continue;
                hands = {
                    top: fx.concealed.slice(),
                    left: fx.concealed.slice(),
                    right: fx.concealed.slice(),
                    bottom: fx.concealed.slice()
                };
                exposedMelds = {
                    top: fx.exposed.slice(),
                    left: fx.exposed.slice(),
                    right: fx.exposed.slice(),
                    bottom: fx.exposed.slice()
                };
                aiWaitTiles = { top: [], left: [], right: [] };
                const samples = [];
                const t0 = _benchNow();
                let pick = null;
                const n = Math.min(iterations, 80); // 舍牌含多次向听，次数略降
                for (let i = 0; i < n; i++) {
                    const s0 = _benchNow();
                    pick = chooseAiDiscardTile(fx.concealed.slice(), 'top');
                    samples.push(_benchNow() - s0);
                }
                discSamples[fx.name] = {
                    picked: pick,
                    timing: _benchStats(samples, _benchNow() - t0, n)
                };
            }
            report.aiDiscard = discSamples;
        } finally {
            hands = savedHands;
            exposedMelds = savedExposed;
            aiWaitTiles = savedWait;
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
            logFlow('基准：向听均 ' + avgShan.toFixed(3) + 'ms；控制台看 benchmarkMahjongAI 详情');
        } catch (e) { /* ignore */ }
    }
    return report;
}

// 暴露到全局，便于手机远程调试 / 桌面控制台
try { window.benchmarkMahjongAI = benchmarkMahjongAI; } catch (e) { /* non-browser */ }
