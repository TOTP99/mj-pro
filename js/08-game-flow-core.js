// ---------- 游戏流程 ----------
const DEAD_WALL = 16; // 荒牌墙：摸到只剩这些时流局

function initGame() {
    gameEpoch++; // 新的一局：让上一局遗留的延时回调全部作废
    resetSpeechQueue();
    buildDeck();
    hands = { top: [], left: [], right: [], bottom: [] };
    exposedMelds = { top: [], left: [], right: [], bottom: [] };
    discardPile = [];
    gameOver = false;
    winner = null;
    selectedIndex = null;
    lastDrawnIndex = null;
    windDragonBonus = { top: false, left: false, right: false, bottom: false };
    firstTurnPending = { top: true, left: true, right: true, bottom: true };
    revealDeclined = { top: {}, left: {}, right: {}, bottom: {} };
    revealPatternSeen = { top: {}, left: {}, right: {}, bottom: {} };
    lastDrawnTile = { top: null, left: null, right: null, bottom: null };
    lastDrawWasFinal = { top: false, left: false, right: false, bottom: false };
    aiWaitTiles = { top: [], left: [], right: [] };
    pendingClaim = null;
    lastSettlement = null;
    clearKongFlags();
    resetAiAxisUsed();
    resetLastCallTurn();
    handTurnCount = 0;
    currentIndex = turnOrder.indexOf(dealer);
    for (const p of PLAYERS) hands[p] = deck.splice(0, 13).sort(tileCompare);
    markDealer();
    render();
    logFlow('发牌完成，游戏开始');
    gameTimeout(() => nextTurn(), 600);
}

const suitOrder = ['万', '条', '筒', '字'];
function tileCompare(a, b) {
    const sa = tileSuit(a), sb = tileSuit(b);
    if (sa !== sb) return suitOrder.indexOf(sa) - suitOrder.indexOf(sb);
    return tileRank(a) - tileRank(b);
}

/** 废牌区（牌池）专用排序：筒→条→万，各花色内部从9到1；字牌按 中发白东西南北 */
const poolSuitOrder = ['筒', '条', '万', '字'];
const poolHonorOrder = ['中', '发', '白', '东', '西', '南', '北'];
function poolTileCompare(a, b) {
    const sa = tileSuit(a), sb = tileSuit(b);
    if (sa !== sb) return poolSuitOrder.indexOf(sa) - poolSuitOrder.indexOf(sb);
    if (sa === '字') {
        const ia = poolHonorOrder.indexOf(honors[tileRank(a) - 1]);
        const ib = poolHonorOrder.indexOf(honors[tileRank(b) - 1]);
        return ia - ib;
    }
    return tileRank(b) - tileRank(a); // 数牌从9到1
}

// 流局：查一下四家听牌情况再宣布
function declareDraw() {
    gameOver = true;
    const tenpaiFlags = {};
    turnOrder.forEach(p => { tenpaiFlags[p] = isTenpai(p); });
    const tenpaiPlayers = turnOrder.filter(p => tenpaiFlags[p]);
    const notTenpai = turnOrder.filter(p => !tenpaiFlags[p]);
    let msg = '牌墙已尽，流局。';
    if (tenpaiPlayers.length === 4) {
        msg += '四家都听牌。';
    } else if (tenpaiPlayers.length === 0) {
        msg += '没有人听牌。';
    } else {
        msg += '听牌：' + tenpaiPlayers.map(nameOf).join('、') + '；不听：' + notTenpai.map(nameOf).join('、');
    }
    logFlow(msg + ' 点确认开下一局');
    speak('流局');
    learnFromDraw(tenpaiPlayers);
    // 2.0 二期：流局也算一局
    if (typeof onFieldDraw === 'function') {
        try { onFieldDraw(); } catch (e) {}
    }
    render();
    // 骰子按钮已移除：流局后用提示条开下一局
    pendingClaim = { mode: 'nextGame' };
    showIndicator('流局', true);
}


// 语音播报排队：连续触发的播报（比如摸/打这张牌的名字，紧接着又要念吃碰杠胡）
// 不能互相打断，必须一句话说完再说下一句，所以用队列串行播放，而不是 cancel() 抢占
let speechQueue = [];
let speechSpeaking = false;
const SPEECH_QUEUE_MAX = 2; // 等待中最多囤2句，避免动作太密时语音越播越滞后于画面

function speak(text) {
    try {
        if (!window.speechSynthesis) return;
        speechQueue.push(text);
        // 队列积压太多时丢弃最旧的等待项，只保留最近的，让语音尽量追上当前局面
        while (speechQueue.length > SPEECH_QUEUE_MAX) speechQueue.shift();
        processSpeechQueue();
    } catch (e) { /* 语音不可用则静默 */ }
}

function processSpeechQueue() {
    if (speechSpeaking || speechQueue.length === 0) return;
    speechSpeaking = true;
    const clean = speechQueue.shift();
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'zh-CN';
    utter.rate = 1.1;
    utter.onend = utter.onerror = () => {
        speechSpeaking = false;
        processSpeechQueue();
    };
    speechSynthesis.speak(utter);
}

