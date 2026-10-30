#!/usr/bin/env node
'use strict';
// 二维码编码器：能为邀请链接生成合法矩阵（定位图案、尺寸合法、确定性）；超长输入安全返回 null 而不抛异常。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/lib/qrcode.js'), 'utf8'), { window: win });
const make = win.QJQR.make;
const url = 'https://mj.example.com/index.html?room=K7M2QX';
const q = make(url);
assert(q && q.size >= 21 && (q.size - 17) % 4 === 0, '版本尺寸应为 21+4k，实际 ' + (q && q.size));
// 三个定位图案：左上/右上/左下 7x7 外框全黑
for (const [r0, c0] of [[0, 0], [0, q.size - 7], [q.size - 7, 0]]) {
  for (let i = 0; i < 7; i++) for (const [r, c] of [[r0, c0 + i], [r0 + 6, c0 + i], [r0 + i, c0], [r0 + i, c0 + 6]])
    assert(q.isDark(r, c), '定位图案外框应为黑');
  assert(!q.isDark(r0 + 1, c0 + 1) && !q.isDark(r0 + 1, c0 + 5), '定位图案内圈应为白');
}
const q2 = make(url);
let same = q.size === q2.size;
for (let r = 0; same && r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.isDark(r, c) !== q2.isDark(r, c)) same = false;
assert(same, '同输入应得同矩阵');
assert.strictEqual(make('x'.repeat(5000)), null, '超长输入应返回 null');
console.log('qr tests passed（尺寸 ' + q.size + '×' + q.size + '）');
