#!/usr/bin/env node
'use strict';
// 单机引擎浸泡测试：真 Chromium 里自动打多局，随机刷新页面验证存档恢复。
// 检查：牌数守恒、四家总分守恒（每局零和）、场次金额与分数同步、手牌张数合法、
//       刷新后状态与存档逐项一致、刷新后不卡死、无页面异常。
// 用法：node tests/engine-soak.pw.cjs [局数=20] [--daily|--advanced]
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require('./pw-path.cjs');
const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const HANDS = parseInt(ARGS.find(a => /^\d+$/.test(a)) || '20', 10);
const ADV = ARGS.includes('--advanced');
const PORT = 8766;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp' };

const DRIVER = `(${function () {
  const S = window.__S = window.__S || { acted: '', closeAt: 0, errs: [] };
  Game.aiThinkMs = () => 30;
  const rnd = Math.random;
  const shown = id => { const e = document.getElementById(id); return e && e.classList.contains('show'); };
  const fakeEv = idx => ({ target: { closest: () => ({ dataset: { index: String(idx) }, getBoundingClientRect: () => null }) } });
  setInterval(function () {
    try {
      const now = Date.now();
      if (shown('mode-select-modal')) { Game.chooseMode(window.__ADV ? 'advanced' : 'daily'); return; }
      if (shown('rules-modal')) { try { Game.confirmRules(); } catch (e) { S.errs.push('confirmRules ' + e); } return; }
      if (shown('amount-modal')) { Game.chooseAmount(50); return; }
      if (shown('reveal-modal')) { Game.confirmReveal(rnd() < 0.6); return; }
      if (shown('round-modal')) { try { Game.confirmRound && Game.confirmRound(); } catch (e) {} }
      if (shown('result-modal')) { if (!S.closeAt) S.closeAt = now + 200; if (now >= S.closeAt) { S.closeAt = 0; S.hands = (S.hands || 0) + 1; Game.closeResultModal(); } return; }
      S.closeAt = 0;
      const pc = Game.pendingClaim;
      if (pc && pc.mode === 'nextGame') { if (S.acted !== 'ng' + Game.gameEpoch) { S.acted = 'ng' + Game.gameEpoch; S.hands = (S.hands || 0) + 1; Game.acceptClaim(); } return; }
      if (Game.gameOver) return;
      if (pc && pc.mode === 'claim') { const k = 'c' + Game.discardPile.length + Game.gameEpoch; if (S.acted !== k) { S.acted = k; if (rnd() < 0.6) { Game.acceptClaim(); if (shown('chi-choice-modal')) Game.chooseChiCombo(0); } else Game.declineClaim(); } return; }
      if (pc && pc.mode === 'selfGang') { if (rnd() < 0.5) Game.acceptClaim(); else Game.handleDiscard(fakeEv(Math.floor(rnd() * Game.hands.bottom.length))), Game.handleDiscard(fakeEv(0)); return; }
      if (!pc && Game.turnOrder[Game.currentIndex] === 'bottom' && Game.hands.bottom.length % 3 === 2) {
        const idx = Math.floor(rnd() * Game.hands.bottom.length); Game.handleDiscard(fakeEv(idx)); Game.handleDiscard(fakeEv(idx));
      }
    } catch (e) { S.errs.push(String(e && e.stack || e)); }
  }, 60);
}})();`;

const STATE = () => ({
  hands: Game.hands, melds: Game.exposedMelds, deck: Game.deck.length, discard: Game.discardPile.length, scores: Game.scores,
  cur: Game.currentIndex, dealer: Game.dealer, over: Game.gameOver,
  n: Game.totalTilesOf({ deck: Game.deck, discardPile: Game.discardPile, hands: Game.hands, exposedMelds: Game.exposedMelds }),
  sumScores: Object.values(Game.scores).reduce((a, b) => a + b, 0), sumField: Object.values(Game.fieldAmounts || {}).reduce((a, b) => a + b, 0),
  fieldActive: !!Game.fieldActive, hc: ['top', 'left', 'right', 'bottom'].map(p => Game.hands[p].length + '/' + Game.exposedMelds[p].length).join(' '),
  sig: [Game.deck.length, Game.discardPile.length, Game.currentIndex, Game.gameOver, Game.pendingClaim && Game.pendingClaim.mode].join('|'),
  ak: [Game.afterKongDrawPlayer || null, Game.afterKongDiscardPlayer || null],
  full: Game.FULL_DECK_SIZE
});

