// ---------- 横屏自动适配开关 ----------
// true：横屏时自动算出缩放比例并上下居中，牌桌始终完整落在当前可视区域内，不用再手动"缩小到80%+上下调整"；
// false：恢复纯手动（缩放下限也回到 70%）。竖屏不受影响。
const AUTO_FIT_LANDSCAPE = true;
const AUTO_FIT_MARGIN = 1;   /* 牌桌离可视区域边缘至少留几 px（横屏最大化时为 0）；只留 1px 防止亚像素取整多出一点 */
const AUTO_FIT_SCALE_MAX = 2; /* 自动适配允许放大的上限：可视区域比牌桌自然尺寸大时（大屏/平板/没有地址栏时）也放大到刚好填满 */
const AUTO_FIT_USE_SAFE_AREA = true; /* true：让开刘海/Home 条等安全区；false：不让（可能被刘海或手势条遮住一点） */

const ORIGINAL_VIEW_SCALE = 1;
const VIEW_SCALE_MIN = AUTO_FIT_LANDSCAPE ? 0.5 : 0.7; /* 手动最多缩到原始的 70%；自动适配时放宽到 50%，给很矮的屏幕留余地 */
const VIEW_SCALE_MAX = AUTO_FIT_LANDSCAPE ? AUTO_FIT_SCALE_MAX : ORIGINAL_VIEW_SCALE; /* 手动扩大的上限（自动适配时放宽，才能表示放大到 >100% 的自动结果） */
const VIEW_SCALE_STEP = 0.05;
const VIEW_SCALE_STORAGE_KEY = 'qionghu_mahjong_view_scale_v1';
const VIEW_ORIGINAL_STORAGE_KEY = 'qionghu_mahjong_view_original_v1';

let viewScale = ORIGINAL_VIEW_SCALE;
/** 启动时记录的桌面原始像素尺寸（供对照/恢复） */
let originalViewRecord = null;

function captureOriginalViewSize() {
    if (originalViewRecord) return originalViewRecord;
    const frame = document.getElementById('table-frame');
    const wrap = document.getElementById('table-wrap');
    let w = 0, h = 0;
    if (frame) {
        const r = frame.getBoundingClientRect();
        // 若当前已缩放，反推未缩放尺寸
        const s = viewScale || 1;
        w = r.width / s;
        h = r.height / s;
    }
    originalViewRecord = {
        scale: ORIGINAL_VIEW_SCALE,
        width: Math.round(w * 10) / 10,
        height: Math.round(h * 10) / 10,
        capturedAt: Date.now()
    };
    try {
        localStorage.setItem(VIEW_ORIGINAL_STORAGE_KEY, JSON.stringify(originalViewRecord));
    } catch (e) { /* ignore */ }
    return originalViewRecord;
}

function loadSavedViewScale() {
    try {
        const raw = localStorage.getItem(VIEW_SCALE_STORAGE_KEY);
        if (raw == null) return ORIGINAL_VIEW_SCALE;
        const n = parseFloat(raw);
        if (!isFinite(n)) return ORIGINAL_VIEW_SCALE;
        return Math.max(VIEW_SCALE_MIN, Math.min(VIEW_SCALE_MAX, n));
    } catch (e) {
        return ORIGINAL_VIEW_SCALE;
    }
}

function applyViewScale() {
    viewScale = Math.round(viewScale * 1000) / 1000;
    if (viewScale > VIEW_SCALE_MAX) viewScale = VIEW_SCALE_MAX;
    if (viewScale < VIEW_SCALE_MIN) viewScale = VIEW_SCALE_MIN;
    document.documentElement.style.setProperty('--view-scale', String(viewScale));
    try {
        localStorage.setItem(VIEW_SCALE_STORAGE_KEY, String(viewScale));
    } catch (e) { /* ignore */ }
    syncViewScaleButtons();
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
    setTimeout(() => { try { fitBottomHand(); } catch (e) {} }, 120);
}