// 新开一局时清空上一局可能积压的播报，避免旧播报堆到新局里
function resetSpeechQueue() {
    speechQueue = [];
    speechSpeaking = false;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
}

// 语音播报里指称某家：自己念“你”，其余念座位名（speak 会自动去掉表情符号）
function voiceName(p) { return p === 'bottom' ? '你' : nameOf(p); }


// 流程提示：只显示文字（在“你”的牌下方），不语音
function logFlow(msg) {
    const el = $('flow-log');
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
    const kinds = currentRevealKinds(hands[player]);
    const prev = revealPatternSeen[player] || {};
    if (!revealDeclined[player]) revealDeclined[player] = {};
    const declined = revealDeclined[player];
    let picked = null;
    for (const k of ['winds', 'dragons']) { // 旧逻辑优先级：winds 优先
        if (kinds[k] && !prev[k]) delete declined[k]; // 新凑齐 → 重新允许提示
        if (picked || !kinds[k]) continue;
        if (exposedMelds[player].some(m => m.type === k)) continue; // 该组已亮过
        if (declined[k]) continue; // 拒绝过且牌型未变
        if (typeof ruleAllowsReveal === 'function' && !ruleAllowsReveal(k, firstTurn)) continue;
        picked = k;
    }
    revealPatternSeen[player] = kinds;
    return picked;
}

// 亮牌：把东南西北(4张)或中发白(3张)从暗牌里移出，变成一组“亮牌”明组，占一个面子位
// 中发白正好3张，跟碰/吃一样不用补牌；东南西北4张，跟杠一样需要补一张牌才能凑够面子位的牌数
// 算幺九+刻子，但不算开门。返回false代表补牌时牌墙已尽、流局已处理，调用方不要再继续往下走
function applyReveal(player, kind) {
    windDragonBonus[player] = true;
    const tiles = kind === 'winds' ? ['1字', '2字', '3字', '4字'] : ['5字', '6字', '7字'];
    tiles.forEach(t => { hands[player].splice(hands[player].indexOf(t), 1); });
    exposedMelds[player].push({ type: kind, tiles: [...tiles] });
    logFlow(nameOf(player) + (kind === 'winds' ? ' 亮出东南西北' : ' 亮出中发白') + '（算幺九+刻子，不算开门）');
    speak('亮牌');
    if (kind === 'dragons') { render(); return true; } // 3张，不用补牌
    if (deck.length <= DEAD_WALL) { declareDraw(); return false; }
    const drawn = deck.pop();
    hands[player].push(drawn);
    hands[player].sort(tileCompare);
    lastDrawnTile[player] = drawn;
    lastDrawWasFinal[player] = deck.length === DEAD_WALL;
    if (player === 'bottom') { lastDrawnIndex = hands.bottom.lastIndexOf(drawn); selectedIndex = null; }
    render();
    return true;
}

let pendingReveal = null; // 'winds' | 'dragons'，等待你在弹窗里选择

function offerReveal(kind) {
    pendingReveal = kind;
    $('reveal-title').innerText =
        (kind === 'winds'
            ? '手里凑齐了东南西北，要亮牌吗？（算幺九+刻子，不算开门；亮出4张后补一张牌）'
            : '手里凑齐了中发白，要亮牌吗？（算幺九+刻子，不算开门；正好3张，不用补牌）');
    $('reveal-modal').classList.add('show');
}

function confirmReveal(reveal) {
    const kind = pendingReveal;
    pendingReveal = null;
    $('reveal-modal').classList.remove('show');
    if (reveal) {
        if (!applyReveal('bottom', kind)) return; // 补牌时牌墙已尽，流局已处理
    } else if (typeof isDailyMode === 'function' && !isDailyMode()) {
        // 高阶：拒绝后同牌型不再提示（牌型变化/新凑齐后会重新允许）
        if (!revealDeclined.bottom) revealDeclined.bottom = {};
        revealDeclined.bottom[kind] = true;
    }
    continueAfterFirstTurnCheck('bottom');
}

// 摸牌之后的自摸判断与后续流程（首次摸牌的亮牌选择处理完之后也会走到这里）
function continueAfterFirstTurnCheck(player) {
    if (gameOver) return;
    if (checkHu(hands[player], exposedMelds[player], player)) {
        if (player === 'bottom') {
            offerHu({ mode: 'selfdraw' });
        } else {
            gameOver = true;
            winner = player;
            const winTile = lastDrawnTile[player];
            const before = [...hands[player]];
            before.splice(before.indexOf(winTile), 1);
            const bonus = scoreWinningHand(before, winTile, exposedMelds[player], true, lastDrawWasFinal[player]);
            applyKongBonuses(bonus, player, 'selfdraw', null);
            const result = settleScore(player, 'selfdraw', null, bonus);
            clearKongFlags();
            logFlow(nameOf(player) + ' 自摸胡牌！' + result.detail);
            speak('胡了，自摸');
            learnFromWin(player, null, { fan: bonus.mult, turns: handTurnCount });
            showResultModal(player, 'selfdraw', null, bonus, result, winTile);
        }
        return;
    }

    if (player === 'bottom') {
        // 检查暗杠/加杠机会，可选提示（不挡出牌）
        offerSelfGangIfAny();
        logFlow('轮到你，请点击一张牌出牌');
    } else {
        gameTimeout(() => aiDiscard(player), 700);
    }
}

