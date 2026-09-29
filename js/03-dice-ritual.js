;(function(){
// ========== 金骰仪式（三击桌面清零 / 调庄掷骰，双骰） ==========
// 流程：触发 → 两颗 34px 金骰从上方抛入，落在四家头像中间 → 落定 → 缩小消失 → 回调
const DICE = {
    SIZE: 34,            // 骰子边长 px
    GRAVITY: 2600,       // px/s²
    BOUNCE_DAMP: 0.52,   // 落地反弹保留系数
    BOUNCE_MIN_VY: 170,  // 撞击速度小于此值视为落定
    SETTLE_MS: 340,      // 落定转到目标面的时长
    REST_MS: 700,        // 落定后停留
    VANISH_MS: 380,      // 缩小消失时长
    TAP_WINDOW: 450,     // 三击判定窗口
    // 3×3 点数格索引（0–8）
    PIPS: {
        1: [4],
        2: [0, 8],
        3: [0, 4, 8],
        4: [0, 2, 6, 8],
        5: [0, 2, 4, 6, 8],
        6: [0, 2, 3, 5, 6, 8]
    },
    RED_PIPS: { 1: true, 4: true }, // 传统骰子：1 / 4 点为红
    // 目标面朝前时的欧拉角
    FACE_ROT: {
        1: { x: 0, y: 0 },
        2: { x: 0, y: -90 },
        3: { x: 0, y: 180 },
        4: { x: 0, y: 90 },
        5: { x: -90, y: 0 },
        6: { x: 90, y: 0 }
    }
};

Game.tableTapTimes = [];
Game.diceBusy = false;
Game.diceRafId = 0;
Game.diceVanishTimer = 0;
Game.diceRestTimer = 0;
Game.diceSavedClaim = null; // 仪式期间暂存吃碰杠/流局提示
Game.diceRitualMode = 'reset'; // 'reset' | 'dealer'
Game.diceLastFaces = [1];
Game.diceThrows = []; // 骰子的物理状态

function diceEls() {
    return {
        stage: Game.$('dice-stage'),
        scene: Game.$('dice-scene'),
        // 双骰：与 index.html 中 dice-throw-1 / dice-throw-2 对应
        dice: [1, 2].map(i => ({
            wrap: Game.$('dice-throw-' + i),
            cube: document.querySelector('#dice-throw-' + i + ' .dice-cube'),
            shadow: document.querySelector('#dice-throw-' + i + ' .dice-shadow')
        }))
    };
}

function initDicePips() {
    document.querySelectorAll('.dice-cube .pips').forEach(el => {
        const n = parseInt(el.dataset.n, 10);
        const on = DICE.PIPS[n] || [];
        const red = !!DICE.RED_PIPS[n];
        el.innerHTML = Array.from({ length: 9 }, (_, i) =>
            on.includes(i) ? '<span class="pip' + (red ? ' red' : '') + '"></span>' : '<span></span>'
        ).join('');
    });
}

/* ---------- 音效：共用 AudioContext，由落地/弹跳事件触发 ---------- */
let diceAudioCtx = null;
function diceCtx() {
    try {
        if (!diceAudioCtx) diceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (diceAudioCtx.state === 'suspended') diceAudioCtx.resume();
        return diceAudioCtx;
    } catch (e) { return null; }
}
/** 弹跳：短促滤波噪声，intensity 0–1 决定音量与亮度 */
function playDiceBounce(intensity) {
    const ctx = diceCtx();
    if (!ctx) return;
    try {
        const t0 = ctx.currentTime;
        const dur = 0.035 + 0.03 * intensity;
        const n = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < n; j++) data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / n, 2.2);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filt = ctx.createBiquadFilter();
        filt.type = 'bandpass';
        filt.frequency.value = 1900 + Math.random() * 1600 + intensity * 600;
        filt.Q.value = 1.1;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.12 + 0.3 * intensity, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
        src.start(t0); src.stop(t0 + dur + 0.02);
    } catch (e) { /* 无音频权限时静默 */ }
}
/** 落定：木质脆响 + 低频收尾 */
function playDiceSettle() {
    const ctx = diceCtx();
    if (!ctx) return;
    try {
        const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320, t0);
        osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.07);
        g.gain.setValueAtTime(0.28, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.1);
        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(150, t0);
        osc2.frequency.exponentialRampToValueAtTime(65, t0 + 0.12);
        g2.gain.setValueAtTime(0.16, t0);
        g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
        osc2.connect(g2); g2.connect(ctx.destination);
        osc2.start(t0); osc2.stop(t0 + 0.15);
    } catch (e) { /* 无音频权限时静默 */ }
}

