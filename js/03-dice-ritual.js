/* ============================================================
 * 03-dice-ritual.js — 骰子仪式（单颗八面 d8：黄金镶钻）
 * - 三击桌面 → 清零菜单仪式；长按猫头 → 调庄仪式
 * - 一颗八面骰从屏幕外抛入桌心，翻滚弹跳后落定亮出点数
 * - 调庄：1–8 点，1-2→东（猫东）3-4→南 5-6→西 7-8→北，四家等概率
 * - 清零仪式那次的点数只是动画展示
 * ============================================================ */
;(function () {
'use strict';

/* ---------- 常量 ---------- */
const DICE = {
    R: 32,               // 八面体中心到顶点距离（小骰子）
    CAM_D: 620, CAM_F: 620,
    GRAVITY: 2600,       // 重力加速度 px/s²
    BOUNCE_DAMP: 0.5,    // 落地反弹保留系数
    BOUNCE_MIN_VY: 170,  // 小于此速度视为落定
    SETTLE_MS: 300,      // 落定转到目标面的时长
    REST_MS: 1150,       // 落定后停留展示
    VANISH_MS: 450,      // 淡出时长
    TAP_WINDOW: 550      // 三击桌面判定窗口 ms
};

/* 8 个面：符号组合 → 点数（对面之和为 9，标准 d8） */
const D8_FACES = [
    { s: [ 1,  1,  1], n: 1 }, { s: [ 1,  1, -1], n: 2 },
    { s: [ 1, -1,  1], n: 3 }, { s: [ 1, -1, -1], n: 4 },
    { s: [-1,  1,  1], n: 5 }, { s: [-1,  1, -1], n: 6 },
    { s: [-1, -1,  1], n: 7 }, { s: [-1, -1, -1], n: 8 }
];
const SQ3 = Math.sqrt(3);
/* 点数 → 座位（turnOrder 顺序：bottom→right→top→left） */
function seatIndexOfFace(face, startIdx) {
    return (startIdx + Math.floor((face - 1) / 2)) % 4; // 1-2 东 3-4 南 5-6 西 7-8 北
}

/* ---------- 状态 ---------- */
Game.tableTapTimes = Game.tableTapTimes || [];
Game.diceBusy = false;
Game.diceRitualMode = 'reset'; // 'reset' | 'dealer'
Game.diceLastFaces = [1];
Game.diceThrows = []; // 单颗骰子的物理状态（数组只为兼容旧引用）

function diceEls() {
    return {
        stage: Game.$('dice-stage'),
        scene: Game.$('dice-scene'),
        canvas: Game.$('dice-canvas')
    };
}

/** 启动时调用：canvas 版无需预生成点数 DOM，保留为空操作（兼容旧调用） */
function initDicePips() { /* no-op: d8 点数由 canvas 绘制 */ }

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
    } catch (e) { /* ignore */ }
}
/** 仪式开场哨声 */
function playDiceSound() {
    const ctx = diceCtx();
    if (!ctx) return;
    try {
        const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, t0);
        osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.12);
        g.gain.setValueAtTime(0.16, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.18);
    } catch (e) { /* ignore */ }
}

