/**
 * 模型编辑器：头图 / 统计卡 / 字段表 / 源表映射 / 分区 / 洞察栏
 * 通过事件委托更新 Store，输入不触发全量重渲染（保持焦点）
 */
(function (root) {
  'use strict';
  var Store = root.Store, Lineage = root.Lineage;
  var TYPE_OPTIONS = ['string', 'varchar(64)', 'varchar(255)', 'text', 'int', 'bigint', 'smallint', 'tinyint', 'decimal(16,2)', 'decimal(18,2)', 'double', 'float', 'boolean', 'date', 'datetime', 'timestamp', 'json', 'array<string>', 'map<string,string>'];

  var LAYER_META = {
    ods: { short: 'ODS', cn: '贴源层' },
    dim: { short: 'DIM', cn: '维度层' },
    dwd: { short: 'DWD', cn: '明细层' },
    dws: { short: 'DWS', cn: '汇总层' },
    ads: { short: 'ADS', cn: '应用层' },
    entity: { short: 'ENT', cn: '业务实体' }
  };
  var TYPE_GROUPS = [
    { key: 'num', label: '数值', color: 'var(--blue)', n: 0 },
    { key: 'str', label: '字符', color: 'var(--teal)', n: 0 },
    { key: 'dec', label: '金额', color: 'var(--amber)', n: 0 },
    { key: 'time', label: '时间', color: 'var(--accent)', n: 0 },
    { key: 'bool', label: '布尔', color: 'var(--pink)', n: 0 }
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function attr(s) { return esc(s); }

  // fk 引用解析："表.列" → { entity, column }（与 ER 图 / 推送逻辑一致）
  function parseFkRef(fk) {
    var s = String(fk || '');
    var i = s.indexOf('.');
    if (!s) return { entity: '', column: '' };
    if (i <= 0) return { entity: s, column: '' };
    return { entity: s.slice(0, i), column: s.slice(i + 1) };
  }

  function typeClass(t) {
    t = String(t || '').toLowerCase();
    if (/^(bigint|int|smallint|tinyint|integer|long)/.test(t)) return 'num';
    if (/^(decimal|numeric|double|float|number)/.test(t)) return 'dec';
    if (/^(date|datetime|timestamp|time)/.test(t)) return 'time';
    if (/^(bool|boolean)/.test(t)) return 'bool';
    if (/^(string|varchar|char|text|json|array|map)/.test(t)) return 'str';
    return 'str';
  }
  function typeGlyph(c) {
    return c === 'num' ? '123' : c === 'dec' ? '0.0' : c === 'time' ? 'T' : c === 'bool' ? '01' : 'Aa';
  }

  var ICON = {
    field: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h6.4"/></svg>',
    db: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><ellipse cx="8" cy="4.4" rx="5.4" ry="2"/><path d="M2.6 4.4v7.2c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V4.4"/><path d="M2.6 8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2"/></svg>',
    grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.2"/><rect x="9" y="2.4" width="4.6" height="4.6" rx="1.2"/><rect x="2.4" y="9" width="4.6" height="4.6" rx="1.2"/><rect x="9" y="9" width="4.6" height="4.6" rx="1.2"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.7"/><path d="M5.4 8.3l1.8 1.8 3.4-3.9"/></svg>',
    star: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.6 9.9 5.5 14.2 6.1 11.1 9.1 11.8 13.4 8 11.4 4.2 13.4 4.9 9.1 1.8 6.1 6.1 5.5Z"/></svg>',
    chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 4 10.4 8l-4 4"/></svg>',
    up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V4M5 7 8 4l3 3"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5V12M5 9 8 12l3-3"/></svg>',
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>',
    col: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.6"/><path d="M2.4 6.4h11.2M6.6 6.4v6.4"/></svg>',
    link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4 9.4 6.6"/><path d="M5.2 7.9 3.9 9.2a2.1 2.1 0 0 0 3 3l1.3-1.3"/><path d="M10.8 8.1l1.3-1.3a2.1 2.1 0 0 0-3-3L7.8 5.1"/></svg>',
    more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.8" cy="8" r="1.3"/></svg>'
  };

  function donutHTML(groups, total) {
    var R = 33, C = 2 * Math.PI * R, segs = '', acc = 0;
    groups.forEach(function (g) {
      if (!g.n) return;
      var len = C * g.n / total;
      segs += '<circle cx="42" cy="42" r="' + R + '" fill="none" stroke="' + g.color + '" stroke-width="9" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '"/>';
      acc += len;
    });
    return '<svg width="84" height="84" viewBox="0 0 84 84">'
      + '<circle cx="42" cy="42" r="33" fill="none" stroke="var(--panel-3)" stroke-width="9"/>'
      + segs + '</svg>';
  }

  function render() {
    var pane = document.getElementById('pane-model');
    var m = Store.find(Store.selectedId);
    if (!m) {
      var emptyLabel = Store.isOLTP() ? '新建实体' : '新建模型';
      pane.innerHTML = '<div class="empty-state"><div class="empty-icon">' + ICON.grid + '</div><p>' + (Store.isOLTP() ? '从左侧选择一个实体，或新建一个实体开始设计' : '从左侧选择一个模型，或新建一个模型开始设计') + '</p><button class="btn primary" onclick="Store.newModel();App.refresh()">' + emptyLabel + '</button></div>';
      return;
    }
    var oltp = Store.isOLTP();
    var models = Store.getModels().filter(function (x) { return x.id !== m.id; });
    var modelCols = Store.getCustomCols('model');
    var fieldCols = Store.getCustomCols('field');
    var lin = Lineage.computeFieldLineage(Store.project, m);
    var badgeByField = {};
    lin.target.fields.forEach(function (f) {
      var ok = f.refs.filter(function (r) { return r.resolved; }).length;
      var bad = f.refs.filter(function (r) { return !r.resolved; }).length;
      badgeByField[f.name] = { ok: ok, bad: bad, detail: f.refs.map(function (r) { return (r.qualifier ? r.qualifier + '.' : '') + r.field + (r.resolved ? '' : ' ✕'); }).join('、') };
    });

    var fields = m.fields || [];
    var fieldCount = fields.length;
    var pkCount = fields.filter(function (f) { return f.pk; }).length;
    var fkCount = fields.filter(function (f) { return f.fk; }).length;
    var idxCount = (m.indexes || []).length;
    var srcCount = (m.sources || []).length;
    var partCount = (m.partition || []).length;
    var linTotal = fieldCount;
    var linOk = fields.filter(function (f) {
      var b = badgeByField[f.name];
      return b && b.ok > 0 && !b.bad;
    }).length;
    var linPct = linTotal ? Math.round(linOk / linTotal * 100) : 0;
    var hasExpr = fields.some(function (f) { return f.expr && String(f.expr).trim(); });
    var linDisplay = hasExpr ? linPct + '<small>%</small>' : '—';
    var linLabel = hasExpr ? ('血缘完整度 · ' + linOk + '/' + linTotal + ' 已推导') : '血缘完整度 · 待填表达式';

    var catPath = '';
    if (m.catalogId) {
      var cn = Store.findCatalogNode ? Store.findCatalogNode(m.catalogId) : null;
      if (cn && cn.path) catPath = cn.path;
    }
    var lmeta = LAYER_META[m.layer] || (oltp ? LAYER_META.entity : LAYER_META.ods);

    var h = [];
    h.push('<div class="editor">');

    /* ---------------- 头图 ---------------- */
    h.push('<section class="hero">');
    h.push('<div class="crumbs">' + lmeta.short + ' · ' + lmeta.cn + ICON.chev + (catPath ? esc(catPath) + ICON.chev : '') + '<b>' + esc(m.cnName || m.name || (oltp ? '未命名实体' : '未命名模型')) + '</b></div>');
    h.push('<div class="hero-row"><div class="hero-main">');
    h.push('<div class="hero-title">');
    h.push('<input id="m-name" class="h1-input mono" data-meta="name" value="' + attr(m.name) + '" placeholder="' + (oltp ? 'table_name' : 'model_name') + '">');
    if (!oltp) {
      h.push('<select id="m-layer" class="layer-select l-' + (m.layer || 'ods') + '" title="数据分层">'
        + ['ods', 'dim', 'dwd', 'dws', 'ads'].map(function (ly) {
          return '<option value="' + ly + '"' + (m.layer === ly ? ' selected' : '') + '>' + ly.toUpperCase() + '</option>';
        }).join('') + '</select>');
    }
    h.push('<span class="tag ok"><i class="led"></i>自动保存</span>');
    h.push('</div>');

    h.push('<div class="hero-subline">');
    h.push('<input id="m-cn" class="sub-input" data-meta="cnName" value="' + attr(m.cnName) + '" placeholder="中文名，如 ' + (oltp ? '用户表' : '订单主表') + '">');
    var catNodes = Store.catalogFlat();
    h.push('<select id="m-catalog" class="catalog-select" title="' + (oltp ? '业务归属（业务域 / 模块）' : '业务目录树中的挂载节点') + '">'
      + '<option value="">' + (oltp ? '未归类' : '未归类') + '</option>'
      + catNodes.map(function (c) {
        return '<option value="' + attr(c.id) + '"' + (m.catalogId === c.id ? ' selected' : '') + '>' + esc('L' + c.level + ' · ' + c.path) + '</option>';
      }).join('') + '</select>');
    h.push('</div>');

    h.push('<input id="m-desc" class="hero-desc" data-meta="desc" value="' + attr(m.desc) + '" placeholder="' + (oltp ? '表用途与业务说明…' : '补充模型用途、口径与注意事项…') + '">');

    h.push('<div class="hero-meta">');
    if (oltp) {
      h.push('<span>' + ICON.field + '<b>' + fieldCount + '</b> 字段</span>');
      h.push('<span>' + ICON.star + '<b>' + pkCount + '</b> 主键</span>');
      h.push('<span>' + ICON.link + '<b>' + fkCount + '</b> 外键</span>');
      h.push('<span>' + ICON.grid + '<b>' + idxCount + '</b> 索引</span>');
    } else {
      h.push('<span>' + ICON.field + '<b>' + fieldCount + '</b> 字段</span>');
      h.push('<span>' + ICON.db + '<b>' + srcCount + '</b> 源表</span>');
      h.push('<span>' + ICON.grid + '<b>' + (partCount ? 'dt' : '—') + '</b> 分区</span>');
      h.push('<span>' + ICON.check + '血缘完整度 <b>' + (hasExpr ? linPct + '%' : '—') + '</b></span>');
    }
    h.push('</div>');
    h.push('</div>');

    h.push('<div class="hero-acts">');
    h.push('<button class="btn" data-act="hero-lineage">' + (oltp ? ICON.link + 'ER 模型图' : ICON.up + '上游血缘') + '</button>');
    h.push('<button class="btn" data-act="hero-sql">' + ICON.col + '生成 DDL</button>');
    if (!oltp || modelCols.length) {
      h.push('<button class="btn ghost icon" data-act="toggle-meta" title="更多属性">' + ICON.more + '</button>');
    }
    h.push('</div></div>');

    /* 更多属性（折叠）：oltp 仅保留自定义列 */
    if (!oltp || modelCols.length) {
      h.push('<div class="meta-more" id="meta-more" hidden>');
      h.push('<div class="form-grid">');
      if (!oltp) {
        h.push('<label class="' + (m.layer === 'ods' ? '' : 'dim') + '">' + (m.layer === 'ods' ? '源系统（ODS 贴源）' : '源系统（仅 ODS 层有效）') + '<input id="m-source" data-meta="source" value="' + attr(m.source) + '" placeholder="mysql://host/db/table"></label>');
        h.push('<label>过滤条件 WHERE<input id="m-where" class="mono" data-meta="where" value="' + attr(m.where) + '" placeholder="如 o.status in (...)"></label>');
        h.push('<label>分组 GROUP BY<input id="m-group" class="mono" data-meta="groupBy" value="' + attr(m.groupBy) + '" placeholder="如 o.shop_id, o.dt"></label>');
      }
      modelCols.forEach(function (col) {
        h.push('<label>' + esc(col.label) + '<input data-meta="x:' + attr(col.key) + '" value="' + attr(m[col.key] || '') + '" placeholder="' + esc(col.label) + '"></label>');
      });
      h.push('</div>');
      h.push('<div style="margin-top:12px"><button class="btn small" data-act="manage-cols" data-scope="model" title="为表元信息增加自定义属性列">' + ICON.col + '自定义列</button></div>');
      h.push('</div>');
    }
    h.push('</section>');

    /* ---------------- 统计卡 ---------------- */
    h.push('<section class="stats">');
    if (oltp) {
      h.push('<div class="stat"><span class="stat-ico v">' + ICON.field + '</span><div class="stat-body"><div class="stat-v">' + fieldCount + '</div><div class="stat-k">字段数</div></div></div>');
      h.push('<div class="stat"><span class="stat-ico a">' + ICON.star + '</span><div class="stat-body"><div class="stat-v">' + pkCount + '</div><div class="stat-k">主键（PK）</div></div></div>');
      h.push('<div class="stat"><span class="stat-ico b">' + ICON.link + '</span><div class="stat-body"><div class="stat-v">' + fkCount + '</div><div class="stat-k">外键（FK）</div></div></div>');
      h.push('<div class="stat"><span class="stat-ico g">' + ICON.grid + '</span><div class="stat-body"><div class="stat-v">' + idxCount + '</div><div class="stat-k">索引</div></div></div>');
    } else {
      h.push('<div class="stat"><span class="stat-ico v">' + ICON.field + '</span><div class="stat-body"><div class="stat-v">' + fieldCount + '</div><div class="stat-k">字段定义 · ' + pkCount + ' 主键</div></div></div>');
      h.push('<div class="stat"><span class="stat-ico b">' + ICON.db + '</span><div class="stat-body"><div class="stat-v">' + srcCount + '</div><div class="stat-k">上游源表 · ' + (srcCount ? '已关联' : '未配置') + '</div></div></div>');
      h.push('<div class="stat"><span class="stat-ico a">' + ICON.grid + '</span><div class="stat-body"><div class="stat-v">' + (partCount ? (m.partition[0] && m.partition[0].name || 'dt') : '0') + '</div><div class="stat-k">分区字段 · ' + (partCount ? '每日增量' : '全量表') + '</div></div></div>');
      h.push('<div class="stat"><span class="stat-ico g">' + ICON.check + '</span><div class="stat-body"><div class="stat-v">' + linDisplay + '</div><div class="stat-k">' + linLabel + '</div></div></div>');
    }
    h.push('</section>');

    /* ---------------- 主体两栏 ---------------- */
    h.push('<div class="edit-grid">');
    h.push('<div class="edit-col">');

    /* 字段定义 */
    h.push('<section class="card">');
    h.push('<div class="card-head"><h3>' + (oltp ? '字段定义' : '字段定义') + ' <span class="count-badge">' + fieldCount + '</span> <span class="card-sub">' + (oltp ? '类型色标 · 主键星标 · 外键引用' : '类型色标 · 主键星标 · 血缘直达') + '</span></h3>');
    h.push('<div><button class="btn small" data-act="manage-cols" data-scope="field" title="为字段表格增加自定义列">' + ICON.col + '自定义列</button> <button class="btn small soft" data-act="add-f">' + ICON.plus + '字段</button></div>');
    h.push('</div>');
    h.push('<datalist id="type-list">' + TYPE_OPTIONS.map(function (t) { return '<option value="' + t + '">'; }).join('') + '</datalist>');

    if (oltp) {
      /* ---- oltp 实体字段表：字段名 | 类型 | 注释 | PK | 可空 | 唯一 | 默认 | FK 引用 ---- */
      var fkModels = Store.getModels().filter(function (x) { return x.id !== m.id && x.name; });
      h.push('<div class="tbl-wrap"><table class="tbl field-tbl oltp-field-tbl"><thead><tr>'
        + '<th style="width:34px">#</th>'
        + '<th style="width:17%">字段</th>'
        + '<th style="width:128px">类型</th>'
        + '<th style="width:13%">注释</th>'
        + '<th style="width:40px;text-align:center" title="主键">PK</th>'
        + '<th style="width:40px;text-align:center" title="可空（缺省可空，PK 隐含 NOT NULL）">可空</th>'
        + '<th style="width:40px;text-align:center" title="单列唯一">唯一</th>'
        + '<th style="width:86px" title="缺省值（原样进 DDL）">默认</th>'
        + '<th>FK 引用</th>'
        + '<th style="width:66px"></th></tr></thead><tbody>');
      fields.forEach(function (f, i) {
        var tc = typeClass(f.type);
        var fk = parseFkRef(f.fk);
        var fkEntityModel = fk.entity ? Store.findByName(fk.entity) : null;
        if (fkEntityModel && fkEntityModel.id === m.id) fkEntityModel = null; // 自引用不提供选项
        var fkCols = fkEntityModel ? (fkEntityModel.fields || []).map(function (x) { return x.name; }).filter(Boolean) : [];
        h.push('<tr data-row="' + i + '">');
        h.push('<td class="idx">' + (i + 1) + '</td>');
        h.push('<td><div class="fcell"><span class="fico ' + tc + '">' + typeGlyph(tc) + '</span><input class="fname mono" data-f="' + i + '" data-p="name" value="' + attr(f.name) + '" placeholder="field_name"></div></td>');
        h.push('<td><span class="tchip ' + tc + '"><input class="tinput mono" data-f="' + i + '" data-p="type" list="type-list" value="' + attr(f.type) + '" title="' + attr(f.type) + '"></span></td>');
        h.push('<td><input class="fcomment" data-f="' + i + '" data-p="comment" value="' + attr(f.comment) + '" placeholder="中文注释"></td>');
        h.push('<td style="text-align:center"><label class="pk-btn" title="设为主键"><input type="checkbox" data-f="' + i + '" data-p="pk"' + (f.pk ? ' checked' : '') + '>' + ICON.star + '</label></td>');
        h.push('<td style="text-align:center"><input type="checkbox" data-f="' + i + '" data-p="nullable"' + (f.nullable !== false ? ' checked' : '') + (f.pk ? ' disabled title="主键隐含 NOT NULL"' : ' title="可空（缺省可空）"') + '></td>');
        h.push('<td style="text-align:center"><input type="checkbox" data-f="' + i + '" data-p="unique"' + (f.unique ? ' checked' : '') + ' title="单列唯一"></td>');
        h.push('<td><input class="mono fdefault" data-f="' + i + '" data-p="default" value="' + attr(f.default) + '" placeholder="如 1" title="缺省值（原样进 DDL，如 1、CURRENT_TIMESTAMP）"></td>');
        h.push('<td><div class="fk-cell">'
          + '<select class="fk-entity" data-f="' + i + '" data-p="fkEntity" title="引用实体"><option value="">无</option>'
          + fkModels.map(function (x) {
            return '<option value="' + attr(x.name) + '"' + (fk.entity === x.name ? ' selected' : '') + '>' + esc(x.name + (x.cnName ? '（' + x.cnName + '）' : '')) + '</option>';
          }).join('') + '</select>'
          + '<select class="fk-col mono" data-f="' + i + '" data-p="fkCol"' + (fkEntityModel ? '' : ' disabled') + ' title="引用字段">'
          + (fkEntityModel ? fkCols.map(function (c) {
            return '<option value="' + attr(c) + '"' + (fk.column === c ? ' selected' : '') + '>' + esc(c) + '</option>';
          }).join('') : '<option value="">' + (fk.entity ? '（实体不存在）' : '—') + '</option>')
          + '</select></div></td>');
        h.push('<td class="row-acts"><button class="icon-btn" data-act="up-f" data-i="' + i + '" title="上移">' + ICON.up + '</button><button class="icon-btn" data-act="down-f" data-i="' + i + '" title="下移">' + ICON.down + '</button><button class="icon-btn danger" data-act="del-f" data-i="' + i + '" title="删除">' + ICON.x + '</button></td>');
        h.push('</tr>');
      });
      h.push('</tbody></table></div>');
      h.push('</section>');

      /* ---- 索引卡片：名称 + 字段多选 chips + 唯一 ---- */
      h.push('<section class="card">');
      h.push('<div class="card-head"><h3>索引 <span class="count-badge">' + idxCount + '</span> <span class="card-sub">点击字段名加入索引（按点击顺序）</span></h3><div><button class="btn small soft" data-act="add-idx">' + ICON.plus + '索引</button></div></div>');
      if (!idxCount) {
        h.push('<div class="card-body"><p class="hint">暂无索引。点击「＋索引」为高频查询字段建索引，复合索引字段顺序影响查询性能。</p></div>');
      } else {
        h.push('<div class="idx-list">');
        var namedFields = fields.map(function (f) { return f.name; }).filter(Boolean);
        (m.indexes || []).forEach(function (ix, i) {
          h.push('<div class="idx-row">');
          h.push('<input class="idx-name mono" data-ix="' + i + '" data-p="name" value="' + attr(ix.name) + '" placeholder="idx_name" title="索引名">');
          h.push('<div class="idx-chips">');
          if (!namedFields.length) h.push('<span class="hint small">先添加字段</span>');
          namedFields.forEach(function (fn) {
            var on = (ix.fields || []).indexOf(fn) >= 0;
            var pos = on ? (ix.fields || []).indexOf(fn) + 1 : '';
            h.push('<button type="button" class="idx-chip' + (on ? ' on' : '') + '" data-act="idx-toggle" data-ix="' + i + '" data-field="' + attr(fn) + '" title="' + (on ? '移出索引（当前第 ' + pos + ' 位）' : '加入索引') + '">' + esc(fn) + (on ? '<i>' + pos + '</i>' : '') + '</button>');
          });
          h.push('</div>');
          h.push('<label class="idx-uniq" title="唯一索引"><input type="checkbox" data-ix="' + i + '" data-p="unique"' + (ix.unique ? ' checked' : '') + '>唯一</label>');
          h.push('<button class="icon-btn danger" data-act="del-idx" data-i="' + i + '" title="删除索引">' + ICON.x + '</button>');
          h.push('</div>');
        });
        h.push('</div>');
      }
      h.push('</section>');
    } else {
      /* ---- olap 字段表（原样） ---- */
      h.push('<div class="tbl-wrap"><table class="tbl field-tbl"><thead><tr>'
        + '<th style="width:34px">#</th>'
        + '<th style="width:20%">字段</th>'
        + '<th style="width:138px">类型</th>'
        + '<th style="width:15%">注释</th>'
        + '<th style="width:44px;text-align:center">PK</th>'
        + '<th>表达式</th>'
        + fieldCols.map(function (col) { return '<th>' + esc(col.label) + '</th>'; }).join('')
        + '<th style="width:170px">血缘</th>'
        + '<th style="width:66px"></th></tr></thead><tbody>');

      fields.forEach(function (f, i) {
        var badge = badgeByField[f.name] || { ok: 0, bad: 0, detail: '' };
        var tc = typeClass(f.type);
        h.push('<tr data-row="' + i + '">');
        h.push('<td class="idx">' + (i + 1) + '</td>');
        h.push('<td><div class="fcell"><span class="fico ' + tc + '">' + typeGlyph(tc) + '</span><input class="fname mono" data-f="' + i + '" data-p="name" value="' + attr(f.name) + '" placeholder="field_name"></div></td>');
        h.push('<td><span class="tchip ' + tc + '"><input class="tinput mono" data-f="' + i + '" data-p="type" list="type-list" value="' + attr(f.type) + '" title="' + attr(f.type) + '"></span></td>');
        h.push('<td><input class="fcomment" data-f="' + i + '" data-p="comment" value="' + attr(f.comment) + '" placeholder="中文注释"></td>');
        h.push('<td style="text-align:center"><label class="pk-btn" title="设为主键"><input type="checkbox" data-f="' + i + '" data-p="pk"' + (f.pk ? ' checked' : '') + '>' + ICON.star + '</label></td>');
        h.push('<td><input class="mono expr" data-f="' + i + '" data-p="expr" value="' + attr(f.expr) + '" placeholder="o.user_id"></td>');
        fieldCols.forEach(function (col) {
          h.push('<td><input data-fx="' + i + '" data-x="' + attr(col.key) + '" value="' + attr(f[col.key] || '') + '" title="' + esc(col.label) + '"></td>');
        });
        h.push('<td>' + (badge.detail
          ? '<span class="lin-badge' + (badge.bad ? ' bad' : '') + '" title="' + attr(badge.detail) + '"><span class="arr">←</span>' + esc(badge.detail.length > 28 ? badge.detail.slice(0, 28) + '…' : badge.detail) + '</span>'
          : '<span class="dim small">—</span>') + '</td>');
        h.push('<td class="row-acts"><button class="icon-btn" data-act="up-f" data-i="' + i + '" title="上移">' + ICON.up + '</button><button class="icon-btn" data-act="down-f" data-i="' + i + '" title="下移">' + ICON.down + '</button><button class="icon-btn danger" data-act="del-f" data-i="' + i + '" title="删除">' + ICON.x + '</button></td>');
        h.push('</tr>');
      });
      h.push('</tbody></table></div>');
      h.push('</section>');
    }

    /* 源表映射 / 分区字段（oltp 项目不渲染） */
    if (!oltp) {
      h.push('<section class="card">');
      h.push('<div class="card-head"><h3>源表映射 <span class="count-badge">' + srcCount + '</span> <span class="card-sub">源表 → 当前模型</span></h3><div><button class="btn small" data-act="add-src">' + ICON.plus + '添加源表</button></div></div>');
      if (!srcCount) {
        h.push('<div class="card-body"><p class="hint">' + (m.layer === 'ods' ? 'ODS 层贴源表无需配置下游源表映射。' : '尚未配置源表。配置后可生成 ETL 语句并自动建立字段血缘。') + '</p></div>');
      } else {
        h.push('<div class="src-list">');
        (m.sources || []).forEach(function (s, i) {
          h.push('<div class="src-card">');
          h.push('<span class="src-ico">' + ICON.db + '</span>');
          h.push('<div class="src-main">');
          h.push('<select class="src-name" data-src="' + i + '" data-p="name"><option value="">-- 选择模型或外部表 --</option>' + models.map(function (x) {
            return '<option value="' + attr(x.name) + '"' + (s.name === x.name ? ' selected' : '') + '>' + esc(x.name + (x.cnName ? '（' + x.cnName + '）' : '')) + '</option>';
          }).join('') + '</select>');
          h.push('<input class="alias-input" data-src="' + i + '" data-p="alias" value="' + attr(s.alias) + '" placeholder="别名，如 o" title="表别名">');
          h.push('</div>');
          h.push('<input class="src-on mono" data-src="' + i + '" data-p="on" value="' + attr(s.on) + '" placeholder="' + (i === 0 ? '主表，无需关联条件' : 'a.id = b.aid') + '"' + (i === 0 ? ' disabled' : '') + ' title="关联条件 ON">');
          h.push('<button class="icon-btn danger" data-act="del-src" data-i="' + i + '" title="删除源表">' + ICON.x + '</button>');
          h.push('</div>');
        });
        h.push('</div>');
      }
      h.push('</section>');

      /* 分区字段 */
      h.push('<section class="card">');
      h.push('<div class="card-head"><h3>分区字段 <span class="count-badge">' + partCount + '</span></h3><div><button class="btn small" data-act="add-p">' + ICON.plus + '分区</button></div></div>');
      if (partCount) {
        h.push('<div class="tbl-wrap"><table class="tbl part-tbl"><thead><tr><th style="width:16%">分区名</th><th style="width:14%">类型</th><th style="width:26%">注释</th><th>取值表达式</th><th style="width:50px"></th></tr></thead><tbody>');
        (m.partition || []).forEach(function (pf, i) {
          h.push('<tr>');
          h.push('<td><input class="mono" data-pt="' + i + '" data-p="name" value="' + attr(pf.name) + '"></td>');
          h.push('<td><input class="mono" data-pt="' + i + '" data-p="type" value="' + attr(pf.type) + '"></td>');
          h.push('<td><input data-pt="' + i + '" data-p="comment" value="' + attr(pf.comment) + '"></td>');
          h.push('<td><input class="mono" data-pt="' + i + '" data-p="expr" value="' + attr(pf.expr) + '" placeholder="如 o.dt"></td>');
          h.push('<td class="center"><button class="icon-btn danger" data-act="del-p" data-i="' + i + '">' + ICON.x + '</button></td>');
          h.push('</tr>');
        });
        h.push('</tbody></table></div>');
      } else {
        h.push('<div class="card-body"><p class="hint">无分区字段（全量表）。</p></div>');
      }
      h.push('</section>');
    }

    /* 逻辑说明 */
    h.push('<section class="card">');
    h.push('<div class="card-head"><h3>逻辑说明 <span class="card-sub">清洗规则 / 口径定义</span></h3></div>');
    h.push('<div class="card-body"><label class="notes-label"><textarea id="m-notes" data-meta="notes" rows="3" placeholder="记录清洗规则、口径定义、上下游约定…">' + esc(m.notes) + '</textarea></label></div>');
    h.push('</section>');

    h.push('</div>'); /* edit-col */

    /* ---------------- 右栏洞察 ---------------- */
    TYPE_GROUPS.forEach(function (g) { g.n = 0; });
    fields.forEach(function (f) {
      var k = typeClass(f.type);
      var g = TYPE_GROUPS.filter(function (x) { return x.key === k; })[0];
      if (g) g.n++;
    });
    var activeGroups = TYPE_GROUPS.filter(function (g) { return g.n > 0; });

    h.push('<aside class="insight-col">');

    h.push('<section class="card insight">');
    h.push('<div class="card-head"><h3>字段类型分布</h3><div><span class="card-sub">' + fieldCount + ' 字段</span></div></div>');
    h.push('<div class="card-body"><div class="donut">');
    h.push('<div class="donut-ring">' + (fieldCount ? donutHTML(TYPE_GROUPS, fieldCount) : donutHTML([], 1)) + '<div class="donut-center"><b>' + fieldCount + '</b><span>字段</span></div></div>');
    h.push('<div class="legend2">' + (activeGroups.length ? activeGroups.map(function (g) {
      return '<div class="row"><i style="background:' + g.color + '"></i>' + g.label + '<small class="v">' + g.n + '</small></div>';
    }).join('') : '<div class="row dim">暂无字段</div>') + '</div>');
    h.push('</div></div></section>');

    if (oltp) {
      /* ---- 外键关系（fk 推导，替代血缘位置） ---- */
      var fkTargets = [];
      (m.fields || []).forEach(function (f) {
        if (!f.fk) return;
        var p = parseFkRef(f.fk);
        var hit = Store.findByName(p.entity);
        fkTargets.push({ field: f.name, name: p.entity, ok: !!hit, column: p.column });
      });
      var referrers = Store.getModels().filter(function (x) {
        return x.id !== m.id && (x.fields || []).some(function (f) {
          return f.fk && parseFkRef(f.fk).entity === m.name;
        });
      });
      var fkAllOk = fkTargets.every(function (t) { return t.ok; });
      h.push('<section class="card">');
      h.push('<div class="card-head"><h3>外键关系 <span class="count-badge">' + fkCount + '</span></h3><div></div></div>');
      h.push('<div class="card-body" style="padding:12px 12px 14px"><div class="linmap">');
      h.push('<div class="lgroup">' + (fkTargets.length ? fkTargets.slice(0, 3).map(function (t) {
        return '<span class="lnode' + (t.ok ? '' : ' bad') + '" title="' + esc(t.field + ' → ' + t.name + '.' + t.column) + '"><i class="dim"></i><span>' + esc(t.name || '?') + '</span></span>';
      }).join('') : '<span class="lin-empty">无被引用实体</span>') + (fkTargets.length > 3 ? '<span class="lin-empty">+' + (fkTargets.length - 3) + '</span>' : '') + '</div>');
      h.push('<div class="connect"></div>');
      h.push('<span class="lnode cur">' + esc(m.name || '未命名') + '</span>');
      h.push('<div class="connect"></div>');
      h.push('<div class="lgroup">' + (referrers.length ? referrers.slice(0, 2).map(function (x) { return '<span class="lnode"><i class="dwd"></i><span>' + esc(x.name) + '</span></span>'; }).join('') : '<span class="lin-empty">暂无引用本实体的实体</span>') + (referrers.length > 2 ? '<span class="lin-empty">+' + (referrers.length - 2) + '</span>' : '') + '</div>');
      h.push('</div>');
      if (!fkAllOk) h.push('<p class="hint small" style="margin-top:8px">⚠ 存在未解析的外键引用（红色标记），详见 ER 模型图告警</p>');
      h.push('</div></section>');
    } else {
      /* 血缘位置 */
      var upNodes = (m.sources || []).map(function (s) { return s.name; }).filter(Boolean);
      var downModels = Store.getModels().filter(function (x) {
        return x.id !== m.id && (x.sources || []).some(function (s) { return s.name === m.name; });
      });
      function layerOf(name) {
        if (name === m.name) return m.layer;
        var hit = Store.getModels().filter(function (x) { return x.name === name; })[0];
        return hit ? hit.layer : 'ods';
      }
      function nodeHTML(name) {
        return '<span class="lnode"><i class="' + layerOf(name) + '"></i><span>' + esc(name) + '</span></span>';
      }
      h.push('<section class="card">');
      h.push('<div class="card-head"><h3>血缘位置</h3><div></div></div>');
      h.push('<div class="card-body" style="padding:12px 12px 14px"><div class="linmap">');
      h.push('<div class="lgroup">' + (upNodes.length ? upNodes.slice(0, 3).map(nodeHTML).join('') : '<span class="lin-empty">无上游源表</span>') + '</div>');
      h.push('<div class="connect"></div>');
      h.push('<span class="lnode cur">' + esc(m.name || '未命名') + '</span>');
      h.push('<div class="connect"></div>');
      h.push('<div class="lgroup">' + (downModels.length ? downModels.slice(0, 2).map(function (x) { return nodeHTML(x.name); }).join('') : '<span class="lin-empty">暂无下游模型</span>') + '</div>');
      h.push('</div></div></section>');
    }

    /* 规范校验 */
    var noComment = fields.filter(function (f) { return !f.comment; }).length;
    var nameOk = /^[a-z][a-z0-9_]*$/.test(m.name || '');
    var checks;
    if (oltp) {
      var badFk = fkTargets.filter(function (t) { return !t.ok; }).length;
      var fieldNames = fields.map(function (f) { return f.name; }).filter(Boolean);
      var badIdx = (m.indexes || []).filter(function (ix) {
        return (ix.fields || []).some(function (fn) { return fieldNames.indexOf(fn) < 0; });
      }).length;
      checks = [
        { ok: pkCount > 0, t: pkCount > 0 ? '主键已定义' : '缺少主键', v: String(pkCount) },
        { ok: nameOk, t: nameOk ? '命名符合规范' : '命名需小写+下划线', v: nameOk ? 'ok' : 'warn' },
        { ok: noComment === 0, t: noComment ? noComment + ' 个字段缺少注释' : '字段注释完整', v: noComment ? 'warn' : 'ok' },
        { ok: badFk === 0, t: badFk ? badFk + ' 个外键引用的实体不存在' : '外键引用完整', v: badFk ? 'warn' : String(fkCount) }
      ];
      if (badIdx) checks.push({ ok: false, t: badIdx + ' 个索引引用了不存在的字段', v: 'warn' });
    } else {
      checks = [
        { ok: pkCount > 0, t: pkCount > 0 ? '主键已定义' : '缺少主键', v: String(pkCount) },
        { ok: nameOk, t: nameOk ? '命名符合规范' : '命名需小写+下划线', v: nameOk ? 'ok' : 'warn' },
        { ok: noComment === 0, t: noComment ? noComment + ' 个字段缺少注释' : '字段注释完整', v: noComment ? 'warn' : 'ok' }
      ];
      if (m.layer !== 'ods') checks.push({ ok: srcCount > 0, t: srcCount ? '已配置源表' : '未配置源表', v: srcCount ? 'ok' : 'warn' });
    }

    h.push('<section class="card">');
    h.push('<div class="card-head"><h3>规范校验 <span class="count-badge">' + checks.filter(function (c) { return !c.ok; }).length + '</span></h3><div><button class="btn small ghost" data-act="open-check">查看</button></div></div>');
    h.push('<div class="card-body"><div class="checks">');
    checks.forEach(function (c) {
      h.push('<div class="chk ' + (c.ok ? 'ok' : 'warn') + '"><span class="ci">' + (c.ok
        ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 8.4l3 3 6-6.4"/></svg>'
        : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.2v6M8 12.4v.2"/></svg>') + '</span>' + c.t + '<span class="st">' + c.v + '</span></div>');
    });
    h.push('</div></div></section>');

    h.push('</aside>');
    h.push('</div>'); /* edit-grid */
    h.push('</div>'); /* editor */

    pane.innerHTML = h.join('');

    // ---- 事件绑定（委托，先清理上一次的绑定，避免重复触发） ----
    if (pane._cleanup) pane._cleanup();
    pane.addEventListener('input', onInput);
    pane.addEventListener('change', onChange);
    pane.addEventListener('click', onClick);
    pane._cleanup = function () {
      pane.removeEventListener('input', onInput);
      pane.removeEventListener('change', onChange);
      pane.removeEventListener('click', onClick);
    };
  }

  var sidebarTimer = null;

  function getModel() { return Store.find(Store.selectedId); }

  function onInput(e) {
    var t = e.target;
    var m = getModel();
    if (!m) return;
    if (t.id === 'm-name' || t.id === 'm-cn' || (t.dataset && t.dataset.meta)) {
      var key = t.dataset ? t.dataset.meta : null;
      if (key) {
        var realKey = key.indexOf('x:') === 0 ? key.slice(2) : key; // x:<key> = 自定义表列
        m[realKey] = t.value; Store.autosave();
      }
      if (t.id === 'm-name' || t.id === 'm-cn') {
        clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(function () { App.renderSidebar(); }, 500);
      }
      return;
    }
    var fi = t.dataset ? t.dataset.f : undefined;
    if (fi !== undefined && t.dataset.p) {
      if (t.dataset.p === 'fkEntity' || t.dataset.p === 'fkCol') return; // FK 两级下拉在 change 里统一处理（select 也会冒泡 input）
      if (t.dataset.p === 'default') {
        // 缺省值：空串省键（保持 JSON 干净），有值才写
        if (t.value === '') delete m.fields[+fi].default;
        else m.fields[+fi].default = t.value;
      } else {
        m.fields[+fi][t.dataset.p] = t.value;
      }
      Store.autosave(); return;
    }
    var ix = t.dataset ? t.dataset.ix : undefined; // 索引行
    if (ix !== undefined && t.dataset.p) {
      if (!m.indexes) m.indexes = [];
      m.indexes[+ix][t.dataset.p] = t.value; Store.autosave(); return;
    }
    var fx = t.dataset ? t.dataset.fx : undefined;
    if (fx !== undefined && t.dataset.x) { m.fields[+fx][t.dataset.x] = t.value; Store.autosave(); return; } // 自定义字段列
    var pi = t.dataset ? t.dataset.pt : undefined;
    if (pi !== undefined && t.dataset.p) { m.partition[+pi][t.dataset.p] = t.value; Store.autosave(); return; }
    var si = t.dataset ? t.dataset.src : undefined;
    if (si !== undefined && t.dataset.p) { m.sources[+si][t.dataset.p] = t.value; Store.autosave(); return; }
  }

  function onChange(e) {
    var t = e.target;
    var m = getModel();
    if (!m) return;
    if (t.id === 'm-layer') {
      m.layer = t.value;
      Store.touch();
      Store.flushSave().catch(function () { }); // 分层变更立即落库
      return;
    }
    if (t.id === 'm-catalog') {
      if (t.value) m.catalogId = t.value;
      else delete m.catalogId; // 空 = 未归类，不保留该键
      Store.touch(); // 重渲染侧栏/目录树分组（select 无输入焦点问题）
      // 业务域绑定是显式选择，不等防抖，立刻写入服务端，避免刷新回退
      Store.flushSave().catch(function () { });
      return;
    }
    var fi = t.dataset ? t.dataset.f : undefined;
    if (fi !== undefined && t.dataset.p === 'pk') {
      m.fields[+fi].pk = t.checked;
      if (t.checked) m.fields[+fi].nullable = false; // PK 隐含 NOT NULL
      var label = t.closest('.pk-btn');
      if (label) label.classList.toggle('on', t.checked);
      Store.autosave();
      render(); // 统计卡 / 校验 / 可空禁用态需要跟随主键变化
      return;
    }
    if (fi !== undefined && t.dataset.p === 'nullable') {
      if (t.checked) delete m.fields[+fi].nullable; // 缺省可空（省键）
      else m.fields[+fi].nullable = false;
      Store.autosave();
      return;
    }
    if (fi !== undefined && t.dataset.p === 'unique') {
      if (t.checked) m.fields[+fi].unique = true;
      else delete m.fields[+fi].unique; // 省键
      Store.autosave();
      render(); // 基数标记/统计需要跟随（ER 图在页签切换时重渲染）
      return;
    }
    if (fi !== undefined && t.dataset.p === 'fkEntity') {
      // FK 第一级：选择/切换引用实体（无 → 清除 fk）
      if (!t.value) delete m.fields[+fi].fk;
      else {
        var target = Store.findByName(t.value);
        var firstCol = target && target.fields && target.fields.length ? (target.fields[0].name || '') : '';
        m.fields[+fi].fk = firstCol ? (t.value + '.' + firstCol) : t.value;
      }
      Store.touch(); // 重渲染第二级下拉选项
      return;
    }
    if (fi !== undefined && t.dataset.p === 'fkCol') {
      // FK 第二级：选择引用字段
      var p = parseFkRef(m.fields[+fi].fk);
      if (p.entity && t.value) m.fields[+fi].fk = p.entity + '.' + t.value;
      Store.touch();
      return;
    }
    var ix = t.dataset ? t.dataset.ix : undefined; // 索引行唯一勾选
    if (ix !== undefined && t.dataset.p === 'unique') {
      if (!m.indexes) m.indexes = [];
      m.indexes[+ix].unique = !!t.checked;
      Store.autosave();
      return;
    }
    if (fi !== undefined && t.dataset.p === 'expr') { render(); return; } // 表达式变更后刷新血缘徽标
    if (fi !== undefined && t.dataset.p === 'name') { render(); return; }
    var si = t.dataset ? t.dataset.src : undefined;
    if (si !== undefined && t.dataset.p === 'name') {
      m.sources[+si].name = t.value;
      if (!m.sources[+si].alias) m.sources[+si].alias = (t.value || '').split('.').pop();
      Store.touch(); return;
    }
  }

  function onClick(e) {
    var btn = e.target.closest('button');
    if (!btn || !btn.dataset.act) return;
    var act = btn.dataset.act;
    if (act === 'toggle-meta') {
      var more = document.getElementById('meta-more');
      if (more) more.hidden = !more.hidden;
      return;
    }
    if (act === 'hero-lineage') { if (root.App) root.App.switchTab('lineage'); return; }
    if (act === 'hero-sql') { if (root.App) root.App.switchTab('sql'); return; }
    if (act === 'open-check') { if (root.Dialogs && root.Dialogs.openCheck) root.Dialogs.openCheck(); return; }

    var m = getModel();
    if (!m) return;
    var i = +btn.dataset.i;
    if (act === 'manage-cols') { Dialogs.manageCols(btn.dataset.scope); return; }
    if (act === 'add-f') { m.fields.push({ name: '', type: Store.isOLTP() ? 'varchar(64)' : 'string', comment: '', pk: false, expr: '' }); Store.touch(); }
    else if (act === 'del-f') {
      m.fields.splice(i, 1);
      Store.touch();
    }
    else if (act === 'up-f' && i > 0) { var a = m.fields.splice(i, 1)[0]; m.fields.splice(i - 1, 0, a); Store.touch(); }
    else if (act === 'down-f' && i < m.fields.length - 1) { var b = m.fields.splice(i, 1)[0]; m.fields.splice(i + 1, 0, b); Store.touch(); }
    else if (act === 'add-p') { m.partition.push({ name: '', type: 'string', comment: '', expr: '' }); Store.touch(); }
    else if (act === 'del-p') { m.partition.splice(i, 1); Store.touch(); }
    else if (act === 'add-src') { m.sources.push({ name: '', alias: '', on: '' }); Store.touch(); }
    else if (act === 'del-src') { m.sources.splice(i, 1); Store.touch(); }
    else if (act === 'add-idx') {
      if (!m.indexes) m.indexes = [];
      m.indexes.push({ name: '', fields: [], unique: false });
      Store.touch();
    }
    else if (act === 'del-idx') { m.indexes.splice(i, 1); Store.touch(); }
    else if (act === 'idx-toggle') {
      var ix = +btn.dataset.ix;
      if (!m.indexes) m.indexes = [];
      if (!m.indexes[ix].fields) m.indexes[ix].fields = [];
      var arr = m.indexes[ix].fields;
      var at = arr.indexOf(btn.dataset.field);
      if (at >= 0) arr.splice(at, 1);
      else arr.push(btn.dataset.field); // 按点击顺序（复合索引字段顺序有意义）
      Store.touch(); // 重渲染 chips 选中态与序号
    }
  }

  root.Editor = { render: render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
