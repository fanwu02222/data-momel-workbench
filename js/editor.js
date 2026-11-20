/**
 * 模型编辑器：元信息、字段表、分区、源表映射、业务逻辑
 * 通过事件委托更新 Store，输入不触发全量重渲染（保持焦点）
 */
(function (root) {
  'use strict';
  var Store = root.Store, Lineage = root.Lineage;
  var TYPE_OPTIONS = ['string', 'varchar(64)', 'varchar(255)', 'text', 'int', 'bigint', 'smallint', 'tinyint', 'decimal(16,2)', 'decimal(18,2)', 'double', 'float', 'boolean', 'date', 'datetime', 'timestamp', 'json', 'array<string>', 'map<string,string>'];

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function attr(s) { return esc(s); }

  function render() {
    var pane = document.getElementById('pane-model');
    var m = Store.find(Store.selectedId);
    if (!m) {
      pane.innerHTML = '<div class="empty-state"><div class="empty-icon">🗂️</div><p>从左侧选择一个模型，或新建一个模型开始设计</p><button class="btn primary" onclick="Store.newModel(\'dwd\');App.refresh()">＋ 新建模型</button></div>';
      return;
    }
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

    var h = [];
    h.push('<div class="editor">');
    // ---- 元信息 ----
    h.push('<div class="card meta-card">');
    h.push('<div class="card-head"><h3>表信息</h3><button class="btn small" data-act="manage-cols" data-scope="model" title="为表元信息增加自定义属性列">⌗ 自定义列</button></div>');
    h.push('<div class="form-grid">');
    h.push('<label>所属层<select id="m-layer">' + ['ods', 'dim', 'dwd', 'dws', 'ads'].map(function (ly) {
      return '<option value="' + ly + '"' + (m.layer === ly ? ' selected' : '') + '>' + ly.toUpperCase() + '</option>';
    }).join('') + '</select></label>');
    h.push('<label>表名<input id="m-name" class="mono" data-meta="name" value="' + attr(m.name) + '" placeholder="如 dwd_order_info_di"></label>');
    h.push('<label>中文名<input id="m-cn" data-meta="cnName" value="' + attr(m.cnName) + '" placeholder="如 订单明细事实表"></label>');
    h.push('<label class="span2">描述<input id="m-desc" data-meta="desc" value="' + attr(m.desc) + '"></label>');
    h.push('<label class="' + (m.layer === 'ods' ? '' : 'dim') + '">' + (m.layer === 'ods' ? '源系统（ODS 贴源）' : '源系统（仅 ODS 层有效）') + '<input id="m-source" data-meta="source" value="' + attr(m.source) + '" placeholder="mysql://host/db/table"></label>');
    h.push('<label>过滤条件 WHERE<input id="m-where" class="mono" data-meta="where" value="' + attr(m.where) + '" placeholder="如 o.status in (...)"></label>');
    h.push('<label>分组 GROUP BY<input id="m-group" class="mono" data-meta="groupBy" value="' + attr(m.groupBy) + '" placeholder="如 o.shop_id, o.dt"></label>');
    modelCols.forEach(function (col) {
      h.push('<label>' + esc(col.label) + '<input data-meta="x:' + attr(col.key) + '" value="' + attr(m[col.key] || '') + '" placeholder="' + esc(col.label) + '"></label>');
    });
    h.push('</div>');
    h.push('<label class="notes-label">逻辑说明（清洗规则 / 口径定义）<textarea id="m-notes" data-meta="notes" rows="2">' + esc(m.notes) + '</textarea></label>');
    h.push('</div>');

    // ---- 源表映射 ----
    h.push('<div class="card">');
    h.push('<div class="card-head"><h3>源表映射（表级血缘）</h3><button class="btn small" data-act="add-src">＋ 添加源表</button></div>');
    if (!(m.sources || []).length) {
      h.push('<p class="hint">' + (m.layer === 'ods' ? 'ODS 层贴源表无需配置下游源表映射。' : '尚未配置源表。配置后可生成 ETL 语句并自动建立字段血缘。') + '</p>');
    } else {
      h.push('<table class="tbl src-tbl"><thead><tr><th style="width:36%">源模型</th><th style="width:16%">别名</th><th>关联条件 ON（第一个源表无需）</th><th style="width:50px"></th></tr></thead><tbody>');
      (m.sources || []).forEach(function (s, i) {
        h.push('<tr>');
        h.push('<td><select data-src="' + i + '" data-p="name"><option value="">-- 选择模型或外部表 --</option>' + models.map(function (x) {
          return '<option value="' + attr(x.name) + '"' + (s.name === x.name ? ' selected' : '') + '>' + esc(x.layer.toUpperCase() + ' · ' + x.name + (x.cnName ? '（' + x.cnName + '）' : '')) + '</option>';
        }).join('') + '</select></td>');
        h.push('<td><input class="mono" data-src="' + i + '" data-p="alias" value="' + attr(s.alias) + '" placeholder="别名"></td>');
        h.push('<td><input class="mono" data-src="' + i + '" data-p="on" value="' + attr(s.on) + '" placeholder="' + (i === 0 ? '—' : 'a.id = b.aid') + '"' + (i === 0 ? ' disabled' : '') + '></td>');
        h.push('<td class="center"><button class="icon-btn danger" data-act="del-src" data-i="' + i + '" title="删除">✕</button></td>');
        h.push('</tr>');
      });
      h.push('</tbody></table>');
    }
    h.push('</div>');

    // ---- 字段 ----
    h.push('<div class="card">');
    h.push('<div class="card-head"><h3>字段定义 <span class="count-badge">' + (m.fields || []).length + '</span></h3><div><button class="btn small" data-act="manage-cols" data-scope="field" title="为字段表格增加自定义列">⌗ 自定义列</button> <button class="btn small" data-act="add-f">＋ 字段</button></div></div>');
    h.push('<datalist id="type-list">' + TYPE_OPTIONS.map(function (t) { return '<option value="' + t + '">'; }).join('') + '</datalist>');
    h.push('<table class="tbl field-tbl"><thead><tr><th style="width:34px">#</th><th style="width:15%">字段名</th><th style="width:13%">类型</th><th style="width:18%">注释</th><th style="width:40px">PK</th><th>业务逻辑 / 表达式（引用源表别名.字段）</th>' +
      fieldCols.map(function (col) { return '<th>' + esc(col.label) + '</th>'; }).join('') +
      '<th style="width:120px">血缘来源</th><th style="width:84px"></th></tr></thead><tbody>');
    (m.fields || []).forEach(function (f, i) {
      var badge = badgeByField[f.name] || { ok: 0, bad: 0, detail: '' };
      h.push('<tr data-row="' + i + '">');
      h.push('<td class="center dim">' + (i + 1) + '</td>');
      h.push('<td><input class="mono" data-f="' + i + '" data-p="name" value="' + attr(f.name) + '" placeholder="field_name"></td>');
      h.push('<td><input class="mono" data-f="' + i + '" data-p="type" value="' + attr(f.type) + '" list="type-list"></td>');
      h.push('<td><input data-f="' + i + '" data-p="comment" value="' + attr(f.comment) + '" placeholder="中文注释"></td>');
      h.push('<td class="center"><input type="checkbox" data-f="' + i + '" data-p="pk"' + (f.pk ? ' checked' : '') + '></td>');
      h.push('<td><input class="mono expr" data-f="' + i + '" data-p="expr" value="' + attr(f.expr) + '" placeholder="如 o.user_id 或 sum(de.amount)"></td>');
      fieldCols.forEach(function (col) {
        h.push('<td><input data-fx="' + i + '" data-x="' + attr(col.key) + '" value="' + attr(f[col.key] || '') + '" title="' + esc(col.label) + '"></td>');
      });
      h.push('<td class="lin-cell">' + (badge.detail
        ? '<span class="lin-badge' + (badge.bad ? ' bad' : '') + '" title="' + attr(badge.detail) + '">' + (badge.bad ? '⚠ ' : '') + esc(badge.detail.length > 26 ? badge.detail.slice(0, 26) + '…' : badge.detail) + '</span>'
        : '<span class="dim">—</span>') + '</td>');
      h.push('<td class="center row-acts"><button class="icon-btn" data-act="up-f" data-i="' + i + '" title="上移">↑</button><button class="icon-btn" data-act="down-f" data-i="' + i + '" title="下移">↓</button><button class="icon-btn danger" data-act="del-f" data-i="' + i + '" title="删除">✕</button></td>');
      h.push('</tr>');
    });
    h.push('</tbody></table>');
    h.push('</div>');

    // ---- 分区 ----
    h.push('<div class="card">');
    h.push('<div class="card-head"><h3>分区字段 <span class="count-badge">' + (m.partition || []).length + '</span></h3><button class="btn small" data-act="add-p">＋ 分区</button></div>');
    if ((m.partition || []).length) {
      h.push('<table class="tbl part-tbl"><thead><tr><th style="width:15%">分区名</th><th style="width:13%">类型</th><th style="width:24%">注释</th><th>取值表达式</th><th style="width:50px"></th></tr></thead><tbody>');
      (m.partition || []).forEach(function (pf, i) {
        h.push('<tr>');
        h.push('<td><input class="mono" data-pt="' + i + '" data-p="name" value="' + attr(pf.name) + '"></td>');
        h.push('<td><input class="mono" data-pt="' + i + '" data-p="type" value="' + attr(pf.type) + '"></td>');
        h.push('<td><input data-pt="' + i + '" data-p="comment" value="' + attr(pf.comment) + '"></td>');
        h.push('<td><input class="mono" data-pt="' + i + '" data-p="expr" value="' + attr(pf.expr) + '" placeholder="如 o.dt"></td>');
        h.push('<td class="center"><button class="icon-btn danger" data-act="del-p" data-i="' + i + '">✕</button></td>');
        h.push('</tr>');
      });
      h.push('</tbody></table>');
    } else {
      h.push('<p class="hint">无分区字段（全量表）。</p>');
    }
    h.push('</div>');
    h.push('</div>');

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
    if (fi !== undefined && t.dataset.p) { m.fields[+fi][t.dataset.p] = t.value; Store.autosave(); return; }
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
    if (t.id === 'm-layer') { m.layer = t.value; Store.touch(); return; }
    var fi = t.dataset ? t.dataset.f : undefined;
    if (fi !== undefined && t.dataset.p === 'pk') { m.fields[+fi].pk = t.checked; Store.autosave(); return; }
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
    var m = getModel();
    if (!m) return;
    var act = btn.dataset.act, i = +btn.dataset.i;
    if (act === 'manage-cols') { Dialogs.manageCols(btn.dataset.scope); return; }
    if (act === 'add-f') { m.fields.push({ name: '', type: 'string', comment: '', pk: false, expr: '' }); Store.touch(); }
    else if (act === 'del-f') { m.fields.splice(i, 1); Store.touch(); }
    else if (act === 'up-f' && i > 0) { var a = m.fields.splice(i, 1)[0]; m.fields.splice(i - 1, 0, a); Store.touch(); }
    else if (act === 'down-f' && i < m.fields.length - 1) { var b = m.fields.splice(i, 1)[0]; m.fields.splice(i + 1, 0, b); Store.touch(); }
    else if (act === 'add-p') { m.partition.push({ name: '', type: 'string', comment: '', expr: '' }); Store.touch(); }
    else if (act === 'del-p') { m.partition.splice(i, 1); Store.touch(); }
    else if (act === 'add-src') { m.sources.push({ name: '', alias: '', on: '' }); Store.touch(); }
    else if (act === 'del-src') { m.sources.splice(i, 1); Store.touch(); }
  }

  root.Editor = { render: render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
