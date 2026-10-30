;(function(){
'use strict';
// ---------- 联机客人（25-net-guest.js）：状态镜像 + 意图上报 ----------
// 客人是"哑终端"：状态由房主快照喂给，复用单机整套渲染/交互；
// 动作被钩子拦截，改发 intent 给房主，不在本地执行。

var SEATS = ['top', 'left', 'right', 'bottom'];

function mySeat() { return Game.net && Game.net.seat; }
function viewOf(c) { return Game.netViewSeatOf(c, mySeat()); }
function canonOf(v) { return Game.netCanonSeatOf(v, mySeat()); }

/** 客人初始化（收到 welcome 后） */
Game.netGuestInit = function (welcome) {
    Game.netPrompt = null;
    startWatchdog();
    Game.netNoSave = true; // 客人镜像状态不得写入单机存档/场次
    if (!Game._netOrig) Game._netOrig = { baseNames: Game.baseNames, statAvatar: Game.statAvatar };
    // 名字/动物按 canonical 身份显示（位置旋转，身份不转）：09 的 nameOf/animalOf/seatLabel 会委托到这里
    Game.netNameOf = function (p) { return Game.netWinds[canonOf(p)]; };
    Game.netAnimalOf = function (p) { return Game.netAnimals[canonOf(p)] || ''; };
    // baseNames（竖屏统计行风位）也按身份重映射
    try {
        if (Game.baseNames && !Game._netBaseRemapped) {
            Game._netBaseRemapped = true;
            var rawBase = Game.baseNames, remappedBase = {};
            SEATS.forEach(function (v) { remappedBase[v] = rawBase[canonOf(v)]; });
            Game.baseNames = remappedBase;
        }
    } catch (e) {}
    remapAvatars();
    // 拦截 claim 意图
    Game.netClaimIntent = guestClaimIntent;
    Game.netGuestTurnIntent = guestTurnIntent;
    try { Game.logFlow('[联机] 已加入房间，你是' + Game.netWinds[mySeat()] + ' ' + Game.netAnimals[mySeat()] + '，座位在你屏幕下方'); } catch (e) {}
};

/** 头像图跟着 canonical 座位走（位置转，图不转） */
function remapAvatars() {
    var my = mySeat();
    SEATS.forEach(function (view) {
        var canon = canonOf(view, my);
        var src = 'avatars/avatar-' + canon + '.webp';
        try {
            var img = document.querySelector('#p-' + view + ' .avatar img');
            if (img) img.src = src;
        } catch (e) {}
    });
    // 竖屏统计行的头像
    try {
        if (Game.statAvatar) {
            var remapped = {};
            SEATS.forEach(function (view) { remapped[view] = Game.statAvatar[canonOf(view, my)]; });
            Game.statAvatar = remapped;
        }
    } catch (e) {}
}
Game.netGuestRemapAvatars = remapAvatars;

/** 应用房主快照（canonical → view 重映射后喂给渲染） */
Game.netGuestApplyState = function (snap) {
    if (!Game.net || Game.net.role !== 'guest') return;
    if (typeof snap.seq === 'number') { // 乱序/过期快照直接丢弃
        if (snap.seq <= Game.net.seq) return;
        Game.net.seq = snap.seq;
    }
    var my = mySeat();
    try {
        Game.gameEpoch = snap.epoch;
        Game.hands = {}; Game.exposedMelds = {};
        SEATS.forEach(function (c) {
            var v = viewOf(c);
            Game.hands[v] = (c === my) ? (snap.hand || []).slice()
                : (snap.allHands && snap.allHands[c]) ? snap.allHands[c].slice() // 结算摊牌
                : new Array(snap.handCounts[c] || 0).fill('x');
            Game.exposedMelds[v] = (snap.melds[c] || []).slice();
        });
        Game.discardPile = (snap.discards || []).map(function (d) { return { tile: d.tile, player: d.player ? viewOf(d.player) : undefined }; });
        Game.deck = new Array(snap.deckCount || 0).fill('x');
        Game.scores = {};
        SEATS.forEach(function (c) { Game.scores[viewOf(c)] = snap.scores[c]; });
        Game.dealer = viewOf(snap.dealer);
        Game.currentIndex = Game.turnOrder.indexOf(viewOf(snap.currentPlayer));
        Game.gameOver = !!snap.gameOver;
        Game.winner = snap.winner ? viewOf(snap.winner) : null;
        // 有待回应的 prompt 时保留 UI 状态：防抖快照晚于 prompt 到达会把要约清掉
        if (!Game.netPrompt) Game.selectedIndex = null;
        else if (Game.selectedIndex != null && !Game.hands.bottom[Game.selectedIndex]) Game.selectedIndex = null;
        Game.lastDrawnIndex = (snap.drawnIdx != null && snap.drawnIdx >= 0) ? snap.drawnIdx : null;
        Game.lastDrawnTile = { top: null, left: null, right: null, bottom: null };
        if (Game.lastDrawnIndex != null && Game.hands.bottom[Game.lastDrawnIndex])
            Game.lastDrawnTile.bottom = Game.hands.bottom[Game.lastDrawnIndex];
        if (!Game.netPrompt) Game.pendingClaim = null;
        Game.netNames = snap.names || {};
        // 开局标志：优先用快照 started；兼容旧房主仅靠手牌/牌墙推断（房间面板据此显示"对局进行中"）
        if (snap.started || (snap.hand && snap.hand.length) || snap.gameOver) Game.net.started = true;
        if (typeof snap.fieldCount === 'number') { // 局/风/圈 以房主为准，不读客人本机的单机数据
            Game.fieldGameCount = snap.fieldCount;
            Game.fieldActive = !!snap.fieldActive;
            try { if (typeof Game.renderFieldAmounts === 'function') Game.renderFieldAmounts(); } catch (e2) {}
        }
        // 新局开始（非结束态）：收起上一局残留的结算弹窗；开局后关掉等待大厅
        if (!snap.gameOver) {
            try { var rm = Game.$('result-modal'); if (rm && rm.classList.contains('show')) rm.classList.remove('show'); } catch (e) {}
            Game.lastSettlement = null;
        }
        try { if (Game.netLobbyIsOpen && Game.netLobbyIsOpen() && (snap.hand || []).length) Game.netLobbyClose(); } catch (e) {}
        if ((snap.hand || []).length) { // 开局后收起本机残留的模式/筹码/规则弹窗（客人不设置这些）
            try { ['mode-select-modal', 'amount-modal', 'rules-modal'].forEach(function (id) { var m = Game.$(id); if (m) m.classList.remove('show'); }); if (Game.clearSelectGlow) Game.clearSelectGlow(); } catch (e) {}
        }
        // 客人本机启动时残留的"请选择模式/筹码"桌面提示：对局开始后清掉
        try {
            var tp = Game.$('table-center-prompt');
            if (tp && tp.classList.contains('show') && (snap.hand || []).length && /^请选择/.test(tp.textContent)) tp.classList.remove('show');
        } catch (e) {}
        Game.requestRender('netGuest/state');
        try { Game.netRefreshAvatarBadges(); } catch (e) {}
    } catch (e) { /* 快照异常不炸，下一帧会再来 */ }
};

/** 收到房主消息总入口 */
Game.netGuestOnMsg = function (d) {
    if (!Game.net || Game.net.role !== 'guest') return;
    if (d.t === 'state') Game.netGuestApplyState(d.snap);
    else if (d.t === 'prompt') onPrompt(d);
    else if (d.t === 'seats') { Game.net.seats = d.seats; if (typeof Game.netLobbyRender === 'function') Game.netLobbyRender(); try { Game.netRefreshAvatarBadges(); } catch (e) {} }
    else if (d.t === 'toast') { try { Game.logFlow('[联机] ' + d.text); if (Game.netToastUI) Game.netToastUI(String(d.text).slice(0, 60)); } catch (e) {} }
    else if (d.t === 'auto') setAutoBanner(!!d.on);
    else if (d.t === 'result') onResult(d);
    else if (d.t === 'hostbye') Game.netGuestOnHostLeft();
    else if (d.t === 'kicked') Game.netGuestOnHostLeft('kicked');
};

/** 终态：房主离开 / 被请出。通知弹窗（不阻塞 alert）；被请出可一键重新加入 */
Game.netGuestOnHostLeft = function (why) {
    if (!Game.net || Game._leaving || Game.net._terminal) return; // 已处理过：close 回调不再重复弹
    Game.net._terminal = true;
    Game.netGuestStopReconnect();
    var code = Game.net.code, name = Game.net.name;
    var isKicked = why === 'kicked';
    var title = isKicked ? '你被请出了房间' : '房主离开了';
    var body = isKicked ? '该座位已转 AI 代打，你可以重新加入。' : '联机结束，回到单机。';
    Game.netLog('guest:terminal', why || 'hostbye');
    try { Game.logFlow('[联机] ' + title); } catch (e) {}
    Game.netClearPrompt();
    function backToSingle() { location.reload(); }
    try { Game.netLeave(); } catch (e) {} // 释放连接；镜像状态保持禁写，刷新后回单机
    if (typeof Game.netShowNotice === 'function') {
        if (isKicked) {
            Game.netShowNotice(title, body, [
                { text: '重新加入', onClick: function () {
                    Game.netJoinRoom(code, name).then(function (r) {
                        if (r.ok) {
                            try { Game.netGuestInit(r.welcome); } catch (e) {}
                            try { Game.netShowGuestWaiting(r.welcome); } catch (e) { Game.netLobbyOpen(); }
                        } else {
                            Game.netShowNotice('加入失败', r.err || '请稍后重试', [{ text: '知道了', onClick: backToSingle }]);
                        }
                    });
                }},
                { text: '知道了', primary: false, onClick: backToSingle }
            ]);
        } else {
            Game.netShowNotice(title, body, [{ text: '知道了', onClick: backToSingle }]);
        }
    } else {
        backToSingle();
    }
};

// ---------- 断线自动重连（令牌保座） ----------
var rc = null, bannerEl = null, watchdog = 0, autoEl = null;
function showBanner(text) {
    try {
        if (!bannerEl) { bannerEl = document.createElement('div'); bannerEl.id = 'net-reconnect'; bannerEl.setAttribute('role', 'status'); document.body.appendChild(bannerEl); }
        bannerEl.textContent = text; bannerEl.classList.add('show');
    } catch (e) {}
}
function hideBanner() { if (bannerEl) bannerEl.classList.remove('show'); }
/** 托管提示条：点一下恢复自己打 */
function setAutoBanner(on) {
    try {
        if (!autoEl) {
            autoEl = document.createElement('button'); autoEl.type = 'button'; autoEl.id = 'net-auto-banner';
            autoEl.textContent = '你已被托管 · 点此恢复自己打';
            autoEl.onclick = function () { Game.netSendHost({ t: 'resume' }); setAutoBanner(false); };
            document.body.appendChild(autoEl);
        }
        autoEl.classList.toggle('show', !!on);
    } catch (e) {}
}
Game.netGuestStopReconnect = function () {
    if (rc) { rc.stop = true; if (rc.timer) clearTimeout(rc.timer); rc = null; }
    if (watchdog) { clearInterval(watchdog); watchdog = 0; }
    hideBanner(); setAutoBanner(false);
};
function startWatchdog() {
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(function () { // 房主长时间一条消息都没有（连 ping 都没有）→ 判断线
        if (!Game.net || Game.net.role !== 'guest' || rc || Game.net._terminal) return;
        if (Date.now() - (Game.net.lastHostMsg || 0) > Game.netTimeouts.hostSilent) Game.netGuestOnConnLost();
    }, 2000);
}
Game.netGuestOnConnLost = function () {
    var n = Game.net;
    if (!n || n.role !== 'guest' || n._terminal || rc || Game._leaving) return;
    Game.netLog('guest:lost');
    Game.netClearPrompt();
    var info = { code: n.code, name: n.name, token: n.token, seat: n.seat, old: n };
    var state = rc = { stop: false, timer: 0, deadline: Date.now() + Math.max(10000, Game.netTimeouts.reserve - 5000), tries: 0 };
    showBanner('连接中断，正在重连…');
    function giveUp(msg) {
        if (state.stop) return;
        Game.netGuestStopReconnect();
        Game.netLog('guest:giveup', msg || '');
        try { Game.netLeave(); } catch (e) {}
        Game.netShowNotice('连接已断开', msg || '重连失败，座位已由 AI 接管。', [{ text: '知道了', onClick: function () { location.reload(); } }]);
    }
    (function attempt() {
        if (state.stop) return;
        if (Date.now() > state.deadline) { giveUp('长时间无法连回房主，座位已由 AI 接管。'); return; }
        state.tries++;
        showBanner('连接中断，正在重连…（第 ' + state.tries + ' 次）');
        Game.netJoinRoom(info.code, info.name, { token: info.token, resume: true }).then(function (r) {
            if (state.stop) { if (r.ok && Game.net && Game.net.peer !== info.old.peer) { try { Game.net.peer.destroy(); } catch (e) {} } return; }
            if (r.ok && r.welcome.seat === info.seat) {
                try { info.old.peer.destroy(); } catch (e) {}
                rc = null; hideBanner(); startWatchdog();
                Game.netLog('guest:resumed');
                if (Game.netToastUI) Game.netToastUI('已重新连上');
                return;
            }
            if (r.ok) { giveUp('座位已变化，请重新加入。'); return; }
            if (r.fatal) { giveUp(r.err); return; }
            state.timer = setTimeout(attempt, 2500);
        });
    })();
};

Game.netGuestCleanup = function () {
    try { var ab = Game.$('btn-toggle-adjust'); if (ab) ab.style.display = ''; } catch (e) {}
    Game.netPrompt = null;
    try { Game.netGuestStopReconnect(); Game.netCountdownHide(); } catch (e) {}
    Game.netClaimIntent = Game._netHostClaimIntent || null; // 还给房主版本，别置空
    Game.netGuestTurnIntent = null;
    Game.netNameOf = null; Game.netAnimalOf = null;
    if (Game._netOrig) {
        Game.baseNames = Game._netOrig.baseNames; Game.statAvatar = Game._netOrig.statAvatar;
        Game._netOrig = null; Game._netBaseRemapped = false;
        ['top', 'left', 'right', 'bottom'].forEach(function (v) {
            try { var img = document.querySelector('#p-' + v + ' .avatar img'); if (img) img.src = 'avatars/avatar-' + v + '.webp'; } catch (e) {}
        });
    }
};

/** 发意图给房主（自动带 prompt id） */
Game.netSendIntent = function (intent) {
    var pr = Game.netPrompt;
    if (!pr) return false;
    return Game.netSendHost(Object.assign({ t: 'intent', id: pr.id }, intent));
};

/** 清掉当前 prompt 的 UI */
Game.netClearPrompt = function () {
    Game.netPrompt = null;
    try { Game.netCountdownHide(); } catch (e) {}
    Game.pendingClaim = null;
    try {
        Game.hideIndicator();
        var m = Game.$('chi-choice-modal'); if (m) m.classList.remove('show');
    } catch (e) {}
};

function onPrompt(p) {
    Game.netPrompt = p;
    try { if (p.ms) Game.netCountdownShow(p.ms, p.kind === 'turn' ? '请出牌 ' : '请选择 '); } catch (e) {}
    try {
        if (p.kind === 'turn') {
            Game.setPhase(Game.PHASE.WAIT_DISCARD, 'netGuest/turn');
            Game.pendingClaim = null;
            Game.selectedIndex = null;
            if (p.gangs && p.gangs.length) {
                Game.pendingClaim = { mode: 'selfGang', gangs: p.gangs, netTurn: true };
                Game.showIndicator('杠', true);
                Game.logFlow('你的回合：可点 杠，或直接点牌打出');
            } else {
                Game.logFlow('轮到你出牌，点一张牌（点两下确认）');
            }
            Game.requestRender('netGuest/turn');
        } else if (p.kind === 'claim') {
            Game.pendingClaim = {
                tile: p.tile, fromPlayer: p.from,
                canPeng: !!p.opts.peng, canGang: !!p.opts.gang,
                chiCombos: p.opts.chi || [], mode: 'claim', netClaim: true
            };
            var options = [p.opts.gang ? '杠' : null, p.opts.peng ? '碰' : null,
                (p.opts.chi && p.opts.chi.length) ? '吃' : null].filter(Boolean).join('/');
            Game.setPhase(Game.PHASE.CLAIM_PROMPT, 'netGuest/claim');
            Game.showIndicator(options, true);
            Game.logFlow('可以' + options + '，点确认执行 / 点过');
            Game.requestRender('netGuest/claim');
        } else if (p.kind === 'reveal') {
            Game.pendingClaim = { mode: 'reveal', netReveal: true, revealKind: p.revealKind };
            Game.setPhase(Game.PHASE.REVEAL_PROMPT, 'netGuest/reveal');
            Game.showIndicator('亮牌', true);
            Game.logFlow('是否亮出' + (p.revealKind === 'winds' ? '东南西北' : '中发白') + '？点确认亮牌 / 点过');
            Game.requestRender('netGuest/reveal');
        }
    } catch (e) {}
}

/** 结算消息 → 复用单机结算弹窗（座位转成 view） */
function onResult(d) {
    try {
        Game.netClearPrompt();
        if (d.draw) {
            Game.gameOver = true;
            Game.logFlow('[联机] ' + (d.detail || '流局'));
            Game.requestRender('netGuest/draw');
            try { Game.feel.banner('流局'); } catch (e) {} // 不用阻塞式 alert
            Game.netSendHost({ t: 'ready', epoch: Game.gameEpoch });
            return;
        }
        var w = viewOf(d.winner);
        var payer = d.payer ? viewOf(d.payer) : null;
        Game.gameOver = true;
        Game.winner = w;
        Game.requestRender('netGuest/result');
        // 结算 payouts 按 canonical 键下发，转成 view 键再进弹窗（09 内部按 view 座位读）
        if (d.result && d.result.payouts) {
            var vp = {};
            SEATS.forEach(function (c) { vp[viewOf(c)] = d.result.payouts[c]; });
            d.result.payouts = vp;
            if (d.result.noKaimenPlayers) d.result.noKaimenPlayers = d.result.noKaimenPlayers.map(viewOf);
        }
        // detail 里的"XX 点炮"是房主视角的座位名，按客人视角重写
        try {
            if (d.mode === 'dianpao' && payer && d.result && typeof d.result.detail === 'string') {
                var ix = d.result.detail.indexOf(' 点炮');
                if (ix > 0) d.result.detail = Game.nameOf(payer) + d.result.detail.slice(ix);
            }
        } catch (e3) {}
        Game.showResultModal(w, d.mode, payer, d.bonus, d.result, d.tile);
        try { var ab = Game.$('btn-toggle-adjust'); if (ab) ab.style.display = 'none'; } catch (e2) {} // 客人不能手动调分，分数以房主为准
    } catch (e) {}
}

/** 出牌钩子（13-handleDiscard）：第二下确认时改发 intent */
function guestTurnIntent(card) {
    if (!Game.net || Game.net.role !== 'guest') return false;
    var pr = Game.netPrompt;
    if (!pr || pr.kind !== 'turn') return false;
    if (!Game.netSendIntent({ kind: 'discard', tile: card })) {
        try { Game.logFlow('[联机] 发送失败，请再点一次确认出牌'); } catch (e) {}
        return true; // 保留 prompt，不吞掉这次出牌
    }
    Game.netClearPrompt();
    Game.setPhase(Game.PHASE.WAIT_DISCARD, 'netGuest/sent');
    try { Game.logFlow('已打出 ' + Game.tileGlyph(card) + '，等房主同步'); } catch (e) {}
    return true;
}

/** 吃碰杠/亮牌钩子（13-acceptClaim/declineClaim/chooseChiCombo）：只发意图 */
function guestClaimIntent(action, i) {
    if (!Game.net || Game.net.role !== 'guest') return false;
    var pr = Game.netPrompt;
    if (!pr) return false;
    var intent = null;
    if (pr.kind === 'claim') {
        var o = pr.opts || {};
        var pc = { canGang: !!o.gang, canPeng: !!o.peng, chiCombos: o.chi || [] }; // 用 prompt 自带数据，不依赖易被清掉的 pendingClaim
        if (action === 'pass') intent = { kind: 'claim', choice: 'pass' };
        else if (action === 'accept') {
            if (pc.canGang) intent = { kind: 'claim', choice: 'gang' };
            else if (pc.canPeng) intent = { kind: 'claim', choice: 'peng' };
            else if (pc.chiCombos && pc.chiCombos.length === 1) intent = { kind: 'claim', choice: 'chi', combo: 0 };
            else return false; // 多种吃法：走现有弹窗，chooseChiCombo 再发
        } else if (action === 'chi' && i != null) intent = { kind: 'claim', choice: 'chi', combo: i };
    } else if (pr.kind === 'turn' && action === 'accept') {
        var g = (pr.gangs && pr.gangs[0]) || null;
        if (!g) return false;
        intent = { kind: 'selfgang', tile: g.tile, gangKind: g.kind };
    } else if (pr.kind === 'reveal') {
        intent = { kind: 'reveal', accept: action === 'accept' };
    }
    if (!intent) return false;
    if (!Game.netSendIntent(intent)) { try { Game.logFlow('[联机] 发送失败，请重试'); } catch (e) {} return true; }
    Game.netClearPrompt();
    try { Game.logFlow('已发送，等房主裁决'); } catch (e) {}
    return true;
}

;})();
