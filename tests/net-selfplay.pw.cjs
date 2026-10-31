#!/usr/bin/env node
'use strict';
// 联机整局自对弈：真 Chromium 里开 1 房主 + 3 客人页，用内存版假 PeerJS（BroadcastChannel）互联，
// 驱动器通过真实 UI 钩子（acceptClaim/declineClaim/handleDiscard/closeResultModal）随机打牌。
// 断言：牌数守恒、无页面异常、无意外 alert、无卡死、无 AI 代打超时、单机存档未被污染；
// 中途让一位客人离开，再换一位新客人加入。
// 用法：node tests/net-selfplay.pw.cjs [局数=12]
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require('./pw-path.cjs');
const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const HANDS = parseInt(ARGS.find(a => /^\d+$/.test(a)) || '12', 10);
const CHAOS = ARGS.includes('--chaos');                              // 故障注入：静默断网重连、挂机托管
const LAT = parseInt((ARGS.find(a => a.startsWith('--lat=')) || '--lat=0').slice(6), 10); // 随机单向延迟上限(ms)
const PORT = 8765;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.md': 'text/plain' };

const FAKE_PEER = (LAT) => `(${function (LAT) {
  const bc = new BroadcastChannel('fp'); const peers = {}, conns = {};
  const cfg = window.__FP = { dead: false };
  const post = m => { if (!cfg.dead) bc.postMessage(m); };
  const lastAt = {};
  class Em { constructor() { this._h = {}; } on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
    _emit(e, a) { (this._h[e] || []).slice().forEach(f => { try { f(a); } catch (x) { console.error('fp handler', x && x.stack || x); } }); } }
  class Conn extends Em { constructor(cid, remote, peer) { super(); this.cid = cid; this.peer = remote; this.open = false; this._p = peer; conns[cid] = this; }
    send(d) { if (!this.open) throw new Error('closed'); post({ k: 'data', cid: this.cid, d }); }
    close() { if (!this.open) return; this.open = false; post({ k: 'close', cid: this.cid }); this._emit('close'); } }
  bc.onmessage = e => { if (cfg.dead) return; const m = e.data, key = m.cid || 'x';
    const at = Math.max((lastAt[key] || 0) + 1, Date.now() + (LAT ? Math.random() * LAT : 0)); lastAt[key] = at;
    setTimeout(() => handle(m), at - Date.now()); };
  function handle(m) {
    if (m.k === 'conn') { const p = peers[m.to]; if (!p || p.destroyed) return; const c = new Conn(m.cid, m.from, p); c.open = true;
      post({ k: 'ack', cid: m.cid }); p._emit('connection', c); }
    else if (m.k === 'ack') { const c = conns[m.cid]; if (c) { c.acked = true; c.open = true; c._emit('open'); } }
    else if (m.k === 'data') { const c = conns[m.cid]; if (c && c.open) c._emit('data', m.d); }
    else if (m.k === 'close') { const c = conns[m.cid]; if (c && c.open) { c.open = false; c._emit('close'); } } }
  window.Peer = class Peer extends Em { constructor(a) { super(); this.id = typeof a === 'string' ? a : 'g' + Math.random().toString(36).slice(2, 9);
      peers[this.id] = this; this.destroyed = false; setTimeout(() => this._emit('open', this.id), 10); }
    connect(to) { const cid = 'c' + Math.random().toString(36).slice(2); const c = new Conn(cid, to, this);
      post({ k: 'conn', to, cid, from: this.id });
      setTimeout(() => { if (!c.acked) this._emit('error', { type: 'peer-unavailable' }); }, 1500); return c; }
    reconnect() {} destroy() { this.destroyed = true; Object.values(conns).forEach(c => { if (c._p === this) c.close(); }); delete peers[this.id]; } };
}})(${LAT});`;

