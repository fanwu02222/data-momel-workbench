/**
 * Node 环境测试：SQL 解析（反解析）、SQL 生成、血缘解析
 * 运行：node test/test.js
 */
'use strict';
const SQLLex = require('../js/sql-lexer.js');
const SQLParse = require('../js/sql-parser.js');
const SQLGen = require('../js/sql-generator.js');
const Lineage = require('../js/lineage.js');
const SAMPLE_SRC = require('fs').readFileSync(require('path').join(__dirname, '../js/sample.js'), 'utf-8');

// 载入 sample（浏览器脚本，通过 Function 求值取 SAMPLE 对象）
const SAMPLE = (function () {
  const fn = new Function(SAMPLE_SRC + '\nreturn SAMPLE;');
  return fn();
})();

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '\n    → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
function section(name) { console.log('\n【' + name + '】'); }

// ================= 词法 =================
section('词法分析');
(function () {
  const toks = SQLLex.lexSQL("SELECT a.name, 'it''s' AS s, b.`col-x` FROM t1 -- comment\nWHERE x >= 10 AND y <> 'z'");
  const vals = toks.filter(t => t.type !== 'eof').map(t => t.value);
  ok(vals[0] === 'SELECT' && vals[1] === 'a', '基础 token 序列', vals);
  const strTok = toks.find(t => t.type === 'string');
  ok(strTok && strTok.value === "it's", "字符串转义（'' → '）", strTok);
  const backtick = toks.find(t => t.value === 'col-x');
  ok(!!backtick, '反引号标识符');
  const ge = toks.find(t => t.type === 'op' && t.value === '>=');
  const ne = toks.find(t => t.type === 'op' && t.value === '<>');
  ok(!!ge && !!ne, '双字符操作符 >= <>');
  const num = toks.find(t => t.type === 'number' && t.value === '10');
  ok(!!num, '数字字面量');
})();

// ================= CREATE TABLE 解析 =================
section('CREATE TABLE 反解析（含注释/分区）');
(function () {
  const sql = `CREATE TABLE IF NOT EXISTS dwd_order_info_di (
  \`order_id\` BIGINT COMMENT '订单ID',
  \`user_id\` BIGINT COMMENT '用户ID',
  \`pay_amount\` DECIMAL(16,2) COMMENT '实付金额'
)
COMMENT '订单明细事实表'
PARTITIONED BY (\`dt\` STRING COMMENT '统计日期')
STORED AS ORC;`;
  const rs = SQLParse.parseSQL(sql);
  ok(rs.length === 1, '解析出 1 个模型', rs.length);
  const m = rs[0].model;
  ok(m.name === 'dwd_order_info_di', '表名', m.name);
  ok(m.layer === 'dwd', '自动识别层 dwd', m.layer);
  ok(m.cnName === '订单明细事实表', '表中文名', m.cnName);
  ok(m.fields.length === 3 && m.fields[0].name === 'order_id' && m.fields[0].type.toUpperCase() === 'BIGINT', '字段与类型', m.fields);
  ok(m.fields[2].type === 'DECIMAL(16,2)', '复合类型 decimal(16,2)', m.fields[2].type);
  ok(m.fields[0].comment === '订单ID', '字段注释', m.fields[0].comment);
  ok(m.partition.length === 1 && m.partition[0].name === 'dt', '分区字段', m.partition);
})();

