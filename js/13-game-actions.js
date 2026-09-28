function startGame() {
    rotateDealer();
    initGame();
    // 结算里手动调过的积分、新一局的庄家/牌面立刻落盘，不等 400ms 防抖
    flushSaveProgress();
}


// 点过：主动放弃当前可以碰/吃/杠的机会，不用等10秒超时
function declineClaim() {
    if (!pendingClaim) { logFlow('现在没有可以碰/吃/杠的牌'); return; }
    if (pendingClaim.mode === 'diceMenu') return;
    const mode = pendingClaim.mode;
    const fromPlayer = pendingClaim.fromPlayer;
    const tile = pendingClaim.tile;
    pendingClaim = null;
    hideIndicator();
    if (mode === 'nextGame') {
        startGame(); // 流局后点过也开下一局
        return;
    }
    if (mode === 'selfGang') {
        logFlow('你选择不杠，请出牌');
        return; // 自己回合，继续等你出牌
    }
    logFlow('你选择不吃/碰/杠');
    resolveAiPengOrAdvance(fromPlayer, tile);
}

// 直接判定胡牌并结算：不再需要逐项确认条件，一步到位显示胡牌内容
function offerHu(ctx) {
    hideIndicator();
    let winTile, before, isSelfDraw, isLastTile, payer = null;
    if (ctx.mode === 'dianpao') {
        winTile = ctx.tile;
        before = [...hands.bottom];
        // 抢杠：这张牌是从 AI 手里被加杠的牌，并不在弃牌堆里，不能 pop（否则会误删一张无关弃牌）
        if (!ctx.robGang) discardPile.pop();
        hands.bottom.push(ctx.tile);
        isSelfDraw = false;
        isLastTile = false;
        payer = ctx.fromPlayer;
    } else {
        winTile = lastDrawnTile.bottom;
        before = [...hands.bottom];
        const idx = before.indexOf(winTile);
        if (idx > -1) before.splice(idx, 1);
        isSelfDraw = true;
        isLastTile = lastDrawWasFinal.bottom;
    }

    const bonus = scoreWinningHand(before, winTile, exposedMelds.bottom, isSelfDraw, isLastTile);
    const mode = isSelfDraw ? 'selfdraw' : 'dianpao';
    applyKongBonuses(bonus, 'bottom', mode, payer);
    gameOver = true;
    winner = 'bottom';
    const result = isSelfDraw
        ? settleScore('bottom', 'selfdraw', null, bonus)
        : settleScore('bottom', 'dianpao', payer, bonus);
    clearKongFlags();
    logFlow('你胡牌了！' + result.detail);
    speak(isSelfDraw ? '胡了，自摸' : '胡了，' + voiceName(payer) + '点炮');
    learnFromWin('bottom', payer, { fan: bonus.mult, turns: handTurnCount });
    render();
    showResultModal('bottom', isSelfDraw ? 'selfdraw' : 'dianpao', payer, bonus, result, winTile);
}

function callPeng() {
    if (!pendingClaim || !pendingClaim.canPeng) { logFlow('现在不能碰'); return; }
    const { tile, fromPlayer } = pendingClaim;
    discardPile.pop(); // 这张牌被拿走，不再留在弃牌堆
    takeTilesFromHand('bottom', tile, 2);
    exposedMelds.bottom.push({ type: 'peng', tiles: [tile, tile, tile] });
    pendingClaim = null;
    currentIndex = turnOrder.indexOf('bottom');
    hideIndicator();
    selectedIndex = null;
    lastDrawnIndex = null;
    logFlow('你碰了 ' + tileGlyph(tile) + '（' + nameOf(fromPlayer) + '打出），请出牌');
    speak('碰' + tileName(tile));
    render();
}

function callChi() {
    if (!pendingClaim || !pendingClaim.chiCombos || !pendingClaim.chiCombos.length) { logFlow('现在不能吃'); return; }
    if (pendingClaim.chiCombos.length === 1) {
        executeChi(pendingClaim.chiCombos[0]);
        return;
    }
    // 有两种以上吃法，弹窗给选择权（冷色紧凑牌面，与结算页一致）
    const opts = $('chi-choice-options');
    opts.innerHTML = pendingClaim.chiCombos.map((combo, i) => {
        const tiles = [...combo, pendingClaim.tile].sort(tileCompare);
        const tilesHtml = tiles.map(t =>
            `<div class="tile-wrap"><div class="tile-marker"></div><div class="tile exposed">${tileImg(t)}</div></div>`
        ).join('');
        return `<div class="hu-opt enabled" onclick="chooseChiCombo(${i})">${tilesHtml}</div>`;
    }).join('');
    $('chi-choice-modal').classList.add('show');
}

