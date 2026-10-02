;(function(){
// ---------- 输光自动重开 ----------
// 有人筹码输光 → 筹码重置为本场初始金额 → 骰子仪式重新调庄 → 仪式结束自动开局
// 由 17-field-manager.js 的 onFieldGameSettled 立 Game.bustAutoRestart 标记，
// 13-game-actions.js 的 startGame() 拦截后调这里，全程无需用户确认。
function autoRestartAfterBust() {
    Game.bustAutoRestart = null;
    if (typeof Game.startNewField === 'function') Game.startNewField(Game.fieldInitialAmount || 50);
    const rm = Game.$('result-modal');
    if (rm) rm.classList.remove('show'); // 骰子仪式要求结算弹窗已关闭
    if (typeof Game.startDiceRitualWithMode === 'function') {
        Game.startDiceRitualWithMode('dealer');
    } else if (typeof Game.startGame === 'function') {
        Game.startGame();
    }
}
Game.autoRestartAfterBust = autoRestartAfterBust;
})();
