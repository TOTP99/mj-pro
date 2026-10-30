#!/usr/bin/env node
'use strict';
// 部署配置：net-config.js 的 peer/ice 能进入 Peer 构造参数；优先级 Game.netPeerConfig > net-config > 默认。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
let lastOpts = null;
class FakePeer {
  constructor(id, o) { if (typeof id !== 'string') o = id; lastOpts = o; this.h = {}; setTimeout(() => (this.h.open || []).forEach(f => f()), 0); }
  on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
  destroy() {} reconnect() {}
}
function load(cfg) {
  const Game = { turnOrder: [], PHASE: {}, setPhase() {}, logFlow() {}, requestRender() {} };
  const win = { addEventListener() {}, QJ_NET_CONFIG: cfg };
  const ctx = { Game, window: win, document: { querySelector: () => null, addEventListener() {}, visibilityState: 'visible' },
    navigator: {}, localStorage: { getItem: () => null }, Peer: FakePeer, setTimeout, clearTimeout, setInterval, clearInterval, console,
    Promise, Object, Array, Date, Number, String, JSON, Math, RegExp, Uint8Array, Uint32Array, crypto: require('crypto').webcrypto };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/23-net.js'), 'utf8'), ctx);
  return Game;
}
(async () => {
  let G = load(undefined);
  await G.netCreateRoom('ABC234', 'x');
  assert.strictEqual(lastOpts.config.iceServers.length, 3, '默认 3 个 STUN');
  assert(!lastOpts.host, '默认不覆盖信令');
  G.netLeave();

  G = load({ peer: { host: 'mj.example.com', port: 443, path: '/peerjs', secure: true }, ice: [{ urls: 'turn:t.example.com:3478', username: 'u', credential: 'c' }, { nope: 1 }] });
  await G.netCreateRoom('ABC234', 'x');
  assert.strictEqual(lastOpts.host, 'mj.example.com');
  assert.strictEqual(lastOpts.secure, true);
  assert.strictEqual(lastOpts.config.iceServers.length, 4, 'STUN×3 + TURN×1，无效项被忽略');
  assert(lastOpts.config.iceServers.some(s => /^turn:/.test(s.urls)));
  G.netLeave();

  G = load({ peer: { host: 'a.example.com' } });
  G.netPeerConfig = { host: 'override.example.com' };
  await G.netCreateRoom('ABC234', 'x');
  assert.strictEqual(lastOpts.host, 'override.example.com', 'Game.netPeerConfig 优先级最高');
  G.netLeave();
  console.log('net config tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