// 检查自己回合是否可暗杠或加杠，弹出「杠」提示与确认/过按钮（可选，点过或不理会都能继续出牌）
function offerSelfGangIfAny() {
    if (gameOver || pendingClaim) return;
    // 加杠：已碰过的牌，手里又有第4张
    for (const meld of exposedMelds.bottom) {
        if (meld.type === 'peng' && hands.bottom.includes(meld.tiles[0])) {
            pendingClaim = { mode: 'selfGang', kind: 'jia', tile: meld.tiles[0] };
            showIndicator('杠', true);
            logFlow('可以加杠 ' + tileGlyph(meld.tiles[0]) + '，点确认杠 / 点过或直接出牌');
            return;
        }
    }
    // 暗杠：手里4张一样（穷胡规则：不能手把一，最多留3组面子在外，第4组必须留在手里）
    if (exposedMelds.bottom.length < 3) {
        const counts = {};
        hands.bottom.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
        for (const t in counts) {
            if (counts[t] >= 4) {
                pendingClaim = { mode: 'selfGang', kind: 'an', tile: t };
                showIndicator('杠', true);
                logFlow('可以暗杠 ' + tileGlyph(t) + '，点确认杠 / 点过或直接出牌');
                return;
            }
        }
    }
}

function executeSelfGang() {
    if (!pendingClaim || pendingClaim.mode !== 'selfGang') return;
    const { kind, tile } = pendingClaim;
    pendingClaim = null;
    hideIndicator();
    if (kind === 'jia') {
        // 抢杠检查
        const robber = findRonPriority('bottom', tile);
        if (robber && robber !== 'bottom') {
            const idx = hands.bottom.indexOf(tile);
            if (idx > -1) hands.bottom.splice(idx, 1);
            hands[robber].push(tile);
            gameOver = true;
            winner = robber;
            const before = [...hands[robber]];
            before.splice(before.indexOf(tile), 1);
            const bonus = scoreWinningHand(before, tile, exposedMelds[robber], false, false);
            // 抢杠按点炮结算（不加杠后点炮；抢杠本身已是特殊）
            const result = settleScore(robber, 'dianpao', 'bottom', bonus);
            clearKongFlags();
            logFlow(nameOf(robber) + ' 抢杠胡了你加杠的 ' + tileGlyph(tile) + '！' + result.detail);
            speak('胡了，' + voiceName('bottom') + '点炮');
            learnFromWin(robber, 'bottom', { fan: bonus.mult, turns: handTurnCount });
            render();
            showResultModal(robber, 'dianpao', 'bottom', bonus, result, tile);
            return;
        }
        const idx = hands.bottom.indexOf(tile);
        if (idx > -1) hands.bottom.splice(idx, 1);
        for (const meld of exposedMelds.bottom) {
            if (meld.type === 'peng' && meld.tiles[0] === tile) {
                meld.type = 'gang';
                meld.tiles.push(tile);
                break;
            }
        }
        logFlow('你加杠了 ' + tileGlyph(tile) + '，补牌中...');
        speak('杠' + tileName(tile));
        render();
        drawReplacementAndContinue();
        return;
    }
    // 暗杠
    if (exposedMelds.bottom.length >= 3) { logFlow('穷胡规则：不能手把一，最后一组必须留在手里'); return; }
    for (let i = 0; i < 4; i++) {
        const idx = hands.bottom.indexOf(tile);
        if (idx > -1) hands.bottom.splice(idx, 1);
    }
    exposedMelds.bottom.push({ type: 'gang', tiles: [tile, tile, tile, tile], concealed: true });
    logFlow('你暗杠了 ' + tileGlyph(tile) + '，补牌中...');
    speak('杠' + tileName(tile));
    render();
    drawReplacementAndContinue();
}

function nextTurn() {
    if (gameOver) return;
    if (deck.length <= DEAD_WALL) { declareDraw(); return; }
    handTurnCount++;
    const player = turnOrder[currentIndex];
    const drawn = deck.pop();
    hands[player].push(drawn);
    hands[player].sort(tileCompare);
    lastDrawnTile[player] = drawn;
    lastDrawWasFinal[player] = deck.length === DEAD_WALL;
    if (player === 'bottom') { lastDrawnIndex = hands.bottom.lastIndexOf(drawn); selectedIndex = null; }
    // 普通摸牌不是杠上开花
    if (afterKongDrawPlayer === player) { /* 保留：仅杠补牌路径会 mark */ }
    validateHandCounts('nextTurn');
    render();
    highlightActive(player);

    const wasFirstTurn = !!firstTurnPending[player];
    if (wasFirstTurn) {
        firstTurnPending[player] = false;
        // 日常：旧版首巡亮牌逻辑（一字不改）
        if (typeof isDailyMode === 'function' && isDailyMode()) {
            const kind = checkWindDragonPattern(hands[player]);
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
    if (typeof isDailyMode === 'function' && !isDailyMode()) {
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
