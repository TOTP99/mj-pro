// ---------- 基础常量与全局状态 ----------
const suits = ['万', '条', '筒'];
const honors = ['东', '南', '西', '北', '中', '发', '白'];
const PLAYERS = ['top', 'left', 'right', 'bottom'];
const turnOrder = ['bottom', 'right', 'top', 'left'];
const baseNames = { top: '西', left: '北', right: '南', bottom: '东' };
const statOrder = ['right', 'top', 'left', 'bottom'];
const statAvatar = {
    right: '<img class="stat-avatar-img" src="avatars/stat-lion.webp" alt="南" draggable="false">',
    top: '<img class="stat-avatar-img" src="avatars/stat-dragon.webp" alt="西" draggable="false">',
    left: '<img class="stat-avatar-img" src="avatars/stat-tiger.webp" alt="北" draggable="false">',
    bottom: '<img class="stat-avatar-img" src="avatars/stat-cat.webp" alt="东" draggable="false">'
};

let deck = [];
let hands = { top: [], left: [], right: [], bottom: [] };
let exposedMelds = { top: [], left: [], right: [], bottom: [] };
let discardPile = [];
let currentIndex = 0;
let gameOver = false;
let pendingClaim = null;
let dealer = 'bottom';
let winner = null;
let selectedIndex = null;
let lastDrawnIndex = null;
let scores = { top: 0, left: 0, right: 0, bottom: 0 };
let windDragonBonus = { top: false, left: false, right: false, bottom: false };
let firstTurnPending = { top: true, left: true, right: true, bottom: true };
let lastDrawnTile = { top: null, left: null, right: null, bottom: null };
let lastDrawWasFinal = { top: false, left: false, right: false, bottom: false };
let aiWaitTiles = { top: [], left: [], right: [] };
let lastSettlement = null;
// 杠上开花 / 杠后点炮：杠后补牌标记；打出后转为点炮×2标记
let afterKongDrawPlayer = null;   // 刚杠完并已补牌、尚未出牌的玩家
let afterKongDiscardPlayer = null; // 刚杠后打出的那一张，点炮时×2

// ---------- 通用工具/定时器 ----------
// DOM 查询、函数防抖、游戏流程定时器（gameEpoch 隔离旧局回调）

// DOM 查询简写：全文本用 $(id) 代替 document.getElementById(id)
const $ = (id) => document.getElementById(id);

/**
 * 防抖工具：返回 schedule 函数；调用后 ms 毫秒内无新调用才执行 fn。
 * schedule.cancel() 可取消未执行的调用（返回是否真的取消了一个待执行的）。
 * AI 学习存档（600ms）与对局进度存档（400ms）共用，行为与原来逐字一致。
 */
function debounce(fn, ms) {
    let timer = 0;
    const schedule = function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = 0; fn(); }, ms);
    };
    schedule.cancel = function () {
        if (timer) { clearTimeout(timer); timer = 0; return true; }
        return false;
    };
    return schedule;
}

// ---------- 局号 + 游戏流程定时器 ----------
// 延时回调经 gameEpoch 隔离：开新局/清零后旧回调自动作废；骰子仪式期间顺延 200ms
let gameEpoch = 0;
function gameTimeout(fn, ms) {
    const epoch = gameEpoch;
    const run = () => {
        if (epoch !== gameEpoch) return; // 已经不是这一局了
        if (typeof diceBusy !== 'undefined' && diceBusy) { setTimeout(run, 200); return; } // 骰子仪式期间暂停
        fn();
    };
    return setTimeout(run, ms);
}

