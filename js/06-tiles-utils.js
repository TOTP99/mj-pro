;(function(){
// 你的这张牌会不会点炮：公开信息危险度模型（現物/筋/壁/已见张数/对手威胁度）。
// 不再读 AI 的暗牌——AI 做决策不再偷看你，你的危险提示也不偷看 AI，对等公平。
// （提示是"看起来危险"，不是"必定点炮"，和成熟麻将游戏的危险牌提示同一定位。）
function isDangerousTile(tile) {
    if (Game.assist && Game.assist.dangerHint === false) return false; // 开关=否：不再标炮牌
    return ['top', 'left', 'right'].some(p => Game.publicDangerVs('bottom', tile, p) >= 0.5);
}

// 危险原因（一句话，给提示/教练用）：只解释"为什么危险"，依据全是公开信息，不读暗牌
function dangerReason(tile) {
    if (!isDangerousTile(tile)) return '';
    const oppName = { top: '对家', left: '上家', right: '下家' };
    const parts = [];
    for (const opp of ['top', 'left', 'right']) {
        if (Game.publicDangerVs('bottom', tile, opp) < 0.5) continue;
        const seen = Game.tileSeenCount(tile) + (Game.hands.bottom || []).filter(t => t === tile).length;
        const suit = Game.tileSuit(tile), rank = Game.tileRank(tile);
        let kind;
        if (suit === '字') kind = seen === 0 ? '生张字牌' : '字牌仅见' + seen + '张';
        else if (rank === 1 || rank === 9) kind = '幺九';
        else if (rank === 2 || rank === 8) kind = seen >= 3 ? '边张' : '边张生张';
        else kind = seen >= 3 ? '中张' : '中张生张';
        const melds = (Game.exposedMelds[opp] || []).length;
        parts.push(oppName[opp] + (melds >= 2 ? melds + '组副露' : '有威胁') + '，' + kind + '危险');
    }
    return parts.join('；');
}

function buildDeck() {
    Game.deck = [];
    for (let s of Game.suits) {
        for (let n = 1; n <= 9; n++) {
            for (let i = 0; i < 4; i++) Game.deck.push(n + s);
        }
    }
    for (let n = 1; n <= Game.honors.length; n++) {
        for (let i = 0; i < 4; i++) Game.deck.push(n + '字');
    }
    shuffle(Game.deck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function tileSuit(t){ return t.slice(-1); }
function tileRank(t){ return parseInt(t.slice(0, -1), 10); }

const rankChinese = ['一','二','三','四','五','六','七','八','九'];
function tileName(t) {
    if (tileSuit(t) === '字') return Game.honors[tileRank(t) - 1];
    return rankChinese[tileRank(t) - 1] + tileSuit(t);
}

// 流程日志等纯文字场景：用中文牌名（三万、东…），不再使用 Unicode 麻将字符
function tileGlyph(t) {
    return tileName(t);
}

// ---------- 牌面图片（tiles/*.webp，与 index.html 同级的 tiles 文件夹）----------
// 牌码仍是 '5万' '3条' '7筒' '1字'(=东)…；字牌顺序与 honors 一致：东南西北中发白
const TILE_IMG_DIR = 'tiles/';
const TILE_IMG_SUITS = { '万': 'man', '条': 'sou', '筒': 'pin' };
const TILE_IMG_HONORS = ['east', 'south', 'west', 'north', 'red', 'green', 'white'];

function tileImgSrc(t) {
    const suit = tileSuit(t), rank = tileRank(t);
    const name = suit === '字' ? TILE_IMG_HONORS[rank - 1] : TILE_IMG_SUITS[suit] + rank;
    return TILE_IMG_DIR + name + '.webp';
}

// 牌面 <img>：cls 传 'inline' 用于听牌提示等行内文字里的小牌
function tileImg(t, cls) {
    return '<img class="tile-img' + (cls ? ' tile-img-' + cls : '') + '" src="' + tileImgSrc(t) + '" alt="" draggable="false">';
}

// 牌背 <img>（tiles/back.webp）：加载失败时给外层 .tileback 加 no-img，回退成原来的蓝色牌背底
function tileBackImg() {
    return '<img class="tile-img tile-img-back" src="' + TILE_IMG_DIR + 'back.webp" alt="" draggable="false" onerror="if(this.parentNode)this.parentNode.classList.add(\'no-img\');this.remove()">';
}

// 提前加载 34 张牌面，避免第一次亮牌/摸牌时闪一下
(function preloadTileImages() {
    try {
        const all = [];
        for (const s of Game.suits) for (let n = 1; n <= 9; n++) all.push(n + s);
        for (let n = 1; n <= Game.honors.length; n++) all.push(n + '字');
        all.forEach(t => { const im = new Image(); im.src = tileImgSrc(t); });
        const bk = new Image(); bk.src = TILE_IMG_DIR + 'back.webp';
    } catch (e) {}
})();

/* ---- 本文件对外接口（IIFE 收敛，唯一出口） ---- */
Game.isDangerousTile = isDangerousTile;
Game.dangerReason = dangerReason;
Game.buildDeck = buildDeck;
Game.tileSuit = tileSuit;
Game.tileRank = tileRank;
Game.tileName = tileName;
Game.tileGlyph = tileGlyph;
Game.tileImg = tileImg;
Game.tileBackImg = tileBackImg;

;})();
