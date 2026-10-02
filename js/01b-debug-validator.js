/*
 * Mahjong Debug / State Validator
 *
 * 只做观测与报警，不改变游戏规则、不阻断牌局。
 * 默认轻量运行；打开 ?debug=1（或 ?dbg=1）后，会输出更完整的上下文。
 */
;(function () {
    const VALID_SUITS = new Set(['万', '条', '筒', '字']);
    const VALID_HONORS = 7;
    const VALID_TILE_COUNT = 136;
    const MAX_COPIES = 4;
    const DEBUG = !!(
        (typeof window !== 'undefined' && (window.MAHJONG_DEBUG || window.location.search.includes('debug=1') || window.location.search.includes('dbg=1'))) ||
        (typeof globalThis !== 'undefined' && globalThis.MAHJONG_DEBUG)
    );

    Game.debug = DEBUG;
    Game.debugStats = {
        checks: 0,
        failures: 0,
        lastFailure: null,
        lastReason: ''
    };

    function tileIsValid(tile) {
        if (typeof tile !== 'string' || tile.length < 2) return false;
        const suit = tile.slice(-1);
        if (!VALID_SUITS.has(suit)) return false;
        const rank = Number(tile.slice(0, -1));
        if (!Number.isInteger(rank)) return false;
        return suit === '字' ? rank >= 1 && rank <= VALID_HONORS : rank >= 1 && rank <= 9;
    }

    function collectState() {
        const zones = [];
        const add = (zone, tile, meta) => zones.push({ zone, tile, meta: meta || null });
        (Game.deck || []).forEach((t, i) => add('deck', t, { index: i }));
        (Game.discardPile || []).forEach((e, i) => add('discard', e && e.tile, { index: i, player: e && e.player }));
        for (const p of (Game.PLAYERS || [])) {
            (Game.hands && Game.hands[p] || []).forEach((t, i) => add('hand:' + p, t, { index: i }));
            (Game.exposedMelds && Game.exposedMelds[p] || []).forEach((m, mi) => {
                (m && m.tiles || []).forEach((t, ti) => add('meld:' + p, t, { meld: mi, index: ti, type: m && m.type }));
            });
        }
        return zones;
    }

    function snapshotSummary(zones) {
        const byZone = {};
        for (const z of zones) byZone[z.zone] = (byZone[z.zone] || 0) + 1;
        return {
            phase: Game.phase,
            currentPlayer: Game.turnOrder && Game.turnOrder[Game.currentIndex],
            gameOver: !!Game.gameOver,
            total: zones.length,
            byZone,
            pendingClaim: Game.pendingClaim ? Game.pendingClaim.mode : null,
            flowTail: (Game.flowLog || []).slice(-5)
        };
    }

    function fail(reason, details) {
        Game.debugStats.failures++;
        Game.debugStats.lastFailure = { reason, details: details || null, at: Date.now() };
        if (Game.debug || !Game.gameOver) {
            try { console.warn('[state-check] ' + reason, details || ''); } catch (_) {}
        }
        try {
            if (typeof Game.logFlow === 'function') Game.logFlow('【状态检查】' + reason);
        } catch (_) {}
    }

    function validateGameState(reason) {
        Game.debugStats.checks++;
        Game.debugStats.lastReason = reason || '';

        // 游戏结束后的结算/转场存在短暂中间态，不强行判断牌区完整性。
        if (Game.gameOver) return true;

        const zones = collectState();
        let ok = true;

        // 开局瞬间（initGame 刚进入 dealing、牌墙尚未建好）牌区为空是正常过渡态，不算异常。
        const dealingBoot = zones.length === 0 && Game.PHASE && Game.phase === Game.PHASE.DEALING;
        if (zones.length !== VALID_TILE_COUNT && !dealingBoot) {
            ok = false;
            fail('牌区总数不是136张：' + zones.length + (reason ? ' @' + reason : ''), snapshotSummary(zones));
        }

        const counts = Object.create(null);
        const invalid = [];
        for (const z of zones) {
            if (!tileIsValid(z.tile)) {
                invalid.push(z);
                continue;
            }
            counts[z.tile] = (counts[z.tile] || 0) + 1;
        }
        if (invalid.length) {
            ok = false;
            fail('发现非法牌编码', invalid.slice(0, 8));
        }

        const overCopies = Object.keys(counts)
            .filter(t => counts[t] > MAX_COPIES)
            .map(t => ({ tile: t, count: counts[t] }));
        if (overCopies.length) {
            ok = false;
            fail('同一牌型超过4张', overCopies);
        }

        // 弃牌记录必须带有来源玩家；否则后续点炮/吃碰归属会变得不可追踪。
        const badDiscards = (Game.discardPile || []).filter(e => !e || !Game.PLAYERS.includes(e.player) || !tileIsValid(e.tile));
        if (badDiscards.length) {
            ok = false;
            fail('弃牌堆存在非法记录', badDiscards.slice(0, 8));
        }

        // 副露只允许标准3/4张组；不判断具体牌型，避免把特殊规则误判成错误。
        const badMelds = [];
        for (const p of (Game.PLAYERS || [])) {
            for (const m of (Game.exposedMelds[p] || [])) {
                const n = m && Array.isArray(m.tiles) ? m.tiles.length : 0;
                if (![3, 4].includes(n)) badMelds.push({ player: p, meld: m });
            }
        }
        if (badMelds.length) {
            ok = false;
            fail('副露组张数异常', badMelds.slice(0, 8));
        }

        // currentIndex 是牌局核心游标，必须始终指向合法玩家。
        if (!Number.isInteger(Game.currentIndex) || !Game.turnOrder || !Game.turnOrder[Game.currentIndex]) {
            ok = false;
            fail('currentIndex 指向非法玩家', { currentIndex: Game.currentIndex, turnOrder: Game.turnOrder });
        }

        // 活跃局必须存在合法 phase。
        if (Game.PHASE && !Object.values(Game.PHASE).includes(Game.phase)) {
            ok = false;
            fail('phase 非法：' + Game.phase);
        }

        if (Game.debug && !ok) {
            try { console.groupCollapsed('[state-check] 完整快照 @' + reason); console.log(snapshotSummary(zones)); console.log(zones); console.groupEnd(); } catch (_) {}
        }
        return ok;
    }

    function assertGameState(reason) {
        const ok = validateGameState(reason);
        if (!ok && Game.debug) {
            const err = new Error('Mahjong state invariant failed: ' + (reason || 'unknown'));
            err.state = Game.debugStats.lastFailure;
            console.error(err);
        }
        return ok;
    }

    Game.validateGameState = validateGameState;
    Game.assertGameState = assertGameState;
    Game.tileIsValid = tileIsValid;

    // 给开发者一个手动检查入口：?debug=1 后控制台执行 Game.debugCheck()
    Game.debugCheck = function (reason) {
        return assertGameState(reason || 'manual');
    };
})();