// ---------- AI 学习：跨局记忆三种性格(保守/激进/精明)的历史战绩，微调决策倾向 ----------
// 7轴各自独立学习（不再是笼统一个数）：callAggr=吃碰激进度 defense=防守让牌
// chaseSpecial=特殊牌型追逐 wallCaution=残局求稳 honorHold=字牌保留 cannonHold=炮牌截留 position=位置感
const AI_AXES = ['callAggr', 'defense', 'chaseSpecial', 'wallCaution', 'honorHold', 'cannonHold', 'position'];
const AI_LEARN_KEY = 'qionghu_mahjong_ai_learn_v1';
function freshAxisConfidence() {
    const o = {};
    for (const ax of AI_AXES) o[ax] = 0;
    return o;
}
let aiLearn = {
    games: 0,
    confidence: { conservative: freshAxisConfidence(), aggressive: freshAxisConfidence(), shrewd: freshAxisConfidence() },
    samples: { conservative: freshAxisConfidence(), aggressive: freshAxisConfidence(), shrewd: freshAxisConfidence() }
};
// 每局临时记录三个AI各自"这局真的用上了哪几条轴"（牌局结束记完账就清空，不落盘）
let aiAxisUsed = { top: new Set(), left: new Set(), right: new Set() };
function resetAiAxisUsed() { aiAxisUsed = { top: new Set(), left: new Set(), right: new Set() }; }
function markAxisUsed(player, axis) {
    if (aiAxisUsed[player]) aiAxisUsed[player].add(axis);
}
// 归因细化用：记这个AI最近一次吃/碰发生在第几轮（handTurnCount），
// 如果点炮的这一巡刚好等于这个数，说明这张点炮的牌大概率是被那次吃碰逼出来的
let lastCallTurn = { top: -1, left: -1, right: -1 };
function resetLastCallTurn() { lastCallTurn = { top: -1, left: -1, right: -1 }; }
// 这一局走了多少轮摸牌，给"激进——胡得快不快"当参考
let handTurnCount = 0;

function loadAiLearn() {
    try {
        const raw = localStorage.getItem(AI_LEARN_KEY);
        // 无存档时载入预置的 2847 局经验（00-ai-preseed.js）
        const src = raw || (typeof AI_PRESEED !== 'undefined' ? JSON.stringify(AI_PRESEED) : null);
        if (!src) return;
        const parsed = JSON.parse(src);
        if (!parsed || !parsed.confidence) return;
        const out = { games: parsed.games || 0, confidence: {}, samples: {} };
        for (const style of ['conservative', 'aggressive', 'shrewd']) {
            const saved = parsed.confidence[style];
            const fresh = freshAxisConfidence();
            // 旧版单数字存档无法映射到7轴，清零重学
            if (saved && typeof saved === 'object') {
                for (const ax of AI_AXES) fresh[ax] = typeof saved[ax] === 'number' ? saved[ax] : 0;
            }
            out.confidence[style] = fresh;
            // 样本数存档：没有就按全0重数（AI 3.0 性格学习率/稳定性用）
            const savedS = parsed.samples && parsed.samples[style];
            const freshS = freshAxisConfidence();
            if (savedS && typeof savedS === 'object') {
                for (const ax of AI_AXES) freshS[ax] = typeof savedS[ax] === 'number' ? Math.max(0, savedS[ax]) : 0;
            }
            out.samples[style] = freshS;
        }
        aiLearn = out;
    } catch (e) { /* 本地存储不可用则用默认值 */ }
}
function saveAiLearn() {
    try { localStorage.setItem(AI_LEARN_KEY, JSON.stringify(aiLearn)); } catch (e) {}
}
loadAiLearn();

function clampConfidence(v) { return Math.max(-3, Math.min(3, v)); }

// AI 学习防抖保存（减少频繁写盘）
const scheduleSaveAiLearn = debounce(saveAiLearn, 600);

// 三种性格对"这局打得好不好"的定义完全不同——不是谁都以"胡了"为唯一目标：
// 保守只在乎有没有点炮；激进只在乎胡得快不快；精明只在乎胡得大不大/有没有挡住别人
// ctx: { role: 'winner'|'payer'|'bystander'|'draw', fan, turns, tenpai }
function scoreHandForStyle(style, ctx) {
    if (ctx.role === 'draw') {
        if (style === 'conservative') return ctx.tenpai ? 0.3 : 0;
        if (style === 'aggressive') return ctx.tenpai ? 0.2 : -0.3;
        return ctx.tenpai ? 0.6 : 0.2; // shrewd：流局听牌=局面在掌控中，是精明最想要的结果
    }
    if (ctx.role === 'winner') {
        if (style === 'conservative') return 1;
        if (style === 'aggressive') {
            const turns = ctx.turns || 99;
            return 1 + Math.max(0, 0.5 - Math.max(0, turns - 20) * 0.02); // 20轮内胡封顶+0.5，越慢加成越少
        }
        return 0.5 + Math.min(1, (ctx.fan || 0) * 0.15); // shrewd：按番数加成，封顶+1(叠加基础0.5=+1.5)
    }
    if (ctx.role === 'payer') {
        if (style === 'conservative') return -1.5; // 保守最大的失败
        if (style === 'aggressive') return -1;
        return (ctx.fan || 0) >= 5 ? -1.5 : -0.6; // shrewd：该挡的挡没挡住，看放的这把多大
    }
    // bystander：这局既没赢也没点炮
    if (style === 'conservative') return 0.5; // 没惹上危险，松一口气
    if (style === 'aggressive') return -0.1; // 被人抢先，小扣
    return 0; // shrewd：不算成也不算败
}

