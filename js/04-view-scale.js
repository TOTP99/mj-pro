;(function(){
// ---------- 横屏牌桌大小（手动滑杆） ----------
// default = 一直以来的原始大小（scale=1，不做自动适配）；
// 黄色滑杆左右拉动：相对默认 80%~110%；按住牌桌上下拖动平移（见 13-game-actions.js initTablePan）；
// 刷新恢复默认（滑杆/拖动都不持久化）。
const VIEW_SIZE_MIN = 80, VIEW_SIZE_MAX = 110; // 相对默认的百分比
const ORIGINAL_VIEW_SCALE = 1;

Game.viewScale = ORIGINAL_VIEW_SCALE;

function applyViewScale() {
    Game.viewScale = Math.round(Game.viewScale * 1000) / 1000;
    document.documentElement.style.setProperty('--view-scale', String(Game.viewScale));
    // 兜底：部分安卓 WebView 在缩放瞬间会出现"金边框已更新、内部圆角裁剪内容未同步重绘"
    // 的错位现象，这里强制触发一次重排+重绘，确保边框与桌面内容一起刷新
    const frameEl = document.getElementById('table-frame');
    const wrapEl = document.getElementById('table-wrap');
    if (frameEl) {
        void frameEl.offsetHeight; // 强制同步重排
    }
    requestAnimationFrame(() => {
        // 下一帧再强制读取一次布局尺寸，确保边框与内部内容按同一次合成结果绘制
        if (wrapEl) void wrapEl.offsetHeight;
        if (frameEl) void frameEl.offsetHeight;
    });
    setTimeout(() => { try { Game.fitBottomHand(); } catch (e) {} }, 120);
}

/** 黄色滑杆 oninput 入口：钳制 80~110 → 设 --view-scale；不存档，刷新恢复 100% */
function setViewSize(pct) {
    let v = Math.round(Number(pct));
    if (!isFinite(v)) v = 100;
    v = Math.min(VIEW_SIZE_MAX, Math.max(VIEW_SIZE_MIN, v));
    Game.viewScale = v / 100;
    applyViewScale();
    const s = document.getElementById('size-slider');
    if (s && String(s.value) !== String(v)) s.value = String(v);
    try { autoUiScale('full'); } catch (e) {} // 牌桌大小变了，头像/手牌放大系数重算
}

/* ==================== 横竖屏切换过渡 ====================
 * 旋转时浏览器先按新方向重排，JS 稍后才切换布局类并重新量尺寸，中间会闪几次「半成品」布局，看起来很生硬。
 * 现在：检测到方向翻转的第一时间把牌桌瞬间隐藏（opacity:0，无过渡），等可视区域尺寸稳定（连续两次量到相同）
 *       后再重新排版/适配，最后淡入（淡入的过渡写在 css/09-ui-scale.css）。最长隐藏 ORIENT_MAX_MS，超时强制显示。
 * ORIENT_SMOOTH=false 可关闭，回到原来的直接切换。 */
const ORIENT_SMOOTH = true;
const ORIENT_MIN_MS = 160;    // 至少隐藏这么久
const ORIENT_POLL_MS = 60;    // 检查尺寸是否稳定的间隔
const ORIENT_MAX_MS = 900;    // 最长隐藏时间（保险）
Game._orientLast = null;       // 上一次判断的方向（true=竖屏）；第一次只记录，不触发过渡
Game._orientTimer = 0; Game._orientStart = 0; Game._orientSizeKey = ''; Game._orientStable = 0;

function _orientIsPortrait() {
    try {
        if (typeof Game.isPortraitOrientation === 'function') return !!Game.isPortraitOrientation();
    } catch (e) { /* ignore */ }
    return window.innerHeight >= window.innerWidth;
}
function _orientSize() {
    const vv = window.visualViewport;
    return Math.round((vv && vv.width) || window.innerWidth) + 'x' + Math.round((vv && vv.height) || window.innerHeight);
}

/** 05 的旋转事件入口 / checkPortraitGuard 调用：方向真的翻转了才开始过渡，普通 resize（地址栏伸缩等）不受影响 */
function orientTransitionCheck() {
    if (!ORIENT_SMOOTH) return;
    const p = _orientIsPortrait();
    if (Game._orientLast === null) { Game._orientLast = p; return; }
    if (p === Game._orientLast) return;
    Game._orientLast = p;
    beginOrientTransition();
}

function beginOrientTransition() {
    document.documentElement.classList.add('orient-changing');
    Game._orientStart = Date.now();
    Game._orientSizeKey = _orientSize();
    Game._orientStable = 0;
    clearTimeout(Game._orientTimer);
    Game._orientTimer = setTimeout(orientPoll, ORIENT_POLL_MS);
}

function orientPoll() {
    const elapsed = Date.now() - Game._orientStart;
    const key = _orientSize();
    if (key === Game._orientSizeKey) Game._orientStable++; else { Game._orientSizeKey = key; Game._orientStable = 0; }
    if ((elapsed >= ORIENT_MIN_MS && Game._orientStable >= 2) || elapsed >= ORIENT_MAX_MS) { endOrientTransition(); return; }
    Game._orientTimer = setTimeout(orientPoll, ORIENT_POLL_MS);
}

function endOrientTransition() {
    clearTimeout(Game._orientTimer);
    const html = document.documentElement;
    try {
        if (typeof Game.checkPortraitGuard === 'function') Game.checkPortraitGuard();
        if (document.body.classList.contains('portrait-layout')) { try { Game.fitBottomHand(); } catch (e) {} }
        else { try { autoUiScale('full'); } catch (e) {} try { Game.fitBottomHand(); } catch (e) {} }
        if (typeof Game.hardenResultModalInteract === 'function') Game.hardenResultModalInteract();
    } catch (e) { /* 出任何问题都要继续去显示 */ }
    requestAnimationFrame(() => requestAnimationFrame(() => {
        html.classList.remove('orient-changing');
        try { if (typeof Game.hardenResultModalInteract === 'function') Game.hardenResultModalInteract(); } catch (e2) {}
    }));
}

/* ==================== 横屏界面元素自适应放大 ====================
 * 桌面里往往还有空地。这里用一个系数 --ui-k（≥1）统一放大：四家头像+分数、你的手牌、手牌上方的提示文字、AI 副露牌，
 * 放大到「四个玩家区域之间、以及和牌桌边框之间刚好不重叠」为止。
 * 做法：用真实布局测量（getBoundingClientRect），在 [1, UI_K_MAX] 上二分找最大可行的系数，
 *       再乘一个安全系数，并复核一次；量不到或有异常时保持 1（=原尺寸）。
 * 触发：每次黄线滑杆调节之后、旋转过渡结束、每局开局（可放大）；有人吃碰杠、副露变多时（只会缩小，不会中途变大，避免画面忽大忽小）。
 * 竖屏、AUTO_UI_SCALE=false 时系数恒为 1，界面与原来完全一致。
 * 样式在 css/09-ui-scale.css（下面会在缺少 <link> 时自动补上）。 */
const AUTO_UI_SCALE = true;   // false：不放大，一切保持原尺寸
const UI_K_MAX = 2;           // 放大上限
const UI_GAP = 2;             // 各区域之间至少留的空隙（牌桌自身像素）
const UI_SAFETY = 0.998;      // 在算出的最大值上只留 0.2% 余量（再复核一次，仍冲突就继续减小）
const UI_SAMPLE_LOG = '可以暗杠 三万，点确认杠 / 点过或直接出牌'; // 按较长的一句提示来预留高度
Game.uiScaleK = 1;
Game._uiSig = '';
Game._uiBaseExtra = new Set(); // 系数=1 时就已经和「牌墙统计栏 W / 弃牌区 D」重叠的组合（原布局如此，不当作放大造成的冲突）

(function ensureUiScaleCss() {
    try {
        if (!document.querySelector('link[href*="09-ui-scale.css"]')) {
            const l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = 'css/09-ui-scale.css';
            document.head.appendChild(l); // 追加在最后，保证覆盖顺序
        }
    } catch (e) { /* ignore */ }
})();

function uiSetK(k) {
    Game.uiScaleK = k;
    document.documentElement.style.setProperty('--ui-k', String(k));
}

/** 两个矩形（加上 gap 的外扩）是否相交 */
function uiRectsOverlap(a, b, gap) {
    return a.left < b.right + gap && b.left < a.right + gap &&
           a.top < b.bottom + gap && b.top < a.bottom + gap;
}

/** blocks = { T, L, R, B, frame }：上家/左家/右家/你 四个区域和牌桌边框的矩形（屏幕坐标）。有冲突返回 true */
function uiHasConflict(blocks, gap) {
    const names = ['T', 'L', 'R', 'B'];
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const a = blocks[names[i]], b = blocks[names[j]];
            if (a && b && uiRectsOverlap(a, b, gap)) return true;
        }
    }
    // 左侧牌墙统计栏(W)、右侧弃牌区(D)：只拦截放大之后「新出现」的重叠
    for (const n of names) {
        for (const x of ['W', 'D']) {
            const a = blocks[n], b = blocks[x];
            if (a && b && !Game._uiBaseExtra.has(n + x) && uiRectsOverlap(a, b, gap)) return true;
        }
    }
    const f = blocks.frame, tol = 0.5;
    if (!f) return true;
    for (const n of ['T', 'L', 'R']) {
        const r = blocks[n];
        if (r && (r.left < f.left - tol || r.right > f.right + tol || r.top < f.top - tol || r.bottom > f.bottom + tol)) return true;
    }
    // 你的区域：左右宽度由 fitBottomHand 自动收缩，只检查上下
    const b = blocks.B;
    if (b && (b.top < f.top - tol || b.bottom > f.bottom + tol)) return true;
    return false;
}

