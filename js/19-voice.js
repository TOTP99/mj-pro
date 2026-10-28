/* ============================================================
 * js/19-voice.js — 预录中文报牌（牌名 / 吃碰杠胡 / 自摸 / 点炮 / 庄 / 流局 / 亮牌）
 * 用 audio/ 目录下的 mp3，通过 WebAudio 播放。
 * 来源：单机版同名文件，接线方式针对 room 改过（见下）：
 *  ① room 的 08-game-flow-core.js 是 IIFE，speak 不是全局函数，
 *     原样抄会因 window.speak 不存在而直接返回；这里改为包 Game.speak。
 *  ② 新开一局时先停掉本局排队的 mp3：room 的 resetSpeechQueue 只在
 *     08 内部，外面够不着，这里包一层 Game.initGame，效果与单机版一致。
 * 认不出的文本 → 回退原来的浏览器语音。
 * ============================================================ */
(function () {
    'use strict';
    var G = window.Game;
    var origSpeak = (G && G.speak) || window.speak;
    var origReset = (G && G.resetSpeechQueue) || window.resetSpeechQueue;
    if (typeof origSpeak !== 'function') return;

    var AUDIO_BASE = 'audio/';
    var KEYS = [
        'chi', 'peng', 'gang', 'hu', 'zimo', 'liuju', 'liangpai',
        'dp_e', 'dp_s', 'dp_w', 'dp_n', 'dp_you',
        'zhuang_e', 'zhuang_s', 'zhuang_w', 'zhuang_n',
        'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
        't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9',
        'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9',
        'z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'
    ];

    var ctx = null, master = null;
    var buffers = {};          // key -> AudioBuffer
    var loading = {};          // key -> Promise
    var active = [];           // 正在播的 source
    var nextStart = 0;
    var GAP = 0.03;            // 片段间隔（秒）
    var MAX_LAG = 2.6;         // 积压超此时长则丢弃，保持同步

    function getCtx() {
        if (ctx) return ctx;
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
            master = ctx.createGain();
            master.gain.value = 1.0;
            master.connect(ctx.destination);
        } catch (e) { ctx = null; }
        return ctx;
    }

    function load(key) {
        if (buffers[key]) return Promise.resolve(buffers[key]);
        if (loading[key]) return loading[key];
        var c = getCtx();
        if (!c) return Promise.reject();
        loading[key] = fetch(AUDIO_BASE + key + '.mp3')
            .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.arrayBuffer();
            })
            .then(function (ab) {
                return new Promise(function (resolve, reject) {
                    c.decodeAudioData(ab, function (buf) {
                        buffers[key] = buf;
                        delete loading[key];
                        resolve(buf);
                    }, function (err) {
                        delete loading[key];
                        reject(err);
                    });
                });
            })
            .catch(function (e) {
                delete loading[key];
                return Promise.reject(e);
            });
        return loading[key];
    }

    function preloadAll() {
        KEYS.forEach(function (k) { load(k).catch(function () {}); });
    }

    // 首次手势解锁 iOS AudioContext，并预加载
    function unlock() {
        var c = getCtx();
        if (!c) return;
        try { if (c.state === 'suspended') c.resume(); } catch (e) {}
        try {
            var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource();
            s.buffer = b; s.connect(c.destination); s.start(0);
        } catch (e) {}
        preloadAll();
    }
    ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'].forEach(function (ev) {
        try { window.addEventListener(ev, unlock, { capture: true, passive: true }); } catch (e) {}
    });
    try { preloadAll(); } catch (e) {}

    // ---------- 文本 → 片段序列 ----------
    var NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
    var SUIT = { '万': 'm', '条': 't', '筒': 'p' };
    var HONOR = { '东': 'z1', '南': 'z2', '西': 'z3', '北': 'z4', '中': 'z5', '发': 'z6', '白': 'z7' };
    var SEAT = { '东': 'e', '南': 's', '西': 'w', '北': 'n' };

    function parse(text) {
        var s = String(text).replace(/[\s,，。！!、]/g, '');
        var out = [], i = 0, m;
        while (i < s.length) {
            var rest = s.slice(i);
            if ((m = /^([东南西北])庄/.exec(rest))) { out.push('zhuang_' + SEAT[m[1]]); i += 2; continue; }
            if ((m = /^([东南西北])点炮/.exec(rest))) { out.push('dp_' + SEAT[m[1]]); i += 3; continue; }
            if ((m = /^你点炮/.exec(rest))) { out.push('dp_you'); i += 3; continue; }
            if ((m = /^([一二三四五六七八九])([万条筒])/.exec(rest))) {
                out.push(SUIT[m[2]] + (NUM.indexOf(m[1]) + 1)); i += 2; continue;
            }
            if (rest.indexOf('胡了') === 0) { out.push('hu'); i += 2; continue; }
            if (rest.indexOf('自摸') === 0) { out.push('zimo'); i += 2; continue; }
            if (rest.indexOf('流局') === 0) { out.push('liuju'); i += 2; continue; }
            if (rest.indexOf('亮牌') === 0) { out.push('liangpai'); i += 2; continue; }
            var ch = rest.charAt(0);
            if (ch === '吃') out.push('chi');
            else if (ch === '碰') out.push('peng');
            else if (ch === '杠') out.push('gang');
            else if (HONOR[ch]) out.push(HONOR[ch]);
            else return null;                       // 认不出 → 交还给浏览器语音
            i += 1;
        }
        return out.length ? out : null;
    }

    // ---------- 播放 ----------
    function speak(text) {
        try {
            var keys = parse(text);
            var c = getCtx();
            if (!keys || !c) return origSpeak(text);

            // 确保全部已加载；未完成则跳过本句（不回退到不稳定 TTS）
            var missing = false;
            for (var k = 0; k < keys.length; k++) {
                if (!buffers[keys[k]]) {
                    load(keys[k]).catch(function () {});
                    missing = true;
                }
            }
            if (missing) return;

            if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }

            var now = c.currentTime;
            if (nextStart < now) nextStart = now + 0.01;
            if (nextStart - now > MAX_LAG) return;        // 积压太多：丢弃

            for (k = 0; k < keys.length; k++) {
                var src = c.createBufferSource();
                src.buffer = buffers[keys[k]];
                src.connect(master);
                src.start(nextStart);
                active.push(src);
                src.onended = (function (s) {
                    return function () {
                        var j = active.indexOf(s);
                        if (j >= 0) active.splice(j, 1);
                    };
                })(src);
                nextStart += src.buffer.duration + GAP;
            }
        } catch (e) {
            try { origSpeak(text); } catch (e2) {}
        }
    }

    function reset() {
        try { if (origReset) origReset(); } catch (e) {}
        try {
            active.forEach(function (s) { try { s.stop(); } catch (e) {} });
        } catch (e) {}
        active = [];
        nextStart = 0;
    }

    window.speak = speak;
    if (G) G.speak = speak;
    // 新开一局先停 mp3（见文件头 ②）
    try {
        if (G && typeof G.initGame === 'function') {
            var origInit = G.initGame;
            G.initGame = function () {
                try { reset(); } catch (e) {}
                return origInit.apply(this, arguments);
            };
        }
    } catch (e) {}
    window.voiceClips = { parse: parse, preload: preloadAll };
})();
