// ---------- 场次与金额管理（2.0 二期） ----------
// 场：从选定初始金额开始，到输光重开或手动重开为止
// 每 16 局提醒一次，走骰子仪式重新调庄
const FIELD_STORAGE_KEY = 'mahjong_field_v1';
const FIELD_ROUNDS = 16;

let fieldAmounts = { top: 0, left: 0, right: 0, bottom: 0 };
let fieldGameCount = 0;
let fieldActive = false; // 是否已开场（选过金额）

function loadField() {
    try {
        const raw = localStorage.getItem(FIELD_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s && s.amounts) {
                fieldAmounts = { ...s.amounts };
                fieldGameCount = s.gameCount || 0;
                fieldActive = !!s.active;
            }
        }
    } catch (e) {}
}

function saveField() {
    try {
        localStorage.setItem(FIELD_STORAGE_KEY, JSON.stringify({
            amounts: fieldAmounts, gameCount: fieldGameCount, active: fieldActive,
        }));
    } catch (e) {}
}

/** 开新场：四家以初始金额开场 */
function startNewField(initialAmount) {
    const amt = Math.max(1, Math.floor(Number(initialAmount) || 50));
    fieldAmounts = { top: amt, left: amt, right: amt, bottom: amt };
    fieldGameCount = 0;
    fieldActive = true;
    saveField();
    if (typeof renderFieldAmounts === 'function') renderFieldAmounts();
}

/** 结算后调用：更新金额、局数，检查输光与 16 局 */
function onFieldGameSettled(payouts) {
    if (!fieldActive) return;
    if (payouts) {
        for (const p of ['top', 'left', 'right', 'bottom']) {
            if (typeof payouts[p] === 'number') fieldAmounts[p] += payouts[p];
        }
    }
    fieldGameCount++;
    saveField();
    if (typeof renderFieldAmounts === 'function') renderFieldAmounts();

    // 输光检查：任何一家金额变负
    const busted = ['top', 'left', 'right', 'bottom'].find(p => fieldAmounts[p] < 0);
    if (busted) {
        // 弹确认，不直接重开
        setTimeout(() => showBustModal(busted), 800);
        return;
    }
    // 16 局提醒
    if (fieldGameCount % FIELD_ROUNDS === 0) {
        setTimeout(() => showRoundReminder(), 800);
    }
}

/** 流局也算一局 */
function onFieldDraw() {
    onFieldGameSettled(null);
}

function showBustModal(player) {
    const name = typeof nameOf === 'function' ? nameOf(player) : player;
    const el = $('bust-modal');
    if (!el) { resetFieldAfterBust(); return; }
    $('bust-message').innerText = name + ' 金额已输光（' + fieldAmounts[player] + '），是否重新开场？';
    el.classList.add('show');
}

function confirmBustRestart() {
    $('bust-modal').classList.remove('show');
    resetFieldAfterBust();
}

function cancelBustRestart() {
    $('bust-modal').classList.remove('show');
    // 用户取消：继续当前场（金额为负也继续，由用户决定）
}

function resetFieldAfterBust() {
    fieldActive = false;
    saveField();
    // 重新选金额开场
    showAmountModal();
}

function showRoundReminder() {
    const el = $('round-modal');
    if (!el) return;
    $('round-message').innerText = '已打满 ' + fieldGameCount + ' 局，走骰子仪式重新调庄。';
    el.classList.add('show');
}

function confirmRoundReselect() {
    $('round-modal').classList.remove('show');
    // 走骰子仪式重新调庄
    if (typeof startDiceRitualWithMode === 'function') {
        startDiceRitualWithMode('dealer');
    }
}

/** 金额选择弹窗 */
function showAmountModal() {
    const el = $('amount-modal');
    if (!el) { startNewField(50); return; }
    el.classList.add('show');
}

function chooseAmount(amt) {
    $('amount-modal').classList.remove('show');
    if (amt === 'custom') {
        const v = prompt('请输入初始金额：', '100');
        const n = Math.floor(Number(v));
        if (!n || n < 1) { showAmountModal(); return; }
        startNewField(n);
    } else {
        startNewField(amt);
    }
    // 开新场后开新局
    if (typeof startGame === 'function') startGame();
    else if (typeof initGame === 'function') initGame();
}

/** 界面显示金额（由 render 调用） */
function renderFieldAmounts() {
    for (const p of ['top', 'left', 'right', 'bottom']) {
        const el = $('amount-' + p);
        if (el) el.innerText = fieldAmounts[p];
    }
    const cnt = $('field-count');
    if (cnt) cnt.innerText = fieldGameCount + ' / ' + FIELD_ROUNDS;
}

loadField();
