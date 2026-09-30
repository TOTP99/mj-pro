;(function(){
// 你的这张牌会不会点炮：真实炮牌判断。
// 等价于「该 AI 的听牌列表里有这张牌」——直接读三家 AI 的真实暗牌+副露，用游戏自己的胡牌判定算出。
// 标出来的牌，你打出去那一刻就会被胡（不是估计）。想要公平就把「危险提示」开关关掉。
// getWinningTilesOf 带缓存（暗牌+副露+亮牌加成为键），同一副手牌命中缓存后不重复计算。
// 注意：只有这个提示读暗牌；AI 自己的决策（11/19/20）仍只用公开信息，不受影响。
function winnersOf(tile) {
    return ['top', 'left', 'right'].filter(p =>
        Game.getWinningTilesOf(Game.hands[p], Game.exposedMelds[p], p).includes(tile));
}
function isDangerousTile(tile) {
    if (Game.assist && Game.assist.dangerHint === false) return false; // 开关=否：不再标炮牌
    return winnersOf(tile).length > 0;
}

// 危险原因（一句话，给提示用）：说出是哪几家会胡这张牌
function dangerReason(tile) {
    if (!isDangerousTile(tile)) return '';
    const oppName = { top: '对家', left: '上家', right: '下家' };
    return winnersOf(tile).map(p => oppName[p]).join('、') + '听这张牌，打出去会点炮';
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