/** delta: +0.05 扩大 / -0.05 缩小；相对「原始正常大小」等比缩放 */
function adjustViewScale(delta) {
    if (!originalViewRecord) captureOriginalViewSize();
    // 已达原始最大尺寸时，扩大无效
    if (delta > 0 && viewScale >= viewScaleUpper() - 1e-9) {
        logFlow(_autoFitMax != null && AUTO_FIT_LANDSCAPE
            ? '已是自动适配的最大尺寸（刚好放满可视区域），无法再扩大'
            : (viewScale > ORIGINAL_VIEW_SCALE + 1e-9 ? '已放大到上限，无法再扩大' : '已是原始正常大小，无法再扩大'));
        applyViewScale();
        return;
    }
    if (delta < 0 && viewScale <= VIEW_SCALE_MIN + 1e-9) {
        logFlow('已缩小到原始大小的 ' + Math.round(VIEW_SCALE_MIN * 100) + '%，无法再缩');
        applyViewScale();
        return;
    }
    viewScale = viewScale + delta;
    if (delta > 0) viewScale = Math.min(viewScale, viewScaleUpper()); // 不超过自动适配的最大值
    applyViewScale();
    const pct = Math.round(viewScale * 100);
    if (Math.abs(viewScale - ORIGINAL_VIEW_SCALE) < 1e-9) {
        logFlow('已恢复原始正常大小（100%）');
    } else if (delta < 0) {
        logFlow('整体（含头像）缩小至 ' + pct + '%（原始=100%）');
    } else {
        logFlow('整体（含头像）扩大至 ' + pct + '%（原始=100%）');
    }
}

/* ==================== 横屏自动适配 ====================
 * 原因：手机浏览器里 100vh 常常比真正可见的高度大（地址栏/工具栏占了一部分），
 * 牌桌又是按 vh 算尺寸并在 body 里居中，于是底部被裁掉，只能手动缩小再上下拖。
 * 做法：把牌桌临时还原成"不缩放、不平移"量出它的自然位置，再按当前真正可见的区域（visualViewport，
 *       扣掉刘海/Home 条安全区和 4px 边距）算出：缩放比例 = min(1, 可用宽/桌宽, 可用高/桌高)，
 *       平移 = 让缩放后的牌桌在可见区域里垂直居中。整个过程同步完成、关掉过渡动画，不会闪。
 * 触发：启动、旋转、窗口大小/可视区域变化、进出全屏、弹窗关闭后。
 * 手动的 缩小/扩大/拖动 仍然可用，效果保留到下一次上述事件（或刷新）为止。
 * 竖屏完全不处理。 */
let _autoFitApplied = false; // 已经自动适配过一次（第一次直接到位不做动画）
let _autoFitReady = false;   // 13 启动段准备好之后才允许自动适配（避免脚本还没加载完就被 resize 事件触发）
let _autoFitTimers = [];
let _autoFitMax = null;     // 最近一次自动适配算出的缩放比例 = 刚好放满可视区域的最大值；手动「扩大」不允许超过它（超过就会被裁掉）
/** 「扩大」按钮/操作的上限：自动适配生效时是 _autoFitMax，否则是 VIEW_SCALE_MAX */
function viewScaleUpper() {
    return (AUTO_FIT_LANDSCAPE && _autoFitMax != null) ? Math.min(VIEW_SCALE_MAX, _autoFitMax) : VIEW_SCALE_MAX;
}

function syncViewScaleButtons() {
    const btnIn = document.getElementById('btn-view-zoom-in');
    const btnOut = document.getElementById('btn-view-zoom-out');
    if (btnIn) btnIn.disabled = viewScale >= viewScaleUpper() - 1e-9;
    if (btnOut) btnOut.disabled = viewScale <= VIEW_SCALE_MIN + 1e-9;
}

