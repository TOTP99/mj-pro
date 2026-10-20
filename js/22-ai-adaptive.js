;(function () {
    'use strict';

    // AI 自适应层（第一阶段）：保留原有三种基础性格，只根据公开局势动态微调。
    // 不读取任何对手暗牌；不修改胡牌判定、合法动作或计分规则。
    // 该层在 11/19/20 模块之后加载，包装原 Game.aiTraitOf，供既有决策引擎使用。
    const originalTraitOf = typeof Game.aiTraitOf === 'function'
        ? Game.aiTraitOf.bind(Game)
        : function () { return {}; };
    const AI_PLAYERS = ['top', 'left', 'right'];
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    function getContext(player) {
        const scores = Game.scores || {};
        const ownScore = Number.isFinite(scores[player]) ? scores[player] : 0;
        const otherScores = (Game.turnOrder || ['bottom', 'right', 'top', 'left'])
            .filter(p => p !== player)
            .map(p => Number.isFinite(scores[p]) ? scores[p] : 0)
            .sort((a, b) => b - a);
        const lead = ownScore - (otherScores[0] || 0);
        const maxScore = Math.max(ownScore, ...otherScores, 0);
        const trailingGap = maxScore - ownScore;
        const wall = Array.isArray(Game.deck) ? Game.deck.length : 70;

        let maxThreat = 0;
        let avgThreat = 0;
        let threatCount = 0;
        for (const opp of (Game.turnOrder || [])) {
            if (opp === player) continue;
            let threat = 0;
            try {
                if (typeof Game.estimateOppTenpai === 'function') {
                    threat = Game.estimateOppTenpai(opp);
                } else {
                    threat = Math.min(0.9, ((Game.exposedMelds[opp] || []).length) * 0.2);
                }
            } catch (_) { threat = 0; }
            threat = clamp(Number.isFinite(threat) ? threat : 0, 0, 1);
            maxThreat = Math.max(maxThreat, threat);
            avgThreat += threat;
            threatCount++;
        }
        avgThreat = threatCount ? avgThreat / threatCount : 0;

        let ownTenpai = false;
        try {
            ownTenpai = typeof Game.isTenpai === 'function' && Game.isTenpai(player) === true;
        } catch (_) {}

        return {
            player,
            baseStyle: (Game.aiPersonality && Game.aiPersonality[player]) || 'shrewd',
            ownScore,
            lead,
            trailingGap,
            wall,
            maxThreat,
            avgThreat,
            ownTenpai,
            lateGame: wall <= 24,
            endGame: wall <= 12,
            ahead: lead >= 1500,
            farBehind: trailingGap >= 2000
        };
    }

    function adaptiveTraitOf(player) {
        const base = originalTraitOf(player) || {};
        // 人类玩家只在教练推荐等辅助场景使用静态底色，不对其策略参数做动态改写。
        if (!AI_PLAYERS.includes(player)) return Object.assign({}, base);

        const c = getContext(player);
        const t = Object.assign({}, base);

        // 1) 对手威胁是短期信号，比分是长期目标；两者同时参与，但设置上下限避免极端摆动。
        let defenseShift = 0;
        if (c.maxThreat >= 0.70) defenseShift -= 0.14;
        else if (c.maxThreat >= 0.48) defenseShift -= 0.07;
        if (c.ahead) defenseShift -= 0.10;
        if (c.farBehind) defenseShift += 0.12;
        if (c.ownTenpai) defenseShift += 0.03; // 已听牌时略偏进攻，但高威胁仍优先生效
        t.riskDefenseAt = clamp((Number.isFinite(base.riskDefenseAt) ? base.riskDefenseAt : 0.95) + defenseShift, 0.55, 1.35);

        // 2) 牌墙越短，领先者越应重视保分；大幅落后者则保留追分机会。
        let wallShift = 0;
        if (c.lateGame && c.ahead) wallShift += 3;
        if (c.endGame && c.ahead) wallShift += 2;
        if (c.lateGame && c.farBehind) wallShift -= 3;
        t.wallCautionAt = clamp((Number.isFinite(base.wallCautionAt) ? base.wallCautionAt : 10) + wallShift, 4, 24);

        // 3) 领先或对手威胁高时，更愿意截留危险牌、避免给下家提供机会。
        let defenseBias = 0;
        if (c.ahead) defenseBias += 0.45;
        if (c.maxThreat >= 0.60) defenseBias += 0.35;
        if (c.farBehind) defenseBias -= 0.40;
        t.cannonHoldTier = clamp((Number.isFinite(base.cannonHoldTier) ? base.cannonHoldTier : 1) + defenseBias, 0, 3);
        t.blockXiajiaTier = clamp((Number.isFinite(base.blockXiajiaTier) ? base.blockXiajiaTier : 1) + defenseBias * 0.8, 0, 3);

        // 4) 落后时允许更积极的吃碰与特殊牌型追逐；领先时更重视手牌效率与稳定性。
        if (c.farBehind) {
            t.ukeireKeepAt = clamp((Number.isFinite(base.ukeireKeepAt) ? base.ukeireKeepAt : 0.45) - 0.08, 0.15, 0.70);
            t.chaseSpecialSlack = clamp((Number.isFinite(base.chaseSpecialSlack) ? base.chaseSpecialSlack : 0) + 0.35, 0, 2);
        } else if (c.ahead) {
            t.ukeireKeepAt = clamp((Number.isFinite(base.ukeireKeepAt) ? base.ukeireKeepAt : 0.45) + 0.05, 0.15, 0.70);
            t.chaseSpecialSlack = clamp((Number.isFinite(base.chaseSpecialSlack) ? base.chaseSpecialSlack : 0) - 0.20, 0, 2);
        }

        return t;
    }

    function snapshot(player) {
        const c = getContext(player);
        const base = originalTraitOf(player) || {};
        const adaptive = adaptiveTraitOf(player);
        return {
            ...c,
            adaptive: {
                riskDefenseAt: adaptive.riskDefenseAt,
                wallCautionAt: adaptive.wallCautionAt,
                cannonHoldTier: adaptive.cannonHoldTier,
                blockXiajiaTier: adaptive.blockXiajiaTier,
                ukeireKeepAt: adaptive.ukeireKeepAt,
                chaseSpecialSlack: adaptive.chaseSpecialSlack
            },
            baseline: {
                riskDefenseAt: base.riskDefenseAt,
                wallCautionAt: base.wallCautionAt,
                cannonHoldTier: base.cannonHoldTier,
                blockXiajiaTier: base.blockXiajiaTier,
                ukeireKeepAt: base.ukeireKeepAt,
                chaseSpecialSlack: base.chaseSpecialSlack
            }
        };
    }

    Game.aiTraitOf = adaptiveTraitOf;
    Game.getAiAdaptiveContext = getContext;
    Game.getAiAdaptiveSnapshot = snapshot;
    Game.aiAdaptive = {
        enabled: true,
        version: '1.0.0',
        description: '公开信息驱动的比分/牌墙/对手威胁自适应策略'
    };
})();
