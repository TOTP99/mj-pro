function canPeng(hand, tile) {
    return hand.filter(t => t === tile).length >= 2;
}

function canGang(hand, tile) {
    return hand.filter(t => t === tile).length >= 3;
}

// 返回可吃的组合（手牌中的两张），找不到返回 null
// 返回所有可行的吃法组合(可能不止一种，比如摸到5万，手里有3万4万又有6万7万)
function findChiCombos(hand, tile) {
    const suit = tileSuit(tile);
    if (suit === '字') return []; // 字牌没有顺子，不能吃
    const rank = tileRank(tile);
    const combos = [[rank - 2, rank - 1], [rank - 1, rank + 1], [rank + 1, rank + 2]];
    const found = [];
    for (const [a, b] of combos) {
        if (a < 1 || b > 9) continue;
        const ta = a + suit, tb = b + suit;
        if (hand.includes(ta) && hand.includes(tb)) found.push([ta, tb]);
    }
    return found;
}

function nameOf(p) {
    return { top: '西', left: '北', right: '南', bottom: '东' }[p];
}
/** 座位对应动物（状态栏小头像：龙西/虎北/狮南/猫东） */
function animalOf(p) {
    return { top: '龙', left: '虎', right: '狮', bottom: '猫' }[p] || '';
}
/** 「东 猫」「南 狮」 */
function seatLabel(p) {
    const w = nameOf(p), a = animalOf(p);
    return a ? (w + ' ' + a) : w;
}

// 显示验胡结算画面：谁胡/自摸or点炮/完整手牌/吃碰杠亮/计分明细/每家加减分
function showResultModal(winnerPlayer, mode, payer, bonus, result, winTile) {
    // 例：东 猫 胡 / 自摸；或 东 猫 胡 / 南 狮 点炮
    $('result-title').innerText = seatLabel(winnerPlayer) + ' 胡';
    $('result-subtitle').innerText =
        mode === 'selfdraw' ? '自摸' : (seatLabel(payer) + ' 点炮');

    const concealedSorted = [...hands[winnerPlayer]].sort(tileCompare);
    let winMarked = false;
    $('result-concealed').innerHTML =
        concealedSorted.map(t => {
            const isWin = !winMarked && t === winTile;
            if (isWin) winMarked = true;
            return `<div class="tile-wrap"><div class="tile-marker"></div><div class="tile exposed${isWin ? ' win-glow' : ''}">${tileImg(t)}</div></div>`;
        }).join('') || '（无）';
    $('result-exposed').innerHTML =
        exposedMelds[winnerPlayer].map(renderMeldGroup).join('') || '（无）';

    const lines = [mode === 'selfdraw' ? '底分 ×1' : '底分 ×2'];
    result.tags.forEach(t => lines.push(t.replace('×', ' ×')));
    $('result-score-lines').innerHTML = lines.map(l => `<div>${l}</div>`).join('');

    lastSettlement = {
        mode,
        winner: winnerPlayer,
        payer: payer || null,
        systemPayouts: { top: result.payouts.top, left: result.payouts.left, right: result.payouts.right, bottom: result.payouts.bottom },
        payouts: { top: result.payouts.top, left: result.payouts.left, right: result.payouts.right, bottom: result.payouts.bottom },
        systemTotal: result.total,
        noKaimenPlayers: result.noKaimenPlayers || [],
        adjusting: false
    };
    renderSettlementView();
    $('result-adjust-panel').style.display = 'none';
    const btn = $('btn-toggle-adjust');
    if (btn) btn.textContent = '特殊情况：手动调分';
    $('result-modal').classList.add('show');
    flushSaveProgress(); // 结算后立刻落盘，防刷新丢分
}

function renderSettlementView() {
    if (!lastSettlement) return;
    const pay = lastSettlement.payouts;
    const noKaimenPlayers = lastSettlement.noKaimenPlayers || [];
    const edited = turnOrder.some(p => pay[p] !== lastSettlement.systemPayouts[p]);
    const sumWin = turnOrder.reduce((s, p) => s + Math.max(0, pay[p]), 0);
    $('result-total').innerText =
        (edited ? '调整后得分合计：' : '总分：') + sumWin + (edited ? '（已手动修改）' : '');

    // 默认只读展示
    $('result-payouts').innerHTML = turnOrder.map(p => {
        const v = pay[p];
        const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
        const sign = v > 0 ? '+' : '';
        const tag = noKaimenPlayers.includes(p) ? ' <span class="no-kaimen-tag">没开门</span>' : '';
        return `<div class="${cls}">${nameOf(p)} ${sign}${v}${tag}</div>`;
    }).join('');

    // 调分面板（仅打开时可见）
    $('result-payouts-edit').innerHTML = turnOrder.map(p => {
        const v = pay[p];
        const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
        const tag = noKaimenPlayers.includes(p) ? ' <span class="no-kaimen-tag">没开门</span>' : '';
        return `<div class="payout-row ${cls}">
            <span class="pname">${nameOf(p)}${tag}</span>
            <button type="button" class="payout-btn" onclick="event.stopPropagation();adjustSettlementPayoutFactor('${p}', 0.5)">÷2</button>
            <input type="number" step="1" value="${v}" data-player="${p}"
                onchange="onSettlementPayoutEdit(this)">
            <button type="button" class="payout-btn" onclick="event.stopPropagation();adjustSettlementPayoutFactor('${p}', 2)">×2</button>
        </div>`;
    }).join('');
}

