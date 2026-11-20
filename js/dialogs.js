/**
 * 对话框：SQL 导入（反解析）、项目校验、DSH 任务生成、JSON 导入导出
 */
(function (root) {
  'use strict';
  var Store = root.Store, SQLParse = root.SQLParse, SQLGen = root.SQLGen, Lineage = root.Lineage;

  // 显式保存动作（模版/自定义列）同步服务端；离线时静默降级到浏览器存储
  function syncServer() { Store.saveToServer().catch(function () { }); }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var modalRoot;
  function ensureRoot() {
    if (!modalRoot) modalRoot = document.getElementById('modal-root');
    return modalRoot;
  }
  function openModal(title, bodyEl, actions) {
    var root = ensureRoot();
    root.innerHTML = '';
    var backdrop = el('div', 'modal-backdrop');
    var box = el('div', 'modal');
    var head = el('div', 'modal-head');
    head.appendChild(el('h3', '', esc(title)));
    var close = el('button', 'modal-close');
    close.textContent = '✕';
    close.onclick = closeModal;
    head.appendChild(close);
    var body = el('div', 'modal-body');
    body.appendChild(bodyEl);
    box.appendChild(head); box.appendChild(body);
    if (actions && actions.length) {
      var foot = el('div', 'modal-foot');
      actions.forEach(function (a) {
        var b;
        if (a && a.nodeType === 1) { b = a; } // 已构建好的按钮节点直接使用
        else {
          b = el('button', 'btn ' + (a.cls || ''));
          b.textContent = a.label || '';
          b.onclick = a.onClick;
        }
        foot.appendChild(b);
      });
      box.appendChild(foot);
    }
    backdrop.appendChild(box);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) closeModal(); });
    root.appendChild(backdrop);
  }
  function closeModal() { if (modalRoot) modalRoot.innerHTML = ''; }

  function toast(msg, isErr) {
    var t = el('div', 'toast' + (isErr ? ' err' : ''));
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }

  // ================= SQL 导入（反解析） =================
  function openImportSQL() {
    var wrap = el('div', 'import-dialog');
    var intro = el('p', 'hint',
      '粘贴 <b>CREATE TABLE</b>（含字段/注释/分区）、<b>CREATE TABLE ... AS SELECT</b> 或 <b>INSERT INTO/OVERWRITE ... SELECT</b> 语句，<br>工作台将反解析为数仓模型（自动识别分层、字段、业务逻辑与血缘）。支持一次粘贴多条语句。');
    wrap.appendChild(intro);
    var ta = el('textarea', 'sql-input mono');
    ta.rows = 12;
    ta.placeholder = "CREATE TABLE IF NOT EXISTS dwd_order_info_di (\n  `order_id` BIGINT COMMENT '订单ID',\n  ...\n) COMMENT '订单明细事实表'\nPARTITIONED BY (`dt` STRING)\nAS SELECT ...;\n\nINSERT OVERWRITE TABLE dws_trade_shop_order_1d PARTITION (dt)\nSELECT o.shop_id, count(1) AS order_count, ...\nFROM dwd_order_info_di o GROUP BY o.shop_id, o.dt;";
    wrap.appendChild(ta);
    var previewBox = el('div', 'import-preview');
    wrap.appendChild(previewBox);

    var parsed = null;
    var btnParse = el('button', 'btn');
    btnParse.textContent = '① 解析预览';
    btnParse.onclick = function () {
      var sqlText = ta.value.trim();
      if (!sqlText) { toast('请先粘贴 SQL', true); return; }
      try {
        parsed = SQLParse.parseSQL(sqlText);
        renderPreview(previewBox, parsed);
        if (!parsed.length) toast('未能解析出任何模型，请检查语句', true);
        else toast('解析出 ' + parsed.length + ' 个模型');
      } catch (err) {
        toast('解析失败：' + err.message, true);
      }
    };
    var btnImport = el('button', 'btn primary');
    btnImport.textContent = '② 导入项目';
    btnImport.onclick = function () {
      if (!parsed || !parsed.length) { toast('请先点击「解析预览」', true); return; }
      var checks = Array.prototype.slice.call(previewBox.querySelectorAll('input[data-idx]:checked'));
      var created = 0, replaced = 0, skipped = 0;
      checks.forEach(function (c) {
        var item = parsed[+c.dataset.idx];
        if (!item) return;
        var layerSel = previewBox.querySelector('select[data-layer="' + c.dataset.idx + '"]');
        if (layerSel) item.model.layer = layerSel.value;
        var r = Store.importModel(item.model);
        if (r.created) created++; else replaced++;
      });
      skipped = parsed.length - created - replaced;
      closeModal();
      App.refresh();
      toast('导入完成：新建 ' + created + '、覆盖 ' + replaced + (skipped ? '、跳过 ' + skipped : ''));
    };
    openModal('SQL 反解析导入', wrap, [btnParse, btnImport]);
  }

  function renderPreview(box, parsed) {
    box.innerHTML = '';
    var tbl = el('table', 'tbl preview-tbl');
    tbl.innerHTML = '<thead><tr><th></th><th>表名</th><th>层</th><th>字段数</th><th>分区</th><th>源表映射</th><th>业务逻辑字段</th></tr></thead>';
    var tb = el('tbody');
    parsed.forEach(function (r, i) {
      var m = r.model;
      var tr = el('tr');
      var logicCount = (m.fields || []).filter(function (f) { return f.expr; }).length;
      tr.innerHTML =
        '<td><input type="checkbox" data-idx="' + i + '" checked></td>' +
        '<td class="mono">' + esc(m.name) + (Store.findByName(m.name) ? ' <span class="tag warn">将覆盖同名模型</span>' : '') + '</td>' +
        '<td><select data-layer="' + i + '">' + ['ods', 'dim', 'dwd', 'dws', 'ads'].map(function (ly) {
          return '<option value="' + ly + '"' + (m.layer === ly ? ' selected' : '') + '>' + ly.toUpperCase() + '</option>';
        }).join('') + '</select></td>' +
        '<td class="center">' + (m.fields || []).length + '</td>' +
        '<td class="center">' + ((m.partition || []).map(function (p) { return esc(p.name); }).join(', ') || '—') + '</td>' +
        '<td class="mono small">' + esc((m.sources || []).map(function (s) { return s.name || s.alias; }).join(' / ') || '—') + '</td>' +
        '<td class="center">' + (logicCount ? logicCount + ' 个表达式' : '<span class="dim">无</span>') + '</td>';
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    box.appendChild(tbl);
  }

  // ================= 项目校验 =================
  function openCheck() {
    var problems = [];
    var models = Store.getModels();
    var nameSeen = {};
    models.forEach(function (m) {
      var label = (m.layer || '?').toUpperCase() + ' · ' + (m.name || '（未命名）');
      if (!m.name) problems.push({ level: 'error', m: m, msg: '表名为空' });
      else {
        if (nameSeen[m.name]) problems.push({ level: 'error', m: m, msg: '表名与 ' + nameSeen[m.name] + ' 重复' });
        nameSeen[m.name] = label;
        var pref = detectPrefix(m.name);
        if (pref && pref !== m.layer) problems.push({ level: 'warn', m: m, msg: '表名前缀 ' + pref + ' 与所属层 ' + m.layer.toUpperCase() + ' 不一致' });
        if (!m.cnName) problems.push({ level: 'warn', m: m, msg: '缺少中文名' });
      }
      var fseen = {};
      (m.fields || []).concat(m.partition || []).forEach(function (f) {
        if (!f.name) { problems.push({ level: 'error', m: m, msg: '存在空字段名' }); return; }
        if (fseen[f.name]) problems.push({ level: 'error', m: m, msg: '字段名重复：' + f.name });
        fseen[f.name] = true;
        if (!f.comment) problems.push({ level: 'info', m: m, msg: '字段「' + f.name + '」缺少注释' });
      });
      if (m.layer !== 'ods') {
        var noExpr = (m.fields || []).filter(function (f) { return !f.expr; }).length;
        if ((m.fields || []).length && noExpr === m.fields.length && !(m.sources || []).length) {
          problems.push({ level: 'info', m: m, msg: '非 ODS 层模型既无源表映射也无字段表达式（可能是手工定义的维表/手工任务）' });
        } else if (noExpr) {
          problems.push({ level: 'info', m: m, msg: noExpr + ' 个字段未填写业务逻辑表达式（将按同名字段直取）' });
        }
        if (!(m.sources || []).length) problems.push({ level: 'warn', m: m, msg: '非 ODS 层缺少源表映射，无法生成 ETL 语句' });
      }
      // 血缘解析
      var lin = Lineage.computeFieldLineage(Store.project, m);
      lin.warnings.forEach(function (w) { problems.push({ level: 'warn', m: m, msg: w }); });
    });
    // 依赖环检测
    var topo = SQLGen.topoSort(models);
    if (topo.cycleWarn.length) problems.push({ level: 'error', m: null, msg: '存在循环依赖，涉及：' + topo.cycleWarn.join('、') });

    var wrap = el('div');
    var counts = { error: 0, warn: 0, info: 0 };
    problems.forEach(function (p) { counts[p.level]++; });
    wrap.appendChild(el('p', 'hint',
      '检查结果：<span class="tag err">错误 ' + counts.error + '</span> <span class="tag warn">警告 ' + counts.warn + '</span> <span class="tag">提示 ' + counts.info + '</span>'));
    var list = el('div', 'check-list');
    if (!problems.length) list.appendChild(el('p', 'ok-msg', '✅ 全部检查通过，模型规范良好！'));
    problems.forEach(function (p) {
      var item = el('div', 'check-item ' + p.level);
      var icon = p.level === 'error' ? '⛔' : p.level === 'warn' ? '⚠️' : '💡';
      var scope = p.m ? '[' + (p.m.layer || '').toUpperCase() + '] ' + esc(p.m.name || '未命名') + '：' : '';
      item.innerHTML = '<span>' + icon + '</span><div><b>' + scope + '</b>' + esc(p.msg) + '</div>';
      if (p.m) {
        var go = el('button', 'btn small');
        go.textContent = '定位';
        go.onclick = function () { Store.selectedId = p.m.id; closeModal(); App.refresh(); };
        item.appendChild(go);
      }
      list.appendChild(item);
    });
    wrap.appendChild(list);
    openModal('模型规范校验', wrap);
  }
  function detectPrefix(name) {
    var m = /^([a-z]+)_/.exec(name || '');
    if (!m) return null;
    var p = m[1].toLowerCase();
    return ['ods', 'dim', 'dwd', 'dws', 'ads'].indexOf(p) >= 0 ? p : null;
  }

  // ================= DSH 任务 =================
  var API_NOTE = '项目数据读取：curl -s http://127.0.0.1:8130/api/project（返回 JSON：{name, dialect, models:[...]}）。修改完成后用 PUT 写回：curl -X PUT -H "Content-Type: application/json" -d @新文件.json http://127.0.0.1:8130/api/project（body 必须是完整项目 JSON，服务端会整体替换并事务入库）。\n';

  var DSH_TEMPLATES = {
    fill_comments: {
      name: '为缺失字段批量补充中文注释',
      prompt: function () {
        return API_NOTE +
          '这是一次数仓治理任务：\n' +
          '1. 找出所有 fields 中 comment 为空的字段；\n' +
          '2. 结合表名、层（ods/dim/dwd/dws/ads）、字段名、表达式（expr）和中文上下文，推断字段业务含义，补写简洁的中文 comment；\n' +
          '3. 同时为缺少 cnName / desc 的模型补全；\n' +
          '4. 保持 JSON 结构与其它字段不变，PUT 写回。\n' +
          '注意：只改注释类字段，不要改动 name/type/expr/血缘结构。完成后汇报补充了多少条注释。';
      }
    },
    naming_check: {
      name: '深度命名与规范审查（输出报告）',
      prompt: function () {
        return API_NOTE +
          '基于读取的数据做一次深度规范审查并输出报告到 docs/模型审查报告.md：\n' +
          '1. 分层职责检查：ODS 是否有加工逻辑、DIM 是否一致性维度（有无被 ADS 绕过直接关联 ODS）、DWD 是否做清洗、DWS 是否轻度聚合、ADS 是否面向应用；\n' +
          '2. 命名规范：表名前缀与分层一致性、字段命名风格（snake_case）、分区规范（dt）；\n' +
          '3. 血缘合理性：跨层引用（如 ADS 直接引用 ODS）、同类字段在不同层口径是否一致；\n' +
          '4. 公共维度缺失检测（如缺少 dim_ 前缀的维度表建议）。\n' +
          '报告用中文，按严重程度分组，给出具体修改建议（表.字段级别）。此任务只读数据 + 写报告文件，不需要 PUT 写回。';
      }
    },
    gen_dict: {
      name: '生成数据字典文档（Markdown）',
      prompt: function () {
        return API_NOTE +
          '生成一份完整的数据字典 docs/数据字典.md：\n' +
          '- 按 ods/dim/dwd/dws/ads 分层组织；\n' +
          '- 每个模型包含：表名、中文名、描述、字段清单（字段名/类型/注释/主键/业务逻辑表达式）、分区、源表映射、WHERE/GROUP BY；\n' +
          '- 末尾附「表级血缘清单」：每行 源表 → 目标表。\n' +
          '文档用中文。此任务只读数据 + 写文档文件，不需要 PUT 写回。';
      }
    },
    batch_sql_import: {
      name: '批量反解析 sql/ 目录下的 SQL 文件入库',
      prompt: function () {
        return API_NOTE +
          '请扫描当前目录下 sql/ 目录里的所有 .sql 文件（如不存在请说明），把它们反解析为数仓模型并合并进项目：\n' +
          '- 每条 CREATE TABLE（含 COMMENT/PARTITIONED BY）解析出字段/类型/注释/分区；\n' +
          '- CTAS / INSERT INTO ... SELECT 解析出源表映射（FROM/JOIN+别名）、字段表达式（业务逻辑）、WHERE、GROUP BY、动态分区；\n' +
          '- 按表名前缀 ods_/dim_/dwd_/dws_/ads_ 自动归层；\n' +
          '- 与已有同名模型则覆盖其定义，否则追加；保持其它模型不变；\n' +
          '- 模型结构：{id, layer, name, cnName, desc, source, notes, fields:[{name,type,comment,pk,expr}], partition:[{name,type,comment,expr}], sources:[{name,alias,on}], where, groupBy}。\n' +
          '合并完成后将完整 JSON PUT 写回，并输出：解析了几个文件、新建/覆盖了几个模型的清单。';
      }
    },
    etl_plan: {
      name: '为指定模型设计 ETL 调度方案',
      prompt: function () {
        var m = Store.find(Store.selectedId);
        return API_NOTE +
          '围绕模型 ' + (m ? m.name : '（我接下来指定）') + ' 设计完整 ETL 方案：\n' +
          '- 依据其依赖链（递归展开上游模型）给出调度顺序（DAG）；\n' +
          '- 每个任务给出：目标表、上游依赖、调度周期建议、增量/全量策略、失败重试与数据质量校验点（行数波动、主键重复、空值率）；\n' +
          '- 输出为 docs/etl调度方案-' + (m ? m.name : 'model') + '.md，中文。此任务只读数据 + 写文档文件，不需要 PUT 写回。';
      }
    }
  };

  function openDSH() {
    var wrap = el('div', 'dsh-dialog');
    wrap.appendChild(el('p', 'hint',
      '复杂或批量的工作可以交给 <b>DSH 智能体</b>在本项目目录执行：它能通过 API 直接读写项目数据（SQLite 存储），执行脚本与生成文档。<br>选择任务模板 → 复制提示词 → 在终端运行 <span class="mono">dsh</span>（或使用现有 DSH 会话）粘贴发送即可。<br>数据读取：<span class="mono">curl http://127.0.0.1:8130/api/project</span>　写回：<span class="mono">PUT</span> 同地址（完整 JSON）'));
    var sel = el('select', 'dsh-select');
    Object.keys(DSH_TEMPLATES).forEach(function (k, i) {
      var o = el('option');
      o.value = k; o.textContent = DSH_TEMPLATES[k].name;
      sel.appendChild(o);
    });
    var ta = el('textarea', 'mono dsh-prompt');
    ta.rows = 12;
    function refreshPrompt() { ta.value = DSH_TEMPLATES[sel.value].prompt(); }
    sel.onchange = refreshPrompt;
    refreshPrompt();
    var stats = Store.getModels().length;
    wrap.appendChild(el('label', 'form-label', '任务模板'));
    wrap.appendChild(sel);
    wrap.appendChild(el('label', 'form-label', '生成的提示词（可编辑后复制）'));
    wrap.appendChild(ta);
    wrap.appendChild(el('p', 'hint small', '当前项目：' + esc(Store.project.name) + ' · ' + stats + ' 个模型 · 存储 workbench.db（SQLite）'));

    var btnCopy = el('button', 'btn primary');
    btnCopy.textContent = '复制提示词';
    btnCopy.onclick = function () {
      ta.select();
      try { document.execCommand('copy'); toast('已复制，请在 DSH 会话中粘贴执行'); }
      catch (e) { toast('复制失败，请手动选择复制', true); }
    };
    var btnExec = el('button', 'btn');
    btnExec.textContent = '直接调用 DSH 执行';
    btnExec.title = '通过本工作台本地服务以 headless 模式调用 DSH（任务在后台运行，完成后自动刷新项目）';
    btnExec.onclick = function () {
      if (btnExec.disabled) return;
      btnExec.disabled = true;
      btnExec.textContent = 'DSH 执行中…';
      var outBox = wrap.querySelector('.dsh-output');
      if (!outBox) { outBox = el('pre', 'mono dsh-output'); wrap.appendChild(outBox); }
      outBox.textContent = '▶ 已启动 DSH 任务（headless 模式），等待输出…\n';
      var scroll = outBox; scroll.scrollTop = scroll.scrollHeight;
      var timer = null;
      function poll(jobId) {
        fetch('/api/dsh/status?id=' + encodeURIComponent(jobId)).then(function (r) { return r.json(); }).then(function (d) {
          outBox.textContent = (d.output || '(等待输出…)') + '\n[状态] ' + d.status;
          outBox.scrollTop = outBox.scrollHeight;
          if (d.status === 'running') { timer = setTimeout(function () { poll(jobId); }, 2500); return; }
          btnExec.disabled = false;
          btnExec.textContent = '直接调用 DSH 执行';
          if (d.projectChanged) {
            Store.load(function () { App.refresh(); toast('DSH 任务完成，检测到 project.json 已更新，工作台已刷新'); });
          } else {
            toast(d.status === 'done' ? 'DSH 任务完成（未改动项目文件）' : 'DSH 任务结束：' + d.status, d.status !== 'done');
          }
        }).catch(function (e) {
          btnExec.disabled = false;
          btnExec.textContent = '直接调用 DSH 执行';
          outBox.textContent += '\n[轮询失败] ' + e.message;
          toast('轮询任务状态失败：' + e.message, true);
        });
      }
      fetch('/api/dsh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: ta.value })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error || '启动失败');
        poll(d.jobId);
      }).catch(function (e) {
        btnExec.disabled = false;
        btnExec.textContent = '直接调用 DSH 执行';
        toast('无法调用本地服务：' + e.message + '（请确认通过 node server.js 启动）', true);
      });
    };
    openModal('DSH 智能体任务', wrap, [btnCopy, btnExec]);
  }

  // ================= SQL 模板编辑 =================
  function openTemplateEditor() {
    var state = { dialect: Store.project.dialect || 'hive', kind: 'ddl' };
    var wrap = el('div', 'tpl-dialog');
    var bar = el('div', 'tpl-bar');
    bar.innerHTML =
      '<label>方言 <select id="tpl-dialect">' + SQLGen.DIALECTS.map(function (d) {
        return '<option value="' + d + '"' + (d === state.dialect ? ' selected' : '') + '>' + SQLGen.dialectName(d) + '</option>';
      }).join('') + '</select></label>' +
      '<label>类型 <select id="tpl-kind"><option value="ddl">建表 DDL</option><option value="dml">ETL DML</option></select></label>' +
      '<span class="tpl-state tag"></span>';
    wrap.appendChild(bar);
    wrap.appendChild(el('p', 'hint',
      '自定义 SQL 生成模板，支持 <span class="mono">{{变量}}</span> 插值与 <span class="mono">{{if:变量}}…{{/if}}</span> 条件块（变量有值时才渲染内部）。点击下方变量名可插入到光标处。仅对当前项目生效，随项目一起保存。'));
    var ta = el('textarea', 'sql-input mono tpl-input');
    ta.rows = 14;
    wrap.appendChild(ta);
    var chips = el('div', 'tpl-vars');
    wrap.appendChild(chips);
    var previewHead = el('div', 'tpl-preview-head');
    previewHead.innerHTML = '<b>实时预览</b><span class="hint"></span>';
    wrap.appendChild(previewHead);
    var preview = el('pre', 'mono dsh-output tpl-preview');
    wrap.appendChild(preview);

    function modelForPreview() {
      return Store.find(Store.selectedId) || Store.getModels().filter(function (m) { return m.layer !== 'ods'; })[0] || Store.getModels()[0] || null;
    }
    function refreshVars() {
      chips.innerHTML = '';
      SQLGen.TEMPLATE_VARS[state.kind].forEach(function (v) {
        var chip = el('button', 'tpl-var mono');
        chip.textContent = '{{' + v.key + '}}';
        chip.title = v.desc;
        chip.onclick = function () {
          var pos = ta.selectionStart || ta.value.length;
          var ins = '{{' + v.key + '}}';
          ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(ta.selectionEnd || pos);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + ins.length;
          updatePreview();
        };
        chips.appendChild(chip);
      });
    }
    function refreshState() {
      var custom = Store.project.sqlTemplates && Store.project.sqlTemplates[state.kind] && String(Store.project.sqlTemplates[state.kind][state.dialect] || '').trim();
      var st = wrap.querySelector('.tpl-state');
      st.textContent = custom ? '自定义模板' : '内置默认模板';
      st.className = 'tpl-state tag ' + (custom ? 'warn' : '');
    }
    function updatePreview() {
      var m = modelForPreview();
      if (!m) { preview.textContent = '（项目中暂无模型，无法预览）'; return; }
      preview.textContent = SQLGen.previewTemplate(m, state.dialect, state.kind, ta.value) || '（空输出）';
      previewHead.querySelector('.hint').textContent = '预览对象：' + (m.name || '未命名');
    }
    function loadCurrent() {
      ta.value = SQLGen.getTemplate(Store.project, state.kind, state.dialect);
      refreshState();
      refreshVars();
      updatePreview();
    }
    bar.querySelector('#tpl-dialect').onchange = function () { state.dialect = this.value; loadCurrent(); };
    bar.querySelector('#tpl-kind').onchange = function () { state.kind = this.value; loadCurrent(); };
    ta.addEventListener('input', updatePreview);
    loadCurrent();

    var actions = [
      {
        label: '恢复内置默认', onClick: function () {
          Store.project.sqlTemplates = Store.project.sqlTemplates || { ddl: {}, dml: {} };
          Store.project.sqlTemplates[state.kind] = Store.project.sqlTemplates[state.kind] || {};
          Store.project.sqlTemplates[state.kind][state.dialect] = '';
          Store.touch();
          syncServer();
          loadCurrent();
          toast('已恢复内置默认模板');
        }
      },
      {
        label: '保存模版', cls: 'primary', onClick: function () {
          Store.project.sqlTemplates = Store.project.sqlTemplates || { ddl: {}, dml: {} };
          Store.project.sqlTemplates[state.kind] = Store.project.sqlTemplates[state.kind] || {};
          Store.project.sqlTemplates[state.kind][state.dialect] = ta.value;
          Store.touch();
          syncServer();
          refreshState();
          toast('已保存 ' + SQLGen.dialectName(state.dialect) + ' ' + (state.kind === 'ddl' ? 'DDL' : 'DML') + ' 模板');
        }
      }
    ];
    openModal('SQL 生成模板', wrap, actions);
  }

  // ================= 自定义扩展列管理 =================
  function manageCols(scope) {
    var scopeName = scope === 'model' ? '表定义' : '字段定义';
    var wrap = el('div', 'col-manage');
    var hint = el('p', 'hint',
      scope === 'model'
        ? '为每张表的元信息增加自定义属性列（如：责任人、主题域、更新频率）。添加后会出现在「表信息」中。'
        : '为字段表格增加自定义列（如：敏感等级、脱敏规则、来源系统）。删除列仅隐藏，已填写的数据保留。');
    wrap.appendChild(hint);
    var list = el('div', 'col-list');
    wrap.appendChild(list);
    function renderList() {
      list.innerHTML = '';
      var cols = Store.getCustomCols(scope);
      if (!cols.length) { list.appendChild(el('p', 'hint', '暂无自定义列。')); return; }
      cols.forEach(function (c) {
        var row = el('div', 'col-row');
        row.innerHTML = '<span class="mono dim">' + esc(c.key) + '</span><b>' + esc(c.label) + '</b>';
        var del = el('button', 'btn small');
        del.textContent = '删除';
        del.onclick = function () { Store.removeCustomCol(scope, c.key); syncServer(); renderList(); };
        row.appendChild(del);
        list.appendChild(row);
      });
    }
    renderList();
    var addRow = el('div', 'col-add-row');
    var input = el('input', 'col-input');
    input.placeholder = '新列名，如：责任人 / 敏感等级';
    var add = el('button', 'btn primary small');
    add.textContent = '＋ 添加列';
    add.onclick = function () {
      var r = Store.addCustomCol(scope, input.value);
      if (!r) { toast('列名为空或已存在', true); return; }
      input.value = '';
      syncServer();
      renderList();
      toast('已添加自定义列：' + r.label);
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') add.click(); });
    addRow.appendChild(input);
    addRow.appendChild(add);
    wrap.appendChild(addRow);
    openModal(scopeName + ' · 自定义列', wrap);
  }

  // ================= Excel 导入 =================
  function importExcel() {
    var mode = 'merge';
    var wrap = el('div', 'import-dialog');
    wrap.appendChild(el('p', 'hint',
      '选择本工作台导出的 <span class="mono">.xlsx</span> 数据字典导入。两种模式：<br>' +
      '<b>合并导入</b>——Excel 里的模型按表名覆盖/追加，其余保持不变（推荐，可从同事处合并数据）；<br>' +
      '<b>替换整库</b>——用 Excel 完整重建项目（当前所有模型会被清除）。'));
    var bar = el('div', 'form-grid');
    bar.style.marginTop = '8px';
    bar.innerHTML =
      '<label>导入模式<select id="ie-mode"><option value="merge">合并导入（推荐）</option><option value="replace">替换整库</option></select></label>' +
      '<label>Excel 文件<input type="file" id="ie-file" accept=".xlsx"></label>';
    wrap.appendChild(bar);
    var statusBox = el('div', 'hint');
    wrap.appendChild(statusBox);
    var startBtn = el('button', 'btn primary');
    startBtn.textContent = '开始导入';
    startBtn.onclick = function () {
      var fileInput = wrap.querySelector('#ie-file');
      var f = fileInput.files && fileInput.files[0];
      if (!f) { toast('请先选择 .xlsx 文件', true); return; }
      if (f.size > 20 * 1024 * 1024) { toast('文件超过 20MB 上限', true); return; }
      var useMode = wrap.querySelector('#ie-mode').value;
      statusBox.textContent = '导入中…';
      startBtn.disabled = true;
      fetch('/api/import/excel?mode=' + useMode, { method: 'POST', body: f })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { statusBox.textContent = '导入失败：' + d.error; toast('导入失败：' + d.error, true); return; }
          Store.project = d.project;
          Store.normalize();
          Store.selectedId = Store.project.models.length ? Store.project.models[0].id : null;
          Store.touch();
          if (useMode === 'merge') Store.saveToServer().catch(function () { });
          closeModal();
          App.refresh();
          var desc = [];
          if (d.added && d.added.length) desc.push('新增 ' + d.added.length);
          if (d.updated && d.updated.length) desc.push('更新 ' + d.updated.length);
          toast('Excel 导入完成：' + (desc.join('、') || '共 ' + d.total + ' 个模型'));
        })
        .catch(function (e) {
          startBtn.disabled = false;
          statusBox.textContent = '导入失败：' + e.message;
          toast('导入失败：' + e.message + '（需通过 node server.js 启动）', true);
        });
    };
    openModal('导入 Excel 数据字典', wrap, [startBtn]);
  }

  // ================= JSON 导入导出 =================
  function exportJSON() {
    var blob = new Blob([JSON.stringify(Store.project, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'project.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 project.json');
  }
  function importJSON() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    inp.onchange = function () {
      var f = inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var p = JSON.parse(fr.result);
          if (!p || !Array.isArray(p.models)) throw new Error('格式不符：缺少 models 数组');
          Store.project = p;
          Store.normalize();
          Store.selectedId = p.models.length ? p.models[0].id : null;
          Store.touch();
          App.refresh();
          toast('导入成功：' + p.models.length + ' 个模型');
        } catch (e) { toast('导入失败：' + e.message, true); }
      };
      fr.readAsText(f);
    };
    inp.click();
  }

  root.Dialogs = {
    openImportSQL: openImportSQL,
    openCheck: openCheck,
    openDSH: openDSH,
    manageCols: manageCols,
    openTemplateEditor: openTemplateEditor,
    importExcel: importExcel,
    exportJSON: exportJSON,
    importJSON: importJSON,
    openModal: openModal,
    closeModal: closeModal,
    toast: toast
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