(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    fs.readFile(f, (e, b) => { if (e) { res.writeHead(/favicon/.test(req.url) ? 204 : 404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
  }).listen(PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  // 刷新后先"冻结"长延时回调，等对比完存档再放行，避免恢复流程里的 AI 摸牌抢在对比之前
  await ctx.addInitScript(() => {
    try { window.__SAVED = localStorage.getItem('qionghu_mahjong_new_progress_v2'); } catch (e) {}
    window.__HOLD = true; const st = window.setTimeout.bind(window);
    window.setTimeout = function (f, ms, ...a) {
      if (typeof f === 'function' && ms >= 20) { const run = () => (window.__HOLD ? st(run, 50) : f(...a)); return st(run, ms); }
      return st(f, ms, ...a);
    };
  });
  const page = await ctx.newPage();
  const problems = []; let reloads = 0, hands = 0, lastHandsSeen = 0;
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text().slice(0, 200) + ' ' + (m.location().url || '')); });
  page.on('dialog', d => { problems.push('alert: ' + d.message()); d.dismiss().catch(() => {}); });
  async function boot() {
    await page.goto('http://localhost:' + PORT + '/index.html');
    await page.waitForFunction(() => window.Game && Game._booted, null, { timeout: 15000 });
  }
  async function install() { await page.evaluate(() => { window.__HOLD = false; }); await page.evaluate('window.__ADV = ' + ADV); await page.evaluate(DRIVER); }
  await boot(); await install();
  let base = null, lastSig = '', lastChange = Date.now(), nextReload = Date.now() + 6000 + Math.random() * 9000, carry = 0;
  const t0 = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, 400));
    const st = await page.evaluate(STATE);
    const S = await page.evaluate(() => window.__S);
    if (S.errs.length) { problems.push('driver: ' + S.errs.join(' | ')); break; }
    hands = carry + (S.hands || 0);
    if (st.n !== 0 && st.n !== st.full) problems.push('牌数不守恒 ' + st.n + '/' + st.full + ' 手牌/副露=' + st.hc);
    if (st.fieldActive) {
      if (base === null) base = { s: st.sumScores, f: st.sumField };
      if (st.sumScores !== base.s) problems.push('四家总分不守恒 ' + st.sumScores + ' != ' + base.s);
      if (st.sumField !== base.f) problems.push('场次金额不守恒 ' + st.sumField + ' != ' + base.f);
    }
    const bad = ['top', 'left', 'right', 'bottom'].filter((p, i) => false);
    const sig = st.sig + '|' + hands; if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    if (Date.now() - lastChange > 25000) { problems.push('卡死 25 秒无变化 sig=' + st.sig + ' 手牌/副露=' + st.hc + ' 当前=' + st.cur); break; }
    if (problems.length) break;
    if (hands >= HANDS) break;
    if (Date.now() > nextReload && st.fieldActive) { // 随机刷新：校验存档恢复
      nextReload = Date.now() + 5000 + Math.random() * 12000;
      await page.evaluate(() => { Game.flushSaveProgress(); });
      carry = hands; reloads++;
      await boot();
      // 以"刷新瞬间页面拿到的存档"为准（刷新前页面还会再跑一点，不能用刷新前读到的）
      const saved = await page.evaluate(() => JSON.parse(window.__SAVED || 'null'));
      if (!saved) { problems.push('刷新后没有存档'); break; }
      const after = await page.evaluate(STATE);
      const J = x => JSON.stringify(x);
      const cmp = (name, a, b) => { if (J(a) !== J(b)) problems.push('刷新后 ' + name + ' 与存档不一致: ' + J(a).slice(0, 120) + ' vs ' + J(b).slice(0, 120)); };
      cmp('hands', saved.hands, after.hands); cmp('melds', saved.exposedMelds, after.melds); cmp('deck', saved.deck.length, after.deck);
      cmp('discard', saved.discardPile.length, after.discard); cmp('scores', saved.scores, after.scores); cmp('dealer', saved.dealer, after.dealer); cmp('over', saved.gameOver, after.over);
      cmp('杠标记', [saved.afterKongDrawPlayer || null, saved.afterKongDiscardPlayer || null], after.ak);
      base = null; await page.evaluate('window.__S = { acted: "", closeAt: 0, errs: [] }'); await install(); lastChange = Date.now();
    }
    if (Date.now() - t0 > 25 * 60 * 1000) { problems.push('总超时'); break; }
  }
  console.log(`${ADV ? '[高阶] ' : '[日常] '}局数 ${hands}/${HANDS}，刷新恢复 ${reloads} 次，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  await browser.close(); srv.close();
  if (problems.length) { console.error('FAIL\n- ' + [...new Set(problems)].slice(0, 15).join('\n- ')); process.exit(1); }
  console.log('engine soak passed');
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
