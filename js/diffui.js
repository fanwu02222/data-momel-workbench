// DIFF 与预览的前端 UI（挂 Materialize 体系旁）
(function (root) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  // ---------- 差异同步面板 ----------
  function openDiffPanel(connectionId) {
    var wrap = document.createElement('div');
    wrap.className = 'diff-panel';
    wrap.innerHTML =
      '<p class="hint small">逐表对比「当前项目模型」与目标库真实结构，生成可执行的 ALTER 语句。' +
      '⚠ 库中多余字段（模型未定义）默认不勾选，执行 DROP 将丢失数据。</p>' +
      '<div class="diff-actions"><button class="btn small primary" id="diff-exec">⚡ 执行勾选项</button>' +
      '<span class="hint small" id="diff-summary">对比中…</span></div>' +
      '<div class="diff-list" id="diff-list"></div>';
    root.Dialogs.openModal('结构对比（差异同步）', wrap, [{ label: '关闭' }]);

    var models = root.Store.getModels();
    var listEl = wrap.querySelector('#diff-list');
    var summaryEl = wrap.querySelector('#diff-summary');
    var pending = models.length, totalChanges = 0;

    models.forEach(function (m) {
      var item = document.createElement('div');
      item.className = 'diff-item';
      item.innerHTML = '<div class="diff-item-head mono">' + esc(m.name || '?') + ' <span class="hint">对比中…</span></div>';
      listEl.appendChild(item);
      fetch('/api/diff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectionId, model: m })
      }).then(function (r) { return r.json(); }).then(function (d) {
        pending--;
        var head = item.querySelector('.diff-item-head span');
        if (!d || d.error) { head.textContent = '❌ ' + (d && d.error || '对比失败'); return; }
        if (!d.exists) { head.textContent = '库中不存在（用「物化到库」创建）'; return; }
        var changes = d.changes || [];
        totalChanges += changes.length;
        if (!changes.length) { head.textContent = '✓ 无差异'; head.className = 'hint'; return; }
        head.textContent = changes.length + ' 项差异';
        changes.forEach(function (c) {
          var row = document.createElement('label');
          row.className = 'diff-row' + (c.risky ? ' risky' : '');
          row.innerHTML =
            '<input type="checkbox" data-sql="' + escAttr(c.sql || '') + '"' + (c.risky ? '' : ' checked') + '>' +
            '<span class="diff-desc">' + esc(c.desc || '') + '</span>' +
            '<code class="diff-sql mono">' + esc(c.sql || '') + '</code>';
          item.appendChild(row);
        });
        if (pending === 0) summaryEl.textContent = '共 ' + totalChanges + ' 项差异';
      }).catch(function (e) {
        pending--;
        item.querySelector('.diff-item-head span').textContent = '❌ ' + e.message;
      });
    });

    wrap.querySelector('#diff-exec').onclick = function () {
      var boxes = Array.prototype.slice.call(wrap.querySelectorAll('.diff-row input:checked'));
      if (!boxes.length) { root.Dialogs.toast('未勾选任何变更', true); return; }
      if (!confirm('对目标库执行 ' + boxes.length + ' 条 ALTER 语句？')) return;
      var stmts = [];
      boxes.forEach(function (b) {
        var sql = b.getAttribute('data-sql');
        sql.split(/;\s*\n/).forEach(function (s) {
          s = s.trim().replace(/;+$/, '');
          if (s) stmts.push({ model: 'diff', sql: s + ';' });
        });
      });
      fetch('/api/materialize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectionId, statements: stmts })
      }).then(function (r) { return r.json(); }).then(function (d) {
        var ok = (d.results || []).filter(function (x) { return x.ok; }).length;
        var fail = (d.results || []).filter(function (x) { return !x.ok; });
        root.Dialogs.toast('执行完成：成功 ' + ok + ' / 失败 ' + fail.length);
      });
    };
  }

  // ---------- 数据预览面板 ----------
  function openPreviewPanel(connectionId, table, limit) {
    var wrap = document.createElement('div');
    wrap.innerHTML = '<div class="hint">读取 ' + esc(table || '') + ' 数据中…</div>';
    root.Dialogs.openModal('数据预览：' + (table || ''), wrap, [{ label: '关闭' }]);
    fetch('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connectionId, table: table, limit: limit || 100 })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) {
        wrap.innerHTML = '<div class="warn-box">❌ ' + esc(d.error) + '</div>';
        return;
      }
      var cols = d.columns || [], rows = d.rows || [];
      var h = '<p class="hint small">' + esc(table) + ' · ' + rows.length + ' 行</p>';
      h += '<div class="preview-table-wrap"><table class="preview-table"><thead><tr>';
      cols.forEach(function (c) { h += '<th class="mono">' + esc(c) + '</th>'; });
      h += '</tr></thead><tbody>';
      rows.forEach(function (row) {
        h += '<tr>';
        row.forEach(function (v) { h += '<td class="mono">' + (v === 'NULL' ? '<span class="hint">NULL</span>' : esc(v)) + '</td>'; });
        h += '</tr>';
      });
      h += '</tbody></table></div>';
      wrap.innerHTML = h;
    }).catch(function (e) {
      wrap.innerHTML = '<div class="warn-box">❌ ' + esc(e.message) + '</div>';
    });
  }

  root.MatExt = { openDiffPanel: openDiffPanel, openPreviewPanel: openPreviewPanel };
})(typeof globalThis !== 'undefined' ? globalThis : this);
