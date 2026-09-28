// ========== 三击桌面：黄金骰子仪式（清零 / 继续） ==========
// 流程：连点空白处 3 次 → 3D 旋转 2s → 缩小消失 → 弹出清零菜单
const DICE = {
    ROLL_MS: 2400,       // 旋转时长（含惯性滑行段）
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

let tableTapTimes = [];
let diceBusy = false;
let diceRafId = 0;
let diceVanishTimer = 0;
let diceSavedClaim = null; // 仪式期间暂存吃碰杠/流局提示
let diceRitualMode = 'reset'; // 'reset' | 'dealer'
let diceLastFace = 1;

function diceEls() {
    return {
        stage: $('dice-stage'),
        scene: $('dice-scene'),
        cube: $('dice-cube'),
        shadow: $('dice-shadow')
    };
}

function initDicePips() {
    document.querySelectorAll('#dice-cube .pips').forEach(el => {
        const n = parseInt(el.dataset.n, 10);
        const on = DICE.PIPS[n] || [];
        el.innerHTML = Array.from({ length: 9 }, (_, i) =>
            on.includes(i) ? '<span class="pip"></span>' : '<span></span>'
        ).join('');
    });
}

/** 合成一串撞击噪声 + 落地低音 */
function playDiceSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const now = ctx.currentTime;
        for (let i = 0; i < 8; i++) {
            const t0 = now + i * 0.07;
            const dur = 0.04 + Math.random() * 0.03;
            const n = Math.floor(ctx.sampleRate * dur);
            const buf = ctx.createBuffer(1, n, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let j = 0; j < n; j++) data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / n, 2);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const filt = ctx.createBiquadFilter();
            filt.type = 'bandpass';
            filt.frequency.value = 800 + Math.random() * 1800;
            filt.Q.value = 1.2;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.35 * (1 - i * 0.04), t0);
            gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
            src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
            src.start(t0); src.stop(t0 + dur + 0.01);
        }
        const tEnd = now + 0.58;
        const osc = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(180, tEnd);
        osc.frequency.exponentialRampToValueAtTime(60, tEnd + 0.12);
        g2.gain.setValueAtTime(0.22, tEnd);
        g2.gain.exponentialRampToValueAtTime(0.001, tEnd + 0.14);
        osc.connect(g2); g2.connect(ctx.destination);
        osc.start(tEnd); osc.stop(tEnd + 0.15);
        setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1200);
    } catch (e) { /* 无音频权限时静默 */ }
}

// ---------- 三击判定 / 旋转动画 / 清零菜单（原先放在 05-device-orientation.js，现与骰子常量放在一起） ----------
function onTableTap(e) {
    if (diceBusy) return;
    if ($('result-modal').classList.contains('show')) return;
    if ($('reveal-modal').classList.contains('show')) return;
    if ($('chi-choice-modal').classList.contains('show')) return;
    if (e.target.closest('.tile, .tileback, .discardTile, .pool-tile, .player-label, button, .meld-group, #claim-indicator, #wall-count, #landscape-ctrl, #discard-query-btn, #discardWall, #pool-modal, img, .claim-btn, .reset-btn')) return;

    const now = Date.now();
    tableTapTimes = tableTapTimes.filter(t => now - t < DICE.TAP_WINDOW);
    tableTapTimes.push(now);
    if (tableTapTimes.length >= 3) {
        tableTapTimes = [];
        startDiceRitual();
    }
}

/** 重置骰子 DOM 状态（隐藏、清除动画类与内联 transform） */
function resetDiceDom() {
    const { stage, scene, cube, shadow } = diceEls();
    if (diceRafId) { cancelAnimationFrame(diceRafId); diceRafId = 0; }
    if (diceVanishTimer) { clearTimeout(diceVanishTimer); diceVanishTimer = 0; }
    stage.classList.remove('show', 'fade-out');
    scene.classList.remove('vanish');
    scene.style.transform = '';
    scene.style.opacity = '';
    cube.classList.remove('settled');
    cube.style.transform = '';
    if (shadow) {
        shadow.style.transform = 'translateZ(-30px) scale(1)';
        shadow.style.opacity = '0.6';
    }
}

/** 三击桌面清零菜单用 */
function startDiceRitual() {
    startDiceRitualWithMode('reset');
}

/** 长按猫头调庄：同一颗骰子，点数按东起顺时针数到谁做庄 */
function startDiceDealerRitual() {
    startDiceRitualWithMode('dealer');
}

