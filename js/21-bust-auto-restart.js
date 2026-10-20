;(function(){
// ---------- 输光自动重开 ----------
// 有人筹码输光 → 筹码重置为本场初始金额 → 骰子仪式重新调庄 → 仪式结束自动开局
// 由 17-field-manager.js 的 onFieldGameSettled 立 Game.bustAutoRestart 标记，
// 13-game-actions.js 的 startGame() 拦截后调这里，全程无需用户确认。
function autoRestartAfterBust() {
    const busted = Game.bustAutoRestart;
    Game.bustAutoRestart = null;
    // 提示一下为什么重开（横幅 + 流程日志），不需要用户确认
    try {
        const who = (typeof busted === 'string' && Game.nameOf) ? Game.nameOf(busted) : '有人';
        const msg = who + '输光，重新开场';
        if (Game.feel && Game.feel.banner) Game.feel.banner(msg);
        if (Game.logFlow) Game.logFlow(msg + '（筹码重置，骰子调庄）');
    } catch (e) {}
    if (typeof Game.startNewField === 'function') Game.startNewField(Game.fieldInitialAmount || 50);
    const rm = Game.$('result-modal');
    if (rm) rm.classList.remove('show'); // 骰子仪式要求结算弹窗已关闭
    // 提示一下为什么重开（横幅会自行消失；失败不影响重开）
    try {
        const who = (typeof busted === 'string' && typeof Game.nameOf === 'function') ? Game.nameOf(busted) : '';
        const msg = (who ? who + ' ' : '') + '输光，重新开场';
        if (Game.feel && typeof Game.feel.banner === 'function') Game.feel.banner(msg);
        if (typeof Game.logFlow === 'function') Game.logFlow(msg);
    } catch (e) {}
    if (typeof Game.startDiceRitualWithMode === 'function') {
        Game.startDiceRitualWithMode('dealer');
    } else if (typeof Game.startGame === 'function') {
        Game.startGame();
    }
}
Game.autoRestartAfterBust = autoRestartAfterBust;
})();
