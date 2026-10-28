#!/usr/bin/env node
'use strict';
// 单机整局自对弈（真 Chromium）：随机操作玩家，检查牌数守恒/手牌张数/庄家轮转/筹码零和/无页面错误/无卡死，
// 并在随机时刻刷新页面，验证存档恢复后的牌局与刷新前完全一致且能继续打完。
// 用法：node tests/solo-selfplay.pw.cjs [局数=20] [刷新次数=4]
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const ROOT = path.join(__dirname, '..');
const HANDS = parseInt(process.argv[2] || '20', 10), RELOADS = parseInt(process.argv[3] || '4', 10);
const PORT = 8766;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp' };

const DRIVER = `(${function (maxHands) {
  const S = window.__S = { hands: 0, closeAt: 0, H: [], errs: [], lastGO: false, pre: null };
  Game.aiThinkMs = () => 30;
  const rnd = Math.random, shown = id => { const e = document.getElementById(id); return e && e.classList.contains('show'); };
  const fakeEv = idx => ({ target: { closest: () => ({ dataset: { index: String(idx) }, getBoundingClientRect: () => null }) } });
  window.addEventListener('pagehide', () => { try { sessionStorage.__pre = JSON.stringify(window.__snap()); } catch (e) {} });
  window.__snap = () => JSON.parse(JSON.stringify({ deck: Game.deck, hands: Game.hands, melds: Game.exposedMelds, discard: Game.discardPile, scores: Game.scores,
    dealer: Game.dealer, cur: Game.currentIndex, over: Game.gameOver, winner: Game.winner }));
  setInterval(function () {
    try {
      const now = Date.now();
      if (Game.gameOver && !S.lastGO) { S.lastGO = true; S.H.push({ dealer: Game.dealer, winner: Game.winner, scores: Object.assign({}, Game.scores), field: Object.assign({}, Game.fieldAmounts), bust: !!Game.bustAutoRestart }); }
      if (!Game.gameOver && S.lastGO) { S.lastGO = false; S.H[S.H.length - 1].nextDealer = Game.dealer; }
      if (shown('amount-modal')) { Game.chooseAmount(50); return; }
      if (shown('round-modal')) { Game.confirmRoundReselect && Game.confirmRoundReselect(); }
      if (shown('result-modal') || Game.gameOver) {
        if (!S.closeAt) S.closeAt = now + 200 + rnd() * 300;
        if (now >= S.closeAt) {
          S.closeAt = 0; S.hands++;
          if (S.hands >= maxHands) { S.done = true; return; }
          if (Game.pendingClaim && Game.pendingClaim.mode === 'nextGame') Game.acceptClaim(); else Game.closeResultModal();
        }
        return;
      }
      if (shown('reveal-modal')) { Game.confirmReveal(rnd() < 0.6); return; }
      const pc = Game.pendingClaim;
      if (pc && pc.mode === 'claim') {
        if (rnd() < 0.6) { Game.acceptClaim(); if (shown('chi-choice-modal')) Game.chooseChiCombo(0); } else Game.declineClaim();
        return;
      }
      if (pc && pc.mode === 'selfGang') { if (rnd() < 0.5) Game.acceptClaim(); else { const i = Math.floor(rnd() * Game.hands.bottom.length); Game.handleDiscard(fakeEv(i)); Game.handleDiscard(fakeEv(i)); } return; }
      if (!pc && Game.turnOrder[Game.currentIndex] === 'bottom' && Game.hands.bottom.length % 3 === 2) {
        const i = Math.floor(rnd() * Game.hands.bottom.length); Game.handleDiscard(fakeEv(i)); Game.handleDiscard(fakeEv(i));
      }
    } catch (e) { S.errs.push(String(e && e.stack || e)); }
  }, 80);
}})`;

