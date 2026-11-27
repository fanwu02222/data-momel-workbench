/**
 * 数据库连接 / 物化到库 / 从数据库反向导入
 *  - 顶栏 ⋯「数据库连接」管理（mysql / postgresql / hive）
 *  - SQL 页「⚡ 物化到库」三步向导：选连接 → 预览 DDL → 执行
 *  - 「导入 SQL」弹窗的「从数据库导入」页签：选连接 → 选表 → 转模型预览 → 导入
 * 依赖 Store / SQLGen / Dialogs（运行时经 root 取，避免加载顺序耦合）
 */
(function (root) {
  'use strict';

  // ---------- 基础工具 ----------
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function jfetch(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d && d.error || ('http ' + r.status));
        return d;
      });
    });
  }

  // ---------- 连接类型元数据 ----------
  var KINDS = {
    mysql: { label: 'MySQL', port: 3306, dialect: 'mysql' },
    postgresql: { label: 'PostgreSQL', port: 5432, dialect: 'postgresql' },
    hive: { label: 'Hive', port: 10000, dialect: 'hive' }
  };
  function kindLabel(k) { return (KINDS[k] || {}).label || k; }
  function connDesc(c) { return kindLabel(c.kind) + ' · ' + (c.host || '') + ':' + (c.port || '') + '/' + (c.database || ''); }
  function connOptionLabel(c) { return c.name + '（' + connDesc(c) + '）'; }

  // ---------- 后端 API ----------
  var api = {
    list: function () {
      return jfetch('/api/connections').then(function (d) { return d.connections || []; });
    },
    create: function (c) {
      return jfetch('/api/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c)
      });
    },
    remove: function (id) {
      return jfetch('/api/connections/' + id, { method: 'DELETE' });
    },
    test: function (req) {
      return jfetch('/api/connections/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
    },
    materialize: function (connectionId, statements) {
      return jfetch('/api/materialize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectionId, statements: statements })
      });
    },
    tables: function (connectionId) {
      return jfetch('/api/introspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectionId })
      }).then(function (d) { return d.tables || []; });
    },
    detail: function (connectionId, tables) {
      return jfetch('/api/introspect/detail', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectionId, tables: tables })
      }).then(function (d) { return d.tables || []; });
    }
  };

  // ---------- 徽标 / 状态小部件 ----------
  function kindBadge(kind) { return '<span class="kind-badge ' + esc(kind) + '">' + esc(kindLabel(kind)) + '</span>'; }
  function testSpan() {
    var s = el('span', 'conn-test');
    return s;
  }
  function runTest(rowEl, id, c) {
    var out = rowEl.querySelector('.conn-test');
    if (!out) return;
    out.className = 'conn-test';
    out.textContent = '测试中…';
    api.test({ id: id }).then(function (d) {
      out.className = 'conn-test ' + (d.ok ? 'ok' : 'err');
      out.textContent = d.ok ? ('✓ ' + (d.version || '连接成功')) : ('✗ ' + (d.error || '连接失败'));
      out.title = out.textContent;
    }).catch(function (e) {
      out.className = 'conn-test err';
      out.textContent = '✗ ' + e.message;
      out.title = e.message;
    });
  }

  // ================= 功能一：数据库连接管理 =================
  // opts.onClose：关闭弹窗后的回调（向导里跳转连接管理时用来返回向导）
  // 表浏览器：列出该连接库中的全部表，可逐表预览数据
  function openTableBrowser(c) {
    var w = el('div');
    w.innerHTML = '<div class="hint">读取表列表中…</div>';
    root.Dialogs.openModal('浏览：' + c.name + '（' + c.database + '）', w, [{ label: '关闭' }]);
    api.tables(c.id).then(function (tables) {
      var h = '<p class="hint small">' + tables.length + ' 张表</p><div class="tb-list">';
      tables.forEach(function (t) {
        h += '<div class="tb-row"><span class="mono tb-name">' + esc(t.name) + '</span>' +
          '<span class="hint tb-comment">' + esc(t.comment || '') + '</span>' +
          '<button class="btn small" data-peek="' + esc(t.name) + '">预览</button></div>';
      });
      h += '</div>';
      w.innerHTML = h;
      w.querySelectorAll('[data-peek]').forEach(function (b) {
        b.onclick = function () {
          root.MatExt.openPreviewPanel(c.id, b.getAttribute('data-peek'), 100);
        };
      });
    }).catch(function (e) {
      w.innerHTML = '<div class="warn-box">❌ ' + esc(e.message) + '</div>';
    });
  }

  function openConnectionsDialog(opts) {
    opts = opts || {};
    var Dialogs = root.Dialogs;
    var wrap = el('div', 'conn-dialog');
    wrap.appendChild(el('p', 'hint',
      '管理「物化到库 / 从数据库导入」使用的连接。密码仅保存在本机 workbench.db，列表接口不会回传。'));

    var listBox = el('div', 'conn-list');
    wrap.appendChild(listBox);

    // ---------- 新建连接表单 ----------
    var newBox = el('div', 'conn-new');
    newBox.appendChild(el('div', 'conn-new-title', '＋ 新建连接'));
    var form = el('div', 'form-grid conn-form');
    form.innerHTML =
      '<label>名称<input id="nc-name" placeholder="如：本地 MySQL"></label>' +
      '<label>类型<select id="nc-kind">' + Object.keys(KINDS).map(function (k) {
        return '<option value="' + k + '">' + kindLabel(k) + '</option>';
      }).join('') + '</select></label>' +
      '<label>主机<input id="nc-host" class="mono" value="127.0.0.1" placeholder="127.0.0.1"></label>' +
      '<label>端口<input id="nc-port" class="mono" type="number" value="3306"></label>' +
      '<label>用户<input id="nc-user" class="mono" placeholder="如 dwtest"></label>' +
      '<label>密码<input id="nc-password" type="password" placeholder="留空则无密码"></label>' +
      '<label>数据库<input id="nc-database" class="mono" placeholder="如 dw_materialize_test"></label>';
    newBox.appendChild(form);
    wrap.appendChild(newBox);

    // 类型 → 默认端口联动（用户手动改过端口后不再覆盖，除非是其它类型的默认端口）
    var portTouched = false;
    var kindSel = form.querySelector('#nc-kind');
    var portInput = form.querySelector('#nc-port');
    kindSel.addEventListener('change', function () {
      var def = (KINDS[kindSel.value] || {}).port || 3306;
      if (!portTouched || isDefaultPort(portInput.value)) portInput.value = def;
    });
    portInput.addEventListener('input', function () { portTouched = true; });
    function isDefaultPort(v) {
      return Object.keys(KINDS).some(function (k) { return String(KINDS[k].port) === String(v); });
    }

    // ---------- 列表渲染 ----------
    function renderList(conns, testId) {
      listBox.innerHTML = '';
      if (!conns.length) {
        listBox.appendChild(el('p', 'conn-empty', '暂无连接，在下方新建一个吧。'));
        return;
      }
      conns.forEach(function (c) {
        var row = el('div', 'conn-row');
        row.dataset.id = c.id;
        row.innerHTML =
          '<div class="conn-main">' +
          '<div class="conn-top">' + kindBadge(c.kind) +
          '<span class="conn-name">' + esc(c.name) + '</span></div>' +
          '<div class="conn-meta">' + esc((c.host || '') + ':' + (c.port || '') + '/' + (c.database || '')) + ' · ' + esc(c.user || '') + '</div>' +
          '</div>' +
          '<span class="conn-test"></span>' +
          '<div class="conn-acts"></div>';
        var acts = row.querySelector('.conn-acts');
        var btnTest = el('button', 'btn small');
        btnTest.textContent = '测试';
        btnTest.onclick = function () { runTest(row, c.id, c); };
        var btnPeek = el('button', 'btn small');
        btnPeek.textContent = '浏览';
        btnPeek.title = '浏览该库的表并预览数据';
        btnPeek.onclick = function () { openTableBrowser(c); };
        var btnDel = el('button', 'btn small danger');
        btnDel.textContent = '删除';
        btnDel.onclick = function () {
          if (!confirm('确定删除连接「' + c.name + '」？')) return;
          api.remove(c.id).then(function () {
            root.Dialogs.toast('已删除连接「' + c.name + '」');
            loadList();
          }).catch(function (e) { root.Dialogs.toast('删除失败：' + e.message, true); });
        };
        acts.appendChild(btnTest); acts.appendChild(btnPeek); acts.appendChild(btnDel);
        listBox.appendChild(row);
        if (testId && c.id === testId) runTest(row, c.id, c); // 新建后自动测试
      });
    }
    function loadList(testId) {
      return api.list().then(function (conns) {
        renderList(conns, testId);
        return conns;
      }).catch(function (e) {
        listBox.innerHTML = '';
        listBox.appendChild(el('p', 'conn-empty', '连接列表加载失败：' + esc(e.message) + '（需通过服务端访问）'));
      });
    }

    var btnCreate = el('button', 'btn primary');
    btnCreate.textContent = '＋ 创建连接';
    btnCreate.onclick = function () {
      var c = {
        name: form.querySelector('#nc-name').value.trim(),
        kind: kindSel.value,
        host: form.querySelector('#nc-host').value.trim() || '127.0.0.1',
        port: parseInt(form.querySelector('#nc-port').value, 10) || 0,
        user: form.querySelector('#nc-user').value.trim(),
        password: form.querySelector('#nc-password').value,
        database: form.querySelector('#nc-database').value.trim()
      };
      if (!c.name) { root.Dialogs.toast('连接名称不能为空', true); return; }
      if (!c.database) { root.Dialogs.toast('数据库名不能为空', true); return; }
      btnCreate.disabled = true;
      api.create(c).then(function (d) {
        btnCreate.disabled = false;
        form.querySelector('#nc-name').value = '';
        form.querySelector('#nc-password').value = '';
        root.Dialogs.toast('连接「' + c.name + '」已创建');
        // 新建后提示可选「测试连接」
        if (confirm('连接「' + c.name + '」已创建，是否立即测试连接？')) {
          loadList(d.connection && d.connection.id);
        } else {
          loadList();
        }
      }).catch(function (e) {
        btnCreate.disabled = false;
        root.Dialogs.toast('创建失败：' + e.message, true);
      });
    };
    var btnClose = el('button', 'btn');
    btnClose.textContent = '关闭';
    btnClose.onclick = function () {
      root.Dialogs.closeModal();
      if (opts.onClose) opts.onClose();
    };

    loadList();
    Dialogs.openModal('数据库连接', wrap, [btnCreate, btnClose]);
  }

  // ================= 功能二：物化到数据库（三步向导） =================
  // 与 SQLGen.genScript 相同的模型排序（oltp 按外键依赖被引用表先建；olap 按血缘拓扑序）
  function orderModels(project) {
    var SQLGen = root.SQLGen;
    var models = (project.models || []).slice();
    if (project.kind === 'oltp') {
      var byName = {};
      models.forEach(function (m) { byName[m.name] = m; });
      var order = [], seen = {};
      function visit(m) {
        if (seen[m.name]) return;
        seen[m.name] = true;
        (m.fields || []).forEach(function (f) {
          var ref = SQLGen.parseFk(f.fk);
          if (ref && byName[ref.table]) visit(byName[ref.table]);
        });
        order.push(m);
      }
      models.slice().sort(function (a, b) { return (a.fields || []).length - (b.fields || []).length; }).forEach(visit);
      return order;
    }
    return SQLGen.topoSort(models).order;
  }

  // 按模型生成 DDL 语句（跳过 genDDL 仅返回提示文本的模型，如 oltp 实体遇 hive 方言）
  // 注：sql-generator.js 的 OLTP MySQL 内置模板会把表注释输出成 COMMENT='xxx`;（引号未闭合、
  // 混入反引号），真实 MySQL 报 1064 语法错误；该文件禁改，这里在物化/预览前做定点修补。
  function repairDdl(sql, dialect) {
    if (dialect !== 'mysql') return sql;
    return String(sql).replace(/COMMENT='((?:[^']|'')*)`;/g, "COMMENT='$1';");
  }
  function buildStatements(project, dialect) {
    var SQLGen = root.SQLGen;
    var statements = [], skipped = [];
    orderModels(project).forEach(function (m) {
      var sql = SQLGen.genDDL(m, dialect, project);
      if (!/\bCREATE\b/i.test(sql)) { skipped.push(m.name || '（未命名）'); return; }
      statements.push({ model: m.name || '（未命名）', sql: repairDdl(sql, dialect) });
    });
    return { statements: statements, skipped: skipped };
  }

  function openMaterializeDialog() {
    var Store = root.Store, Dialogs = root.Dialogs, SQLGen = root.SQLGen;
    if (!Store.getModels().length) { Dialogs.toast('当前项目还没有模型，先创建模型再物化', true); return; }

    var state = { conns: [], connId: 0, bundle: null };
    var wrap = el('div', 'mat-dialog');
    var stepsBar = el('div', 'wz-steps');
    var bodyBox = el('div');
    var foot = el('div', 'foot-actions');
    wrap.appendChild(stepsBar);
    wrap.appendChild(bodyBox);

    var STEP_NAMES = ['选连接', '预览 DDL', '执行结果'];
    function renderSteps(cur) {
      stepsBar.innerHTML = STEP_NAMES.map(function (n, i) {
        var idx = i + 1;
        var cls = 'wz-step' + (idx === cur ? ' active' : '') + (idx < cur ? ' done' : '');
        return '<span class="' + cls + '"><b>' + (idx < cur ? '✓' : idx) + '</b>' + n + '</span>';
      }).join('<span class="wz-arrow">→</span>');
    }
    function setFoot(nodes) {
      foot.innerHTML = '';
      (nodes || []).forEach(function (n) { foot.appendChild(n); });
    }
    function curConn() {
      return state.conns.filter(function (c) { return c.id === state.connId; })[0] || null;
    }

    // ---------- 步骤 1：选连接 ----------
    function renderStep1() {
      renderSteps(1);
      bodyBox.innerHTML = '';
      bodyBox.appendChild(el('p', 'hint',
        '选择目标数据库连接，把当前项目 <b>' + esc(Store.project.name) + '</b>（' + (Store.isOLTP() ? '业务库' : '数仓') + ' · ' +
        Store.getModels().length + ' 个模型）生成 DDL 并在真实库中建表。语句使用 <span class="mono">CREATE TABLE IF NOT EXISTS</span>，已有同名表不会被改动。'));
      var grid = el('div', 'form-grid');
      grid.style.marginTop = '10px';
      grid.innerHTML = '<label class="span2">数据库连接<select id="mat-conn"><option value="">加载中…</option></select></label>';
      bodyBox.appendChild(grid);
      var hint = el('p', 'hint small');
      hint.style.marginTop = '8px';
      bodyBox.appendChild(hint);

      var sel = grid.querySelector('#mat-conn');
      function fillSel() {
        if (!state.conns.length) {
          sel.innerHTML = '<option value="">（暂无连接）</option>';
          hint.innerHTML = '还没有数据库连接，点击「管理连接」新建一个。';
          return;
        }
        sel.innerHTML = state.conns.map(function (c) {
          return '<option value="' + c.id + '"' + (c.id === state.connId ? ' selected' : '') + '>' + esc(connOptionLabel(c)) + '</option>';
        }).join('');
        state.connId = parseInt(sel.value, 10) || 0;
        updHint();
      }
      function updHint() {
        var c = curConn();
        if (!c) { hint.innerHTML = ''; return; }
        var dia = (KINDS[c.kind] || {}).dialect || c.kind;
        hint.innerHTML = '目标：' + kindBadge(c.kind) + ' <span class="mono">' + esc(c.host + ':' + c.port + '/' + c.database) + '</span> · 生成方言：' + esc(SQLGen.dialectName(dia)) +
          (c.kind === 'hive' ? '<br>⚠ Hive 连接通过本机 <span class="mono">beeline</span> 执行，需要已安装 Hive 客户端，否则后端会报错。' : '');
      }
      sel.addEventListener('change', function () {
        state.connId = parseInt(sel.value, 10) || 0;
        updHint();
      });
      api.list().then(function (conns) {
        state.conns = conns;
        if (!state.connId && conns.length) state.connId = conns[0].id;
        fillSel();
      }).catch(function (e) {
        state.conns = [];
        fillSel();
        hint.innerHTML = '<span class="tag err">连接列表加载失败：' + esc(e.message) + '</span>';
      });

      var btnManage = el('button', 'btn');
      btnManage.textContent = '管理连接';
      btnManage.onclick = function () {
        Dialogs.closeModal();
        openConnectionsDialog({ onClose: openMaterializeDialog });
      };
      var btnDdlOnly = el('button', 'btn');
      btnDdlOnly.textContent = '仅生成 DDL 不执行';
      btnDdlOnly.title = '跳到 SQL 脚本页生成当前方言的 DDL，不连接数据库';
      btnDdlOnly.onclick = function () {
        var c = curConn();
        var dialect = c ? ((KINDS[c.kind] || {}).dialect || c.kind) : (Store.project.dialect || 'mysql');
        Dialogs.closeModal();
        root.App.switchTab('sql');
        var d = document.getElementById('sql-dialect');
        if (d) d.value = dialect;
        var p = document.getElementById('sql-parts');
        if (p) p.value = 'ddl';
        var gen = document.getElementById('btn-do-gen');
        if (gen) gen.click();
        Dialogs.toast('已在 SQL 脚本页生成 ' + SQLGen.dialectName(dialect) + ' DDL（未执行）');
      };
      var btnNext = el('button', 'btn primary');
      btnNext.textContent = '下一步：预览 DDL →';
      btnNext.onclick = function () {
        if (!state.connId) { Dialogs.toast('请先选择数据库连接', true); return; }
        renderStep2();
      };
      setFoot([btnManage, btnDdlOnly, btnNext]);
    }

    // ---------- 步骤 2：预览 DDL ----------
    function renderStep2() {
      renderSteps(2);
      var c = curConn();
      var dialect = (KINDS[c.kind] || {}).dialect || c.kind;
      state.bundle = buildStatements(Store.project, dialect);
      var b = state.bundle;

      bodyBox.innerHTML = '';
      bodyBox.appendChild(el('p', 'hint',
        '将向 <b>' + esc(c.name) + '</b>（' + connDesc(c) + '）执行 <b>' + b.statements.length + '</b> 条 DDL 语句（方言：' + esc(SQLGen.dialectName(dialect)) + '）。' +
        (b.skipped.length ? '<br><span class="tag warn">已跳过 ' + b.skipped.length + ' 个不适用该方言的模型：' + esc(b.skipped.join('、')) + '</span>' : '')));
      var list = el('div', 'mat-ddl-list');
      if (!b.statements.length) {
        list.appendChild(el('p', 'conn-empty', '没有可执行的 DDL 语句。'));
      }
      b.statements.forEach(function (s, i) {
        var item = el('details', 'mat-ddl-item');
        if (i === 0) item.open = true;
        var sum = el('summary');
        sum.innerHTML = '<span class="m-name">' + esc(s.model) + '</span><span class="m-meta">' + esc(s.sql.slice(0, 60).replace(/\n/g, ' ')) + '…</span>';
        item.appendChild(sum);
        var pre = el('pre', 'mono');
        pre.textContent = s.sql;
        item.appendChild(pre);
        list.appendChild(item);
      });
      bodyBox.appendChild(list);

      var btnBack = el('button', 'btn');
      btnBack.textContent = '← 上一步';
      btnBack.onclick = renderStep1;
      var btnRun = el('button', 'btn primary');
      btnRun.textContent = '⚡ 执行物化';
      if (!b.statements.length) btnRun.disabled = true;
      btnRun.onclick = function () { renderStep3(btnRun); };
      setFoot([btnBack, btnRun]);
    }

    // ---------- 步骤 3：执行 + 结果 ----------
    function renderStep3(btnRun) {
      renderSteps(3);
      var c = curConn();
      var b = state.bundle;
      bodyBox.innerHTML = '';
      bodyBox.appendChild(el('p', 'hint', '正在向 <b>' + esc(c.name) + '</b>（' + connDesc(c) + '）执行 ' + b.statements.length + ' 条 DDL…'));
      var box = el('div', 'mat-results');
      bodyBox.appendChild(box);
      setFoot([]);
      api.materialize(state.connId, b.statements).then(function (d) {
        var rs = d.results || [];
        var okN = rs.filter(function (r) { return r.ok; }).length;
        bodyBox.querySelector('p.hint').innerHTML =
          '物化完成：<span class="tag ok">✓ 成功 ' + okN + '</span>' + (rs.length - okN ? ' <span class="tag err">✗ 失败 ' + (rs.length - okN) + '</span>' : '') +
          ' → ' + esc(c.name) + '（' + connDesc(c) + '）';
        box.innerHTML = rs.map(function (r) {
          return '<div class="mat-result ' + (r.ok ? 'ok' : 'err') + '">' +
            '<span>' + (r.ok ? '✓' : '✗') + '</span>' +
            '<span class="mr-name">' + esc(r.model || '') + '</span>' +
            (r.ok ? '<span class="mr-note">建表成功</span>' : '<span class="mr-err">' + esc(r.error || '未知错误') + '</span>') +
            '</div>';
        }).join('');
        var btnDone = el('button', 'btn primary');
        btnDone.textContent = '关闭';
        btnDone.onclick = Dialogs.closeModal;
        setFoot([btnDone]);
        Dialogs.toast(okN === rs.length ? '物化成功：' + okN + ' 个模型已建表' : '物化完成：成功 ' + okN + ' / 失败 ' + (rs.length - okN), okN !== rs.length);
      }).catch(function (e) {
        bodyBox.querySelector('p.hint').innerHTML = '<span class="tag err">执行失败：' + esc(e.message) + '</span>';
        var btnBack = el('button', 'btn');
        btnBack.textContent = '← 上一步';
        btnBack.onclick = renderStep2;
        setFoot([btnBack]);
        Dialogs.toast('物化失败：' + e.message, true);
      });
    }

    Dialogs.openModal('⚡ 物化到数据库', wrap, [foot]);
    renderStep1();
  }

  // ================= 功能三：从数据库导入（表 → 模型） =================
  // introspect/detail 的表结构 → 前端模型（oltp: entity 全量映射；olap: ods 贴源精简）
  function tableToModel(t, connName, isOLTP) {
    var m = {
      id: '', layer: isOLTP ? 'entity' : 'ods',
      name: t.name || '', cnName: t.comment || '', desc: '',
      source: isOLTP ? '' : ('db://' + connName + '/' + (t.name || '')),
      notes: '', fields: [], partition: [], sources: [], where: '', groupBy: ''
    };
    (t.columns || []).forEach(function (c) {
      if (isOLTP) {
        var f = { name: c.name, type: c.type, comment: c.comment || '' };
        if (c.pk) f.pk = true;
        if (c.nullable === false) f.nullable = false;
        if (c.unique) f.unique = true;
        if (c.default !== undefined && c.default !== null && String(c.default) !== '') f.default = String(c.default);
        if (c.fk) f.fk = c.fk;
        m.fields.push(f);
      } else {
        var f2 = { name: c.name, type: c.type, comment: c.comment || '' };
        if (c.pk) f2.pk = true;
        m.fields.push(f2);
      }
    });
    if (isOLTP) {
      m.indexes = (t.indexes || []).map(function (ix) {
        return { name: ix.name, fields: (ix.fields || []).slice(), unique: !!ix.unique };
      });
    }
    return m;
  }

  // 「导入 SQL」弹窗的「从数据库导入」页签；footEl 为该页签专属的底部按钮容器
  function buildDbImportPane(footEl) {
    var Store = root.Store, Dialogs = root.Dialogs;
    var pane = el('div', 'db-import');
    var state = { conns: [], connId: 0, tables: [], models: null, connName: '' };

    function setFoot(nodes) {
      footEl.innerHTML = '';
      (nodes || []).forEach(function (n) { footEl.appendChild(n); });
    }
    function curConn() { return state.conns.filter(function (c) { return c.id === state.connId; })[0] || null; }

    pane.appendChild(el('p', 'hint',
      '选择数据库连接，勾选要导入的表，工作台将读取真实表结构（字段 / 主键 / 外键 / 索引 / 注释）转换为' +
      (Store.isOLTP() ? '<b>实体模型</b>（保留全部约束）' : '<b>ODS 贴源模型</b>（仅字段与注释，溯源标记 <span class="mono">db://连接/表</span>）') + '。'));

    // ---------- 连接选择 + 表清单 ----------
    var bar = el('div', 'db-import-bar');
    bar.innerHTML = '<label>数据库连接<select id="dbi-conn"><option value="">加载中…</option></select></label>';
    var btnReload = el('button', 'btn small');
    btnReload.textContent = '↻ 刷新表列表';
    bar.appendChild(btnReload);
    pane.appendChild(bar);

    var listBox = el('div');
    listBox.style.marginTop = '10px';
    pane.appendChild(listBox);

    var sel = bar.querySelector('#dbi-conn');
    sel.addEventListener('change', function () {
      state.connId = parseInt(sel.value, 10) || 0;
      loadTables();
    });
    btnReload.onclick = function () { if (state.connId) loadTables(); };

    function fillSel() {
      if (!state.conns.length) {
        sel.innerHTML = '<option value="">（暂无连接）</option>';
        listBox.innerHTML = '<p class="conn-empty">还没有数据库连接。请先在顶栏 <b>⋯ → 🔌 数据库连接</b> 中新建，再回到这里导入。</p>';
        setFoot([]);
        return;
      }
      sel.innerHTML = state.conns.map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === state.connId ? ' selected' : '') + '>' + esc(connOptionLabel(c)) + '</option>';
      }).join('');
      state.connId = parseInt(sel.value, 10) || 0;
    }

    function loadTables() {
      var c = curConn();
      if (!c) return;
      state.models = null;
      listBox.innerHTML = '<p class="hint small">正在读取 ' + esc(connDesc(c)) + ' 的表清单…</p>';
      setFoot([]);
      api.tables(state.connId).then(function (tables) {
        if (parseInt(sel.value, 10) !== state.connId) return; // 已切换连接
        state.tables = tables;
        renderTableList();
      }).catch(function (e) {
        listBox.innerHTML = '<p class="conn-empty">表清单读取失败：' + esc(e.message) + '</p>';
      });
    }

    function renderTableList() {
      var c = curConn();
      listBox.innerHTML = '';
      if (!state.tables.length) {
        listBox.appendChild(el('p', 'conn-empty', '该库里没有表。'));
        setFoot([]);
        return;
      }
      var head = el('div', 'db-list-head');
      head.innerHTML = '<label class="push-check-all"><input type="checkbox" id="dbi-all" checked><b>' + connBadge(c.kind) + ' 选择要导入的表</b></label><span class="hint small" id="dbi-count"></span>';
      var list = el('div', 'db-table-list');
      list.innerHTML = state.tables.map(function (t) {
        return '<label class="db-table-item"><input type="checkbox" data-tname="' + esc(t.name) + '" checked>' +
          '<span class="db-table-name">' + esc(t.name) + '</span>' +
          '<span class="db-table-comment">' + esc(t.comment || '') + '</span></label>';
      }).join('');
      listBox.appendChild(head);
      listBox.appendChild(list);

      function syncCount() {
        var n = list.querySelectorAll('input[data-tname]:checked').length;
        var total = state.tables.length;
        head.querySelector('#dbi-count').textContent = '已选 ' + n + ' / ' + total + ' 张表';
        head.querySelector('#dbi-all').checked = n === total;
        btnImport.textContent = '导入所选（' + n + '）';
        btnImport.disabled = !n;
      }
      list.addEventListener('change', syncCount);
      head.querySelector('#dbi-all').addEventListener('change', function () {
        var all = this.checked;
        list.querySelectorAll('input[data-tname]').forEach(function (cb) { cb.checked = all; });
        syncCount();
      });

      var btnImport = el('button', 'btn primary');
      btnImport.textContent = '导入所选';
      btnImport.onclick = loadDetail;
      setFoot([btnImport]);
      syncCount();

      function loadDetail() {
        var names = Array.prototype.map.call(list.querySelectorAll('input[data-tname]:checked'), function (cb) { return cb.dataset.tname; });
        if (!names.length) { Dialogs.toast('请至少选择一张表', true); return; }
        btnImport.disabled = true;
        btnImport.textContent = '读取表结构中…';
        api.detail(state.connId, names).then(function (tables) {
          var bad = tables.filter(function (t) { return t.error; });
          var good = tables.filter(function (t) { return !t.error; });
          if (bad.length) Dialogs.toast('部分表读取失败：' + bad.map(function (t) { return t.name + '（' + t.error + '）'; }).join('、'), true);
          if (!good.length) {
            btnImport.disabled = false;
            btnImport.textContent = '导入所选';
            return;
          }
          state.models = good.map(function (t) { return tableToModel(t, c.name, Store.isOLTP()); });
          renderPreview(good);
        }).catch(function (e) {
          btnImport.disabled = false;
          btnImport.textContent = '导入所选';
          Dialogs.toast('读取表结构失败：' + e.message, true);
        });
      }

      function renderPreview(good) {
        // 复用「粘贴 SQL」导入的预览表格样式
        listBox.innerHTML = '';
        var tbl = el('table', 'tbl preview-tbl');
        var isOLTP = Store.isOLTP();
        tbl.innerHTML = '<thead><tr><th></th><th>表名</th><th>层</th><th>字段数</th><th>主键</th><th>外键</th><th>索引</th><th>溯源</th></tr></thead>';
        var tb = el('tbody');
        state.models.forEach(function (m, i) {
          var pks = m.fields.filter(function (f) { return f.pk; }).map(function (f) { return f.name; });
          var fks = m.fields.filter(function (f) { return f.fk; });
          var tr = el('tr');
          tr.innerHTML =
            '<td><input type="checkbox" data-idx="' + i + '" checked></td>' +
            '<td class="mono">' + esc(m.name) + (Store.findByName(m.name) ? ' <span class="tag warn">将覆盖同名模型</span>' : '') + '</td>' +
            '<td><span class="mono">' + (isOLTP ? 'ENTITY' : 'ODS') + '</span></td>' +
            '<td class="center">' + m.fields.length + '</td>' +
            '<td class="mono small">' + esc(pks.join(', ') || '—') + '</td>' +
            '<td class="center">' + (fks.length ? fks.length + ' 条' : '<span class="dim">—</span>') + '</td>' +
            '<td class="center">' + (isOLTP && m.indexes.length ? m.indexes.length + ' 个' : '<span class="dim">' + (isOLTP ? '—' : '丢弃') + '</span>') + '</td>' +
            '<td class="mono small dim">' + esc(m.source || '—') + '</td>';
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        listBox.appendChild(el('p', 'hint small',
          '来自 ' + connBadge(c.kind) + ' ' + esc(connDesc(c)) + ' · ' + (isOLTP
            ? '字段 / 主键 / 外键 / 唯一 / 缺省值 / 索引 原样映射为实体'
            : '仅保留字段名 / 类型 / 注释 / 主键，其余约束丢弃（贴源层语义）')));
        listBox.appendChild(tbl);

        var btnBack = el('button', 'btn');
        btnBack.textContent = '← 重新选择';
        btnBack.onclick = function () { state.models = null; renderTableList(); };
        var btnConfirm = el('button', 'btn primary');
        btnConfirm.textContent = '✓ 确认导入';
        btnConfirm.onclick = function () {
          var checks = Array.prototype.slice.call(listBox.querySelectorAll('input[data-idx]:checked'));
          var created = 0, replaced = 0;
          checks.forEach(function (cb) {
            var m = state.models[+cb.dataset.idx];
            if (!m) return;
            var r = Store.importModel(m);
            if (r.created) created++; else replaced++;
          });
          Store.flushSave().catch(function () { });
          Dialogs.closeModal();
          root.App.refresh();
          Dialogs.toast('从数据库导入完成：新建 ' + created + '、覆盖 ' + replaced);
        };
        setFoot([btnBack, btnConfirm]);
      }
    }

    // 初始化：拉连接 → 默认选中第一个 → 拉表
    api.list().then(function (conns) {
      state.conns = conns;
      if (conns.length) state.connId = conns[0].id;
      fillSel();
      if (state.connId) loadTables();
    }).catch(function (e) {
      state.conns = [];
      fillSel();
      listBox.innerHTML = '<p class="conn-empty">连接列表加载失败：' + esc(e.message) + '（需通过服务端访问）</p>';
    });

    return pane;
  }

  function connBadge(kind) { return '<span class="kind-badge ' + esc(kind) + '">' + esc(kindLabel(kind)) + '</span>'; }

  // pickConnection(cb, title)：弹小窗选择一个连接（物化/对比共用）
  function pickConnection(cb, title) {
    var conns = [];
    api.list().then(function (list) {
      conns = list || [];
      var w = document.createElement('div');
      if (!conns.length) {
        w.innerHTML = '<p>暂无数据库连接，先在 ⋯ 菜单「数据库连接」中创建。</p>';
        Dialogs.openModal(title || '选择连接', w, [{ label: '关闭' }]);
        return;
      }
      var h = '<div class="conn-pick-list">';
      conns.forEach(function (c) {
        h += '<button class="btn conn-pick-item" data-cid="' + c.id + '">' + connBadge(c.kind) + esc(c.name) +
          '<span class="hint">' + esc(c.host + ':' + c.port + '/' + c.database) + '</span></button>';
      });
      h += '</div>';
      w.innerHTML = h;
      Dialogs.openModal(title || '选择连接', w, [{ label: '取消' }]);
      w.querySelectorAll('.conn-pick-item').forEach(function (b) {
        b.onclick = function () {
          var id = parseInt(b.dataset.cid, 10);
          Dialogs.closeModal();
          cb(conns.filter(function (c) { return c.id === id; })[0]);
        };
      });
    });
  }

  root.Materialize = {
    KINDS: KINDS,
    api: api,
    openConnectionsDialog: openConnectionsDialog,
    openMaterializeDialog: openMaterializeDialog,
    buildDbImportPane: buildDbImportPane,
    buildStatements: buildStatements,
    tableToModel: tableToModel,
    pickConnection: pickConnection
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
