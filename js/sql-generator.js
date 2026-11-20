/**
 * SQL 生成器（模板驱动版）
 *  - 每个方言 × DDL/DML 都有内置默认模板，输出与历史版本一致
 *  - 项目可通过 project.sqlTemplates[kind][dialect] 覆盖模板
 *  - 模板语法：{{变量}} 插值；{{if:变量}}...{{/if}} 条件块（变量真值时才渲染内部）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SQLGen = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function q(name, dialect) {
    if (dialect === 'mysql' || dialect === 'hive') return '`' + name + '`';
    if (dialect === 'postgresql') return '"' + name + '"';
    return name; // clickhouse
  }
  function esc(s) { return String(s == null ? '' : s).replace(/'/g, "''"); }

  var DIALECTS = ['hive', 'mysql', 'clickhouse', 'postgresql'];

  // ---------- 内置默认模板 ----------
  var DEFAULT_TEMPLATES = {
    ddl: {
      hive: 'CREATE TABLE IF NOT EXISTS {{tableName}} (\n{{columns}}\n)\nCOMMENT \'{{tableComment}}\'\nPARTITIONED BY (\n{{partitionColumns}}\n)\nSTORED AS ORC\n;',
      mysql: 'CREATE TABLE IF NOT EXISTS {{tableName}} (\n{{allColumns}}{{pkClause}}\n) COMMENT=\'{{tableComment}}\'{{if:partitionHint}}\n{{partitionHint}}\n{{/if}};',
      clickhouse: 'CREATE TABLE IF NOT EXISTS {{tableName}}\n(\n{{allColumns}}\n)\nENGINE = MergeTree\nORDER BY ({{orderByKeys}})\n{{if:chPartition}}PARTITION BY {{chPartition}}\n{{/if}}COMMENT \'{{tableComment}}\'\n;',
      postgresql: 'CREATE TABLE IF NOT EXISTS {{tableName}} (\n{{allColumns}}\n);\n{{if:tableCommentClause}}{{tableCommentClause}}\n{{/if}}{{columnCommentClauses}}'
    },
    dml: {
      hive: '{{headerComments}}{{insertVerb}} {{targetTable}}{{dmlPartitionSpec}}\nSELECT\n{{selectList}}\n{{fromClause}}{{if:whereClause}}\nWHERE {{whereClause}}{{/if}}{{if:groupByClause}}\nGROUP BY {{groupByClause}}{{/if}}\n;',
      mysql: '{{headerComments}}{{insertVerb}} {{targetTable}}\nSELECT\n{{selectList}}\n{{fromClause}}{{if:whereClause}}\nWHERE {{whereClause}}{{/if}}{{if:groupByClause}}\nGROUP BY {{groupByClause}}{{/if}}\n;',
      clickhouse: '{{headerComments}}{{insertVerb}} {{targetTable}}\nSELECT\n{{selectList}}\n{{fromClause}}{{if:whereClause}}\nWHERE {{whereClause}}{{/if}}{{if:groupByClause}}\nGROUP BY {{groupByClause}}{{/if}}\n;',
      postgresql: '{{headerComments}}{{insertVerb}} {{targetTable}}\nSELECT\n{{selectList}}\n{{fromClause}}{{if:whereClause}}\nWHERE {{whereClause}}{{/if}}{{if:groupByClause}}\nGROUP BY {{groupByClause}}{{/if}}\n;'
    }
  };

  // DDL/DML 模板可用变量说明（供编辑器展示）
  var TEMPLATE_VARS = {
    ddl: [
      { key: 'tableName', desc: '带引用符的表名' },
      { key: 'rawTableName', desc: '原始表名（无引用符）' },
      { key: 'tableComment', desc: '表中文名（转义后）' },
      { key: 'layerUpper', desc: '分层大写（ODS/DIM/…）' },
      { key: 'columns', desc: '普通字段定义（逗号分隔多行）' },
      { key: 'partitionColumns', desc: '分区字段定义' },
      { key: 'allColumns', desc: '普通字段 + 分区字段（合在一起）' },
      { key: 'pkClause', desc: '主键子句（MySQL；无主键为空）' },
      { key: 'orderByKeys', desc: 'ClickHouse 排序键或 tuple()' },
      { key: 'chPartition', desc: 'ClickHouse 分区表达式' },
      { key: 'partitionHint', desc: 'MySQL 分区提示注释' },
      { key: 'tableCommentClause', desc: 'PostgreSQL 表注释语句' },
      { key: 'columnCommentClauses', desc: 'PostgreSQL 字段注释语句' }
    ],
    dml: [
      { key: 'headerComments', desc: '表名/描述注释（-- 开头，含换行）' },
      { key: 'insertVerb', desc: 'INSERT OVERWRITE TABLE / INSERT INTO' },
      { key: 'targetTable', desc: '目标表名（带引用符）' },
      { key: 'dmlPartitionSpec', desc: '动态分区子句（Hive）' },
      { key: 'selectList', desc: 'SELECT 字段清单（expr AS col）' },
      { key: 'fromClause', desc: 'FROM + LEFT JOIN 子句' },
      { key: 'whereClause', desc: '过滤条件内容' },
      { key: 'groupByClause', desc: '分组内容' }
    ]
  };

  // ---------- 模板引擎 ----------
  function renderTemplate(tpl, vars) {
    var out = String(tpl || '').replace(/\{\{if:(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, function (_, key, inner) {
      return vars[key] ? inner : '';
    });
    out = out.replace(/\{\{(\w+)\}\}/g, function (_, key) {
      return vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : '';
    });
    return out.replace(/\s+$/, '');
  }

  function getTemplate(project, kind, dialect) {
    var t = project && project.sqlTemplates && project.sqlTemplates[kind] && project.sqlTemplates[kind][dialect];
    return (t && String(t).trim()) ? t : DEFAULT_TEMPLATES[kind][dialect];
  }

  // ---------- 变量构建 ----------
  function mapTypeCH(t) {
    var m = /^(\w+)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/.exec(t);
    var base = (m ? m[1] : t).toLowerCase();
    var args = m ? m.slice(2, m[1] === 'decimal' && m[3] !== undefined ? 4 : 3).filter(function (x) { return x !== undefined; }) : [];
    var map = {
      string: 'String', varchar: 'String', text: 'String', json: 'String',
      bigint: 'Int64', int: 'Int32', integer: 'Int32', smallint: 'Int16', tinyint: 'Int8',
      double: 'Float64', float: 'Float32', boolean: 'Bool', bool: 'Bool', date: 'Date', datetime: 'DateTime'
    };
    if (base === 'decimal') return 'Decimal(' + (args.length ? args.join(', ') : '38, 2') + ')';
    var ch = map[base];
    if (!ch) return t;
    return ch;
  }

  function colDef(f, dialect) {
    var t = String(f.type || 'string').trim() || 'string';
    if (dialect === 'clickhouse') t = mapTypeCH(t);
    var col = '  ' + q(f.name, dialect) + ' ' + t;
    if (f.pk && dialect === 'mysql') col += ' NOT NULL';
    if (f.comment) col += (dialect === 'postgresql' ? '' : " COMMENT '" + esc(f.comment) + "'");
    return col;
  }

  function buildDdlVars(m, dialect) {
    var cols = (m.fields || []).map(function (f) { return colDef(f, dialect); });
    var parts = (m.partition || []).map(function (f) { return colDef(f, dialect); });
    var pks = (m.fields || []).filter(function (f) { return f.pk; }).map(function (f) { return q(f.name, dialect); });
    var vars = {
      tableName: q(m.name, dialect),
      rawTableName: String(m.name || ''),
      tableComment: esc(m.cnName || m.name),
      layerUpper: String(m.layer || '').toUpperCase(),
      columns: cols.join(',\n'),
      partitionColumns: parts.join(',\n'),
      allColumns: cols.concat(parts).join(',\n'),
      pkClause: (dialect === 'mysql' && pks.length) ? '\n  PRIMARY KEY (' + pks.join(', ') + ')' : '',
      orderByKeys: pks.length ? pks.join(', ') : 'tuple()',
      chPartition: (dialect === 'clickhouse' && (m.partition || []).length) ? q(m.partition[0].name, dialect) : '',
      partitionHint: (dialect === 'mysql' && (m.partition || []).length)
        ? '-- MySQL 无分区表语法，以下字段建议转为普通列或按天分表：' + (m.partition || []).map(function (pf) { return pf.name; }).join(', ')
        : '',
      tableCommentClause: (dialect === 'postgresql' && m.cnName)
        ? "COMMENT ON TABLE " + q(m.name, dialect) + " IS '" + esc(m.cnName) + "';" : '',
      columnCommentClauses: (dialect === 'postgresql')
        ? (m.fields || []).concat(m.partition || []).filter(function (f) { return f.comment; })
          .map(function (f) { return "COMMENT ON COLUMN " + q(m.name, dialect) + '.' + q(f.name, dialect) + " IS '" + esc(f.comment) + "';"; })
          .join('\n')
        : ''
    };
    return vars;
  }

  function buildDmlVars(m, dialect) {
    var selectParts = (m.fields || []).map(function (f) {
      var expr = (f.expr || '').trim() || f.name;
      return '  ' + expr + ' AS ' + q(f.name, dialect);
    });
    (m.partition || []).forEach(function (pf) {
      var expr = (pf.expr || '').trim() || pf.name;
      selectParts.push('  ' + expr + ' AS ' + q(pf.name, dialect));
    });
    var srcs = m.sources || [];
    var fromLines = [];
    if (srcs.length) {
      var first = srcs[0];
      fromLines.push('FROM ' + q(first.name || '未命名源表', dialect) + (first.alias ? ' ' + first.alias : ''));
      for (var i = 1; i < srcs.length; i++) {
        var s = srcs[i];
        var on = (s.on || '').trim() || '/* TODO: 请补充关联条件 */ 1 = 1';
        fromLines.push('LEFT JOIN ' + q(s.name || '未命名源表', dialect) + (s.alias ? ' ' + s.alias : '') + '\n  ON ' + on);
      }
    }
    return {
      headerComments: (m.cnName ? '-- ' + m.cnName + '\n' : '') + (m.desc ? '-- ' + m.desc + '\n' : ''),
      insertVerb: dialect === 'hive' ? 'INSERT OVERWRITE TABLE' : 'INSERT INTO',
      targetTable: q(m.name, dialect),
      dmlPartitionSpec: (dialect === 'hive' && (m.partition || []).length)
        ? ' PARTITION (' + (m.partition || []).map(function (pf) { return q(pf.name, dialect); }).join(', ') + ')' : '',
      selectList: selectParts.join(',\n'),
      fromClause: fromLines.join('\n'),
      whereClause: m.where || '',
      groupByClause: m.groupBy || ''
    };
  }

  // ---------- 生成入口 ----------
  function genDDL(m, dialect, project) {
    dialect = dialect || (project && project.dialect) || 'hive';
    var usingDefault = !(project && project.sqlTemplates && project.sqlTemplates.ddl && String(project.sqlTemplates.ddl[dialect] || '').trim());
    var out = renderTemplate(getTemplate(project, 'ddl', dialect), buildDdlVars(m, dialect));
    // 仅内置默认模板时追加 ODS 同步说明（自定义模板输出完全由用户掌控）
    if (usingDefault && (m.source || '') && m.layer === 'ods') {
      out += '\n\n-- ODS 同步任务：' + m.source + ' → ' + m.name + '（由 DataX / Flink CDC 等集成工具执行，也可交给 DSH 编写同步脚本）';
    }
    return out;
  }

  function genDML(m, dialect, project) {
    dialect = dialect || (project && project.dialect) || 'hive';
    if (m.layer === 'ods') {
      var src = m.source || '（未配置源系统）';
      return '-- ' + m.name + ' 为 ODS 层贴源表，数据来自：' + src + '\n' +
        '-- 生成方式：数据集成任务全量/增量同步；如需帮助可在工作台「DSH 任务」中生成同步方案。\n' +
        '-- 示例（Flink CDC 参考）：\n' +
        '-- INSERT INTO ' + q(m.name, dialect) + '\n-- SELECT id, user_id, ... FROM ' + esc(src) + ';';
    }
    if (!(m.sources || []).length) {
      return '-- ' + m.name + ' 尚未配置源表映射，请先在「模型设计 → 源表映射」中维护上游模型。';
    }
    var tpl = getTemplate(project, 'dml', dialect);
    return renderTemplate(tpl, buildDmlVars(m, dialect));
  }

  // 用指定模板预览渲染（模板编辑器用）
  function previewTemplate(m, dialect, kind, tpl) {
    var vars = kind === 'ddl' ? buildDdlVars(m, dialect) : buildDmlVars(m, dialect);
    return renderTemplate(tpl, vars);
  }

  // ---------- 全量脚本（按依赖拓扑排序） ----------
  function topoSort(models) {
    var byName = {};
    models.forEach(function (m) { byName[m.name] = m; });
    var visited = {}, order = [], stack = {}, cycleWarn = [];
    function visit(m) {
      if (visited[m.name]) return;
      if (stack[m.name]) { cycleWarn.push(m.name); return; }
      stack[m.name] = true;
      (m.sources || []).forEach(function (s) { if (s.name && byName[s.name]) visit(byName[s.name]); });
      stack[m.name] = false;
      visited[m.name] = true;
      order.push(m);
    }
    models.forEach(visit);
    return { order: order, cycleWarn: cycleWarn };
  }

  function genScript(project, opts) {
    opts = opts || {};
    var dialect = opts.dialect || project.dialect || 'hive';
    var models;
    if (opts.modelId) {
      models = (project.models || []).filter(function (m) { return m.id === opts.modelId; });
    } else {
      models = topoSort(project.models || []).order;
    }
    var parts = [];
    var header = '/*\n * 数据仓库脚本（由数据建模工作台生成）\n * 项目：' + (project.name || '未命名') + '\n * 方言：' + dialectName(dialect) + '\n * 生成时间：' + new Date().toLocaleString('zh-CN') + '\n * 模型数：' + models.length + '\n */';
    parts.push(header);
    models.forEach(function (m, i) {
      parts.push('\n' + '='.repeat(60));
      parts.push('-- ' + (i + 1) + '. ' + '[' + (m.layer || '').toUpperCase() + '] ' + m.name + (m.cnName ? '（' + m.cnName + '）' : ''));
      parts.push('='.repeat(60));
      if (opts.parts !== 'dml') parts.push(genDDL(m, dialect, project));
      if (opts.parts !== 'ddl') {
        parts.push('');
        parts.push(genDML(m, dialect, project));
      }
    });
    return parts.join('\n');
  }

  function dialectName(d) {
    return { hive: 'Hive / SparkSQL', mysql: 'MySQL', clickhouse: 'ClickHouse', postgresql: 'PostgreSQL' }[d] || d;
  }

  return {
    genDDL: genDDL, genDML: genDML, genScript: genScript, topoSort: topoSort,
    dialectName: dialectName, renderTemplate: renderTemplate, previewTemplate: previewTemplate,
    getTemplate: getTemplate, DEFAULT_TEMPLATES: DEFAULT_TEMPLATES, TEMPLATE_VARS: TEMPLATE_VARS, DIALECTS: DIALECTS
  };
});