(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    fs.readFile(f, (e, b) => { if (e) { res.writeHead(/favicon/.test(req.url) ? 204 : 404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
  }).listen(PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text().slice(0, 200) + ' ' + (m.location().url || '')); });
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  async function boot() { await page.goto('http://localhost:' + PORT + '/index.html'); await page.waitForFunction(() => window.Game, null, { timeout: 15000 }); await page.waitForTimeout(600); }
  await boot();
  let doneHands = 0;
  await page.evaluate(() => { Game.chooseMode('daily'); });
  const inject = async (remaining) => { await page.evaluate(DRIVER + '(' + remaining + ')'); };
  await inject(HANDS);
  const poll = () => page.evaluate(() => ({ s: window.__S, n: Game.totalTilesOf({ deck: Game.deck, discardPile: Game.discardPile, hands: Game.hands, exposedMelds: Game.exposedMelds }),
    ok: Game.validateHandCounts('test'), full: Game.FULL_DECK_SIZE, fa: Game.fieldAmounts, fi: Game.fieldInitialAmount, sig: [Game.deck.length, Game.discardPile.length, Game.currentIndex, Game.gameOver].join('|') }));
  let lastSig = '', lastChange = Date.now(), reloads = 0, allH = [];
  const t0 = Date.now(); let carried = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 600));
    const h = await poll();
    if (h.n !== h.full) problems.push('牌数不守恒 ' + h.n);
    if (!h.ok) problems.push('手牌张数异常');
    if (h.fa && typeof h.fi === 'number') { const sum = Object.values(h.fa).reduce((a, b) => a + b, 0); if (sum !== 4 * h.fi) problems.push('筹码不零和 ' + sum + ' vs ' + 4 * h.fi); }
    if (h.s.errs.length) problems.push('driver: ' + h.s.errs.join(' | '));
    const sig = h.sig + '|' + h.s.hands; if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    if (Date.now() - lastChange > 20000) { problems.push('卡死：20 秒无变化 ' + h.sig); break; }
    if (problems.length) break;
    if (h.s.done) { allH = allH.concat(h.s.H); break; }
    // 随机刷新：一局进行中、已有一定巡数时
    const doReload = reloads < RELOADS && h.s.hands >= 2 + reloads * Math.floor(HANDS / (RELOADS + 1)) && !h.sig.endsWith('true') && Math.random() < 0.3;
    if (doReload) {
      reloads++; allH = allH.concat(h.s.H); carried += h.s.hands;
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.Game && Game.hands && Game.hands.bottom && Game.hands.bottom.length > 0, null, { timeout: 15000, polling: 10 }); // 恢复后立刻比对，赶在 AI 继续出牌之前
      const cmp = await page.evaluate(() => { const pre = JSON.parse(sessionStorage.__pre || 'null'); const now = JSON.parse(JSON.stringify({ deck: Game.deck, hands: Game.hands, melds: Game.exposedMelds, discard: Game.discardPile, scores: Game.scores, dealer: Game.dealer, cur: Game.currentIndex, over: Game.gameOver, winner: Game.winner }));
        if (!pre) return { err: '刷新前没留下快照' };
        const diff = Object.keys(pre).filter(k => JSON.stringify(pre[k]) !== JSON.stringify(now[k])); return { diff, over: pre.over }; });
      if (cmp.err || cmp.diff.length) { problems.push('刷新后牌局与刷新前不一致：' + (cmp.err || cmp.diff.join(','))); break; }
      await inject(HANDS - carried);
    }
    if (Date.now() - t0 > 25 * 60 * 1000) { problems.push('总超时'); break; }
  }
  // 庄家轮转规则
  const next = d => ['bottom', 'right', 'top', 'left'][(['bottom', 'right', 'top', 'left'].indexOf(d) + 1) % 4];
  let checked = 0;
  for (const r of allH) {
    if (!r.nextDealer || r.bust) continue;
    const want = (r.winner === null || r.winner === r.dealer) ? r.dealer : next(r.dealer);
    if (r.nextDealer !== want) problems.push(`庄家轮转错误：庄 ${r.dealer} 赢家 ${r.winner} 下局庄 ${r.nextDealer}，应为 ${want}`);
    checked++;
  }
  console.log(`单机自对弈：共 ${allH.length + (problems.length ? 0 : 0)} 局记录，庄家轮转检查 ${checked} 次，刷新恢复 ${reloads} 次，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  await browser.close(); srv.close();
  if (problems.length) { console.error('FAIL\n- ' + [...new Set(problems)].slice(0, 12).join('\n- ')); process.exit(1); }
  console.log('solo selfplay passed');
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
