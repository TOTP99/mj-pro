// ---------- 规则配置（2.0 一期） ----------
// 两种模式：daily 日常（与旧版完全一致，不走配置）；advanced 高阶（走下方 7 开关）
// 7 开关语义（默认全关）：
//   kaimen        ON=要求开门（须碰/吃/明杠），OFF=闭手可胡
//   pinghu        ON=允许平胡（无刻子可胡），OFF=须有刻子（旧版行为）
//   yaojiu        ON=要求幺九（须含1/9/字），OFF=不要求
//   sanmenqi      ON=要求三门齐，OFF=允许缺门
//   revealDragons ON=允许中发白亮牌，OFF=不允许
//   revealWinds   ON=允许东南西北亮牌，OFF=不允许
//   sevenPairs    ON=允许七小对胡牌，OFF=不允许（旧版行为）
const RULES_STORAGE_KEY = 'mahjong_rules_v1';
const DEFAULT_RULES = {
    kaimen: false,
    pinghu: false,
    yaojiu: false,
    sanmenqi: false,
    revealDragons: false,
    revealWinds: false,
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
function ruleRequiresKaimen() { return isDailyMode() ? true : rulesConfig.kaimen; }
function ruleAllowsPinghu() { return isDailyMode() ? false : rulesConfig.pinghu; }
function ruleRequiresYaojiu() { return isDailyMode() ? true : rulesConfig.yaojiu; }
function ruleRequiresSanmenqi() { return isDailyMode() ? true : rulesConfig.sanmenqi; }
function ruleAllowsSevenPairs() { return isDailyMode() ? false : rulesConfig.sevenPairs; }
function ruleAllowsReveal(kind) {
    // 日常：沿用旧版（首巡可亮）；高阶：看开关
    if (isDailyMode()) return true;
    return kind === 'dragons' ? rulesConfig.revealDragons : rulesConfig.revealWinds;
}

// 启动时加载
loadRulesConfig();

// ---------- 模式选择 UI ----------
// 显示/隐藏弹窗（复用 .show 类）
function showModal(id) { const el = $(id); if (el) el.classList.add('show'); }
function hideModal(id) { const el = $(id); if (el) el.classList.remove('show'); }

function openModeSelect() {
    // 标出当前模式（打勾）
    document.querySelectorAll('#mode-select-modal .mode-option').forEach(function (b) {
        b.classList.toggle('cur', b.getAttribute('data-mode') === gameMode);
    });
    showModal('mode-select-modal');
}

function chooseMode(mode) {
    hideModal('mode-select-modal');
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
