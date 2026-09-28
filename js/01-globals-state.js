var Game = {};
;(function(){
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

Game.deck = [];
Game.hands = { top: [], left: [], right: [], bottom: [] };
Game.exposedMelds = { top: [], left: [], right: [], bottom: [] };
Game.discardPile = [];
Game.currentIndex = 0;
Game.gameOver = false;
Game.pendingClaim = null;
Game.dealer = 'bottom';
Game.winner = null;
Game.selectedIndex = null;
Game.lastDrawnIndex = null;
Game.scores = { top: 0, left: 0, right: 0, bottom: 0 };
Game.windDragonBonus = { top: false, left: false, right: false, bottom: false };
Game.firstTurnPending = { top: true, left: true, right: true, bottom: true };
// 亮牌提示状态（高阶）：每家拒绝过的种类；上次检查到的牌型（用于检测"新凑齐"）
// 拒绝后同牌型不再提示；牌型从不满足变为满足时清除拒绝、重新允许提示。跨局不保存。
Game.revealDeclined = { top: {}, left: {}, right: {}, bottom: {} };
Game.revealPatternSeen = { top: {}, left: {}, right: {}, bottom: {} };
Game.lastDrawnTile = { top: null, left: null, right: null, bottom: null };
Game.lastDrawWasFinal = { top: false, left: false, right: false, bottom: false };
Game.aiWaitTiles = { top: [], left: [], right: [] };
Game.lastSettlement = null;
// 杠上开花 / 杠后点炮：杠后补牌标记；打出后转为点炮×2标记
Game.afterKongDrawPlayer = null;   // 刚杠完并已补牌、尚未出牌的玩家
Game.afterKongDiscardPlayer = null; // 刚杠后打出的那一张，点炮时×2


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
Game.aiLearn = {
    games: 0,
    confidence: { conservative: freshAxisConfidence(), aggressive: freshAxisConfidence(), shrewd: freshAxisConfidence() }
};
// 每局临时记录三个AI各自"这局真的用上了哪几条轴"（牌局结束记完账就清空，不落盘）
Game.aiAxisUsed = { top: new Set(), left: new Set(), right: new Set() };
function resetAiAxisUsed() { Game.aiAxisUsed = { top: new Set(), left: new Set(), right: new Set() }; }
function markAxisUsed(player, axis) {
    if (Game.aiAxisUsed[player]) Game.aiAxisUsed[player].add(axis);
}
// 归因细化用：记这个AI最近一次吃/碰发生在第几轮（handTurnCount），
// 如果点炮的这一巡刚好等于这个数，说明这张点炮的牌大概率是被那次吃碰逼出来的
Game.lastCallTurn = { top: -1, left: -1, right: -1 };
function resetLastCallTurn() { Game.lastCallTurn = { top: -1, left: -1, right: -1 }; }
// 这一局走了多少轮摸牌，给"激进——胡得快不快"当参考
Game.handTurnCount = 0;

function loadAiLearn() {
    try {
        const raw = localStorage.getItem(AI_LEARN_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.confidence) return;
        const out = { games: parsed.games || 0, confidence: {} };
        for (const style of ['conservative', 'aggressive', 'shrewd']) {
            const saved = parsed.confidence[style];
            const fresh = freshAxisConfidence();
            // 旧版本(改7轴之前)是一个性格一个数字，直接读到的是number；这种情况没法对应到某条轴，
            // 清零重新开始学，不强行套用（新老结构对不上，硬套没有意义）
            if (saved && typeof saved === 'object') {
                for (const ax of AI_AXES) fresh[ax] = typeof saved[ax] === 'number' ? saved[ax] : 0;
            }
            out.confidence[style] = fresh;
        }
        Game.aiLearn = out;
    } catch (e) { /* 本地存储不可用则用默认值 */ }
}
function saveAiLearn() {
    try { localStorage.setItem(AI_LEARN_KEY, JSON.stringify(Game.aiLearn)); } catch (e) {}
}
loadAiLearn();

function clampConfidence(v) { return Math.max(-3, Math.min(3, v)); }

// AI 学习防抖保存（减少频繁写盘）
Game.aiLearnSaveTimer = 0;
function scheduleSaveAiLearn() {
    if (Game.aiLearnSaveTimer) clearTimeout(Game.aiLearnSaveTimer);
    Game.aiLearnSaveTimer = setTimeout(() => {
        Game.aiLearnSaveTimer = 0;
        saveAiLearn();
    }, 600);
}

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

// 这局结束，把 score 记到这个AI这局真正用上的那几条轴上（没用上的轴不动）
// justCalled=true 时说明这次点炮是"这一巡刚吃/碰完就打出去"逼出来的——归因细化：
// 吃碰相关的轴(callAggr/chaseSpecial)多担责任，其余轴（防守/残局/字牌/位置感等）少担，
// 因为这张牌很可能是被那次吃碰打乱了手牌节奏才被迫打出的，不是这些轴自己选错了
function applyAxisScore(player, style, score, justCalled) {
    const used = Game.aiAxisUsed[player];
    if (!used || used.size === 0) return;
    const CALL_AXES = new Set(['callAggr', 'chaseSpecial']);
    for (const axis of used) {
        const weight = justCalled ? (CALL_AXES.has(axis) ? 1.4 : 0.4) : 1;
        Game.aiLearn.confidence[style][axis] = clampConfidence(Game.aiLearn.confidence[style][axis] + score * weight);
    }
}

// 一局定输赢后调用。meta: { fan, turns }（自摸/点炮都算胡，不再区分对"这局的分"的影响——
// 三种性格各自在乎的东西已经在 scoreHandForStyle 里体现了）
function learnFromWin(winnerPlayer, payerPlayer, meta) {
    meta = meta || {};
    for (const p of ['top', 'left', 'right']) {
        const style = Game.aiPersonality[p];
        if (!style) continue;
        const role = p === winnerPlayer ? 'winner' : (p === payerPlayer ? 'payer' : 'bystander');
        const score = scoreHandForStyle(style, { role, fan: meta.fan, turns: meta.turns });
        const justCalled = role === 'payer' && Game.lastCallTurn[p] === Game.handTurnCount;
        applyAxisScore(p, style, score, justCalled);
    }
    resetAiAxisUsed();
    resetLastCallTurn();
    Game.aiLearn.games += 1;
    scheduleSaveAiLearn();
}
// 流局时调用：听牌的性格按自己的表加分，没听牌的按自己的表扣分/加分
function learnFromDraw(tenpaiPlayers) {
    for (const p of ['top', 'left', 'right']) {
        const style = Game.aiPersonality[p];
        if (!style) continue;
        const score = scoreHandForStyle(style, { role: 'draw', tenpai: tenpaiPlayers.includes(p) });
        applyAxisScore(p, style, score);
    }
    resetAiAxisUsed();
    resetLastCallTurn();
    Game.aiLearn.games += 1;
    scheduleSaveAiLearn();
}

// DOM 查询简写：全文本用 $(id) 代替 document.getElementById(id)
const $ = (id) => document.getElementById(id);

// ---------- 局号 + 游戏流程定时器 ----------
// gameEpoch：每开一局（initGame）+1。流程里的延时回调（AI 摸牌/出牌/吃碰后出牌等）
// 都通过 gameTimeout 调度：局号变了（清零重启/开下一局）就直接作废，不会串到新局里多摸/多打一次；
// 骰子仪式期间（diceBusy）自动顺延，不让 AI 在清零菜单弹出时继续推进牌局、覆盖你的吃碰杠提示。
Game.gameEpoch = 0;
function gameTimeout(fn, ms) {
    const epoch = Game.gameEpoch;
    const run = () => {
        if (epoch !== Game.gameEpoch) return; // 已经不是这一局了
        if (typeof Game.diceBusy !== 'undefined' && Game.diceBusy) { setTimeout(run, 200); return; } // 骰子仪式期间暂停
        fn();
    };
    return setTimeout(run, ms);
}

// ---------- 显式状态机（二期） ----------
// 把原来散落在各处的隐式流程控制（gameOver 布尔、pendingClaim 四种 mode、
// pendingReveal、firstTurnPending、setTimeout 链）收敛为一个权威的 Game.phase。
// 约定：
// - setPhase 只做"记录 + 转移合法性检查"，非法转移记违规、打 console.warn，
//   但不拦截、不改任何原有行为（行为零变化是二期的硬约束）。
// - 骰子仪式是覆盖态：pushPhase 压栈进入，popPhase 恢复；
//   调庄/清零会另起一局，走 setPhase('dealing') 并清空压栈。
// - 纯展示浮层（牌池、头像介绍等）不设 phase。
Game.PHASE = {
    BOOT: 'boot',               // 脚本加载、尚未决定入口
    MODE_SELECT: 'modeSelect',  // 模式选择弹窗
    RULES_EDIT: 'rulesEdit',    // 高阶规则配置弹窗
    AMOUNT_SELECT: 'amountSelect', // 初始筹码选择弹窗
    DEALING: 'dealing',         // 发牌、开局中
    DRAW: 'draw',               // 摸牌动作执行中（nextTurn）
    REVEAL_PROMPT: 'revealPrompt', // 亮牌弹窗等待选择
    WAIT_DISCARD: 'waitDiscard', // 等待出牌（等你点牌 / 等 AI 决策）
    SELF_GANG_OFFER: 'selfGangOffer', // 你的可选杠提示（点确认杠/点过/直接出牌）
    CLAIM_PROMPT: 'claimPrompt', // 吃碰杠等待你确认
    CHI_CHOICE: 'chiChoice',    // 多种吃法选择弹窗
    REPLACEMENT: 'replacement', // 杠后补牌中
    SETTLING: 'settling',       // 结算弹窗
    NEXT_GAME: 'nextGame',      // 流局/终局后"开下一局"提示
    BUST: 'bust',               // 破产确认弹窗
    ROUND_END: 'roundEnd',      // 打满 16 局提醒
    DICE_RITUAL: 'diceRitual',  // 骰子仪式（覆盖态）
    DICE_MENU: 'diceMenu',      // 清零/继续菜单（覆盖态）
};
// 合法转移表：从已确认的状态转移图整理。sim 跑 3000 局断言零违规，
// 若某条真实路径不在表里，说明表漏了（补表），而不是逻辑错了（不动逻辑）。
const PHASE_TRANSITIONS = {
    boot: ['modeSelect', 'dealing', 'draw', 'revealPrompt', 'waitDiscard', 'claimPrompt', 'nextGame'],
    modeSelect: ['rulesEdit', 'amountSelect', 'dealing', 'modeSelect'],
    rulesEdit: ['modeSelect', 'amountSelect', 'dealing'],
    amountSelect: ['dealing', 'amountSelect', 'diceRitual'],
    dealing: ['draw'],
    draw: ['revealPrompt', 'selfGangOffer', 'waitDiscard', 'settling', 'nextGame'],
    revealPrompt: ['selfGangOffer', 'waitDiscard', 'settling', 'nextGame'],
    waitDiscard: ['claimPrompt', 'selfGangOffer', 'replacement', 'settling', 'nextGame', 'draw', 'waitDiscard'],
    selfGangOffer: ['waitDiscard', 'claimPrompt', 'draw', 'replacement', 'settling', 'nextGame'],
    claimPrompt: ['waitDiscard', 'chiChoice', 'replacement', 'settling', 'nextGame', 'draw'],
    chiChoice: ['claimPrompt', 'waitDiscard'],
    replacement: ['waitDiscard', 'selfGangOffer', 'settling', 'nextGame'],
    settling: ['dealing', 'nextGame', 'bust', 'roundEnd'],
    nextGame: ['dealing'],
    bust: ['settling', 'amountSelect', 'dealing'],
    roundEnd: ['diceRitual', 'dealing'],
    diceRitual: ['diceMenu', 'dealing'], // 仪式结束：reset 进菜单 / dealer 调庄直接开新局
    diceMenu: ['dealing'],
};
Game.phase = Game.PHASE.BOOT;
Game.phaseStack = [];      // 覆盖态压栈（骰子仪式）
Game.phaseViolations = 0;  // 非法转移计数（sim 断言用）
Game.phaseHistory = [];    // 最近 40 次转移（含 why），定位"怎么走到这"用
const PHASE_HISTORY_MAX = 40;
function recordPhaseTransition(from, to, why, ok) {
    Game.phaseHistory.push({ from, to, why: why || '', ok: !!ok });
    if (Game.phaseHistory.length > PHASE_HISTORY_MAX) Game.phaseHistory.shift();
}
function setPhase(next, why) {
    const cur = Game.phase;
    if (next === cur) return cur; // 自转移：直接通过
    const allowed = PHASE_TRANSITIONS[cur] || [];
    const ok = allowed.indexOf(next) !== -1;
    recordPhaseTransition(cur, next, why, ok);
    if (!ok) {
        Game.phaseViolations++;
        try { console.warn('[phase] 非法转移 ' + cur + ' → ' + next + (why ? '（' + why + '）' : '')); } catch (e) {}
    }
    Game.phase = next;
    return next;
}
// 覆盖态进入/退出：diceRitual 可压在任意 phase 之上
function pushPhase(next, why) {
    const cur = Game.phase;
    Game.phaseStack.push(cur);
    recordPhaseTransition(cur, next, (why || '') + ' [push]', true);
    Game.phase = next;
    return next;
}
function popPhase(why) {
    const cur = Game.phase;
    const prev = Game.phaseStack.pop();
    if (prev !== undefined) Game.phase = prev;
    recordPhaseTransition(cur, prev === undefined ? cur : prev, (why || '') + ' [pop]', true);
    return Game.phase;
}
function resetPhaseStats() {
    Game.phaseViolations = 0;
    Game.phaseHistory = [];
}

// ---------- 牌总数守恒检查 ----------
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
const FULL_DECK_SIZE = suits.length * 9 * 4 + honors.length * 4; // 136
Game._lastTileWarnKey = '';
function checkTileConservation(reason) {
    if (Game.gameOver) return true;
    const n = totalTilesOf({ deck: Game.deck, discardPile: Game.discardPile, hands: Game.hands, exposedMelds: Game.exposedMelds });
    if (n === FULL_DECK_SIZE) return true;
    const key = reason + ':' + n;
    if (key !== Game._lastTileWarnKey) {
        Game._lastTileWarnKey = key;
        try { console.warn('[tile-check] 牌总数异常', n, '/', FULL_DECK_SIZE, '@' + reason, { deck: Game.deck.length, discard: Game.discardPile.length, hands: cloneState(Game.hands), melds: cloneState(Game.exposedMelds) }); } catch (e) {}
        try { Game.logFlow('【异常】牌总数异常 ' + n + '/' + FULL_DECK_SIZE + (reason ? ' @' + reason : '')); } catch (e) {}
    }
    return false;
}

// 全部 JS 按 01→15 顺序加载、共享全局作用域（无 module）；各文件职责见 README.md 的目录/改哪里表。

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
    const maxScore = Math.max(...Object.values(Game.scores));
    const isPortrait = document.body && document.body.classList.contains('portrait-layout');
    if (isPortrait) {
        // 竖屏：原版牌墙下五行列表（头像/风位/奖杯/庄/听）
        ensurePortraitStatRows();
        renderStatRow('stat-avatar', p => statAvatar[p]);
        renderStatRow('stat-wind', p => baseNames[p]);
        renderStatRow('stat-medal', p => (maxScore > 0 && Game.scores[p] === maxScore) ? '<span class="ico-star">★</span>' : '');
        renderStatRow('stat-dealer', p => p === Game.dealer ? '<span class="ico-badge ico-dealer">庄</span>' : '');
        renderStatRow('stat-tenpai', p => Game.isTenpai(p) ? '<span class="ico-badge ico-tenpai">听</span>' : '');
    } else {
        // 横屏：侧栏每人一行
        const ps = $('player-stats');
        if (ps) {
            ps.innerHTML = statOrder.map(p => {
                const medal = (maxScore > 0 && Game.scores[p] === maxScore) ? ' <span class="ico-star">★</span>' : '';
                const dealerMark = p === Game.dealer ? ' <span class="ico-badge ico-dealer">庄</span>' : '';
                const tenpaiMark = Game.isTenpai(p) ? ' <span class="ico-badge ico-tenpai">听</span>' : '';
                return `<div class="stat-line" data-player="${p}">${statAvatar[p]} ${baseNames[p]}${medal}${dealerMark}${tenpaiMark}</div>`;
            }).join('');
        }
    }
    for (const p of PLAYERS) {
        const s = Game.scores[p];
        const el = $('score-' + p);
        if (el) el.innerText = (s >= 0 ? '+' : '') + s;
    }
    scheduleSaveProgress();
}

// 完整对局记忆（积分/庄家/牌面/轮次）→ localStorage，刷新后原样恢复
const MAHJONG_STORAGE_KEY = 'qionghu_mahjong_progress_v2';
Game.restoringGame = false;
Game.saveProgressTimer = 0;
Game.savedPendingReveal = null; // 存档里记下的「等你选亮牌」类型，读档后由 resumeFromSave 使用

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
function scheduleSaveProgress() {
    if (Game.restoringGame) return;
    if (Game.saveProgressTimer) clearTimeout(Game.saveProgressTimer);
    Game.saveProgressTimer = setTimeout(() => {
        Game.saveProgressTimer = 0;
        saveGameProgress();
    }, 400);
}

/** 立刻落盘（取消未执行的防抖），用于关键节点与页面关闭前 */
function flushSaveProgress() {
    if (Game.restoringGame) return;
    if (Game.saveProgressTimer) {
        clearTimeout(Game.saveProgressTimer);
        Game.saveProgressTimer = 0;
    }
    saveGameProgress();
}

function saveGameProgress() {
    if (Game.restoringGame) return;
    if (!checkTileConservation('save')) return; // 牌数不对的异常状态不落盘，保留上一份正常存档
    try {
        localStorage.setItem(MAHJONG_STORAGE_KEY, JSON.stringify({
            v: 2,
            scores: Game.scores, dealer: Game.dealer, currentIndex: Game.currentIndex, gameOver: Game.gameOver, winner: Game.winner,
            selectedIndex: Game.selectedIndex, lastDrawnIndex: Game.lastDrawnIndex,
            deck: cloneState(Game.deck),
            hands: cloneState(Game.hands),
            exposedMelds: cloneState(Game.exposedMelds),
            discardPile: cloneState(Game.discardPile),
            windDragonBonus: cloneState(Game.windDragonBonus),
            firstTurnPending: cloneState(Game.firstTurnPending),
            lastDrawnTile: cloneState(Game.lastDrawnTile),
            lastDrawWasFinal: cloneState(Game.lastDrawWasFinal),
            aiWaitTiles: cloneState(Game.aiWaitTiles),
            // 仅持久化「下一局」；进行中吃碰杠刷新后由玩家重选，避免半自动卡死
            pendingClaimMode: Game.pendingClaim && Game.pendingClaim.mode === 'nextGame' ? 'nextGame' : null,
            // 等你选「亮牌/不亮」时刷新：记下类型，读档后重新弹窗
            pendingRevealKind: (typeof Game.pendingReveal !== 'undefined') ? Game.pendingReveal : null,
            // 亮牌拒绝记录 & 已见牌型：刷新后不重复询问、牌型重凑后恢复提示资格
            revealDeclined: cloneState(Game.revealDeclined),
            revealPatternSeen: cloneState(Game.revealPatternSeen)
        }));
    } catch (e) { /* 隐私模式等不可用时忽略 */ }
}

// 刷新/切后台前强制写入，避免防抖窗口内丢进度；同时强制落盘 AI 学习数据
window.addEventListener('pagehide', () => {
    if (Game.aiLearnSaveTimer) {
        clearTimeout(Game.aiLearnSaveTimer);
        Game.aiLearnSaveTimer = 0;
        saveAiLearn();
    }
    flushSaveProgress();
});
/* resize / orientationchange → bindOrientationListeners → handleOrientationEvent（内含 fitBottomHand） */
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaveProgress();
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
                        if (typeof old.scores[p] === 'number') Game.scores[p] = old.scores[p];
                    }
                }
                if (old && PLAYERS.includes(old.dealer)) {
                    Game.dealer = old.dealer;
                }
            }
            return false; // 无完整对局，走 initGame
        }
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return false;

        // 始终恢复跨局指标
        if (saved.scores) {
            for (const p of PLAYERS) {
                if (typeof saved.scores[p] === 'number') Game.scores[p] = saved.scores[p];
            }
        }
        if (PLAYERS.includes(saved.dealer)) {
            Game.dealer = saved.dealer;
        }

        // 完整对局快照（v2）才恢复牌面
        if (saved.v !== 2 || !Array.isArray(saved.deck) || !saved.hands) return false;
        // 进行中的牌局：牌总数必须是 136，否则说明存档已损坏，放弃牌面、只保留积分/庄家重开一局
        if (!saved.gameOver && totalTilesOf(saved) !== FULL_DECK_SIZE) {
            try { console.warn('[tile-check] 存档牌总数异常，已放弃该存档牌面：', totalTilesOf(saved)); } catch (e) {}
            return false;
        }

        Game.restoringGame = true;
        Game.deck = saved.deck;
        Game.hands = saved.hands;
        Game.exposedMelds = saved.exposedMelds || { top: [], left: [], right: [], bottom: [] };
        Game.discardPile = saved.discardPile || [];
        Game.currentIndex = typeof saved.currentIndex === 'number' ? saved.currentIndex : turnOrder.indexOf(Game.dealer);
        Game.gameOver = !!saved.gameOver;
        Game.winner = saved.winner || null;
        Game.windDragonBonus = saved.windDragonBonus || { top: false, left: false, right: false, bottom: false };
        Game.firstTurnPending = saved.firstTurnPending || { top: false, left: false, right: false, bottom: false };
        Game.lastDrawnTile = saved.lastDrawnTile || { top: null, left: null, right: null, bottom: null };
        Game.lastDrawWasFinal = saved.lastDrawWasFinal || { top: false, left: false, right: false, bottom: false };
        Game.aiWaitTiles = saved.aiWaitTiles || { top: [], left: [], right: [] };
        Game.selectedIndex = saved.selectedIndex ?? null;
        Game.lastDrawnIndex = saved.lastDrawnIndex ?? null;
        Game.pendingClaim = saved.pendingClaimMode === 'nextGame' ? { mode: 'nextGame' } : null;
        Game.savedPendingReveal = saved.pendingRevealKind || null;
        if (saved.revealDeclined) Game.revealDeclined = saved.revealDeclined;
        if (saved.revealPatternSeen) Game.revealPatternSeen = saved.revealPatternSeen;
        Game.restoringGame = false;
        return true;
    } catch (e) {
        Game.restoringGame = false;
        return false; /* 存档损坏时忽略，从当前默认状态开始 */
    }
}

