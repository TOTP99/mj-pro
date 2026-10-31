'use strict';
// 统一解析 Playwright：优先 PLAYWRIGHT_PATH → 项目/全局 require('playwright') → 常见全局目录。
// 全部失败时给出明确安装提示，而不是抛出晦涩的 MODULE_NOT_FOUND。
const path = require('path');
const cp = require('child_process');

function tryRequire(spec) {
  try { return require(spec); } catch (e) { return null; }
}
function globalRoots() {
  const roots = [];
  try { roots.push(cp.execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch (e) {}
  roots.push('/opt/npm-tools/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules');
  return roots.filter(Boolean);
}
function loadPlaywright() {
  const tried = [];
  const env = process.env.PLAYWRIGHT_PATH;
  if (env) {
    tried.push(env);
    const m = tryRequire(env) || tryRequire(path.resolve(env));
    if (m) return m;
  }
  tried.push('playwright');
  let m = tryRequire('playwright');
  if (m) return m;
  for (const root of globalRoots()) {
    const p = path.join(root, 'playwright');
    tried.push(p);
    m = tryRequire(p);
    if (m) return m;
  }
  throw new Error('找不到 Playwright。已尝试：' + tried.join(' | ') +
    '\n请在项目根目录执行 npm install，或设置 PLAYWRIGHT_PATH=<playwright 模块路径>。');
}
module.exports = loadPlaywright();
module.exports.loadPlaywright = loadPlaywright;