/* ---------- 三击桌面 → 清零菜单仪式 ---------- */
function onTableTap(e) {
    if (Game.diceBusy) return;
    const rm = Game.$('result-modal');
    if (rm && rm.classList.contains('show')) return;
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

function resetDiceDom() {
    const { stage, scene, canvas } = diceEls();
    if (Game.diceRafId) { cancelAnimationFrame(Game.diceRafId); Game.diceRafId = 0; }
    if (Game.diceVanishTimer) { clearTimeout(Game.diceVanishTimer); Game.diceVanishTimer = 0; }
    if (Game.diceRestTimer) { clearTimeout(Game.diceRestTimer); Game.diceRestTimer = 0; }
    Game.diceThrows = [];
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (!stage) return;
    stage.classList.remove('show');
    if (scene) {
        scene.classList.remove('vanish');
        scene.style.transform = '';
        scene.style.opacity = '';
    }
}

/* ---------- 八面体数学 ---------- */
/** 先 Ry(ry) 再 Rx(rx) */
function rot3(p, rx, ry) {
    const c1 = Math.cos(ry), s1 = Math.sin(ry);
    const x1 = p.x * c1 + p.z * s1, y1 = p.y, z1 = -p.x * s1 + p.z * c1;
    const c2 = Math.cos(rx), s2 = Math.sin(rx);
    return { x: x1, y: y1 * c2 - z1 * s2, z: y1 * s2 + z1 * c2 };
}
/** 把目标面的法线转到朝向观众所需的 rx, ry（弧度） */
function faceAngles(f) {
    const nx = f.s[0] / SQ3, ny = f.s[1] / SQ3, nz = f.s[2] / SQ3;
    return { ry: Math.atan2(-nx, nz), rx: Math.atan2(ny, Math.hypot(nx, nz)) };
}
function nearAngle(cur, target) {
    const TAU = Math.PI * 2;
    return target + TAU * Math.round((cur - target) / TAU);
}
/** 金色：更黄更暗（深 #69460a → 亮 #ebbe2d） */
function goldColor(b) {
    const dk = [105, 70, 10], lt = [235, 190, 45];
    const k = Math.max(0, Math.min(1, b));
    return 'rgb(' + Math.round(dk[0] + (lt[0] - dk[0]) * k) + ','
        + Math.round(dk[1] + (lt[1] - dk[1]) * k) + ','
        + Math.round(dk[2] + (lt[2] - dk[2]) * k) + ')';
}
const LIGHT = (function () {
    const l = { x: -0.35, y: -0.55, z: 0.76 };
    const m = Math.hypot(l.x, l.y, l.z);
    return { x: l.x / m, y: l.y / m, z: l.z / m };
})();

/* ---------- 仪式流程 ---------- */
function startDiceDealerRitual() {
    startDiceRitualWithMode('dealer');
}

function startDiceRitualWithMode(mode) {
    if (Game.diceBusy) return;
    if (Game.$('result-modal') && Game.$('result-modal').classList.contains('show')) return;
    Game.diceBusy = true;
    Game.pushPhase(Game.PHASE.DICE_RITUAL, 'startDiceRitualWithMode');
    Game.diceRitualMode = (mode === 'dealer') ? 'dealer' : 'reset';
    Game.diceSavedClaim = Game.pendingClaim;
    Game.pendingClaim = { mode: 'diceMenu' };
    Game.hideIndicator();
    resetDiceDom();

    const { stage, canvas } = diceEls();
    if (!stage || !canvas) { Game.diceBusy = false; return; }
    // canvas 铺满舞台
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    stage.classList.add('show');
    playDiceSound();

    // 调庄掷 1–8 定庄；清零仪式点数仅动画展示
    const face = D8_FACES[Math.floor(Math.random() * 8)];
    Game.diceLastFaces = [face.n];

    const cx = w / 2, cy = h * 0.46;
    const sx = Math.random() < 0.5 ? -1 : 1;
    const x0 = cx + sx * (110 + Math.random() * 70);
    const die = {
        x: x0, y: -70,
        vx: (cx + (Math.random() * 20 - 10) - x0) * 2.1, vy: 60,
        rx: Math.random() * 6.28, ry: Math.random() * 6.28,
        vrx: (650 + Math.random() * 550) * (Math.random() < 0.5 ? -1 : 1),
        vry: (650 + Math.random() * 550) * (Math.random() < 0.5 ? -1 : 1),
        floorX: cx + (Math.random() * 16 - 8), floorY: cy + (Math.random() * 12 - 6),
        face: face, state: 'fly',
        fade: 1, dpr: dpr
    };
    Game.diceThrows = [die];

    const ctx = canvas.getContext('2d');
    let last = performance.now();
    function tick(now) {
        const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000));
        last = now;
        stepDie(die, dt, now);
        drawDie(ctx, die);
        if (die.state === 'fade') {
            die.fade -= dt / (DICE.VANISH_MS / 1000);
            if (die.fade <= 0) {
                Game.diceRafId = 0;
                resetDiceDom();
                if (Game.diceRitualMode === 'dealer') {
                    applyDealerFromDice(Game.diceLastFaces[0]);
                } else {
                    showDiceResetMenu();
                }
                return;
            }
        }
        Game.diceRafId = requestAnimationFrame(tick);
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
        if (t.y >= t.floorY && t.vy > 0) {
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
                // 落定：位置咬住桌心目标点（消除弹跳带来的水平漂移），再 ease 转到目标面
                t.x = t.floorX; t.y = t.floorY;
                t.state = 'settle';
                t.settleT0 = now;
                const a = faceAngles(t.face);
                t.fromRx = t.rx; t.fromRy = t.ry;
                t.toRx = nearAngle(t.fromRx, a.rx);
                t.toRy = nearAngle(t.fromRy, a.ry);
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
            t.state = 'rest';
            t.rx = t.toRx; t.ry = t.toRy;
            t.restT0 = now;
        }
    } else if (t.state === 'rest') {
        if (now - t.restT0 > DICE.REST_MS) t.state = 'fade';
    }
}