function toggleSettlementAdjust() {
    if (!lastSettlement) return;
    lastSettlement.adjusting = !lastSettlement.adjusting;
    const panel = $('result-adjust-panel');
    const btn = $('btn-toggle-adjust');
    if (lastSettlement.adjusting) {
        panel.style.display = 'block';
        if (btn) btn.textContent = '收起手动调分';
        renderSettlementView();
    } else {
        panel.style.display = 'none';
        if (btn) btn.textContent = '特殊情况：手动调分';
    }
}

// 改一家，其余按点炮/自摸关系自动联动
function onSettlementPayoutEdit(input) {
    if (!lastSettlement) return;
    const p = input.dataset.player;
    if (input.value.trim() === '' || input.value.trim() === '-') return; // 还在输入中（比如刚打了个负号），先不处理
    let v = parseInt(input.value, 10);
    if (isNaN(v)) return;
    applySettlementPayoutValue(p, v);
}

// ×2 / ÷2 按钮：在当前值基础上直接乘/除，可反复点击
function adjustSettlementPayoutFactor(p, factor) {
    if (!lastSettlement) return;
    const cur = lastSettlement.payouts[p];
    const v = Math.round(cur * factor);
    applySettlementPayoutValue(p, v);
}

// 改一家，其余按点炮/自摸关系自动联动
function applySettlementPayoutValue(p, v) {
    if (!lastSettlement) return;
    const old = lastSettlement.payouts[p];
    if (v === old) return;

    const { mode, winner, payer } = lastSettlement;
    const pay = lastSettlement.payouts;

    if (mode === 'dianpao') {
        // 点炮：只有赢家与点炮者，互为相反数
        if (p === winner) {
            pay[winner] = v;
            if (payer) pay[payer] = -v;
        } else if (p === payer) {
            pay[payer] = v;
            pay[winner] = -v;
        } else {
            // 其余两家本应是 0，强制回 0
            pay[p] = 0;
        }
    } else {
        // 自摸：三家付钱，赢家收总和
        if (p === winner) {
            // 改赢家总分：按原系统付款比例（或均分）把差额摊到三家
            const losers = turnOrder.filter(x => x !== winner);
            const oldWin = old;
            const delta = v - oldWin;
            pay[winner] = v;
            // 按原付款绝对值比例分摊；若原都为 0 则均分
            const weights = losers.map(x => Math.abs(lastSettlement.systemPayouts[x]) || 0);
            const wsum = weights.reduce((a, b) => a + b, 0);
            if (wsum === 0) {
                const each = Math.trunc(delta / losers.length);
                let remain = delta - each * losers.length;
                losers.forEach((x, i) => {
                    pay[x] -= each + (i === 0 ? remain : 0);
                });
            } else {
                let allocated = 0;
                losers.forEach((x, i) => {
                    if (i === losers.length - 1) {
                        pay[x] -= (delta - allocated);
                    } else {
                        const share = Math.round(delta * weights[i] / wsum);
                        pay[x] -= share;
                        allocated += share;
                    }
                });
            }
        } else {
            // 改某一家付款：赢家收入随之增减
            const delta = v - old; // 付款方变多（如 -4→-6，delta=-2）则赢家少 2
            pay[p] = v;
            pay[winner] -= delta;
        }
    }

    renderSettlementView();
    // 保持当前编辑框焦点数值已由 render 刷新
}

function resetSettlementPayouts() {
    if (!lastSettlement) return;
    lastSettlement.payouts = {
        top: lastSettlement.systemPayouts.top,
        left: lastSettlement.systemPayouts.left,
        right: lastSettlement.systemPayouts.right,
        bottom: lastSettlement.systemPayouts.bottom
    };
    renderSettlementView();
}


