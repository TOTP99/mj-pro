;(function(){
/* 14-credit-clock.js
 * 接管 #credit-label 的内容（仅竖屏可见，横屏由 CSS 隐藏）：
 *   单行：时钟框(HH:MM) + 模式 + 筹码 + 音效（缩写按钮，统一样式）
 *   署名移到右下角 #credit-corner；1/东/1 移到牌墙旁；在线时长已删。
 * 横屏：竖屏那行被 CSS 隐藏；左侧栏的 #img-display-badge（TP制作）只显示「TP制作」。
 * 加载顺序无要求：只在事件/点击回调里用 Game，加载期只碰 DOM。
 */
(function () {
    'use strict';

    // 时钟框：按键同款样式（由 CSS .credit-clock 控制）
    var el1 = document.getElementById('credit-label');
    if (!el1) return;

    el1.style.whiteSpace = 'nowrap';
    el1.style.fontVariantNumeric = 'tabular-nums';

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    var lastHtml = '';

    function render() {
        var d = new Date();
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        // 单行：时钟框 + 三个缩写按钮（按钮只建一次）
        var html = '<span class="credit-clock">' + hm + '</span>' +
            '<button type="button" class="credit-btn" onclick="Game.openModeSelect()">模式</button>' +
            '<button type="button" class="credit-btn" onclick="Game.openAmountSelect()">筹码</button>' +
            '<button type="button" class="credit-btn" id="sfx-toggle" onclick="Game.toggleSfx()">音效</button>';
        if (html !== lastHtml) { el1.innerHTML = html; lastHtml = html; }
        // 同步音效按钮状态
        try { if (typeof syncSfxButtons === 'function') syncSfxButtons(); } catch (e) {}
    }

    render();
    setInterval(render, 1000);
})();

;})();
