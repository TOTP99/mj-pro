/* ============================================================
 * js/18-game-feel.js — 手感一期：合成音效 + 出牌飞行 + 横幅闪光 + 节奏
 * 借鉴成熟麻将游戏的共性做法（雀魂/天凤/MJ 系）：
 *   - 摸牌轻响 + 手牌右端滑入；出牌脆响（4 种随机变体防听觉疲劳）+ 飞牌落定
 *   - 吃/碰/杠各有辨识音 + 中央短横幅，不遮挡牌桌
 *   - AI 出牌 500~900ms 随机“思考”，从不秒出；动画只用 transform/opacity，
 *     绝不阻塞逻辑；prefers-reduced-motion 下跳过飞行
 * 纯装饰层：所有函数在无 AudioContext / 无真实 DOM 时静默 no-op，
 * 不得影响规则、牌数、回合逻辑（仿真环境同样成立）。
 * ============================================================ */
;(function () {
'use strict';

/* ---------------- 音效引擎（WebAudio 全合成，无外部资源） ---------------- */
var SFX_KEY = 'qj_mahjong_new_sfx_on';
var _enabled = true;
try { _enabled = localStorage.getItem(SFX_KEY) !== '0'; } catch (e) { /* 仿真桩无妨 */ }

var _ctx = null, _master = null;
function ac() {
    if (typeof window === 'undefined') return null;
    try {
        if (!_ctx) {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            _ctx = new AC();
            _master = _ctx.createGain();
            _master.gain.value = 0.45;
            _master.connect(_ctx.destination);
        }
        if (_ctx.state === 'suspended') _ctx.resume();
        return _ctx;
    } catch (e) { return null; }
}
// iOS/Safari：首次手势解锁音频上下文
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pointerdown', function unlock() {
        if (_enabled) ac();
    }, { once: true });
}

// 滤波噪声敲击（牌声主体）
function burst(o) {
    if (!_enabled) return;
    var ctx = ac(); if (!ctx) return;
    try {
        var dur = o.dur || 0.06;
        var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
        var buf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
        var src = ctx.createBufferSource(); src.buffer = buf;
        var f = ctx.createBiquadFilter(); f.type = 'bandpass';
        f.frequency.value = o.freq || 2200; f.Q.value = o.q || 1.1;
        var g = ctx.createGain();
        var t = ctx.currentTime + (o.at || 0);
        g.gain.setValueAtTime(o.gain || 0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f); f.connect(g); g.connect(_master);
        src.start(t); src.stop(t + dur + 0.02);
    } catch (e) {}
}

// 正弦/三角短音（提示音主体），freqTo 可做上滑
function tone(o) {
    if (!_enabled) return;
    var ctx = ac(); if (!ctx) return;
    try {
        var dur = o.dur || 0.1;
        var osc = ctx.createOscillator();
        osc.type = o.type || 'sine';
        var t = ctx.currentTime + (o.at || 0);
        osc.frequency.setValueAtTime(o.freq || 660, t);
        if (o.freqTo) osc.frequency.exponentialRampToValueAtTime(o.freqTo, t + dur);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(o.gain || 0.4, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(g); g.connect(_master);
        osc.start(t); osc.stop(t + dur + 0.02);
    } catch (e) {}
}

// 出牌脆响 4 种随机变体：成熟游戏的防听觉疲劳做法
var DISCARD_FREQS = [1900, 2300, 2600, 2900];

Game.sfx = {
    get enabled() { return _enabled; },
    draw:    function () { burst({ freq: 1350, dur: 0.045, gain: 0.28, q: 0.9 }); },
    discard: function () {
        var f = DISCARD_FREQS[(Math.random() * DISCARD_FREQS.length) | 0];
        burst({ freq: f, dur: 0.06, gain: 0.55 });
        burst({ freq: f * 0.5, dur: 0.09, gain: 0.22, at: 0.012 }); // 木质低频尾
    },
    chi:  function () { tone({ freq: 660, dur: 0.09, gain: 0.35 }); tone({ freq: 880, dur: 0.12, gain: 0.35, at: 0.08 }); },
    peng: function () { tone({ freq: 196, dur: 0.14, type: 'triangle', gain: 0.6 }); burst({ freq: 900, dur: 0.05, gain: 0.4 }); },
    gang: function () { tone({ freq: 130, dur: 0.2, type: 'triangle', gain: 0.65 }); burst({ freq: 5200, dur: 0.12, gain: 0.18, q: 2, at: 0.02 }); },
    win:  function () {
        var seq = [523, 587, 659, 784, 880];
        for (var i = 0; i < seq.length; i++) tone({ freq: seq[i], dur: 0.16, type: 'triangle', gain: 0.38, at: i * 0.09 });
    },
    click: function () { burst({ freq: 3200, dur: 0.03, gain: 0.22 }); },
    turn:  function () { tone({ freq: 440, dur: 0.05, gain: 0.13 }); }
};

// 音效开关（持久化），按钮文字同步
Game.toggleSfx = function () {
    _enabled = !_enabled;
    try { localStorage.setItem(SFX_KEY, _enabled ? '1' : '0'); } catch (e) {}
    if (_enabled) { ac(); Game.sfx.click(); }
    syncSfxButtons();
    return _enabled;
};
Game.isSfxEnabled = function () { return _enabled; };
function syncSfxButtons() {
    try {
        var lbl = _enabled ? '音效开' : '音效关';
        ['sfx-toggle', 'sfx-toggle-ls'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b) b.textContent = lbl;
        });
    } catch (e) {}
}
syncSfxButtons(); // 14 先于 18 建按钮：启动时按存档同步一次文字

