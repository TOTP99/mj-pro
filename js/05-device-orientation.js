function isIOSDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isAndroidDevice() {
    const ua = navigator.userAgent || '';
    return /Android/i.test(ua);
}
/** Pixel / 其它 Google 系机型（含 GSI 特征时的辅助识别） */
function isGoogleAndroidDevice() {
    if (!isAndroidDevice()) return false;
    const ua = navigator.userAgent || '';
    // Pixel 常见 UA 含 "Pixel"；部分 ChromeOS 平板不含 Android
    return /Pixel/i.test(ua) || /Nexus/i.test(ua);
}
function applyDevicePlatformClass() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;
    const android = isAndroidDevice();
    const ios = isIOSDevice();
    root.classList.toggle('is-android', android);
    root.classList.toggle('is-ios', ios);
    root.classList.toggle('is-google-android', isGoogleAndroidDevice());
    body.classList.toggle('is-android', android);
    body.classList.toggle('is-ios', ios);
    body.classList.toggle('is-google-android', isGoogleAndroidDevice());
}

/** 同步真实可视区域到 CSS 变量（iOS 地址栏 + Android Chrome 底栏/手势条） */
function syncAppViewportVars() {
    let w = window.innerWidth || document.documentElement.clientWidth || 0;
    let h = window.innerHeight || document.documentElement.clientHeight || 0;
    try {
        if (window.visualViewport) {
            w = Math.round(window.visualViewport.width) || w;
            h = Math.round(window.visualViewport.height) || h;
        }
    } catch (e) { /* ignore */ }
    // Android：全屏后优先用 layout 视口，避免 visualViewport 被工具栏短暂缩小
    try {
        if (isAndroidDevice() && (document.fullscreenElement || document.webkitFullscreenElement)) {
            w = window.innerWidth || w;
            h = window.innerHeight || h;
        }
    } catch (e) { /* ignore */ }
    if (w > 0) document.documentElement.style.setProperty('--app-width', w + 'px');
    if (h > 0) document.documentElement.style.setProperty('--app-height', h + 'px');
    return { w, h };
}

/** 读取当前可视宽高（优先 visualViewport） */
function getViewportSize() {
    let w = window.innerWidth || document.documentElement.clientWidth || 0;
    let h = window.innerHeight || document.documentElement.clientHeight || 0;
    try {
        if (window.visualViewport) {
            w = Math.round(window.visualViewport.width) || w;
            h = Math.round(window.visualViewport.height) || h;
        }
    } catch (e) { /* ignore */ }
    // Android 旋转动画中 inner 可能短暂不准：若与 screen 方向明显相反，采信 screen
    try {
        if (isAndroidDevice() && screen && screen.width && screen.height) {
            const sw = screen.width, sh = screen.height;
            const innerLand = w >= h;
            const screenLand = sw >= sh;
            // 仅在差异很大时校正，避免误伤分屏
            if (innerLand !== screenLand && Math.max(w, h) / Math.max(1, Math.min(w, h)) < 1.15) {
                const a = Math.max(w, h), b = Math.min(w, h);
                if (screenLand) { w = a; h = b; }
                else { w = b; h = a; }
            }
        }
    } catch (e) { /* ignore */ }
    return { w, h };
}

/**
 * 综合判断是否竖屏
 * iOS Safari 旋转瞬间 orientation / matchMedia / 宽高可能短暂不一致：
 * 以「宽高比」为主信号，其它 API 作辅助；明显横宽时强制横屏。
 */
function isPortraitOrientation() {
    const { w, h } = getViewportSize();
    // 主信号：宽高（旋转完成后最可靠）
    if (w > 0 && h > 0) {
        // 明显横屏
        if (w > h * 1.05) return false;
        // 明显竖屏
        if (h > w * 1.05) return true;
    }
    // 接近方形时再用系统 API
    try {
        if (typeof window.orientation === 'number') {
            const o = window.orientation;
            if (o === 90 || o === -90) return false;
            if (o === 0 || o === 180) return true;
        }
    } catch (e) { /* ignore */ }
    try {
        if (screen.orientation && typeof screen.orientation.type === 'string') {
            const t = screen.orientation.type;
            if (t.indexOf('landscape') === 0) return false;
            if (t.indexOf('portrait') === 0) return true;
        }
    } catch (e) { /* ignore */ }
    try {
        if (window.matchMedia('(orientation: landscape)').matches) return false;
        if (window.matchMedia('(orientation: portrait)').matches) return true;
    } catch (e) { /* ignore */ }
    if (!w || !h) return false;
    return h >= w;
}

