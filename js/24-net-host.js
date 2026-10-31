;(function(){
'use strict';
// ---------- 联机房主（24-net-host.js）：跑全引擎，统一裁决，广播快照 ----------
// 单机流程零改动：所有钩子平时不存在（undefined），仅房主建房后才赋值生效。

var SEATS = ['top', 'left', 'right', 'bottom'];

function isHost() { return Game.netIsHost(); }
function seatMeta(seat) {
    if (!Game.net) return null;
    for (var i = 0; i < Game.net.seats.length; i++) if (Game.net.seats[i].seat === seat) return Game.net.seats[i];
    return null;
}
function isRemoteHuman(seat) {
    var m = seatMeta(seat);
    return !!(m && m.kind === 'human' && !m.auto && seat !== 'bottom' && Game.net.conns[seat]);
}
/** 由 AI 逻辑代打的座位：AI、已掉线、托管中的真人 */
function isAiLike(seat) {
    var m = seatMeta(seat);
    return !m || m.kind === 'ai' || !!m.auto || (seat !== 'bottom' && !Game.net.conns[seat]);
}
function turnOrderFrom(discarder) {
    var t = Game.turnOrder, i = t.indexOf(discarder);
    return [t[(i + 1) % 4], t[(i + 2) % 4], t[(i + 3) % 4]];
}
function seatName(s) { return Game.netWinds[s] + ' ' + Game.netAnimals[s]; }

/** 房主开局初始化：补齐 AI 座位、包渲染广播、关存档 */
Game.netHostInit = function () {
    Game.net.started = true;
    Game.netNoSave = true; // 联机局不写单机存档/场次
    // 空座位填 AI
    var taken = {};
    Game.net.seats.forEach(function (s) { taken[s.seat] = true; });
    SEATS.forEach(function (s) {
        if (!taken[s]) Game.net.seats.push({ seat: s, kind: 'ai', name: '' });
    });
    // 渲染即广播（防抖 400ms，兜底不断流）
    if (!Game._netRenderWrapped) {
        Game._netRenderWrapped = true;
        var _rr = Game.requestRender, _t = 0;
        Game.requestRender = function (reason) {
            _rr(reason);
            if (isHost()) {
                try { Game.netRefreshAvatarBadges(); } catch (e) {}
                if (_t) clearTimeout(_t);
                _t = setTimeout(function () { _t = 0; Game.netBroadcastState(false); }, 400);
            }
        };
        var _dd = Game.declareDraw;
        Game.declareDraw = function () {
            _dd();
            if (isHost()) {
                Game.netBroadcastState(true);
                Game.netBroadcast({ t: 'result', draw: true, detail: '牌墙已尽，流局' });
            }
        };
    }
    Game.netBroadcastSeats();
};

function restoreSaves() { Game.netNoSave = false; }
Game.netHostRestore = restoreSaves;

/** 给所有客人广播座位表 */
Game.netBroadcastSeats = function () {
    if (!isHost()) return;
    Game.netBroadcast({ t: 'seats', seats: Game.netPublicSeats() });
    if (typeof Game.netLobbyRender === 'function') Game.netLobbyRender();
    try { Game.netRefreshAvatarBadges(); } catch (e) {}
};

/** 构造给某客人的快照（只含他自己的手牌） */
function buildSnapshot(forSeat) {
    var snap = {
        v: 2, seq: ++Game.net.seq, epoch: Game.gameEpoch,
        currentPlayer: Game.turnOrder[Game.currentIndex],
        dealer: Game.dealer,
        deckCount: (Game.deck || []).length,
        discards: (Game.discardPile || []).map(function (d) { return { tile: d.tile, player: d.player }; }),
        handCounts: {}, melds: {}, scores: {}, names: {},
        hand: null, drawnIdx: null,
        gameOver: !!Game.gameOver, winner: Game.winner || null,
        fieldActive: !!Game.fieldActive,
        fieldCount: Game.fieldGameCount || 0,
        started: !!Game.net.started
    };
    SEATS.forEach(function (s) {
        snap.handCounts[s] = ((Game.hands && Game.hands[s]) || []).length;
        snap.melds[s] = (Game.exposedMelds && Game.exposedMelds[s]) || [];
        snap.scores[s] = (Game.scores || {})[s];
        var m = seatMeta(s);
        snap.names[s] = m ? (m.name || '') : '';
    });
    if (Game.gameOver && Game.hands) { // 一局结束：所有人的牌公开（结算页要摊牌）
        snap.allHands = {};
        SEATS.forEach(function (s) { snap.allHands[s] = (Game.hands[s] || []).slice(); });
    }
    if (forSeat && Game.hands && Game.hands[forSeat]) {
        snap.hand = Game.hands[forSeat].slice();
        var lt = Game.lastDrawnTile && Game.lastDrawnTile[forSeat];
        snap.drawnIdx = (lt != null && snap.hand.length % 3 === 2) ? snap.hand.lastIndexOf(lt) : null;
    }
    return snap;
}

/** 广播状态快照；immediate=true 立刻发（prompt 之前先 flush） */
Game.netBroadcastState = function (immediate) {
    if (!isHost()) return;
    Object.keys(Game.net.conns).forEach(function (seat) {
        try { Game.net.conns[seat].send({ t: 'state', snap: buildSnapshot(seat) }); } catch (e) {}
    });
};

/** 新客人中途加入：同步当前状态 */
Game.netHostSyncGuest = function (seat, resumed) {
    try { Game.net.conns[seat].send({ t: 'state', snap: buildSnapshot(seat) }); } catch (e) {}
    if (!resumed) Game.netToast(seatName(seat) + ' 加入对局（当前对局继续）');
    else Game.netHostResendPrompt(seat);
};

/** 断线重连后：若房主正在等这个座位，补发当前要约（剩余时间），否则重连者要干等到超时 */
Game.netHostResendPrompt = function (seat) {
    var now = Date.now();
    Object.keys(_awaits).forEach(function (id) {
        var a = _awaits[id];
        if (a.seat !== seat) return;
        var left = a.deadline - now;
        if (left < 1500) return;
        Game.netSendTo(seat, Object.assign({ t: 'prompt', id: id, ms: left }, a.msg));
        Game.netLog('host:resend-prompt', seat + ' ' + a.msg.kind);
    });
};

/** 房主锁房/解锁：锁房后不收新人（令牌重连不受影响） */
Game.netSetLocked = function (on) {
    if (!isHost()) return;
    Game.net.locked = !!on;
    Game.netLog('host:lock', !!on);
    if (typeof Game.netLobbyRender === 'function') Game.netLobbyRender();
};

/** 客人掉线：座位转 AI；若正等他，做 AI 兜底 */
Game.netHostSeatToAI = function (seat) {
    var m = seatMeta(seat);
    if (m) m.kind = 'ai';
    // 若有未完成的 await，直接按超时走 AI 兜底
    Object.keys(_awaits).forEach(function (id) {
        if (_awaits[id].seat === seat) { var r = _awaits[id].resolve; delete _awaits[id]; r({ timeout: true, aiFallback: true }); }
    });
    Game.netBroadcastSeats();
    Game.netBroadcastState(true);
};

// ---------- 等待远端意图 ----------
var _awaits = Object.create(null); // 无原型：id 取 "constructor"/"__proto__" 等不会命中原型属性
var _promptSeq = 0;
Game.netOffers = {}; // seat -> 当前有效的 claim/reveal/turn offer（校验用）

/** 连续超时 2 次 → 托管（AI 代打），玩家点"恢复"才回来；避免挂机卡全桌 */
function noteTimeout(seat) {
    var m = seatMeta(seat);
    if (!m || m.kind !== 'human') return;
    m.timeouts = (m.timeouts || 0) + 1;
    Game.netLog('host:timeout', seat + ' x' + m.timeouts);
    if (m.timeouts >= 2 && !m.auto) {
        m.auto = true;
        Game.netToast(seatName(seat) + ' 连续超时，已托管（AI 代打）');
        Game.netSendTo(seat, { t: 'auto', on: true });
        Game.netBroadcastSeats();
    }
}
function awaitIntent(seat, msg, timeoutMs) {
    return new Promise(function (resolve) {
        var epoch = Game.gameEpoch;
        var id = 'p' + (++_promptSeq);
        Game.netSendTo(seat, Object.assign({ t: 'prompt', id: id, ms: timeoutMs }, msg));
        var timer = setTimeout(function () {
            delete _awaits[id]; delete Game.netOffers[seat];
            // 吃碰杠要约超时＝默认"过"，不算挂机（否则不想吃碰又没点过的人会被误托管）
            if (msg.kind !== 'claim') noteTimeout(seat);
            resolve({ timeout: true });
        }, timeoutMs);
        _awaits[id] = {
            seat: seat,
            msg: msg,
            deadline: Date.now() + timeoutMs,
            resolve: function (r) {
                clearTimeout(timer); delete _awaits[id]; delete Game.netOffers[seat];
                if (Game.gameEpoch !== epoch) resolve({ epochChanged: true });
                else resolve(r);
            }
        };
    });
}

/** 客人消息路由（intent / bye） */
Game.netHostOnGuestMsg = function (conn, d) {
    if (!isHost()) return;
    var seat = null;
    Object.keys(Game.net.conns).forEach(function (s) { if (Game.net.conns[s] === conn) seat = s; });
    if (!seat) return;
    Game.net.lastSeen[seat] = Date.now();
    var m = seatMeta(seat);
    if (d.t === 'bye') { hostDropSeatBye(seat); return; }
    if (d.t === 'ready') { Game.net.ready[seat] = Game.gameEpoch; return; }
    if (d.t === 'resume') { // 取消托管
        if (m && m.auto) { m.auto = false; m.timeouts = 0; Game.netToast(seatName(seat) + ' 回来了'); Game.netBroadcastSeats(); }
        return;
    }
    if (d.t !== 'intent' || !d.id || !_awaits[d.id]) return;
    if (_awaits[d.id].seat !== seat) return; // 不是等他，别人的 id 不能用
    if (m) m.timeouts = 0;
    _awaits[d.id].resolve({ intent: d });
};
function hostDropSeatBye(seat) {
    // 23-net.js 的 hostDropSeat 在作用域外？它是 IIFE 内部函数——通过 Game 暴露
    if (typeof Game.netHostDropSeat === 'function') Game.netHostDropSeat(seat, 'bye', false);
}

// ---------- 下一局门闩：等真人客人看完结算（ready）或超时 ----------
Game.netHostStartGate = function (proceed) {
    if (!isHost()) return false;
    if (Game.netGetPhase() !== 'settling') return false; // 只在结算阶段有门闩
    if (!Game.net.started || !Game.gameOver) return false;
    if (Game.net._gate) return true; // 已在等，忽略重复点击
    function pending() { return SEATS.filter(function (s) { return isRemoteHuman(s) && Game.net.ready[s] !== Game.gameEpoch; }); }
    var first = pending();
    if (!first.length) return false;
    Game.net._gate = true;
    var names = first.map(function (s) { return Game.netWinds[s] + Game.netAnimals[s]; }).join('、');
    Game.logFlow('[联机] 等待 ' + names + ' 确认结算…');
    try { if (Game.netToastUI) Game.netToastUI('等待 ' + names + ' 确认结算…'); } catch (e) {}
    var t0 = Date.now();
    var iv = setInterval(function () {
        if (!Game.net || !isHost()) { clearInterval(iv); return; }
        if (!pending().length || Date.now() - t0 > Game.netTimeouts.ready) {
            clearInterval(iv); Game.net._gate = false; proceed();
        }
    }, 200);
    return true;
};

// ---------- 钩子：座位决策调度（08 continueAfterFirstTurnCheck 的 else 分支） ----------
Game.netOnSeatTurn = function (player) {
    if (!isHost()) return false;
    if (!isRemoteHuman(player)) return false;
    hostAwaitTurn(player);
    return true;
};

// ---------- 钩子：远端亮牌（08 nextTurn 的 reveal 分支） ----------
Game.netRevealRemote = function (player, kind) {
    if (!isHost()) return false;
    if (!isRemoteHuman(player)) return false;
    (async function () {
        var epoch = Game.gameEpoch;
        Game.netOffers[player] = { kind: 'reveal', revealKind: kind };
        var r = await awaitIntent(player, { kind: 'reveal', revealKind: kind }, Game.netTimeouts.reveal);
        if (Game.gameEpoch !== epoch || Game.gameOver) return;
        var accept = r.intent && r.intent.kind === 'reveal' && r.intent.accept;
        if (accept) {
            var ok = Game.applyReveal(player, kind);
            Game.netBroadcastState(true);
            // 无补牌位时 applyReveal 不动牌、不流局：继续该座位回合（等出牌）
            if (!ok && Game.gameOver) return;
        }
        Game.continueAfterFirstTurnCheck(player);
    })();
    return true;
};

// ---------- 远端回合：等出牌（含可选杠） ----------
function selfGangOptions(player) {
    var out = [];
    if (Game.gameOver) return out;
    if (!Game.hasReplacementSlot()) return out; // 补牌位检查（统一收口）：无补牌位不提供杠选项
    (Game.exposedMelds[player] || []).forEach(function (meld) {
        if (meld.type === 'peng' && Game.hands[player].indexOf(meld.tiles[0]) >= 0)
            out.push({ tile: meld.tiles[0], kind: 'jia' });
    });
    if ((Game.exposedMelds[player] || []).length < 3) {
        var counts = {};
        Game.hands[player].forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
        Object.keys(counts).forEach(function (t) { if (counts[t] >= 4) out.push({ tile: t, kind: 'an' }); });
    }
    return out;
}
function validDiscard(player, tile) {
    var h = Game.hands[player] || [];
    return h.length % 3 === 2 && h.indexOf(tile) >= 0 && !Game.gameOver &&
        Game.turnOrder[Game.currentIndex] === player;
}
function hostAwaitTurn(player) {
    (async function () {
        var epoch = Game.gameEpoch;
        if (Game.gameOver) return;
        Game.setPhase(Game.PHASE.WAIT_DISCARD, 'netHost/awaitTurn');
        if (!isRemoteHuman(player)) { // 座位已掉线转 AI：不空等
            Game.scheduleAi(function () { Game.aiDiscard(player); }, Game.aiThinkMs(), 'netHost/awaitTurn/ai');
            return;
        }
        var gangs = selfGangOptions(player);
        Game.netOffers[player] = { kind: 'turn', gangs: gangs };
        Game.netBroadcastState(true);
        var r = await awaitIntent(player, { kind: 'turn', gangs: gangs }, Game.netTimeouts.turn);
        if (Game.gameEpoch !== epoch || Game.gameOver) return;
        var it = r.intent;
        if (!r.timeout && it && it.kind === 'selfgang') {
            var g = null;
            gangs.forEach(function (x) { if (x.tile === it.tile && x.kind === it.gangKind) g = x; });
            if (g) { doSelfGang(player, g.tile, g.kind, epoch); return; }
        }
        var tile = (!r.timeout && it && it.kind === 'discard' && validDiscard(player, it.tile))
            ? it.tile
            : Game.chooseAiDiscardTile(Game.hands[player].slice(), player);
        if (r.timeout || !it || it.kind !== 'discard')
            Game.logFlow(seatName(player) + ' 超时，AI 代打');
        execDiscard(player, tile, epoch);
    })();
}
function execDiscard(player, tile, epoch) {
    if (Game.gameOver || Game.gameEpoch !== epoch) return;
    if (!validDiscard(player, tile)) tile = Game.chooseAiDiscardTile(Game.hands[player].slice(), player);
    Game.TileFlow.discard(player, tile);
    Game.markKongDiscardIfNeeded(player);
    Game.validateHandCounts('netExecDiscard');
    Game.requestRender('netExecDiscard');
    try { Game.sfx.discard(); Game.feel.flyAiDiscard(player, Game.tileImg(tile)); } catch (e) {}
    try { Game.speak(Game.tileName(tile)); } catch (e) {}
    Game.logFlow(seatName(player) + ' 打出了 ' + Game.tileGlyph(tile));
    Game.netBroadcastState(true);
    _afterDiscard(player, tile, epoch);
}

// ---------- 远端自杠 ----------
function nearestRon(discarder, tile) {
    var order = turnOrderFrom(discarder);
    for (var i = 0; i < order.length; i++) {
        var s = order[i];
        try { if (Game.checkHu(Game.hands[s].concat([tile]), Game.exposedMelds[s], s)) return s; } catch (e) {}
    }
    return null;
}
function doSelfGang(player, tile, kind, epoch) {
    if (Game.gameOver || Game.gameEpoch !== epoch) return;
    if (kind === 'jia') {
        var robber = nearestRon(player, tile);
        if (robber) {
            Game.TileFlow.transfer(player, robber, tile);
            settleRon(robber, player, tile, true);
            return;
        }
        // 抢杠无人胡 → 再查补牌位：无补牌位不执行加杠，回等出牌
        if (!Game.hasReplacementSlot()) { hostAwaitTurn(player); return; }
        Game.TileFlow.addGang(player, tile);
    } else {
        if ((Game.exposedMelds[player] || []).length >= 3) { hostAwaitTurn(player); return; }
        // 补牌位检查（统一收口）：无补牌位不执行暗杠，回等出牌
        if (!Game.hasReplacementSlot()) { hostAwaitTurn(player); return; }
        Game.TileFlow.meld(player, 'gang', [tile, tile, tile, tile], { concealed: true });
    }
    Game.logFlow(seatName(player) + (kind === 'jia' ? ' 加杠 ' : ' 暗杠 ') + Game.tileGlyph(tile) + '，补牌中...');
    try { Game.sfx.gang(); Game.feel.banner('杠！'); } catch (e) {}
    Game.requestRender('netSelfGang');
    Game.netBroadcastState(true);
    gangReplacement(player, epoch);
}
function gangReplacement(player, epoch) {
    if (Game.gameOver || Game.gameEpoch !== epoch) return;
    Game.setPhase(Game.PHASE.REPLACEMENT, 'netGangReplacement');
    if (Game.deck.length <= Game.DEAD_WALL) { Game.declareDraw(); return; }
    var drawn = Game.TileFlow.draw(player, 'replacement');
    Game.hands[player].sort(Game.tileCompare);
    Game.lastDrawnTile[player] = drawn;
    Game.lastDrawWasFinal[player] = Game.deck.length === Game.DEAD_WALL;
    Game.markKongDraw(player);
    Game.validateHandCounts('netGangReplacement');
    Game.requestRender('netGangReplacement');
    Game.netBroadcastState(true);
    var winTile = Game.lastDrawnTile[player];
    if (Game.checkHu(Game.hands[player], Game.exposedMelds[player], player)) {
        settleSelfDraw(player, winTile);
        return;
    }
    var rk = Game.revealKindAfterDraw(player);
    if (rk && isRemoteHuman(player)) {
        // 补牌后的亮牌：走一次 reveal 要约
        (async function () {
            Game.netOffers[player] = { kind: 'reveal', revealKind: rk };
            var r = await awaitIntent(player, { kind: 'reveal', revealKind: rk }, Game.netTimeouts.reveal);
            if (Game.gameEpoch !== epoch || Game.gameOver) return;
            if (r.intent && r.intent.kind === 'reveal' && r.intent.accept) {
                if (revealAfterReplacement(player, rk)) return; // 亮牌补牌后自摸/流局已结算
                Game.netBroadcastState(true);
            }
            hostAwaitTurn(player);
        })();
        return;
    }
    if (rk && revealAfterReplacement(player, rk)) return;
    hostAwaitTurn(player);
}
/** 杠后补牌时的亮牌：东南西北亮出后又补了一张——不再算杠上开花，且新摸的牌要重新判自摸。
 *  返回 true 表示本局已结束（自摸或流局），调用方不要再续行。 */
function revealAfterReplacement(player, kind) {
    var ok = Game.applyReveal(player, kind);
    if (Game.gameOver) return true;
    if (ok && kind === 'winds') {
        Game.clearKongFlags();
        if (Game.checkHu(Game.hands[player], Game.exposedMelds[player], player)) {
            settleSelfDraw(player, Game.lastDrawnTile[player]);
            return true;
        }
    }
    return false;
}

// ---------- 结算（房主统一，广播结果） ----------
function settleRon(winner, discarder, tile, robGang) {
    // 抢杠：牌已从加杠者手里转给胡牌者，不能再取弃牌堆（与单机 executeSelfGang 一致）
    if (!robGang) Game.TileFlow.takeDiscardToHand(winner);
    Game.gameOver = true;
    Game.winner = winner;
    var before = Game.hands[winner].slice();
    before.splice(before.indexOf(tile), 1);
    var bonus = Game.scoreWinningHand(before, tile, Game.exposedMelds[winner], false);
    if (!robGang) Game.applyKongBonuses(bonus, winner, 'dianpao', discarder);
    var result = Game.settleScore(winner, 'dianpao', discarder, bonus);
    Game.clearKongFlags();
    Game.logFlow(seatName(winner) + ' 胡了' + seatName(discarder) + '的点炮！' + result.detail);
    try { Game.speak('胡了'); Game.learnFromWin(winner, discarder, { fan: bonus.mult, turns: Game.handTurnCount }); } catch (e) {}
    Game.requestRender('netSettleRon');
    Game.netBroadcastState(true);
    Game.netBroadcast({ t: 'result', winner: winner, mode: 'dianpao', payer: discarder, bonus: bonus, result: result, tile: tile, detail: result.detail });
    Game.showResultModal(winner, 'dianpao', discarder, bonus, result, tile);
}
function settleSelfDraw(player, winTile) {
    Game.gameOver = true;
    Game.winner = player;
    var before = Game.hands[player].slice();
    var wi = before.indexOf(winTile);
    if (wi < 0) wi = before.length - 1;
    before.splice(wi, 1);
    var bonus = Game.scoreWinningHand(before, winTile, Game.exposedMelds[player], Game.lastDrawWasFinal[player]);
    Game.applyKongBonuses(bonus, player, 'selfdraw', null);
    var result = Game.settleScore(player, 'selfdraw', null, bonus);
    Game.clearKongFlags();
    Game.logFlow(seatName(player) + ' 自摸胡牌！' + result.detail);
    try { Game.speak('胡了，自摸'); Game.learnFromWin(player, null, { fan: bonus.mult, turns: Game.handTurnCount }); } catch (e) {}
    Game.requestRender('netSettleSelf');
    Game.netBroadcastState(true);
    Game.netBroadcast({ t: 'result', winner: player, mode: 'selfdraw', payer: null, bonus: bonus, result: result, tile: winTile, detail: result.detail });
    Game.showResultModal(player, 'selfdraw', null, bonus, result, winTile);
}

// ---------- 钩子：统一的出牌后处理（点炮→吃碰杠要约→下一家） ----------
// 在 11-aiDiscard / 13-handleDiscard 的点炮检查之前调用；返回 true 表示已接管
Game.netAfterDiscard = function (discarder, tile) {
    if (!isHost()) return false;
    _afterDiscard(discarder, tile, Game.gameEpoch);
    return true;
};
function _afterDiscard(discarder, tile, epoch) {
    if (Game.gameOver || Game.gameEpoch !== epoch) return;
    // 1) 点炮（胡是自动的，所有座位一视同仁）
    var ronSeat = nearestRon(discarder, tile);
    if (ronSeat) { settleRon(ronSeat, discarder, tile); return; }
    if (Game.afterKongDiscardPlayer === discarder) Game.afterKongDiscardPlayer = null;
    // 2) 吃碰杠要约
    _claims(discarder, tile, epoch);
}

function _claims(discarder, tile, epoch) {
    (async function () {
        if (Game.gameOver || Game.gameEpoch !== epoch) return;
        var next = Game.nextPlayerOf(discarder);
        var offers = [];
        SEATS.forEach(function (s) {
            if (s === discarder) return;
            if ((Game.exposedMelds[s] || []).length >= 3) return; // 穷胡：不能手把一
            var o = { seat: s, peng: false, gang: false, chiCombos: [] };
            if (isAiLike(s)) {
                if (Game.canPeng(Game.hands[s], tile) && Game.shouldAiPeng(s, tile)) o.peng = true;
                if (s === next) {
                    var combos = Game.findChiCombos(Game.hands[s], tile);
                    var best = null, bestEV = -Infinity;
                    combos.forEach(function (combo) {
                        if (!Game.shouldAiChi(s, tile, combo)) return;
                        var ev = -Infinity;
                        try { ev = Game.meldCallEV(s, tile, 'chi', combo).evCall; } catch (e) {}
                        if (ev > bestEV) { bestEV = ev; best = combo; }
                    });
                    if (best) o.chiOne = best;
                }
            } else {
                o.peng = Game.canPeng(Game.hands[s], tile);
                // 补牌位检查（统一收口）：无补牌位时不对真人座位提供杠
                o.gang = Game.canGang(Game.hands[s], tile) && Game.hasReplacementSlot();
                if (s === next) o.chiCombos = Game.findChiCombos(Game.hands[s], tile);
            }
            if (o.peng || o.gang || o.chiOne || (o.chiCombos && o.chiCombos.length)) offers.push(o);
        });
        if (!offers.length) { Game.advanceTurn(); return; }

        Game.setPhase(Game.PHASE.CLAIM_PROMPT, 'netClaims');
        var results = await Promise.all(offers.map(function (o) {
            if (isAiLike(o.seat)) {
                return Promise.resolve({ seat: o.seat, choice: o.peng ? 'peng' : (o.chiOne ? 'chi' : 'pass'), combo: o.chiOne || null });
            }
            if (o.seat === 'bottom') return offerLocalClaim(o, discarder, tile); // 房主本机 UI
            Game.netOffers[o.seat] = { kind: 'claim', tile: tile, from: discarder, opts: o };
            Game.netBroadcastState(true);
            return awaitIntent(o.seat, {
                kind: 'claim', tile: tile, from: discarder,
                opts: { peng: o.peng, gang: o.gang, chi: o.chiCombos }
            }, Game.netTimeouts.claim).then(function (r) {
                return normalizeClaimIntent(o, r);
            });
        }));
        if (Game.gameEpoch !== epoch || Game.gameOver) return;
        // 裁决：杠/碰 > 吃；同级按下家距离 discarder 最近者胜
        var order = turnOrderFrom(discarder);
        var dist = function (s) { return order.indexOf(s); };
        var pg = results.filter(function (r) { return r.choice === 'peng' || r.choice === 'gang'; })
            .sort(function (a, b) { return dist(a.seat) - dist(b.seat); });
        var ch = results.filter(function (r) { return r.choice === 'chi'; });
        var win = pg[0] || ch[0] || null;
        if (!win) { Game.advanceTurn(); return; }
        execClaimWin(win, discarder, tile, epoch);
    })();
}

function normalizeClaimIntent(o, r) {
    var it = r.intent;
    if (!r.timeout && it && it.kind === 'claim') {
        if (it.choice === 'peng' && o.peng) return { seat: o.seat, choice: 'peng' };
        if (it.choice === 'gang' && o.gang) return { seat: o.seat, choice: 'gang' };
        if (it.choice === 'chi' && o.chiCombos && o.chiCombos[it.combo | 0]) return { seat: o.seat, choice: 'chi', combo: o.chiCombos[it.combo | 0] };
    }
    return { seat: o.seat, choice: 'pass' };
}

/** 房主本机要约：走现有 indicator UI，点选只记录意图 */
function offerLocalClaim(o, discarder, tile) {
    return new Promise(function (resolve) {
        var epoch = Game.gameEpoch;
        Game.pendingClaim = {
            tile: tile, fromPlayer: discarder,
            canPeng: o.peng, canGang: o.gang, chiCombos: o.chiCombos || [],
            mode: 'claim', netLocal: true
        };
        var options = [o.gang ? '杠' : null, o.peng ? '碰' : null, (o.chiCombos && o.chiCombos.length) ? '吃' : null].filter(Boolean).join('/');
        Game.showIndicator(options, true);
        Game.logFlow('可以' + options + '，点确认执行 / 点过');
        Game.netCountdownShow(Game.netTimeouts.claim, '请选择 ');
        var timer = setTimeout(function () {
            Game.netCountdownHide();
            if (Game.netLocalAwait) {
                Game.netLocalAwait = null;
                Game.pendingClaim = null;
                try { Game.hideIndicator(); Game.$('chi-choice-modal').classList.remove('show'); } catch (e) {}
                resolve({ seat: 'bottom', choice: 'pass' });
            }
        }, Game.netTimeouts.claim);
        Game.netLocalAwait = function (res) {
            clearTimeout(timer); Game.netLocalAwait = null; Game.netCountdownHide();
            if (Game.gameEpoch !== epoch) resolve({ seat: 'bottom', choice: 'pass' });
            else resolve({ seat: 'bottom', choice: res.choice, combo: res.combo || null });
        };
    });
}

/** acceptClaim / declineClaim / chooseChiCombo 的房主本机钩子：只记录意图，不执行 */
Game.netClaimIntent = Game._netHostClaimIntent = function (action, i) {
    if (!isHost() || !Game.netLocalAwait) return false;
    var pc = Game.pendingClaim || {};
    var choice = null, combo = null;
    if (action === 'pass') choice = 'pass';
    else if (action === 'accept') {
        if (pc.canGang) choice = 'gang';
        else if (pc.canPeng) choice = 'peng';
        else if (pc.chiCombos && pc.chiCombos.length === 1) { choice = 'chi'; combo = pc.chiCombos[0]; }
        else return false; // 多种吃法：走弹窗，chooseChiCombo 再定
    } else if (action === 'chi' && i != null && pc.chiCombos && pc.chiCombos[i]) {
        choice = 'chi'; combo = pc.chiCombos[i];
    }
    if (!choice) return false;
    var r = Game.netLocalAwait; Game.netLocalAwait = null;
    Game.pendingClaim = null;
    try { Game.hideIndicator(); Game.$('chi-choice-modal').classList.remove('show'); } catch (e) {}
    r({ choice: choice, combo: combo });
    return true;
};

function execClaimWin(win, discarder, tile, epoch) {
    if (Game.gameOver || Game.gameEpoch !== epoch) return;
    var seat = win.seat;
    // 防御：要约时已守门，此处仅防 stale 杠意图；无补牌位时杠降为碰，不能碰则按过处理
    if (win.choice === 'gang' && !Game.hasReplacementSlot()) {
        if (Game.canPeng(Game.hands[seat], tile)) win = { seat: seat, choice: 'peng' };
        else { Game.advanceTurn(); return; }
    }
    Game.logFlow(seatName(seat) + ' ' + ({ peng: '碰', gang: '杠', chi: '吃' }[win.choice] || '') + '了 ' + Game.tileGlyph(tile));
    if (isAiLike(seat) && seat !== 'bottom') {
        if (win.choice === 'peng') { Game.aiPengClaim(seat, tile); return; }
        if (win.choice === 'chi') { Game.aiChiClaim(seat, tile, win.combo); return; }
    }
    if (seat === 'bottom') {
        // 房主本机：用现有执行函数（它们读 Game.pendingClaim）
        Game.pendingClaim = { tile: tile, fromPlayer: discarder, canPeng: win.choice === 'peng', canGang: win.choice === 'gang', chiCombos: win.combo ? [win.combo] : [], mode: 'claim' };
        if (win.choice === 'peng') Game.callPeng();
        else if (win.choice === 'gang') Game.callGang();
        else if (win.choice === 'chi') Game.callChi();
        Game.pendingClaim = null;
        return;
    }
    // 远端客人：直接执行 TileFlow，然后等他出牌
    if (win.choice === 'peng') {
        Game.TileFlow.claim(seat, 'peng', [tile, tile]);
    } else if (win.choice === 'gang') {
        Game.TileFlow.claim(seat, 'gang', [tile, tile, tile], null, { concealed: false });
    } else if (win.choice === 'chi') {
        Game.TileFlow.claim(seat, 'chi', win.combo, Game.tileCompare);
    }
    Game.currentIndex = Game.turnOrder.indexOf(seat);
    try { Game.sfx.peng(); Game.feel.banner(win.choice === 'chi' ? '吃！' : (win.choice === 'gang' ? '杠！' : '碰！')); } catch (e) {}
    Game.setPhase(Game.PHASE.WAIT_DISCARD, 'netClaimWin');
    Game.requestRender('netClaimWin');
    Game.netBroadcastState(true);
    if (win.choice === 'gang') { gangReplacement(seat, epoch); return; }
    hostAwaitTurn(seat);
}

;})();