/** 在 [lo, hi] 里找最大的可行系数（假定 lo 可行、可行性随系数增大单调变差） */
function uiSearchK(feasible, lo, hi, iters) {
    if (feasible(hi)) return hi;
    let a = lo, b = hi;
    for (let i = 0; i < iters; i++) {
        const mid = (a + b) / 2;
        if (feasible(mid)) a = mid; else b = mid;
    }
    return a;
}

/** 以系数 k 排版后，量出各区域的位置（提示文字用较长的样例，手牌按未收缩的最大尺寸） */
function uiMeasure(k) {
    uiSetK(k);
    const g = (id) => document.getElementById(id);
    const hand = g('hand-bottom');
    if (hand) {
        hand.style.setProperty('--tile-w', (29 * k).toFixed(2) + 'px');
        hand.style.setProperty('--tile-h', (39 * k).toFixed(2) + 'px');
        hand.style.setProperty('--tile-fs', (29 * k).toFixed(2) + 'px');
    }
    const log = g('flow-log');
    const savedLog = log ? log.textContent : null;
    if (log) log.textContent = UI_SAMPLE_LOG;
    const rc = (el) => (el ? el.getBoundingClientRect() : null);
    const stack = (id) => { const p = g(id); return p ? p.querySelector('.player-side-stack') : null; };
    const out = {
        T: rc(g('p-top')), L: rc(stack('p-left')), R: rc(stack('p-right')),
        B: rc(g('p-bottom')), frame: rc(g('table-frame')),
        W: rc(g('wall-count')), D: rc(g('discardWall'))
    };
    if (log && savedLog !== null) log.textContent = savedLog; // 还原
    return out;
}