// ================= INSERT OVERWRITE SELECT 解析 =================
section('INSERT OVERWRITE ... SELECT 反解析（业务逻辑/血缘）');
(function () {
  const sql = `INSERT OVERWRITE TABLE dws_trade_shop_order_1d PARTITION (dt)
SELECT
  oi.shop_id AS shop_id,
  count(distinct oi.order_id) AS order_count,
  sum(de.sale_amount) AS sale_amount,
  oi.dt AS dt
FROM dwd_order_info_di oi
LEFT JOIN dwd_order_detail_di de
  ON oi.order_id = de.order_id AND oi.dt = de.dt
WHERE oi.order_status in ('01','02','03')
GROUP BY oi.shop_id, oi.dt;`;
  const rs = SQLParse.parseSQL(sql);
  ok(rs.length === 1, '解析出 1 个模型');
  const m = rs[0].model;
  ok(m.name === 'dws_trade_shop_order_1d' && m.layer === 'dws', '表名与层');
  const byName = {}; m.fields.forEach(f => byName[f.name] = f);
  ok(byName.order_count.expr === 'count(distinct oi.order_id)', '聚合表达式保留', byName.order_count);
  ok(byName.shop_id.expr === 'oi.shop_id', '别名表达式', byName.shop_id);
  ok(m.partition.length === 1 && m.partition[0].name === 'dt' && m.partition[0].expr === 'oi.dt', '动态分区 + 表达式', m.partition);
  ok(m.sources.length === 2 && m.sources[0].alias === 'oi' && m.sources[1].name === 'dwd_order_detail_di', '源表映射', m.sources);
  ok(/oi\.order_id = de\.order_id/.test(m.sources[1].on), 'JOIN ON 条件', m.sources[1].on);
  ok(/order_status in/.test(m.where), 'WHERE 条件', m.where);
  ok(/oi\.shop_id, oi\.dt/.test(m.groupBy), 'GROUP BY', m.groupBy);
})();

// ================= CTAS + MySQL 方言 =================
section('CTAS（CREATE TABLE AS SELECT）解析');
(function () {
  const sql = `CREATE TABLE ads_trade_total_1d AS
SELECT
  t.dt AS dt,
  sum(t.order_count) AS order_count,
  count(distinct t.shop_id) AS shop_count
FROM dws_trade_shop_order_1d t
GROUP BY t.dt;`;
  const rs = SQLParse.parseSQL(sql);
  const m = rs[0].model;
  ok(m.name === 'ads_trade_total_1d' && m.layer === 'ads', '表名与层 ads');
  const byName = {}; m.fields.forEach(f => byName[f.name] = f);
  ok(byName.order_count && byName.order_count.expr === 'sum(t.order_count)', '表达式');
  ok(m.sources.length === 1 && m.sources[0].alias === 't', '源表');
  ok(/t\.dt/.test(m.groupBy), 'GROUP BY');
})();

section('MySQL CREATE TABLE 解析');
(function () {
  const sql = "CREATE TABLE IF NOT EXISTS `ods_user_info` (\n  `id` bigint NOT NULL COMMENT '用户ID',\n  `user_name` varchar(64) DEFAULT NULL COMMENT '用户名',\n  `city` varchar(32) COMMENT '城市',\n  PRIMARY KEY (`id`)\n) COMMENT='用户信息表';";
  const rs = SQLParse.parseSQL(sql);
  const m = rs[0].model;
  ok(m.name === 'ods_user_info' && m.layer === 'ods', '表名与层');
  ok(m.fields.length === 3, 'PRIMARY KEY 行不计入字段', m.fields.map(f => f.name));
  ok(m.fields[1].type === 'varchar(64)', '类型 varchar(64)', m.fields[1].type);
  ok(m.fields[2].comment === '城市', '注释');
  ok(m.cnName === '用户信息表', '表 COMMENT', m.cnName);
})();

section('DIM 维度层识别');
(function () {
  const sql = "CREATE TABLE IF NOT EXISTS dim_user (\n  `user_id` BIGINT COMMENT '用户ID',\n  `city` STRING COMMENT '城市'\n) COMMENT '用户维度表';";
  const m = SQLParse.parseSQL(sql)[0].model;
  ok(m.name === 'dim_user' && m.layer === 'dim', 'dim_ 前缀自动归入 DIM 层', m.layer);
  const m2 = SQLParse.parseSQL("CREATE TABLE dwd_x (a bigint COMMENT 'x');")[0].model;
  ok(m2.layer === 'dwd', 'dwd_ 前缀仍归 DWD', m2.layer);
})();