function closeResultModal() {
    // 若手动改过分，把差额补进 scores（系统分已在 settleScore 时写入）
    if (lastSettlement) {
        for (const p of turnOrder) {
            const delta = lastSettlement.payouts[p] - lastSettlement.systemPayouts[p];
            if (delta) scores[p] += delta;
        }
        lastSettlement = null;
    }
    $('result-modal').classList.remove('show');
    if (gameOver) startGame();
}

// 确认/放弃按钮的图标（内联 SVG：绿底对勾、红底叉；大小跟随 .claim-btn 的 font-size）
const ICON_CLAIM_YES = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#2f9e5f"/><path d="M6.6 12.6l3.7 3.7 7.1-7.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLAIM_NO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#c8453b"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>';

/** 吃碰杠时在桌面正中显示当前被叫的牌；无牌或非 claim/selfGang 时隐藏 */
function updateClaimFocusTile() {
    let el = $('claim-focus-tile');
    if (!el) {
        const table = $('game-table');
        if (!table) return;
        el = document.createElement('div');
        el.id = 'claim-focus-tile';
        el.setAttribute('aria-hidden', 'true');
        table.appendChild(el);
    }
    const tile = (pendingClaim && pendingClaim.tile
        && (pendingClaim.mode === 'claim' || pendingClaim.mode === 'selfGang'))
        ? pendingClaim.tile : null;
    if (tile && typeof tileImg === 'function') {
        el.innerHTML = '<div class="tile-wrap"><div class="tile-marker"></div><div class="tile">' + tileImg(tile) + '</div></div>';
        el.classList.add('show');
    } else {
        el.innerHTML = '';
        el.classList.remove('show');
    }
}

function showIndicator(text, interactive) {
    const el = $('claim-indicator');
    if (interactive) {
        el.innerHTML = '<span class="claim-actions">'
            + '<span class="claim-btn claim-yes" role="button" aria-label="确认" onclick="event.stopPropagation();acceptClaim()">' + ICON_CLAIM_YES + '</span>'
            + '<span class="claim-btn claim-no" role="button" aria-label="过" onclick="event.stopPropagation();declineClaim()">' + ICON_CLAIM_NO + '</span>'
            + '</span>'
            + '<span class="claim-label">' + text + '</span>';
    } else {
        el.innerText = text;
    }
    el.classList.add('show');
    try { updateClaimFocusTile(); } catch (e) {}
    if (document.body && document.body.classList.contains('portrait-layout')) {
        const tip = $('tile-tooltip');
        if (tip) tip.classList.remove('show');
    }
    if (!(document.body && document.body.classList.contains('portrait-layout'))) {
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }
}

function hideIndicator() {
    const el = $('claim-indicator');
    el.classList.remove('show');
    el.innerHTML = '';
    try { updateClaimFocusTile(); } catch (e) {}
    if (document.body && document.body.classList.contains('portrait-layout')
        && typeof exposedInfoShownFor !== 'undefined' && exposedInfoShownFor) {
        try { showExposedInfo(exposedInfoShownFor); } catch (e) {}
    }
}

// ---- 竖屏副露：点击头像显示/隐藏（横屏仍用头像下常驻副露，不走此浮层）----
let exposedInfoShownFor = null;

function toggleExposedInfo(player) {
    if (!(document.body && document.body.classList.contains('portrait-layout'))) {
        return;
    }
    if (exposedInfoShownFor === player) {
        exposedInfoShownFor = null;
        hideExposedInfo();
        return;
    }
    exposedInfoShownFor = player;
    showExposedInfo(player);
}

function showExposedInfo(player) {
    const tooltip = $('tile-tooltip');
    if (!tooltip) return;
    const melds = exposedMelds[player] || [];
    if (!melds.length) {
        tooltip.innerHTML = '';
        tooltip.classList.remove('show');
        return;
    }
    const avatar = (typeof statAvatar !== 'undefined' && statAvatar[player]) ? statAvatar[player] : '';
    const head = avatar ? `<div class="tt-avatar">${avatar}</div>` : '';
    const rows = melds.slice(0, 3).map(m => {
        let tilesHtml;
        if (m.type === 'gang' && m.concealed) {
            tilesHtml = renderExposedFace(m.tiles[0]) + renderExposedBack() + renderExposedBack() + renderExposedBack();
        } else {
            tilesHtml = m.tiles.map(renderExposedFace).join('');
        }
        return `<div class="tt-meld"><span class="tt-tiles">${tilesHtml}</span></div>`;
    }).join('');
    tooltip.innerHTML = head + rows;
    const claimOn = $('claim-indicator') && $('claim-indicator').classList.contains('show');
    if (claimOn) tooltip.classList.remove('show');
    else tooltip.classList.add('show');
}