// 性格学习率（AI 3.0）：激进反应快、保守求稳、精明居中——发展性格，不磨平性格
const LEARN_RATE = { conservative: 0.8, aggressive: 1.2, shrewd: 1.0 };

// 遗忘曲线：学习值每局衰减一点点（0.97/局），防止某条轴被早期几局锁死
function decayAiLearn() {
    for (const style of ['conservative', 'aggressive', 'shrewd']) {
        const c = aiLearn.confidence[style];
        if (!c) continue;
        for (const axis of AI_AXES) c[axis] = clampConfidence(c[axis] * 0.97);
    }
}

// 单轴记分（position 名次轴等需要单独归因时用）
function applySingleAxisScore(player, style, axis, score) {
    if (!aiLearn.confidence[style]) return; // 未知性格字符串：防御，不抛错
    if (Math.abs(score) < 0.25) return; // 噪声过滤：不痛不痒的局不调整
    const n = (aiLearn.samples[style] && aiLearn.samples[style][axis]) || 0;
    const stability = Math.min(1, 12 / (12 + n)); // 样本越多学得越慢，防抖
    let delta = score * stability * (LEARN_RATE[style] || 1);
    delta = Math.max(-0.6, Math.min(0.6, delta)); // 单局封顶：单局最多动0.6
    aiLearn.confidence[style][axis] = clampConfidence(aiLearn.confidence[style][axis] + delta);
    if (aiLearn.samples[style]) aiLearn.samples[style][axis] = n + 1;
}

// 这局结束，把 score 记到这个AI这局真正用上的那几条轴上（没用上的轴不动）
// justCalled=true 时说明这次点炮是"这一巡刚吃/碰完就打出去"逼出来的——归因细化：
// 吃碰相关的轴(callAggr/chaseSpecial)多担责任，其余轴（防守/残局/字牌等）少担，
// 因为这张牌很可能是被那次吃碰打乱了手牌节奏才被迫打出的，不是这些轴自己选错了
function applyAxisScore(player, style, score, justCalled) {
    const used = aiAxisUsed[player];
    if (!used || used.size === 0) return;
    if (!aiLearn.confidence[style]) return; // 未知性格字符串：防御，不抛错
    if (Math.abs(score) < 0.25) return; // 噪声过滤：不痛不痒的局不调整
    const CALL_AXES = new Set(['callAggr', 'chaseSpecial']);
    for (const axis of used) {
        if (axis === 'position') continue; // 名次轴单独归因（看名次变化），不走通用分
        const weight = justCalled ? (CALL_AXES.has(axis) ? 1.4 : 0.4) : 1;
        const n = (aiLearn.samples[style] && aiLearn.samples[style][axis]) || 0;
        const stability = Math.min(1, 12 / (12 + n)); // 样本越多学得越慢，防抖
        let delta = score * weight * stability * (LEARN_RATE[style] || 1);
        delta = Math.max(-0.6, Math.min(0.6, delta)); // 单局封顶：单局最多动0.6
        aiLearn.confidence[style][axis] = clampConfidence(aiLearn.confidence[style][axis] + delta);
        if (aiLearn.samples[style]) aiLearn.samples[style][axis] = n + 1;
    }
}