/** 把物理状态画到 canvas：阴影 / 八面体 / 镶钻点数 */
function drawDie(ctx, t) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.save();
    ctx.scale(t.dpr || 1, t.dpr || 1);
    const w = W / (t.dpr || 1), h = H / (t.dpr || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, t.fade);
    const R = DICE.R, D = DICE.CAM_D, F = DICE.CAM_F;
    // 落地阴影
    const hgt = Math.max(0, (t.floorY - t.y)) / 400;
    ctx.save();
    ctx.translate(t.x, t.floorY + R * 0.9 + 8);
    const shScale = Math.max(0.5, 1 - hgt * 0.3);
    ctx.scale(shScale, 1);
    const sg = ctx.createRadialGradient(0, 0, 2, 0, 0, R * 1.15);
    sg.addColorStop(0, 'rgba(0,0,0,' + (0.5 * Math.max(0.2, 1 - hgt * 0.6)).toFixed(2) + ')');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.15, 0, 6.29); ctx.fill();
    ctx.restore();
    // 8 个面：旋转 → 按深度排序 → 绘制
    const items = D8_FACES.map(function (f) {
        const v = f.s.map(function (sgn, i) {
            const p = { x: 0, y: 0, z: 0 };
            if (i === 0) p.x = sgn * R; else if (i === 1) p.y = sgn * R; else p.z = sgn * R;
            return rot3(p, t.rx, t.ry);
        });
        const n = rot3({ x: f.s[0] / SQ3, y: f.s[1] / SQ3, z: f.s[2] / SQ3 }, t.rx, t.ry);
        return { f: f, v: v, n: n, z: (v[0].z + v[1].z + v[2].z) / 3 };
    });
    items.sort(function (a, b) { return a.z - b.z; }); // 远的先画
    items.forEach(function (it) {
        if (it.n.z <= 0.02) return; // 背面不画
        const b = 0.42 + 0.58 * Math.max(0, it.n.x * LIGHT.x + it.n.y * LIGHT.y + it.n.z * LIGHT.z);
        const pts = it.v.map(function (p) {
            const s = F / (D - p.z);
            return { x: t.x + p.x * s, y: t.y + p.y * s, s: s };
        });
        // 金面
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.lineTo(pts[2].x, pts[2].y);
        ctx.closePath();
        ctx.fillStyle = goldColor(b);
        ctx.fill();
        // 顶部高光
        const hg = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[2].x, pts[2].y);
        hg.addColorStop(0, 'rgba(255,250,225,' + (0.42 * b).toFixed(2) + ')');
        hg.addColorStop(0.55, 'rgba(255,250,225,0)');
        ctx.fillStyle = hg; ctx.fill();
        ctx.strokeStyle = 'rgba(90,60,10,0.55)'; ctx.lineWidth = 1; ctx.stroke();
        // 镶钻：三个顶点小钻
        pts.forEach(function (p) {
            ctx.save();
            ctx.shadowColor = 'rgba(220,240,255,0.95)'; ctx.shadowBlur = 6;
            ctx.fillStyle = '#f4faff';
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.1 * p.s, 0, 6.29); ctx.fill();
            ctx.restore();
        });
        // 钻石点数
        const cxp = (pts[0].x + pts[1].x + pts[2].x) / 3, cyp = (pts[0].y + pts[1].y + pts[2].y) / 3;
        const sc = (pts[0].s + pts[1].s + pts[2].s) / 3;
        const fs = 15 * sc;
        ctx.save();
        ctx.font = '700 ' + fs.toFixed(1) + 'px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(190,225,255,0.95)'; ctx.shadowBlur = 9;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(it.f.n, cxp, cyp + 1);
        ctx.shadowBlur = 0;
        // 星芒呼吸
        const tw = 0.6 + 0.4 * Math.sin(performance.now() / 380 + it.f.n);
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.75 * tw).toFixed(2) + ')';
        ctx.lineWidth = 1.1;
        const L = fs * 0.85 * tw;
        ctx.beginPath();
        ctx.moveTo(cxp - L, cyp); ctx.lineTo(cxp + L, cyp);
        ctx.moveTo(cxp, cyp - L * 0.7); ctx.lineTo(cxp, cyp + L * 0.7);
        ctx.stroke();
        ctx.restore();
    });
    // 落定金光
    if (t.state === 'rest' || t.state === 'fade') {
        ctx.save();
        ctx.globalAlpha *= 0.5;
        const gg = ctx.createRadialGradient(t.x, t.y, 4, t.x, t.y, R * 2.4);
        gg.addColorStop(0, 'rgba(255,220,120,0.55)');
        gg.addColorStop(1, 'rgba(255,220,120,0)');
        ctx.fillStyle = gg;
        ctx.beginPath(); ctx.arc(t.x, t.y, R * 2.4, 0, 6.29); ctx.fill();
        ctx.restore();
    }
    ctx.restore();
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
 * 调庄：一颗八面骰，1-2→东（猫东）3-4→南 5-6→西 7-8→北（四家等概率）
 * turnOrder: bottom → right → top → left → bottom …
 * 保留积分，按新庄重新发牌开一局
 */
