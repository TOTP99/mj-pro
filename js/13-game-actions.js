;(function(){
function startGame() {
    Game.rotateDealer();
    Game.initGame();
    // 结算里手动调过的积分、新一局的庄家/牌面立刻落盘，不等 400ms 防抖
    Game.flushSaveProgress();
}


// 点过：主动放弃当前可以碰/吃/杠的机会，不用等10秒超时
function declineClaim() {
    if (!Game.pendingClaim) { Game.logFlow('现在没有可以碰/吃/杠的牌'); return; }
    if (Game.pendingClaim.mode === 'diceMenu') return;
    const mode = Game.pendingClaim.mode;
    const fromPlayer = Game.pendingClaim.fromPlayer;
    const tile = Game.pendingClaim.tile;
    Game.pendingClaim = null;
    Game.hideIndicator();
    if (mode === 'nextGame') {
        startGame(); // 流局后点过也开下一局
        return;
    }
    if (mode === 'selfGang') {
        Game.logFlow('你选择不杠，请出牌');
        Game.setPhase(Game.PHASE.WAIT_DISCARD, 'declineClaim/selfGang');
        return; // 自己回合，继续等你出牌
    }
    Game.logFlow('你选择不吃/碰/杠');
    Game.resolveAiPengOrAdvance(fromPlayer, tile);
}

// 直接判定胡牌并结算：不再需要逐项确认条件，一步到位显示胡牌内容
function offerHu(ctx) {
    Game.hideIndicator();
    let winTile, before, isSelfDraw, isLastTile, payer = null;
    if (ctx.mode === 'dianpao') {
        winTile = ctx.tile;
        before = [...Game.hands.bottom];
        // 抢杠：这张牌从 AI 手里直接转给你；普通点炮：弃牌堆顶拿给你（原子操作）
        if (ctx.robGang) Game.TileFlow.transfer(ctx.fromPlayer, 'bottom', ctx.tile);
        else Game.TileFlow.takeDiscardToHand('bottom');
        isSelfDraw = false;
        isLastTile = false;
        payer = ctx.fromPlayer;
    } else {
        winTile = Game.lastDrawnTile.bottom;
        before = [...Game.hands.bottom];
        const idx = before.indexOf(winTile);
        if (idx > -1) before.splice(idx, 1);
        isSelfDraw = true;
        isLastTile = Game.lastDrawWasFinal.bottom;
    }

    const bonus = Game.scoreWinningHand(before, winTile, Game.exposedMelds.bottom, isSelfDraw, isLastTile);
    const mode = isSelfDraw ? 'selfdraw' : 'dianpao';
    Game.applyKongBonuses(bonus, 'bottom', mode, payer);
    Game.gameOver = true;
    Game.winner = 'bottom';
    const result = isSelfDraw
        ? Game.settleScore('bottom', 'selfdraw', null, bonus)
        : Game.settleScore('bottom', 'dianpao', payer, bonus);
    Game.clearKongFlags();
    Game.logFlow('你胡牌了！' + result.detail);
    Game.speak(isSelfDraw ? '胡了，自摸' : '胡了，' + Game.voiceName(payer) + '点炮');
    Game.learnFromWin('bottom', payer, { fan: bonus.mult, turns: Game.handTurnCount });
    Game.render();
    Game.showResultModal('bottom', isSelfDraw ? 'selfdraw' : 'dianpao', payer, bonus, result, winTile);
}

function callPeng() {
    if (!Game.pendingClaim || !Game.pendingClaim.canPeng) { Game.logFlow('现在不能碰'); return; }
    const { tile, fromPlayer } = Game.pendingClaim;
    Game.TileFlow.claim('bottom', 'peng', [tile, tile]);
    Game.pendingClaim = null;
    Game.currentIndex = Game.turnOrder.indexOf('bottom');
    Game.hideIndicator();
    Game.selectedIndex = null;
    Game.lastDrawnIndex = null;
    Game.logFlow('你碰了 ' + Game.tileGlyph(tile) + '（' + Game.nameOf(fromPlayer) + '打出），请出牌');
    Game.speak('碰' + Game.tileName(tile));
    Game.render();
    Game.setPhase(Game.PHASE.WAIT_DISCARD, 'callPeng');
}

function callChi() {
    if (!Game.pendingClaim || !Game.pendingClaim.chiCombos || !Game.pendingClaim.chiCombos.length) { Game.logFlow('现在不能吃'); return; }
    if (Game.pendingClaim.chiCombos.length === 1) {
        executeChi(Game.pendingClaim.chiCombos[0]);
        Game.setPhase(Game.PHASE.WAIT_DISCARD, 'callChi');
        return;
    }
    // 有两种以上吃法，弹窗给选择权（冷色紧凑牌面，与结算页一致）
    Game.setPhase(Game.PHASE.CHI_CHOICE, 'callChi');
    const opts = Game.$('chi-choice-options');
    opts.innerHTML = Game.pendingClaim.chiCombos.map((combo, i) => {
        const tiles = [...combo, Game.pendingClaim.tile].sort(Game.tileCompare);
        const tilesHtml = tiles.map(t =>
            `<div class="tile-wrap"><div class="tile-marker"></div><div class="tile exposed">${Game.tileImg(t)}</div></div>`
        ).join('');
        return `<div class="hu-opt enabled" onclick="Game.chooseChiCombo(${i})">${tilesHtml}</div>`;
    }).join('');
    Game.$('chi-choice-modal').classList.add('show');
}

function chooseChiCombo(i) {
    const combo = Game.pendingClaim.chiCombos[i];
    Game.$('chi-choice-modal').classList.remove('show');
    executeChi(combo);
    Game.setPhase(Game.PHASE.WAIT_DISCARD, 'chooseChiCombo');
}

/** 取消吃法选择 = 过牌，交给 AI 碰/下家流程 */
function closeChiChoice() {
    Game.$('chi-choice-modal').classList.remove('show');
    if (Game.pendingClaim && Game.pendingClaim.mode === 'claim') declineClaim();
}

function executeChi(combo) {
    const { tile } = Game.pendingClaim;
    Game.TileFlow.claim('bottom', 'chi', combo, Game.tileCompare);
    Game.pendingClaim = null;
    Game.currentIndex = Game.turnOrder.indexOf('bottom');
    Game.hideIndicator();
    Game.selectedIndex = null;
    Game.lastDrawnIndex = null;
    Game.logFlow('你吃了 ' + Game.tileGlyph(tile) + '，请出牌');
    Game.speak('吃' + Game.tileName(tile));
    Game.render();
}


// ---------- 你自己的操作：点确认 / 杠 / 杠后补牌 / 点牌出牌（原先放在 11-ai-discard-claim.js） ----------
// 点确认：按 杠 > 碰 > 吃 优先级执行
function acceptClaim() {
    if (!Game.pendingClaim) return;
    if (Game.pendingClaim.mode === 'diceMenu') return; // 清零菜单用专用按钮，不走确认
    if (Game.pendingClaim.mode === 'nextGame') {
        Game.pendingClaim = null;
        Game.hideIndicator();
        startGame();
        return;
    }
    if (Game.pendingClaim.mode === 'selfGang') {
        Game.executeSelfGang();
        return;
    }
    // 别人打牌的吃碰杠
    if (Game.pendingClaim.canGang) { callGang(); return; }
    if (Game.pendingClaim.canPeng) { callPeng(); return; }
    if (Game.pendingClaim.chiCombos && Game.pendingClaim.chiCombos.length) { callChi(); return; }
}

function callGang() {
    if (Game.gameOver) { Game.logFlow('本局已结束'); return; }
    // 明杠：别人打出的牌，手里已有3张（由 acceptClaim 在 canGang 时调用）
    // 加杠/暗杠走 executeSelfGang，不在此重复
    if (!Game.pendingClaim || !Game.pendingClaim.canGang) { Game.logFlow('现在不能杠'); return; }
    const { tile, fromPlayer } = Game.pendingClaim;
    Game.TileFlow.claim('bottom', 'gang', [tile, tile, tile], null, { concealed: false });
    Game.pendingClaim = null;
    Game.currentIndex = Game.turnOrder.indexOf('bottom');
    Game.hideIndicator();
    Game.logFlow('你杠了 ' + Game.tileGlyph(tile) + '（' + Game.nameOf(fromPlayer) + '打出），补牌中...');
    Game.speak('杠' + Game.tileName(tile));
    Game.render();
    drawReplacementAndContinue();
}

// 杠后从牌墙补一张，检查杠上开花，否则等你出牌
function drawReplacementAndContinue() {
    Game.setPhase(Game.PHASE.REPLACEMENT, 'drawReplacementAndContinue');
    if (Game.deck.length <= Game.DEAD_WALL) { Game.declareDraw(); return; }
    const drawn = Game.TileFlow.draw('bottom', 'replacement');
    Game.hands.bottom.sort(Game.tileCompare);
    Game.lastDrawnTile.bottom = drawn;
    Game.lastDrawWasFinal.bottom = Game.deck.length === Game.DEAD_WALL;
    Game.lastDrawnIndex = Game.hands.bottom.lastIndexOf(drawn);
    Game.selectedIndex = null;
    Game.markKongDraw('bottom');
    Game.validateHandCounts('drawReplacement');
    Game.render();
    if (Game.checkHu(Game.hands.bottom, Game.exposedMelds.bottom, 'bottom')) {
        offerHu({ mode: 'selfdraw' }); // 杠上开花×2 在 offerHu/applyKongBonuses
        return;
    }
    Game.offerSelfGangIfAny();
    if (!Game.pendingClaim) Game.setPhase(Game.PHASE.WAIT_DISCARD, 'drawReplacementAndContinue');
    Game.logFlow('补牌：' + Game.tileGlyph(drawn) + '，请出牌');
}

function handleDiscard(event) {
    if (Game.gameOver) return;
    // 手里必须是"待出牌"的张数（暗牌数 %3==2）才能选牌/出牌：
    // 新局刚发完牌时，庄家（你）手里是13张、第一张牌要600ms后才自动摸——这个空档里连点两下同一张牌，
    // 会把13张打成12张，摸牌步骤又已经错过，这一局就永久少一张牌（暗牌12张/副露0）
    if (Game.hands.bottom.length % 3 !== 2) return;
    // 别人打牌的吃碰杠必须先处理；自己的可选杠不挡出牌
    if (Game.pendingClaim && Game.pendingClaim.mode !== 'selfGang') return;
    if (Game.pendingClaim && Game.pendingClaim.mode === 'selfGang') {
        Game.pendingClaim = null;
        Game.hideIndicator();
    }
    if (Game.turnOrder[Game.currentIndex] !== 'bottom') return; // 不是你的回合
    const target = event.target.closest('.tile');
    if (!target || target.dataset.index === undefined) return;
    const idx = parseInt(target.dataset.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= Game.hands.bottom.length) return;

    if (Game.selectedIndex !== idx) {
        // 第一次点这张（或改按了别的牌）：标记▼等待确认，不真正出牌
        Game.selectedIndex = idx;
        Game.render();
        return;
    }

    // 再次点同一张：真正打出
    const card = Game.hands.bottom[idx];
    Game.TileFlow.discard('bottom', card);
    Game.markKongDiscardIfNeeded('bottom');
    Game.selectedIndex = null;
    Game.lastDrawnIndex = null;
    Game.speak(Game.tileName(card));
    Game.logFlow('你打出了 ' + Game.tileGlyph(card));
    Game.validateHandCounts('handleDiscard');
    Game.render();

    // 检查是否有AI能胡你打出的这张牌
    const ronPlayer = Game.findRonPriority('bottom', card);
    if (ronPlayer) {
        Game.TileFlow.takeDiscardToHand(ronPlayer);
        Game.gameOver = true;
        Game.winner = ronPlayer;
        const before = [...Game.hands[ronPlayer]];
        before.splice(before.indexOf(card), 1);
        const bonus = Game.scoreWinningHand(before, card, Game.exposedMelds[ronPlayer], false, false);
        Game.applyKongBonuses(bonus, ronPlayer, 'dianpao', 'bottom');
        const result = Game.settleScore(ronPlayer, 'dianpao', 'bottom', bonus);
        Game.clearKongFlags();
        Game.logFlow(Game.nameOf(ronPlayer) + ' 点炮胡了你打出的牌！' + result.detail);
        Game.speak('胡了，' + Game.voiceName('bottom') + '点炮');
        Game.learnFromWin(ronPlayer, 'bottom', { fan: bonus.mult, turns: Game.handTurnCount });
        Game.render();
        Game.showResultModal(ronPlayer, 'dianpao', 'bottom', bonus, result, card);
        return;
    }
    if (Game.afterKongDiscardPlayer === 'bottom') Game.afterKongDiscardPlayer = null;
    Game.resolveAiPengOrAdvance('bottom', card);
}

// 弹窗打开时锁定页面滚动，避免底层与弹层抢惯性
function syncBodyScrollLock() {
    const ids = ['result-modal', 'reveal-modal', 'chi-choice-modal', 'pool-modal', 'player-intro-modal',
                 'mode-select-modal', 'rules-modal', 'amount-modal', 'bust-modal', 'round-modal'];
    const open = ids.some(id => {
        const el = Game.$(id);
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
        if (typeof Game.scheduleAutoFitBurst === 'function') Game.scheduleAutoFitBurst(); // 弹窗期间跳过的自动适配，关闭后补做
    }
}
(function watchModalsForScrollLock() {
    const ids = ['result-modal', 'reveal-modal', 'chi-choice-modal', 'pool-modal', 'player-intro-modal',
                 'mode-select-modal', 'rules-modal', 'amount-modal', 'bust-modal', 'round-modal'];
    const obs = new MutationObserver(syncBodyScrollLock);
    ids.forEach(id => {
        const el = Game.$(id);
        if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
})();


/** 按住牌桌上下拖动：平移整个界面（不改规则逻辑） */
const VIEW_PAN_STORAGE_KEY = 'qionghu_mahjong_view_pan_y_v1';
const VIEW_PAN_MAX = 180; /* px，相对中心上下限 */
Game.viewPanY = 0;
Game.panDrag = null; // { startY, startPan }

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
    Game.viewPanY = Math.max(-VIEW_PAN_MAX, Math.min(VIEW_PAN_MAX, Game.viewPanY));
    document.documentElement.style.setProperty('--view-pan-y', Game.viewPanY.toFixed(1) + 'px');
    if (persist) {
        try { localStorage.setItem(VIEW_PAN_STORAGE_KEY, String(Game.viewPanY)); } catch (e) {}
    }
}
function initTablePan() {
    const wrap = document.getElementById('table-wrap');
    const frame = document.getElementById('table-frame');
    if (!wrap || !frame) return;
    Game.viewPanY = loadSavedViewPan();
    applyViewPan(false);

    const isInteractive = (t) => !!(t && t.closest && t.closest(
        '.tile, .tileback, .discardTile, .pool-tile, .player-label, button, .meld-group, #claim-indicator, #wall-count, #landscape-ctrl, #discard-query-btn, #discardWall, #pool-modal, #result-modal, #reveal-modal, #chi-choice-modal, #player-intro-modal, img, .claim-btn, .reset-btn, .avatar, input'
    ));

    const onStart = (clientY, target) => {
        if (isInteractive(target)) return false;
        if (document.body.classList.contains('modal-open')) return false;
        Game.panDrag = { startY: clientY, startPan: Game.viewPanY };
        wrap.classList.add('panning');
        return true;
    };
    const onMove = (clientY) => {
        if (!Game.panDrag) return;
        const dy = clientY - Game.panDrag.startY;
        Game.viewPanY = Game.panDrag.startPan + dy;
        applyViewPan(false);
    };
    const onEnd = () => {
        if (!Game.panDrag) return;
        Game.panDrag = null;
        wrap.classList.remove('panning');
        applyViewPan(true);
    };

    frame.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (!onStart(e.clientY, e.target)) return;
        try { frame.setPointerCapture(e.pointerId); } catch (err) {}
    });
    frame.addEventListener('pointermove', (e) => {
        if (!Game.panDrag) return;
        onMove(e.clientY);
    });
    frame.addEventListener('pointerup', onEnd);
    frame.addEventListener('pointercancel', onEnd);
    // 避免拖动时触发三连击骰子：移动超过阈值则清空 tap
    frame.addEventListener('pointermove', (e) => {
        if (!Game.panDrag) return;
        if (Math.abs(e.clientY - Game.panDrag.startY) > 8) {
            Game.tableTapTimes = [];
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
Game.initDicePips();
// 先按原始比例量一次桌面，记下「正常大小」，再应用（可能已保存的）缩放
Game.viewScale = Game.ORIGINAL_VIEW_SCALE;
document.documentElement.style.setProperty('--view-scale', '1');
setTimeout(() => {
    Game.captureOriginalViewSize();
    if (Game.AUTO_FIT_LANDSCAPE) {
        // 横屏自动适配接管：不再读取以前手动保存的缩放/平移，按当前可视区域自动算（竖屏不处理）
        Game._autoFitReady = true;
        Game.autoFitLandscapeView();
        Game.scheduleAutoFitBurst();
    } else {
        Game.viewScale = Game.loadSavedViewScale();
        Game.applyViewScale();
    }
}, 0);
// 启动：有完整存档则原样恢复，否则显示模式选择（2.0 一期）
if (Game.loadGameProgress()) {
    Game.resumeFromSave();
} else {
    // 等所有脚本加载完再弹模式选择
    setTimeout(() => {
        if (typeof Game.openModeSelect === 'function') Game.openModeSelect();
        else Game.initGame(); // 兜底：规则模块未加载时直接开局
    }, 50);
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.startGame = startGame;
Game.declineClaim = declineClaim;
Game.offerHu = offerHu;
Game.callChi = callChi;
Game.chooseChiCombo = chooseChiCombo;
Game.closeChiChoice = closeChiChoice;
Game.acceptClaim = acceptClaim;
Game.drawReplacementAndContinue = drawReplacementAndContinue;
Game.handleDiscard = handleDiscard;

;})();
