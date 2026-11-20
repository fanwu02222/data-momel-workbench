/**
 * 应用入口：布局渲染、侧栏分层导航、页签切换、SQL 预览、顶栏动作
 */
(function (root) {
  'use strict';
  var Store = root.Store, Editor = root.Editor, Dialogs = root.Dialogs, Lineage = root.Lineage, SQLGen = root.SQLGen;

  var LAYERS = [
    { key: 'ods', title: 'ODS · 原始数据层', desc: '贴源表，与源系统一致' },
    { key: 'dim', title: 'DIM · 维度层', desc: '一致性维度，支撑明细与分析' },
    { key: 'dwd', title: 'DWD · 明细数据层', desc: '清洗/标准化后的明细事实' },
    { key: 'dws', title: 'DWS · 汇总数据层', desc: '轻度聚合，公共粒度汇总' },
    { key: 'ads', title: 'ADS · 应用数据层', desc: '面向报表与应用的结果表' }
  ];
  var currentTab = 'model';
  var lineageMode = 'field'; // field | global

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---------- 侧栏 ----------
  function renderSidebar() {
    var box = document.getElementById('layer-groups');
    var models = Store.getModels();
    var h = [];
    LAYERS.forEach(function (ly) {
      var ms = models.filter(function (m) { return m.layer === ly.key; });
      h.push('<div class="layer-group" data-layer="' + ly.key + '">');
      h.push('<div class="layer-head"><span class="layer-dot ' + ly.key + '"></span><span class="layer-title">' + ly.title + '</span><span class="layer-count">' + ms.length + '</span></div>');
      h.push('<div class="layer-desc">' + ly.desc + '</div>');
      h.push('<div class="layer-models">');
      if (!ms.length) h.push('<div class="layer-empty">暂无模型</div>');
      ms.forEach(function (m) {
        var sel = m.id === Store.selectedId ? ' selected' : '';
        h.push('<div class="model-item' + sel + '" data-id="' + m.id + '">');
        h.push('<div class="model-item-main"><span class="model-name mono">' + esc(m.name || '（未命名）') + '</span>' + (m.cnName ? '<span class="model-cn">' + esc(m.cnName) + '</span>' : '') + '</div>');
        h.push('<div class="model-item-meta"><span>' + ((m.fields || []).length) + ' 字段</span>' + ((m.sources || []).length ? '<span>← ' + (m.sources || []).length + ' 源</span>' : '') + '</div>');
        h.push('<span class="model-acts"><button class="icon-btn" data-act="dup" data-id="' + m.id + '" title="复制模型">⧉</button><button class="icon-btn danger" data-act="del" data-id="' + m.id + '" title="删除">✕</button></span>');
        h.push('</div>');
      });
      h.push('</div></div>');
    });
    box.innerHTML = h.join('');
  }

  // ---------- 顶栏状态 ----------
  function renderStatus(source) {
    var elx = document.getElementById('save-status');
    if (!elx) return;
    if (Store.serverOnline) elx.innerHTML = '<span class="dot ok"></span>已连接本地服务（SQLite）';
    else elx.innerHTML = '<span class="dot warn"></span>本地模式（浏览器存储）';
  }

  // ---------- SQL 预览 ----------
  function highlightSQL(sql) {
    var stashArr = [];
    function stash(m) { stashArr.push(m); return '\u0000X' + (stashArr.length - 1) + 'X\u0000'; }
    var html = esc(sql);
    html = html.replace(/--[^\n]*/g, stash);       // 注释先保护
    html = html.replace(/'[^'\n]*'/g, stash);      // 字符串先保护
    html = html.replace(/\b(SELECT|FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|INSERT|OVERWRITE|INTO|CREATE|TABLE|IF|NOT|EXISTS|PARTITION|PARTITIONED|BY|AS|COMMENT|STORED|ORC|LEFT|RIGHT|FULL|INNER|OUTER|CROSS|JOIN|ON|AND|OR|CASE|WHEN|THEN|ELSE|END|DISTINCT|COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|NULL|IS|IN|LIKE|BETWEEN|UNION|ALL|VALUES|ENGINE|MERGETREE|PRIMARY|KEY)\b/gi, '<span class="k">$1</span>');
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="n">$1</span>');
    html = html.replace(/\u0000X(\d+)X\u0000/g, function (m, i) {
      var s = stashArr[+i];
      var cls = s.charAt(0) === '-' ? 'c' : 's';
      return '<span class="' + cls + '">' + s + '</span>';
    });
    return html;
  }

  function renderSQLPane() {
    var pane = document.getElementById('pane-sql');
    var m = Store.find(Store.selectedId);
    var h = [];
    h.push('<div class="sql-toolbar">');
    h.push('<label>范围 <select id="sql-scope"><option value="all">全部模型（按依赖排序）</option><option value="one"' + (m ? '' : ' disabled') + '>当前模型' + (m ? '：' + esc(m.name) : '（未选择）') + '</option></select></label>');
    h.push('<label>内容 <select id="sql-parts"><option value="both">DDL + DML</option><option value="ddl">仅建表 DDL</option><option value="dml">仅 ETL DML</option></select></label>');
    h.push('<label>方言 <select id="sql-dialect">');
    ['hive', 'mysql', 'clickhouse', 'postgresql'].forEach(function (d) {
      h.push('<option value="' + d + '"' + (Store.project.dialect === d ? ' selected' : '') + '>' + SQLGen.dialectName(d) + '</option>');
    });
    h.push('</select></label>');
    h.push('<button class="btn primary" id="btn-do-gen">⚙ 生成 SQL</button>');
    h.push('<button class="btn" id="btn-tpl" title="编辑 SQL 生成模板">⌗ 模版</button>');
    h.push('<button class="btn" id="btn-copy-sql">复制</button>');
    h.push('<button class="btn" id="btn-dl-sql">下载 .sql</button>');
    h.push('</div>');
    h.push('<div class="sql-output-wrap"><pre id="sql-output" class="mono sql-output"><span class="hint-line">点击「生成 SQL」查看脚本…</span></pre></div>');
    pane.innerHTML = h.join('');
    document.getElementById('btn-do-gen').onclick = function () { genSQL(); };
    document.getElementById('btn-tpl').onclick = function () { Dialogs.openTemplateEditor(); };
    document.getElementById('btn-copy-sql').onclick = function () {
      var pre = document.getElementById('sql-output');
      var text = pre.textContent;
      if (text.indexOf('点击「生成 SQL」') === 0) { Dialogs.toast('请先生成 SQL', true); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { Dialogs.toast('已复制到剪贴板'); });
      else { Dialogs.toast('请手动选择复制', true); }
    };
    document.getElementById('btn-dl-sql').onclick = function () {
      var pre = document.getElementById('sql-output');
      var text = pre.textContent;
      if (text.indexOf('点击「生成 SQL」') === 0) { Dialogs.toast('请先生成 SQL', true); return; }
      var blob = new Blob([text], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'warehouse_' + (Store.project.dialect || 'hive') + '_' + new Date().toISOString().slice(0, 10) + '.sql';
      a.click(); URL.revokeObjectURL(a.href);
    };
  }

  function genSQL() {
    var scope = document.getElementById('sql-scope').value;
    var parts = document.getElementById('sql-parts').value;
    var dialect = document.getElementById('sql-dialect').value;
    Store.project.dialect = dialect; Store.autosave();
    var opts = { dialect: dialect, parts: parts };
    if (scope === 'one') opts.modelId = Store.selectedId;
    var sql = SQLGen.genScript(Store.project, opts);
    var pre = document.getElementById('sql-output');
    pre.innerHTML = highlightSQL(sql);
  }

  // ---------- 血缘页 ----------
  function renderLineagePane() {
    var pane = document.getElementById('pane-lineage');
    var m = Store.find(Store.selectedId);
    var h = [];
    h.push('<div class="lin-toolbar">');
    h.push('<div class="seg">');
    h.push('<button class="seg-btn' + (lineageMode === 'field' ? ' active' : '') + '" data-mode="field">字段级血缘（当前模型）</button>');
    h.push('<button class="seg-btn' + (lineageMode === 'global' ? ' active' : '') + '" data-mode="global">全局模型血缘</button>');
    h.push('</div>');
    h.push('<div class="lin-tools"><span class="hint">拖动平移 · 滚轮缩放 · 悬停字段名高亮</span><button class="btn small" id="btn-lin-reset">重置视图</button></div>');
    h.push('</div>');
    h.push('<div class="lin-canvas-wrap"><div id="lin-canvas" class="lin-canvas"></div></div>');
    h.push('<div id="lin-warnings" class="lin-warnings"></div>');
    pane.innerHTML = h.join('');

    pane.querySelectorAll('.seg-btn').forEach(function (b) {
      b.onclick = function () { lineageMode = b.dataset.mode; renderLineagePane(); };
    });
    var canvas = document.getElementById('lin-canvas');
    var warnBox = document.getElementById('lin-warnings');
    document.getElementById('btn-lin-reset').onclick = function () {
      var svg = canvas.querySelector('svg');
      if (svg && svg._resetView) svg._resetView();
    };
    if (lineageMode === 'field') {
      if (!m) {
        canvas.innerHTML = '<div class="empty-state small"><p>请先选择一个模型</p></div>';
        return;
      }
      var lin = Lineage.computeFieldLineage(Store.project, m);
      var r = Lineage.renderFieldLineage(canvas, lin);
      warnBox.innerHTML = (r.warnings || []).length
        ? '<div class="warn-box">⚠ ' + r.warnings.map(esc).join('<br>⚠ ') + '</div>'
        : '<div class="ok-box">✅ 字段血缘解析完整，无未解析引用</div>';
    } else {
      var graph = Lineage.computeModelLineage(Store.project);
      Lineage.renderModelLineage(canvas, graph, function (id) {
        Store.selectedId = id;
        lineageMode = 'field';
        refresh();
      });
      warnBox.innerHTML = '<div class="ok-box">共 ' + graph.nodes.length + ' 个模型、' + graph.edges.length + ' 条表级血缘（点击模型可查看其字段级血缘）</div>';
    }
  }

  // ---------- 页签 ----------
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    ['model', 'lineage', 'sql'].forEach(function (t) {
      document.getElementById('pane-' + t).style.display = t === tab ? '' : 'none';
    });
    if (tab === 'model') Editor.render();
    if (tab === 'lineage') renderLineagePane();
    if (tab === 'sql') renderSQLPane();
  }

  // ---------- 刷新 ----------
  function refresh() {
    document.getElementById('project-name').value = Store.project.name || '';
    document.getElementById('dialect').value = Store.project.dialect || 'hive';
    renderSidebar();
    renderStatus();
    switchTab(currentTab);
  }

  // ---------- 主题 ----------
  var THEME_KEY = 'dw-workbench-theme';
  function initTheme() {
    var btn = document.getElementById('btn-theme');
    function apply(t) {
      document.documentElement.setAttribute('data-theme', t);
      btn.title = t === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
    }
    apply(document.documentElement.getAttribute('data-theme') || 'light');
    btn.onclick = function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { }
      apply(next);
    };
  }

  // ---------- 初始化 ----------
  function init() {
    initTheme();
    // 数据变更 → 即时重渲染（增删字段/模型、切层、导入等操作立即生效）
    Store.onChange(function () {
      renderSidebar();
      renderStatus();
      if (currentTab === 'model') Editor.render();
      else if (currentTab === 'lineage') renderLineagePane();
    });

    // 顶栏
    document.getElementById('btn-new-model').onclick = function () {
      Dialogs.openModal('新建模型', (function () {
        var wrap = document.createElement('div');
        wrap.innerHTML =
          '<div class="form-grid">' +
          '<label>初始分层<select id="nm-layer">' + LAYERS.map(function (l) { return '<option value="' + l.key + '">' + l.title + '</option>'; }).join('') + '</select></label>' +
          '<label>表名（可留空稍后填写）<input id="nm-name" class="mono" placeholder="如 dwd_order_info_di"></label>' +
          '</div>';
        return wrap;
      })(), [
        {
          label: '创建', cls: 'primary', onClick: function () {
            var layer = document.getElementById('nm-layer').value;
            var name = document.getElementById('nm-name').value.trim();
            var m = Store.newModel(layer);
            if (name) m.name = name;
            Store.touch();
            Dialogs.closeModal();
            refresh();
          }
        }
      ]);
    };
    document.getElementById('btn-import').onclick = Dialogs.openImportSQL;
    document.getElementById('btn-gensql').onclick = function () { switchTab('sql'); };
    document.getElementById('btn-check').onclick = Dialogs.openCheck;
    document.getElementById('btn-dsh').onclick = Dialogs.openDSH;
    document.getElementById('btn-save').onclick = function () {
      Store.saveToServer().then(function () {
        renderStatus();
        Dialogs.toast('已保存到数据库（workbench.db）');
      }).catch(function () {
        renderStatus();
        Dialogs.toast('保存到服务器失败，已保存在浏览器本地', true);
      });
    };
    document.getElementById('btn-export').onclick = Dialogs.exportJSON;
    document.getElementById('btn-export-excel').onclick = function () {
      var n = (Store.project.models || []).length;
      if (!n) { Dialogs.toast('项目中还没有模型，无法导出', true); return; }
      var size = XlsxExport.download(Store.project);
      Dialogs.toast('已导出 Excel 数据字典（' + (size / 1024).toFixed(1) + ' KB，' + n + ' 个模型）');
    };
    document.getElementById('btn-import-json').onclick = Dialogs.importJSON;
    document.getElementById('btn-sample').onclick = function () {
      Dialogs.openModal('加载示例项目', (function () {
        var w = document.createElement('div');
        w.innerHTML = '<p>将载入「电商交易数仓」示例（ODS→DWD→DWS→ADS 全链路演示）。<br><b>当前项目内容会被替换</b>（此前保存的 project.json 将被覆盖），确定继续吗？</p>';
        return w;
      })(), [{
        label: '确认加载', cls: 'primary', onClick: function () {
          Store.project = JSON.parse(JSON.stringify(root.SAMPLE));
          Store.selectedId = Store.project.models[0] ? Store.project.models[0].id : null;
          Store.touch();
          Store.saveToServer().catch(function () { });
          Dialogs.closeModal();
          refresh();
          Dialogs.toast('已加载示例项目（写入 SQLite）');
        }
      }]);
    };
    document.getElementById('project-name').addEventListener('input', function () {
      Store.project.name = this.value; Store.autosave();
    });
    document.getElementById('dialect').addEventListener('change', function () {
      Store.project.dialect = this.value; Store.autosave();
    });

    // 侧栏事件（委托）
    var sidebar = document.getElementById('sidebar');
    sidebar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (btn) {
        e.stopPropagation();
        if (btn.dataset.act === 'dup') { Store.duplicateModel(btn.dataset.id); refresh(); }
        else if (btn.dataset.act === 'del') {
          var m = Store.find(btn.dataset.id);
          if (m && confirm('确定删除模型「' + (m.name || m.cnName || '未命名') + '」？')) {
            Store.deleteModel(btn.dataset.id); refresh();
          }
        }
        return;
      }
      var item = e.target.closest('.model-item');
      if (item) {
        Store.selectedId = item.dataset.id;
        renderSidebar();
        switchTab(currentTab);
      }
    });

    // 页签
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.tab); };
    });

    // 数据加载
    Store.load(function (source) {
      var first = Store.getModels()[0];
      if (first && !Store.selectedId) Store.selectedId = first.id;
      refresh();
      if (source === 'local') Dialogs.toast('未连接本地服务，数据暂存浏览器（运行 node server.js 可启用 SQLite 持久化）');
    });

    // 快捷键：Ctrl+S 保存
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        document.getElementById('btn-save').click();
      }
    });
  }

  root.App = { refresh: refresh, renderSidebar: renderSidebar, switchTab: switchTab };
  document.addEventListener('DOMContentLoaded', init);
})(typeof globalThis !== 'undefined' ? globalThis : this);