function applyDealerFromDice(face) {
    resetDiceDom();
    Game.hideIndicator();
    Game.diceBusy = false;
    Game.phaseStack.length = 0; // 调庄另起一局，丢弃仪式前的压栈
    Game.setPhase(Game.PHASE.DEALING, 'applyDealerFromDice');
    const saved = Game.diceSavedClaim;
    Game.diceSavedClaim = null;
    Game.pendingClaim = null;

    const a = Math.max(1, Math.min(8, face | 0));
    const start = Game.turnOrder.indexOf('bottom');
    const idx = seatIndexOfFace(a, start); // 1-2→东(你) 3-4→下家 5-6→对家 7-8→上家
    Game.dealer = Game.turnOrder[idx];
    try { Game.markDealer(); } catch (e) {}
    // 调庄后新开一个 4 圈周期（局数清零，从 1/东/1 重新计）
    try { if (typeof Game.resetFieldCycle === 'function') Game.resetFieldCycle(); } catch (e) {}

    const who = (typeof Game.seatLabel === 'function') ? Game.seatLabel(Game.dealer) : Game.nameOf(Game.dealer);
    Game.logFlow('调庄：八面骰 ' + a + ' → ' + who + ' 做庄（保留积分开新局）');
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
    for (const id of ['result-modal', 'reveal-modal', 'chi-choice-modal']) {
        const el = Game.$(id);
        if (el) el.classList.remove('show');
    }
    Game.diceBusy = false;
    Game.phaseStack.length = 0; // 清零另起一局，丢弃仪式前的压栈
    Game.setPhase(Game.PHASE.DEALING, 'confirmFullReset');
    Game.diceSavedClaim = null;
    Game.pendingClaim = null;
    Game.lastSettlement = null;
    // 清零重启：筹码回到本场初始金额；没设过则默认 50（不再归零）
    const resetAmt = Math.max(1, Math.floor(Number(Game.fieldInitialAmount) || 50));
    Game.scores = { top: resetAmt, left: resetAmt, right: resetAmt, bottom: resetAmt };
    if (Game.fieldAmounts) Game.fieldAmounts = { top: resetAmt, left: resetAmt, right: resetAmt, bottom: resetAmt };
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
Game._dicePhysics = { stepDie: stepDie, drawDie: drawDie, faceAngles: faceAngles, seatIndexOfFace: seatIndexOfFace, DICE: DICE }; // 测试钩子

;})();