function chooseChiCombo(i) {
    const combo = pendingClaim.chiCombos[i];
    $('chi-choice-modal').classList.remove('show');
    executeChi(combo);
}

/** 取消吃法选择 = 过牌，交给 AI 碰/下家流程 */
function closeChiChoice() {
    $('chi-choice-modal').classList.remove('show');
    if (pendingClaim && pendingClaim.mode === 'claim') declineClaim();
}

function executeChi(combo) {
    const { tile } = pendingClaim;
    discardPile.pop();
    combo.forEach(t => {
        const idx = hands.bottom.indexOf(t);
        if (idx > -1) hands.bottom.splice(idx, 1);
    });
    const meldTiles = [...combo, tile].sort(tileCompare);
    exposedMelds.bottom.push({ type: 'chi', tiles: meldTiles });
    pendingClaim = null;
    currentIndex = turnOrder.indexOf('bottom');
    hideIndicator();
    selectedIndex = null;
    lastDrawnIndex = null;
    logFlow('你吃了 ' + tileGlyph(tile) + '，请出牌');
    speak('吃' + tileName(tile));
    render();
}


// ---------- 你自己的操作：点确认 / 杠 / 杠后补牌 / 点牌出牌（原先放在 11-ai-discard-claim.js） ----------
// 点确认：按 杠 > 碰 > 吃 优先级执行
function acceptClaim() {
    if (!pendingClaim) return;
    if (pendingClaim.mode === 'diceMenu') return; // 清零菜单用专用按钮，不走确认
    if (pendingClaim.mode === 'nextGame') {
        pendingClaim = null;
        hideIndicator();
        startGame();
        return;
    }
    if (pendingClaim.mode === 'selfGang') {
        executeSelfGang();
        return;
    }
    // 别人打牌的吃碰杠
    if (pendingClaim.canGang) { callGang(); return; }
    if (pendingClaim.canPeng) { callPeng(); return; }
    if (pendingClaim.chiCombos && pendingClaim.chiCombos.length) { callChi(); return; }
}

function callGang() {
    if (gameOver) { logFlow('本局已结束'); return; }
    // 明杠：别人打出的牌，手里已有3张（由 acceptClaim 在 canGang 时调用）
    // 加杠/暗杠走 executeSelfGang，不在此重复
    if (!pendingClaim || !pendingClaim.canGang) { logFlow('现在不能杠'); return; }
    const { tile, fromPlayer } = pendingClaim;
    discardPile.pop();
    takeTilesFromHand('bottom', tile, 3);
    exposedMelds.bottom.push({ type: 'gang', tiles: [tile, tile, tile, tile], concealed: false });
    pendingClaim = null;
    currentIndex = turnOrder.indexOf('bottom');
    hideIndicator();
    logFlow('你杠了 ' + tileGlyph(tile) + '（' + nameOf(fromPlayer) + '打出），补牌中...');
    speak('杠' + tileName(tile));
    render();
    drawReplacementAndContinue();
}

// 杠后从牌墙补一张，检查杠上开花，否则等你出牌
function drawReplacementAndContinue() {
    if (deck.length <= DEAD_WALL) { declareDraw(); return; }
    const drawn = deck.pop();
    hands.bottom.push(drawn);
    hands.bottom.sort(tileCompare);
    lastDrawnTile.bottom = drawn;
    lastDrawWasFinal.bottom = deck.length === DEAD_WALL;
    lastDrawnIndex = hands.bottom.lastIndexOf(drawn);
    selectedIndex = null;
    markKongDraw('bottom');
    validateHandCounts('drawReplacement');
    render();
    if (checkHu(hands.bottom, exposedMelds.bottom, 'bottom')) {
        offerHu({ mode: 'selfdraw' }); // 杠上开花×2 在 offerHu/applyKongBonuses
        return;
    }
    offerSelfGangIfAny();
    logFlow('补牌：' + tileGlyph(drawn) + '，请出牌');
}

