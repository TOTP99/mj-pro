;(function () {
'use strict';
// ---------- 联机大厅（26-net-lobby.js）v4.5 ----------
// 建房 / 加入 / 座位表 / 开局
// 商业级：无阻塞 alert（全走 net-notice）、异步操作有加载态与取消、防重入、
// 焦点管理、确认弹窗、房间码粘贴处理、键盘友好、完整清理。

var lobbyEl = null, lobbyBody = null, statusPill = null;
var noticeEl = null, toastEl = null, toastTimer = null;
var SEAT_ORDER = ['bottom', 'top', 'left', 'right']; // 猫龙虎狮
var busySeq = 0; // 异步操作序号：取消/重渲染后过期回调直接丢弃

function $(id) { return document.getElementById(id); }

function ensureLobbyDom() {
    if (lobbyEl) return;
    lobbyEl = document.createElement('div');
    lobbyEl.id = 'net-lobby-modal';
    lobbyEl.setAttribute('role', 'dialog');
    lobbyEl.setAttribute('aria-modal', 'true');
    lobbyEl.setAttribute('aria-label', '联机对战');
    lobbyEl.innerHTML =
        '<div class="hu-box net-lobby-box">' +
        '<div class="hu-title">联机对战</div>' +
        '<div class="hu-scroll" id="net-lobby-body"></div>' +
        '</div>';
    document.body.appendChild(lobbyEl);
    lobbyBody = $('net-lobby-body');
    lobbyEl.addEventListener('click', function (e) {
        if (e.target === lobbyEl) Game.netLobbyClose();
    });
    // 状态小 pill（点按复制诊断）
    statusPill = document.createElement('div');
    statusPill.id = 'net-status-pill';
    statusPill.style.display = 'none';
    statusPill.title = '点按打开房间面板';
    statusPill.setAttribute('role', 'button');
    statusPill.tabIndex = 0;
    statusPill.onclick = function () { Game.netLobbyOpen(); };
    statusPill.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            statusPill.click();
        }
    };
    document.body.appendChild(statusPill);
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ---------- 通知弹窗（替代 alert） ---------- */
function ensureNoticeDom() {
    if (noticeEl) return;
    noticeEl = document.createElement('div');
    noticeEl.id = 'net-notice-modal';
    noticeEl.setAttribute('role', 'alertdialog');
    noticeEl.setAttribute('aria-modal', 'true');
    noticeEl.setAttribute('aria-labelledby', 'net-notice-title');
    noticeEl.innerHTML =
        '<div class="hu-box net-notice-box">' +
        '<div class="net-notice-title" id="net-notice-title"></div>' +
        '<div class="hu-scroll"><div class="net-notice-body" id="net-notice-body"></div></div>' +
        '<div class="net-notice-btns" id="net-notice-btns"></div>' +
        '</div>';
    document.body.appendChild(noticeEl);
}

/**
 * 通知弹窗。buttons: [{text, primary(默认true), onClick}]
 */
function netShowNotice(title, body, buttons) {
    ensureNoticeDom();
    $('net-notice-title').textContent = title || '提示';
    $('net-notice-body').textContent = body || '';
    var wrap = $('net-notice-btns');
    wrap.innerHTML = '';
    (buttons && buttons.length ? buttons : [{ text: '知道了' }]).forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hu-btn' + (b.primary === false ? ' ghost' : '');
        btn.textContent = b.text;
        btn.onclick = function () {
            noticeEl.classList.remove('show');
            try { if (b.onClick) b.onClick(); } catch (e) {}
        };
        wrap.appendChild(btn);
    });
    noticeEl.classList.add('show');
    try { wrap.firstChild.focus(); } catch (e) {}
}
Game.netShowNotice = netShowNotice;

// Esc：通知弹窗优先处理次要按钮；大厅关闭
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (qrEl && qrEl.classList.contains('show')) {
        qrEl.classList.remove('show');
    } else if (noticeEl && noticeEl.classList.contains('show')) {
        var g = noticeEl.querySelector('.hu-btn.ghost');
        if (g) g.click();
        else {
            var first = noticeEl.querySelector('.hu-btn');
            if (first) first.click();
        }
    } else if (lobbyEl && lobbyEl.classList.contains('show')) {
        Game.netLobbyClose();
    }
});

