;(function(){
// ---------- 游戏流程 ----------
const DEAD_WALL = 16; // 荒牌墙：摸到只剩这些时流局

function initGame() {
    Game.gameEpoch++; // 新的一局：让上一局遗留的延时回调全部作废
    Game.setPhase(Game.PHASE.DEALING, 'initGame');
    resetSpeechQueue();
    Game.buildDeck();
    Game.hands = { top: [], left: [], right: [], bottom: [] };
    Game.exposedMelds = { top: [], left: [], right: [], bottom: [] };
    Game.discardPile = [];
    Game.gameOver = false;
    Game.winner = null;
    Game.selectedIndex = null;
    Game.lastDrawnIndex = null;
    Game.windDragonBonus = { top: false, left: false, right: false, bottom: false };
    Game.firstTurnPending = { top: true, left: true, right: true, bottom: true };
    Game.revealDeclined = { top: {}, left: {}, right: {}, bottom: {} };
    Game.revealPatternSeen = { top: {}, left: {}, right: {}, bottom: {} };
    Game.lastDrawnTile = { top: null, left: null, right: null, bottom: null };
    Game.lastDrawWasFinal = { top: false, left: false, right: false, bottom: false };
    Game.aiWaitTiles = { top: [], left: [], right: [] };
    Game.pendingClaim = null;
    Game.lastSettlement = null;
    Game.clearKongFlags();
    Game.resetAiAxisUsed();
    Game.resetLastCallTurn();
    Game.resetAiDefenseMode();
    Game.handTurnCount = 0;
    Game.currentIndex = Game.turnOrder.indexOf(Game.dealer);
    Game.resetFlowLog();
    Game.TileFlow.deal(tileCompare);
    Game.markDealer();
    Game.requestRender('initGame');
    logFlow('发牌完成，游戏开始');
    Game.scheduleAi(() => nextTurn(), 600, 'initGame/firstTurn');
}

const suitOrder = ['万', '条', '筒', '字'];
function tileCompare(a, b) {
    const sa = Game.tileSuit(a), sb = Game.tileSuit(b);
    if (sa !== sb) return suitOrder.indexOf(sa) - suitOrder.indexOf(sb);
    return Game.tileRank(a) - Game.tileRank(b);
}

/** 废牌区（牌池）专用排序：筒→条→万，各花色内部从9到1；字牌按 中发白东西南北 */
const poolSuitOrder = ['筒', '条', '万', '字'];
const poolHonorOrder = ['中', '发', '白', '东', '西', '南', '北'];
function poolTileCompare(a, b) {
    const sa = Game.tileSuit(a), sb = Game.tileSuit(b);
    if (sa !== sb) return poolSuitOrder.indexOf(sa) - poolSuitOrder.indexOf(sb);
    if (sa === '字') {
        const ia = poolHonorOrder.indexOf(Game.honors[Game.tileRank(a) - 1]);
        const ib = poolHonorOrder.indexOf(Game.honors[Game.tileRank(b) - 1]);
        return ia - ib;
    }
    return Game.tileRank(b) - Game.tileRank(a); // 数牌从9到1
}

// 流局：查一下四家听牌情况再宣布
function declareDraw() {
    Game.gameOver = true;
    Game.setPhase(Game.PHASE.NEXT_GAME, 'declareDraw');
    const tenpaiFlags = {};
    Game.turnOrder.forEach(p => { tenpaiFlags[p] = Game.isTenpai(p); });
    const tenpaiPlayers = Game.turnOrder.filter(p => tenpaiFlags[p]);
    const notTenpai = Game.turnOrder.filter(p => !tenpaiFlags[p]);
    let msg = '牌墙已尽，流局。';
    if (tenpaiPlayers.length === 4) {
        msg += '四家都听牌。';
    } else if (tenpaiPlayers.length === 0) {
        msg += '没有人听牌。';
    } else {
        msg += '听牌：' + tenpaiPlayers.map(Game.nameOf).join('、') + '；不听：' + notTenpai.map(Game.nameOf).join('、');
    }
    logFlow(msg + ' 点确认开下一局');
    speak('流局');
    Game.learnFromDraw(tenpaiPlayers);
    // 2.0 二期：流局也算一局
    if (typeof Game.onFieldDraw === 'function') {
        try { Game.onFieldDraw(); } catch (e) {}
    }
    Game.requestRender('declareDraw');
    // 骰子按钮已移除：流局后用提示条开下一局
    Game.pendingClaim = { mode: 'nextGame' };
    Game.showIndicator('流局', true);
}


// 语音播报排队：连续触发的播报（比如摸/打这张牌的名字，紧接着又要念吃碰杠胡）
// 不能互相打断，必须一句话说完再说下一句，所以用队列串行播放，而不是 cancel() 抢占
Game.speechQueue = [];
Game.speechSpeaking = false;
const SPEECH_QUEUE_MAX = 2; // 等待中最多囤2句，避免动作太密时语音越播越滞后于画面

function speak(text) {
    try {
        if (!window.speechSynthesis) return;
        Game.speechQueue.push(text);
        // 队列积压太多时丢弃最旧的等待项，只保留最近的，让语音尽量追上当前局面
        while (Game.speechQueue.length > SPEECH_QUEUE_MAX) Game.speechQueue.shift();
        processSpeechQueue();
    } catch (e) { /* 语音不可用则静默 */ }
}

function processSpeechQueue() {
    if (Game.speechSpeaking || Game.speechQueue.length === 0) return;
    Game.speechSpeaking = true;
    const clean = Game.speechQueue.shift();
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'zh-CN';
    utter.rate = 1.1;
    utter.onend = utter.onerror = () => {
        Game.speechSpeaking = false;
        processSpeechQueue();
    };
    speechSynthesis.speak(utter);
}

// 新开一局时清空上一局可能积压的播报，避免旧播报堆到新局里
function resetSpeechQueue() {
    Game.speechQueue = [];
    Game.speechSpeaking = false;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
}

// 语音播报里指称某家：自己念“你”，其余念座位名（speak 会自动去掉表情符号）
function voiceName(p) { return p === 'bottom' ? '你' : Game.nameOf(p); }


// 流程提示：只显示文字（在“你”的牌下方），不语音
function logFlow(msg) {
    const el = Game.$('flow-log');
    if (el) el.innerText = msg;
}

// 检查某手牌是否凑齐了东南西北(风)或中发白(箭)各一张
function checkWindDragonPattern(hand) {
    const winds = ['1字', '2字', '3字', '4字'];
    const dragons = ['5字', '6字', '7字'];
    if (winds.every(t => hand.includes(t))) return 'winds';
    if (dragons.every(t => hand.includes(t))) return 'dragons';
    return null;
}

// 当前手牌满足的亮牌牌型（两种可同时满足）
function currentRevealKinds(hand) {
    const winds = ['1字', '2字', '3字', '4字'];
    const dragons = ['5字', '6字', '7字'];
    return {
        winds: winds.every(t => hand.includes(t)),
        dragons: dragons.every(t => hand.includes(t)),
    };
}

/**
 * 高阶亮牌决策（摸牌后调用）：
 * - 每种牌型从"不满足"变为"满足"（新凑齐）时，清除该种类的拒绝记录，重新允许提示
 * - 已亮过的种类不再提示；拒绝过的种类在牌型未变时不再提示
 * - 两类同时满足沿用旧逻辑优先级（winds 优先）
 * - firstTurn=true 时沿用旧版（两种都可亮）；否则按开关
 * 返回 'winds' | 'dragons' | null
 */
function pickAdvancedRevealKind(player, firstTurn) {
    // 穷胡规则：已有 3 组副露，不许第 4 组（亮牌也不行）
    if ((Game.exposedMelds[player] || []).length >= 3) return null;
    const kinds = currentRevealKinds(Game.hands[player]);
    const prev = Game.revealPatternSeen[player] || {};
    if (!Game.revealDeclined[player]) Game.revealDeclined[player] = {};
    const declined = Game.revealDeclined[player];
    let picked = null;
    for (const k of ['winds', 'dragons']) { // 旧逻辑优先级：winds 优先
        if (kinds[k] && !prev[k]) delete declined[k]; // 新凑齐 → 重新允许提示
        if (picked || !kinds[k]) continue;
        if (Game.exposedMelds[player].some(m => m.type === k)) continue; // 该组已亮过
        if (declined[k]) continue; // 拒绝过且牌型未变
        if (typeof Game.ruleAllowsReveal === 'function' && !Game.ruleAllowsReveal(k, firstTurn)) continue;
        picked = k;
    }
    Game.revealPatternSeen[player] = kinds;
    return picked;
}

/**
 * 摸牌/杠后补牌后的统一亮牌检查（非首巡）：
 * - 日常模式：非首巡不检查（与普通摸牌一致）
 * - 高阶模式：按开关检查（3 组副露上限已在 pickAdvancedRevealKind 内）
 * 返回 'winds' | 'dragons' | null
 */
function revealKindAfterDraw(player) {
    if (typeof Game.isDailyMode === 'function' && !Game.isDailyMode()) {
        return pickAdvancedRevealKind(player, false);
    }
    return null;
}

// 亮牌：把东南西北(4张)或中发白(3张)从暗牌里移出，变成一组“亮牌”明组，占一个面子位
// 中发白正好3张，跟碰/吃一样不用补牌；东南西北4张，跟杠一样需要补一张牌才能凑够面子位的牌数
// 算幺九+刻子，但不算开门。返回false代表补牌时牌墙已尽、流局已处理，调用方不要再继续往下走
function applyReveal(player, kind) {
    Game.windDragonBonus[player] = true;
    const tiles = kind === 'winds' ? ['1字', '2字', '3字', '4字'] : ['5字', '6字', '7字'];
    Game.TileFlow.meld(player, kind, tiles);
    logFlow(Game.nameOf(player) + (kind === 'winds' ? ' 亮出东南西北' : ' 亮出中发白') + '（算幺九+刻子，不算开门）');
    speak('亮牌');
    if (kind === 'dragons') { Game.requestRender('applyReveal/dragons'); return true; } // 3张，不用补牌
    if (Game.deck.length <= DEAD_WALL) { declareDraw(); return false; }
    const drawn = Game.TileFlow.draw(player, 'revealDraw');
    Game.hands[player].sort(tileCompare);
    Game.lastDrawnTile[player] = drawn;
    Game.lastDrawWasFinal[player] = Game.deck.length === DEAD_WALL;
    if (player === 'bottom') { Game.lastDrawnIndex = Game.hands.bottom.lastIndexOf(drawn); Game.selectedIndex = null; }
    Game.requestRender('applyReveal/winds');
    return true;
}

Game.pendingReveal = null; // 'winds' | 'dragons'，等待你在弹窗里选择
Game.pendingRevealContext = null; // 'replacement' = 杠后补牌时弹出的亮牌，关闭后回到补牌续行

function offerReveal(kind) {
    Game.setPhase(Game.PHASE.REVEAL_PROMPT, 'offerReveal');
    Game.pendingReveal = kind;
    Game.$('reveal-title').innerText =
        (kind === 'winds'
            ? '手里凑齐了东南西北，要亮牌吗？（算幺九+刻子，不算开门；亮出4张后补一张牌）'
            : '手里凑齐了中发白，要亮牌吗？（算幺九+刻子，不算开门；正好3张，不用补牌）');
    Game.$('reveal-modal').classList.add('show');
}

function confirmReveal(reveal) {
    const kind = Game.pendingReveal;
    Game.pendingReveal = null;
    Game.$('reveal-modal').classList.remove('show');
    const ctx = Game.pendingRevealContext;
    Game.pendingRevealContext = null;
    if (reveal) {
        if (!applyReveal('bottom', kind)) return; // 补牌时牌墙已尽，流局已处理
        // 杠后补牌时亮出东南西北又补了一张：之后胡牌不再算杠上开花
        if (ctx === 'replacement' && kind === 'winds') Game.clearKongFlags();
    } else if (typeof Game.isDailyMode === 'function' && !Game.isDailyMode()) {
        // 高阶：拒绝后同牌型不再提示（牌型变化/新凑齐后会重新允许）
        if (!Game.revealDeclined.bottom) Game.revealDeclined.bottom = {};
        Game.revealDeclined.bottom[kind] = true;
    }
    if (ctx === 'replacement') {
        Game.continueReplacementAfterReveal();
    } else {
        continueAfterFirstTurnCheck('bottom');
    }
}

// 摸牌之后的自摸判断与后续流程（首次摸牌的亮牌选择处理完之后也会走到这里）
function continueAfterFirstTurnCheck(player) {
    if (Game.gameOver) return;
    if (Game.checkHu(Game.hands[player], Game.exposedMelds[player], player)) {
        if (player === 'bottom') {
            Game.offerHu({ mode: 'selfdraw' });
        } else {
            Game.gameOver = true;
            Game.winner = player;
            const winTile = Game.lastDrawnTile[player];
            const before = [...Game.hands[player]];
            before.splice(before.indexOf(winTile), 1);
            const bonus = Game.scoreWinningHand(before, winTile, Game.exposedMelds[player], Game.lastDrawWasFinal[player]);
            Game.applyKongBonuses(bonus, player, 'selfdraw', null);
            const result = Game.settleScore(player, 'selfdraw', null, bonus);
            Game.clearKongFlags();
            logFlow(Game.nameOf(player) + ' 自摸胡牌！' + result.detail);
            speak('胡了，自摸');
            Game.learnFromWin(player, null, { fan: bonus.mult, turns: Game.handTurnCount });
            Game.showResultModal(player, 'selfdraw', null, bonus, result, winTile);
        }
        return;
    }

    if (player === 'bottom') {
        // 检查暗杠/加杠机会，可选提示（不挡出牌）
        offerSelfGangIfAny();
        if (!Game.pendingClaim) Game.setPhase(Game.PHASE.WAIT_DISCARD, 'continueAfterFirstTurnCheck');
        logFlow('轮到你，请点击一张牌出牌');
    } else {
        Game.setPhase(Game.PHASE.WAIT_DISCARD, 'continueAfterFirstTurnCheck');
        Game.scheduleAi(() => Game.aiDiscard(player), Game.aiThinkMs(), 'continueAfterFirstTurnCheck/aiDiscard');
    }
}

// 检查自己回合是否可暗杠或加杠，弹出「杠」提示与确认/过按钮（可选，点过或不理会都能继续出牌）
function offerSelfGangIfAny() {
    if (Game.gameOver || Game.pendingClaim) return;
    // 加杠：已碰过的牌，手里又有第4张
    for (const meld of Game.exposedMelds.bottom) {
        if (meld.type === 'peng' && Game.hands.bottom.includes(meld.tiles[0])) {
            Game.pendingClaim = { mode: 'selfGang', kind: 'jia', tile: meld.tiles[0] };
            Game.setPhase(Game.PHASE.SELF_GANG_OFFER, 'offerSelfGangIfAny/jia');
            Game.showIndicator('杠', true);
            logFlow('可以加杠 ' + Game.tileGlyph(meld.tiles[0]) + '，点确认杠 / 点过或直接出牌');
            return;
        }
    }
    // 暗杠：手里4张一样（穷胡规则：不能手把一，最多留3组面子在外，第4组必须留在手里）
    if (Game.exposedMelds.bottom.length < 3) {
        const counts = {};
        Game.hands.bottom.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
        for (const t in counts) {
            if (counts[t] >= 4) {
                Game.pendingClaim = { mode: 'selfGang', kind: 'an', tile: t };
                Game.setPhase(Game.PHASE.SELF_GANG_OFFER, 'offerSelfGangIfAny/an');
                Game.showIndicator('杠', true);
                logFlow('可以暗杠 ' + Game.tileGlyph(t) + '，点确认杠 / 点过或直接出牌');
                return;
            }
        }
    }
}

function executeSelfGang() {
    if (!Game.pendingClaim || Game.pendingClaim.mode !== 'selfGang') return;
    const { kind, tile } = Game.pendingClaim;
    Game.pendingClaim = null;
    Game.hideIndicator();
    if (kind === 'jia') {
        // 抢杠检查
        const robber = Game.findRonPriority('bottom', tile);
        if (robber && robber !== 'bottom') {
            Game.TileFlow.transfer('bottom', robber, tile);
            Game.gameOver = true;
            Game.winner = robber;
            const before = [...Game.hands[robber]];
            before.splice(before.indexOf(tile), 1);
            const bonus = Game.scoreWinningHand(before, tile, Game.exposedMelds[robber], false);
            // 抢杠按点炮结算（不加杠后点炮；抢杠本身已是特殊）
            const result = Game.settleScore(robber, 'dianpao', 'bottom', bonus);
            Game.clearKongFlags();
            logFlow(Game.nameOf(robber) + ' 抢杠胡了你加杠的 ' + Game.tileGlyph(tile) + '！' + result.detail);
            speak('胡了，' + voiceName('bottom') + '点炮');
            Game.learnFromWin(robber, 'bottom', { fan: bonus.mult, turns: Game.handTurnCount });
            Game.requestRender('executeSelfGang/rob');
            Game.showResultModal(robber, 'dianpao', 'bottom', bonus, result, tile);
            return;
        }
        Game.TileFlow.addGang('bottom', tile);
        logFlow('你加杠了 ' + Game.tileGlyph(tile) + '，补牌中...');
        speak('杠' + Game.tileName(tile));
        Game.sfx.gang(); Game.feel.banner('杠！');
        Game.requestRender('executeSelfGang/jia');
        Game.drawReplacementAndContinue();
        return;
    }
    // 暗杠
    if (Game.exposedMelds.bottom.length >= 3) { logFlow('穷胡规则：不能手把一，最后一组必须留在手里'); return; }
    Game.TileFlow.meld('bottom', 'gang', [tile, tile, tile, tile], { concealed: true });
    logFlow('你暗杠了 ' + Game.tileGlyph(tile) + '，补牌中...');
    speak('杠' + Game.tileName(tile));
    Game.sfx.gang(); Game.feel.banner('杠！');
    Game.requestRender('executeSelfGang/an');
    Game.drawReplacementAndContinue();
}

function nextTurn() {
    if (Game.gameOver) return;
    if (Game.deck.length <= DEAD_WALL) { declareDraw(); return; }
    Game.setPhase(Game.PHASE.DRAW, 'nextTurn');
    Game.handTurnCount++;
    const player = Game.turnOrder[Game.currentIndex];
    const drawn = Game.TileFlow.draw(player, 'draw');
    Game.hands[player].sort(tileCompare);
    Game.lastDrawnTile[player] = drawn;
    Game.lastDrawWasFinal[player] = Game.deck.length === DEAD_WALL;
    if (player === 'bottom') { Game.lastDrawnIndex = Game.hands.bottom.lastIndexOf(drawn); Game.selectedIndex = null; Game._drawnAnimPlayed = false; }
    // 普通摸牌不是杠上开花（杠补牌路径由各自的 mark 逻辑处理）
    Game.validateHandCounts('nextTurn');
    Game.requestRender('nextTurn');
    Game.sfx.draw(); // 手感：摸牌轻响（AI 摸牌也有，节奏感）
    Game.highlightActive(player);

    const wasFirstTurn = !!Game.firstTurnPending[player];
    if (wasFirstTurn) {
        Game.firstTurnPending[player] = false;
        // 日常：旧版首巡亮牌逻辑 + 用户规则：已有 3 组副露不许第 4 组（亮牌也不行）
        if (typeof Game.isDailyMode === 'function' && Game.isDailyMode()) {
            let kind = Game.exposedMelds[player].length >= 3 ? null : checkWindDragonPattern(Game.hands[player]);
            if (kind) {
                if (player === 'bottom') {
                    offerReveal(kind);
                    return;
                }
                if (!applyReveal(player, kind)) return;
            }
        }
    }
    // 高阶：首巡沿用旧版（两种都可亮），之后按开关随时可亮；
    // 拒绝后同牌型不再提示，牌型变化（新凑齐）后重新提示；两组可先后亮
    if (typeof Game.isDailyMode === 'function' && !Game.isDailyMode()) {
        const kind = pickAdvancedRevealKind(player, wasFirstTurn);
        if (kind) {
            if (player === 'bottom') {
                offerReveal(kind);
                return;
            }
            if (!applyReveal(player, kind)) return;
        }
    }

    continueAfterFirstTurnCheck(player);
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.DEAD_WALL = DEAD_WALL;
Game.initGame = initGame;
Game.tileCompare = tileCompare;
Game.poolTileCompare = poolTileCompare;
Game.declareDraw = declareDraw;
Game.speak = speak;
Game.voiceName = voiceName;
Game.logFlow = logFlow;
Game.checkWindDragonPattern = checkWindDragonPattern;
Game.pickAdvancedRevealKind = pickAdvancedRevealKind;
Game.revealKindAfterDraw = revealKindAfterDraw;
Game.applyReveal = applyReveal;
Game.offerReveal = offerReveal;
Game.confirmReveal = confirmReveal;
Game.offerSelfGangIfAny = offerSelfGangIfAny;
Game.executeSelfGang = executeSelfGang;
Game.nextTurn = nextTurn;

;})();
