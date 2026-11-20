const fs = require('fs');
const XlsxExport = require('/home/fanwu/工作台/数据建模/js/xlsx-export.js');
const http = require('http');
// 读当前用户数据，改一处 + 加一个新表，导出为待导入 Excel
http.get('http://127.0.0.1:8130/api/project', res => {
  let s = '';
  res.on('data', c => s += c);
  res.on('end', () => {
    const p = JSON.parse(s);
    const ods = p.models.find(m => m.name === 'ods_order_info');
    ods.cnName = '导入测试表名称';
    p.models.push({
      id: 'm_excel_new', layer: 'ads', name: 'zz_excel_model', cnName: 'Excel 新增模型',
      desc: '', source: '', notes: '',
      fields: [{ name: 'metric', type: 'bigint', comment: '指标', pk: false, expr: 'sum(t.metric)' }],
      partition: [], sources: [{ name: 'ods_order_info', alias: 't', on: '' }],
      where: '', groupBy: ''
    });
    fs.writeFileSync('/tmp/import-test.xlsx', Buffer.from(XlsxExport.buildWorkbook(p)));
    console.log('测试 Excel 已生成（含改名 + 新表）');
  });
});