/* ---------- Toast 轻提示 ---------- */
function netToastUI(text) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'net-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        toastEl.classList.remove('show');
    }, 2200);
}
Game.netToastUI = netToastUI;

/* ---------- 大厅开关 ---------- */
Game.netLobbyOpen = function () {
    ensureLobbyDom();
    // 已在房间里：回到当前房间面板（不能再建/加入别的房间）
    if (Game.net && Game.net.role === 'host') renderHostRoom();
    else if (Game.net && Game.net.role === 'guest') renderGuestWaiting({ seat: Game.net.seat, seats: Game.net.seats });
    else renderMain();
    lobbyEl.classList.add('show');
    try {
        var firstBtn = lobbyBody.querySelector('button');
        if (firstBtn) firstBtn.focus();
    } catch (e) {}
};
Game.netLobbyClose = function () {
    if (lobbyEl) lobbyEl.classList.remove('show');
};
Game.netLobbyIsOpen = function () {
    return !!(lobbyEl && lobbyEl.classList.contains('show'));
};

function seatLabel(seat) {
    return Game.netWinds[seat] + ' ' + Game.netAnimals[seat];
}

/** 座位头像：用 canonical 原始映射（客人本地的 statAvatar 被重映射过） */
function seatAvatar(seat) {
    var table = (Game._netOrig && Game._netOrig.statAvatar) || Game.statAvatar || {};
    return table[seat] || '';
}

function humanCount(seats) {
    var n = 0;
    (seats || []).forEach(function (s) {
        if (s.kind === 'human') n++;
    });
    return n;
}

/** 座位表：头像 + 名字 + 状态；房主可踢人；新加入滑入动画 */
var prevSeatKeys = '';
function seatsHtml(seats) {
    var isHost = Game.net && Game.net.role === 'host';
    var mySeat = Game.net && Game.net.seat;
    var curKeys = (seats || [])
        .filter(function (s) { return s.kind === 'human'; })
        .map(function (s) { return s.seat; })
        .join(',');
    var isFirst = !prevSeatKeys;
    var prev = '|' + prevSeatKeys + '|';
    var html = '<div class="net-seats">';
    SEAT_ORDER.forEach(function (seat) {
        var m = null;
        (seats || []).forEach(function (s) {
            if (s.seat === seat) m = s;
        });
        var cls = 'net-seat';
        var inner;
        if (!m) {
            cls += ' empty';
            inner = '<div class="net-seat-sub">等待加入…</div>';
        } else if (m.kind === 'ai') {
            cls += ' ai';
            inner =
                '<div class="net-seat-avatar">' + seatAvatar(seat) + '</div>' +
                '<div class="net-seat-info">' +
                '<div class="net-seat-name">' + esc(m.away && m.name ? m.name : seatLabel(seat)) + '</div>' +
                '<div class="net-seat-sub">' +
                (m.away ? '离线 · AI 暂代（可重连）' : 'AI 代打') +
                '</div></div>';
        } else {
            cls += ' human';
            if (seat === mySeat) cls += ' you';
            if (!isFirst && prev.indexOf('|' + seat + '|') < 0) cls += ' net-seat-enter';
            var youTag = seat === mySeat ? '<span class="net-you-tag">你</span>' : '';
            var kick = (isHost && seat !== 'bottom')
                ? '<button type="button" class="net-kick" data-kick="' + seat +
                  '" title="请出该玩家" aria-label="请出">×</button>'
                : '';
            inner =
                '<div class="net-seat-avatar">' + seatAvatar(seat) + '</div>' +
                '<div class="net-seat-info">' +
                '<div class="net-seat-name">' + esc(m.name || '玩家') + youTag + '</div>' +
                '<div class="net-seat-sub">' + esc(seatLabel(seat)) +
                (m.auto ? ' · 托管中' : '') + '</div></div>' + kick;
        }
        html += '<div class="' + cls + '">' + inner + '</div>';
    });
    html += '</div>';
    var n = humanCount(seats);
    html += '<div class="net-count">' + n + ' / 4 人</div>';
    prevSeatKeys = curKeys;
    return html;
}

