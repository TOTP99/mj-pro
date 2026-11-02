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

// ---------- 房主消息校验（客人不信任线上数据：房主可能是改过的客户端，或数据在途中损坏） ----------
var SEAT_SET = { top: 1, left: 1, right: 1, bottom: 1 };
var MELD_TYPES = { chi: 1, peng: 1, gang: 1, dragons: 1, winds: 1 };
var hasOwnP = Object.prototype.hasOwnProperty;
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function isSeatId(x) { return typeof x === 'string' && hasOwnP.call(SEAT_SET, x); }
function isInt(x, lo, hi) { return typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi; }
function isNum(x, lim) { return typeof x === 'number' && isFinite(x) && Math.abs(x) <= lim; }
function tileOk(t) { return Game.netValidTile(t); }
function tilesOk(a, max) { return Array.isArray(a) && a.length <= max && a.every(tileOk); }

/** 校验并规范化一个副露组；非法返回 null（只保留已知字段） */
function cleanMeld(m) {
    if (!isObj(m) || typeof m.type !== 'string' || !hasOwnP.call(MELD_TYPES, m.type)) return null;
    if (!tilesOk(m.tiles, 4) || m.tiles.length < 3) return null;
    var out = { type: m.type, tiles: m.tiles.slice() };
    if (m.concealed === true) out.concealed = true;
    return out;
}

/**
 * 校验房主快照，返回「规范化后的新对象」；任何一项不合法返回 null（整份丢弃，不应用半份）。
 * 只做结构/范围/牌种/张数上限检查——不要求总牌数=136（客人看不到别家暗牌，且房主有过渡态快照）。
 */
function validateSnapshot(snap, my) {
    if (!isObj(snap)) return null;
    if (snap.seq !== undefined && !isInt(snap.seq, 0, 1e9)) return null;
    if (!isInt(snap.epoch, 0, 1e9)) return null;
    if (!isSeatId(snap.currentPlayer) || !isSeatId(snap.dealer)) return null;
    if (!isInt(snap.deckCount, 0, 136)) return null;
    if (!isObj(snap.handCounts) || !isObj(snap.melds) || !isObj(snap.scores)) return null;
    var out = { seq: snap.seq, epoch: snap.epoch, currentPlayer: snap.currentPlayer, dealer: snap.dealer, deckCount: snap.deckCount,
        handCounts: {}, melds: {}, scores: {}, names: {}, discards: [], hand: null, allHands: null, drawnIdx: null };
    var i, c;
    for (i = 0; i < SEATS.length; i++) {
        c = SEATS[i];
        if (!isInt(snap.handCounts[c], 0, 14)) return null;
        out.handCounts[c] = snap.handCounts[c];
        if (!Array.isArray(snap.melds[c]) || snap.melds[c].length > 4) return null;
        out.melds[c] = [];
        for (var k = 0; k < snap.melds[c].length; k++) {
            var cm = cleanMeld(snap.melds[c][k]);
            if (!cm) return null;
            out.melds[c].push(cm);
        }
        if (!isNum(snap.scores[c], 1e9)) return null;
        out.scores[c] = snap.scores[c];
        var nm = isObj(snap.names) ? snap.names[c] : '';
        out.names[c] = (typeof nm === 'string' && nm) ? Game.netCleanName(nm, '') : '';
    }
    if (!Array.isArray(snap.discards) || snap.discards.length > 136) return null;
    for (i = 0; i < snap.discards.length; i++) {
        var d = snap.discards[i];
        if (!isObj(d) || !tileOk(d.tile)) return null;
        if (d.player != null && !isSeatId(d.player)) return null;
        out.discards.push({ tile: d.tile, player: d.player || undefined });
    }
    if (snap.hand != null) {
        if (!tilesOk(snap.hand, 14) || snap.hand.length !== out.handCounts[my]) return null;
        out.hand = snap.hand.slice();
    }
    if (snap.allHands != null) {
        if (!isObj(snap.allHands)) return null;
        out.allHands = {};
        for (i = 0; i < SEATS.length; i++) {
            c = SEATS[i];
            if (!tilesOk(snap.allHands[c], 14) || snap.allHands[c].length !== out.handCounts[c]) return null;
            out.allHands[c] = snap.allHands[c].slice();
        }
    }
    if (snap.drawnIdx != null) {
        // 房主用 lastIndexOf 求下标：刚摸的牌已不在手里（碰/吃之后）时是 -1，意思是「没有刚摸的牌」，不是坏数据
        if (!isInt(snap.drawnIdx, -1, 13)) return null;
        out.drawnIdx = snap.drawnIdx >= 0 ? snap.drawnIdx : null;
        if (out.drawnIdx != null && out.hand && out.drawnIdx >= out.hand.length) return null;
    }
    // 全桌牌张合计：同一种牌（可见部分）不得超过 4 张，牌码必须合法
    var groups = [], pile = out.discards.map(function (x) { return x.tile; });
    groups.push(pile);
    for (i = 0; i < SEATS.length; i++) {
        c = SEATS[i];
        out.melds[c].forEach(function (m) { groups.push(m.tiles); });
    }
    if (out.allHands) { for (i = 0; i < SEATS.length; i++) groups.push(out.allHands[SEATS[i]]); }
    else if (out.hand) groups.push(out.hand);
    var seen = {};
    for (i = 0; i < groups.length; i++) {
        for (var j = 0; j < groups[i].length; j++) {
            var tc = groups[i][j];
            seen[tc] = (seen[tc] || 0) + 1;
            if (seen[tc] > 4) return null;
        }
    }
    if (snap.winner != null && !isSeatId(snap.winner)) return null;
    out.winner = snap.winner || null;
    out.gameOver = snap.gameOver === true;
    out.started = snap.started === true;
    out.fieldActive = snap.fieldActive === true;
    if (snap.fieldCount !== undefined) {
        if (!isInt(snap.fieldCount, 0, 1e6)) return null;
        out.fieldCount = snap.fieldCount;
    }
    return out;
}
Game.netValidateSnapshot = validateSnapshot;