function uiFeasible(k) {
    const blocks = uiMeasure(k);
    const f = blocks.frame;
    if (!f || !(f.width > 0)) return false;               // 量不到：当作不可行，保持原尺寸
    const frameEl = document.getElementById('table-frame');
    const s = (frameEl && frameEl.offsetWidth) ? f.width / frameEl.offsetWidth : 1; // 当前牌桌缩放
    return !uiHasConflict(blocks, UI_GAP * (s > 0 ? s : 1));
}

/** mode: 'full' 可放大也可缩小；'shrink' 只允许比当前更小（用于中途副露变多） */
function autoUiScale(mode) {
    const body = document.body;
    if (!body) return;
    if (!AUTO_UI_SCALE || body.classList.contains('portrait-layout')) {
        if (Game.uiScaleK !== 1) { uiSetK(1); try { Game.fitBottomHand(); } catch (e) {} }
        return;
    }
    if (body.classList.contains('modal-open')) return; // 弹窗期间页面被固定，关闭后会再触发
    if (typeof Game.hands === 'undefined' || !Game.hands.bottom || !Game.hands.bottom.length) return; // 还没发牌
    const prev = Game.uiScaleK;
    try {
        // 先在系数=1（原尺寸）下记下哪些区域本来就和牌墙栏/弃牌区重叠
        Game._uiBaseExtra = new Set();
        const b1 = uiMeasure(1), f1 = b1.frame;
        if (f1 && f1.width > 0) {
            const fe = document.getElementById('table-frame');
            const s1 = (fe && fe.offsetWidth) ? f1.width / fe.offsetWidth : 1;
            for (const n of ['T', 'L', 'R', 'B']) {
                for (const x of ['W', 'D']) {
                    if (b1[n] && b1[x] && uiRectsOverlap(b1[n], b1[x], UI_GAP * (s1 > 0 ? s1 : 1))) Game._uiBaseExtra.add(n + x);
                }
            }
        }
        let k = uiSearchK(uiFeasible, 1, UI_K_MAX, 10);                     // 二分 10 次，精度约 0.001
        k = Math.max(1, Math.floor(k * UI_SAFETY * 200) / 200);            // 向下取到 0.005 的倍数
        while (k > 1 && !uiFeasible(k)) k = Math.max(1, Math.round((k - 0.005) * 1000) / 1000); // 复核，仍冲突就一点点减小
        if (mode === 'shrink') k = Math.min(k, prev);
        uiSetK(k);
    } catch (e) {
        uiSetK(1); // 出任何问题都退回原尺寸
    }
    try { Game.fitBottomHand(); } catch (e) {}
}

