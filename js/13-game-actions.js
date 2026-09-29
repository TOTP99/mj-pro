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

    const bonus = Game.scoreWinningHand(before, winTile, Game.exposedMelds.bottom, isLastTile);
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
    Game.requestRender('offerHu');
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
    Game.sfx.peng(); Game.feel.banner('碰！');
    Game.requestRender('callPeng');
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
    Game.sfx.chi(); Game.feel.banner('吃！');
    Game.requestRender('executeChi');
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
    Game.sfx.gang(); Game.feel.banner('杠！');
    Game.requestRender('callGang');
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
    Game._drawnAnimPlayed = false; // 手感：补到的牌也滑入一次
    Game.markKongDraw('bottom');
    Game.validateHandCounts('drawReplacement');
    Game.requestRender('drawReplacement');
    // 杠后补牌与普通摸牌一致：先检查亮牌
    const revealKind = Game.revealKindAfterDraw('bottom');
    if (revealKind) {
        Game.pendingRevealContext = 'replacement';
        Game.offerReveal(revealKind);
        return;
    }
    continueReplacementAfterReveal();
}

// 杠后补牌续行（亮牌弹窗关闭后也会回到这里）：自摸/杠上开花判断 → 可选杠 → 等出牌
function continueReplacementAfterReveal() {
    if (Game.gameOver) return;
    if (Game.checkHu(Game.hands.bottom, Game.exposedMelds.bottom, 'bottom')) {
        offerHu({ mode: 'selfdraw' }); // 杠上开花×2 在 offerHu/applyKongBonuses
        return;
    }
    Game.offerSelfGangIfAny();
    if (!Game.pendingClaim) Game.setPhase(Game.PHASE.WAIT_DISCARD, 'drawReplacementAndContinue');
    Game.logFlow('补牌：' + Game.tileGlyph(Game.lastDrawnTile.bottom) + '，请出牌');
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
        Game.requestRender('handleDiscard/select');
        return;
    }

    // 再次点同一张：真正打出（出牌前先记牌面位置，供飞牌动画用）
    const card = Game.hands.bottom[idx];
    const fromRect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    Game.TileFlow.discard('bottom', card);
    Game.markKongDiscardIfNeeded('bottom');
    Game.selectedIndex = null;
    Game.lastDrawnIndex = null;
    Game.speak(Game.tileName(card));
    Game.logFlow('你打出了 ' + Game.tileGlyph(card));
    Game.validateHandCounts('handleDiscard');
    Game.requestRender('handleDiscard/discard');
    Game.sfx.discard(); // 手感：脆响 + 飞牌落定
    Game.feel.flyDiscard(fromRect, Game.tileImg(card));

    // 检查是否有AI能胡你打出的这张牌
    const ronPlayer = Game.findRonPriority('bottom', card);
    if (ronPlayer) {
        Game.TileFlow.takeDiscardToHand(ronPlayer);
        Game.gameOver = true;
        Game.winner = ronPlayer;
        const before = [...Game.hands[ronPlayer]];
        before.splice(before.indexOf(card), 1);
        const bonus = Game.scoreWinningHand(before, card, Game.exposedMelds[ronPlayer], false);
        Game.applyKongBonuses(bonus, ronPlayer, 'dianpao', 'bottom');
        const result = Game.settleScore(ronPlayer, 'dianpao', 'bottom', bonus);
        Game.clearKongFlags();
        Game.logFlow(Game.nameOf(ronPlayer) + ' 点炮胡了你打出的牌！' + result.detail);
        Game.speak('胡了，' + Game.voiceName('bottom') + '点炮');
        Game.learnFromWin(ronPlayer, 'bottom', { fan: bonus.mult, turns: Game.handTurnCount });
        Game.requestRender('handleDiscard/ron');
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


/** 按住牌桌上下拖动：平移整个界面（不改规则逻辑）；不持久化，刷新恢复默认 */
const VIEW_PAN_MAX = 180; /* px，相对中心上下限 */
Game.viewPanY = 0;
Game.panDrag = null; // { startY, startPan }

/* 拖动不持久化，刷新恢复默认 */
function applyViewPan() {
    Game.viewPanY = Math.max(-VIEW_PAN_MAX, Math.min(VIEW_PAN_MAX, Game.viewPanY));
    document.documentElement.style.setProperty('--view-pan-y', Game.viewPanY.toFixed(1) + 'px');
}
function initTablePan() {
    const wrap = document.getElementById('table-wrap');
    const frame = document.getElementById('table-frame');
    if (!wrap || !frame) return;
    Game.viewPanY = 0;
    applyViewPan();

    const isInteractive = (t) => !!(t && t.closest && t.closest(
        '.tile, .tileback, .discardTile, .pool-tile, .player-label, button, .meld-group, #claim-indicator, #wall-count, #discard-query-btn, #discardWall, #pool-modal, #result-modal, #reveal-modal, #chi-choice-modal, #player-intro-modal, img, .claim-btn, .reset-btn, .avatar, input'
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
        applyViewPan();
    };
    const onEnd = () => {
        if (!Game.panDrag) return;
        Game.panDrag = null;
        wrap.classList.remove('panning');
        applyViewPan();
    };

    frame.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (!onStart(e.clientY, e.target)) return;
        try { frame.setPointerCapture(e.pointerId); } catch (err) {}
    });
    frame.addEventListener('pointermove', (e) => {
        if (!Game.panDrag) return;
        onMove(e.clientY);
        // 避免拖动时触发三连击骰子：移动超过阈值则清空 tap
        if (Math.abs(e.clientY - Game.panDrag.startY) > 8) {
            Game.tableTapTimes = [];
        }
    });
    frame.addEventListener('pointerup', onEnd);
    frame.addEventListener('pointercancel', onEnd);
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
// 横屏 default = 一直以来的原始大小；黄线滑杆/按住拖动都不持久化，刷新即默认
// （viewScale/viewPanY 的归零已在 04 加载与 initTablePan 里做过，这里只显式复位 CSS 变量）
document.documentElement.style.setProperty('--view-scale', '1');
document.documentElement.style.setProperty('--view-pan-y', '0px');
// 启动：等 DOMContentLoaded（此时全部 17 个脚本已执行完）再决定恢复存档还是显示模式选择。
// 4.1 修：resumeFromSave 会走渲染链路，依赖 16/17 的规则函数；之前在 13 加载时同步执行，
// Game.ruleAllowsSevenPairs 等尚不存在，渲染抛出的 TypeError 会中断本文件尾部的导出，
// 导致刷新后 Game.handleDiscard 等全部缺失、点牌无反应（一期 IIFE 化引入的回归）。
function bootGame() {
    if (Game._booted) return; // 幂等：防止动态注入时 DOMContentLoaded 与 setTimeout 双跑
    Game._booted = true;
    if (Game.loadGameProgress()) {
        Game.resumeFromSave();
    } else if (typeof Game.openModeSelect === 'function') {
        Game.openModeSelect();
    } else {
        Game.initGame(); // 兜底：规则模块未加载时直接开局
    }
    // 首屏布局落稳后智能定位横屏牌桌（左侧栏不被切）
    setTimeout(() => { try { if (typeof Game.fitViewPanX === 'function') Game.fitViewPanX(); } catch (e) {} }, 400);
    // 16 局时刷新重进：直接弹出 4 圈结束调庄
    setTimeout(() => {
        try {
            if (Game.fieldActive && (Game.fieldGameCount || 0) >= 16 && typeof Game.showRoundReminder === 'function') {
                Game.showRoundReminder();
            }
        } catch (e) {}
    }, 800);
}
document.addEventListener('DOMContentLoaded', bootGame);
// 兜底：脚本若被动态/defer 注入、已错过 DOMContentLoaded
if (document.readyState !== 'loading') setTimeout(bootGame, 0);

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.startGame = startGame;
Game.declineClaim = declineClaim;
Game.offerHu = offerHu;
Game.callChi = callChi;
Game.chooseChiCombo = chooseChiCombo;
Game.closeChiChoice = closeChiChoice;
Game.acceptClaim = acceptClaim;
Game.drawReplacementAndContinue = drawReplacementAndContinue;
Game.continueReplacementAfterReveal = continueReplacementAfterReveal;
Game.handleDiscard = handleDiscard;

;})();