/** 应用房主快照（canonical → view 重映射后喂给渲染）。
 *  先整体校验、整体构建，最后一次性提交：任何一步失败，本机状态原样保留（不会出现「更新了一半」）。 */
Game.netGuestApplyState = function (snap) {
    if (!Game.net || Game.net.role !== 'guest') return false;
    var my = mySeat();
    var v = validateSnapshot(snap, my);
    if (!v) { // 异常快照：丢弃、留诊断；seq 也不推进（否则一个伪造的大 seq 会让之后所有真快照被当成过期）
        Game.netLog('guest:bad-snapshot');
        return false;
    }
    if (typeof v.seq === 'number') { // 乱序/过期快照直接丢弃
        if (v.seq <= Game.net.seq) return false;
    }
    var nx;
    try { // ---- 构建阶段：只读 + 纯计算，不碰任何全局状态 ----
        nx = { hands: {}, melds: {}, scores: {}, drawnTile: { top: null, left: null, right: null, bottom: null } };
        SEATS.forEach(function (c) {
            var vw = viewOf(c);
            nx.hands[vw] = (c === my) ? (v.hand || [])
                : (v.allHands && v.allHands[c]) ? v.allHands[c] // 结算摊牌
                : new Array(v.handCounts[c]).fill('x');
            nx.melds[vw] = v.melds[c];
            nx.scores[vw] = v.scores[c];
        });
        nx.discards = v.discards.map(function (d) { return { tile: d.tile, player: d.player ? viewOf(d.player) : undefined }; });
        nx.deck = new Array(v.deckCount).fill('x');
        nx.dealer = viewOf(v.dealer);
        nx.currentIndex = Game.turnOrder.indexOf(viewOf(v.currentPlayer));
        nx.winner = v.winner ? viewOf(v.winner) : null;
        nx.drawnIdx = (v.drawnIdx != null && v.drawnIdx < nx.hands.bottom.length) ? v.drawnIdx : null;
        if (nx.drawnIdx != null) nx.drawnTile.bottom = nx.hands.bottom[nx.drawnIdx];
        if (nx.currentIndex < 0 || nx.dealer == null) throw new Error('bad-seat-map');
    } catch (e) { Game.netLog('guest:bad-snapshot', 'build'); return false; }

    // ---- 提交阶段：纯赋值，不会抛错 ----
    if (typeof v.seq === 'number') Game.net.seq = v.seq;
    Game.gameEpoch = v.epoch;
    Game.hands = nx.hands;
    Game.exposedMelds = nx.melds;
    Game.discardPile = nx.discards;
    Game.deck = nx.deck;
    Game.scores = nx.scores;
    Game.dealer = nx.dealer;
    Game.currentIndex = nx.currentIndex;
    Game.gameOver = v.gameOver;
    Game.winner = nx.winner;
    // 有待回应的 prompt 时保留 UI 状态：防抖快照晚于 prompt 到达会把要约清掉
    if (!Game.netPrompt) Game.selectedIndex = null;
    else if (Game.selectedIndex != null && !Game.hands.bottom[Game.selectedIndex]) Game.selectedIndex = null;
    Game.lastDrawnIndex = nx.drawnIdx;
    Game.lastDrawnTile = nx.drawnTile;
    if (!Game.netPrompt) Game.pendingClaim = null;
    Game.netNames = v.names;
    // 开局标志：优先用快照 started；兼容旧房主仅靠手牌/牌墙推断（房间面板据此显示"对局进行中"）
    if (v.started || (v.hand && v.hand.length) || v.gameOver) Game.net.started = true;
    var hasHand = !!(v.hand && v.hand.length);
    try {
        if (typeof v.fieldCount === 'number') { // 局/风/圈 以房主为准，不读客人本机的单机数据
            Game.fieldGameCount = v.fieldCount;
            Game.fieldActive = v.fieldActive;
            try { if (typeof Game.renderFieldAmounts === 'function') Game.renderFieldAmounts(); } catch (e2) {}
        }
        // 新局开始（非结束态）：收起上一局残留的结算弹窗；开局后关掉等待大厅
        if (!v.gameOver) {
            try { var rm = Game.$('result-modal'); if (rm && rm.classList.contains('show')) rm.classList.remove('show'); } catch (e) {}
            Game.lastSettlement = null;
        }
        try { if (Game.netLobbyIsOpen && Game.netLobbyIsOpen() && hasHand) Game.netLobbyClose(); } catch (e) {}
        if (hasHand) { // 开局后收起本机残留的模式/筹码/规则弹窗（客人不设置这些）
            try { ['mode-select-modal', 'amount-modal', 'rules-modal'].forEach(function (id) { var m = Game.$(id); if (m) m.classList.remove('show'); }); if (Game.clearSelectGlow) Game.clearSelectGlow(); } catch (e) {}
        }
        // 客人本机启动时残留的"请选择模式/筹码"桌面提示：对局开始后清掉
        try {
            var tp = Game.$('table-center-prompt');
            if (tp && tp.classList.contains('show') && hasHand && /^请选择/.test(tp.textContent)) tp.classList.remove('show');
        } catch (e) {}
        Game.requestRender('netGuest/state');
        try { Game.netRefreshAvatarBadges(); } catch (e) {}
    } catch (e) { /* UI 副作用异常不炸：状态已完整提交，下一帧会再来 */ }
    return true;
};

