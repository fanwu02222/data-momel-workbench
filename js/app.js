/**
 * 应用入口：布局渲染、侧栏分层导航、页签切换、SQL 预览、顶栏动作
 */
(function (root) {
  'use strict';
  var Store = root.Store, Editor = root.Editor, Dialogs = root.Dialogs, Lineage = root.Lineage, SQLGen = root.SQLGen;

  var LAYERS = [
    { key: 'ods', short: 'ODS', cn: '贴源层', title: 'ODS · 原始数据层', desc: '贴源表，与源系统一致' },
    { key: 'dim', short: 'DIM', cn: '维度层', title: 'DIM · 维度层', desc: '一致性维度，支撑明细与分析' },
    { key: 'dwd', short: 'DWD', cn: '明细层', title: 'DWD · 明细数据层', desc: '清洗/标准化后的明细事实' },
    { key: 'dws', short: 'DWS', cn: '汇总层', title: 'DWS · 汇总数据层', desc: '轻度聚合，公共粒度汇总' },
    { key: 'ads', short: 'ADS', cn: '应用层', title: 'ADS · 应用数据层', desc: '面向报表与应用的结果表' }
  ];
  var currentTab = 'model';
  var lineageMode = 'field'; // field | global

  // 侧栏视图：layer=按分层（默认） catalog=按业务目录（L1-L5 树）
  var VIEW_KEY = 'dw-workbench-sidebar-view';
  var sidebarView = 'layer';
  try { var savedView = localStorage.getItem(VIEW_KEY); if (savedView === 'catalog') sidebarView = 'catalog'; } catch (e) { }
  var olapViewPref = sidebarView; // olap 用户的视图偏好（oltp 强制目录树时不覆盖）
  var catCollapsed = {}; // 目录节点折叠状态（仅存内存）
  var layerCollapsed = {}; // 分层视图各层折叠状态（仅存内存）

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---------- 侧栏：模型卡片（两种视图共用） ----------
  var TABLE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2"/><path d="M2.3 6.1h11.4M6.2 6.1v7.6"/></svg>';

  function modelItemHTML(m) {
    var sel = m.id === Store.selectedId ? ' selected' : '';
    var n = (m.fields || []).length;
    var searchText = ((m.name || '') + ' ' + (m.cnName || '') + ' ' + (m.fields || []).map(function (f) { return f.name || ''; }).join(' ')).toLowerCase();
    var h = '<div class="model-item' + sel + '" data-id="' + m.id + '" data-search="' + esc(searchText) + '">';
    h += '<span class="model-ico">' + TABLE_ICON + '</span>';
    h += '<div class="model-item-main"><span class="model-name">' + esc(m.name || '（未命名）') + '</span>' + (m.cnName ? '<span class="model-cn">' + esc(m.cnName) + '</span>' : '<span class="model-cn">未命名中文</span>') + '</div>';
    h += '<span class="model-field-count">' + n + '</span>';
    h += '<span class="model-acts">'
      + '<button class="icon-btn" data-act="dup" data-id="' + m.id + '" title="复制模型"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5.4" y="5.4" width="7.4" height="7.4" rx="1.4"/><path d="M10.6 5.4V4a1.2 1.2 0 0 0-1.2-1.2H4a1.2 1.2 0 0 0-1.2 1.2v5.4A1.2 1.2 0 0 0 4 10.6h1.4"/></svg></button>'
      + '<button class="icon-btn danger" data-act="del" data-id="' + m.id + '" title="删除"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg></button>'
      + '</span>';
    h += '</div>';
    return h;
  }

  // ---------- 侧栏 ----------
  function renderSidebar() {
    var box = document.getElementById('layer-groups');
    var models = Store.getModels();
    var h = [];
    LAYERS.forEach(function (ly) {
      var ms = models.filter(function (m) { return m.layer === ly.key; });
      var collapsed = !!layerCollapsed[ly.key];
      h.push('<div class="layer-group" data-layer="' + ly.key + '">');
      h.push('<div class="layer-head' + (collapsed ? ' is-collapsed' : '') + '" data-layer-toggle="' + ly.key + '">'
        + '<span class="layer-caret"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.3 8 10.3l4-4"/></svg></span>'
        + '<span class="layer-chip ' + ly.key + '">' + ly.short + '</span>'
        + '<span class="layer-title">' + ly.cn + '</span>'
        + '<span class="layer-count">' + ms.length + '</span></div>');
      if (!collapsed) {
        h.push('<div class="layer-models">');
        if (!ms.length) h.push('<div class="layer-empty">暂无模型</div>');
        ms.forEach(function (m) { h.push(modelItemHTML(m)); });
        h.push('</div>');
      }
      h.push('</div>');
    });
    box.innerHTML = h.join('');
    applySearch();
  }

  // ---------- 侧栏搜索过滤 ----------
  function applySearch() {
    var input = document.getElementById('model-search');
    if (!input) return;
    var q = (input.value || '').trim().toLowerCase();
    document.querySelectorAll('#layer-groups .model-item, #catalog-view .model-item').forEach(function (el) {
      var hit = !q || (el.getAttribute('data-search') || '').indexOf(q) >= 0;
      el.style.display = hit ? '' : 'none';
    });
    document.querySelectorAll('#layer-groups .layer-group').forEach(function (g) {
      if (!q) { g.style.display = ''; return; }
      var vis = 0;
      g.querySelectorAll('.model-item').forEach(function (it) { if (it.style.display !== 'none') vis++; });
      g.style.display = vis ? '' : 'none';
    });
  }

  // ---------- 侧栏：业务目录树（L1-L5） ----------
  // 节点子树内的模型总数（含挂在后代节点上的）
  function subtreeModelCount(node) {
    var ids = Store.catalogSubtreeIds(node.id);
    return Store.getModels().filter(function (m) { return m.catalogId && ids.indexOf(String(m.catalogId)) >= 0; }).length;
  }

  function catNodeHTML(n, depth, byCat) {
    var kids = n.children || [];
    var hasKids = kids.length > 0;
    var collapsed = !!catCollapsed[n.id];
    var modelsHere = byCat[n.id] || [];
    var subCount = subtreeModelCount(n);
    var h = [];
    h.push('<div class="cat-node" data-node="' + n.id + '" style="--cat-depth:' + depth + '">');
    h.push('<div class="cat-row">');
    h.push('<span class="cat-caret' + (hasKids ? '' : ' leaf') + '" data-toggle="' + n.id + '"' + (hasKids ? ' title="' + (collapsed ? '展开' : '折叠') + '"' : '') + '>' + (hasKids ? (collapsed ? '▸' : '▾') : '·') + '</span>');
    h.push('<span class="cat-level l' + n.level + '">L' + n.level + '</span>');
    h.push('<span class="cat-name">' + esc(n.name) + '</span>');
    if (n.cnName) h.push('<span class="cat-cn">' + esc(n.cnName) + '</span>');
    if (subCount) h.push('<span class="cat-badge" title="子树内模型数">' + subCount + '</span>');
    h.push('<span class="cat-ops">');
    h.push('<button class="icon-btn" data-cat="add" data-node="' + n.id + '" title="新建子节点">＋</button>');
    h.push('<button class="icon-btn" data-cat="rename" data-node="' + n.id + '" title="改名">✎</button>');
    h.push('<button class="icon-btn danger" data-cat="del" data-node="' + n.id + '" title="删除（整棵子树）">✕</button>');
    h.push('</span></div>');
    if (modelsHere.length && !collapsed) {
      h.push('<div class="cat-models">');
      modelsHere.forEach(function (m) { h.push(modelItemHTML(m)); });
      h.push('</div>');
    }
    if (hasKids && !collapsed) {
      h.push('<div class="cat-children">');
      kids.forEach(function (k) { h.push(catNodeHTML(k, depth + 1, byCat)); });
      h.push('</div>');
    }
    h.push('</div>');
    return h.join('');
  }

  function renderCatalogView() {
    var box = document.getElementById('catalog-view');
    if (!box) return;
    if (sidebarView !== 'catalog' || !Store.project) { box.style.display = 'none'; return; }
    box.style.display = '';
    var models = Store.getModels();
    var validIds = {};
    (function walkAll(nodes) { (nodes || []).forEach(function (n) { validIds[n.id] = true; walkAll(n.children || []); }); })(Store.catalog);
    var byCat = {};
    var uncat = [];
    models.forEach(function (m) {
      var c = m.catalogId ? String(m.catalogId) : '';
      if (!c || !validIds[c]) { uncat.push(m); return; }
      (byCat[c] = byCat[c] || []).push(m);
    });
    var h = [];
    h.push('<div class="cat-group">');
    h.push('<div class="cat-group-head"><span class="cat-group-title">未归类</span><span class="layer-count">' + uncat.length + '</span></div>');
    h.push('<div class="cat-models flat">');
    if (!uncat.length) h.push('<div class="layer-empty">没有未归类模型</div>');
    uncat.forEach(function (m) { h.push(modelItemHTML(m)); });
    h.push('</div></div>');
    h.push('<div class="cat-tree">');
    if (!Store.catalog.length) h.push('<div class="layer-empty">暂无业务目录，点击下方「＋ 新建业务域」创建根节点</div>');
    Store.catalog.forEach(function (n) { h.push(catNodeHTML(n, 1, byCat)); });
    h.push('</div>');
    h.push('<button class="btn small cat-add-root" id="btn-new-domain">＋ 新建业务域</button>');
    box.innerHTML = h.join('');
    applySearch();
    var addBtn = document.getElementById('btn-new-domain');
    if (addBtn) addBtn.onclick = function () { openCatalogNodeDialog('root', null); };
  }

  // 侧栏视图切换（按分层 / 按业务目录）；oltp 项目强制目录树视图（不写入记忆，避免覆盖 olap 偏好）
  function setSidebarView(v) {
    sidebarView = v;
    if (!document.body.classList.contains('oltp')) {
      olapViewPref = v;
      try { localStorage.setItem(VIEW_KEY, v); } catch (e) { }
    }
    document.querySelectorAll('.sidebar-toggle .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    document.getElementById('layer-groups').style.display = v === 'layer' ? '' : 'none';
    var title = document.getElementById('sidebar-title');
    if (title) title.textContent = v === 'layer' ? '数据分层' : '业务目录树';
    renderCatalogView();
  }

  // 项目类型（oltp/olap）驱动的全局 UI 切换：侧栏视图、文案、页签、顶栏按钮
  function applyKindUI() {
    var oltp = Store.isOLTP();
    document.body.classList.toggle('oltp', oltp);
    // 顶栏「推送到数仓」仅 oltp 显示（CSS 控制 display）
    var pushBtn = document.getElementById('btn-push-ods');
    if (pushBtn) pushBtn.style.display = oltp ? '' : 'none';
    // 页签与图标轨道文案：血缘关系 ⇄ ER 模型图
    var tabLabel = oltp ? 'ER 模型图' : '血缘关系';
    var tabBtn = document.querySelector('#tabs button[data-tab="lineage"] .tab-label');
    if (tabBtn) tabBtn.textContent = tabLabel;
    var rail = document.querySelector('.rail-item[data-rail="lineage"]');
    if (rail) rail.title = tabLabel;
    // 新建按钮文案
    var newLabel = document.getElementById('new-model-label');
    if (newLabel) newLabel.textContent = oltp ? '新建实体' : '新建模型';
    // oltp 强制目录树视图；olap 恢复用户视图偏好
    setSidebarView(oltp ? 'catalog' : olapViewPref);
  }

  // ---------- 目录节点弹窗：新建（根/子）/ 改名 ----------
  function openCatalogNodeDialog(mode, node) {
    var isRoot = mode === 'root', isRename = mode === 'rename';
    var oltp = Store.isOLTP();
    // 子节点级别规则：L1 下→L2；L2 下→L2 子域或 L3；L3 下→L3（同级）
    // oltp 语义：L1 业务域 / L2 模块（可多级）/ L3 子域；olap 语义：L1 业务域 / L2 主题域 / L3 业务对象
    var levelOpts;
    if (isRoot) levelOpts = [{ v: 1, label: 'L1 · 业务域' }];
    else if (node.level === 1) levelOpts = [{ v: 2, label: oltp ? 'L2 · 模块' : 'L2 · 主题域' }];
    else if (node.level === 2) levelOpts = oltp
      ? [{ v: 2, label: 'L2 · 模块（子模块）' }, { v: 3, label: 'L3 · 子域' }]
      : [{ v: 2, label: 'L2 · 主题域（子域）' }, { v: 3, label: 'L3 · 业务对象' }];
    else levelOpts = [{ v: 3, label: oltp ? 'L3 · 子域（同级）' : 'L3 · 业务对象（同级）' }];
    var title = isRename ? '改名目录节点' : (isRoot ? '新建业务域（L1 根节点）' : '新建子节点');
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="form-grid cat-dialog">' +
      '<label>名称<input id="cn-name" placeholder="' + (oltp ? '如：交易域 / 订单 / 支付' : '如：财务域 / 应收 / 发票') + '"></label>' +
      '<label>中文名<input id="cn-cn" placeholder="' + (oltp ? '如：订单管理' : '如：应收管理') + '"></label>' +
      (isRename ? '' : '<label>级别<select id="cn-level">' + levelOpts.map(function (o) { return '<option value="' + o.v + '">' + o.label + '</option>'; }).join('') + '</select></label>') +
      '</div>' +
      (!isRoot ? '<p class="hint small cat-parent-hint">父节点：' + esc(node.name) + (node.cnName ? '（' + esc(node.cnName) + '）' : '') + ' · 层级语义 ' + (oltp
        ? 'L1 业务域 → L2 模块 → L3 子域，L4=挂载实体，L5=字段'
        : 'L1 业务域 → L2 主题域 → L3 业务对象，L4=挂载模型，L5=字段') + '</p>' : '');
    if (isRename) {
      wrap.querySelector('#cn-name').value = node.name || '';
      wrap.querySelector('#cn-cn').value = node.cnName || '';
    }
    Dialogs.openModal(title, wrap, [{
      label: isRename ? '保存' : '创建', cls: 'primary', onClick: function () {
        var name = wrap.querySelector('#cn-name').value.trim();
        var cnName = wrap.querySelector('#cn-cn').value.trim();
        if (!name) { Dialogs.toast('节点名称不能为空', true); return; }
        var done;
        if (isRename) done = Store.renameCatalogNode(node.id, name, cnName);
        else {
          var level = parseInt(wrap.querySelector('#cn-level').value, 10) || levelOpts[0].v;
          done = Store.createCatalogNode(isRoot ? '' : node.id, level, name, cnName);
        }
        done.then(function () {
          if (!isRoot && !isRename) delete catCollapsed[node.id]; // 新建子节点后确保父节点展开
          Dialogs.closeModal();
          Dialogs.toast(isRename ? '已更新节点「' + name + '」' : '已创建节点「' + name + '」');
        }).catch(function (e) { Dialogs.toast('操作失败：' + e.message, true); });
      }
    }]);
  }

  function confirmDeleteNode(node) {
    var n = Store.catalogSubtreeIds(node.id).length;
    var mc = subtreeModelCount(node);
    var msg = '确定删除「' + (node.name || '') + '」？' + (n > 1 ? '整棵子树共 ' + n + ' 个节点都会删除。' : '');
    msg += mc ? '挂在其中的 ' + mc + ' 个模型将回到「未归类」（模型本身不会被删除）。' : '挂在其中的模型将回到「未归类」（模型本身不会被删除）。';
    if (!confirm(msg)) return;
    Store.deleteCatalogNode(node.id).then(function (d) {
      Dialogs.toast('已删除 ' + (d.deleted || n) + ' 个目录节点');
    }).catch(function (e) { Dialogs.toast('删除失败：' + e.message, true); });
  }

  // ---------- 顶栏状态 ----------
  // 反映「编辑是否已落到 SQLite」：保存中 / 已保存 HH:MM:SS / 同步失败 / 本地模式
  function renderStatus(source) {
    var elx = document.getElementById('save-status');
    if (!elx) return;
    if (!Store.serverOnline) {
      elx.innerHTML = '<span class="dot warn"></span>本地模式';
      elx.title = '未连接服务端，改动只存在浏览器 localStorage';
      return;
    }
    var st = Store.saveState;
    if (st === 'saving') { elx.innerHTML = '<span class="dot warn"></span>保存中…'; elx.title = '正在写入 SQLite'; return; }
    if (st === 'error') { elx.innerHTML = '<span class="dot warn"></span>同步失败 · 已存本地'; elx.title = Store.saveStateMsg || '写入服务端失败'; return; }
    if (st === 'saved' && Store.lastSavedAt) { elx.innerHTML = '<span class="dot ok"></span>已保存 ' + Store.lastSavedAt; elx.title = '已写入 SQLite'; return; }
    elx.innerHTML = '<span class="dot ok"></span>SQLite 已连接';
    elx.title = '数据存于 workbench.db';
  }

  // ---------- 顶栏：项目切换器 ----------
  function renderProjectSelect() {
    var sel = document.getElementById('project-select');
    if (!sel) return;
    if (!Store.serverOnline) {
      sel.innerHTML = '<option>本地模式（未连接服务）</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    var h = [];
    Store.projects.forEach(function (p) {
      h.push('<option value="' + p.id + '"' + (p.id === Store.projectId ? ' selected' : '') + ' title="' + (p.modelCount || 0) + ' 个模型">' + esc(p.name) + '</option>');
    });
    if (!Store.projects.length) h.push('<option value="' + Store.projectId + '">项目 ' + Store.projectId + '</option>');
    h.push('<option value="__new__">＋ 新建项目…</option>');
    h.push('<option value="__manage__">⚙ 管理项目…</option>');
    sel.innerHTML = h.join('');
  }

  function switchProject(id) {
    if (id === Store.projectId) { renderProjectSelect(); return; }
    if (!confirm('切换项目？当前项目的修改会自动保存到数据库。')) { renderProjectSelect(); return; }
    // 先把当前项目的待写入改动落库，再加载新项目，避免防抖窗口内的编辑丢失或串项目
    Store.flushSave().catch(function () { }).then(function () {
      Store.loadProject(id, function () {
        catCollapsed = {}; // 不同项目的目录树，折叠状态重置
        App.refresh();
        var meta = Store.projects.filter(function (p) { return p.id === id; })[0];
        Dialogs.toast('已切换到「' + (Store.project.name || (meta && meta.name) || ('项目 ' + id)) + '」');
      });
    });
  }

  function openNewProject() {
    var wrap = document.createElement('div');
    var dialects = ['hive', 'mysql', 'clickhouse', 'postgresql'];
    var DIALECT_BY_KIND = { oltp: 'mysql', olap: 'hive' };
    wrap.innerHTML =
      '<div class="kind-picker">' +
      '<label class="kind-opt"><input type="radio" name="np-kind" value="oltp"><span class="kind-ico">🗃</span><span class="kind-txt"><b>业务库建模（OLTP）</b><small>实体 / ER 图 / 外键索引，产出业务库 DDL</small></span></label>' +
      '<label class="kind-opt"><input type="radio" name="np-kind" value="olap" checked><span class="kind-ico">📊</span><span class="kind-txt"><b>数仓建模（OLAP）</b><small>分层 / 血缘 / ETL，产出数仓脚本</small></span></label>' +
      '</div>' +
      '<div class="form-grid cat-dialog" style="margin-top:12px">' +
      '<label>项目名称<input id="np-name" placeholder="如：零售交易数仓"></label>' +
      '<label>默认方言<select id="np-dialect">' + dialects.map(function (d) {
        return '<option value="' + d + '"' + (Store.project && Store.project.dialect === d ? ' selected' : '') + '>' + SQLGen.dialectName(d) + '</option>';
      }).join('') + '</select></label>' +
      '</div>' +
      '<p class="hint small cat-parent-hint">新项目为空项目（无模型），创建后自动切换过去；各项目的模型与业务目录相互独立。</p>';
    // 类型 → 默认方言联动（用户手动改方言后不再覆盖）
    var kindTouched = false, dialectTouched = false;
    wrap.querySelectorAll('input[name="np-kind"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!dialectTouched) wrap.querySelector('#np-dialect').value = DIALECT_BY_KIND[r.value] || 'hive';
        kindTouched = true;
      });
    });
    wrap.querySelector('#np-dialect').addEventListener('change', function () { dialectTouched = true; });
    Dialogs.openModal('新建项目', wrap, [{
      label: '创建', cls: 'primary', onClick: function () {
        var name = wrap.querySelector('#np-name').value.trim();
        var dialect = wrap.querySelector('#np-dialect').value;
        var kindEl = wrap.querySelector('input[name="np-kind"]:checked');
        var kind = kindEl ? kindEl.value : 'olap';
        if (!name) { Dialogs.toast('请填写项目名称', true); return; }
        Store.createProject(name, dialect, kind).then(function (d) {
          Dialogs.closeModal();
          return Store.loadProject(d.project.id, function () {
            catCollapsed = {};
            App.refresh();
            Dialogs.toast('已创建并切换到「' + d.project.name + '」' + (kind === 'oltp' ? '（业务库建模）' : ''));
          });
        }).catch(function (e) { Dialogs.toast('创建项目失败：' + e.message, true); });
      }
    }]);
  }

  // 管理项目：列出全部项目，支持行内改名与删除（无需切换当前项目）
  // 结构对比流程：选连接 → 差异清单 → 勾选执行 ALTER（SQL 页按钮与「数据源」菜单共用）
  function openDiffFlow() {
    root.Materialize.pickConnection(function (conn) {
      root.MatExt.openDiffPanel(conn.id);
    }, '选择对比目标连接');
  }

  // 物化流程：打开物化向导（SQL 页按钮与「数据源」菜单共用）
  function openMaterializeFlow() {
    if (root.Materialize && root.Materialize.openMaterializeDialog) root.Materialize.openMaterializeDialog();
  }

  function openManageProjects() {
    function rowHTML() {
      var cur = Store.projectId;
      var only = Store.projects.length <= 1;
      return Store.projects.map(function (p) {
        var isCur = p.id === cur;
        return '<tr data-pid="' + p.id + '" data-pname="' + esc(p.name) + '">' +
          '<td class="mono">' + p.id + '</td>' +
          '<td><input class="mg-name col-input" value="' + esc(p.name) + '"' + (isCur ? ' title="当前项目"' : '') + '></td>' +
          '<td>' + (p.kind === 'oltp' ? 'OLTP' : 'OLAP') + '</td>' +
          '<td class="mono">' + (p.modelCount || 0) + '</td>' +
          '<td>' + (isCur ? '<span class="mg-cur">当前</span>' : '') + '</td>' +
          '<td class="mg-ops">' +
          '<button class="btn small" data-mg="rename" data-pid="' + p.id + '">保存名</button>' +
          '<button class="btn small danger"' + (only ? ' disabled title="至少保留一个项目"' : ' data-mg="del" data-pid="' + p.id + '"') + '>删除</button>' +
          '</td></tr>';
      }).join('');
    }
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<p class="hint small">改名直接编辑后点「保存名」；删除会连同该项目全部模型与业务目录一并移除（不可恢复）。</p>' +
      '<table class="mg-table"><thead><tr><th>ID</th><th>项目名称</th><th>类型</th><th>模型</th><th></th><th>操作</th></tr></thead>' +
      '<tbody id="mg-rows">' + rowHTML() + '</tbody></table>';
    Dialogs.openModal('管理项目', wrap, [{ label: '关闭', cls: '' }]);
    wrap.querySelector('#mg-rows').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-mg]');
      if (!btn || btn.disabled) return;
      var pid = parseInt(btn.dataset.pid, 10);
      var row = wrap.querySelector('tr[data-pid="' + pid + '"]');
      if (btn.dataset.mg === 'rename') {
        var v = row.querySelector('.mg-name').value.trim();
        if (!v) { Dialogs.toast('项目名称不能为空', true); return; }
        Store.updateProjectMetaFor(pid, { name: v }).then(function () {
          Dialogs.toast('已改名：' + v);
          if (pid === Store.projectId) { Store.project.name = v; var pn = document.getElementById('project-name'); if (pn) pn.value = v; Store.autosave(); }
          wrap.querySelector('#mg-rows').innerHTML = rowHTML();
          renderProjectSelect();
        }).catch(function (err) { Dialogs.toast(err.message || '改名失败', true); });
      } else if (btn.dataset.mg === 'del') {
        var meta = Store.projects.filter(function (p) { return p.id === pid; })[0];
        if (!confirm('确定删除项目「' + (meta ? meta.name : pid) + '」？\n其 ' + (meta ? meta.modelCount : '?') + ' 个模型与业务目录将被一并删除，不可恢复！')) return;
        Store.deleteProject(pid).then(function () {
          Dialogs.toast('已删除项目「' + (meta ? meta.name : pid) + '」');
          if (pid === Store.projectId) {
            // 删的是当前项目：切到剩余的第一个
            var left = Store.projects.filter(function (p) { return p.id !== pid; });
            if (left.length) {
              Store.loadProject(left[0].id, function () { catCollapsed = {}; App.refresh(); renderProjectSelect(); });
            }
          } else {
            wrap.querySelector('#mg-rows').innerHTML = rowHTML();
            renderProjectSelect();
          }
        }).catch(function (err) { Dialogs.toast(err.message || '删除失败', true); });
      }
    });
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
    var partsOpts = Store.isOLTP()
      ? '<option value="ddl" selected>仅建表 DDL</option>'
      : '<option value="both">DDL + DML</option><option value="ddl">仅建表 DDL</option><option value="dml">仅 ETL DML</option>';
    h.push('<label>内容 <select id="sql-parts">' + partsOpts + '</select></label>');
    h.push('<label>方言 <select id="sql-dialect">');
    ['hive', 'mysql', 'clickhouse', 'postgresql'].forEach(function (d) {
      h.push('<option value="' + d + '"' + (Store.project.dialect === d ? ' selected' : '') + '>' + SQLGen.dialectName(d) + '</option>');
    });
    h.push('</select></label>');
    h.push('<button class="btn primary" id="btn-do-gen">⚙ 生成 SQL</button>');
    h.push('<button class="btn" id="btn-mat" title="把模型 DDL 物化到真实数据库（MySQL / PostgreSQL / Hive）">⚡ 物化到库</button>');
    h.push('<button class="btn" id="btn-diff" title="对比当前项目模型与目标库的真实结构，生成可执行的 ALTER 同步语句">⇄ 结构对比</button>');
    h.push('<button class="btn" id="btn-tpl" title="编辑 SQL 生成模板">⌗ 模版</button>');
    h.push('<button class="btn" id="btn-copy-sql">复制</button>');
    h.push('<button class="btn" id="btn-dl-sql">下载 .sql</button>');
    h.push('</div>');
    h.push('<div class="sql-output-wrap"><pre id="sql-output" class="mono sql-output"><span class="hint-line">点击「生成 SQL」查看脚本…</span></pre></div>');
    pane.innerHTML = h.join('');
    document.getElementById('btn-do-gen').onclick = function () { genSQL(); };
    var btnMat = document.getElementById('btn-mat');
    var btnDiff = document.getElementById('btn-diff');
    if (btnDiff) btnDiff.onclick = openDiffFlow;
    if (btnMat) btnMat.onclick = openMaterializeFlow;
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

  // ER 画布：字段行内编辑浮层（新建 f=null / 编辑现有 f）
  function openFieldQuickEdit(m, f) {
    var isNew = !f;
    if (isNew) {
      f = { name: '', type: 'varchar(64)', comment: '' };
      m.fields = m.fields || [];
      m.fields.push(f);
    }
    var oldEl = document.getElementById('er-field-edit');
    if (oldEl) oldEl.remove();
    var layer = document.createElement('div');
    layer.id = 'er-field-edit';
    layer.style.cssText = 'position:fixed;z-index:9999;background:var(--panel);border:1px solid var(--line-2);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.2);padding:10px 12px;width:300px;font-size:12px';
    layer.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px">' + esc(m.name || '?') + ' · ' + (isNew ? '新字段' : esc(f.name)) + '</div>' +
      '<div class="fe-grid">' +
      '<label>名称<input id="fe-name" class="col-input" value="' + esc(f.name) + '" placeholder="field_name"></label>' +
      '<label>类型<input id="fe-type" class="col-input mono" value="' + esc(f.type) + '" placeholder="varchar(64)"></label>' +
      '<label>注释<input id="fe-comment" class="col-input" value="' + esc(f.comment || '') + '"></label>' +
      '<label class="fe-inline"><input type="checkbox" id="fe-pk"' + (f.pk ? ' checked' : '') + '>主键</label>' +
      '<label class="fe-inline"><input type="checkbox" id="fe-nullable"' + (f.nullable === false ? ' checked' : '') + '>非空</label>' +
      '<label class="fe-inline"><input type="checkbox" id="fe-unique"' + (f.unique ? ' checked' : '') + '>唯一</label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">' +
      '<button class="btn small" data-fe="cancel">取消</button>' +
      '<button class="btn small primary" data-fe="save">保存</button></div>';
    document.body.appendChild(layer);
    layer.style.left = Math.min(window.innerWidth - 320, 80) + 'px';
    layer.style.top = Math.min(window.innerHeight - 220, 120) + 'px';
    var nameInput = layer.querySelector('#fe-name');
    nameInput.focus();
    function close() { layer.remove(); document.removeEventListener('mousedown', onDoc, true); }
    function onDoc(e) { if (!layer.contains(e.target)) close(); }
    document.addEventListener('mousedown', onDoc, true);
    layer.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    layer.addEventListener('keydown', function (e) { e.stopPropagation(); });
    function save() {
      var name = nameInput.value.trim();
      if (!name) { Dialogs.toast('字段名不能为空', true); return; }
      var dup = (m.fields || []).some(function (x) { return x !== f && x.name === name; });
      if (dup) { Dialogs.toast('同实体已有同名字段：' + name, true); return; }
      f.name = name;
      f.type = layer.querySelector('#fe-type').value.trim() || 'string';
      f.comment = layer.querySelector('#fe-comment').value.trim();
      f.pk = layer.querySelector('#fe-pk').checked;
      if (layer.querySelector('#fe-nullable').checked) f.nullable = false; else delete f.nullable;
      if (layer.querySelector('#fe-unique').checked) f.unique = true; else delete f.unique;
      if (f.pk) { delete f.nullable; delete f.unique; }
      Store.flushSave().catch(function () { });
      close();
      renderLineagePane(); renderCatalogView();
      Dialogs.toast((isNew ? '已添加字段 ' : '已更新字段 ') + name);
    }
    layer.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-fe]');
      if (!b) return;
      if (b.dataset.fe === 'save') save();
      else close();
    });
    layer.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') close();
    });
  }

  // ---------- 血缘页 / ER 模型图页 ----------
  function renderLineagePane() {
    var pane = document.getElementById('pane-lineage');
    var m = Store.find(Store.selectedId);
    var h = [];
    h.push('<div class="lin-toolbar">');
    if (Store.isOLTP()) {
      /* ---- ER 模型图（oltp 项目） ---- */
      h.push('<div class="seg"><button class="seg-btn active">ER 模型图（全项目实体）</button></div>');
      h.push('<div class="lin-tools"><span class="hint">拖动实体调整布局 · 空白处拖动平移 · 滚轮缩放 · 点击实体编辑</span>'
        + '<button class="btn small" id="btn-lin-clear">重置布局</button>'
        + '<button class="btn small" id="btn-lin-reset">适应窗口</button></div>');
      h.push('</div>');
      h.push('<div class="lin-canvas-wrap"><div id="lin-canvas" class="lin-canvas"></div></div>');
      h.push('<div id="lin-warnings" class="lin-warnings"></div>');
      pane.innerHTML = h.join('');
      var canvas = document.getElementById('lin-canvas');
      var warnBox = document.getElementById('lin-warnings');
      document.getElementById('btn-lin-reset').onclick = function () {
        var svg = canvas.querySelector('svg');
        if (svg && svg._resetView) svg._resetView();
      };
      document.getElementById('btn-lin-clear').onclick = function () {
        delete Store.project.layout;
        Store.autosave();
        renderLineagePane();
        Dialogs.toast('已恢复默认布局');
      };
      if (!Store.getModels().length) {
        canvas.innerHTML = '<div class="empty-state small"><p>暂无实体，先在左侧「新建实体」</p></div>';
        warnBox.innerHTML = '';
        return;
      }
      root.ER_HOOKS = {
        afterRelationChange: function () {
          Store.flushSave().catch(function () { }); // 关系是显式操作，立即落库
          renderLineagePane(); // 重渲染 ER（新连线/标记）
          renderCatalogView();
        },
        getModelNames: function () { return Store.getModels().map(function (m) { return m.name; }); },
        createJoinEntity: function (name, aName, aPk, bName, bPk) {
          var m = Store.newModel('entity');
          m.name = name;
          m.cnName = '中间表（' + aName + ' × ' + bName + '）';
          m.desc = 'N:N 关系中间表（由 ER 图自动生成）';
          m.fields = [
            { name: 'id', type: 'bigint', comment: '主键', pk: true, nullable: false },
            { name: aName + '_id', type: 'bigint', comment: '关联 ' + aName, fk: aName + '.' + aPk, nullable: false },
            { name: bName + '_id', type: 'bigint', comment: '关联 ' + bName, fk: bName + '.' + bPk, nullable: false }
          ];
          m.indexes = [
            { name: 'idx_' + aName + '_id', fields: [aName + '_id'], unique: false },
            { name: 'idx_' + bName + '_id', fields: [bName + '_id'], unique: false }
          ];
          Store.flushSave().catch(function () { });
          renderLineagePane();
          renderCatalogView();
          Dialogs.toast('已生成中间表「' + name + '」（两条 N:1 外键构成 N:N）');
        },
        removeRelation: function (model, field) {
          if (!confirm('删除外键关系：' + (model.name || '?') + '.' + (field.name || '?') + ' → ' + (field.fk || '?') + ' ？')) return;
            delete field.fk;
            Store.flushSave().catch(function () { });
            renderLineagePane();
            renderCatalogView();
            Dialogs.toast('已删除关系');
        }
  ,
        // ---- ER 画布快速建模 ----
        onQuickCreate: function (x, y) {
          var name = 'entity_' + Date.now().toString(36).slice(-4);
          var m = Store.newModel('entity');
          m.name = name;
          m.fields = [{ name: 'id', type: 'bigint', comment: '主键', pk: true, nullable: false }];
          var lay = Store.project.layout || (Store.project.layout = {});
          lay[m.id] = { x: Math.max(0, x), y: Math.max(0, y) };
          Store.flushSave().catch(function () { });
          renderLineagePane();
          Dialogs.toast('已创建实体「' + name + '」，双击标题改名、拖字段建关系');
        },
        onRenameModel: function (m, v) {
          var dup = Store.getModels().some(function (x) { return x !== m && x.name === v; });
          if (dup) { Dialogs.toast('已存在同名实体：' + v, true); return; }
          m.name = v;
          Store.flushSave().catch(function () { });
          renderLineagePane(); renderSidebar(); renderCatalogView();
          Dialogs.toast('已改名「' + v + '」');
        },
        onEditField: function (m, f) { openFieldQuickEdit(m, f); },
        onDeleteField: function (m, f) {
          if (!confirm('删除字段 ' + (m.name || '?') + '.' + (f.name || '?') + (f.fk ? '（外键关系一并删除）' : '') + '？')) return;
          m.fields = (m.fields || []).filter(function (x) { return x !== f; });
          Store.flushSave().catch(function () { });
          renderLineagePane(); renderCatalogView();
          Dialogs.toast('已删除字段 ' + (f.name || ''));
        },
        onDeleteModel: function (m) {
          if (!confirm('删除实体「' + (m.name || '?') + '」及其 ' + (m.fields || []).length + ' 个字段？')) return;
          Store.deleteModel(m.id);
          if (Store.project.layout) delete Store.project.layout[m.id];
          Store.flushSave().catch(function () { });
          renderLineagePane(); renderSidebar(); renderCatalogView();
          Dialogs.toast('已删除实体「' + (m.name || '') + '」');
        }
      };
      var r = root.ER.renderER(canvas, Store.project, {
        catalog: Store.catalog,
        getLayout: function () { return Store.project.layout || null; },
        saveLayout: function (lay) { Store.project.layout = lay; Store.autosave(); },
        onSelectModel: function (id) {
          Store.selectedId = id;
          renderSidebar();
          renderCatalogView();
          switchTab('model');
        },
        // 画布快速建模（hooks 与 ER_HOOKS 同源，拖关系等旧交互也走 ER_HOOKS）
        onQuickCreate: root.ER_HOOKS.onQuickCreate,
        onRenameModel: root.ER_HOOKS.onRenameModel,
        onEditField: root.ER_HOOKS.onEditField,
        onDeleteField: root.ER_HOOKS.onDeleteField,
        onDeleteModel: root.ER_HOOKS.onDeleteModel
      });
      warnBox.innerHTML = (r.warnings || []).length
        ? '<div class="warn-box">⚠ ' + r.warnings.map(esc).join('<br>⚠ ') + '</div>'
        : '<div class="ok-box">✅ 共 ' + r.entityCount + ' 个实体、' + r.edgeCount + ' 条外键关系，引用解析完整</div>';
      return;
    }
    /* ---- 血缘关系（olap 项目，原样） ---- */
    h.push('<div class="seg">');
    h.push('<button class="seg-btn' + (lineageMode === 'field' ? ' active' : '') + '" data-mode="field">字段级血缘（当前模型）</button>');
    h.push('<button class="seg-btn' + (lineageMode === 'global' ? ' active' : '') + '" data-mode="global">全局模型血缘</button>');
    h.push('</div>');
    h.push('<div class="lin-tools"><span class="hint">' + (lineageMode === 'global'
      ? '拖动模型调整布局 · 空白处拖动平移 · 滚轮缩放 · 点击模型下钻'
      : '拖动平移 · 滚轮缩放 · 悬停字段名高亮') + '</span>'
      + (lineageMode === 'global' ? '<button class="btn small" id="btn-lin-clear">重置布局</button>' : '')
      + '<button class="btn small" id="btn-lin-reset">适应窗口</button></div>');
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
    var btnClear = document.getElementById('btn-lin-clear');
    if (btnClear) btnClear.onclick = function () {
      delete Store.project.layout;
      Store.autosave();
      renderLineagePane();
      Dialogs.toast('已恢复默认布局');
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
      }, {
        getLayout: function () { return Store.project.layout || null; },
        saveLayout: function (lay) { Store.project.layout = lay; Store.autosave(); }
      });
      warnBox.innerHTML = '<div class="ok-box">共 ' + graph.nodes.length + ' 个模型、' + graph.edges.length + ' 条表级血缘（点击模型可查看其字段级血缘）</div>';
    }
  }

  // ---------- 页签 ----------
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    document.querySelectorAll('.rail-item').forEach(function (b) { b.classList.toggle('active', b.dataset.rail === tab); });
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
    renderProjectSelect();
    applyKindUI();
    renderSidebar();
    renderCatalogView();
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

    // 侧栏：搜索过滤 / 整栏收起 / 图标轨道
    var searchInput = document.getElementById('model-search');
    if (searchInput) searchInput.addEventListener('input', applySearch);
    var sidebarEl = document.getElementById('sidebar');
    var RAIL_KEY = 'dw-workbench-sidebar-collapsed';
    function applyRail(c) {
      sidebarEl.classList.toggle('collapsed', c);
      try { localStorage.setItem(RAIL_KEY, c ? '1' : '0'); } catch (e) { }
    }
    var railBtn = document.getElementById('rail-btn');
    if (railBtn) railBtn.onclick = function () { applyRail(!sidebarEl.classList.contains('collapsed')); };
    try { if (localStorage.getItem(RAIL_KEY) === '1') applyRail(true); } catch (e) { }
    document.querySelectorAll('.rail-item').forEach(function (b) {
      b.onclick = function () {
        var r = b.dataset.rail;
        if (r === 'new') { document.getElementById('btn-new-model').click(); return; }
        switchTab(r);
      };
    });
    setSidebarView(sidebarView); // 应用上次的侧栏视图（localStorage 记忆，默认「按分层」）
    // 数据变更 → 即时重渲染（增删字段/模型、切层、导入、目录树变更等操作立即生效）
    Store.onChange(function () {
      renderSidebar();
      renderCatalogView();
      renderStatus();
      if (currentTab === 'model') Editor.render();
      else if (currentTab === 'lineage') renderLineagePane();
    });
    // 保存状态单独监听：只更新顶栏文案，不触发整页重渲染（避免输入时丢焦点）
    Store.onSaveState(function () { renderStatus(); });

    // 顶栏
    document.getElementById('btn-new-model').onclick = function () {
      var oltp = Store.isOLTP();
      Dialogs.openModal(oltp ? '新建实体' : '新建模型', (function () {
        var wrap = document.createElement('div');
        wrap.innerHTML =
          '<div class="form-grid">' +
          (oltp
            ? '<label>表名（可留空稍后填写）<input id="nm-name" class="mono" placeholder="如 user_info"></label>'
            : '<label>初始分层<select id="nm-layer">' + LAYERS.map(function (l) { return '<option value="' + l.key + '">' + l.title + '</option>'; }).join('') + '</select></label>' +
          '<label>表名（可留空稍后填写）<input id="nm-name" class="mono" placeholder="如 dwd_order_info_di"></label>') +
          '</div>';
        return wrap;
      })(), [
        {
          label: '创建', cls: 'primary', onClick: function () {
            var layerEl = document.getElementById('nm-layer');
            var layer = layerEl ? layerEl.value : 'entity';
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
    document.getElementById('btn-rename-project').onclick = function () {
      var w = document.createElement('div');
      w.innerHTML = '<label class="notes-label">项目名称<input id="rp-name" class="col-input" style="height:34px" value="' + esc(Store.project.name || '') + '"></label>';
      Dialogs.openModal('重命名项目', w, [{
        label: '保存', cls: 'primary', onClick: function () {
          var v = w.querySelector('#rp-name').value.trim();
          if (!v) { Dialogs.toast('项目名称不能为空', true); return; }
          var pn = document.getElementById('project-name');
          Store.project.name = v;
          if (pn) { pn.value = v; pn.dispatchEvent(new Event('change')); }
          Store.autosave();
          Dialogs.closeModal();
          refresh();
        }
      }]);
    };

    document.getElementById('btn-import').onclick = function () { Dialogs.openImportSQL({ defaultTab: 'paste' }); };
    // ---- 顶栏三段菜单（项目管理 / 数据模型 / 数据源）----
    function closeMenu(el) {
      var d = el && el.closest ? el.closest('details') : null;
      if (d) d.removeAttribute('open');
    }
    var btnNewProject = document.getElementById('btn-new-project');
    if (btnNewProject) btnNewProject.onclick = function () { closeMenu(btnNewProject); openNewProject(); };
    var btnManageProjects = document.getElementById('btn-manage-projects');
    if (btnManageProjects) btnManageProjects.onclick = function () { closeMenu(btnManageProjects); openManageProjects(); };
    var btnRename2 = document.getElementById('btn-rename-project');
    if (btnRename2) {
      var origRename = btnRename2.onclick;
      btnRename2.onclick = function (e) { closeMenu(btnRename2); if (origRename) return origRename.call(this, e); };
    }
    var btnImportDb = document.getElementById('btn-import-db');
    if (btnImportDb) btnImportDb.onclick = function () { closeMenu(btnImportDb); Dialogs.openImportSQL({ defaultTab: 'db' }); };
    var btnMatEntry = document.getElementById('btn-mat-entry');
    if (btnMatEntry) btnMatEntry.onclick = function () { closeMenu(btnMatEntry); switchTab('sql'); openMaterializeFlow(); };
    var btnDiffEntry = document.getElementById('btn-diff-entry');
    if (btnDiffEntry) btnDiffEntry.onclick = function () { closeMenu(btnDiffEntry); switchTab('sql'); openDiffFlow(); };
    document.getElementById('btn-gensql').onclick = function () { switchTab('sql'); };
    document.getElementById('btn-check').onclick = Dialogs.openCheck;
    document.getElementById('btn-dsh').onclick = Dialogs.openDSH;
    // 推送到数仓（仅 oltp 项目显示，applyKindUI 控制 display）
    var pushBtn = document.getElementById('btn-push-ods');
    if (pushBtn) pushBtn.onclick = function () { Dialogs.openPushToOds(); };
    document.getElementById('btn-save').onclick = function () {
      Store.saveToServer().then(function () {
        renderStatus();
        Store.refreshProjects().then(function () { renderProjectSelect(); });
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
    document.getElementById('btn-import-excel').onclick = Dialogs.importExcel;
    var btnDbConn = document.getElementById('btn-db-connections');
    if (btnDbConn) btnDbConn.onclick = function () {
      var menu = btnDbConn.closest('details');
      if (menu) menu.removeAttribute('open'); // 菜单不遮挡弹窗
      if (root.Materialize && root.Materialize.openConnectionsDialog) root.Materialize.openConnectionsDialog();
    };
    var btnSampleOltp = document.getElementById('btn-sample-oltp');
    if (btnSampleOltp) btnSampleOltp.onclick = function () {
      Dialogs.openModal('加载 OLTP 示例（业务库）', (function () {
        var w = document.createElement('div');
        w.innerHTML = '<p>将<b>新建</b>一个「电商业务库（示例）」项目：5 个实体（部门/用户/商品/订单/明细）+ 外键 ER 关系 + 复合索引 + 业务目录树。<br>不影响现有项目（多项目隔离），创建后自动切换过去。</p>';
        return w;
      })(), [{
        label: '创建示例', cls: 'primary', onClick: function () {
          Dialogs.closeModal();
          Store.installOtlpSample(false).then(function (r) {
            if (r.skipped) { Dialogs.toast('示例已存在，从顶栏下拉切换即可'); renderProjectSelect(); return; }
            catCollapsed = {};
            App.refresh();
            switchProject(r.id);
            Dialogs.toast('已创建「电商业务库（示例）」');
          }).catch(function (e) { Dialogs.toast('创建示例失败：' + e.message, true); });
        }
      }]);
    };
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
      // 方言变更同步服务端 projects 行（整库 PUT 也会带上，这里保证元信息即时一致）
      if (Store.serverOnline) Store.updateProjectMeta({ dialect: this.value }).catch(function () { });
    });
    document.getElementById('project-name').addEventListener('change', function () {
      if (!Store.serverOnline) return;
      var cur = Store.projects.filter(function (p) { return p.id === Store.projectId; })[0];
      if (cur && cur.name === this.value) return; // 未变化不请求
      Store.updateProjectMeta({ name: this.value }).then(function () {
        renderProjectSelect();
      }).catch(function () { Dialogs.toast('项目名同步到服务端失败', true); });
    });

    // 顶栏：项目切换器
    document.getElementById('project-select').addEventListener('change', function () {
      var v = this.value;
      if (v === '__new__') { renderProjectSelect(); openNewProject(); return; }
      if (v === '__manage__') { renderProjectSelect(); openManageProjects(); return; }
      var id = parseInt(v, 10);
      if (!id || id === Store.projectId) { renderProjectSelect(); return; }
      switchProject(id);
    });

    // 侧栏视图切换（按分层 | 按业务目录）
    document.querySelectorAll('.sidebar-toggle .seg-btn').forEach(function (b) {
      b.onclick = function () { setSidebarView(b.dataset.view); };
    });

    // 侧栏事件（委托：模型卡片操作 + 目录树节点操作，两种视图共用）
    var sidebar = document.getElementById('sidebar');
    sidebar.addEventListener('click', function (e) {
      // 分层视图：点击层标题折叠/展开该层
      var lyHead = e.target.closest('[data-layer-toggle]');
      if (lyHead) {
        var lk = lyHead.dataset.layerToggle;
        if (layerCollapsed[lk]) delete layerCollapsed[lk]; else layerCollapsed[lk] = true;
        renderSidebar();
        return;
      }
      var catBtn = e.target.closest('button[data-cat]');
      if (catBtn) {
        e.stopPropagation();
        var node = Store.findCatalogNode(catBtn.dataset.node);
        if (!node) return;
        if (catBtn.dataset.cat === 'add') openCatalogNodeDialog('child', node);
        else if (catBtn.dataset.cat === 'rename') openCatalogNodeDialog('rename', node);
        else if (catBtn.dataset.cat === 'del') confirmDeleteNode(node);
        return;
      }
      var caret = e.target.closest('[data-toggle]');
      if (caret) {
        var nid = caret.dataset.toggle;
        if (catCollapsed[nid]) delete catCollapsed[nid]; else catCollapsed[nid] = true;
        renderCatalogView();
        return;
      }
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
        renderCatalogView();
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
      // 全新库自动补装 OLTP 示例项目（幂等，不切换，仅出现在下拉里）
      if (Store.serverOnline && Store.projects.length === 1 && root.OLTP_SAMPLE) {
        Store.installOtlpSample(true).then(function (r) {
          if (!r.skipped) { renderProjectSelect(); Dialogs.toast('已为你预置「电商业务库（示例）」OLTP 项目，顶栏可切换'); }
        }).catch(function () { });
      }
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