function wireKickButtons() {
    Array.prototype.forEach.call(lobbyBody.querySelectorAll('[data-kick]'), function (btn) {
        btn.onclick = function (e) {
            e.stopPropagation();
            var seat = btn.getAttribute('data-kick');
            var m = null;
            (Game.net.seats || []).forEach(function (s) {
                if (s.seat === seat) m = s;
            });
            var nm = m ? (m.name || '玩家') : '该玩家';
            netShowNotice(
                '请出玩家',
                '确定请出 ' + seatLabel(seat) + '（' + nm + '）吗？该座位将转 AI 代打。',
                [
                    {
                        text: '请出',
                        onClick: function () {
                            try { Game.netHostDropSeat(seat, '被房主请出'); } catch (err) {}
                            netToastUI('已请出 ' + nm);
                        }
                    },
                    { text: '取消', primary: false }
                ]
            );
        };
    });
}

function renderMain() {
    busySeq++;
    lobbyBody.innerHTML =
        '<div class="net-desc">和朋友点对点联机，最多 4 人，空位 AI 顶上。<br>' +
        '先进房间的是房主（坐猫），后进按龙→虎→狮入座。</div>' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn" id="net-go-create">建房</button>' +
        '<button class="hu-btn net-btn" id="net-go-join">加入房间</button>' +
        '</div>' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn ghost" id="net-net-help">网络说明</button>' +
        '<button class="hu-btn net-btn ghost" id="net-lobby-cancel">返回</button>' +
        '</div>';
    $('net-go-create').onclick = renderCreate;
    $('net-go-join').onclick = function () { renderJoin(); };
    $('net-net-help').onclick = showNetHelp;
    $('net-lobby-cancel').onclick = Game.netLobbyClose;
    try { $('net-go-create').focus(); } catch (e) {}
}

/** 是否已配置 TURN（部署配置 net-config.js 或本机 localStorage） */
function turnConfigured() {
    function has(list) {
        return Array.isArray(list) && list.some(function (x) {
            return x && x.urls && /(^|[\s,\[])turns?:/i.test(Array.isArray(x.urls) ? x.urls.join(',') : String(x.urls));
        });
    }
    try { if (window.QJ_NET_CONFIG && has(window.QJ_NET_CONFIG.ice)) return true; } catch (e) {}
    try { if (has(JSON.parse(localStorage.getItem('qj_mj_net_ice') || 'null'))) return true; } catch (e) {}
    return false;
}

/** 网络说明：连不上时的自查与 TURN 配置指引 */
function showNetHelp() {
    var hasTurn = turnConfigured();
    var body =
        '联机走 PeerJS 点对点，默认使用公共信令和公共 STUN。\n\n' +
        '连不上时建议：\n' +
        '1. 尽量和房主在同一 Wi‑Fi\n' +
        '2. 关闭 VPN / 代理后重试\n' +
        '3. 手机流量或公司网络失败属常见现象（对称 NAT），需要 TURN 中继\n\n' +
        '当前 TURN：' + (hasTurn ? '已配置' : '未配置') + '\n\n' +
        '部署方（站长）：编辑站点根目录的 net-config.js 填入自建信令与 TURN，步骤见 deploy/README-DEPLOY.md。';
    netShowNotice('联机网络说明', body, [
        { text: '知道了' },
        {
            text: '复制诊断', primary: false,
            onClick: function () { copyText(Game.netDiag(), '诊断信息已复制'); }
        }
    ]);
}

/** 用户已取消但那次建房/加入其实成功了：干净退出，避免幽灵座位 */
function dropStaleNet(r) {
    if (!r || !r.ok || !r.peer) return;
    if (Game.net && Game.net.peer === r.peer) {
        try { Game.netLeave(); } catch (e) {}
        Game.netNoSave = false;
        updatePill();
    } else {
        try { r.peer.destroy(); } catch (e) {}
    }
}

function renderCreate() {
    var mySeq = ++busySeq;
    lobbyBody.innerHTML =
        '<div class="net-label">你的名字</div>' +
        '<input class="net-input" id="net-name" maxlength="12" placeholder="比如：阿猫" ' +
        'value="' + esc(Game.netDefaultName()) + '" autocomplete="nickname" aria-label="你的名字">' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn" id="net-do-create">建房</button>' +
        '<button class="hu-btn net-btn ghost" id="net-back1">返回</button>' +
        '</div>' +
        '<div class="net-err" id="net-err"></div>';
    var nameInput = $('net-name');
    try { nameInput.focus(); nameInput.select(); } catch (e) {}
    $('net-do-create').onclick = function () {
        var name = Game.netCleanName(nameInput.value, '房主');
        Game.netRememberName(name);
        var code = Game.netGenCode();
        setBusy('正在建房…', true, function () { renderMain(); });
        Game.netCreateRoom(code, name).then(function (r) {
            if (mySeq !== busySeq) {
                dropStaleNet(r);
                return;
            }
            if (r.role === 'host') {
                renderHostRoom();
            } else if (r.role === 'guest') {
                renderGuestWaiting(r.welcome);
                if (typeof Game.netGuestInit === 'function') Game.netGuestInit(r.welcome);
            } else {
                setErr(r.err || '建房失败');
                renderMain();
            }
        }).catch(function (err) {
            if (mySeq !== busySeq) return;
            setErr('建房异常：' + (err && err.message ? err.message : err));
            renderMain();
        });
    };
    $('net-back1').onclick = renderMain;
    nameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') $('net-do-create').click();
    });
}