function handleDiscard(event) {
    if (gameOver) return;
    // 手里必须是"待出牌"的张数（暗牌数 %3==2）才能选牌/出牌：
    // 新局刚发完牌时，庄家（你）手里是13张、第一张牌要600ms后才自动摸——这个空档里连点两下同一张牌，
    // 会把13张打成12张，摸牌步骤又已经错过，这一局就永久少一张牌（暗牌12张/副露0）
    if (hands.bottom.length % 3 !== 2) return;
    // 别人打牌的吃碰杠必须先处理；自己的可选杠不挡出牌
    if (pendingClaim && pendingClaim.mode !== 'selfGang') return;
    if (pendingClaim && pendingClaim.mode === 'selfGang') {
        pendingClaim = null;
        hideIndicator();
    }
    if (turnOrder[currentIndex] !== 'bottom') return; // 不是你的回合
    const target = event.target.closest('.tile');
    if (!target || target.dataset.index === undefined) return;
    const idx = parseInt(target.dataset.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= hands.bottom.length) return;

    if (selectedIndex !== idx) {
        // 第一次点这张（或改按了别的牌）：标记▼等待确认，不真正出牌
        selectedIndex = idx;
        render();
        return;
    }

    // 再次点同一张：真正打出
    const card = hands.bottom[idx];
    hands.bottom.splice(idx, 1);
    markKongDiscardIfNeeded('bottom');
    discardPile.push({ player: 'bottom', tile: card });
    selectedIndex = null;
    lastDrawnIndex = null;
    speak(tileName(card));
    logFlow('你打出了 ' + tileGlyph(card));
    validateHandCounts('handleDiscard');
    render();

    // 检查是否有AI能胡你打出的这张牌
    const ronPlayer = findRonPriority('bottom', card);
    if (ronPlayer) {
        discardPile.pop();
        hands[ronPlayer].push(card);
        gameOver = true;
        winner = ronPlayer;
        const before = [...hands[ronPlayer]];
        before.splice(before.indexOf(card), 1);
        const bonus = scoreWinningHand(before, card, exposedMelds[ronPlayer], false, false);
        applyKongBonuses(bonus, ronPlayer, 'dianpao', 'bottom');
        const result = settleScore(ronPlayer, 'dianpao', 'bottom', bonus);
        clearKongFlags();
        logFlow(nameOf(ronPlayer) + ' 点炮胡了你打出的牌！' + result.detail);
        speak('胡了，' + voiceName('bottom') + '点炮');
        learnFromWin(ronPlayer, 'bottom', { fan: bonus.mult, turns: handTurnCount });
        render();
        showResultModal(ronPlayer, 'dianpao', 'bottom', bonus, result, card);
        return;
    }
    if (afterKongDiscardPlayer === 'bottom') afterKongDiscardPlayer = null;
    resolveAiPengOrAdvance('bottom', card);
}