// 一局定输赢后调用。meta: { fan, turns }（自摸/点炮都算胡，不再区分对"这局的分"的影响——
// 三种性格各自在乎的东西已经在 scoreHandForStyle 里体现了）
function learnFromWin(winnerPlayer, payerPlayer, meta) {
    meta = meta || {};
    decayAiLearn(); // 遗忘曲线：防早期几局锁死
    for (const p of ['top', 'left', 'right']) {
        const style = aiPersonality[p];
        if (!style) continue;
        const role = p === winnerPlayer ? 'winner' : (p === payerPlayer ? 'payer' : 'bystander');
        const score = scoreHandForStyle(style, { role, fan: meta.fan, turns: meta.turns });
        const justCalled = role === 'payer' && lastCallTurn[p] === handTurnCount;
        applyAxisScore(p, style, score, justCalled);
        // 名次轴单独归因：这局名次上升=名次感用对了，下降=用错了（只在用过 position 轴时记）
        if (aiAxisUsed[p] && aiAxisUsed[p].has('position') && rankAtDeal) {
            const was = rankAtDeal[p], now = rankNow(p);
            if (was !== undefined && now >= 0) applySingleAxisScore(p, style, 'position', (was - now) * 0.4);
        }
        // AI 3.0 分化度：记这局
        const st = aiStyleStats[style];
        if (st) {
            st.games += 1;
            if (role === 'winner') { st.wins += 1; st.winTurns += (meta.turns || 0); st.winFan += (meta.fan || 0); }
            if (role === 'payer') st.dealIns += 1;
        }
    }
    resetAiAxisUsed();
    resetLastCallTurn();
    aiLearn.games += 1;
    scheduleSaveAiLearn();
}
// 流局时调用：听牌的性格按自己的表加分，没听牌的按自己的表扣分/加分
function learnFromDraw(tenpaiPlayers) {
    decayAiLearn(); // 遗忘曲线：防早期几局锁死
    for (const p of ['top', 'left', 'right']) {
        const style = aiPersonality[p];
        if (!style) continue;
        const score = scoreHandForStyle(style, { role: 'draw', tenpai: tenpaiPlayers.includes(p) });
        applyAxisScore(p, style, score);
        // AI 3.0 分化度：记这局
        const st = aiStyleStats[style];
        if (st) st.games += 1;
    }
    resetAiAxisUsed();
    resetLastCallTurn();
    aiLearn.games += 1;
    scheduleSaveAiLearn();
}

// ---------- AI 3.0 名次感（position 轴） ----------
// 每局开局记四家名次快照（按筹码/分数排序，0=第1名），结算时看名次变化：
// 名次上升=名次感用对了，下降=用错了。只在该 AI 本局真用过 position 轴时记（见 learnFromWin）
let rankAtDeal = null;
function snapshotRankAtDeal() {
    const ss = turnOrder.map(p => ({ p, s: (scores && scores[p]) || 0 }));
    ss.sort((a, b) => b.s - a.s);
    const out = {};
    ss.forEach((x, i) => { out[x.p] = i; });
    rankAtDeal = out;
}
function rankNow(player) {
    const ss = turnOrder.map(p => ({ p, s: (scores && scores[p]) || 0 }));
    ss.sort((a, b) => b.s - a.s);
    return ss.findIndex(x => x.p === player);
}

// ---------- AI 3.0 性格分化度追踪 ----------
// 每局按性格记关键行为（吃碰/点炮/胡牌/轮数/番数），算三性格的标准差，
// 看学习有没有把三家磨成一个模子（只追踪不落盘，验证/调参用）
function freshStyleStats() {
    const o = {};
    for (const s of ['conservative', 'aggressive', 'shrewd'])
        o[s] = { games: 0, calls: 0, dealIns: 0, wins: 0, winTurns: 0, winFan: 0 };
    return o;
}
let aiStyleStats = freshStyleStats();
// 吃/碰/杠一次（分化度用）
function trackAiCall(player) {
    const style = (typeof aiPersonality !== 'undefined' && aiPersonality[player]) || null;
    if (style && aiStyleStats[style]) aiStyleStats[style].calls += 1;
}
// 三个性格在关键指标上的分化度：每项返回 { conservative, aggressive, shrewd, std }
// （std 越大说明三个 AI 性格分化越明显，std→0 说明学成了同一个模子）
function aiDivergence() {
    const std = arr => {
        const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
    };
    const per = fn => {
        const o = {};
        for (const s of ['conservative', 'aggressive', 'shrewd']) o[s] = fn(aiStyleStats[s]);
        o.std = std([o.conservative, o.aggressive, o.shrewd]);
        return o;
    };
    const rate = x => x.games ? x.calls / x.games : 0;      // 场均吃碰
    const dealRate = x => x.games ? x.dealIns / x.games : 0; // 场均点炮
    const winRate = x => x.games ? x.wins / x.games : 0;     // 胜率
    const avgTurns = x => x.wins ? x.winTurns / x.wins : 0;   // 平均胡牌轮数
    const avgFan = x => x.wins ? x.winFan / x.wins : 0;       // 平均番数
    return { callRate: per(rate), dealInRate: per(dealRate), winRate: per(winRate), avgWinTurns: per(avgTurns), avgWinFan: per(avgFan) };
}