// ---------- 三击判定（原先放在 05-device-orientation.js，现与骰子常量放在一起） ----------
function onTableTap(e) {
    if (Game.diceBusy) return;
    if (Game.$('result-modal').classList.contains('show')) return;
    if (Game.$('reveal-modal').classList.contains('show')) return;
    if (Game.$('chi-choice-modal').classList.contains('show')) return;
    if (e.target.closest('.tile, .tileback, .discardTile, .pool-tile, .player-label, button, .meld-group, #claim-indicator, #wall-count, #discard-query-btn, #discardWall, #pool-modal, img, .claim-btn, .reset-btn')) return;

    const now = Date.now();
    Game.tableTapTimes = Game.tableTapTimes.filter(t => now - t < DICE.TAP_WINDOW);
    Game.tableTapTimes.push(now);
    if (Game.tableTapTimes.length >= 3) {
        Game.tableTapTimes = [];
        startDiceRitualWithMode('reset'); // 三击桌面清零菜单
    }
}

/** 重置骰子 DOM 状态（隐藏、清除动画类与内联 transform） */
function resetDiceDom() {
    const { stage, scene, dice } = diceEls();
    if (Game.diceRafId) { cancelAnimationFrame(Game.diceRafId); Game.diceRafId = 0; }
    if (Game.diceVanishTimer) { clearTimeout(Game.diceVanishTimer); Game.diceVanishTimer = 0; }
    if (Game.diceRestTimer) { clearTimeout(Game.diceRestTimer); Game.diceRestTimer = 0; }
    Game.diceThrows = [];
    if (!stage) return;
    stage.classList.remove('show');
    if (scene) {
        scene.classList.remove('vanish');
        scene.style.transform = '';
        scene.style.opacity = '';
    }
    dice.forEach(d => {
        if (d.wrap) { d.wrap.style.transform = ''; d.wrap.style.opacity = ''; }
        if (d.cube) { d.cube.classList.remove('settled'); d.cube.style.transform = ''; }
        if (d.shadow) { d.shadow.style.transform = ''; d.shadow.style.opacity = ''; }
    });
}

/** 长按猫头调庄：掷一颗骰，点数 1~4 从东起顺时针定庄 */
function startDiceDealerRitual() {
    startDiceRitualWithMode('dealer');
}

