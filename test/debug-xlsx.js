const fs = require('fs');
const XlsxExport = require('/home/fanwu/工作台/数据建模/js/xlsx-export.js');
const SAMPLE = new Function(fs.readFileSync('/home/fanwu/工作台/数据建模/js/sample.js', 'utf-8') + '\nreturn SAMPLE;')();
const bytes = XlsxExport.buildWorkbook(SAMPLE);
fs.writeFileSync('/tmp/test-export.xlsx', Buffer.from(bytes));
console.log('written', bytes.length, 'magic:', bytes[0].toString(16), bytes[1].toString(16));
const buf = Buffer.from(bytes);
console.log('first16:', Array.from(buf.slice(0, 16)).join(','));