/** 从 URL 读取房间码（?room= / ?code= / #room=），无效返回空串 */
function readRoomFromUrl() {
    try {
        var u = new URL(location.href);
        var c = u.searchParams.get('room') || u.searchParams.get('code');
        if (!c && u.hash) {
            var m = u.hash.match(/(?:^|[&#])room=([A-Za-z0-9]+)/i);
            if (m) c = m[1];
        }
        c = Game.netNormCode(c || '');
        return Game.netValidCode(c) ? c : '';
    } catch (e) {
        return '';
    }
}

/** 加入失败时给出可操作的建议 */
function joinFailTips(errMsg) {
    var msg = String(errMsg || '加入失败');
    var tips = '';
    if (/已在联机房间/.test(msg)) tips = '';
    else if (/找不到房间|peer-unavailable|无响应|房间码|已锁房/i.test(msg)) tips = '\n\n请确认：房间码正确、房主仍在线、未解散也未锁房。';
    else if (/网络|连接失败|断开|超时|timeout|ICE|webrtc/i.test(msg)) tips = '\n\n网络建议：尽量同一 Wi‑Fi；关闭 VPN；仍失败请看大厅「网络说明」。';
    else if (/版本/.test(msg)) tips = '\n\n请双方都强制刷新页面后再试。';
    return msg + tips;
}

function renderJoin(prefillCode) {
    var mySeq = ++busySeq;
    var initialCode = Game.netNormCode(typeof prefillCode === 'string' ? prefillCode : readRoomFromUrl()).slice(0, Game.netCodeLen);
    lobbyBody.innerHTML =
        '<div class="net-label">房间码（房主告诉你的 ' + Game.netCodeLen + ' 位字母数字）</div>' +
        '<input class="net-input net-code-input" id="net-code" maxlength="' + Game.netCodeLen +
        '" autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
        'aria-label="房间码" placeholder="K7M2QX" value="' + esc(initialCode) + '">' +
        '<div class="net-label">你的名字</div>' +
        '<input class="net-input" id="net-name2" maxlength="12" placeholder="比如：阿虎" ' +
        'value="' + esc(Game.netDefaultName()) + '" autocomplete="nickname" aria-label="你的名字">' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn" id="net-do-join">加入</button>' +
        '<button class="hu-btn net-btn ghost" id="net-back2">返回</button>' +
        '</div>' +
        '<div class="net-err" id="net-err"></div>';
    var codeEl = $('net-code');
    var nameEl = $('net-name2');
    try {
        if (initialCode.length >= Game.netCodeLen) nameEl.focus();
        else codeEl.focus();
    } catch (e) {}

    // 自动转大写、去杂质；满码后聚焦名字；支持粘贴
    function normalizeCodeInput() {
        var v = Game.netNormCode(codeEl.value).slice(0, Game.netCodeLen);
        if (codeEl.value !== v) codeEl.value = v;
        if (v.length >= Game.netCodeLen) {
            try { nameEl.focus(); } catch (e) {}
        }
    }
    codeEl.addEventListener('input', normalizeCodeInput);
    codeEl.addEventListener('paste', function () {
        setTimeout(normalizeCodeInput, 0);
    });

    $('net-do-join').onclick = function () {
        var code = Game.netNormCode(codeEl.value);
        var name = Game.netCleanName(nameEl.value, '客人');
        if (!Game.netValidCode(code)) {
            setErr('房间码是 ' + Game.netCodeLen + ' 位字母数字（没有 I、O、0、1）');
            return;
        }
        Game.netRememberName(name);
        setBusy('正在连接房主…', true, function () { renderJoin(code); });
        Game.netJoinRoom(code, name).then(function (r) {
            if (mySeq !== busySeq) {
                dropStaleNet(r);
                return;
            }
            if (r.ok) {
                renderGuestWaiting(r.welcome);
                if (typeof Game.netGuestInit === 'function') Game.netGuestInit(r.welcome);
            } else {
                clearBusy();
                setErr(joinFailTips(r.err || '加入失败')); // 不重绘页面，已填的房间码和名字保留
            }
        }).catch(function (err) {
            if (mySeq !== busySeq) return;
            clearBusy();
            setErr(joinFailTips('加入异常：' + (err && err.message ? err.message : err)));
        });
    };
    $('net-back2').onclick = renderMain;
    nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') $('net-do-join').click();
    });
    codeEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && codeEl.value.length >= Game.netCodeLen) {
            nameEl.focus();
        }
    });
}

