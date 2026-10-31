;(function () {
'use strict';
// ---------- 联机底层（23-net.js）v4.5 ----------
// PeerJS 传输 · 房间 · 座位 · 消息路由
// 房主权威，客人镜像。引擎决策只跑在房主。
// 协议 v2 兼容：版本握手、令牌重连、结构校验、限流、座位脱敏、诊断日志。
// 商业级加固：消息体积限制、token-bucket 限流、更高熵令牌、统一配置、完整清理路径。

// ========== 可配置项（商业部署时优先改这里） ==========
var NET_CONFIG = {
    PROTO: 2,
    ROOM_PREFIX: 'qj-mj-v4-',
    CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // 去掉易混 I O 0 1
    CODE_LEN: 6,
    TOKEN_BYTES: 16,          // 128-bit token
    MAX_MSG_BYTES: 4096,      // 客人→房主 单条消息上限（意图都很小），防滥用
    MAX_HOST_MSG_BYTES: 16384, // 房主→客人（快照/结算会随牌局增长，实测后期约 3.4KB，留足余量）
    RATE_BURST: 20,           // token-bucket 突发
    RATE_REFILL_PER_SEC: 8,   // 每秒补充
    MAX_NAME_LEN: 12,
    MAX_BAD_MSGS: 8,          // 累计违规后踢出
    LOG_MAX: 400,
    // 超时（毫秒）
    timeouts: {
        turn: 45000,
        claim: 15000,
        reveal: 15000,
        hello: 14000,
        ping: 10000,
        dead: 55000,          // 房主判定客人掉线
        hostSilent: 32000,    // 客人判定房主静默
        reserve: 90000,       // 掉线座位保留窗口
        ready: 10000,
        open: 15000           // 连信令服务器的总超时（建房/加入）
    },
    // 默认 STUN；TURN 可通过 localStorage.qj_mj_net_ice 或 Game.netPeerConfig 覆盖
    defaultIce: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ]
};

var PROTO = NET_CONFIG.PROTO;
var ROOM_PREFIX = NET_CONFIG.ROOM_PREFIX;
var CODE_ALPHABET = NET_CONFIG.CODE_ALPHABET;
var CODE_LEN = NET_CONFIG.CODE_LEN;
var SEATS = ['top', 'left', 'right', 'bottom'];
var FILL_ORDER = ['top', 'left', 'right']; // 客人入座：龙→虎→狮（猫=房主固定下方）
var RING = ['bottom', 'left', 'top', 'right']; // 顺时针（屏幕视角）
var WINDS = { bottom: '东', right: '南', top: '西', left: '北' };
var ANIMALS = { bottom: '猫', top: '龙', left: '虎', right: '狮' };

Game.NET_PROTO = PROTO;
Game.netCodeLen = CODE_LEN;
Game.netTimeouts = NET_CONFIG.timeouts;
Game.net = null; // {role, code, name, seat, peer, seats, conns, guestConn, token, started, seq, ...}

// ========== 诊断日志（环形，不含手牌等隐私） ==========
var logBuf = [];
Game.netLog = function (ev, data) {
    try {
        logBuf.push({ t: Date.now(), ev: String(ev || ''), d: data === undefined ? '' : data });
        if (logBuf.length > NET_CONFIG.LOG_MAX) logBuf.shift();
    } catch (e) {}
};
Game.netDiag = function () {
    var n = Game.net;
    var lines = [
        '麻将联机诊断 proto=' + PROTO + ' ' + new Date().toISOString(),
        'ua=' + (typeof navigator !== 'undefined' ? navigator.userAgent : '?')
    ];
    if (n) {
        lines.push('role=' + n.role + ' code=' + n.code + ' seat=' + n.seat + ' started=' + !!n.started + ' phase=' + Game.netGetPhase() + ' locked=' + !!n.locked);
        lines.push('seats=' + JSON.stringify(Game.netPublicSeats ? Game.netPublicSeats() : []));
        if (n.rtt) lines.push('rtt=' + JSON.stringify(n.rtt));
        if (n.lastHostMsg) lines.push('lastHostMsgAgo=' + (Date.now() - n.lastHostMsg) + 'ms');
    } else {
        lines.push('未联机');
    }
    logBuf.slice(-150).forEach(function (e) {
        var ts = new Date(e.t).toISOString().slice(11, 23);
        var payload = typeof e.d === 'string' ? e.d : (function () {
            try { return JSON.stringify(e.d); } catch (err) { return '[unserializable]'; }
        })();
        lines.push(ts + ' ' + e.ev + ' ' + payload);
    });
    return lines.join('\n');
};

// ========== 座位旋转 ==========
function ringIdx(s) { return RING.indexOf(s); }
/** 房主视角 canonical → 某客人的 view（客人自己永远在 bottom） */
function viewSeatOf(canonical, mySeat) {
    return RING[(ringIdx(canonical) - ringIdx(mySeat) + 4) % 4];
}
function canonSeatOf(view, mySeat) {
    return RING[(ringIdx(view) + ringIdx(mySeat)) % 4];
}
Game.netViewSeatOf = viewSeatOf;
Game.netCanonSeatOf = canonSeatOf;
Game.netWinds = WINDS;
Game.netAnimals = ANIMALS;
Game.netSeats = SEATS;

/** 联机客人：模式/筹码/调庄/清零都由房主决定；客人点了只提示，不改本地状态 */
Game.netGuestBlock = function () {
    if (!Game.net || Game.net.role !== 'guest') return false;
    try { if (Game.netToastUI) Game.netToastUI('联机中，由房主设置'); } catch (e) {}
    return true;
};

function isNet() { return !!Game.net; }
function isNetHost() { return !!(Game.net && Game.net.role === 'host'); }
function isNetGuest() { return !!(Game.net && Game.net.role === 'guest'); }
Game.isNet = isNet;
Game.netIsHost = isNetHost;
Game.netIsGuest = isNetGuest;

/**
 * 联机显式阶段（只读，用于诊断与竞态守卫）
 * offline 未联机 | lobby 已建房/加入未开局 | playing 对局中 | settling 本局已结束（等 ready / 下一局）
 */
Game.netGetPhase = function () {
    if (!Game.net) return 'offline';
    if (!Game.net.started) return 'lobby';
    if (Game.gameOver) return 'settling';
    return 'playing';
};
/** 座位是否处于「掉线保留」窗口（令牌有效、AI 暂代） */
Game.netSeatIsReserved = function (seat) {
    if (!Game.net || !Game.net.seats) return false;
    for (var i = 0; i < Game.net.seats.length; i++) {
        var s = Game.net.seats[i];
        if (s.seat === seat) return !!(s.away && s.token && s.reservedUntil && Date.now() < s.reservedUntil);
    }
    return false;
};
/** 座位是否由 AI 逻辑代打（AI / 托管 / 掉线无连接） */
Game.netSeatIsAiLike = function (seat) {
    if (!Game.net) return true;
    if (seat === 'bottom' && Game.net.role === 'host') return false;
    var m = null;
    for (var i = 0; i < (Game.net.seats || []).length; i++) {
        if (Game.net.seats[i].seat === seat) { m = Game.net.seats[i]; break; }
    }
    if (!m) return true;
    if (m.kind === 'ai' || m.auto) return true;
    if (seat !== 'bottom' && !(Game.net.conns && Game.net.conns[seat])) return true;
    return false;
};

function peerJsReady() { return typeof Peer !== 'undefined'; }
Game.netPeerJsReady = peerJsReady;

// ========== 房间码 / 名字 / 令牌 ==========
Game.netNormCode = function (s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
};
Game.netGenCode = function () {
    var out = '', i, r;
    try {
        r = new Uint32Array(CODE_LEN);
        crypto.getRandomValues(r);
        for (i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[r[i] % CODE_ALPHABET.length];
    } catch (e) {
        for (i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
};
Game.netValidCode = function (s) {
    return new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LEN + '}$').test(Game.netNormCode(s));
};

function genToken() {
    try {
        var bytes = new Uint8Array(NET_CONFIG.TOKEN_BYTES);
        crypto.getRandomValues(bytes);
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
        return s;
    } catch (e) {
        var out = '', j;
        for (j = 0; j < 8; j++) out += Math.floor(Math.random() * 0x100000000).toString(36);
        return out;
    }
}

/** 名字净化：去控制字符/尖括号/危险符号，Unicode 规范化，限长 */
Game.netCleanName = function (n, dflt) {
    var s = String(n == null ? '' : n);
    try { s = s.normalize('NFKC'); } catch (e) {}
    s = s.replace(/[\u0000-\u001f\u007f<>&"'`\\\/]/g, '').replace(/\s+/g, ' ').trim();
    s = Array.from(s).slice(0, NET_CONFIG.MAX_NAME_LEN).join('');
    return s || dflt || '玩家';
};

function roomIdOf(code) {
    return ROOM_PREFIX + Game.netNormCode(code).toLowerCase();
}

/** 可覆盖 PeerJS 服务器配置（默认公有云；生产应指向自建 PeerServer + TURN） */
Game.netPeerConfig = null;

function iceServers() {
    var list = NET_CONFIG.defaultIce.slice();
    try { // 部署配置（net-config.js）里的 TURN/STUN
        var cfg = (typeof window !== 'undefined' && window.QJ_NET_CONFIG) || null;
        if (cfg && Array.isArray(cfg.ice)) {
            cfg.ice.forEach(function (s) { if (s && s.urls) list.push(s); });
        }
    } catch (e) {}
    try {
        var extra = JSON.parse(localStorage.getItem('qj_mj_net_ice') || 'null');
        if (Array.isArray(extra)) {
            extra.forEach(function (s) {
                if (s && s.urls) list.push(s);
            });
        }
    } catch (e) {}
    return list;
}

function peerOptions() {
    var o = {
        debug: 0,
        config: { iceServers: iceServers() },
        // 生产环境可在 Game.netPeerConfig 中覆盖 host/port/path/key/secure
    };
    try { // 部署配置里的自建信令（host/port/path/secure/key）
        var cfg = (typeof window !== 'undefined' && window.QJ_NET_CONFIG) || null;
        if (cfg && cfg.peer && typeof cfg.peer === 'object') {
            Object.keys(cfg.peer).forEach(function (k) { o[k] = cfg.peer[k]; });
        }
    } catch (e) {}
    var cfg = Game.netPeerConfig;
    if (!cfg) { // 无需改代码：localStorage.qj_mj_net_peer = '{"host":"peer.example.com","port":443,"path":"/mj","secure":true}'
        try {
            var raw = JSON.parse(localStorage.getItem('qj_mj_net_peer') || 'null');
            if (raw && typeof raw === 'object' && typeof raw.host === 'string') cfg = raw;
        } catch (e) {}
    }
    if (cfg) {
        ['host', 'port', 'path', 'secure', 'key', 'pingInterval'].forEach(function (k) {
            if (cfg[k] !== undefined) o[k] = cfg[k];
        });
    }
    return o;
}

/** 座位表脱敏：永远不把令牌发给别人 */
Game.netPublicSeats = function () {
    if (!Game.net || !Game.net.seats) return [];
    return Game.net.seats.map(function (s) {
        return {
            seat: s.seat,
            kind: s.kind,
            name: s.name || '',
            away: !!s.away,
            auto: !!s.auto
        };
    });
};

// ========== 消息安全校验 ==========
/** 消息的 UTF-8 字节数（不是 JSON 字符数：中文 3 字节/字，emoji 4 字节，按 length 算会少估 3 倍）。
 *  序列化失败（循环引用等）按超限处理。 */
var _utf8Enc = (typeof TextEncoder === 'function') ? new TextEncoder() : null;
function utf8Len(str) {
    if (_utf8Enc) return _utf8Enc.encode(str).length;
    var n = 0; // 无 TextEncoder 的兜底：按码点手算
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length &&
                 str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) { n += 4; i++; }
        else n += 3;
    }
    return n;
}
function approxMsgBytes(d) {
    try {
        var s = JSON.stringify(d);
        if (typeof s !== 'string') return NET_CONFIG.MAX_MSG_BYTES + 1; // undefined/函数等不可序列化
        return utf8Len(s);
    } catch (e) {
        return NET_CONFIG.MAX_MSG_BYTES + 1;
    }
}
Game.netMsgBytes = approxMsgBytes; // 供测试/诊断

// 白名单查表一律用自有属性：{}[ 'constructor' / 'toString' / '__proto__' ] 在原型链上是真值，会被误放行
var hasOwn = Object.prototype.hasOwnProperty;
function ownKey(table, k) {
    return typeof k === 'string' && hasOwn.call(table, k);
}
/** 是否为"普通对象"消息（排除数组、null、带非 Object 原型的实例） */
function isPlainMsg(d) {
    // 不用 === Object.prototype：跨 realm（iframe/vm）的 Object.prototype 不是同一个。
    // 改为"原型是根原型（自己没有原型）"，这样继承了别人字段的对象、类实例都进不来。
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (Object.prototype.toString.call(d) !== '[object Object]') return false;
    var proto = Object.getPrototypeOf(d);
    return proto === null || Object.getPrototypeOf(proto) === null;
}

// 房主→客人 / 客人→房主 允许的消息类型（自有属性白名单）
var HOST_MSG_TYPES = { welcome: 1, deny: 1, ping: 1, state: 1, prompt: 1, seats: 1, toast: 1, auto: 1, result: 1, hostbye: 1, kicked: 1 };
var GUEST_MSG_TYPES = { hello: 1, intent: 1, bye: 1, ready: 1, resume: 1, pong: 1 };

var INTENT_KINDS = { discard: 1, selfgang: 1, claim: 1, reveal: 1 };
var CHOICES = { peng: 1, gang: 1, chi: 1, pass: 1 };

function isStr(x, max) {
    return typeof x === 'string' && x.length <= max;
}

/** 校验客人 intent 结构（语义合法性由上层 offer 校验负责） */
Game.netValidIntent = function (d) {
    if (!isPlainMsg(d) || d.t !== 'intent' || !isStr(d.id, 24) || !d.id || !ownKey(INTENT_KINDS, d.kind)) return false;
    if (d.tile !== undefined && !isStr(d.tile, 6)) return false;
    if (d.kind === 'claim') {
        if (!ownKey(CHOICES, d.choice)) return false;
        if (d.combo !== undefined && d.combo !== null &&
            !(Number.isInteger(d.combo) && d.combo >= 0 && d.combo < 8)) return false;
    }
    if (d.kind === 'selfgang' && !(d.gangKind === 'an' || d.gangKind === 'jia')) return false;
    if (d.kind === 'reveal' && typeof d.accept !== 'boolean') return false;
    return true;
};

// ========== Token-bucket 限流（每连接独立） ==========
function makeRateGuard() {
    return {
        tokens: NET_CONFIG.RATE_BURST,
        last: Date.now(),
        bad: 0
    };
}
function rateAllow(guard) {
    var now = Date.now();
    var elapsed = (now - guard.last) / 1000;
    guard.last = now;
    guard.tokens = Math.min(NET_CONFIG.RATE_BURST, guard.tokens + elapsed * NET_CONFIG.RATE_REFILL_PER_SEC);
    if (guard.tokens < 1) return false;
    guard.tokens -= 1;
    return true;
}

// ========== 建房 / 加入 ==========
/** 建房：抢注房间号，抢到=房主；已被占 → 自动转客人 */
Game.netCreateRoom = function (code, name) {
    code = Game.netNormCode(code);
    return new Promise(function (resolve) {
        if (!peerJsReady()) {
            resolve({ ok: false, err: '需要联网才能联机（PeerJS 未加载）' });
            return;
        }
        if (Game.net) { // 已在房间里：不允许再建（否则旧连接泄漏、客人成幽灵）
            resolve({ ok: false, err: '你已在联机房间中，请先离开当前房间' });
            return;
        }
        var id = roomIdOf(code);
        var done = false;
        var peer = null;
        try {
            peer = new Peer(id, peerOptions());
        } catch (e) {
            resolve({ ok: false, err: '创建失败：' + (e && e.message ? e.message : e) });
            return;
        }
        var timedOut = false;
        var openTimer = setTimeout(function () { // 信令服务器卡住：不让界面无限转圈
            if (done) return;
            done = true; timedOut = true;
            try { peer.destroy(); } catch (e) {}
            Game.netLog('host:open-timeout');
            resolve({ ok: false, err: '连接联机服务器超时，请检查网络后重试' });
        }, Game.netTimeouts.open);
        peer.on('open', function () {
            if (done) return;
            done = true;
            clearTimeout(openTimer);
            name = Game.netCleanName(name, '房主');
            Game.net = {
                role: 'host',
                code: code,
                name: name,
                seat: 'bottom',
                peer: peer,
                seats: [{ seat: 'bottom', kind: 'human', name: name }],
                conns: {},
                lastSeen: {},
                rtt: {},
                seq: 0,
                started: false,
                locked: false,
                ready: {},
                heartbeat: null
            };
            Game.netLog('host:open', code);
            wireHostPeer(peer);
            resolve({ ok: true, role: 'host', peer: peer });
        });
        // 信令断开：带退避持续重连（客人断线重连要靠房主信令在线）
        var sigTries = 0, sigTimer = 0;
        function sigRetry() {
            if (sigTimer) return;
            if (!(Game.net && Game.net.peer === peer) || peer.destroyed) return;
            if (!peer.disconnected) { sigTries = 0; return; }
            var wait = Math.min(15000, 1500 * Math.pow(1.6, sigTries++));
            sigTimer = setTimeout(function () {
                sigTimer = 0;
                if (!(Game.net && Game.net.peer === peer) || peer.destroyed) return;
                if (peer.disconnected) {
                    Game.netLog('host:signal-retry', sigTries);
                    try { peer.reconnect(); } catch (e) {}
                    sigRetry(); // 若仍断开，继续排下一次
                } else sigTries = 0;
            }, wait);
        }
        peer.on('disconnected', function () {
            Game.netLog('host:signal-lost');
            sigRetry();
        });
        peer.on('error', function (err) {
            var t = err && err.type;
            Game.netLog('host:error', t);
            if (timedOut) return;
            if (done && Game.net && Game.net.peer === peer && peer.disconnected) sigRetry();
            if (done && t !== 'unavailable-id') return;
            clearTimeout(openTimer);
            if (t === 'unavailable-id' || t === 'peer-unavailable') {
                try { peer.destroy(); } catch (e) {}
                Game.netJoinRoom(code, name).then(resolve);
            } else if (!done) {
                done = true;
                try { peer.destroy(); } catch (e) {}
                resolve({ ok: false, err: '网络错误：' + (t || 'unknown') });
            }
        });
    });
};

/** 加入房间。opts: {token, resume, expectSeat} 用于断线重连 */
Game.netJoinRoom = function (code, name, opts) {
    opts = opts || {};
    code = Game.netNormCode(code);
    return new Promise(function (resolve) {
        if (!peerJsReady()) {
            resolve({ ok: false, err: '需要联网才能联机（PeerJS 未加载）' });
            return;
        }
        if (Game.net && !opts.resume) { // 已在房间：不能再加入别的房间（重连例外）
            resolve({ ok: false, err: '你已在联机房间中，请先离开当前房间', fatal: true });
            return;
        }
        var done = false;
        var peer = null;
        var to = null;
        try {
            peer = new Peer(peerOptions());
        } catch (e) {
            resolve({ ok: false, err: '创建失败：' + (e && e.message ? e.message : e) });
            return;
        }
        function fail(msg, fatal) {
            if (done) return;
            done = true;
            if (to) clearTimeout(to);
            try { peer.destroy(); } catch (e) {}
            Game.netLog('join:fail', msg);
            resolve({ ok: false, err: msg, fatal: !!fatal });
        }
        // 信令服务器卡住（open 前）也要有总超时
        to = setTimeout(function () { fail('连接联机服务器超时，请检查网络后重试'); }, Game.netTimeouts.open);
        peer.on('open', function () {
            var conn;
            if (done) return;
            try {
                conn = peer.connect(roomIdOf(code), { reliable: true });
            } catch (e) {
                fail('连接失败');
                return;
            }
            if (to) clearTimeout(to);
            to = setTimeout(function () {
                fail('房主无响应（房间码对吗？房主是否仍在大厅？）');
            }, Game.netTimeouts.hello);
            conn.on('open', function () {
                try {
                    conn.send({
                        t: 'hello',
                        v: PROTO,
                        name: Game.netCleanName(name, '客人'),
                        token: opts.token || null,
                        resume: !!opts.resume
                    });
                } catch (e) {
                    fail('发送失败');
                }
            });
            conn.on('data', function (d) {
                if (done || !isPlainMsg(d)) return;
                if (approxMsgBytes(d) > NET_CONFIG.MAX_HOST_MSG_BYTES) return;
                if (d.t === 'welcome') {
                    if (to) clearTimeout(to);
                    done = true;
                    if (d.v !== PROTO) {
                        try { peer.destroy(); } catch (e) {}
                        resolve({ ok: false, err: '版本不一致，请刷新页面', fatal: true });
                        return;
                    }
                    if (Game.net && Game.net.hostSilentTimer) { // 重连换新 net：清掉旧定时器，防泄漏
                        try { clearInterval(Game.net.hostSilentTimer); } catch (e) {}
                    }
                    Game.net = {
                        role: 'guest',
                        code: code,
                        name: Game.netCleanName(name, '客人'),
                        seat: d.seat,
                        peer: peer,
                        guestConn: conn,
                        seats: d.seats || [],
                        token: d.token || null,
                        lastHostMsg: Date.now(),
                        seq: 0,
                        started: !!d.started,
                        hostSilentTimer: null
                    };
                    Game.netLog('join:ok', d.seat + (d.resumed ? ' resumed' : ''));
                    wireGuestConn(conn);
                    startGuestHostWatch();
                    resolve({ ok: true, role: 'guest', welcome: d, peer: peer });
                } else if (d.t === 'deny') {
                    fail(d.text || '被拒绝', !!d.fatal);
                }
            });
            conn.on('error', function () { fail('连接失败'); });
            conn.on('close', function () { fail('连接已断开'); });
        });
        peer.on('error', function (err) {
            var t = err && err.type;
            fail(t === 'peer-unavailable'
                ? '找不到房间（房间码对吗？房主是否仍在线？）'
                : '网络错误：' + (t || 'unknown') + '。可尝试同一 Wi‑Fi 或配置 TURN（见大厅「网络说明」）');
        });
    });
};

// ========== 房主：连接与消息处理 ==========
function wireHostPeer(peer) {
    acquireWakeLock();
    peer.on('connection', function (conn) {
        var guard = makeRateGuard();
        var helloTimer = setTimeout(function () {
            try { conn.close(); } catch (e) {}
        }, Game.netTimeouts.hello);

        function violation(why) {
            guard.bad++;
            Game.netLog('host:bad-msg', why);
            if (guard.bad >= NET_CONFIG.MAX_BAD_MSGS) {
                var seat = connSeatOf(conn);
                Game.netLog('host:kick-abuse', seat || '?');
                if (seat) hostDropSeat(seat, '消息异常');
                else {
                    try { conn.close(); } catch (e) {}
                }
            }
        }

        conn.on('data', function (d) {
            if (!isPlainMsg(d) || typeof d.t !== 'string') {
                violation('shape');
                return;
            }
            if (!ownKey(GUEST_MSG_TYPES, d.t)) { // 含 'constructor'/'__proto__' 等原型名
                violation('type:' + String(d.t).slice(0, 16));
                return;
            }
            if (approxMsgBytes(d) > NET_CONFIG.MAX_MSG_BYTES) {
                violation('size');
                return;
            }
            if (!rateAllow(guard)) {
                violation('rate');
                return;
            }
            var seat;
            if (d.t === 'hello') {
                clearTimeout(helloTimer);
                if (connSeatOf(conn)) return; // 同一连接重复 hello：忽略
                hostAdmitGuest(conn, d);
            } else if (d.t === 'intent') {
                if (!Game.netValidIntent(d)) {
                    violation('intent');
                    return;
                }
                if (typeof Game.netHostOnGuestMsg === 'function') Game.netHostOnGuestMsg(conn, d);
            } else if (d.t === 'bye' || d.t === 'ready' || d.t === 'resume') {
                if (typeof Game.netHostOnGuestMsg === 'function') Game.netHostOnGuestMsg(conn, d);
            } else if (d.t === 'pong') {
                seat = connSeatOf(conn);
                if (seat) {
                    Game.net.lastSeen[seat] = Date.now();
                    if (typeof d.ts === 'number' && Date.now() >= d.ts) {
                        Game.net.rtt[seat] = Date.now() - d.ts;
                    }
                }
            } else {
                violation('type:' + String(d.t).slice(0, 16));
            }
        });
        conn.on('close', function () {
            clearTimeout(helloTimer);
            hostDropConn(conn);
        });
        conn.on('error', function () {
            clearTimeout(helloTimer);
            hostDropConn(conn);
        });
    });

    // 心跳：定期 ping；超时无声当掉线（保留座位等重连）
    if (Game.net.heartbeat) clearInterval(Game.net.heartbeat);
    Game.net.heartbeat = setInterval(function () {
        if (!isNetHost()) {
            clearInterval(Game.net.heartbeat);
            return;
        }
        var now = Date.now();
        Object.keys(Game.net.conns).forEach(function (seat) {
            var c = Game.net.conns[seat];
            try { c.send({ t: 'ping', ts: now }); } catch (e) {}
            if (Game.net.lastSeen[seat] && now - Game.net.lastSeen[seat] > Game.netTimeouts.dead) {
                hostDropSeat(seat, '掉线', true);
            }
        });
        var changed = false;
        Game.net.seats.forEach(function (s) {
            if (s.away && s.reservedUntil && now > s.reservedUntil) {
                s.away = false;
                delete s.reservedUntil;
                delete s.token;
                s.name = '';
                changed = true;
            }
        });
        if (changed && typeof Game.netBroadcastSeats === 'function') Game.netBroadcastSeats();
    }, Game.netTimeouts.ping);
}

function connSeatOf(conn) {
    if (!Game.net || !Game.net.conns) return null;
    var keys = Object.keys(Game.net.conns);
    for (var i = 0; i < keys.length; i++) {
        if (Game.net.conns[keys[i]] === conn) return keys[i];
    }
    return null;
}

function metaOf(seat) {
    var seats = (Game.net && Game.net.seats) || [];
    for (var i = 0; i < seats.length; i++) {
        if (seats[i].seat === seat) return seats[i];
    }
    return null;
}

function deny(conn, text, fatal) {
    try {
        conn.send({ t: 'deny', text: text, fatal: !!fatal });
    } catch (e) {}
    setTimeout(function () {
        try { conn.close(); } catch (e) {}
    }, 200);
}

function welcomeMsg(seat, token, resumed) {
    return {
        t: 'welcome',
        v: PROTO,
        seat: seat,
        seats: Game.netPublicSeats(),
        code: Game.net.code,
        token: token,
        resumed: !!resumed,
        started: !!Game.net.started
    };
}

/** 房主接纳客人：优先令牌重连，否则按龙→虎→狮分配，满座可顶非保留 AI */
function hostAdmitGuest(conn, d) {
    if (d.v !== PROTO) {
        deny(conn, '版本不一致，请两边都刷新页面后重试', true);
        return;
    }
    var net = Game.net;
    var now = Date.now();
    var name = Game.netCleanName(d.name, '客人');
    var i, m, seat = null;

    // 1) 令牌重连
    if (d.token && typeof d.token === 'string' && d.token.length >= 16) {
        m = null;
        for (i = 0; i < net.seats.length; i++) {
            if (net.seats[i].token === d.token) {
                m = net.seats[i];
                break;
            }
        }
        if (m && m.seat !== 'bottom') {
            var old = net.conns[m.seat];
            if (old && old !== conn) {
                delete net.conns[m.seat];
                try { old.close(); } catch (e) {}
            }
            m.kind = 'human';
            m.away = false;
            m.auto = false;
            m.timeouts = 0;
            delete m.reservedUntil;
            net.conns[m.seat] = conn;
            net.lastSeen[m.seat] = now;
            try { conn.send(welcomeMsg(m.seat, m.token, true)); } catch (e) {}
            Game.netLog('host:resume', m.seat);
            if (typeof Game.netBroadcastSeats === 'function') Game.netBroadcastSeats();
            Game.netToast(WINDS[m.seat] + ' ' + ANIMALS[m.seat] + '（' + m.name + '）重新连线');
            if (net.started && typeof Game.netHostSyncGuest === 'function') {
                Game.netHostSyncGuest(m.seat, true);
            }
            return;
        }
    }
    if (d.resume) {
        deny(conn, '座位已过期，请重新加入', true);
        return;
    }
    if (net.locked) { // 房主锁房：只放行令牌重连，不收新人
        deny(conn, '房主已锁房，暂不接受新玩家');
        return;
    }

    // 2) 新客人
    var taken = {};
    net.seats.forEach(function (s) { taken[s.seat] = true; });
    var evictAI = false;
    for (i = 0; i < FILL_ORDER.length; i++) {
        if (!taken[FILL_ORDER[i]]) {
            seat = FILL_ORDER[i];
            break;
        }
    }
    if (!seat) {
        for (i = 0; i < FILL_ORDER.length; i++) {
            m = metaOf(FILL_ORDER[i]);
            if (m && m.kind === 'ai' && !(m.away && m.reservedUntil > now)) {
                seat = FILL_ORDER[i];
                evictAI = true;
                break;
            }
        }
    }
    if (!seat) {
        deny(conn, '房间已满');
        return;
    }
    if (evictAI || taken[seat]) {
        net.seats = net.seats.filter(function (s) { return s.seat !== seat; });
    }
    var token = genToken();
    net.seats.push({
        seat: seat,
        kind: 'human',
        name: name,
        token: token,
        timeouts: 0
    });
    net.conns[seat] = conn;
    net.lastSeen[seat] = now;
    try { conn.send(welcomeMsg(seat, token, false)); } catch (e) {}
    Game.netLog('host:admit', seat + ' ' + name);
    if (typeof Game.netBroadcastSeats === 'function') Game.netBroadcastSeats();
    else hostBroadcastSeatsFallback();
    Game.netToast(WINDS[seat] + ' ' + ANIMALS[seat] + '（' + name + '）加入了房间');
    if (net.started && typeof Game.netHostSyncGuest === 'function') {
        Game.netHostSyncGuest(seat);
    }
}

function hostBroadcastSeatsFallback() {
    if (typeof Game.netLobbyRender === 'function') Game.netLobbyRender();
}

function hostDropConn(conn) {
    var seat = connSeatOf(conn);
    if (seat) hostDropSeat(seat, '连接中断', true);
}

Game.netHostDropSeat = hostDropSeat;

/** keep=true：意外掉线，保留座位令牌；否则直接释放 */
function hostDropSeat(seat, reason, keep) {
    if (!Game.net || Game.net.role !== 'host') return;
    var c = Game.net.conns[seat];
    delete Game.net.conns[seat];
    delete Game.net.lastSeen[seat];
    if (Game.net.ready) delete Game.net.ready[seat]; // 结算门闩：该座位不再被等，避免卡住下一局
    if (c) {
        if (!keep && reason !== 'bye') {
            try { c.send({ t: 'kicked', reason: reason }); } catch (e) {}
        }
        try { c.close(); } catch (e) {}
    }
    var m = metaOf(seat);
    Game.netLog('host:drop', seat + ' ' + reason + (keep ? ' keep' : ''));
    if (m) {
        if (Game.net.started) {
            m.kind = 'ai';
            m.auto = false;
            m.timeouts = 0;
            if (keep && m.token) {
                m.away = true;
                m.reservedUntil = Date.now() + Game.netTimeouts.reserve;
            } else {
                m.away = false;
                delete m.token;
                delete m.reservedUntil;
                m.name = '';
            }
        } else {
            Game.net.seats = Game.net.seats.filter(function (s) { return s.seat !== seat; });
        }
    }
    Game.netToast(
        (WINDS[seat] || seat) + ' ' +
        (reason === 'bye' ? '离开' : reason) +
        '，该座位' + (keep ? '由 AI 暂代（可重连）' : '转 AI 代打')
    );
    if (typeof Game.netBroadcastSeats === 'function') Game.netBroadcastSeats();
    else hostBroadcastSeatsFallback();
    if (typeof Game.netHostSeatToAI === 'function') Game.netHostSeatToAI(seat);
}

// ========== 客人：接线 + 房主静默检测 ==========
function wireGuestConn(conn) {
    acquireWakeLock();
    conn.on('data', function (d) {
        if (!isPlainMsg(d) || !ownKey(HOST_MSG_TYPES, d.t)) return; // 房主只会发白名单类型；其余静默丢弃
        var sz = approxMsgBytes(d);
        if (sz > NET_CONFIG.MAX_HOST_MSG_BYTES) { // 不再静默丢弃：留诊断，便于定位
            Game.netLog('guest:drop-oversize', { t: d.t, bytes: sz });
            return;
        }
        if (Game.net && Game.net.guestConn === conn) {
            Game.net.lastHostMsg = Date.now();
        }
        if (d.t === 'ping') {
            try { conn.send({ t: 'pong', ts: d.ts }); } catch (e) {}
            return;
        }
        if (typeof Game.netGuestOnMsg === 'function') Game.netGuestOnMsg(d);
    });
    function lost() {
        if (!Game.net || Game.net.guestConn !== conn || Game._leaving) return;
        if (typeof Game.netGuestOnConnLost === 'function') Game.netGuestOnConnLost();
    }
    conn.on('close', lost);
    conn.on('error', lost);
}

function startGuestHostWatch() {
    if (!Game.net || Game.net.role !== 'guest') return;
    if (Game.net.hostSilentTimer) clearInterval(Game.net.hostSilentTimer);
    Game.net.hostSilentTimer = setInterval(function () {
        if (!isNetGuest() || !Game.net.lastHostMsg) return;
        if (Date.now() - Game.net.lastHostMsg > Game.netTimeouts.hostSilent) {
            Game.netLog('guest:host-silent');
            if (typeof Game.netGuestOnConnLost === 'function') Game.netGuestOnConnLost();
        }
    }, 4000);
}

// ========== 发送 API ==========
Game.netSendTo = function (seat, msg) {
    if (!isNetHost()) return false;
    var c = Game.net.conns[seat];
    if (!c) return false;
    try {
        c.send(msg);
        return true;
    } catch (e) {
        return false;
    }
};

Game.netBroadcast = function (msg, exceptSeat) {
    if (!isNetHost()) return;
    Object.keys(Game.net.conns).forEach(function (seat) {
        if (seat === exceptSeat) return;
        try { Game.net.conns[seat].send(msg); } catch (e) {}
    });
};

Game.netSendHost = function (msg) {
    if (!isNetGuest() || !Game.net.guestConn) return false;
    try {
        Game.net.guestConn.send(msg);
        return true;
    } catch (e) {
        return false;
    }
};

/** 房主本机小喇叭 */
Game.netToast = function (text) {
    try { Game.logFlow('[联机] ' + text); } catch (e) {}
    if (isNetHost()) Game.netBroadcast({ t: 'toast', text: text });
};

// ========== 出牌倒计时 UI ==========
var cdEl = null, cdTimer = 0, cdRing = null, cdRingFg = null;
var CD_RING_C = 2 * Math.PI * 21;

function cdEnsureRing() {
    if (cdRing) return;
    try {
        var av = document.querySelector('#p-bottom .avatar');
        if (!av) return;
        cdRing = document.createElement('div');
        cdRing.className = 'net-ring';
        cdRing.setAttribute('aria-hidden', 'true');
        cdRing.innerHTML =
            '<svg viewBox="0 0 48 48">' +
            '<circle class="net-ring-bg" cx="24" cy="24" r="21"></circle>' +
            '<circle class="net-ring-fg" cx="24" cy="24" r="21"></circle>' +
            '</svg>';
        av.appendChild(cdRing);
        cdRingFg = cdRing.querySelector('.net-ring-fg');
    } catch (e) {}
}

Game.netCountdownHide = function () {
    if (cdTimer) {
        clearInterval(cdTimer);
        cdTimer = 0;
    }
    if (cdEl) cdEl.classList.remove('show');
    if (cdRing) cdRing.classList.remove('show');
};

Game.netCountdownShow = function (ms, label) {
    try {
        if (!cdEl) {
            cdEl = document.createElement('div');
            cdEl.id = 'net-countdown';
            cdEl.setAttribute('role', 'timer');
            document.body.appendChild(cdEl);
        }
        Game.netCountdownHide();
        var end = Date.now() + ms;
        cdEnsureRing();
        function tick() {
            var remain = end - Date.now();
            var left = Math.max(0, Math.ceil(remain / 1000));
            cdEl.textContent = (label || '') + left + ' 秒';
            cdEl.classList.toggle('warn', left <= 5);
            if (cdRingFg) {
                var frac = Math.max(0, Math.min(1, remain / ms));
                cdRingFg.style.strokeDasharray = String(CD_RING_C);
                cdRingFg.style.strokeDashoffset = String((CD_RING_C * (1 - frac)).toFixed(1));
                cdRingFg.classList.toggle('warn', left <= 5);
            }
            if (cdRing) cdRing.classList.add('show');
            if (left <= 0) Game.netCountdownHide();
        }
        cdEl.classList.add('show');
        tick();
        cdTimer = setInterval(tick, 250);
    } catch (e) {}
};

/** 头像徽标：真人绿点 / AI 灰字 / 托管·离线提示 */
Game.netRefreshAvatarBadges = function () {
    var show = !!Game.net;
    ['top', 'left', 'right', 'bottom'].forEach(function (view) {
        var el = null;
        try { el = document.querySelector('#p-' + view + ' .avatar'); } catch (e) {}
        if (!el) return;
        var badge = el.querySelector('.net-badge');
        var meta = null;
        if (show && Game.net.seats) {
            var canon = (Game.net.role === 'guest')
                ? Game.netCanonSeatOf(view, Game.net.seat)
                : view;
            for (var i = 0; i < Game.net.seats.length; i++) {
                if (Game.net.seats[i].seat === canon) {
                    meta = Game.net.seats[i];
                    break;
                }
            }
        }
        // 昵称：真人座位在头像下方显示名字（textContent，防注入）；AI/空位不显示
        var labelEl = el.closest ? el.closest('.player-label') : null;
        var nick = labelEl ? labelEl.querySelector('.net-nick') : null;
        if (!meta || meta.kind !== 'human' || !meta.name) {
            if (nick) nick.remove();
        } else if (labelEl) {
            if (!nick) {
                nick = document.createElement('span');
                nick.className = 'net-nick';
                labelEl.appendChild(nick);
            }
            if (nick.textContent !== meta.name) nick.textContent = meta.name;
        }
        // 昵称：真人座位在头像下方显示名字（房主/客人通用，canonical 座位已映射到 view）
        try {
            var label = el.closest('.player-label');
            var nick = label ? label.querySelector('.net-nick') : null;
            if (meta && meta.kind === 'human' && meta.name) {
                if (!nick && label) {
                    nick = document.createElement('span');
                    nick.className = 'net-nick';
                    label.appendChild(nick);
                }
                if (nick) { nick.textContent = meta.name; nick.title = meta.name; }
            } else if (nick) {
                nick.remove();
            }
        } catch (e) {}
        if (!meta) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            el.appendChild(badge);
        }
        if (meta.kind === 'human' && meta.auto) {
            badge.className = 'net-badge net-ai';
            badge.textContent = '托管';
            badge.title = '托管中（AI 代打）';
        } else if (meta.kind === 'human') {
            badge.className = 'net-badge net-human';
            badge.textContent = '';
            badge.title = '真人玩家';
        } else if (meta.away) {
            badge.className = 'net-badge net-ai';
            badge.textContent = '离线';
            badge.title = '已掉线，AI 暂代，可重连';
        } else {
            badge.className = 'net-badge net-ai';
            badge.textContent = 'AI';
            badge.title = 'AI 代打';
        }
    });
};

/** 离开联机：完整清理连接、定时器、标记 */
Game.netLeave = function () {
    if (!Game.net) return;
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
    var wasGuest = Game.net.role === 'guest';
    Game._leaving = true;
    setTimeout(function () { Game._leaving = false; }, 2500);
    Game.netLog('leave', wasGuest ? 'guest' : 'host');
    try { Game.netCountdownHide(); } catch (e) {}
    try {
        if (Game.netGuestStopReconnect) Game.netGuestStopReconnect();
    } catch (e) {}
    try {
        if (Game.net.role === 'guest') {
            try { Game.net.guestConn.send({ t: 'bye' }); } catch (e) {}
        } else {
            Game.netBroadcast({ t: 'hostbye' });
        }
        Object.keys(Game.net.conns || {}).forEach(function (s) {
            try { Game.net.conns[s].close(); } catch (e) {}
        });
        if (Game.net.heartbeat) {
            clearInterval(Game.net.heartbeat);
            Game.net.heartbeat = null;
        }
        if (Game.net.hostSilentTimer) {
            clearInterval(Game.net.hostSilentTimer);
            Game.net.hostSilentTimer = null;
        }
        try { Game.net.peer.destroy(); } catch (e) {}
    } catch (e) {}
    Game.net = null;
    Game.netNoSave = wasGuest;
    if (!wasGuest) {
        try { if (Game.netHostRestore) Game.netHostRestore(); } catch (e) {}
    }
    if (wasGuest) {
        try { if (Game.netGuestCleanup) Game.netGuestCleanup(); } catch (e) {}
    }
    try { Game.netRefreshAvatarBadges(); } catch (e) {}
};

// ========== 前后台 / 锁屏防护 ==========
// 房主或客人切后台、锁屏会让定时器被节流，对端会误判掉线。
// 1) 在联机中申请屏幕常亮（Wake Lock）；2) 回到前台立刻检查连接并补发状态。
var wakeLock = null;
function acquireWakeLock() {
    try {
        if (!Game.net || !navigator.wakeLock || wakeLock || document.visibilityState !== 'visible') return;
        navigator.wakeLock.request('screen').then(function (l) {
            wakeLock = l;
            l.addEventListener('release', function () { wakeLock = null; });
        }, function () {});
    } catch (e) {}
}
Game.netAcquireWakeLock = acquireWakeLock;
document.addEventListener('visibilitychange', function () {
    if (!Game.net) return;
    if (document.visibilityState === 'visible') {
        acquireWakeLock();
        if (isNetHost()) {
            Game.netLog('host:foreground');
            try { Game.netBroadcast({ t: 'ping', ts: Date.now() }); } catch (e) {}
            try { if (Game.net.started) Game.netBroadcastState(true); } catch (e) {}
        } else if (isNetGuest() && Game.net.lastHostMsg &&
                   Date.now() - Game.net.lastHostMsg > Game.netTimeouts.hostSilent) {
            Game.netLog('guest:foreground-stale');
            if (typeof Game.netGuestOnConnLost === 'function') Game.netGuestOnConnLost();
        }
    } else {
        Game.netLog('hidden');
    }
});

window.addEventListener('beforeunload', function () {
    if (Game.net && Game.net.role === 'host') {
        try { Game.netBroadcast({ t: 'hostbye' }); } catch (e) {}
    }
});

// 暴露配置供调试 / 生产覆盖
Game.NET_CONFIG = NET_CONFIG;

;})();