const DRIVER = `(${function (role) {
  const S = { hands: 0, acted: '', timeouts: 0, closeAt: 0, maxHands: 0, errs: [] };
  window.__S = S;
  const origLog = Game.logFlow;
  Game.logFlow = function (t) { if (/超时，AI 代打/.test(t)) S.timeouts++; return origLog.apply(this, arguments); };
  Game.aiThinkMs = () => 30;
  Game.netTimeouts.turn = 12000; Game.netTimeouts.claim = 6000; Game.netTimeouts.reveal = 6000;
  const rnd = () => Math.random();
  const shown = id => { const e = document.getElementById(id); return e && e.classList.contains('show'); };
  const fakeEv = idx => ({ target: { closest: () => ({ dataset: { index: String(idx) }, getBoundingClientRect: () => null }) } });
  function discardRandom() { const n = Game.hands.bottom.length; const idx = Math.floor(rnd() * n);
    Game.handleDiscard(fakeEv(idx)); Game.handleDiscard(fakeEv(idx)); }
  function doClaim(accept) {
    if (!accept) { Game.declineClaim(); return; }
    Game.acceptClaim();
    if (shown('chi-choice-modal')) Game.chooseChiCombo(0);
  }
  setInterval(function () {
    try {
      const now = Date.now();
      if (S.afk) return;
      if (shown('result-modal') || Game.gameOver) {
        if (!S.closeAt) S.closeAt = now + 300 + rnd() * 500;
        if (now >= S.closeAt) { S.closeAt = 0; if (role === 'host') { S.hands++; if (S.hands >= S.maxHands) { S.done = true; return; } } try { Game.closeResultModal(); } catch (e) { S.errs.push(String(e)); } }
        return;
      }
      S.closeAt = 0;
      if (role === 'host') {
        if (shown('amount-modal')) { Game.chooseAmount(50); return; }
        if (shown('reveal-modal')) { Game.confirmReveal(rnd() < 0.6); return; }
        const pc = Game.pendingClaim;
        if (pc && pc.mode === 'claim' && pc.netLocal) { if (S.acted !== 'c' + Game.discardPile.length) { S.acted = 'c' + Game.discardPile.length; doClaim(rnd() < 0.6); } return; }
        if (pc && pc.mode === 'selfGang') { if (rnd() < 0.5) Game.acceptClaim(); else discardRandom(); return; }
        if (!pc && Game.turnOrder[Game.currentIndex] === 'bottom' && Game.hands.bottom.length % 3 === 2) discardRandom();
      } else {
        if (S.afk) return; // 挂机：不回应任何 prompt
        const p = Game.netPrompt; if (!p) return;
        if (p.kind === 'claim') { if (S.acted !== p.id) { S.acted = p.id; doClaim(rnd() < 0.6); } }
        else if (p.kind === 'reveal') { if (S.acted !== p.id) { S.acted = p.id; doClaim(rnd() < 0.6); } }
        else if (p.kind === 'turn') {
          if (p.gangs && p.gangs.length && rnd() < 0.5 && S.acted !== p.id) { S.acted = p.id; Game.acceptClaim(); }
          else if (Game.hands.bottom.length % 3 === 2) discardRandom();
        }
      }
    } catch (e) { S.errs.push(String(e && e.stack || e)); }
  }, 80);
}})`;