const FULL_DECK_SIZE = suits.length * 9 * 4 + honors.length * 4; // 136
let _lastTileWarnKey = '';
function checkTileConservation(reason) {
    if (gameOver) return true;
    const n = totalTilesOf({ deck, discardPile, hands, exposedMelds });
    if (n === FULL_DECK_SIZE) return true;
    const key = reason + ':' + n;
    if (key !== _lastTileWarnKey) {
        _lastTileWarnKey = key;
        try { console.warn('[tile-check] 牌总数异常', n, '/', FULL_DECK_SIZE, '@' + reason, { deck: deck.length, discard: discardPile.length, hands: cloneState(hands), melds: cloneState(exposedMelds) }); } catch (e) {}
        try { logFlow('【异常】牌总数异常 ' + n + '/' + FULL_DECK_SIZE + (reason ? ' @' + reason : '')); } catch (e) {}
    }
    return false;
}

// 全部 JS 按 01→18 顺序加载、共享全局作用域（无 module）；各文件职责见 README.md 的目录/改哪里表。

// ---------- 状态面板 ----------
// 渲染左侧空地里的状态面板：每位玩家一行，横着写 头像图标 风位 奖杯 庄家 听牌提示（例如 [头像] 西 ★ 庄 听）
function renderStatRow(elId, cellFor) {
    const el = $(elId);
    if (!el) return;
    el.innerHTML = statOrder.map(p => `<span class="stat-cell" data-player="${p}">${cellFor(p)}</span>`).join('');
}

function ensurePortraitStatRows() {
    const ps = $('player-stats');
    if (!ps) return;
    if ($('stat-avatar') && $('stat-wind') && $('stat-medal') && $('stat-dealer') && $('stat-tenpai')) return;
    ps.innerHTML = ''
        + '<div class="stat-row avatar-row" id="stat-avatar"></div>'
        + '<div class="stat-row" id="stat-wind"></div>'
        + '<div class="stat-row" id="stat-medal"></div>'
        + '<div class="stat-row" id="stat-dealer"></div>'
        + '<div class="stat-row" id="stat-tenpai"></div>';
}

function markDealer() {
    const maxScore = Math.max(...Object.values(scores));
    const hasLead = Object.values(scores).some(v => v !== maxScore); // 四家同分（如开场初始筹码）不挂奖杯
    const isPortrait = document.body && document.body.classList.contains('portrait-layout');
    if (isPortrait) {
        // 竖屏：原版牌墙下五行列表（头像/风位/奖杯/庄/听）
        ensurePortraitStatRows();
        renderStatRow('stat-avatar', p => statAvatar[p]);
        renderStatRow('stat-wind', p => baseNames[p]);
        renderStatRow('stat-medal', p => (hasLead && maxScore > 0 && scores[p] === maxScore) ? '<span class="ico-star">★</span>' : '');
        renderStatRow('stat-dealer', p => p === dealer ? '<span class="ico-badge ico-dealer">庄</span>' : '');
        renderStatRow('stat-tenpai', p => isTenpai(p) ? '<span class="ico-badge ico-tenpai">听</span>' : '');
    } else {
        // 横屏：侧栏每人一行
        const ps = $('player-stats');
        if (ps) {
            ps.innerHTML = statOrder.map(p => {
                const medal = (hasLead && maxScore > 0 && scores[p] === maxScore) ? ' <span class="ico-star">★</span>' : '';
                const dealerMark = p === dealer ? ' <span class="ico-badge ico-dealer">庄</span>' : '';
                const tenpaiMark = isTenpai(p) ? ' <span class="ico-badge ico-tenpai">听</span>' : '';
                return `<div class="stat-line" data-player="${p}">${statAvatar[p]} ${baseNames[p]}${medal}${dealerMark}${tenpaiMark}</div>`;
            }).join('');
        }
    }
    for (const p of PLAYERS) {
        const s = scores[p];
        const el = $('score-' + p);
        if (el) el.innerText = s;
        // 庄家光环：头像加呼吸金光
        try {
            const pd = $('p-' + p);
            if (pd) pd.classList.toggle('is-dealer', p === dealer);
        } catch (e) {}
    }
    scheduleSaveProgress();
}

