/**
 * Excel 回环测试：导出 → 导入（replace / merge）→ 数据完整性比对
 * 运行：node test/excel-roundtrip.js（需本地服务已启动）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XlsxExport = require('../js/xlsx-export.js');

const BASE = 'http://127.0.0.1:8130/api/project';
const BASE_IMPORT = 'http://127.0.0.1:8130/api/import/excel';
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '\n    → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

const SAMPLE_SRC = fs.readFileSync(path.join(__dirname, '../js/sample.js'), 'utf-8');
const SAMPLE = new Function(SAMPLE_SRC + '\nreturn SAMPLE;')();

(async () => {
  // 事故防护：任何污染性写入前，先同步备份当前数据（测完恢复这份）
  const ORIGINAL = await (await fetch(BASE)).json();
  console.log('【Excel 回环（导出 → 导入）】当前 ' + ORIGINAL.models.length + ' 模型已备份');
  // 准备：整库替换为带全量信息的测试项目
  const test = JSON.parse(JSON.stringify(SAMPLE));
  test.name = '回环测试项目';
  test.dialect = 'clickhouse';
  test.customCols = {
    model: [{ key: 'x_owner', label: '责任人' }, { key: 'x_domain', label: '主题域' }],
    field: [{ key: 'x_sensitivity', label: '敏感等级' }]
  };
  const dwd = test.models.find(m => m.name === 'dwd_order_info_di');
  dwd.x_owner = '李四'; dwd.x_domain = '交易';
  dwd.fields[0].x_sensitivity = 'L2';
  dwd.notes = '清洗规则：过滤无效订单';
  dwd.sources[0].on = '补充条件 x = 1';
  await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(test) });

  // 1. 导出
  const bytes = XlsxExport.buildWorkbook(test);
  console.log('  导出 ' + bytes.length + ' B');

  // 2. 整库替换导入（先污染数据，验证 replace 恢复）
  const polluted = JSON.parse(JSON.stringify(test));
  polluted.models = polluted.models.slice(0, 3);
  polluted.models[0].name = 'zz_p污染表';
  await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(polluted) });

  const r1 = await (await fetch(BASE_IMPORT + '?mode=replace', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(bytes)
  })).json();
  ok(!r1.error, 'replace 导入成功', r1.error);
  const p1 = await (await fetch(BASE)).json();
  ok(p1.models.length === test.models.length, 'replace 恢复全部模型（' + p1.models.length + ' 个）');
  ok(p1.name === '回环测试项目' && p1.dialect === 'clickhouse', '项目名/方言还原', p1.name + '/' + p1.dialect);
  const g1 = p1.models.find(m => m.name === 'dwd_order_info_di');
  ok(g1.x_owner === '李四' && g1.x_domain === '交易', '表级自定义属性还原');
  ok(g1.fields[0].x_sensitivity === 'L2', '字段级自定义属性还原');
  ok(g1.notes === '清洗规则：过滤无效订单', '逻辑说明(notes)还原', g1.notes);
  ok(g1.sources[0].on === '补充条件 x = 1', 'JOIN 条件还原', g1.sources);
  const odsp = p1.models.find(m => m.name === 'ods_order_info');
  ok(!!odsp && (odsp.partition || []).length === 1 && odsp.partition[0].name === 'dt', '分区字段还原');

  // 3. 合并导入：Excel 含既有表（覆盖）+ 新表（追加）
  const mergeBook = JSON.parse(JSON.stringify(test));
  mergeBook.models = mergeBook.models.filter(m => ['ods_order_info', 'ads_trade_total_1d'].indexOf(m.name) >= 0);
  const newModel = JSON.parse(JSON.stringify(test.models[0]));
  newModel.name = 'zz_new_from_excel'; newModel.cnName = 'Excel 新增表';
  mergeBook.models.push(newModel);
  const bytes2 = XlsxExport.buildWorkbook(mergeBook);
  const r2 = await (await fetch(BASE_IMPORT + '?mode=merge', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(bytes2)
  })).json();
  ok(!r2.error, 'merge 导入成功', r2.error);
  ok(r2.updated.indexOf('ods_order_info') >= 0, '既有表被覆盖更新（' + r2.updated.join(',') + '）');
  ok(r2.added.indexOf('zz_new_from_excel') >= 0, '新表被追加（' + r2.added.join(',') + '）');
  const p2 = await (await fetch(BASE)).json();
  ok(p2.models.length === test.models.length + 1, '合并后模型总数 = 原 ' + test.models.length + ' + 新 1', p2.models.length);
  ok(p2.models.find(m => m.name === 'zz_new_from_excel'), '新表数据可读');

  // 4. 非法文件
  const r3 = await (await fetch(BASE_IMPORT + '?mode=replace', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not a zip')
  })).json();
  ok(!!r3.error, '非法文件被拒绝：' + r3.error);

  // 5. 恢复测试前的用户数据
  await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ORIGINAL) });
  const fin = await (await fetch(BASE)).json();
  console.log('  已恢复用户原数据（' + fin.models.length + ' 模型，sqlTemplates=' + JSON.stringify(fin.sqlTemplates || null) + '）');

  console.log('\n========================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试执行失败:', e.message); process.exit(1); });