(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    fs.readFile(f, (e, b) => { if (e) { if (/favicon/.test(req.url)) { res.writeHead(204); res.end(); return; } console.error('404', req.url); res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
  }).listen(PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript(FAKE_PEER(LAT));
  await ctx.route('**/peerjs.min.js', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
  const problems = []; let unexpectedAlerts = 0, expectLeaveAlerts = false;
  async function open(name) {
    const p = await ctx.newPage(); p._name = name;
    p.on('pageerror', e => problems.push(name + ' pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') {
      problems.push(name + ' console.error: ' + m.text().slice(0, 200) + ' ' + (m.location().url || ''));
      if (/NaN/.test(m.location().url || '')) p.evaluate(() => JSON.stringify({ go: Game.gameOver, ph: Game.phase, pc: Game.pendingClaim && Game.pendingClaim.mode, hb: Game.hands.bottom.slice(0, 3), ht: Game.hands.top.slice(0, 2), log: (Game.flowLog || []).length, stack: new Error().stack })).then(x => console.error('DBG', name, x)).catch(() => {});
    } });
    p.on('dialog', d => { unexpectedAlerts++; problems.push(name + ' alert: ' + d.message()); d.dismiss().catch(() => {}); });
    await p.goto('http://localhost:' + PORT + '/index.html'); await p.waitForFunction(() => window.Game && Game._booted !== undefined || window.Game, null, { timeout: 15000 });
    await p.waitForTimeout(500); return p;
  }
  const TIMING = () => { Game.netTimeouts.ping = 1500; Game.netTimeouts.dead = 6000; Game.netTimeouts.hostSilent = 5000; Game.netTimeouts.reserve = 40000; Game.netTimeouts.ready = 4000; };
  const host = await open('host');
  await host.evaluate(TIMING);
  await host.evaluate(async () => { const r = await Game.netCreateRoom(Game.netGenCode(), '房主'); window.__ROOM = r.ok ? Game.net.code : null; if (!r.ok || r.role !== 'host') throw new Error('建房失败 ' + JSON.stringify(r)); });
  async function joinGuest(name) {
    const g = await open(name);
    await g.evaluate(TIMING);
    const ROOM = await host.evaluate(() => window.__ROOM);
    const r = await g.evaluate(async ([c, n]) => { const r = await Game.netJoinRoom(c, n); if (!r.ok) return { err: r.err }; Game.netGuestInit(r.welcome); return { seat: r.welcome.seat }; }, [ROOM, name]);
    if (r.err) throw new Error(name + ' 加入失败 ' + r.err); return g;
  }
  const guests = [await joinGuest('g1'), await joinGuest('g2'), await joinGuest('g3')];
  await host.evaluate(() => { Game.netHostInit(); Game.chooseMode('daily'); });
  for (const p of [host, ...guests]) await p.evaluate(DRIVER + '(' + JSON.stringify(p === host ? 'host' : 'guest') + ')');
  await host.evaluate(h => { __S.maxHands = h; }, HANDS);
  const poll = p => p.evaluate(() => ({ s: window.__S, n: Game.totalTilesOf({ deck: Game.deck, discardPile: Game.discardPile, hands: Game.hands, exposedMelds: Game.exposedMelds }),
    sig: [Game.deck.length, Game.discardPile.length, Game.currentIndex, Game.gameOver, Object.values(Game.hands).map(h => h.length).join(',')].join('|'), full: Game.FULL_DECK_SIZE }));
  const chaos = {};
  let lastSig = '', lastChange = Date.now(), left = false, rejoined = false, extraGuest = null, nGuests = guests.slice();
  const t0 = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, 700));
    const h = await poll(host);
    if (h.n !== h.full) problems.push('牌数不守恒 ' + h.n + '/' + h.full + ' @hand ' + h.s.hands);
    if (h.s.errs.length) problems.push('host driver: ' + h.s.errs.splice(0).join(' | '));
    const sig = h.sig + '|' + h.s.hands; if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
    if (Date.now() - lastChange > 25000) { problems.push('卡死：25 秒无状态变化 @hand ' + h.s.hands + ' sig=' + h.sig); break; }
    if (problems.length) break;
    if (!left && h.s.hands >= Math.floor(HANDS / 3)) { // 一位客人主动离开
      left = true; expectLeaveAlerts = true;
      await nGuests[0].evaluate(() => { Game.netLeave(); }); await nGuests[0].waitForTimeout(300);
      await nGuests[0].close(); nGuests = nGuests.slice(1);
    }
    if (CHAOS) {
      const hh = h.s.hands;
      if (!chaos.cut && hh >= 3) { chaos.cut = true; await guests[1].evaluate(() => { window.__FP.dead = true; }); chaos.cutAt = Date.now(); }
      if (chaos.cut && !chaos.healed && Date.now() - chaos.cutAt > 14000) { chaos.healed = true; await guests[1].evaluate(() => { window.__FP.dead = false; }); }
      if (!chaos.afk && hh >= 6) { chaos.afk = true; chaos.afkAt = Date.now(); await guests[2].evaluate(() => { __S.afk = true; }); }
      if (chaos.afk && !chaos.back && Date.now() - chaos.afkAt > 30000) {
        chaos.back = true;
        await guests[2].evaluate(() => { __S.afk = false; const b = document.getElementById('net-auto-banner'); if (b && b.classList.contains('show')) b.click(); });
      }
    }
    if (left && !rejoined && h.s.hands >= Math.floor(HANDS / 3) + 2) { // 新客人中途加入
      rejoined = true; extraGuest = await joinGuest('g4'); nGuests.push(extraGuest);
      await extraGuest.evaluate(DRIVER + "('guest')");
    }
    for (const g of nGuests) { const r = await poll(g); if (r.s && r.s.errs.length) problems.push(g._name + ' driver: ' + r.s.errs.splice(0).join(' | ')); }
    if (h.s.done) break;
    if (Date.now() - t0 > 20 * 60 * 1000) { problems.push('总超时'); break; }
  }
  const fin = await poll(host);
  const timeouts = fin.s.timeouts; const save = await host.evaluate(() => localStorage.getItem('qionghu_mahjong_new_progress_v2'));
  const gTimeouts = []; for (const g of nGuests) gTimeouts.push((await poll(g)).s.timeouts);
  console.log(`${CHAOS ? '[chaos] ' : ''}${LAT ? '[lat≤' + LAT + 'ms] ' : ''}局数 ${fin.s.hands}/${HANDS}，用时 ${Math.round((Date.now() - t0) / 1000)}s，房主侧"超时AI代打" ${timeouts} 次`);
  if (save) problems.push('联机污染了单机存档 qionghu_mahjong_new_progress_v2');
  if (unexpectedAlerts) problems.push('出现 ' + unexpectedAlerts + ' 次 alert');
  if (CHAOS) {
    const diag = await host.evaluate(() => Game.netDiag());
    const g2 = await guests[1].evaluate(() => ({ diag: Game.netDiag(), seat: Game.net && Game.net.seat }));
    const seats = await host.evaluate(() => Game.net.seats.map(s => ({ seat: s.seat, kind: s.kind, away: !!s.away, auto: !!s.auto })));
    if (!/host:resume/.test(diag)) problems.push('断网重连：房主没记录到 resume');
    if (!/guest:resumed/.test(g2.diag)) problems.push('断网重连：客人没记录到 resumed');
    if (!/host:timeout/.test(diag)) problems.push('挂机：房主没记录到超时');
    if (!/已托管/.test(await host.evaluate(() => Game.flowLog && '' ) + diag)) { /* 托管提示在 toast，不强制 */ }
    if (seats.some(x => x.away || x.auto)) problems.push('结束时仍有离线/托管座位 ' + JSON.stringify(seats));
    console.log('chaos: 断网重连 OK，挂机托管/恢复 OK，座位', JSON.stringify(seats.map(x => x.seat + ':' + x.kind)));
  }
  if (!CHAOS && !problems.length && timeouts > 0) problems.push('有 ' + timeouts + ' 次 AI 代打超时（客人本应都能回应）');
  await browser.close(); srv.close();
  if (problems.length) { console.error('FAIL\n- ' + [...new Set(problems)].slice(0, 15).join('\n- ')); process.exit(1); }
  console.log('net selfplay passed');
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