function startDiceRitualWithMode(mode) {
    if (Game.diceBusy) return;
    if (Game.$('result-modal') && Game.$('result-modal').classList.contains('show')) return;
    Game.diceBusy = true;
    Game.pushPhase(Game.PHASE.DICE_RITUAL, 'startDiceRitualWithMode');
    Game.diceRitualMode = mode === 'dealer' ? 'dealer' : 'reset';
    Game.diceSavedClaim = Game.pendingClaim;
    Game.pendingClaim = { mode: 'diceMenu' };
    Game.hideIndicator();
    resetDiceDom();

    const { stage, scene, dice } = diceEls();
    if (!stage || !scene) { Game.diceBusy = false; return; }
    stage.classList.add('show');

    // 双骰：清零仪式各掷 1~6；调庄仍用第 1 颗的 1~4（四家等概率），第 2 颗仅作展示
    const dealerMode = (Game.diceRitualMode === 'dealer');
    const d1 = dealerMode ? (1 + Math.floor(Math.random() * 4)) : (1 + Math.floor(Math.random() * 6));
    const d2 = 1 + Math.floor(Math.random() * 6);
    Game.diceLastFaces = [d1, d2];
    const faces = [d1, d2];

    const W = scene.clientWidth || 300;
    const H = scene.clientHeight || 260;
    // 落点：牌桌几何中心（四家头像中间）；两颗左右错开约一颗半
    const cx = W / 2, cy = H * 0.50;
    const S = DICE.SIZE;
    const pairGap = S + 10; // 两骰落点水平间距

    Game.diceThrows = dice.map((d, i) => {
        const side = (i === 0) ? -1 : 1; // 0 左、1 右
        const dir = side; // 从外侧抛入，落向中心
        const floorX = cx + side * (pairGap / 2) + (Math.random() * 8 - 4);
        const floorY = cy + (Math.random() * 10 - 5);
        return {
            el: d,
            maxX: Math.max(16, W - 16 - S),
            x: cx + side * (pairGap + 18) + (Math.random() * 12 - 6),
            y: -S - 12 - Math.random() * 20,
            vx: -side * (120 + Math.random() * 80), // 向中心飞
            vy: 50 + Math.random() * 50,
            rx: Math.random() * 360,
            ry: Math.random() * 360,
            vrx: (520 + Math.random() * 420) * (Math.random() < 0.5 ? -1 : 1),
            vry: (520 + Math.random() * 420) * (Math.random() < 0.5 ? -1 : 1),
            floorX: Math.max(16, Math.min(W - 16 - S, floorX)),
            floorY: Math.max(40, Math.min(H - 20 - S, floorY)),
            face: faces[i] || d1,
            state: 'fly', // fly → settle → done
            settleT0: 0, fromRx: 0, fromRy: 0, toRx: 0, toRy: 0
        };
    });

    let last = performance.now();
    function tick(now) {
        const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
        last = now;
        let allDone = true;
        for (const t of Game.diceThrows) {
            stepDie(t, dt, now);
            paintDie(t);
            if (t.state !== 'done') allDone = false;
        }
        if (!allDone) {
            Game.diceRafId = requestAnimationFrame(tick);
            return;
        }
        Game.diceRafId = 0;
        // 落定 → 停留 → 缩小消失 → 回调
        Game.diceRestTimer = setTimeout(() => {
            Game.diceRestTimer = 0;
            void scene.offsetWidth; // 强制重绘一帧再加 vanish，确保 transition 生效
            scene.classList.add('vanish');
            Game.diceVanishTimer = setTimeout(() => {
                Game.diceVanishTimer = 0;
                stage.classList.remove('show');
                scene.classList.remove('vanish');
                scene.style.transform = '';
                scene.style.opacity = '';
                if (Game.diceRitualMode === 'dealer') {
                    applyDealerFromDice(Game.diceLastFaces[0]);
                } else {
                    showDiceResetMenu();
                }
            }, DICE.VANISH_MS);
        }, DICE.REST_MS);
    }
    Game.diceRafId = requestAnimationFrame(tick);
}

