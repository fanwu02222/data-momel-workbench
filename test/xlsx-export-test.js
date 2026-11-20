/**
 * Excel 导出测试：生成 xlsx → 交由 Python zipfile + ElementTree 深度校验
 * 运行：node test/xlsx-export-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XlsxExport = require('../js/xlsx-export.js');

const SAMPLE_SRC = fs.readFileSync(path.join(__dirname, '../js/sample.js'), 'utf-8');
const SAMPLE = new Function(SAMPLE_SRC + '\nreturn SAMPLE;')();

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '\n    → ' + extra : '')); }
}

console.log('【Excel 导出】');
// 1. 基本生成
const bytes = XlsxExport.buildWorkbook(SAMPLE);
ok(bytes instanceof Uint8Array && bytes.length > 2000, '生成 xlsx 字节流（' + bytes.length + ' B）');
// 2. ZIP 魔数
ok(bytes[0] === 0x50 && bytes[1] === 0x4B, 'ZIP 魔数 PK');
// 3. CRC32 已知向量："123456789" → 0xCBF43926
const crc = XlsxExport.crc32(new TextEncoder().encode('123456789'));
ok(crc === 0xCBF43926, 'CRC32 已知向量校验 (0x' + crc.toString(16) + ')');
// 4. 文件名
ok(/数据字典_\d{8}\.xlsx$/.test(XlsxExport.fileName(SAMPLE)), '下载文件名格式', XlsxExport.fileName(SAMPLE));

// 写临时文件交 Python 校验
const tmp = path.join(__dirname, 'tmp-export.xlsx');
fs.writeFileSync(tmp, Buffer.from(bytes));

const { execFileSync } = require('child_process');
let py = '';
try {
  py = execFileSync('python3', [path.join(__dirname, 'verify_xlsx.py'), tmp], { encoding: 'utf-8', timeout: 30000 });
} catch (e) {
  py = e.stdout || '';
  fail++;
  console.log('  ✗ Python 校验执行失败\n    → ' + (e.stderr || e.message).slice(0, 300));
}
py.trim().split('\n').filter(Boolean).forEach(function (line) {
  if (line.startsWith('OK ')) { pass++; console.log('  ✓ ' + line.slice(3)); }
  else if (line.startsWith('FAIL ')) { fail++; console.log('  ✗ ' + line.slice(5)); }
});

try { fs.unlinkSync(tmp); } catch (e) { }

console.log('\n========================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