// ================= 多语句 =================
section('多语句一次解析');
(function () {
  const sql = `CREATE TABLE t_a (id bigint COMMENT 'x');
INSERT INTO t_b SELECT a.id AS id, a.name AS name FROM t_a a WHERE a.dt = '2024-01-01';
CREATE TABLE t_c (x int);`;
  const rs = SQLParse.parseSQL(sql);
  ok(rs.length === 3, '3 个模型', rs.map(r => r.model.name));
  const mb = rs[1].model;
  ok(mb.where === "a.dt = '2024-01-01'", 'INSERT 语句 WHERE', mb.where);
})();

// ================= 血缘解析 =================
section('字段级血缘解析（表达式引用提取）');
(function () {
  const refs = Lineage.extractRefs("if(o.pay_amount is null, 0, o.pay_amount)");
  ok(refs.length === 2 && refs.every(r => r.qualifier === 'o' && r.field === 'pay_amount'), 'if() 内两次引用', refs);
  const refs2 = Lineage.extractRefs("coalesce(s.sku_name, od.sku_name)");
  ok(refs2.length === 2 && refs2[0].qualifier === 's' && refs2[1].qualifier === 'od', 'coalesce 跨源引用', refs2);
  const refs3 = Lineage.extractRefs("od.sale_price * od.quantity");
  ok(refs3.length === 2, '算术表达式引用', refs3);
  const refs4 = Lineage.extractRefs("count(distinct oi.order_id)");
  ok(refs4.length === 1 && refs4[0].field === 'order_id', 'count(distinct x)', refs4);
  const refs5 = Lineage.extractRefs("'2024-01-01'");
  ok(refs5.length === 0, '字符串字面量不是引用', refs5);
})();

section('全链路血缘（示例项目）');
(function () {
  const find = n => SAMPLE.models.filter(m => m.name === n)[0];
  // dwd_order_detail_di: 两个源
  const lin1 = Lineage.computeFieldLineage(SAMPLE, find('dwd_order_detail_di'));
  ok(lin1.sources.length === 2, '两源表', lin1.sources.map(s => s.name));
  const sku = lin1.target.fields.filter(f => f.name === 'sku_name')[0];
  ok(sku.refs.length === 2 && sku.refs.every(r => r.resolved), 'coalesce 双源血缘已解析', sku.refs);
  // ads_trade_total_1d
  const lin2 = Lineage.computeFieldLineage(SAMPLE, find('ads_trade_total_1d'));
  const oc = lin2.target.fields.filter(f => f.name === 'order_count')[0];
  ok(oc.refs[0].resolved && oc.refs[0].sourceName === 'dws_trade_shop_order_1d', 'ADS→DWS 血缘', oc.refs);
  // 全局模型级血缘
  const graph = Lineage.computeModelLineage(SAMPLE);
  ok(graph.nodes.length === 11, '11 个模型节点（含 DIM）', graph.nodes.length);
  ok(graph.nodes.filter(n => n.layer === 'dim').length === 1, 'DIM 层有 1 个模型', graph.nodes.filter(n => n.layer === 'dim'));
  ok(graph.edges.length >= 9, '表级血缘边数 ≥ 9（ADS 走 DIM）', graph.edges.length);
  // DIM 链路：dim_user ← ods_user_info；ads_user_buy_stats ← dim_user
  const dimEdges = graph.edges.filter(e => e.fromName === 'ods_user_info' && e.toName === 'dim_user');
  const adsViaDim = graph.edges.filter(e => e.fromName === 'dim_user' && e.toName === 'ads_user_buy_stats');
  ok(dimEdges.length === 1 && adsViaDim.length === 1, 'ODS→DIM→ADS 维度链路成立', graph.edges);
  // ADS 字段级血缘经过 DIM
  const findM = n => SAMPLE.models.filter(m => m.name === n)[0];
  const linAds = Lineage.computeFieldLineage(SAMPLE, findM('ads_user_buy_stats'));
  const cityField = linAds.target.fields.filter(f => f.name === 'city')[0];
  ok(cityField.refs[0].resolved && cityField.refs[0].sourceName === 'dim_user', 'ADS.city 血缘解析到 dim_user.city', cityField.refs);
})();

