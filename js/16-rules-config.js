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

let gameMode = 'daily'; // 'daily' | 'advanced'
let rulesConfig = { ...DEFAULT_RULES };

function loadRulesConfig() {
    try {
        const raw = localStorage.getItem(RULES_STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            gameMode = saved.mode === 'advanced' ? 'advanced' : 'daily';
            rulesConfig = { ...DEFAULT_RULES };
            for (const k of Object.keys(DEFAULT_RULES)) {
                if (typeof saved.rules?.[k] === 'boolean') rulesConfig[k] = saved.rules[k];
            }
        }
    } catch (e) { /* 用默认 */ }
}

function saveRulesConfig() {
    try {
        localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify({ mode: gameMode, rules: rulesConfig }));
    } catch (e) { /* 存档失败不阻断 */ }
}

function isDailyMode() { return gameMode !== 'advanced'; }
function setGameMode(mode) {
    gameMode = mode === 'advanced' ? 'advanced' : 'daily';
    saveRulesConfig();
}
function getRules() { return { ...rulesConfig }; }
function setRule(key, val) {
    if (key in DEFAULT_RULES) {
        rulesConfig[key] = !!val;
        saveRulesConfig();
    }
}

// 高阶模式下 checkHu 用的判定开关；日常模式不走这里（直接用旧逻辑）
// 全关时：须开门/须幺九/须三门齐/须刻子/不许七小对 ≡ 旧版
function ruleRequiresKaimen() { return isDailyMode() ? true : !rulesConfig.kaimen; }
function ruleAllowsPinghu() { return isDailyMode() ? false : rulesConfig.pinghu; }
function ruleRequiresYaojiu() { return isDailyMode() ? true : !rulesConfig.yaojiu; }
function ruleRequiresSanmenqi() { return isDailyMode() ? true : !rulesConfig.sanmenqi; }
function ruleAllowsSevenPairs() { return isDailyMode() ? false : rulesConfig.sevenPairs; }
// kind: 'winds' | 'dragons'；firstTurn: 是否该家首巡
function ruleAllowsReveal(kind, firstTurn) {
    if (isDailyMode()) return true; // 日常：调用方已限定首巡，沿用旧版
    if (firstTurn) return true;      // 高阶首巡：沿用旧版（两种都可亮）
    return kind === 'dragons' ? rulesConfig.revealDragons : rulesConfig.revealWinds;
}

// 启动时加载
loadRulesConfig();

// ---------- 模式选择 UI ----------
// 显示/隐藏弹窗（复用 .show 类）
function showModal(id) { const el = $(id); if (el) el.classList.add('show'); }
function hideModal(id) { const el = $(id); if (el) el.classList.remove('show'); }

/** 牌桌中央提示条：模式/筹码选择时先亮提示、弹窗稍后跟上 */
function showTablePrompt(text) {
    const el = $('table-center-prompt');
    if (el) { el.textContent = text; el.classList.add('show'); }
}
function hideTablePrompt() {
    const el = $('table-center-prompt');
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
    // 标出当前模式（打勾）
    document.querySelectorAll('#mode-select-modal .mode-option').forEach(function (b) {
        b.classList.toggle('cur', b.getAttribute('data-mode') === gameMode);
    });
    // 先在牌桌中央提示，弹窗稍后跟上，把注意力先引到牌桌
    showTablePrompt('请选择模式');
    glowSelectButtons('mode-select-modal', false);
    setTimeout(function () { showModal('mode-select-modal'); }, 650);
}

function chooseMode(mode) {
    hideModal('mode-select-modal');
    clearSelectGlow();
    if (mode === 'advanced') {
        // 高阶：先显示规则页（带上次配置）
        syncRulesUI();
        showModal('rules-modal');
    } else {
        // 如果已有对局在进行，换模式开新局需先确认
        if (typeof gameOver !== 'undefined' && !gameOver) {
            if (!confirm('切换到日常模式将重新开局，继续吗？')) return;
        }
        setGameMode('daily');
        startGameWithMode();
    }
}

function setRuleYN(key, val) {
    setRule(key, val);
    syncRuleYN(key);
}

function syncRuleYN(key) {
    const row = document.querySelector('.rule-row[data-rule="' + key + '"]');
    if (!row) return;
    const on = !!rulesConfig[key];
    row.querySelectorAll('.yn-seg button').forEach(function (b) {
        b.classList.toggle('sel', (b.getAttribute('data-yn') === '1') === on);
    });
}

function syncRulesUI() {
    Object.keys(DEFAULT_RULES).forEach(syncRuleYN);
}

function confirmRules() {
    if (typeof gameOver !== 'undefined' && !gameOver) {
        if (!confirm('应用高阶规则将重新开局，继续吗？')) return;
    }
    hideModal('rules-modal');
    setGameMode('advanced');
    startGameWithMode();
}

function backToModeSelect() {
    hideModal('rules-modal');
    showTablePrompt('请选择模式');
    glowSelectButtons('mode-select-modal', false);
    showModal('mode-select-modal');
}

function startGameWithMode() {
    // 若未开场，先选金额
    if (typeof fieldActive !== 'undefined' && !fieldActive) {
        if (typeof showAmountModal === 'function') {
            showAmountModal();
            return;
        }
    }
    // 按当前模式开新局
    if (typeof startGame === 'function') startGame();
    else if (typeof initGame === 'function') initGame();
}
