;(function(){
// ---------- 规则配置（2.0 一期） ----------
// 两种模式：daily 日常（与旧版完全一致，不走配置）；advanced 高阶（走下方 7 开关）
// 7 开关语义：每项 ON 都是相对旧版的额外许可/放宽，OFF 则严格等于旧版行为。
// 因此 7 项全关的高阶 ≡ 日常旧版（用户要求：默认关就和现在玩法没区别）。
//   kaimen        ON=闭手可胡（放宽），OFF=须开门（旧版）
//   pinghu        ON=平胡可胡（无刻子；中发白作将亦可），OFF=须有刻子（旧版）
//   yaojiu        ON=无幺九可胡（放宽），OFF=须含幺九（旧版）
//   sanmenqi      ON=缺门可胡（放宽），OFF=须三门齐（旧版）
//   revealDragons ON=中发白随时可亮，OFF=仅首巡可亮（旧版）
//   revealWinds   ON=东南西北随时可亮，OFF=仅首巡可亮（旧版）
//   sevenPairs    ON=允许七小对胡牌，OFF=不允许（旧版）
const RULES_STORAGE_KEY = 'mahjong_rules_v2'; // v2：开关语义重定义，旧存档作废
const DEFAULT_RULES = {
    kaimen: false,
    pinghu: false,
    yaojiu: false,
    sanmenqi: false,
    revealDragons: true, // 用户要求：随时亮牌默认开启
    revealWinds: true,
    sevenPairs: false,
};

Game.gameMode = 'daily'; // 'daily' | 'advanced'
Game.rulesConfig = { ...DEFAULT_RULES };

function loadRulesConfig() {
    try {
        const raw = localStorage.getItem(RULES_STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            Game.gameMode = saved.mode === 'advanced' ? 'advanced' : 'daily';
            Game.rulesConfig = { ...DEFAULT_RULES };
            for (const k of Object.keys(DEFAULT_RULES)) {
                if (typeof saved.rules?.[k] === 'boolean') Game.rulesConfig[k] = saved.rules[k];
            }
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
function getRules() { return { ...Game.rulesConfig }; }
function setRule(key, val) {
    if (key in DEFAULT_RULES) {
        Game.rulesConfig[key] = !!val;
        saveRulesConfig();
    }
}

// 高阶模式下 checkHu 用的判定开关；日常模式不走这里（直接用旧逻辑）
// 全关时：须开门/须幺九/须三门齐/须刻子/不许七小对 ≡ 旧版
function ruleRequiresKaimen() { return isDailyMode() ? true : !Game.rulesConfig.kaimen; }
function ruleAllowsPinghu() { return isDailyMode() ? false : Game.rulesConfig.pinghu; }
function ruleRequiresYaojiu() { return isDailyMode() ? true : !Game.rulesConfig.yaojiu; }
function ruleRequiresSanmenqi() { return isDailyMode() ? true : !Game.rulesConfig.sanmenqi; }
function ruleAllowsSevenPairs() { return isDailyMode() ? false : Game.rulesConfig.sevenPairs; }
// kind: 'winds' | 'dragons'；firstTurn: 是否该家首巡
function ruleAllowsReveal(kind, firstTurn) {
    if (isDailyMode()) return true; // 日常：调用方已限定首巡，沿用旧版
    if (firstTurn) return true;      // 高阶首巡：沿用旧版（两种都可亮）
    return kind === 'dragons' ? Game.rulesConfig.revealDragons : Game.rulesConfig.revealWinds;
}

// 启动时加载
loadRulesConfig();

// ---------- 模式选择 UI ----------
// 显示/隐藏弹窗（复用 .show 类）
function showModal(id) { const el = Game.$(id); if (el) el.classList.add('show'); }
function hideModal(id) { const el = Game.$(id); if (el) el.classList.remove('show'); }

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
Game.placePromptAtDiamondCenter = placePromptAtDiamondCenter;
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
    if (typeof Game.gameOver !== 'undefined' && !Game.gameOver) {
        if (!confirm('切换到日常模式将重新开局，继续吗？')) return;
    }
    setGameMode('daily');
    startGameWithMode();
}

function setRuleYN(key, val) {
    setRule(key, val);
    syncRuleYN(key);
}

function syncRuleYN(key) {
    const row = document.querySelector('.rule-row[data-rule="' + key + '"]');
    if (!row) return;
    const on = !!Game.rulesConfig[key];
    row.querySelectorAll('.yn-seg button').forEach(function (b) {
        b.classList.toggle('sel', (b.getAttribute('data-yn') === '1') === on);
    });
}

function syncRulesUI() {
    Object.keys(DEFAULT_RULES).forEach(syncRuleYN);
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
    if (typeof Game.gameOver !== 'undefined' && !Game.gameOver) {
        if (!confirm('应用高阶规则将重新开局，继续吗？')) return;
    }
    hideModal('rules-modal');
    setGameMode('advanced');
    startGameWithMode();
}

function backToModeSelect() {
    hideModal('rules-modal');
    Game.setPhase(Game.PHASE.MODE_SELECT, 'backToModeSelect');
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
Game.getRules = getRules;
Game.setRule = setRule;
Game.ruleRequiresKaimen = ruleRequiresKaimen;
Game.ruleAllowsPinghu = ruleAllowsPinghu;
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

;})();