function hideExposedInfo() {
    exposedInfoShownFor = null;
    const tooltip = $('tile-tooltip');
    if (tooltip) tooltip.classList.remove('show');
}

// ---- 长按头像：玩家文字介绍（禁系统复制/分享菜单）----
const PLAYER_INTRO = {
    top: {
        title: '龙 · 西',
        sub: '性格精明 · 攻守平衡',
        body: '吃碰看收益，不乱开火。中发白、风牌多留；危险牌会躲，不僵持。副露适中，重听牌质量与安全。'
    },
    left: {
        title: '虎 · 北',
        sub: '性格保守 · 求稳少险',
        body: '优先安全牌，少点炮。吃碰很挑，向听变差基本不做；副露也少。听后更不拆牌，偏稳。'
    },
    right: {
        title: '狮 · 南',
        sub: '性格激进 · 敢打敢冲',
        body: '为求速度更敢吃碰、开门，可接受向听稍差。副露可偏多，常往碰碰胡靠。躲炮少，进攻强，也易放炮。'
    }
    // bottom（猫 · 东）已取消性格介绍：长按大头像改为调庄，见下方 onAvatarPointerDown / onAvatarContextMenu
};

const AVATAR_LONGPRESS_MS = 480;
let _avatarLpTimer = 0;
let _avatarLpFired = false;
let _avatarLpPlayer = null;

function playerFromAvatarEl(el) {
    const p = el && el.closest && el.closest('.player');
    if (!p || !p.id || p.id.indexOf('p-') !== 0) return null;
    return p.id.slice(2);
}

function showPlayerIntro(player) {
    const info = PLAYER_INTRO[player];
    if (!info) return;
    const modal = $('player-intro-modal');
    if (!modal) return;
    const t = $('player-intro-title');
    const s = $('player-intro-sub');
    const b = $('player-intro-body');
    if (t) t.textContent = info.title;
    if (s) s.textContent = info.sub;
    if (b) b.textContent = info.body;
    modal.classList.add('show');
}

function closePlayerIntro() {
    const modal = $('player-intro-modal');
    if (modal) modal.classList.remove('show');
}

function clearAvatarLongPress() {
    if (_avatarLpTimer) {
        clearTimeout(_avatarLpTimer);
        _avatarLpTimer = 0;
    }
}

function onAvatarPointerDown(e) {
    const av = e.target && e.target.closest && e.target.closest('.avatar');
    if (!av) return;
    if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return;
    const player = playerFromAvatarEl(av);
    if (!player) return;
    _avatarLpFired = false;
    _avatarLpPlayer = player;
    clearAvatarLongPress();
    _avatarLpTimer = setTimeout(() => {
        _avatarLpTimer = 0;
        _avatarLpFired = true;
        if (player === 'bottom') {
            // 东·大猫头：长按掉骰子调庄（原「小猫头」的 hidden gem 已迁移到这里）
            try {
                if (typeof diceBusy !== 'undefined' && diceBusy) return;
                if (typeof startDiceDealerRitual === 'function') startDiceDealerRitual();
            } catch (err) { /* ignore */ }
            return;
        }
        showPlayerIntro(player);
    }, AVATAR_LONGPRESS_MS);
}

function onAvatarPointerUp(e) {
    clearAvatarLongPress();
}

function onAvatarClickCapture(e) {
    const av = e.target && e.target.closest && e.target.closest('.avatar');
    if (!av) return;
    if (_avatarLpFired) {
        e.preventDefault();
        e.stopPropagation();
        _avatarLpFired = false;
    }
}

function onAvatarContextMenu(e) {
    const av = e.target && e.target.closest && e.target.closest('.avatar');
    if (!av) return;
    e.preventDefault();
    e.stopPropagation();
    const player = playerFromAvatarEl(av);
    if (!player) return;
    if (player === 'bottom') {
        try {
            if (typeof diceBusy !== 'undefined' && diceBusy) return;
            if (typeof startDiceDealerRitual === 'function') startDiceDealerRitual();
        } catch (err) { /* ignore */ }
        return;
    }
    showPlayerIntro(player);
}

(function bindAvatarLongPress() {
    const root = document;
    root.addEventListener('pointerdown', onAvatarPointerDown, { passive: true });
    root.addEventListener('pointerup', onAvatarPointerUp, { passive: true });
    root.addEventListener('pointercancel', onAvatarPointerUp, { passive: true });
    root.addEventListener('click', onAvatarClickCapture, true);
    root.addEventListener('contextmenu', onAvatarContextMenu, true);
})();

function highlightActive(player) {
    document.querySelectorAll('.player').forEach(el => el.classList.remove('active'));
    $('p-' + player).classList.add('active');
}