// ================= SQL 生成 =================
section('SQL 生成（Hive）');
(function () {
  const find = n => SAMPLE.models.filter(m => m.name === n)[0];
  const ddl = SQLGen.genDDL(find('dwd_order_info_di'), 'hive');
  ok(/CREATE TABLE IF NOT EXISTS `dwd_order_info_di`/.test(ddl), 'DDL 表名');
  ok(/COMMENT '订单明细事实表（清洗）'/.test(ddl), '表注释');
  ok(/PARTITIONED BY/.test(ddl) && /`dt` string/i.test(ddl), '分区定义');
  ok(/STORED AS ORC/.test(ddl), '存储格式');
  const dml = SQLGen.genDML(find('dwd_order_info_di'), 'hive', SAMPLE);
  ok(/INSERT OVERWRITE TABLE `dwd_order_info_di` PARTITION \(`?dt`?\)/.test(dml), '动态分区写入');
  ok(/o\.id AS `order_id`/.test(dml), '字段表达式映射');
  ok(/if\(o\.pay_amount is null, 0, o\.pay_amount\)/.test(dml), '业务逻辑表达式保留');
  ok(/WHERE o\.order_status in/.test(dml), 'WHERE 条件');
  const dml2 = SQLGen.genDML(find('dws_trade_shop_order_1d'), 'hive', SAMPLE);
  ok(/LEFT JOIN `dwd_order_detail_di` de/.test(dml2) && /oi\.order_id = de\.order_id/.test(dml2), 'JOIN 生成', dml2);
  ok(/GROUP BY oi\.shop_id, oi\.dt/.test(dml2), 'GROUP BY 生成');
  const odsDdl = SQLGen.genDDL(find('ods_order_info'), 'hive');
  ok(/ODS 同步任务/.test(odsDdl), 'ODS 同步说明');
})();

section('SQL 生成（其它方言 + 拓扑排序）');
(function () {
  const find = n => SAMPLE.models.filter(m => m.name === n)[0];
  const ddlMy = SQLGen.genDDL(find('dws_trade_shop_order_1d'), 'mysql');
  ok(/PRIMARY KEY \(`shop_id`\)/.test(ddlMy), 'MySQL 主键');
  const ddlCH = SQLGen.genDDL(find('dws_trade_shop_order_1d'), 'clickhouse');
  ok(/ENGINE = MergeTree/.test(ddlCH) && /ORDER BY \(shop_id\)/.test(ddlCH), 'ClickHouse ENGINE');
  ok(/Decimal\(18, 2\)/.test(ddlCH), 'CH 类型映射 decimal→Decimal', ddlCH.match(/Decimal[^\n]*/));
  const ddlPG = SQLGen.genDDL(find('dws_trade_shop_order_1d'), 'postgresql');
  ok(/COMMENT ON TABLE/.test(ddlPG), 'PostgreSQL COMMENT ON');
  const topo = SQLGen.topoSort(SAMPLE.models);
  const idx = n => topo.order.findIndex(m => m.name === n);
  ok(idx('ods_order_info') < idx('dwd_order_info_di') && idx('dwd_order_info_di') < idx('dws_trade_shop_order_1d') && idx('dws_trade_shop_order_1d') < idx('ads_trade_total_1d'), '拓扑排序 ODS→DWD→DWS→ADS');
  const script = SQLGen.genScript(SAMPLE, { dialect: 'hive' });
  ok(script.indexOf('ods_order_info') < script.indexOf('dwd_order_info_di'), '全量脚本依赖顺序');
})();

// ================= 生成 → 反解析 回环 =================
section('回环测试：生成的 SQL 再反解析回模型');
(function () {
  const find = n => SAMPLE.models.filter(m => m.name === n)[0];
  const dml = SQLGen.genDML(find('dws_trade_shop_order_1d'), 'hive', SAMPLE);
  const rs = SQLParse.parseSQL(dml);
  ok(rs.length === 1, 'DML 可再次反解析');
  const m = rs[0].model;
  const byName = {}; m.fields.forEach(f => byName[f.name] = f);
  ok(byName.order_count && /count\(distinct oi\.order_id\)/.test(byName.order_count.expr), '业务逻辑无损往返');
  ok(m.sources.length === 2, '源表映射还原', m.sources);
  ok(/oi\.shop_id, oi\.dt/.test(m.groupBy), 'GROUP BY 还原');
})();

