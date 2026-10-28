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
    statusPill.title = '点按复制联机诊断信息（反馈问题时发给开发者）';
    statusPill.setAttribute('role', 'button');
    statusPill.tabIndex = 0;
    statusPill.onclick = function () { copyText(Game.netDiag(), '诊断信息已复制'); };
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
    if (noticeEl && noticeEl.classList.contains('show')) {
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
    renderMain();
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
        '<button class="hu-btn net-btn ghost" id="net-lobby-cancel">返回</button>' +
        '</div>';
    $('net-go-create').onclick = renderCreate;
    $('net-go-join').onclick = renderJoin;
    $('net-lobby-cancel').onclick = Game.netLobbyClose;
    try { $('net-go-create').focus(); } catch (e) {}
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

function renderJoin() {
    var mySeq = ++busySeq;
    lobbyBody.innerHTML =
        '<div class="net-label">房间码（房主告诉你的 ' + Game.netCodeLen + ' 位字母数字）</div>' +
        '<input class="net-input net-code-input" id="net-code" maxlength="' + Game.netCodeLen +
        '" autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
        'aria-label="房间码" placeholder="K7M2QX">' +
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
    try { codeEl.focus(); } catch (e) {}

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
        setBusy('正在连接房主…', true, function () { renderJoin(); });
        Game.netJoinRoom(code, name).then(function (r) {
            if (mySeq !== busySeq) {
                dropStaleNet(r);
                return;
            }
            if (r.ok) {
                renderGuestWaiting(r.welcome);
                if (typeof Game.netGuestInit === 'function') Game.netGuestInit(r.welcome);
            } else {
                setErr(r.err || '加入失败');
                renderJoin();
            }
        }).catch(function (err) {
            if (mySeq !== busySeq) return;
            setErr('加入异常：' + (err && err.message ? err.message : err));
            renderJoin();
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

function copyRoomCode() {
    var code = Game.net && Game.net.code;
    if (!code) return;
    copyText(code, '房间码已复制，发给朋友来加入吧');
}

function renderHostRoom() {
    busySeq++;
    lobbyBody.innerHTML =
        '<div class="net-label">房间码（点按复制，发给朋友）</div>' +
        '<button type="button" class="net-code-btn" id="net-code-copy" aria-label="复制房间码">' +
        esc(Game.net.code) + '</button>' +
        '<div class="net-copy-hint">点按房间码复制</div>' +
        '<div id="net-seats-wrap">' + seatsHtml(Game.net.seats) + '</div>' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn" id="net-start-daily">日常开局</button>' +
        '<button class="hu-btn net-btn" id="net-start-adv">高阶开局</button>' +
        '</div>' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn ghost" id="net-leave1">解散房间</button>' +
        '</div>';
    $('net-code-copy').onclick = copyRoomCode;
    $('net-start-daily').onclick = function () { hostStart('daily'); };
    $('net-start-adv').onclick = function () { hostStart('advanced'); };
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
        '<div class="net-spinner" aria-hidden="true"></div>' +
        '<div class="net-busy-text">等待房主开始游戏…</div>' +
        '<div class="net-row">' +
        '<button class="hu-btn net-btn ghost" id="net-leave2">离开房间</button>' +
        '</div>';
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
            ? '·' + humanCount(Game.net.seats) + '/4人'
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectEntry);
} else {
    injectEntry();
}
// 兜底：弹窗可能是后渲染的
setTimeout(injectEntry, 800);
setTimeout(injectEntry, 2500);

;})();