function copyText(text, okMsg) {
    function done() { netToastUI(okMsg || '已复制'); }
    function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        try {
            ta.select();
            document.execCommand('copy');
            done();
        } catch (e) {}
        ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
    } else {
        fallback();
    }
}

/** 邀请链接：同页面 + ?room=房间码（朋友打开自动预填） */
function getShareUrl(code) {
    code = Game.netNormCode(code || (Game.net && Game.net.code) || '');
    if (!code) return '';
    try {
        var u = new URL(location.href);
        u.search = '';
        u.hash = '';
        u.searchParams.set('room', code);
        return u.toString();
    } catch (e) {
        return (location.origin || '') + (location.pathname || '/') + '?room=' + encodeURIComponent(code);
    }
}
function copyShareLink() {
    var code = Game.net && Game.net.code;
    if (!code) return;
    var url = getShareUrl(code);
    if (!url) { copyRoomCode(); return; }
    copyText(url, '邀请链接已复制，朋友打开即可填入房间码');
}
function copyShareInvite() {
    var code = Game.net && Game.net.code;
    if (!code) return;
    var url = getShareUrl(code);
    copyText('来打麻将！房间码 ' + code + (url ? '\n' + url : ''), '邀请文案已复制（含房间码+链接）');
}

/** 二维码弹窗：朋友用手机相机/微信扫一扫即可打开加入页（链接带 ?room=） */
var qrEl = null;
function qrSvg(text) {
    var q = (window.QJQR && window.QJQR.make) ? window.QJQR.make(text) : null;
    if (!q) return '';
    var quiet = 4, n = q.size + quiet * 2, d = '';
    for (var r = 0; r < q.size; r++) {
        for (var c = 0; c < q.size; c++) {
            if (q.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
        }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="房间二维码">' +
        '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
function showQr() {
    var code = Game.net && Game.net.code;
    if (!code) return;
    var url = getShareUrl(code);
    var svg = qrSvg(url);
    if (!svg) { netShowNotice('二维码生成失败', '请改用「复制链接」或直接发房间码：' + code, [{ text: '知道了' }]); return; }
    if (!qrEl) {
        qrEl = document.createElement('div');
        qrEl.id = 'net-qr-modal';
        qrEl.setAttribute('role', 'dialog');
        qrEl.setAttribute('aria-modal', 'true');
        qrEl.setAttribute('aria-label', '扫码加入');
        qrEl.addEventListener('click', function (e) { if (e.target === qrEl) qrEl.classList.remove('show'); });
        document.body.appendChild(qrEl);
    }
    var secure = /^https:/i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)/i.test(url);
    var warn = /^https:/i.test(url) ? '' :
        '<div class="net-qr-warn">当前不是 HTTPS 公网地址，朋友的手机可能打不开；请先把游戏部署到网上，或直接发房间码。</div>';
    qrEl.innerHTML =
        '<div class="hu-box net-qr-box">' +
        '<div class="hu-title">扫码加入</div>' +
        '<div class="net-qr-img">' + svg + '</div>' +
        '<div class="net-qr-code">' + esc(code) + '</div>' +
        '<div class="net-qr-hint">朋友用手机相机或微信「扫一扫」即可打开加入页</div>' +
        warn +
        '<div class="net-row"><button type="button" class="hu-btn net-btn" id="net-qr-close">关闭</button></div>' +
        '</div>';
    qrEl.classList.add('show');
    $('net-qr-close').onclick = function () { qrEl.classList.remove('show'); };
    try { $('net-qr-close').focus(); } catch (e) {}
}
Game.netShowQr = showQr;

function copyRoomCode() {
    var code = Game.net && Game.net.code;
    if (!code) return;
    copyText(code, '房间码已复制，发给朋友来加入吧');
}

/** 建房后静默尝试把邀请文案放进剪贴板（需浏览器允许；失败不打扰） */
function autoCopyInvite() {
    try {
        var code = Game.net && Game.net.code;
        if (!code || !navigator.clipboard || !navigator.clipboard.writeText) return;
        var url = getShareUrl(code);
        navigator.clipboard.writeText('来打麻将！房间码 ' + code + (url ? '\n' + url : '')).then(function () {
            netToastUI('邀请已自动复制，直接粘贴发给朋友');
        }, function () {});
    } catch (e) {}
}

var hostRoomShown = '';
function renderHostRoom() {
    busySeq++;
    lobbyBody.innerHTML =
        '<div class="net-label">房间码（点按复制，发给朋友）</div>' +
        '<button type="button" class="net-code-btn" id="net-code-copy" aria-label="复制房间码">' +
        esc(Game.net.code) + '</button>' +
        '<div class="net-copy-hint">点房间码复制 · 也可复制链接发给朋友</div>' +
        '<div class="net-share-box">' +
        '<button type="button" class="net-qr-inline" id="net-show-qr" aria-label="放大二维码" title="点按放大">' + qrSvg(getShareUrl(Game.net.code)) + '</button>' +
        '<div class="net-share-btns">' +
        '<div class="net-qr-tip">朋友扫码即可自动加入</div>' +
        '<button type="button" class="hu-btn net-btn ghost" id="net-copy-link">复制链接</button>' +
        '<button type="button" class="hu-btn net-btn ghost" id="net-copy-invite">复制邀请</button>' +
        '</div></div>' +
        '<div id="net-seats-wrap">' + seatsHtml(Game.net.seats) + '</div>' +
        '<div class="net-sticky">' +
        (Game.net.started
            ? '<div class="net-row"><button class="hu-btn net-btn" id="net-back-table">返回牌桌</button></div>'
            : '<div class="net-row">' +
              '<button class="hu-btn net-btn" id="net-start-daily">日常开局</button>' +
              '<button class="hu-btn net-btn" id="net-start-adv">高阶开局</button>' +
              '</div>') +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn ghost" id="net-lock">锁房</button>' +
        '<button class="hu-btn net-btn ghost" id="net-diag">复制诊断</button>' +
        '<button class="hu-btn net-btn ghost" id="net-leave1">解散房间</button>' +
        '</div></div>';
    $('net-code-copy').onclick = copyRoomCode;
    $('net-copy-link').onclick = copyShareLink;
    $('net-copy-invite').onclick = copyShareInvite;
    $('net-show-qr').onclick = showQr;
    if (hostRoomShown !== Game.net.code) { hostRoomShown = Game.net.code; autoCopyInvite(); }
    if ($('net-start-daily')) $('net-start-daily').onclick = function () { hostStart('daily'); };
    if ($('net-start-adv')) $('net-start-adv').onclick = function () { hostStart('advanced'); };
    if ($('net-back-table')) $('net-back-table').onclick = Game.netLobbyClose;
    $('net-lock').onclick = function () { Game.netSetLocked(!Game.net.locked); };
    $('net-diag').onclick = function () { copyText(Game.netDiag(), '诊断信息已复制'); };
    updateLockBtn();
    $('net-leave1').onclick = function () {
        netShowNotice('解散房间', '确定解散房间吗？所有客人将被断开。', [
            {
                text: '解散',
                onClick: function () {
                    Game.netLeave();
                    renderMain();
                    updatePill();
                }
            },
            { text: '取消', primary: false }
        ]);
    };
    wireKickButtons();
    updatePill();
    try { $('net-code-copy').focus(); } catch (e) {}
}

function updateLockBtn() {
    var b = $('net-lock');
    if (b && Game.net) b.textContent = Game.net.locked ? '解锁' : '锁房';
}

function hostStart(mode) {
    if (typeof Game.netHostInit === 'function') Game.netHostInit();
    Game.netLobbyClose();
    updatePill();
    try {
        Game.chooseMode(mode);
    } catch (e) {
        try { Game.startGame(); } catch (e2) {}
    }
    setTimeout(function () {
        try {
            if (Game.netBroadcastSeats) Game.netBroadcastSeats();
            if (Game.netBroadcastState) Game.netBroadcastState(true);
        } catch (e) {}
    }, 800);
}

function renderGuestWaiting(welcome) {
    busySeq++;
    lobbyBody.innerHTML =
        '<div class="net-label">已加入房间 <b class="net-code-inline">' +
        esc(Game.net.code) + '</b></div>' +
        '<div class="net-label">你是：<b>' + esc(seatLabel(welcome.seat)) + '</b></div>' +
        '<div id="net-seats-wrap">' + seatsHtml(welcome.seats || Game.net.seats) + '</div>' +
        (Game.net.started
            ? '<div class="net-busy-text">对局进行中</div>'
            : '<div class="net-spinner" aria-hidden="true"></div><div class="net-busy-text">等待房主开始游戏…</div>') +
        '<div class="net-sticky"><div class="net-row">' +
        (Game.net.started ? '<button class="hu-btn net-btn" id="net-back-table2">返回牌桌</button>' : '') +
        '<button class="hu-btn net-btn ghost" id="net-diag2">复制诊断</button>' +
        '<button class="hu-btn net-btn ghost" id="net-leave2">离开房间</button>' +
        '</div></div>';
    if ($('net-back-table2')) $('net-back-table2').onclick = Game.netLobbyClose;
    $('net-diag2').onclick = function () { copyText(Game.netDiag(), '诊断信息已复制'); };
    $('net-leave2').onclick = function () {
        netShowNotice('离开房间', '确定离开吗？需要重新加入才能继续。', [
            {
                text: '离开',
                onClick: function () {
                    Game.netLeave();
                    // 镜像状态不能留在单机，刷新回到单机存档
                    try { location.reload(); } catch (e) {}
                }
            },
            { text: '取消', primary: false }
        ]);
    };
    updatePill();
}

/** 供客人被请出后“重新加入”用 */
Game.netShowGuestWaiting = function (welcome) {
    ensureLobbyDom();
    renderGuestWaiting(welcome);
    lobbyEl.classList.add('show');
};

/** 座位表刷新（23/24 回调）；房主屏有新客人加入时 toast */
var lastHumanJson = '';
Game.netLobbyRender = function () {
    if (!Game.net || !Game.netLobbyIsOpen()) {
        updatePill();
        return;
    }
    try {
        if (Game.net.role === 'host') {
            var humans = (Game.net.seats || [])
                .filter(function (s) { return s.kind === 'human'; })
                .map(function (s) { return s.seat + ':' + (s.name || ''); });
            var cur = JSON.stringify(humans);
            if (lastHumanJson && cur !== lastHumanJson) {
                var prev = {};
                try {
                    JSON.parse(lastHumanJson).forEach(function (h) {
                        prev[h.split(':')[0]] = true;
                    });
                } catch (e) {}
                humans.forEach(function (h) {
                    var parts = h.split(':');
                    var seat = parts[0];
                    var nm = parts[1] || '';
                    if (!prev[seat] && seat !== 'bottom') {
                        netToastUI(seatLabel(seat) + '（' + nm + '）加入了房间');
                    }
                });
            }
            lastHumanJson = cur;
        }
    } catch (e) {}
    var w = $('net-seats-wrap');
    if (w) {
        w.innerHTML = seatsHtml(Game.net.seats);
        wireKickButtons();
    }
    updateLockBtn();
    updatePill();
};

function setBusy(t, cancellable, onCancel) {
    var e = $('net-err');
    if (!e) return;
    e.className = 'net-err busy';
    e.innerHTML =
        '<div class="net-spinner" style="margin:6px auto 2px" aria-hidden="true"></div>' +
        '<div class="net-busy-text">' + esc(t) + '</div>' +
        (cancellable
            ? '<div class="net-row"><button class="hu-btn net-btn ghost" id="net-busy-cancel">取消</button></div>'
            : '');
    if (cancellable && onCancel) {
        var btn = $('net-busy-cancel');
        if (btn) {
            btn.onclick = function () {
                busySeq++;
                onCancel();
            };
        }
    }
}

function clearBusy() {
    var e = $('net-err');
    if (e) { e.className = 'net-err'; e.textContent = ''; }
}

function setErr(t) {
    var e = $('net-err');
    if (e) {
        e.className = 'net-err';
        e.textContent = t;
    }
}

function updatePill() {
    if (!statusPill) return;
    if (Game.net) {
        statusPill.style.display = '';
        statusPill.className = '';
        var role = Game.net.role === 'host' ? '房主' : '客人';
        var extra = Game.net.role === 'host'
            ? '·' + humanCount(Game.net.seats) + '/4人' + (Game.net.locked ? '·已锁' : '')
            : '';
        statusPill.textContent =
            '联机中·' + role + '·' + seatLabel(Game.net.seat) +
            ' #' + Game.net.code + extra;
    } else {
        statusPill.style.display = 'none';
        lastHumanJson = '';
        prevSeatKeys = '';
    }
}
Game.netUpdatePill = updatePill;

Game.netDefaultName = function () {
    try {
        return localStorage.getItem('qj_mj_net_name') || '';
    } catch (e) {
        return '';
    }
};
Game.netRememberName = function (n) {
    try {
        localStorage.setItem('qj_mj_net_name', n);
    } catch (e) {}
};

// ---- 入口：往模式选择弹窗里加「联机对战」按钮 ----
function injectEntry() {
    var box = document.querySelector('#mode-select-modal .mode-options');
    if (!box || $('net-entry-btn')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'net-entry-btn';
    b.className = 'mode-option';
    b.innerHTML =
        '<span class="mode-check" aria-hidden="true"></span>' +
        '<span class="mode-text"><b>联机对战</b><i>和朋友点对点开房</i></span>';
    b.onclick = function () {
        if (!Game.netPeerJsReady()) {
            netShowNotice(
                '需要联网',
                '联机需要联网，PeerJS 没加载出来，请检查网络后重试。',
                [{ text: '知道了' }]
            );
            return;
        }
        try {
            var m = $('mode-select-modal');
            if (m) m.classList.remove('show');
        } catch (e) {}
        Game.netLobbyOpen();
    };
    box.appendChild(b);
}

/** 深链（扫码 / 点链接）：带 ?room= 打开页面 → 自动加入，无需再点；失败则停在预填好的加入页 */
function autoJoinName() {
    var n = '';
    try { n = Game.netCleanName(Game.netDefaultName(), ''); } catch (e) {}
    if (!n) n = '客人' + String(Math.floor(10 + Math.random() * 90)); // 没填过名字：给个默认名
    return n;
}
function tryDeepLinkJoin() {
    if (Game.net) return;
    var code = readRoomFromUrl();
    if (!code || !Game.netPeerJsReady()) return;
    try {
        var m = $('mode-select-modal');
        if (m) m.classList.remove('show');
    } catch (e) {}
    ensureLobbyDom();
    renderJoin(code);
    lobbyEl.classList.add('show');
    var nameEl = $('net-name2');
    if (nameEl && !nameEl.value) nameEl.value = autoJoinName();
    try { history.replaceState(null, '', location.pathname); } catch (e) {} // 地址栏去掉 ?room=，刷新不会重复自动加入
    netToastUI('正在加入房间 ' + code + '…');
    var btn = $('net-do-join');
    if (btn) btn.click();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        injectEntry();
        setTimeout(tryDeepLinkJoin, 1200);
    });
} else {
    injectEntry();
    setTimeout(tryDeepLinkJoin, 1200);
}
// 兜底：弹窗可能是后渲染的
setTimeout(injectEntry, 800);
setTimeout(injectEntry, 2500);

;})();