// 完整对局记忆（积分/庄家/牌面/轮次）→ localStorage，刷新后原样恢复
const MAHJONG_STORAGE_KEY = 'qionghu_mahjong_progress_v2';
let restoringGame = false;
let savedPendingReveal = null; // 存档里记下的「等你选亮牌」类型，读档后由 resumeFromSave 使用

function cloneState(obj) {
    // 优先使用原生 structuredClone（更快），失败时回退到 JSON 方式
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(obj);
        } catch (e) {
            // 极少数环境失败时回退
        }
    }
    return JSON.parse(JSON.stringify(obj));
}

/** 防抖写盘：避免每次 render 都同步 stringify 造成卡顿 */
const _debouncedSaveProgress = debounce(saveGameProgress, 400);
function scheduleSaveProgress() {
    if (restoringGame) return;
    _debouncedSaveProgress();
}

/** 立刻落盘（取消未执行的防抖），用于关键节点与页面关闭前 */
function flushSaveProgress() {
    if (restoringGame) return;
    _debouncedSaveProgress.cancel();
    saveGameProgress();
}

function saveGameProgress() {
    if (restoringGame) return;
    if (!checkTileConservation('save')) return; // 牌数不对的异常状态不落盘，保留上一份正常存档
    try {
        localStorage.setItem(MAHJONG_STORAGE_KEY, JSON.stringify({
            v: 2,
            scores, dealer, currentIndex, gameOver, winner,
            selectedIndex, lastDrawnIndex,
            deck: cloneState(deck),
            hands: cloneState(hands),
            exposedMelds: cloneState(exposedMelds),
            discardPile: cloneState(discardPile),
            windDragonBonus: cloneState(windDragonBonus),
            firstTurnPending: cloneState(firstTurnPending),
            lastDrawnTile: cloneState(lastDrawnTile),
            lastDrawWasFinal: cloneState(lastDrawWasFinal),
            aiWaitTiles: cloneState(aiWaitTiles),
            // 仅持久化「下一局」；进行中吃碰杠刷新后由玩家重选，避免半自动卡死
            pendingClaimMode: pendingClaim && pendingClaim.mode === 'nextGame' ? 'nextGame' : null,
            // 等你选「亮牌/不亮」时刷新：记下类型，读档后重新弹窗
            pendingRevealKind: (typeof pendingReveal !== 'undefined') ? pendingReveal : null
        }));
    } catch (e) { /* 隐私模式等不可用时忽略 */ }
}

// 刷新/切后台前强制写入，避免防抖窗口内丢进度；同时强制落盘 AI 学习数据
window.addEventListener('pagehide', () => {
    if (scheduleSaveAiLearn.cancel()) saveAiLearn();
    flushSaveProgress();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaveProgress(); // 切后台时立刻落盘
});