function autoFitLandscapeView() {
    if (!AUTO_FIT_LANDSCAPE || !_autoFitReady) return false;
    try {
        const body = document.body;
        const wrap = document.getElementById('table-wrap');
        const frame = document.getElementById('table-frame');
        if (!body || !wrap || !frame) return false;
        if (body.classList.contains('portrait-layout')) return false; // 竖屏不动
        if (typeof isPortraitOrientation === 'function' && isPortraitOrientation()) return false;
        if (body.classList.contains('modal-open')) return false;      // 弹窗打开时页面被固定，弹窗关闭后会再触发
        if (typeof panDrag !== 'undefined' && panDrag) return false;  // 正在拖动牌桌

        const root = document.documentElement.style;
        wrap.classList.add('panning');                // 关闭过渡，读到的就是最终位置而不是动画中间值
        root.setProperty('--view-scale', '1');
        root.setProperty('--view-pan-y', '0px');
        const r = frame.getBoundingClientRect();      // 自然尺寸/位置（未缩放、未平移）

        const vv = window.visualViewport;
        const vpW = (vv && vv.width) || window.innerWidth;
        const vpH = (vv && vv.height) || window.innerHeight;
        const isMax = body.classList.contains('landscape-max');
        const cs = window.getComputedStyle ? window.getComputedStyle(body) : null;
        const pad = (k) => (isMax || !cs || !AUTO_FIT_USE_SAFE_AREA) ? 0 : (parseFloat(cs[k]) || 0); // 非最大化时 body 的 padding 就是安全区
        const m = isMax ? 0 : AUTO_FIT_MARGIN;
        const availL = pad('paddingLeft') + m, availR = vpW - pad('paddingRight') - m;
        const availT = pad('paddingTop') + m,  availB = vpH - pad('paddingBottom') - m;

        let s = 1;
        if (r.width > 0 && r.height > 0) {
            s = Math.min(AUTO_FIT_SCALE_MAX, (availR - availL) / r.width, (availB - availT) / r.height); // 取「刚好放得下」的最大比例，可视区域更大时也放大
        }
        if (!(s > 0)) s = 1;
        s = Math.max(VIEW_SCALE_MIN, Math.floor(s * 1000) / 1000); // 向下取整：保证不会因四舍五入多出 1px

        // 缩放以牌桌中心为原点，中心位置不变；再平移到可见区域的垂直中心
        const cy = r.top + r.height / 2;
        let pan = (availT + availB) / 2 - cy;
        if (!isFinite(pan)) pan = 0;
        pan = Math.max(-240, Math.min(240, pan));
        if (Math.abs(pan) < 0.5) pan = 0;

        const prevS = viewScale, prevP = viewPanY;    // 上一次生效的值（用来做平滑过渡）
        _autoFitMax = s;                              // 这就是当前可视区域下的最大尺寸
        viewScale = s;
        viewPanY = pan;
        root.setProperty('--view-scale', String(s));
        root.setProperty('--view-pan-y', pan.toFixed(1) + 'px');
        // 放大到 >100% 时不锁定栅格化比例（will-change:transform 会让放大后的文字发虚）；≤100% 保持样式表里的设置
        wrap.style.willChange = s > 1.001 ? 'auto' : '';
        void wrap.offsetHeight;                       // 强制同步布局：这一帧就以最终值绘制
        try { autoUiScale('full'); } catch (e) {}     // 牌桌大小定了，再算头像/手牌等的放大系数
        // 平滑：非首次、非旋转过渡中、且数值确实变了 → 先回到旧位置（无过渡），再打开过渡设成新值，牌桌会平滑地变到新大小
        const hiding = document.documentElement.classList.contains('orient-changing');
        const animate = _autoFitApplied && !hiding && (Math.abs(prevS - s) > 0.002 || Math.abs(prevP - pan) > 0.5);
        _autoFitApplied = true;
        if (animate) {
            root.setProperty('--view-scale', String(prevS));
            root.setProperty('--view-pan-y', prevP.toFixed(1) + 'px');
            void wrap.offsetHeight;
            wrap.classList.remove('panning');
            void wrap.offsetHeight;
            root.setProperty('--view-scale', String(s));
            root.setProperty('--view-pan-y', pan.toFixed(1) + 'px');
        } else {
            requestAnimationFrame(() => wrap.classList.remove('panning'));
        }
        syncViewScaleButtons();
        setTimeout(() => { try { fitBottomHand(); } catch (e) {} }, 60);
        return true;
    } catch (e) {
        try { document.getElementById('table-wrap').classList.remove('panning'); } catch (e2) {}
        return false;
    }
}

