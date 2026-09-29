;(function(){
// ---------- 渲染 ----------
function renderTile(t, idx, clickable) {
    let marker = '';
    if (idx === Game.selectedIndex) marker = '<span class="mk-sel">▼</span>';
    else if (idx === Game.lastDrawnIndex) marker = '<span class="mk-new">●</span>';
    const danger = Game.isDangerousTile(t) ? 'danger' : '';
    return `<div class="tile-wrap"><div class="tile-marker">${marker}</div><div class="tile ${clickable ? '' : 'disabled'} ${danger}" data-index="${idx}">${Game.tileImg(t)}</div></div>`;
}

function renderExposedFace(t) {
    return `<div class="tile-wrap"><div class="tile-marker"></div><div class="tile exposed">${Game.tileImg(t)}</div></div>`;
}

function renderExposedBack() {
    return `<div class="tile-wrap"><div class="tile-marker"></div><div class="tileback">${Game.tileBackImg()}</div></div>`;
}

// 按组渲染一组已亮出的牌：亮牌(风/箭)用黑色虚线框；暗杠用黄色虚线框，3张扣着1张露出(避免完全认不出是什么牌)；其余照常整组亮出
function renderMeldGroup(m) {
    let cls = 'meld-group';
    if (m.type === 'winds' || m.type === 'dragons') cls += ' reveal-group';
    if (m.type === 'gang' && m.concealed) cls += ' angang-group';

    let tilesHtml;
    if (m.type === 'gang' && m.concealed) {
        tilesHtml = renderExposedFace(m.tiles[0]) + renderExposedBack() + renderExposedBack() + renderExposedBack();
    } else {
        tilesHtml = m.tiles.map(renderExposedFace).join('');
    }
    return `<div class="${cls}">${tilesHtml}</div>`;
}


function openPoolModal() {
    renderPoolGrid();
    const modal = Game.$('pool-modal');
    if (modal) modal.classList.add('show');
    Game.logFlow('牌池：已弃出 ' + Game.discardPile.length + ' 张，可上下滑动查看');
}
function closePoolModal() {
    const modal = Game.$('pool-modal');
    if (modal) modal.classList.remove('show');
}
function renderPoolGrid() {
    const grid = Game.$('pool-grid');
    if (!grid) return;
    const count = Game.$('pool-box-count');
    if (count) count.textContent = '（' + Game.discardPile.length + ' 张）';
    const sortedPool = [...Game.discardPile].sort((a, b) => Game.poolTileCompare(a.tile, b.tile));
    grid.innerHTML = sortedPool.length
        ? sortedPool.map(d => `<div class="pool-tile">${Game.tileImg(d.tile)}</div>`).join('')
        : '<div class="pool-empty">暂无弃牌</div>';
}

function render() {
    for (let p in Game.hands) {
        const isBottom = p === 'bottom';
        const isMyTurn = isBottom && Game.turnOrder[Game.currentIndex] === 'bottom' && !Game.gameOver && (!Game.pendingClaim || Game.pendingClaim.mode === 'selfGang');
        let html = '';
        if (isBottom) {
            html += Game.hands[p].map((t, idx) => renderTile(t, idx, isMyTurn)).join('');
            Game.exposedMelds[p].forEach(m => { html += renderMeldGroup(m); });
            Game.$('hand-' + p).innerHTML = html;
        } else {
            // AI 暗牌不显示；副露直接挂在头像下方，最多三行
            Game.$('hand-' + p).innerHTML = '';
            const expEl = Game.$('exposed-' + p);
            if (expEl) {
                expEl.innerHTML = (Game.exposedMelds[p] || []).map(renderMeldGroup).join('');
            }
        }
    }
    const wall = Game.$('discardWall');
    // 横竖屏都显示最近 20 张（横屏 4 列 = 5 行）
    const discardView = Game.discardPile.slice(-20);
    wall.innerHTML = discardView.map((d, i, arr) =>
        `<div class="discardTile${i === arr.length - 1 ? ' latest' : ''}">${Game.tileImg(d.tile)}</div>`).join('');
    Game.$('wall-count-text').innerText = '牌墙: ' + Game.deck.length + '张-' + Game.aiLearn.games + '局';
    // 诊断：牌总数守恒 + 回合状态，有问题直接标红，卡住时一眼可见
    try {
        const tot = Game.totalTilesOf({ deck: Game.deck, discardPile: Game.discardPile, hands: Game.hands, exposedMelds: Game.exposedMelds });
        const wc = Game.$('wall-count-text');
        if (tot !== Game.FULL_DECK_SIZE) {
            wc.innerText += '【牌' + tot + '/136!】';
            wc.style.color = '#ff4444';
            wc.style.fontWeight = 'bold';
        } else {
            wc.style.color = '';
            wc.style.fontWeight = '';
        }
        // 回合状态：轮到谁、是否结束、有没有卡住的 claim
        const turnInfo = '轮到' + Game.nameOf(Game.turnOrder[Game.currentIndex])
            + (Game.gameOver ? '(已结束)' : '')
            + (Game.pendingClaim ? '[等' + Game.pendingClaim.mode + ']' : '');
        wc.title = turnInfo + ' 总数' + tot + '/136';
    } catch (e) {}
    Game.$('wall-count-text').title = (Game.$('wall-count-text').title || '') + (Game.aiLearn.games > 0
        ? ' AI已学习' + Game.aiLearn.games + '局'
        : '');
    const poolModal = Game.$('pool-modal');
    if (poolModal && poolModal.classList.contains('show')) renderPoolGrid();
    Game.markDealer();
    if (Game.exposedInfoShownFor && document.body && document.body.classList.contains('portrait-layout')) {
        try { Game.showExposedInfo(Game.exposedInfoShownFor); } catch (e) {}
    }
    fitBottomHand();
    // 局数变化 / 副露数量变化时，重新核对横屏界面放大系数（04-view-scale.js）
    try { if (typeof Game.uiScaleOnRender === 'function') Game.uiScaleOnRender(); } catch (e) {}
    try { updateTenpaiHint(); } catch (e) {}
    try { Game.validateHandCounts('render'); } catch (e) {}
}

// ---------- 横屏底牌自适应：无论手牌+吃碰杠亮组有多少张（含最多三次杠），
// 都通过等比缩放让它们在同一行内完整显示，不换行、不重叠、不需要滚动 ----------
function fitBottomHand() {
    const handEl = Game.$('hand-bottom');
    if (!handEl) return;
    // 竖屏：完全按原版固定 29×39 + 横向滑动，不做缩放
    if (document.body && document.body.classList.contains('portrait-layout')) {
        handEl.style.overflowX = 'auto';
        handEl.style.justifyContent = 'flex-start';
        handEl.style.setProperty('--tile-w', '29px');
        handEl.style.setProperty('--tile-h', '39px');
        handEl.style.setProperty('--tile-fs', '29px');
        return;
    }
    // 横屏界面放大系数（04-view-scale.js 按牌桌里的可用空间算出，≥1；未启用时为 1）
    const uiK = (typeof Game.uiScaleK === 'number' && Game.uiScaleK > 0) ? Game.uiScaleK : 1;
    const baseW = 29 * uiK, baseH = 39 * uiK, baseFS = 29 * uiK;
    const MIN_SCALE = 0.42;
    handEl.style.overflowX = 'hidden';
    handEl.style.justifyContent = 'center';
    handEl.style.setProperty('--tile-w', baseW.toFixed(2) + 'px');
    handEl.style.setProperty('--tile-h', baseH.toFixed(2) + 'px');
    handEl.style.setProperty('--tile-fs', baseFS.toFixed(2) + 'px');
    const container = handEl.parentElement;
    if (!container) return;
    const availWidth = container.clientWidth;
    const naturalWidth = handEl.scrollWidth;
    if (availWidth > 0 && naturalWidth > availWidth) {
        let scale = availWidth / naturalWidth;
        if (scale < MIN_SCALE) scale = MIN_SCALE;
        handEl.style.setProperty('--tile-w', (baseW * scale).toFixed(2) + 'px');
        handEl.style.setProperty('--tile-h', (baseH * scale).toFixed(2) + 'px');
        handEl.style.setProperty('--tile-fs', (baseFS * scale).toFixed(2) + 'px');
        requestAnimationFrame(() => {
            if (handEl.scrollWidth > container.clientWidth + 1) {
                handEl.style.overflowX = 'auto';
            }
        });
    }
}

// ---------- 听牌提示（只针对你自己的手牌） ----------
// 四种显示：等别人时「听 一万2 · 共3张」；点选牌后「打北 → 听 …」；未点选「可听牌：打 北 白」；
// 结构成型但缺穷胡条件「成型 · 缺：开门」。「余」= 4 − 你能看到的张数。
// 听口用 getWinningTilesOf（与 checkHu 同一套规则、带缓存），不会和实际胡牌不一致。
// 总开关：false 可彻底禁用（连 UI 开关也不出现）。
const TENPAI_HINT_ENABLED = true;
const TENPAI_HINT_MAX_TYPES = 6;   // 最多列出几种听牌，多了显示「…」
const TENPAI_HINT_UI_KEY = 'qionghu_mahjong_tenpai_hint_ui_v1';
/** UI 开关：只有为 true 时才显示 #tenpai-hint 胶囊；由猫头像旁的对话气泡按钮控制，localStorage 持久化。默认关。 */
Game.tenpaiHintUiOn = (function () {
    try {
        const v = localStorage.getItem(TENPAI_HINT_UI_KEY);
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
    } catch (e) {}
    return false; // 默认不出现胶囊，需点对话气泡才开
})();
const _partialCache = new Map();
Game._tenpaiHintHtml = null;

/** 同步对话气泡按钮外观与 aria；在 DOM 就绪后调用 */
function syncTenpaiHintToggleUi() {
    const btn = Game.$('tenpai-hint-toggle');
    if (!btn) return;
    if (Game.tenpaiHintUiOn) {
        btn.classList.add('on');
        btn.setAttribute('aria-pressed', 'true');
    } else {
        btn.classList.remove('on');
        btn.setAttribute('aria-pressed', 'false');
    }
}

/** 点击猫头像旁的对话气泡：切换听牌提示开关并立刻刷新胶囊 */
function toggleTenpaiHint() {
    if (!TENPAI_HINT_ENABLED) return;
    Game.tenpaiHintUiOn = !Game.tenpaiHintUiOn;
    try { localStorage.setItem(TENPAI_HINT_UI_KEY, Game.tenpaiHintUiOn ? '1' : '0'); } catch (e) {}
    syncTenpaiHintToggleUi();
    Game._tenpaiHintHtml = null; // 强制 updateTenpaiHint 重写 DOM
    try { updateTenpaiHint(); } catch (e) {}
    try { Game.logFlow(Game.tenpaiHintUiOn ? '听牌提示：开' : '听牌提示：关'); } catch (e) {}
}

/** 你能看到的这张牌的张数（hypoHand：你「假设」的手牌；extraSeen：假设刚打出的那张，也算已见） */
function humanSeenCount(tile, hypoHand, extraSeen) {
    let seen = hypoHand.filter(t => t === tile).length + (extraSeen === tile ? 1 : 0);
    seen += Game.discardPile.filter(d => d.tile === tile).length;
    for (const p of Game.turnOrder) {
        for (const m of (Game.exposedMelds[p] || [])) {
            if (p !== 'bottom' && m.type === 'gang' && m.concealed) continue; // 别人的暗杠你看不到
            seen += m.tiles.filter(x => x === tile).length;
        }
    }
    return seen;
}

/** 结构成型（能拆成面子+将）、但穷胡规则还缺条件的「最接近」的一种：{ tile, missing:[…] } 或 null */
function partialWaitInfo(concealed, exposed) {
    const key = concealed.slice().sort().join(',') + '|'
        + exposed.map(m => m.type + (m.concealed ? 'c' : '') + m.tiles.join('')).join(';') + '|' + (Game.windDragonBonus.bottom ? '+' : '-');
    if (_partialCache.has(key)) return _partialCache.get(key);
    let best = null;
    for (const t of Game.allTileTypes()) {
        const a = Game.analyzeHu([...concealed, t], exposed, 'bottom');
        if (!a.structuralOk) continue;
        const missing = [];
        if (!a.kaimen) missing.push('开门');
        if (!a.sanmenqi) missing.push('三门齐');
        if (!a.yaojiu) missing.push('幺九');
        if (!a.kezi) missing.push('刻子');
        if (!missing.length) continue; // 真能胡的走 getWinningTilesOf
        if (!best || missing.length < best.missing.length) best = { tile: t, missing };
    }
    if (_partialCache.size > 2000) _partialCache.clear();
    _partialCache.set(key, best);
    return best;
}

/** 听牌 HTML：waits 非空 → 横屏「听 一万2 四万1 · 共3张」；竖屏上听只显示胡啥「听 一万 四万」；否则成型缺条件；都没有返回 null */
function formatWaitsHtml(concealed, exposed, extraSeen) {
    const waits = Game.getWinningTilesOf(concealed, exposed, 'bottom');
    if (waits.length) {
        const isPortrait = document.body && document.body.classList.contains('portrait-layout');
        // 竖屏上听：只显示可胡的牌面，不带余张与合计（单行、省宽度）
        if (isPortrait) {
            const shown = waits.slice(0, TENPAI_HINT_MAX_TYPES).map(t =>
                `<span class="th-w"><b>${Game.tileImg(t, 'inline')}</b></span>`).join('');
            const more = waits.length > TENPAI_HINT_MAX_TYPES ? '<span class="th-more">…</span>' : '';
            return `<span class="th-lab">听</span>${shown}${more}`;
        }
        // 横屏：完整信息（牌 + 场上余张 + 共几张）
        let total = 0;
        const items = waits.map(t => {
            const left = Math.max(0, 4 - humanSeenCount(t, concealed, extraSeen));
            total += left;
            return { t, left };
        });
        const shown = items.slice(0, TENPAI_HINT_MAX_TYPES).map(x =>
            `<span class="th-w${x.left === 0 ? ' th-none' : ''}"><b>${Game.tileImg(x.t, 'inline')}</b><i>${x.left}</i></span>`).join('');
        const more = items.length > TENPAI_HINT_MAX_TYPES ? '<span class="th-more">…</span>' : '';
        return `<span class="th-lab">听</span>${shown}${more}<span class="th-sum">共${total}张</span>`;
    }
    const part = partialWaitInfo(concealed, exposed);
    if (part) return `<span class="th-lab th-part">成型</span><span class="th-miss">缺：${part.missing.join(' / ')}</span>`;
    return null;
}

/** 当前应该显示的提示 HTML（不显示返回 ''） */
function computeTenpaiHint() {
    if (!TENPAI_HINT_ENABLED || !Game.tenpaiHintUiOn || Game.gameOver || !Game.hands || !Game.hands.bottom || !Game.hands.bottom.length) return '';
    if (typeof Game.diceBusy !== 'undefined' && Game.diceBusy) return '';
    const hand = Game.hands.bottom, ex = Game.exposedMelds.bottom || [];
    const need = (4 - ex.length) * 3 + 2;
    if (hand.length === need - 1) return formatWaitsHtml(hand, ex, null) || '';           // 等牌中
    const myTurn = Game.turnOrder[Game.currentIndex] === 'bottom' && (!Game.pendingClaim || Game.pendingClaim.mode === 'selfGang');
    if (hand.length !== need || !myTurn) return '';
    if (Game.selectedIndex != null && Game.selectedIndex >= 0 && Game.selectedIndex < hand.length) {
        const t = hand[Game.selectedIndex];
        const rest = hand.slice(); rest.splice(Game.selectedIndex, 1);
        const body = formatWaitsHtml(rest, ex, t);
        return `<span class="th-lab th-dis">打${Game.tileImg(t, 'inline')}</span>` + (body || '<span class="th-miss">未听牌</span>');
    }
    // 还没点选：列出哪些打法能听牌
    const outs = [];
    for (const t of new Set(hand)) {
        const rest = hand.slice(); rest.splice(rest.indexOf(t), 1);
        if (Game.getWinningTilesOf(rest, ex, 'bottom').length) outs.push(t);
    }
    outs.sort(Game.tileCompare);
    if (!outs.length) return '';
    return `<span class="th-lab">可听牌</span><span class="th-miss">打 ${outs.map(t => Game.tileImg(t, 'inline')).join(' ')}</span>`;
}

/** 把提示画到猫右边（.avatar-with-toggle 内绝对定位）；开关关或无内容时不显示 */
function updateTenpaiHint() {
    try { syncTenpaiHintToggleUi(); } catch (e) {}
    let el = Game.$('tenpai-hint');
    if (!el) {
        const host = document.querySelector('.avatar-with-toggle') || Game.$('p-bottom');
        if (!host || !document.createElement) return;
        el = document.createElement('div');
        el.id = 'tenpai-hint';
        el.setAttribute('aria-live', 'polite');
        host.appendChild(el);
    }
    const html = computeTenpaiHint();
    if (html === Game._tenpaiHintHtml) return;   // 没变化就不动 DOM
    Game._tenpaiHintHtml = html;
    el.innerHTML = html;
    if (html) el.classList.add('show'); else el.classList.remove('show');
}

function rotateDealer() {
    // 有人胡牌：赢家是庄家就连庄，否则下庄
    // 流局（winner为null）：无条件连庄
    const dealerStays = Game.winner === null ? true : (Game.winner === Game.dealer);
    if (!dealerStays) Game.dealer = Game.nextPlayerOf(Game.dealer);
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.renderExposedFace = renderExposedFace;
Game.renderExposedBack = renderExposedBack;
Game.renderMeldGroup = renderMeldGroup;
Game.openPoolModal = openPoolModal;
Game.closePoolModal = closePoolModal;
Game.render = render;
Game.fitBottomHand = fitBottomHand;
Game.toggleTenpaiHint = toggleTenpaiHint;
Game.rotateDealer = rotateDealer;

;})();