function loadGameProgress() {
    try {
        // 兼容旧版仅存 scores+dealer 的存档
        let raw = localStorage.getItem(MAHJONG_STORAGE_KEY);
        if (!raw) {
            const legacy = localStorage.getItem('qionghu_mahjong_progress_v1');
            if (legacy) {
                const old = JSON.parse(legacy);
                if (old && old.scores) {
                    for (const p of PLAYERS) {
                        if (typeof old.scores[p] === 'number') scores[p] = old.scores[p];
                    }
                }
                if (old && PLAYERS.includes(old.dealer)) {
                    dealer = old.dealer;
                }
            }
            return false; // 无完整对局，走 initGame
        }
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return false;

        // 始终恢复跨局指标
        if (saved.scores) {
            for (const p of PLAYERS) {
                if (typeof saved.scores[p] === 'number') scores[p] = saved.scores[p];
            }
        }
        if (PLAYERS.includes(saved.dealer)) {
            dealer = saved.dealer;
        }

        // 完整对局快照（v2）才恢复牌面
        if (saved.v !== 2 || !Array.isArray(saved.deck) || !saved.hands) return false;
        // 进行中的牌局：牌总数必须是 136，否则说明存档已损坏，放弃牌面、只保留积分/庄家重开一局
        if (!saved.gameOver && totalTilesOf(saved) !== FULL_DECK_SIZE) {
            try { console.warn('[tile-check] 存档牌总数异常，已放弃该存档牌面：', totalTilesOf(saved)); } catch (e) {}
            return false;
        }

        restoringGame = true;
        deck = saved.deck;
        hands = saved.hands;
        exposedMelds = saved.exposedMelds || { top: [], left: [], right: [], bottom: [] };
        discardPile = saved.discardPile || [];
        currentIndex = (Number.isInteger(saved.currentIndex) && saved.currentIndex >= 0 && saved.currentIndex < turnOrder.length)
            ? saved.currentIndex
            : turnOrder.indexOf(dealer);
        gameOver = !!saved.gameOver;
        winner = saved.winner || null;
        windDragonBonus = saved.windDragonBonus || { top: false, left: false, right: false, bottom: false };
        firstTurnPending = saved.firstTurnPending || { top: false, left: false, right: false, bottom: false };
        lastDrawnTile = saved.lastDrawnTile || { top: null, left: null, right: null, bottom: null };
        lastDrawWasFinal = saved.lastDrawWasFinal || { top: false, left: false, right: false, bottom: false };
        aiWaitTiles = saved.aiWaitTiles || { top: [], left: [], right: [] };
        selectedIndex = saved.selectedIndex ?? null;
        lastDrawnIndex = saved.lastDrawnIndex ?? null;
        pendingClaim = saved.pendingClaimMode === 'nextGame' ? { mode: 'nextGame' } : null;
        savedPendingReveal = saved.pendingRevealKind || null;
        restoringGame = false;
        return true;
    } catch (e) {
        restoringGame = false;
        return false; /* 存档损坏时忽略，从当前默认状态开始 */
    }
}

// 从存档恢复后：重绘桌面，若轮到 AI 且局未结束则继续其出牌
function resumeFromSave() {
    render();
    const player = turnOrder[currentIndex];
    highlightActive(player);
    if (gameOver) {
        // 结算弹窗无法原样恢复：统一给出「开下一局」入口（庄家轮转仍按 winner 计算）
        pendingClaim = { mode: 'nextGame' };
        showIndicator('下一局', true);
        logFlow((winner ? (nameOf(winner) + ' 胡了。') : '流局。') + '点确认开下一局（积分与庄家已保留）');
        return;
    }
    // 情形一：刷新时你正在「亮牌/不亮」弹窗里——重新弹出，选完会接着做自摸判断
    if (player === 'bottom' && savedPendingReveal) {
        const kind = savedPendingReveal;
        savedPendingReveal = null;
        if (hands.bottom.length % 3 === 2 && checkWindDragonPattern(hands.bottom) === kind) {
            offerReveal(kind);
            return;
        }
    }
    // 情形二：AI 刚出完牌、等你吃碰杠时刷新——重走吃碰杠/换人流程，不可再摸（防连摸两次）
    const lastDiscard = discardPile[discardPile.length - 1];
    if (player !== 'bottom' && hands[player].length % 3 === 1 && lastDiscard && lastDiscard.player === player) {
        logFlow('继续对局…');
        gameTimeout(() => checkClaimOrAdvance(player, lastDiscard.tile), 600);
        return;
    }
    // 手牌数 %3==2 说明已摸牌、正等着出牌；%3==1 说明还没摸，需要先补摸（否则这张牌永远没人摸到）
    const needDiscard = hands[player].length % 3 === 2;
    if (player === 'bottom') {
        if (needDiscard) {
            logFlow('轮到你，请点击一张牌出牌');
            offerSelfGangIfAny();
        } else {
            logFlow('继续对局…');
            gameTimeout(() => nextTurn(), 600);
        }
    } else {
        logFlow('继续对局…');
        gameTimeout(() => {
            if (needDiscard) aiDiscard(player);
            else nextTurn();
        }, 600);
    }
}

// ---------- 完整性检查：牌总数守恒 ----------
// 一副牌固定 136 张：牌墙 + 四家暗牌 + 四家副露 + 弃牌堆，任何时刻都应等于这个数
// （局已结束时不检查：抢杠等结算路径会把牌挪来挪去）
function totalTilesOf(s) {
    let n = ((s.deck || []).length) + ((s.discardPile || []).length);
    for (const p of PLAYERS) {
        n += ((s.hands && s.hands[p]) || []).length;
        for (const m of ((s.exposedMelds && s.exposedMelds[p]) || [])) n += ((m && m.tiles) || []).length;
    }
    return n;
}
