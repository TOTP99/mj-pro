;(function(){
// ---------- 场次与金额管理（2.0 二期） ----------
// 场：从选定初始金额开始，到输光重开或手动重开为止
// 每 16 局提醒一次，走骰子仪式重新调庄
// 输光流程（自动）：筹码重置为本场初始金额 → 骰子仪式重新调庄 → 开始新场
const FIELD_STORAGE_KEY = 'mahjong_new_field_v1';
const FIELD_ROUNDS = 16;

Game.fieldAmounts = { top: 0, left: 0, right: 0, bottom: 0 };
Game.fieldGameCount = 0;
Game.fieldActive = false; // 是否已开场（选过金额）
Game.fieldInitialAmount = 50; // 本场开场时的初始金额（同金额重选不重开场）
Game.bustAutoRestart = null; // 输光自动重开：存输光的玩家位置，startGame 时拦截走自动流程

function loadField() {
    try {
        const raw = localStorage.getItem(FIELD_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s && s.amounts) {
                Game.fieldAmounts = { ...s.amounts };
                Game.fieldGameCount = s.gameCount || 0;
                Game.fieldActive = !!s.active;
                if (s.initialAmount > 0) Game.fieldInitialAmount = s.initialAmount;
            }
        }
    } catch (e) {}
}

function saveField() {
    try {
        localStorage.setItem(FIELD_STORAGE_KEY, JSON.stringify({
            amounts: Game.fieldAmounts, gameCount: Game.fieldGameCount, active: Game.fieldActive,
            initialAmount: Game.fieldInitialAmount,
        }));
    } catch (e) {}
}

/** 开新场：四家以初始金额开场 */
function startNewField(initialAmount) {
    const amt = Math.max(1, Math.floor(Number(initialAmount) || 50));
    Game.fieldAmounts = { top: amt, left: amt, right: amt, bottom: amt };
    Game.scores = { top: amt, left: amt, right: amt, bottom: amt }; // 头像旁数字同步为初始筹码
    Game.fieldGameCount = 0;
    Game.fieldActive = true;
    Game.fieldInitialAmount = amt;
    saveField();
    if (typeof renderFieldAmounts === 'function') renderFieldAmounts();
}

/** 结算后调用：更新金额、局数，检查输光与 16 局 */
function onFieldGameSettled(payouts) {
    if (!Game.fieldActive) return;
    if (payouts) {
        for (const p of ['top', 'left', 'right', 'bottom']) {
            if (typeof payouts[p] === 'number') Game.fieldAmounts[p] += payouts[p];
        }
    }
    Game.fieldGameCount++;
    saveField();
    if (typeof renderFieldAmounts === 'function') renderFieldAmounts();

    // 输光检查：任何一家金额变负 → 自动重开（筹码重置+骰子调庄），startGame 时执行
    const busted = ['top', 'left', 'right', 'bottom'].find(p => Game.fieldAmounts[p] < 0);
    if (busted) {
        Game.bustAutoRestart = busted;
        return;
    }
    // 16 局提醒
    if (Game.fieldGameCount % FIELD_ROUNDS === 0) {
        setTimeout(() => showRoundReminder(), 800);
    }
}

/** 流局也算一局 */
function onFieldDraw() {
    onFieldGameSettled(null);
}

/** 16 局提醒 */
function showRoundReminder() {
    const el = Game.$('round-modal');
    if (!el) return;
    Game.pushPhase(Game.PHASE.ROUND_END, 'showRoundReminder'); // 覆盖式提醒，压栈
    Game.$('round-message').innerText = '4 圈已打完（16 局），掷骰子决定下一个起始庄家。';
    el.classList.add('show');
}

function confirmRoundReselect() {
    Game.$('round-modal').classList.remove('show');
    // 走骰子仪式重新调庄
    if (typeof Game.startDiceRitualWithMode === 'function') {
        Game.startDiceRitualWithMode('dealer');
    }
}

/** 金额选择弹窗 */
function showAmountModal() {
    const el = Game.$('amount-modal');
    if (!el) { startNewField(50); return; }
    Game.setPhase(Game.PHASE.AMOUNT_SELECT, 'showAmountModal');
    Game.showTablePrompt('请选择初始筹码');
    Game.glowSelectButtons('amount-modal', true); // 最后一个是取消，不发光
    el.classList.add('show');
}

/** 署名行/横屏入口：直接选初始筹码 */
function openAmountSelect() {
    // 对局进行中需先确认（重选会重新开场）
    if (typeof Game.gameOver !== 'undefined' && !Game.gameOver) {
        Game.confirmDialog('重新开场', '重新选择初始筹码将重新开场，继续吗？', function() {
            showAmountModal();
        });
        return;
    }
    showAmountModal();
}

function closeAmountModal() {
    const el = Game.$('amount-modal');
    if (el) el.classList.remove('show');
    if (typeof Game.clearSelectGlow === 'function') Game.clearSelectGlow();
}

function chooseAmount(amt) {
    Game.$('amount-modal').classList.remove('show');
    if (typeof Game.clearSelectGlow === 'function') Game.clearSelectGlow();
    let n;
    if (amt === 'custom') {
        const v = prompt('请输入初始金额：', '100');
        n = Math.floor(Number(v));
        if (!n || n < 1) { showAmountModal(); return; }
    } else {
        n = Math.floor(Number(amt));
    }
    n = Math.max(1, n || 50);
    // 明确点选即重开新场：openAmountSelect 的确认框已承诺"重新开场"，
    // 同金额也不再静默跳过（否则确认框说了重开却没动，头像数字原地不动）。
    // chooseAmount 只被三个按钮调用，每次都是用户明确意图，无需防误触。
    startNewField(n);
    // 开新场后开新局
    if (typeof Game.startGame === 'function') Game.startGame();
    else if (typeof Game.initGame === 'function') Game.initGame();
}

/** 界面显示：局/风/圈 = 本圈第几局(1-4) / 当前庄家的门风 / 第几圈(1-4)
    东西南北过一遍（4 局）圈数 +1；圈数 >4 时走调庄。
    「风是当前庄」：直接读 Game.dealer 的固定门风，不按局数推算（庄家是骰子定的，乱序时推算不对）。 */
function fieldCircleText() {
    const c = Game.fieldGameCount || 0;
    const game = (c % 4) + 1;
    const bn = Game.baseNames || {};
    const wind = bn[Game.dealer] || '东';
    const circle = Math.floor(c / 4) + 1;
    return game + '/' + wind + '/' + circle;
}
function renderFieldAmounts() {
    const txt = fieldCircleText();
    const a = Game.$('field-count');
    if (a) a.innerText = txt;
    // 2026-10-01：横屏局数已并入第2行牌墙文字（#field-count-ls 已删除），这里同步刷新
    const wc = Game.$('wall-count-text');
    if (wc && typeof Game.wallCountLabel === 'function') wc.innerText = Game.wallCountLabel();
}

/** 骰子调庄后：新开一个 4 圈周期（局数清零） */
function resetFieldCycle() {
    Game.fieldGameCount = 0;
    Game.fieldActive = true;
    saveField();
    renderFieldAmounts();
}

loadField();

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.startNewField = startNewField;
Game.resetFieldCycle = resetFieldCycle;
Game.onFieldGameSettled = onFieldGameSettled;
Game.onFieldDraw = onFieldDraw;
Game.showRoundReminder = showRoundReminder;
Game.confirmRoundReselect = confirmRoundReselect;
Game.showAmountModal = showAmountModal;
Game.fieldCircleText = fieldCircleText; // 局数/风/圈显示（测试用）
Game.openAmountSelect = openAmountSelect;
Game.closeAmountModal = closeAmountModal;
Game.chooseAmount = chooseAmount;

;})();