/** 每次 render 后调用：局数变化或副露减少 → 重新算（可放大）；副露增加 → 只允许缩小 */
function uiScaleOnRender() {
    if (!AUTO_UI_SCALE) return;
    const epoch = (typeof Game.gameEpoch !== 'undefined') ? Game.gameEpoch : 0;
    const counts = Game.PLAYERS.map(p => ((Game.exposedMelds[p] && Game.exposedMelds[p].length) || 0));
    const total = counts.reduce((a, b) => a + b, 0);
    const sig = epoch + '|' + counts.join(',');
    if (sig === Game._uiSig) return;
    const prevParts = Game._uiSig ? Game._uiSig.split('|') : null;
    const prevTotal = prevParts ? prevParts[1].split(',').reduce((a, b) => a + (+b), 0) : -1;
    const newGame = !prevParts || prevParts[0] !== String(epoch);
    Game._uiSig = sig;
    autoUiScale(newGame || total < prevTotal ? 'full' : 'shrink');
}

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.ORIGINAL_VIEW_SCALE = ORIGINAL_VIEW_SCALE;
Game.applyViewScale = applyViewScale;
Game.setViewSize = setViewSize;
Game.orientTransitionCheck = orientTransitionCheck;
Game.uiScaleOnRender = uiScaleOnRender;

;})();