/** 视口刚变化时尺寸还没稳定（旋转/全屏动画），在几个时间点各量一次，最后一次为准 */
function scheduleAutoFitBurst() {
    if (!AUTO_FIT_LANDSCAPE) return;
    _autoFitTimers.forEach(clearTimeout);
    _autoFitTimers = [80, 350, 900, 1800].map(ms => setTimeout(autoFitLandscapeView, ms));
}
window.addEventListener('resize', scheduleAutoFitBurst);
window.addEventListener('orientationchange', scheduleAutoFitBurst);
window.addEventListener('pageshow', scheduleAutoFitBurst);
if (window.visualViewport && window.visualViewport.addEventListener) {
    window.visualViewport.addEventListener('resize', scheduleAutoFitBurst);
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
let _orientLast = null;       // 上一次判断的方向（true=竖屏）；第一次只记录，不触发过渡
let _orientTimer = 0, _orientStart = 0, _orientSizeKey = '', _orientStable = 0;

function _orientIsPortrait() {
    try {
        if (typeof isPortraitOrientation === 'function') return !!isPortraitOrientation();
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
    if (_orientLast === null) { _orientLast = p; return; }
    if (p === _orientLast) return;
    _orientLast = p;
    beginOrientTransition();
}

function beginOrientTransition() {
    document.documentElement.classList.add('orient-changing');
    _orientStart = Date.now();
    _orientSizeKey = _orientSize();
    _orientStable = 0;
    clearTimeout(_orientTimer);
    _orientTimer = setTimeout(orientPoll, ORIENT_POLL_MS);
}

function orientPoll() {
    const elapsed = Date.now() - _orientStart;
    const key = _orientSize();
    if (key === _orientSizeKey) _orientStable++; else { _orientSizeKey = key; _orientStable = 0; }
    if ((elapsed >= ORIENT_MIN_MS && _orientStable >= 2) || elapsed >= ORIENT_MAX_MS) { endOrientTransition(); return; }
    _orientTimer = setTimeout(orientPoll, ORIENT_POLL_MS);
}

function endOrientTransition() {
    clearTimeout(_orientTimer);
    const html = document.documentElement;
    try {
        if (typeof checkPortraitGuard === 'function') checkPortraitGuard();
        if (document.body.classList.contains('portrait-layout')) fitBottomHand();
        else autoFitLandscapeView();
        if (typeof hardenResultModalInteract === 'function') hardenResultModalInteract();
    } catch (e) { /* 出任何问题都要继续去显示 */ }
    requestAnimationFrame(() => requestAnimationFrame(() => {
        html.classList.remove('orient-changing');
        try { if (typeof hardenResultModalInteract === 'function') hardenResultModalInteract(); } catch (e2) {}
    }));
}

/* ==================== 横屏界面元素自适应放大 ====================
 * 自动适配把整张牌桌缩放到刚好放进可见区域之后，桌面里往往还有空地。
 * 这里用一个系数 --ui-k（≥1）统一放大：四家头像+分数、你的手牌、手牌上方的提示文字、AI 副露牌，
 * 放大到「四个玩家区域之间、以及和牌桌边框之间刚好不重叠」为止。
 * 做法：用真实布局测量（getBoundingClientRect），在 [1, UI_K_MAX] 上二分找最大可行的系数，
 *       再乘一个安全系数，并复核一次；量不到或有异常时保持 1（=原尺寸）。
 * 触发：每次横屏自动适配之后；每局开局（可放大）；有人吃碰杠、副露变多时（只会缩小，不会中途变大，避免画面忽大忽小）。
 * 竖屏、AUTO_UI_SCALE=false 时系数恒为 1，界面与原来完全一致。
 * 样式在 css/09-ui-scale.css（下面会在缺少 <link> 时自动补上）。 */
const AUTO_UI_SCALE = true;   // false：不放大，一切保持原尺寸
const UI_K_MAX = 2;           // 放大上限
const UI_GAP = 2;             // 各区域之间至少留的空隙（牌桌自身像素）
const UI_SAFETY = 0.998;      // 在算出的最大值上只留 0.2% 余量（再复核一次，仍冲突就继续减小）
const UI_SAMPLE_LOG = '可以暗杠 三万，点确认杠 / 点过或直接出牌'; // 按较长的一句提示来预留高度
let uiScaleK = 1;
let _uiSig = '';
let _uiBaseExtra = new Set(); // 系数=1 时就已经和「牌墙统计栏 W / 弃牌区 D」重叠的组合（原布局如此，不当作放大造成的冲突）

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
    uiScaleK = k;
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
            if (a && b && !_uiBaseExtra.has(n + x) && uiRectsOverlap(a, b, gap)) return true;
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
        if (uiScaleK !== 1) { uiSetK(1); try { fitBottomHand(); } catch (e) {} }
        return;
    }
    if (body.classList.contains('modal-open')) return; // 弹窗期间页面被固定，关闭后会再触发
    if (typeof hands === 'undefined' || !hands.bottom || !hands.bottom.length) return; // 还没发牌
    const prev = uiScaleK;
    try {
        // 先在系数=1（原尺寸）下记下哪些区域本来就和牌墙栏/弃牌区重叠
        _uiBaseExtra = new Set();
        const b1 = uiMeasure(1), f1 = b1.frame;
        if (f1 && f1.width > 0) {
            const fe = document.getElementById('table-frame');
            const s1 = (fe && fe.offsetWidth) ? f1.width / fe.offsetWidth : 1;
            for (const n of ['T', 'L', 'R', 'B']) {
                for (const x of ['W', 'D']) {
                    if (b1[n] && b1[x] && uiRectsOverlap(b1[n], b1[x], UI_GAP * (s1 > 0 ? s1 : 1))) _uiBaseExtra.add(n + x);
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
    try { fitBottomHand(); } catch (e) {}
}

/** 每次 render 后调用：局数变化或副露减少 → 重新算（可放大）；副露增加 → 只允许缩小 */
function uiScaleOnRender() {
    if (!AUTO_UI_SCALE) return;
    const epoch = (typeof gameEpoch !== 'undefined') ? gameEpoch : 0;
    const counts = PLAYERS.map(p => ((exposedMelds[p] && exposedMelds[p].length) || 0));
    const total = counts.reduce((a, b) => a + b, 0);
    const sig = epoch + '|' + counts.join(',');
    if (sig === _uiSig) return;
    const prevParts = _uiSig ? _uiSig.split('|') : null;
    const prevTotal = prevParts ? prevParts[1].split(',').reduce((a, b) => a + (+b), 0) : -1;
    const newGame = !prevParts || prevParts[0] !== String(epoch);
    _uiSig = sig;
    autoUiScale(newGame || total < prevTotal ? 'full' : 'shrink');
}

async function toggleLandscapeMaximize() {
    // 横屏调整 = 恢复原始正常大小 + 尽量全屏横屏
    if (!originalViewRecord) captureOriginalViewSize();
    viewScale = ORIGINAL_VIEW_SCALE;
    applyViewScale();
    applyDevicePlatformClass();
    const body = document.body;
    const ios = isIOSDevice();
    const android = isAndroidDevice();
    let fsOk = false;
    try {
        if (!ios) {
            // Android / 桌面 Chrome：Fullscreen + 锁定横屏（用户手势内调用）
            const el = document.documentElement;
            const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
            if (req && !document.fullscreenElement && !document.webkitFullscreenElement) {
                try {
                    // navigationUI: 'hide' 在 Chrome Android 可尽量隐藏系统栏
                    await req.call(el, { navigationUI: 'hide' });
                    fsOk = true;
                } catch (e) {
                    try { await req.call(el); fsOk = true; } catch (e2) {}
                }
            } else if (document.fullscreenElement || document.webkitFullscreenElement) {
                fsOk = true;
            }
            try {
                if (screen.orientation && screen.orientation.lock) {
                    // Android Chrome 支持在全屏后 lock
                    await screen.orientation.lock('landscape').catch(() =>
                        screen.orientation.lock('landscape-primary').catch(() => {})
                    );
                }
            } catch (e) {}
            if (android && !fsOk) {
                // 未进全屏时：滚动收起 Chrome 工具栏
                try { window.scrollTo(0, 1); } catch (e) {}
            }
        } else {
            try { window.scrollTo(0, 1); } catch (e) {}
        }
        body.classList.add('landscape-max');
        syncAppViewportVars();
        if (ios) {
            logFlow(isPortraitOrientation()
                ? '请横向持机；可在设置中关闭竖屏锁定'
                : '已横屏铺满（iOS 可将网页「添加到主屏幕」以隐藏地址栏）');
        } else if (android) {
            logFlow(fsOk
                ? '已全屏横屏（Android）'
                : '已横屏铺满；可再点一次尝试全屏，或「添加到主屏幕」');
        } else {
            logFlow(fsOk ? '已最大化' : '已最大化（可尝试全屏或添加到主屏幕）');
        }
    } catch (e) {
        body.classList.add('landscape-max');
        syncAppViewportVars();
        logFlow('已最大化');
    }
    if (!fsOk) {
        [60, 200, 400, 800, 1200].forEach(ms => {
            setTimeout(() => {
                try { window.scrollTo(0, 1); } catch (e) {}
                syncAppViewportVars();
                fitBottomHand();
            }, ms);
        });
    } else if (android) {
        // 全屏成功后仍同步几次，适配系统栏动画
        [100, 300, 600].forEach(ms => {
            setTimeout(() => { syncAppViewportVars(); fitBottomHand(); }, ms);
        });
    }
    setTimeout(() => { try { fitBottomHand(); } catch (e) {} }, 180);
    setTimeout(() => { try { fitBottomHand(); } catch (e) {} }, 450);
    scheduleAutoFitBurst();
}
document.addEventListener('fullscreenchange', () => {
    syncAppViewportVars();
    scheduleAutoFitBurst();
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        // 仅退出全屏时不必强制退出横屏铺满（用户可能仍横持）
        setTimeout(() => {
            syncAppViewportVars();
            fitBottomHand();
            schedulePortraitGuardChecks();
        }, 120);
    } else {
        document.body.classList.add('landscape-max');
        setTimeout(() => { syncAppViewportVars(); fitBottomHand(); }, 100);
    }
});
document.addEventListener('webkitfullscreenchange', () => {
    syncAppViewportVars();
    scheduleAutoFitBurst();
    schedulePortraitGuardChecks();
});