function placeClaimIndicatorForOrientation(isPortrait) {
    const el = $('claim-indicator');
    if (!el) return;
    if (isPortrait) {
        const table = $('game-table');
        if (table && el.parentElement !== table) table.appendChild(el);
    } else {
        const wall = $('wall-count');
        if (wall && el.parentElement !== wall) wall.appendChild(el);
    }
}


/** 结算弹窗打开时：清 transform / 锁定偏移，保证横竖屏切换后「确定」仍可点 */
function hardenResultModalInteract() {
    try {
        const body = document.body;
        if (!body) return;
        const rm = document.getElementById('result-modal');
        const open = rm && rm.classList.contains('show');
        if (!open) return;
        if (body.classList.contains('modal-open')) {
            body.style.top = '0px';
            body.dataset.scrollY = '0';
        }
        rm.style.pointerEvents = 'auto';
        rm.style.touchAction = 'pan-y';
        const box = rm.querySelector('.result-box');
        if (box) {
            box.style.transform = 'none';
            box.style.webkitTransform = 'none';
            box.style.pointerEvents = 'auto';
        }
        rm.querySelectorAll('button').forEach(function (b) {
            b.style.pointerEvents = 'auto';
            b.style.touchAction = 'manipulation';
        });
    } catch (e) { /* ignore */ }
}

function checkPortraitGuard() {
    syncAppViewportVars();
    const isPortrait = isPortraitOrientation();
    const body = document.body;
    if (!body) return;
    const wasPortrait = body.classList.contains('portrait-layout');
    if (wasPortrait !== !!isPortrait) { try { orientTransitionCheck(); } catch (e) { /* 04 未加载时忽略 */ } } // 方向翻转：先隐藏牌桌再切换布局
    // 双布局：竖屏用 portrait-layout，横屏用默认横屏样式；不再强制拦截
    body.classList.toggle('portrait-layout', !!isPortrait);
    placeClaimIndicatorForOrientation(!!isPortrait);
    // 方向切换时刷新牌墙下列表（竖屏五行 / 横屏侧栏）
    if (wasPortrait !== !!isPortrait) {
        try { hideExposedInfo(); } catch (e) {}
        try { markDealer(); } catch (e) {}
        try { render(); } catch (e) {}
    }
    setTimeout(() => { try { fitBottomHand(); } catch (e) {} }, 60);
    if (isPortrait) setTimeout(() => { try { fitBottomHand(); } catch (e) {} }, 200);
    try { hardenResultModalInteract(); } catch (e) {}
}

/** 旋转/尺寸变化后多次复核（iOS 地址栏收起与旋转动画期间尺寸会变） */
/** 旋转处理状态（Android Chrome 会连续触发 orientation + resize） */
let _orientationHandling = false;
let _lastOrientationKey = '';
let _orientationTimers = [];

function clearOrientationTimers() {
    _orientationTimers.forEach(id => clearTimeout(id));
    _orientationTimers = [];
}

function getOrientationKey() {
    const { w, h } = getViewportSize();
    let type = '';
    try {
        if (screen.orientation && screen.orientation.type) type = screen.orientation.type;
    } catch (e) {}
    try {
        if (!type && typeof window.orientation === 'number') type = String(window.orientation);
    } catch (e) {}
    return type + '|' + (w > h ? 'L' : 'P') + '|' + w + 'x' + h;
}

/**
 * 统一响应屏幕旋转 / 视口变化
 * Android：orientationchange 时宽高常未更新，需等 resize / visualViewport；
 * 并做防抖，避免一次旋转触发十几次重排。
 */