/** 单颗骰子物理步进：重力下落 → 碰地反弹 → 减速落定转到目标面 */
function stepDie(t, dt, now) {
    if (t.state === 'fly') {
        t.vy += DICE.GRAVITY * dt;
        t.x += t.vx * dt;
        t.y += t.vy * dt;
        t.rx += t.vrx * dt;
        t.ry += t.vry * dt;
        // 左右墙反弹
        if (t.x < 16) {
            t.x = 16; t.vx = Math.abs(t.vx) * 0.6; playDiceBounce(0.25);
        } else if (t.x > t.maxX) {
            t.x = t.maxX; t.vx = -Math.abs(t.vx) * 0.6; playDiceBounce(0.25);
        }
        // 落地
        if (t.y >= t.floorY) {
            t.y = t.floorY;
            const impact = Math.abs(t.vy);
            if (impact > DICE.BOUNCE_MIN_VY) {
                t.vy = -t.vy * DICE.BOUNCE_DAMP;
                t.vx *= 0.72;
                t.vrx *= 0.55; t.vry *= 0.55;
                t.vrx += (Math.random() * 240 - 120);
                t.vry += (Math.random() * 240 - 120);
                playDiceBounce(Math.min(1, impact / 950));
            } else {
                // 落定：ease 转到目标面
                t.state = 'settle';
                t.settleT0 = now;
                const end = DICE.FACE_ROT[t.face];
                t.fromRx = t.rx; t.fromRy = t.ry;
                t.toRx = end.x + 360 * Math.round((t.rx - end.x) / 360);
                t.toRy = end.y + 360 * Math.round((t.ry - end.y) / 360);
                playDiceSettle();
            }
        }
    } else if (t.state === 'settle') {
        const u = Math.min(1, (now - t.settleT0) / DICE.SETTLE_MS);
        // easeOutBack：轻微过冲再回正 → 咬合感
        const c = 1.4;
        const e = 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
        t.rx = t.fromRx + (t.toRx - t.fromRx) * e;
        t.ry = t.fromRy + (t.toRy - t.fromRy) * e;
        if (u >= 1) {
            t.state = 'done';
            t.rx = t.toRx; t.ry = t.toRy;
            if (t.el.cube) t.el.cube.classList.add('settled');
        }
    }
}

/** 把物理状态画到 DOM：位移 / 旋转 / 阴影 */
function paintDie(t) {
    const wrap = t.el.wrap, cube = t.el.cube, shadow = t.el.shadow;
    if (!wrap) return;
    wrap.style.transform = 'translate(' + t.x.toFixed(1) + 'px, ' + t.y.toFixed(1) + 'px)';
    if (cube) cube.style.transform = 'rotateX(' + t.rx.toFixed(1) + 'deg) rotateY(' + t.ry.toFixed(1) + 'deg)';
    if (shadow) {
        const h = Math.max(0, t.floorY - t.y); // 离地高度
        const s = Math.max(0.38, 1 - h / 260);
        const offY = (t.floorY - t.y) + DICE.SIZE / 2 + 5;
        shadow.style.transform = 'translateY(' + offY.toFixed(1) + 'px) scale(' + s.toFixed(2) + ', ' + (s * 0.9).toFixed(2) + ')';
        shadow.style.opacity = (0.12 + 0.4 * s).toFixed(2);
    }
}

function showDiceResetMenu() {
    Game.setPhase(Game.PHASE.DICE_MENU, 'showDiceResetMenu');
    const el = Game.$('claim-indicator');
    el.innerHTML =
        '<div class="reset-menu">'
        + '<button type="button" class="reset-btn" onclick="event.stopPropagation();Game.confirmFullReset()">清零重启</button>'
        + '<button type="button" class="reset-btn" onclick="event.stopPropagation();Game.cancelDiceRitual()">继续加油</button>'
        + '</div>';
    el.classList.add('show');
}

/** 继续加油：收起菜单，恢复仪式前的吃碰杠提示 */
function cancelDiceRitual() {
    resetDiceDom();
    Game.hideIndicator();
    Game.diceBusy = false;
    Game.popPhase('cancelDiceRitual');
    Game.pendingClaim = Game.diceSavedClaim;
    Game.diceSavedClaim = null;
    if (!Game.pendingClaim) return;
    if (Game.pendingClaim.mode === 'nextGame') {
        Game.showIndicator('下一局', true);
    } else if (Game.pendingClaim.mode === 'selfGang') {
        Game.showIndicator('杠', true);
    } else if (Game.pendingClaim.mode === 'claim') {
        const options = [
            Game.pendingClaim.canGang ? '杠' : null,
            Game.pendingClaim.canPeng ? '碰' : null,
            (Game.pendingClaim.chiCombos && Game.pendingClaim.chiCombos.length) ? '吃' : null
        ].filter(Boolean).join('/');
        Game.showIndicator(options, true);
    }
}