// ================= SQL 模板 =================
section('SQL 模板（自定义覆盖）');
(function () {
  const find = n => SAMPLE.models.filter(m => m.name === n)[0];
  // 1. 无 sqlTemplates 时用内置默认（上面用例已覆盖），这里验证显式空串同样回退默认
  const pEmpty = JSON.parse(JSON.stringify(SAMPLE));
  pEmpty.sqlTemplates = { ddl: { hive: '' }, dml: {} };
  ok(/STORED AS ORC/.test(SQLGen.genDDL(find('ods_order_info'), 'hive', pEmpty)), '空模板回退内置默认');
  // 2. 自定义 DDL 模板：变量替换 + 条件块
  const pCustom = JSON.parse(JSON.stringify(SAMPLE));
  pCustom.sqlTemplates = {
    ddl: { hive: '-- custom {{layerUpper}} {{rawTableName}}\nCREATE TABLE {{tableName}};' },
    dml: { hive: 'INSERT INTO {{targetTable}}\nSELECT {{selectList}}\nFROM {{firstSource}}{{if:whereClause}}\n-- filtered{{/if}};' }
  };
  const ddlOut = SQLGen.genDDL(find('ods_order_info'), 'hive', pCustom);
  ok(ddlOut === '-- custom ODS ods_order_info\nCREATE TABLE `ods_order_info`;', '自定义 DDL 模板变量替换', ddlOut);
  // 3. 自定义 DML：whereClause 有值时条件块生效；无值时块被剔除
  const dmlWithWhere = SQLGen.genDML(find('dwd_order_info_di'), 'hive', pCustom);
  ok(/-- filtered/.test(dmlWithWhere) && dmlWithWhere.startsWith('INSERT INTO `dwd_order_info_di`'), '自定义 DML 模板 + 条件块命中', dmlWithWhere.slice(0, 80));
  const dmlNoWhere = SQLGen.genDML(find('dws_user_buy_1d'), 'hive', pCustom);
  ok(!/-- filtered/.test(dmlNoWhere), '条件块在变量为空时剔除', dmlNoWhere);
  // 4. 模板编辑不影响其它方言
  ok(/ENGINE = MergeTree/.test(SQLGen.genDDL(find('dws_trade_shop_order_1d'), 'clickhouse', pCustom)), '未定制方言不受影响');
  // 5. 全量脚本携带自定义模板
  const script = SQLGen.genScript(pCustom, { dialect: 'hive', parts: 'ddl' });
  ok(script.includes('-- custom DWD dwd_order_info_di'), 'genScript 使用自定义模板');
})();