function startDiceRitualWithMode(mode) {
    if (diceBusy) return;
    if ($('result-modal') && $('result-modal').classList.contains('show')) return;
    diceBusy = true;
    diceRitualMode = mode === 'dealer' ? 'dealer' : 'reset';
    diceSavedClaim = pendingClaim;
    pendingClaim = { mode: 'diceMenu' };
    hideIndicator();
    resetDiceDom();

    const { stage, scene, cube, shadow } = diceEls();
    stage.classList.add('show');
    playDiceSound();

    const face = 1 + Math.floor(Math.random() * 6);
    diceLastFace = face;
    const end = DICE.FACE_ROT[face];
    /* 惯性：主轴转得多、衰减慢；副轴摩擦大更快停 */
    const spinsX = (5 + Math.floor(Math.random() * 6)) * 360;
    const spinsY = (8 + Math.floor(Math.random() * 9)) * 360;
    const spinsZ = (3 + Math.floor(Math.random() * 4)) * 360;
    const phase = Math.random() * Math.PI * 2;
    const driftDir = (Math.random() < 0.5 ? -1 : 1);
    const t0 = performance.now();

    /** 角速度积分型缓动：前段快转（冲量），中段滑行（惯性），末段摩擦刹停 */
    function spinProgress(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        // 前 62%：快速释放大部分转角（≈90%）
        if (t < 0.62) {
            const u = t / 0.62;
            return (1 - Math.pow(1 - u, 1.55)) * 0.90;
        }
        // 后 38%：剩余 10% 用更强摩擦慢慢咬住目标面
        const u = (t - 0.62) / 0.38;
        return 0.90 + 0.10 * (1 - Math.pow(1 - u, 2.4));
    }
    /** 副轴摩擦更大，更早贴近终值 */
    function axisProgress(t, friction) {
        const p = spinProgress(t);
        // friction>1 → 更早接近 1
        return 1 - Math.pow(1 - p, friction);
    }

    function tick(now) {
        const t = Math.min(1, (now - t0) / DICE.ROLL_MS);
        const pY = axisProgress(t, 1.0);   // 主自旋：惯性最长
        const pX = axisProgress(t, 1.35);  // 俯仰：略快停
        const pZ = axisProgress(t, 1.55);  // 横滚：最先咬死
        const invY = 1 - pY;

        // 抛起 + 落地连跳（一次主跳 + 一次衰减小跳）
        const lift = Math.sin(Math.PI * Math.min(1, t / 0.92));
        let hop = 0;
        if (t > 0.78 && t < 0.92) {
            const u = (t - 0.78) / 0.14;
            hop = Math.sin(u * Math.PI) * 6.2 * (1 - u * 0.5);
        } else if (t >= 0.92 && t < 1) {
            const u = (t - 0.92) / 0.08;
            hop = Math.sin(u * Math.PI) * 2.2 * (1 - u);
        }
        const toss = lift * 46 + hop;

        // 空中水平漂移，落地后被摩擦拉回中心
        const air = Math.max(0, 1 - t / 0.85);
        const driftX = driftDir * Math.sin(phase + t * 5.2) * 7.5 * air * air;
        const driftZ = Math.cos(phase * 0.7 + t * 3.5) * 3.5 * air * air;

        // 转速越高 wobble 越大，随惯性衰减
        const wobbleAmp = 32 * invY * invY;
        const wobble = wobbleAmp * Math.sin((now - t0) * 0.028 + phase);
        const wobble2 = wobbleAmp * 0.55 * Math.sin((now - t0) * 0.041 + phase * 1.3);

        // 接近终面时轻微过冲再回正（咬合感）
        let overshoot = 0;
        if (t > 0.72 && t < 1) {
            const u = (t - 0.72) / 0.28;
            overshoot = Math.sin(u * Math.PI) * 14 * (1 - u) * (1 - pY);
        }

        const rx = spinsX * (1 - pX) + end.x * pX + wobble * 0.85 + overshoot * 0.25;
        const ry = spinsY * (1 - pY) + end.y * pY + wobble * 0.55;
        const rz = spinsZ * (1 - pZ) + overshoot * 0.4 + wobble2 * 0.35;

        const scale = 1 + lift * 0.26 + hop * 0.012;
        scene.style.transform =
            `translateX(${driftX}px) translateY(${-toss}px) translateZ(${driftZ}px) scale(${scale})`;
        cube.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`;
        if (shadow) {
            // 阴影略滞后于骰子水平位置 → 惯性拖影
            const lag = 0.65;
            const shX = driftX * lag;
            const shScale = Math.max(0.32, 1 - lift * 0.52 + hop * 0.03);
            shadow.style.transform =
                `translateX(${shX}px) translateZ(-28px) scale(${shScale}, ${0.85 + lift * 0.15})`;
            shadow.style.opacity = String(0.18 + 0.42 * (1 - lift * 0.85));
        }

        if (t < 1) {
            diceRafId = requestAnimationFrame(tick);
            return;
        }
        // 落地定格 → 缩小消失
        diceRafId = 0;
        scene.style.transform = 'translateY(0) scale(1)';
        cube.style.transform = `rotateX(${end.x}deg) rotateY(${end.y}deg) rotateZ(0deg)`;
        cube.classList.add('settled');
        if (shadow) {
            shadow.style.transform = 'translateZ(-28px) scale(1)';
            shadow.style.opacity = '0.55';
        }
        // 强制重绘一帧再加 vanish，确保 transition 生效
        void scene.offsetWidth;
        scene.classList.add('vanish');
        diceVanishTimer = setTimeout(() => {
            diceVanishTimer = 0;
            stage.classList.remove('show');
            scene.classList.remove('vanish');
            scene.style.transform = '';
            scene.style.opacity = '';
            if (diceRitualMode === 'dealer') {
                applyDealerFromDice(diceLastFace);
            } else {
                showDiceResetMenu();
            }
        }, DICE.VANISH_MS);
    }
    diceRafId = requestAnimationFrame(tick);
}

function showDiceResetMenu() {
    const el = $('claim-indicator');
    el.innerHTML =
        '<div class="reset-menu">'
        + '<button type="button" class="reset-btn" onclick="event.stopPropagation();confirmFullReset()">清零重启</button>'
        + '<button type="button" class="reset-btn" onclick="event.stopPropagation();cancelDiceRitual()">继续加油</button>'
        + '</div>';
    el.classList.add('show');
}

/** 继续加油：收起菜单，恢复仪式前的吃碰杠提示 */
function cancelDiceRitual() {
    resetDiceDom();
    hideIndicator();
    diceBusy = false;
    pendingClaim = diceSavedClaim;
    diceSavedClaim = null;
    if (!pendingClaim) return;
    if (pendingClaim.mode === 'nextGame') {
        showIndicator('下一局', true);
    } else if (pendingClaim.mode === 'selfGang') {
        showIndicator('杠', true);
    } else if (pendingClaim.mode === 'claim') {
        const options = [
            pendingClaim.canGang ? '杠' : null,
            pendingClaim.canPeng ? '碰' : null,
            (pendingClaim.chiCombos && pendingClaim.chiCombos.length) ? '吃' : null
        ].filter(Boolean).join('/');
        showIndicator(options, true);
    }
}

/** 清零重启：积分/庄家/存档全部归零并开新局 */

/**
 * 调庄：一颗骰 1–6，从东（bottom/猫）起顺时针数
 * turnOrder: bottom → right → top → left → bottom …
 * 1=东猫 2=南狮 3=西龙 4=北虎 5=东猫 6=南狮
 * 保留积分，按新庄重新发牌开一局
 */
function applyDealerFromDice(face) {
    resetDiceDom();
    hideIndicator();
    diceBusy = false;
    const saved = diceSavedClaim;
    diceSavedClaim = null;
    pendingClaim = null;

    const f = Math.max(1, Math.min(6, face | 0));
    const start = turnOrder.indexOf('bottom');
    const idx = (start + (f - 1)) % 4;
    dealer = turnOrder[idx];
    try { markDealer(); } catch (e) {}

    const who = (typeof seatLabel === 'function') ? seatLabel(dealer) : nameOf(dealer);
    logFlow('调庄：骰子 ' + f + ' → ' + who + ' 做庄（保留积分开新局）');
    try {
        if (typeof speak === 'function') speak(nameOf(dealer) + '庄');
    } catch (e) {}

    // 关其它弹层，保留 scores
    try {
        const rm = $('result-modal'); if (rm) rm.classList.remove('show');
        const rv = $('reveal-modal'); if (rv) rv.classList.remove('show');
        const cm = $('chi-choice-modal'); if (cm) cm.classList.remove('show');
    } catch (e) {}
    lastSettlement = null;
    winner = null;
    gameOver = false;
    selectedIndex = null;
    lastDrawnIndex = null;
    try { initGame(); } catch (e) {
        logFlow('调庄发牌失败，请三击桌面重开');
        pendingClaim = saved;
    }
}

function confirmFullReset() {
    resetDiceDom();
    hideIndicator();
    $('result-modal').classList.remove('show');
    $('reveal-modal').classList.remove('show');
    $('chi-choice-modal').classList.remove('show');
    diceBusy = false;
    diceSavedClaim = null;
    pendingClaim = null;
    lastSettlement = null;
    scores = { top: 0, left: 0, right: 0, bottom: 0 };
    dealer = 'bottom';
    try {
        localStorage.removeItem(MAHJONG_STORAGE_KEY);
        localStorage.removeItem('qionghu_mahjong_progress_v1');
    } catch (e) { /* ignore */ }
    winner = null;
    gameOver = false;
    initGame();
    logFlow('已清零，新的一局开始');
}