/** 收到房主消息总入口 */
Game.netGuestOnMsg = function (d) {
    if (!Game.net || Game.net.role !== 'guest') return;
    if (d.t === 'state') Game.netGuestApplyState(d.snap);
    else if (d.t === 'prompt') onPrompt(d);
    else if (d.t === 'seats') { Game.net.seats = Game.netSanitizeSeats(d.seats); if (typeof Game.netLobbyRender === 'function') Game.netLobbyRender(); try { Game.netRefreshAvatarBadges(); } catch (e) {} }
    else if (d.t === 'toast') { if (typeof d.text !== 'string') return; var tx = d.text.slice(0, 120); try { Game.logFlow('[联机] ' + tx); if (Game.netToastUI) Game.netToastUI(tx.slice(0, 60)); } catch (e) {} }
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
var promptExpiryTimer = 0;
Game.netClearPrompt = function () {
    Game.netPrompt = null;
    if (promptExpiryTimer) { clearTimeout(promptExpiryTimer); promptExpiryTimer = 0; }
    try { Game.netCountdownHide(); } catch (e) {}
    Game.pendingClaim = null;
    try {
        Game.hideIndicator();
        var m = Game.$('chi-choice-modal'); if (m) m.classList.remove('show');
    } catch (e) {}
};

/** 校验并规范化房主要约；非法返回 null（不弹任何 UI） */
function cleanPrompt(p) {
    if (!isObj(p) || typeof p.id !== 'string' || !p.id || p.id.length > 24) return null;
    var ms = (p.ms === undefined || p.ms === null) ? 0 : p.ms;
    if (!isNum(ms, 10 * 60 * 1000) || ms < 0) return null;
    var out = { id: p.id, kind: p.kind, ms: ms };
    var i;
    if (p.kind === 'turn') {
        var gangs = p.gangs === undefined ? [] : p.gangs;
        if (!Array.isArray(gangs) || gangs.length > 8) return null;
        out.gangs = [];
        for (i = 0; i < gangs.length; i++) {
            var g = gangs[i];
            if (!isObj(g) || !tileOk(g.tile) || !(g.kind === 'an' || g.kind === 'jia')) return null;
            out.gangs.push({ tile: g.tile, kind: g.kind });
        }
    } else if (p.kind === 'claim') {
        if (!tileOk(p.tile) || !isObj(p.opts) || !isSeatId(p.from)) return null;
        var chi = p.opts.chi === undefined ? [] : p.opts.chi;
        if (!Array.isArray(chi) || chi.length > 3) return null;
        out.tile = p.tile;
        out.from = p.from;
        out.opts = { peng: p.opts.peng === true, gang: p.opts.gang === true, chi: [] };
        for (i = 0; i < chi.length; i++) {
            if (!tilesOk(chi[i], 2) || chi[i].length !== 2) return null;
            out.opts.chi.push(chi[i].slice());
        }
        if (!out.opts.peng && !out.opts.gang && !out.opts.chi.length) return null; // 没有任何可选项的要约没有意义
    } else if (p.kind === 'reveal') {
        if (p.revealKind !== 'winds' && p.revealKind !== 'dragons') return null;
        out.revealKind = p.revealKind;
    } else return null;
    return out;
}
Game.netCleanPrompt = cleanPrompt;

function onPrompt(raw) {
    var p = cleanPrompt(raw);
    if (!p) { Game.netLog('guest:bad-prompt'); return; }
    if (Game.netPrompt && Game.netPrompt.id === p.id) return; // 同一要约重复到达（重连补发/重复消息）：幂等，不重复弹 UI
    Game.netPrompt = p;
    // 过期保护：房主超时后已按「过/AI 代打」处理，这里到点收起 UI，避免对已作废的要约点击后无人响应
    if (promptExpiryTimer) clearTimeout(promptExpiryTimer);
    promptExpiryTimer = 0;
    if (p.ms) {
        promptExpiryTimer = setTimeout(function () {
            promptExpiryTimer = 0;
            if (Game.netPrompt === p) Game.netClearPrompt();
        }, p.ms + 1500);
    }
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

/** 校验并规范化结算消息；非法返回 null。所有进入弹窗 innerHTML 的字段都在这里收窄成数字/白名单/限长字符串。 */
function cleanResult(d) {
    if (!isObj(d)) return null;
    var epoch = (d.epoch === undefined) ? Game.gameEpoch : d.epoch;
    if (!isInt(epoch, 0, 1e9)) return null;
    var detail = (typeof d.detail === 'string') ? d.detail.slice(0, 200) : '';
    if (d.draw === true) return { draw: true, epoch: epoch, detail: detail };
    if (!isSeatId(d.winner) || !(d.mode === 'selfdraw' || d.mode === 'dianpao')) return null;
    if (d.mode === 'dianpao' && !isSeatId(d.payer)) return null;
    if (!tileOk(d.tile)) return null;
    var r = d.result;
    if (!isObj(r) || !isObj(r.payouts) || !Array.isArray(r.tags) || r.tags.length > 16) return null;
    var out = { epoch: epoch, winner: d.winner, mode: d.mode, payer: d.mode === 'dianpao' ? d.payer : null, tile: d.tile,
        result: { payouts: {}, tags: [], total: 0, noKaimenPlayers: [], detail: detail } };
    for (var i = 0; i < SEATS.length; i++) {
        if (!isNum(r.payouts[SEATS[i]], 1e9)) return null;
        out.result.payouts[SEATS[i]] = r.payouts[SEATS[i]];
    }
    for (i = 0; i < r.tags.length; i++) {
        if (typeof r.tags[i] !== 'string' || r.tags[i].length > 40) return null;
        out.result.tags.push(r.tags[i]);
    }
    out.result.total = isNum(r.total, 1e9) ? r.total : 0;
    if (Array.isArray(r.noKaimenPlayers)) {
        r.noKaimenPlayers.forEach(function (x) { if (isSeatId(x) && out.result.noKaimenPlayers.indexOf(x) < 0) out.result.noKaimenPlayers.push(x); });
    }
    out.bonus = { mult: (d.bonus && isNum(d.bonus.mult, 1e9)) ? d.bonus.mult : 1, tags: out.result.tags.slice() };
    return out;
}
Game.netCleanResult = cleanResult;

/** 结算消息 → 复用单机结算弹窗（座位转成 view） */
function onResult(raw) {
    var d = cleanResult(raw);
    if (!d) { Game.netLog('guest:bad-result'); return; }
    if (Game.net._resultEpoch === d.epoch) return; // 同一局的结算重复到达（重连补发等）：幂等，只处理一次
    Game.net._resultEpoch = d.epoch;
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
        var vp = {};
        SEATS.forEach(function (c) { vp[viewOf(c)] = d.result.payouts[c]; });
        d.result.payouts = vp;
        d.result.noKaimenPlayers = d.result.noKaimenPlayers.map(viewOf);
        // detail 里的"XX 点炮"是房主视角的座位名，按客人视角重写
        try {
            if (d.mode === 'dianpao' && payer && typeof d.result.detail === 'string') {
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