/**
 * 调庄：一颗骰子，点数 1~4 → 东/南/西/北 依次（四家等概率）
 * turnOrder: bottom → right → top → left → bottom …
 * 保留积分，按新庄重新发牌开一局
 */
function applyDealerFromDice(d1) {
    resetDiceDom();
    Game.hideIndicator();
    Game.diceBusy = false;
    Game.phaseStack.length = 0; // 调庄另起一局，丢弃仪式前的压栈
    Game.setPhase(Game.PHASE.DEALING, 'applyDealerFromDice');
    const saved = Game.diceSavedClaim;
    Game.diceSavedClaim = null;
    Game.pendingClaim = null;

    const a = Math.max(1, Math.min(4, d1 | 0));
    const start = Game.turnOrder.indexOf('bottom');
    const idx = (start + (a - 1)) % 4; // 1→东(你) 2→下家 3→对家 4→上家（turnOrder 顺序）
    Game.dealer = Game.turnOrder[idx];
    try { Game.markDealer(); } catch (e) {}
    // 调庄后新开一个 4 圈周期（局数清零，从 1/东/1 重新计）
    try { if (typeof Game.resetFieldCycle === 'function') Game.resetFieldCycle(); } catch (e) {}

    const who = (typeof Game.seatLabel === 'function') ? Game.seatLabel(Game.dealer) : Game.nameOf(Game.dealer);
    Game.logFlow('调庄：骰子 ' + a + ' → ' + who + ' 做庄（保留积分开新局）');
    try {
        if (typeof Game.speak === 'function') Game.speak(Game.nameOf(Game.dealer) + '庄');
    } catch (e) {}

    // 关其它弹层，保留 scores
    try {
        const rm = Game.$('result-modal'); if (rm) rm.classList.remove('show');
        const rv = Game.$('reveal-modal'); if (rv) rv.classList.remove('show');
        const cm = Game.$('chi-choice-modal'); if (cm) cm.classList.remove('show');
    } catch (e) {}
    Game.lastSettlement = null;
    Game.winner = null;
    Game.gameOver = false;
    Game.selectedIndex = null;
    Game.lastDrawnIndex = null;
    try { Game.initGame(); } catch (e) {
        Game.logFlow('调庄发牌失败，请三击桌面重开');
        Game.pendingClaim = saved;
    }
}

/** 清零重启：积分/庄家/存档全部归零并开新局 */
function confirmFullReset() {
    resetDiceDom();
    Game.hideIndicator();
    Game.$('result-modal').classList.remove('show');
    Game.$('reveal-modal').classList.remove('show');
    Game.$('chi-choice-modal').classList.remove('show');
    Game.diceBusy = false;
    Game.phaseStack.length = 0; // 清零另起一局，丢弃仪式前的压栈
    Game.setPhase(Game.PHASE.DEALING, 'confirmFullReset');
    Game.diceSavedClaim = null;
    Game.pendingClaim = null;
    Game.lastSettlement = null;
    Game.scores = { top: 0, left: 0, right: 0, bottom: 0 };
    Game.dealer = 'bottom';
    try {
        localStorage.removeItem(Game.MAHJONG_STORAGE_KEY);
    } catch (e) { /* ignore */ }
    Game.winner = null;
    Game.gameOver = false;
    Game.initGame();
    Game.logFlow('已清零，新的一局开始');
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.initDicePips = initDicePips;
Game.onTableTap = onTableTap;
Game.startDiceDealerRitual = startDiceDealerRitual;
Game.startDiceRitualWithMode = startDiceRitualWithMode;
Game.showDiceResetMenu = showDiceResetMenu;
Game.applyDealerFromDice = applyDealerFromDice;
Game.cancelDiceRitual = cancelDiceRitual;
Game.confirmFullReset = confirmFullReset;
Game._dicePhysics = { stepDie: stepDie, paintDie: paintDie, DICE: DICE }; // 测试钩子

;})();