// 从存档恢复后：重绘桌面，若轮到 AI 且局未结束则继续其出牌
function resumeFromSave() {
    Game.render();
    const player = turnOrder[Game.currentIndex];
    Game.highlightActive(player);
    if (Game.gameOver) {
        // 结算弹窗无法原样恢复：统一给出「开下一局」入口（庄家轮转仍按 winner 计算）
        Game.pendingClaim = { mode: 'nextGame' };
        Game.setPhase(Game.PHASE.NEXT_GAME, 'resumeFromSave/gameOver');
        Game.showIndicator('下一局', true);
        Game.logFlow((Game.winner ? (Game.nameOf(Game.winner) + ' 胡了。') : '流局。') + '点确认开下一局（积分与庄家已保留）');
        return;
    }
    // 情形一：刷新时你正在「亮牌/不亮」弹窗里——重新弹出，选完会接着做自摸判断
    if (player === 'bottom' && Game.savedPendingReveal) {
        const kind = Game.savedPendingReveal;
        Game.savedPendingReveal = null;
        if (Game.hands.bottom.length % 3 === 2 && Game.checkWindDragonPattern(Game.hands.bottom) === kind) {
            Game.offerReveal(kind);
            return;
        }
    }
    // 情形二：AI 刚打出牌、正在等你吃碰杠时刷新——currentIndex 还停在打牌那家，
    // 他手牌是 %3==1，但这一轮其实已经摸过并打完了。不能当成“还没摸牌”再摸一次
    // （否则他会连摸两次、下家被跳过、你的吃碰杠机会也丢了），应重新走吃碰杠/换人流程
    const lastDiscard = Game.discardPile[Game.discardPile.length - 1];
    if (player !== 'bottom' && Game.hands[player].length % 3 === 1 && lastDiscard && lastDiscard.player === player) {
        Game.logFlow('继续对局…');
        Game.setPhase(Game.PHASE.CLAIM_PROMPT, 'resumeFromSave/claim');
        gameTimeout(() => Game.checkClaimOrAdvance(player, lastDiscard.tile), 600);
        return;
    }
    // 恢复时先判断“当前该轮到的这家”这一轮是否已经摸过牌：
    // 手牌数 %3==2 说明已摸牌、正等着出牌；%3==1 说明这一轮还没摸牌，需要先补摸，
    // 否则这一轮会被直接跳过出牌提示，导致这张牌永远留在牌堆里没人摸到（表现为手牌永久少一张）。
    // 之前只有 AI 分支（else）做了这个判断，"你"（bottom）分支没做，是本 bug 的根因。
    const needDiscard = Game.hands[player].length % 3 === 2;
    if (player === 'bottom') {
        if (needDiscard) {
            Game.logFlow('轮到你，请点击一张牌出牌');
            Game.offerSelfGangIfAny(); // 可能把 phase 置为 selfGangOffer
            if (!Game.pendingClaim) Game.setPhase(Game.PHASE.WAIT_DISCARD, 'resumeFromSave/bottom');
        } else {
            Game.logFlow('继续对局…');
            gameTimeout(() => Game.nextTurn(), 600); // nextTurn 会置 draw
        }
    } else {
        Game.logFlow('继续对局…');
        Game.setPhase(Game.PHASE.WAIT_DISCARD, 'resumeFromSave/aiTurn');
        gameTimeout(() => {
            if (needDiscard) Game.aiDiscard(player);
            else Game.nextTurn();
        }, 600);
    }
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.suits = suits;
Game.honors = honors;
Game.PLAYERS = PLAYERS;
Game.turnOrder = turnOrder;
Game.statAvatar = statAvatar;
Game.resetAiAxisUsed = resetAiAxisUsed;
Game.markAxisUsed = markAxisUsed;
Game.resetLastCallTurn = resetLastCallTurn;
Game.learnFromWin = learnFromWin;
Game.learnFromDraw = learnFromDraw;
Game.$ = $;
Game.gameTimeout = gameTimeout;
Game.setPhase = setPhase;
Game.pushPhase = pushPhase;
Game.popPhase = popPhase;
Game.resetPhaseStats = resetPhaseStats;
Game.totalTilesOf = totalTilesOf;
Game.FULL_DECK_SIZE = FULL_DECK_SIZE;
Game.markDealer = markDealer;
Game.MAHJONG_STORAGE_KEY = MAHJONG_STORAGE_KEY;
Game.flushSaveProgress = flushSaveProgress;
Game.saveGameProgress = saveGameProgress;
Game.loadGameProgress = loadGameProgress;
Game.resumeFromSave = resumeFromSave;

;})();