/* ---------------- 节奏：AI 思考时长（毫秒） ---------------- */
// 固定偏置 + 随机抖动：像人一样“想一下”，从不秒出，也从不拖沓
Game.aiThinkMs = function () { return 500 + Math.random() * 400; }; // 原 900~1600ms，调快为 500~900ms

/* ---------------- 动画 helpers（纯视觉，不碰状态） ---------------- */
function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
}
function realDom() {
    try { return typeof document !== 'undefined' && document.body && document.body.nodeType === 1; }
    catch (e) { return false; }
}

Game.feel = {
    // 出牌飞行：克隆牌从 fromRect 飞到弃牌区最新一张，220ms 落定
    flyDiscard: function (fromRect, tileHtml) {
        try {
            if (reducedMotion() || !realDom() || !fromRect || !tileHtml) return;
            var river = document.querySelector('#discardWall .discardTile.latest') ||
                        document.querySelector('#discardWall');
            if (!river) return;
            var to = river.getBoundingClientRect();
            var w = fromRect.width || 34, h = fromRect.height || 46;
            var el = document.createElement('div');
            el.className = 'feel-fly';
            el.innerHTML = '<div class="tile">' + tileHtml + '</div>';
            el.style.left = fromRect.left + 'px';
            el.style.top = fromRect.top + 'px';
            el.style.width = w + 'px';
            el.style.height = h + 'px';
            document.body.appendChild(el);
            void el.offsetWidth; // 强制回流，启动过渡
            var dx = (to.left + to.width / 2) - (fromRect.left + w / 2);
            var dy = (to.top + to.height / 2) - (fromRect.top + h / 2);
            el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(0.94)';
            el.style.opacity = '0.92';
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
            // 落定小 bounce（只作用于最新弃牌，渲染重建时不重复触发）
            var latest = document.querySelector('#discardWall .discardTile.latest');
            if (latest && latest.classList) {
                latest.classList.remove('feel-land');
                void latest.offsetWidth;
                latest.classList.add('feel-land');
            }
        } catch (e) {}
    },
    // AI 出牌：从该家座位区飞出（AI 手牌是牌背，取座位中心为起点）
    flyAiDiscard: function (player, tileHtml) {
        try {
            if (reducedMotion() || !realDom()) return;
            var seat = document.getElementById('p-' + player);
            if (!seat || !seat.getBoundingClientRect) return;
            var r = seat.getBoundingClientRect();
            var w = 34, h = 46; // 以座位中心为起点，牌面大小起飞
            Game.feel.flyDiscard(
                { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2, width: w, height: h },
                tileHtml
            );
        } catch (e) {}
    },
    // 中央短横幅：吃/碰/杠/胡，0.9s 自动消失，不挡操作
    banner: function (text) {
        try {
            if (!realDom() || !text) return;
            var old = document.querySelector('.feel-banner');
            if (old && old.parentNode) old.parentNode.removeChild(old);
            var el = document.createElement('div');
            el.className = 'feel-banner';
            el.textContent = text;
            document.body.appendChild(el);
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 950);
        } catch (e) {}
    }
};

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ----
   （Game.sfx / toggleSfx / isSfxEnabled / aiThinkMs / feel 已在上方直接挂载） */

})();
