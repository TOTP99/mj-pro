;(function(){
// ---------- 规则配置（2.0 一期，2026-09-28 新版语义） ----------
// 两种模式：daily 日常（与旧版完全一致，不走配置）；advanced 高阶（走下方 9 开关）
// 新版语义：开关直接描述规则本身（不再是“相对旧版的放宽”）；默认配置 ≡ 日常玩法。
//   mustKaimen      是=必须开门（旧版），否=闭手可胡
//   mustPeng        是=必须有碰牌/刻子（旧版），否=平胡可胡
//   dragonsAsPeng   是=中发白作将相当于碰牌（旧版），否=不算（mustPeng=否时此项无意义，置灰）
//   mustYaojiu      是=必须有幺九（旧版），否=无幺九可胡
//   mustSanmenqi    是=必须三门齐（旧版），否=缺门可胡
//   revealAllowed   是=中发白/东南西北可以亮牌，否=完全不能亮
//   revealFirstTurn 是=打第一张牌前可亮（旧版首巡），否=首巡也不可
//   revealAnytime   是=随时可亮，否=仅看首巡项（开随时后首巡项置灰）
//   sevenPairs      是=七小对可胡，否=不允许（旧版）
const RULES_STORAGE_KEY = 'mahjong_new_rules_v2';
const DEFAULT_RULES = {
    mustKaimen: true,
    mustPeng: true,
    dragonsAsPeng: true,
    mustYaojiu: true,
    mustSanmenqi: true,
    revealAllowed: true,
    revealFirstTurn: true,
    revealAnytime: false,
    sevenPairs: false,
};
// 旧版 key → 新版 key 迁移（旧语义整体取反；亮牌两项合并为三项）
function migrateLegacyRules(r) {
    if (typeof r.mustKaimen !== 'boolean' && typeof r.kaimen === 'boolean') Game.rulesConfig.mustKaimen = !r.kaimen;
    if (typeof r.mustPeng !== 'boolean' && typeof r.pinghu === 'boolean') Game.rulesConfig.mustPeng = !r.pinghu;
    if (typeof r.mustYaojiu !== 'boolean' && typeof r.yaojiu === 'boolean') Game.rulesConfig.mustYaojiu = !r.yaojiu;
    if (typeof r.mustSanmenqi !== 'boolean' && typeof r.sanmenqi === 'boolean') Game.rulesConfig.mustSanmenqi = !r.sanmenqi;
    if (typeof r.revealAnytime !== 'boolean' && (typeof r.revealDragons === 'boolean' || typeof r.revealWinds === 'boolean')) {
        Game.rulesConfig.revealAllowed = true;
        Game.rulesConfig.revealFirstTurn = true;
        Game.rulesConfig.revealAnytime = !!r.revealDragons || !!r.revealWinds; // 旧版开过随时亮≈新版随时
    }
}

Game.gameMode = 'daily'; // 'daily' | 'advanced'
Game.rulesConfig = { ...DEFAULT_RULES };

function loadRulesConfig() {
    try {
        const raw = localStorage.getItem(RULES_STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            Game.gameMode = saved.mode === 'advanced' ? 'advanced' : 'daily';
            Game.rulesConfig = { ...DEFAULT_RULES };
            const r = saved.rules || {};
            for (const k of Object.keys(DEFAULT_RULES)) {
                if (typeof r[k] === 'boolean') Game.rulesConfig[k] = r[k];
            }
            migrateLegacyRules(r);
        }
    } catch (e) { /* 用默认 */ }
}

function saveRulesConfig() {
    try {
        localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify({ mode: Game.gameMode, rules: Game.rulesConfig }));
    } catch (e) { /* 存档失败不阻断 */ }
}

function isDailyMode() { return Game.gameMode !== 'advanced'; }
function setGameMode(mode) {
    Game.gameMode = mode === 'advanced' ? 'advanced' : 'daily';
    saveRulesConfig();
}
function setRule(key, val) {
    if (key in DEFAULT_RULES) {
        Game.rulesConfig[key] = !!val;
        saveRulesConfig();
    }
}
// 高阶模式下 checkHu / 亮牌用的判定开关；日常模式不走这里（直接用旧逻辑）
// 默认配置下：须开门/须刻子/中发白作将算刻子/须幺九/须三门齐/不许七小对/仅首巡可亮 ≡ 旧版
function ruleRequiresKaimen() { return isDailyMode() ? true : !!Game.rulesConfig.mustKaimen; }
function ruleRequiresPeng() { return isDailyMode() ? true : !!Game.rulesConfig.mustPeng; }
function ruleDragonsPairAsPeng() { return isDailyMode() ? true : !!Game.rulesConfig.dragonsAsPeng; }
function ruleRequiresYaojiu() { return isDailyMode() ? true : !!Game.rulesConfig.mustYaojiu; }
function ruleRequiresSanmenqi() { return isDailyMode() ? true : !!Game.rulesConfig.mustSanmenqi; }
function ruleAllowsSevenPairs() { return isDailyMode() ? false : !!Game.rulesConfig.sevenPairs; }
// kind: 'winds' | 'dragons'（新版已合并为总开关，参数仅保留兼容）；firstTurn: 是否该家首巡
function ruleAllowsReveal(kind, firstTurn) {
    if (isDailyMode()) return true; // 日常：调用方已限定首巡，沿用旧版
    if (!Game.rulesConfig.revealAllowed) return false; // 总开关关：完全不能亮
    if (Game.rulesConfig.revealAnytime) return true;   // 随时可亮
    if (!Game.rulesConfig.revealFirstTurn) return false;
    return !!firstTurn; // 仅打第一张牌前可亮
}

// 启动时加载
loadRulesConfig();

// ---------- 辅助开关（模式选择页）：危险提示 / 教练模式 ----------
// dangerHint   默认是：标出可能点炮的牌；选否则完全不标
// coachMode    默认否：轮到你时 AI 推荐一张弃牌并给一句话理由
const ASSIST_STORAGE_KEY = 'qj_mahjong_new_assist';
const DEFAULT_ASSIST = { dangerHint: true, coachMode: false };
Game.assist = { ...DEFAULT_ASSIST };
function loadAssist() {
    try {
        const raw = localStorage.getItem(ASSIST_STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            for (const k of Object.keys(DEFAULT_ASSIST)) {
                if (typeof saved[k] === 'boolean') Game.assist[k] = saved[k];
            }
        }
    } catch (e) { /* 用默认 */ }
}
function saveAssist() {
    try { localStorage.setItem(ASSIST_STORAGE_KEY, JSON.stringify(Game.assist)); } catch (e) {}
}
function setAssistYN(key, val) {
    if (!(key in DEFAULT_ASSIST)) return;
    Game.assist[key] = !!val;
    saveAssist();
    syncAssistYN(key);
    syncAssistLsButtons();
    if (key === 'dangerHint') Game.requestRender('setAssistYN/dangerHint'); // 标记开关变化即时生效
}
function syncYnRow(attr, key, on) {
    const row = document.querySelector('.rule-row[' + attr + '="' + key + '"]');
    if (!row) return;
    on = !!on;
    row.querySelectorAll('.yn-seg button').forEach(function (b) {
        b.classList.toggle('sel', (b.getAttribute('data-yn') === '1') === on);
    });
}
function syncAssistYN(key) { syncYnRow('data-assist', key, Game.assist[key]); }
function syncAssistUI() { Object.keys(DEFAULT_ASSIST).forEach(syncAssistYN); }
Game.setAssistYN = setAssistYN;
Game.syncAssistUI = syncAssistUI;
loadAssist();

// ---------- 左栏一键开关：教练模式 / 危险提示 ----------
// 2026-10-01：模式选择弹窗里的辅助分组已移除，入口只在横屏左栏（第1行教练 / 第4行危险）
function syncAssistLsButtons() {
    try {
        var c = document.getElementById('coach-toggle-ls');
        if (c) c.textContent = Game.assist.coachMode ? '教练开' : '教练关';
        var d = document.getElementById('danger-toggle-ls');
        if (d) d.textContent = Game.assist.dangerHint ? '危险开' : '危险关';
    } catch (e) {}
}
Game.toggleCoachMode = function () {
    setAssistYN('coachMode', !Game.assist.coachMode);
};
Game.toggleDangerHint = function () {
    setAssistYN('dangerHint', !Game.assist.dangerHint);
};
syncAssistLsButtons(); // 启动时按存档同步一次左栏文字

// ---------- 模式选择 UI ----------
// 显示/隐藏弹窗（复用 .show 类）
function showModal(id) { const el = Game.$(id); if (el) el.classList.add('show'); }
function hideModal(id) { const el = Game.$(id); if (el) el.classList.remove('show'); }

// 13. 通用二次确认弹窗（替代原生 confirm，样式统一）
Game._confirmCallback = null;
Game.confirmDialog = function(title, message, onConfirm) {
    const t = Game.$('confirm-title');
    const m = Game.$('confirm-message');
    const ok = Game.$('confirm-ok');
    if (t) t.innerText = title || '请确认';
    if (m) m.innerText = message || '';
    Game._confirmCallback = (typeof onConfirm === 'function') ? onConfirm : null;
    if (ok) {
        ok.onclick = function() {
            Game.closeConfirm();
            if (Game._confirmCallback) {
                const cb = Game._confirmCallback;
                Game._confirmCallback = null;
                cb();
            }
        };
    }
    showModal('confirm-modal');
};
Game.closeConfirm = function() {
    Game._confirmCallback = null;
    hideModal('confirm-modal');
};

/** 牌桌中央提示条：模式/筹码选择时先亮提示、弹窗稍后跟上
    位置取四头像中心连成的菱形正中心（实时计算，替代固定的 50%/50%） */
function placePromptAtDiamondCenter() {
    const el = Game.$('table-center-prompt');
    const frame = Game.$('table-frame');
    if (!el || !frame) return;
    // 头像用 getBoundingClientRect 取可视中心：自带玩家座位的
    // translate/rotate transform，也自带 #table-wrap 的缩放。
    // 提示条是 #table-frame 的子元素，style.left/top 属于 frame 本地（未缩放）坐标系，
    // 因此用"可视中心 − frame 可视原点，再除以渲染缩放"换算回去。
    // 缩放 = frame 渲染宽度 ÷ 布局宽度（不解析 transform 矩阵，稳）。
    const fr = frame.getBoundingClientRect();
    const scale = (frame.offsetWidth > 0) ? (fr.width / frame.offsetWidth) : 1;
    let sx = 0, sy = 0, n = 0;
    ['top', 'left', 'right', 'bottom'].forEach(function (p) {
        const host = document.getElementById('p-' + p);
        const av = host ? host.querySelector('.avatar') : null;
        if (!av) return;
        const r = av.getBoundingClientRect();
        if (!(r.width > 0) || !(r.height > 0)) return;
        sx += r.left + r.width / 2; sy += r.top + r.height / 2; n++;
    });
    if (n < 4 || !(scale > 0)) return; // 头像不全，保持 CSS 默认位置
    // 菱形中心 = 四可视中心点坐标平均；CSS translate(-50%,-50%) 让提示条中心落在此点
    el.style.left = ((sx / n - fr.left) / scale) + 'px';
    el.style.top = ((sy / n - fr.top) / scale) + 'px';
}
function showTablePrompt(text) {
    const el = Game.$('table-center-prompt');
    if (el) { el.textContent = text; placePromptAtDiamondCenter(); el.classList.add('show'); }
}
function hideTablePrompt() {
    const el = Game.$('table-center-prompt');
    if (el) el.classList.remove('show');
}
/** 选择类弹窗的按钮呼吸发光；skipLast 跳过最后一个按钮（如取消） */
function glowSelectButtons(modalId, skipLast) {
    const btns = document.querySelectorAll('#' + modalId + ' button');
    btns.forEach(function (b, i) {
        b.classList.toggle('btn-glow', !(skipLast && i === btns.length - 1));
    });
}
function clearSelectGlow() {
    document.querySelectorAll('.btn-glow').forEach(function (b) { b.classList.remove('btn-glow'); });
    hideTablePrompt();
}

function openModeSelect() {
    Game.setPhase(Game.PHASE.MODE_SELECT, 'openModeSelect');
    // 标出当前模式（打勾）
    document.querySelectorAll('#mode-select-modal .mode-option').forEach(function (b) {
        b.classList.toggle('cur', b.getAttribute('data-mode') === Game.gameMode);
    });
    Game.syncAssistUI(); // 辅助开关（危险提示/教练模式）同步当前值
    // 先在牌桌中央提示，弹窗稍后跟上，把注意力先引到牌桌
    showTablePrompt('请选择模式');
    glowSelectButtons('mode-select-modal', false);
    setTimeout(function () { showModal('mode-select-modal'); }, 650);
}

function chooseMode(mode) {
    hideModal('mode-select-modal');
    clearSelectGlow();
    const gameLive = !Game.gameOver && !!Game.fieldActive; // 对局进行中且已开场
    if (mode === 'advanced') {
        // 已在高阶且对局进行中：快照当前规则，供 confirmRules 判断用户是否真改了
        rulesSnapshotBeforeEdit = (gameLive && Game.gameMode === 'advanced') ? snapshotRules() : null;
        // 高阶：先显示规则页（带上次配置）
        Game.setPhase(Game.PHASE.RULES_EDIT, 'chooseMode/advanced');
        syncRulesUI();
        showModal('rules-modal');
        return;
    }
    // 日常：已在日常且对局进行中 → 同模式，不确认、不重开，手牌不动
    if (gameLive && Game.gameMode === 'daily') return;
    // 如果已有对局在进行，换模式开新局需先确认
    if (!Game.gameOver) { // gameOver 在 01 加载时恒为 false，无需 typeof 守卫
        Game.confirmDialog('切换模式', '切换到日常模式将重新开局，继续吗？', function() {
            setGameMode('daily');
            startGameWithMode();
        });
        return;
    }
    setGameMode('daily');
    startGameWithMode();
}

function setRuleYN(key, val) {
    setRule(key, val);
    syncRuleYN(key);
    refreshRuleExclusions();
}

function syncRuleYN(key) { syncYnRow('data-rule', key, Game.rulesConfig[key]); }

function syncRulesUI() {
    Object.keys(DEFAULT_RULES).forEach(syncRuleYN);
    refreshRuleExclusions();
}

// 互斥/从属：置灰不可选（值保留，条件恢复后自动可用）
function refreshRuleExclusions() {
    setRowDisabled('dragonsAsPeng', !Game.rulesConfig.mustPeng); // 不要求碰牌时，中发白作将项无意义
    setRowDisabled('revealFirstTurn', !Game.rulesConfig.revealAllowed || !!Game.rulesConfig.revealAnytime);
    setRowDisabled('revealAnytime', !Game.rulesConfig.revealAllowed); // 总开关关：两个时机项都置灰
}
function setRowDisabled(key, disabled) {
    const row = document.querySelector('.rule-row[data-rule="' + key + '"]');
    if (row) row.classList.toggle('disabled', !!disabled);
}

// 规则快照：进规则页时记下，对局进行中点"应用"时若一条没改就不重开
var rulesSnapshotBeforeEdit = null;
function snapshotRules() {
    const s = {};
    Object.keys(DEFAULT_RULES).forEach(function (k) { s[k] = !!Game.rulesConfig[k]; });
    return s;
}
function rulesEqual(a, b) {
    return Object.keys(DEFAULT_RULES).every(function (k) { return !!a[k] === !!b[k]; });
}

function confirmRules() {
    const gameLive = !Game.gameOver && !!Game.fieldActive;
    // 对局进行中、已在高阶、规则一条没动 → 不重开，手牌不动
    if (gameLive && Game.gameMode === 'advanced' && rulesSnapshotBeforeEdit && rulesEqual(rulesSnapshotBeforeEdit, Game.rulesConfig)) {
        hideModal('rules-modal');
        rulesSnapshotBeforeEdit = null;
        return;
    }
    rulesSnapshotBeforeEdit = null;
    if (!Game.gameOver) { // gameOver 在 01 加载时恒为 false，无需 typeof 守卫
        Game.confirmDialog('应用规则', '应用高阶规则将重新开局，继续吗？', function() {
            hideModal('rules-modal');
            setGameMode('advanced');
            startGameWithMode();
        });
        return;
    }
    hideModal('rules-modal');
    setGameMode('advanced');
    startGameWithMode();
}

function backToModeSelect() {
    hideModal('rules-modal');
    Game.setPhase(Game.PHASE.MODE_SELECT, 'backToModeSelect');
    Game.syncAssistUI();
    showTablePrompt('请选择模式');
    glowSelectButtons('mode-select-modal', false);
    showModal('mode-select-modal');
}

function startGameWithMode() {
    // 若未开场，先选金额
    if (typeof Game.fieldActive !== 'undefined' && !Game.fieldActive) {
        if (typeof Game.showAmountModal === 'function') {
            Game.showAmountModal();
            return;
        }
    }
    // 按当前模式开新局
    if (typeof Game.startGame === 'function') Game.startGame();
    else if (typeof Game.initGame === 'function') Game.initGame();
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.isDailyMode = isDailyMode;
Game.setGameMode = setGameMode;
Game.setRule = setRule;
Game.ruleRequiresKaimen = ruleRequiresKaimen;
Game.ruleRequiresPeng = ruleRequiresPeng;
Game.ruleDragonsPairAsPeng = ruleDragonsPairAsPeng;
Game.ruleRequiresYaojiu = ruleRequiresYaojiu;
Game.ruleRequiresSanmenqi = ruleRequiresSanmenqi;
Game.ruleAllowsSevenPairs = ruleAllowsSevenPairs;
Game.ruleAllowsReveal = ruleAllowsReveal;
Game.showTablePrompt = showTablePrompt;
Game.glowSelectButtons = glowSelectButtons;
Game.clearSelectGlow = clearSelectGlow;
Game.openModeSelect = openModeSelect;
Game.chooseMode = chooseMode;
Game.setRuleYN = setRuleYN;
Game.confirmRules = confirmRules;
Game.backToModeSelect = backToModeSelect;
Game.placePromptAtDiamondCenter = placePromptAtDiamondCenter;

;})();
