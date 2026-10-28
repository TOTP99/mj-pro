;(function () {
'use strict';
/* 视口 Sensor：统一输出 Game.layout，驱动横竖屏布局与缩放。
 * 兼容旧 class portrait-layout；新增 data-layout / data-tier 供 CSS 使用。 */

function isIOSDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isAndroidDevice() {
    return /Android/i.test(navigator.userAgent || '');
}
function isGoogleAndroidDevice() {
    if (!isAndroidDevice()) return false;
    const ua = navigator.userAgent || '';
    return /Pixel/i.test(ua) || /Nexus/i.test(ua);
}

function applyDevicePlatformClass() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;
    const android = isAndroidDevice();
    const ios = isIOSDevice();
    const google = isGoogleAndroidDevice();
    [root, body].forEach(function (el) {
        el.classList.toggle('is-android', android);
        el.classList.toggle('is-ios', ios);
        el.classList.toggle('is-google-android', google);
    });
}

/** 读取可视区尺寸（优先 visualViewport；Android 全屏优先 layout 视口） */
function getViewportSize() {
    let w = window.innerWidth || document.documentElement.clientWidth || 0;
    let h = window.innerHeight || document.documentElement.clientHeight || 0;
    try {
        if (window.visualViewport) {
            w = Math.round(window.visualViewport.width) || w;
            h = Math.round(window.visualViewport.height) || h;
        }
    } catch (e) { /* ignore */ }
    try {
        if (isAndroidDevice() && (document.fullscreenElement || document.webkitFullscreenElement)) {
            w = window.innerWidth || w;
            h = window.innerHeight || h;
        }
    } catch (e) { /* ignore */ }
    return { w: w || 0, h: h || 0 };
}

function syncAppViewportVars() {
    const size = getViewportSize();
    const root = document.documentElement;
    if (size.h > 0) root.style.setProperty('--app-height', size.h + 'px');
    if (size.w > 0) root.style.setProperty('--app-width', size.w + 'px');
    return size;
}

/** 是否竖屏：orientation API → matchMedia → 宽高比 */
function isPortraitOrientation() {
    try {
        if (typeof window.orientation === 'number') {
            const o = window.orientation;
            if (o === 0 || o === 180) return true;
            if (o === 90 || o === -90) return false;
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
    const size = getViewportSize();
    if (!size.w || !size.h) return false;
    return size.h >= size.w;
}

/** 尺寸档位：竖屏看高度，横屏看短边 */
function resolveTier(mode, w, h) {
    if (mode === 'portrait') {
        if (h <= 580 || w <= 360) return 'xs';
        if (h <= 700) return 'sm';
        if (h >= 900 && w >= 400) return 'lg';
        return 'md';
    }
    const shortSide = Math.min(w, h);
    if (shortSide <= 360) return 'xs';
    if (shortSide <= 500) return 'sm';
    if (shortSide >= 700) return 'lg';
    return 'md';
}

function readSafeInsets() {
    const cs = getComputedStyle(document.documentElement);
    const num = function (v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    return {
        t: num(cs.getPropertyValue('--sat')) || 0,
        r: num(cs.getPropertyValue('--sar')) || 0,
        b: num(cs.getPropertyValue('--sab')) || 0,
        l: num(cs.getPropertyValue('--sal')) || 0
    };
}

/** 单一真相源：写入 Game.layout + data-layout/data-tier + 兼容 class */
function publishLayout(force) {
    const size = syncAppViewportVars();
    const portrait = isPortraitOrientation();
    const mode = portrait ? 'portrait' : 'landscape';
    const tier = resolveTier(mode, size.w, size.h);
    const safe = readSafeInsets();
    const dpr = window.devicePixelRatio || 1;
    const sig = mode + '-' + tier + '-' + Math.round(size.w) + 'x' + Math.round(size.h);

    const prev = Game.layout || {};
    const changed = force || prev.sig !== sig || prev.mode !== mode;

    Game.layout = { mode: mode, tier: tier, w: size.w, h: size.h, safe: safe, dpr: dpr, sig: sig };

    const root = document.documentElement;
    const body = document.body;
    if (root) {
        root.setAttribute('data-layout', mode);
        root.setAttribute('data-tier', tier);
    }
    if (body) {
        body.classList.toggle('portrait-layout', portrait);
        body.setAttribute('data-layout', mode);
        body.setAttribute('data-tier', tier);
    }
    return changed;
}

function placeClaimIndicatorForOrientation(isPortrait) {
    const el = (Game.$ && Game.$('claim-indicator')) || document.getElementById('claim-indicator');
    if (!el) return;
    if (isPortrait) {
        const table = (Game.$ && Game.$('game-table')) || document.getElementById('game-table');
        if (table && el.parentElement !== table) table.appendChild(el);
    } else {
        const wall = (Game.$ && Game.$('wall-count')) || document.getElementById('wall-count');
        if (wall && el.parentElement !== wall) wall.appendChild(el);
    }
}

/** 结算弹窗打开时清除 transform，保证横竖切换后按钮可点 */
function hardenResultModalInteract() {
    try {
        const body = document.body;
        if (!body) return;
        const rm = document.getElementById('result-modal');
        if (!rm || !rm.classList.contains('show')) return;
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
    const prevMode = (Game.layout && Game.layout.mode) || null;
    const changed = publishLayout(false);
    const portrait = Game.layout.mode === 'portrait';
    placeClaimIndicatorForOrientation(portrait);

    if (changed && prevMode && prevMode !== Game.layout.mode) {
        try { Game.hideExposedInfo(); } catch (e) {}
        try { Game.markDealer(); } catch (e) {}
        try { Game.requestRender('orientationChange'); } catch (e) {}
    }
    setTimeout(function () { try { Game.fitBottomHand(); } catch (e) {} }, 60);
    if (portrait) setTimeout(function () { try { Game.fitBottomHand(); } catch (e) {} }, 200);
    try { hardenResultModalInteract(); } catch (e) {}
    return changed;
}

Game._orientationHandling = false;
Game._lastOrientationKey = '';
Game._orientationTimers = [];

function clearOrientationTimers() {
    Game._orientationTimers.forEach(function (id) { clearTimeout(id); });
    Game._orientationTimers = [];
}

function getOrientationKey() {
    const size = getViewportSize();
    let type = '';
    try {
        if (screen.orientation && screen.orientation.type) type = screen.orientation.type;
    } catch (e) {}
    try {
        if (!type && typeof window.orientation === 'number') type = String(window.orientation);
    } catch (e) {}
    return type + '|' + (size.w > size.h ? 'L' : 'P') + '|' + size.w + 'x' + size.h;
}

/**
 * 统一响应旋转 / 视口变化。
 * Android 旋转时宽高常滞后，靠多档延迟复核；同一稳定状态不重复重排。
 */
function handleOrientationEvent(source) {
    try { Game.orientTransitionCheck(); } catch (e) {}
    const key = getOrientationKey();
    if (source === 'resize' && key === Game._lastOrientationKey && !Game._orientationHandling) {
        syncAppViewportVars();
        return;
    }
    Game._orientationHandling = true;
    syncAppViewportVars();
    checkPortraitGuard();
    try { Game.fitBottomHand(); } catch (e) {}

    clearOrientationTimers();
    const delays = (source === 'init' || source === 'DOMContentLoaded')
        ? [0, 80]
        : [50, 120, 280];
    delays.forEach(function (ms) {
        const id = setTimeout(function () {
            syncAppViewportVars();
            checkPortraitGuard();
            try { Game.fitBottomHand(); } catch (e) {}
            try {
                if (typeof Game.autoFitTable === 'function') Game.autoFitTable(true);
            } catch (e) {}
            try {
                const tp = document.getElementById('claim-indicator');
                if (tp && tp.classList.contains('show') && typeof Game.placePromptAtDiamondCenter === 'function') {
                    Game.placePromptAtDiamondCenter();
                }
            } catch (e) {}
            hardenResultModalInteract();
            Game._lastOrientationKey = getOrientationKey();
            if (ms === delays[delays.length - 1]) Game._orientationHandling = false;
        }, ms);
        Game._orientationTimers.push(id);
    });
}

function bindOrientationListeners() {
    window.addEventListener('orientationchange', function () {
        handleOrientationEvent('orientationchange');
    }, { passive: true });
    try {
        if (screen.orientation && screen.orientation.addEventListener) {
            screen.orientation.addEventListener('change', function () {
                handleOrientationEvent('screen.orientation');
            });
        }
    } catch (e) {}
    try {
        const mql = window.matchMedia('(orientation: landscape)');
        const onMql = function () { handleOrientationEvent('matchMedia'); };
        if (mql.addEventListener) mql.addEventListener('change', onMql);
        else if (mql.addListener) mql.addListener(onMql);
    } catch (e) {}
    window.addEventListener('resize', function () {
        handleOrientationEvent('resize');
    }, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', function () {
            handleOrientationEvent('visualViewport');
        }, { passive: true });
        window.visualViewport.addEventListener('scroll', function () {
            syncAppViewportVars();
        }, { passive: true });
    }
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') handleOrientationEvent('visibility');
    });
    window.addEventListener('pageshow', function () {
        handleOrientationEvent('pageshow');
    });
    document.addEventListener('DOMContentLoaded', function () {
        applyDevicePlatformClass();
        handleOrientationEvent('DOMContentLoaded');
    });
}

bindOrientationListeners();
applyDevicePlatformClass();
handleOrientationEvent('init');
try { placeClaimIndicatorForOrientation(isPortraitOrientation()); } catch (e) {}

(function () {
    function kick() { try { hardenResultModalInteract(); } catch (e) {} }
    window.addEventListener('orientationchange', function () {
        kick();
        setTimeout(kick, 50);
        setTimeout(kick, 200);
        setTimeout(kick, 500);
        setTimeout(kick, 900);
    }, { passive: true });
    window.addEventListener('resize', kick, { passive: true });
    try {
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', kick, { passive: true });
        }
    } catch (e) {}
})();

Game.syncAppViewportVars = syncAppViewportVars;
Game.isPortraitOrientation = isPortraitOrientation;
Game.hardenResultModalInteract = hardenResultModalInteract;
Game.checkPortraitGuard = checkPortraitGuard;
Game.publishLayout = publishLayout;
Game.getViewportSize = getViewportSize;

;})();