// 弹窗打开时锁定页面滚动，避免底层与弹层抢惯性
function syncBodyScrollLock() {
    const ids = ['result-modal', 'reveal-modal', 'chi-choice-modal', 'pool-modal', 'player-intro-modal'];
    const open = ids.some(id => {
        const el = $(id);
        return el && el.classList.contains('show');
    });
    const body = document.body;
    if (open) {
        if (!body.classList.contains('modal-open')) {
            body.dataset.scrollY = String(window.scrollY || window.pageYOffset || 0);
            body.classList.add('modal-open');
            body.style.top = `-${body.dataset.scrollY}px`;
        }
    } else if (body.classList.contains('modal-open')) {
        const y = parseInt(body.dataset.scrollY || '0', 10) || 0;
        body.classList.remove('modal-open');
        body.style.top = '';
        delete body.dataset.scrollY;
        window.scrollTo(0, y);
        if (typeof scheduleAutoFitBurst === 'function') scheduleAutoFitBurst(); // 弹窗期间跳过的自动适配，关闭后补做
    }
}
(function watchModalsForScrollLock() {
    const ids = ['result-modal', 'reveal-modal', 'chi-choice-modal', 'pool-modal', 'player-intro-modal'];
    const obs = new MutationObserver(syncBodyScrollLock);
    ids.forEach(id => {
        const el = $(id);
        if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
})();


/** 按住牌桌上下拖动：平移整个界面（不改规则逻辑） */
const VIEW_PAN_STORAGE_KEY = 'qionghu_mahjong_view_pan_y_v1';
const VIEW_PAN_MAX = 180; /* px，相对中心上下限 */
let viewPanY = 0;
let panDrag = null; // { startY, startPan }

function loadSavedViewPan() {
    try {
        const raw = localStorage.getItem(VIEW_PAN_STORAGE_KEY);
        if (raw == null) return 0;
        const n = parseFloat(raw);
        return isFinite(n) ? n : 0;
    } catch (e) { return 0; }
}
// persist=true 才写 localStorage：拖动过程中每次 pointermove 都同步写盘会造成卡顿，
// 所以拖动时只更新 CSS 变量，松手（onEnd）时再存一次
function applyViewPan(persist) {
    viewPanY = Math.max(-VIEW_PAN_MAX, Math.min(VIEW_PAN_MAX, viewPanY));
    document.documentElement.style.setProperty('--view-pan-y', viewPanY.toFixed(1) + 'px');
    if (persist) {
        try { localStorage.setItem(VIEW_PAN_STORAGE_KEY, String(viewPanY)); } catch (e) {}
    }
}
function initTablePan() {
    const wrap = document.getElementById('table-wrap');
    const frame = document.getElementById('table-frame');
    if (!wrap || !frame) return;
    viewPanY = loadSavedViewPan();
    applyViewPan(false);

    const isInteractive = (t) => !!(t && t.closest && t.closest(
        '.tile, .tileback, .discardTile, .pool-tile, .player-label, button, .meld-group, #claim-indicator, #wall-count, #landscape-ctrl, #discard-query-btn, #discardWall, #pool-modal, #result-modal, #reveal-modal, #chi-choice-modal, #player-intro-modal, img, .claim-btn, .reset-btn, .avatar, input'
    ));

    const onStart = (clientY, target) => {
        if (isInteractive(target)) return false;
        if (document.body.classList.contains('modal-open')) return false;
        panDrag = { startY: clientY, startPan: viewPanY };
        wrap.classList.add('panning');
        return true;
    };
    const onMove = (clientY) => {
        if (!panDrag) return;
        const dy = clientY - panDrag.startY;
        viewPanY = panDrag.startPan + dy;
        applyViewPan(false);
    };
    const onEnd = () => {
        if (!panDrag) return;
        panDrag = null;
        wrap.classList.remove('panning');
        applyViewPan(true);
    };

    frame.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (!onStart(e.clientY, e.target)) return;
        try { frame.setPointerCapture(e.pointerId); } catch (err) {}
    });
    frame.addEventListener('pointermove', (e) => {
        if (!panDrag) return;
        onMove(e.clientY);
    });
    frame.addEventListener('pointerup', onEnd);
    frame.addEventListener('pointercancel', onEnd);
    // 避免拖动时触发三连击骰子：移动超过阈值则清空 tap
    frame.addEventListener('pointermove', (e) => {
        if (!panDrag) return;
        if (Math.abs(e.clientY - panDrag.startY) > 8) {
            tableTapTimes = [];
        }
    });
}

initTablePan();
/** 桌面鼠标端：右键点在牌面/牌背/副露上容易弹出浏览器"另存为图片"菜单，这里统一拦截
    （头像的右键拦截已在 09-turn-settlement.js / 15-stat-avatar-longpress.js 里做了） */
document.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('.tile, .tileback, .discardTile, .pool-tile, .meld-group')) {
        e.preventDefault();
    }
}, true);
initDicePips();
// 先按原始比例量一次桌面，记下「正常大小」，再应用（可能已保存的）缩放
viewScale = ORIGINAL_VIEW_SCALE;
document.documentElement.style.setProperty('--view-scale', '1');
setTimeout(() => {
    captureOriginalViewSize();
    if (AUTO_FIT_LANDSCAPE) {
        // 横屏自动适配接管：不再读取以前手动保存的缩放/平移，按当前可视区域自动算（竖屏不处理）
        _autoFitReady = true;
        autoFitLandscapeView();
        scheduleAutoFitBurst();
    } else {
        viewScale = loadSavedViewScale();
        applyViewScale();
    }
}, 0);
// 启动：有完整存档则原样恢复，否则显示模式选择（2.0 一期）
if (loadGameProgress()) {
    resumeFromSave();
} else {
    // 等所有脚本加载完再弹模式选择
    setTimeout(() => {
        if (typeof openModeSelect === 'function') openModeSelect();
        else initGame(); // 兜底：规则模块未加载时直接开局
    }, 50);
}