function handleOrientationEvent(source) {
    try { orientTransitionCheck(); } catch (e) { /* 04 未加载时忽略 */ } // 第一时间发现方向翻转，抢在浏览器绘制「半成品」布局之前隐藏
    const key = getOrientationKey();
    // 同一稳定状态不重复打满定时器（resize 噪声多）
    if (source === 'resize' && key === _lastOrientationKey && !_orientationHandling) {
        syncAppViewportVars();
        return;
    }
    _orientationHandling = true;
    syncAppViewportVars();
    checkPortraitGuard();
    try { fitBottomHand(); } catch (e) {}

    clearOrientationTimers();
    const delays = isAndroidDevice()
        ? [0, 50, 100, 150, 250, 400, 600, 900, 1200, 1600]
        : [0, 50, 120, 250, 400, 700, 1100];
    delays.forEach(ms => {
        const id = setTimeout(() => {
            syncAppViewportVars();
            checkPortraitGuard();
            try { fitBottomHand(); } catch (e) {}
            const nowKey = getOrientationKey();
            if (ms >= delays[delays.length - 1] - 50) {
                _lastOrientationKey = nowKey;
                _orientationHandling = false;
            }
        }, ms);
        _orientationTimers.push(id);
    });
}

function schedulePortraitGuardChecks() {
    handleOrientationEvent('manual');
}

/** —— 屏幕旋转 / 视口事件绑定 —— */
function bindOrientationListeners() {
    // 1) 传统 orientationchange（部分 Android WebView 仍依赖）
    window.addEventListener('orientationchange', () => {
        handleOrientationEvent('orientationchange');
    }, { passive: true });

    // 2) Screen Orientation API（Chrome Android 推荐）
    try {
        if (screen.orientation && screen.orientation.addEventListener) {
            screen.orientation.addEventListener('change', () => {
                handleOrientationEvent('screen.orientation');
            });
        }
    } catch (e) { /* ignore */ }

    // 3) matchMedia 横竖屏切换（不依赖 orientation 事件，兼容性好）
    try {
        const mql = window.matchMedia('(orientation: landscape)');
        const onMql = () => handleOrientationEvent('matchMedia');
        if (mql.addEventListener) mql.addEventListener('change', onMql);
        else if (mql.addListener) mql.addListener(onMql); // 旧 Android WebView
    } catch (e) { /* ignore */ }

    // 4) resize：旋转后尺寸落稳的主信号（防抖在 handle 内）
    window.addEventListener('resize', () => {
        handleOrientationEvent('resize');
    }, { passive: true });

    // 5) visualViewport：Chrome 工具栏伸缩 / 旋转后的真实可见区域
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            handleOrientationEvent('visualViewport');
        }, { passive: true });
        window.visualViewport.addEventListener('scroll', () => {
            // 仅同步 CSS 变量，不做全量旋转流程，减少抖动
            syncAppViewportVars();
        }, { passive: true });
    }

    // 6) 回前台 / bfcache 恢复后再测一次（Android 多任务切换常见）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            handleOrientationEvent('visibility');
        }
    });
    window.addEventListener('pageshow', () => {
        handleOrientationEvent('pageshow');
    });

    document.addEventListener('DOMContentLoaded', () => {
        applyDevicePlatformClass();
        handleOrientationEvent('DOMContentLoaded');
    });
}

bindOrientationListeners();
applyDevicePlatformClass();
handleOrientationEvent('init');
syncAppViewportVars();
try { placeClaimIndicatorForOrientation(isPortraitOrientation()); } catch (e) {}

/* harden-result-on-orient：旋转全程多次加固结算确认可点 */
(function () {
    function kick() {
        try { hardenResultModalInteract(); } catch (e) {}
    }
    window.addEventListener('orientationchange', function () {
        kick();
        setTimeout(kick, 50);
        setTimeout(kick, 200);
        setTimeout(kick, 500);
        setTimeout(kick, 900);
    }, { passive: true });
    window.addEventListener('resize', function () {
        kick();
    }, { passive: true });
    try {
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', kick, { passive: true });
        }
    } catch (e) {}
})();