// ================= OLTP：实体 DDL 生成 =================
section('OLTP：业务库实体 DDL 生成');
(function () {
  const proj = { name: '业务库', dialect: 'mysql', kind: 'oltp', models: [
    { id: 'e_dept', layer: 'entity', name: 'dept_info', cnName: '部门', fields: [
      { name: 'id', type: 'bigint', comment: '部门ID', pk: true },
      { name: 'dept_name', type: 'varchar(64)', comment: '部门名' }
    ] },
    { id: 'e_user', layer: 'entity', name: 'user_info', cnName: '用户', fields: [
      { name: 'id', type: 'bigint', comment: '用户ID', pk: true },
      { name: 'dept_id', type: 'bigint', comment: '部门', fk: 'dept_info.id' },
      { name: 'email', type: 'varchar(128)', comment: '邮箱', unique: true },
      { name: 'status', type: 'tinyint', comment: '状态', default: '1' },
      { name: 'created_at', type: 'datetime', comment: '创建时间', default: 'CURRENT_TIMESTAMP', nullable: false }
    ], indexes: [{ name: 'idx_user_dept_status', fields: ['dept_id', 'status'], unique: false }] }
  ] };
  const mysqlDdl = SQLGen.genDDL(proj.models[1], 'mysql', proj);
  ok(/NOT NULL/.test(mysqlDdl) && /DEFAULT 1/.test(mysqlDdl) && /CURRENT_TIMESTAMP/.test(mysqlDdl), 'MySQL：NOT NULL/DEFAULT 生成');
  ok(/UNIQUE/.test(mysqlDdl), 'MySQL：单列唯一');
  ok(/CONSTRAINT .* FOREIGN KEY \(.*dept_id.*\) REFERENCES .*dept_info/.test(mysqlDdl), 'MySQL：外键约束');
  ok(/KEY .*idx_user_dept_status.* \(.*dept_id.*status.*\)/.test(mysqlDdl), 'MySQL：复合索引');
  const pgDdl = SQLGen.genDDL(proj.models[1], 'postgresql', proj);
  ok(/UNIQUE/.test(pgDdl) && /REFERENCES/.test(pgDdl), 'PG：唯一与外键');
  ok(/CREATE INDEX .*idx_user_dept_status/.test(pgDdl), 'PG：独立索引语句');
  ok(/hive/i.test(SQLGen.genDDL(proj.models[1], 'hive', proj)) && /OLTP/.test(SQLGen.genDDL(proj.models[1], 'hive', proj)), '不支持的方言给提示');
  const script = SQLGen.genScript(proj, {});
  ok(script.indexOf('dept_info') < script.indexOf('user_info'), 'OLTP：被引用实体先建（FK 依赖排序）');
  ok(!/INSERT INTO/.test(script), 'OLTP：不生成 ETL DML');
})();

// ================= OLTP：实体 DDL 反解析 =================
section('OLTP：业务库 DDL 反解析');
(function () {
  const sql = `CREATE TABLE user_info (
  id bigint NOT NULL COMMENT '用户ID',
  dept_id bigint COMMENT '部门',
  email varchar(128) NOT NULL COMMENT '邮箱',
  status tinyint DEFAULT 1 COMMENT '状态',
  PRIMARY KEY (id),
  UNIQUE KEY uk_email (email),
  KEY idx_user_dept_status (dept_id, status),
  CONSTRAINT fk_user_dept FOREIGN KEY (dept_id) REFERENCES dept_info (id)
) COMMENT='用户';`;
  const m = SQLParse.parseSQL(sql)[0].model;
  const g = n => m.fields.filter(f => f.name === n)[0];
  ok(g('id').pk === true, '表级 PRIMARY KEY 回填');
  ok(g('email').nullable === false && g('email').unique === true, '表级 UNIQUE KEY 单列 → nullable/unique');
  ok(g('dept_id').fk === 'dept_info.id', '表级 FOREIGN KEY → 字段 fk');
  ok(g('status').default === '1', '列级 DEFAULT 提取');
  ok(m.indexes && m.indexes[0].name === 'idx_user_dept_status' && m.indexes[0].fields.join(',') === 'dept_id,status', '复合索引提取');
  ok(m.cnName === '用户', '表 COMMENT 还原');
  const sqlPg = 'CREATE TABLE order_item (id bigserial PRIMARY KEY, order_id bigint REFERENCES order_info (id), sku varchar(64) UNIQUE NOT NULL, qty int DEFAULT 1);';
  const m2 = SQLParse.parseSQL(sqlPg)[0].model;
  const g2 = n => m2.fields.filter(f => f.name === n)[0];
  ok(g2('id').pk === true, 'PG：列级 PRIMARY KEY');
  ok(g2('order_id').fk === 'order_info.id', 'PG：列级 REFERENCES');
  ok(g2('sku').unique === true && g2('sku').nullable === false, 'PG：列级 UNIQUE NOT NULL');
  // 回环：反解析 → 再生成，约束不丢
  const regen = SQLGen.genDDL(m, 'mysql', { name: 'x', dialect: 'mysql', kind: 'oltp', models: [m] });
  ok(/FOREIGN KEY/.test(regen) && /UNIQUE/.test(regen) && /idx_user_dept_status/.test(regen), '回环：生成 → 反解析 → 再生成约束无损');
})();

console.log('\n========================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
