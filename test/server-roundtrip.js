'use strict';
// PUT 回环测试：追加测试模型 → 校验 → 恢复原数据
const BASE = 'http://127.0.0.1:8130/api/project';
(async () => {
  const orig = await (await fetch(BASE)).json();
  console.log('原模型数:', orig.models.length);

  const test = JSON.parse(JSON.stringify(orig));
  test.models.push({
    id: 'm_put_test', layer: 'ads', name: 'zz_put_roundtrip_test', cnName: '回环测试表',
    fields: [{ name: 'amt', type: 'decimal(18,2)', comment: '金额', pk: false, expr: 'sum(x.amt)' }],
    partition: [{ name: 'dt', type: 'string', comment: '日', expr: 'x.dt' }],
    sources: [{ name: 'ods_order_info', alias: 'x', on: '' }], where: "x.dt = '2024-01-01'", groupBy: 'x.dt'
  });
  let r = await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(test) });
  console.log('PUT(写入测试模型):', r.status, JSON.stringify(await r.json()));

  const after = await (await fetch(BASE)).json();
  const m = after.models.find(x => x.name === 'zz_put_roundtrip_test');
  console.log('GET 验证: 模型数 =', after.models.length, '| 测试表字段 =', m ? m.fields[0].name + '/' + m.fields[0].type : '丢失',
    '| expr =', m ? m.fields[0].expr : '', '| where =', m ? m.where : '');

  r = await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orig) });
  console.log('PUT(还原):', r.status);
  const restored = await (await fetch(BASE)).json();
  console.log('还原后模型数:', restored.models.length, '| 快照模型数一致:', JSON.stringify(restored) === JSON.stringify(orig));

  // ===== 自定义扩展列持久化测试 =====
  const withCols = JSON.parse(JSON.stringify(orig));
  withCols.customCols = {
    model: [{ key: 'x_owner', label: '责任人' }, { key: 'x_domain', label: '主题域' }],
    field: [{ key: 'x_sensitivity', label: '敏感等级' }]
  };
  withCols.models[0].x_owner = '李四';
  withCols.models[0].x_domain = '交易';
  withCols.models[0].fields[0].x_sensitivity = 'L3';
  await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withCols) });
  const got = await (await fetch(BASE)).json();
  const m0 = got.models[0];
  const f0 = m0.fields[0];
  const okCols = got.customCols && got.customCols.model.length === 2 && got.customCols.field.length === 1;
  const okAttrs = m0.x_owner === '李四' && m0.x_domain === '交易' && f0.x_sensitivity === 'L3';
  console.log('自定义列持久化: 配置还原 =', okCols, '| 表级属性 =', m0.x_owner + '/' + m0.x_domain, '| 字段级属性 =', f0.x_sensitivity, '| 保留原有键(name/type等) =', f0.name + '/' + f0.type + '/' + f0.expr);
  if (!okCols || !okAttrs) { console.log('✗ 自定义列测试失败'); process.exit(1); }
  // 还原
  await fetch(BASE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orig) });
  const fin = await (await fetch(BASE)).json();
  console.log('最终还原: 模型数 =', fin.models.length, '| customCols =', JSON.stringify(fin.customCols || null));

  const snap = JSON.parse(require('fs').readFileSync('project.json', 'utf-8'));
  console.log('project.json 快照已同步:', snap.models.length, '个模型');
})();
