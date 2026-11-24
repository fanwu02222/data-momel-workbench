/**
 * ER 模型图（oltp 项目专用）：
 *  - 实体卡片：标题栏（实体名 + 中文名）+ 字段行（PK 🔑 / FK 🔗 标记 + 字段名：类型）
 *  - 连线由 field.fk = "实体.列" 推导：标签「本字段 → 目标列」
 *  - 基数：目标端画 "1"（一条竖线）；本端 unique fk 画 "1"，普通 fk 画鸦脚（三叉）
 *  - 未解析 fk（目标实体不存在）：红虚线告警
 *  - 交互：节点拖拽 + 布局持久化（project.layout）+ 适应窗口 + 缩放平移（复用 lineage SVG 引擎）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var svgEl = (typeof Lineage !== 'undefined') ? Lineage.svgEl
    : (typeof require !== 'undefined' ? require('./lineage.js').svgEl : null);
  var attachPanZoom = (typeof Lineage !== 'undefined') ? Lineage.attachPanZoom
    : (typeof require !== 'undefined' ? require('./lineage.js').attachPanZoom : null);
  var attachNodeDrag = (typeof Lineage !== 'undefined') ? Lineage.attachNodeDrag
    : (typeof require !== 'undefined' ? require('./lineage.js').attachNodeDrag : null);

  var BOX_W = 232, HEADER_H = 34, ROW_H = 21, PAD = 10;
  var COL_GAP = 90, ROW_GAP = 40, TOP = 44;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // 实体高度：表头 + 字段行 + 底边距（至少一行，空实体提示一行）
  function boxH(m) { return HEADER_H + Math.max(1, (m.fields || []).length) * ROW_H + PAD; }

  // fk 解析："表.列" → { entity, column }；实体名不含点的场景（复合外键 v2.0 不支持）
  function parseFk(fk) {
    var s = String(fk || '');
    var i = s.indexOf('.');
    if (i <= 0) return { entity: s, column: '' };
    return { entity: s.slice(0, i), column: s.slice(i + 1) };
  }

  // 收集 fk 边（含未解析的）
  function computeEdges(project) {
    var byName = {};
    (project.models || []).forEach(function (m) { if (m.name) byName[m.name] = m; });
    var edges = [];
    (project.models || []).forEach(function (m) {
      (m.fields || []).forEach(function (f) {
        if (!f.fk) return;
        var p = parseFk(f.fk);
        var target = byName[p.entity] || null;
        edges.push({
          fromModel: m, field: f,
          targetName: p.entity, targetColumn: p.column,
          target: target, resolved: !!target
        });
      });
    });
    return edges;
  }

  // 实体的目录归属键：catalogId 所属的 L1 根节点 id（无则归入「未归类」组）
  function catalogRootOf(model, rootOf) {
    var cid = model.catalogId ? String(model.catalogId) : '';
    return cid && rootOf[cid] ? rootOf[cid] : '__uncat__';
  }

  // 初始布局：实体有目录归属时按 L1 根节点分组列排；无目录（或均未挂载）则从左到右蛇形
  function defaultLayout(project, rootOf) {
    var models = project.models || [];
    var pos = {};
    if (!models.some(function (m) { return m.catalogId && rootOf[String(m.catalogId)]; })) {
      // 蛇形列排：列自左向右，行走向上下交替
      var n = models.length;
      var cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      var rows = Math.max(1, Math.ceil(n / cols));
      models.forEach(function (m, i) {
        var col = Math.floor(i / rows), row = i % rows;
        if (col % 2 === 1) row = rows - 1 - row; // 奇数列自下而上
        pos[m.id] = { x: 40 + col * (BOX_W + COL_GAP), y: TOP + row * (boxH(m) + ROW_GAP) };
      });
      return pos;
    }
    // 按目录根分组列排（未归类的实体排在最后一列）
    var groups = [], groupIdx = {};
    models.forEach(function (m) {
      var key = catalogRootOf(m, rootOf);
      if (!(key in groupIdx)) { groupIdx[key] = groups.length; groups.push({ uncat: key === '__uncat__', models: [] }); }
      groups[groupIdx[key]].models.push(m);
    });
    groups.sort(function (a, b) { return a.uncat === b.uncat ? 0 : (a.uncat ? 1 : -1); });
    var x = 40;
    groups.forEach(function (grp) {
      var y = TOP;
      grp.models.forEach(function (m) {
        pos[m.id] = { x: x, y: y };
        y += boxH(m) + ROW_GAP;
      });
      x += BOX_W + COL_GAP;
    });
    return pos;
  }

  /**
   * 渲染 ER 图到容器
   * opts: { getLayout, saveLayout, onSelectModel }
   */
  function renderER(container, project, opts) {
    opts = opts || {};
    container.innerHTML = '';
    var svgEl_ = svgEl; // 局部引用（Node 环境下 Lineage 由 require 引入）
    var models = project.models || [];
    var edges = computeEdges(project);

    // catalog 根节点映射（catalogId -> L1 根 id）
    var rootOf = { __has__: false };
    (function walk(nodes, root) {
      (nodes || []).forEach(function (n) {
        var r = root || n.id;
        rootOf[n.id] = r;
        rootOf.__has__ = true;
        walk(n.children || [], r);
      });
    })(opts.catalog || [], null);

    // 节点位置：已保存布局优先（钳制在画布内），否则自动布局
    var saved = (typeof opts.getLayout === 'function' && opts.getLayout()) || {};
    var auto = defaultLayout(project, rootOf);
    Object.keys(auto).forEach(function (id) { if (!saved[id]) saved[id] = auto[id]; });
    var maxH = models.reduce(function (mx, m) { return Math.max(mx, boxH(m)); }, 0);
    var totalW = 80, totalH = TOP + 40;
    models.forEach(function (m) {
      var p = saved[m.id];
      totalW = Math.max(totalW, p.x + BOX_W + 60);
      totalH = Math.max(totalH, p.y + boxH(m) + 50);
    });
    var MAXX = Math.max(0, totalW - BOX_W), MAXY = Math.max(0, totalH - maxH);
    function clampP(v, max) { return Math.max(0, Math.min(Math.round(v), max)); }
    var pos = {};
    models.forEach(function (m) {
      var p = saved[m.id] || { x: 40, y: TOP };
      pos[m.id] = { x: clampP(p.x, MAXX), y: clampP(p.y, MAXY) };
    });

    // SVG 尺寸 = 可视容器（画布即视口），内容靠 viewport transform 适应
    var host = container.parentElement || container;
    var vw = host.clientWidth || totalW, vh = host.clientHeight || totalH;
    var svg = svgEl_('svg', { width: vw, height: vh, style: 'overflow:visible' });
    var g = svgEl_('g', { class: 'viewport' });
    svg.appendChild(g);
    container.appendChild(svg);

    // 实体名 → 节点记录（字段行 y 坐标，供连线锚点）
    var nodeByName = {}, boxes = {};
    models.forEach(function (m) {
      if (!m.name) return;
      nodeByName[m.name] = {
        model: m, x: pos[m.id].x, y: pos[m.id].y, w: BOX_W, h: boxH(m),
        fieldY: {}
      };
      (m.fields || []).forEach(function (f, i) { nodeByName[m.name].fieldY[f.name] = pos[m.id].y + HEADER_H + i * ROW_H + ROW_H / 2 + 2; });
    });

    // ---- 连线 ----
    var edgesG = svgEl_('g', { class: 'ln-edges er-edges' });
    g.appendChild(edgesG);
    var edgeIndex = {}; // nodeId -> [rec]
    var warnings = [];

    function edgeGeometry(e) {
      var a = nodeByName[e.fromModel.name], b = e.resolved ? nodeByName[e.targetName] : null;
      if (!a) return null;
      var y1 = a.fieldY[e.field.name] != null ? a.fieldY[e.field.name] : a.y + HEADER_H / 2;
      if (!b) {
        // 未解析 fk：从源盒右侧伸出的红色虚线短桩
        return { stub: true, x1: a.x + a.w, y1: y1, x2: a.x + a.w + 64, y2: y1 };
      }
      var y2 = b.fieldY[e.targetColumn] != null ? b.fieldY[e.targetColumn] : b.y + HEADER_H / 2;
      // 锚点取朝向对方的一侧
      var x1 = b.x + b.w / 2 >= a.x + a.w / 2 ? a.x + a.w : a.x;
      var x2 = x1 > b.x + b.w / 2 ? b.x + b.w : b.x;
      return { stub: false, x1: x1, y1: y1, x2: x2, y2: y2 };
    }

    edges.forEach(function (e) {
      var geo = edgeGeometry(e);
      if (!geo) return;
      var rec = { geo: geo, from: e.fromModel.id, to: e.resolved ? e.target.id : e.fromModel.id, e: e };
      function redraw() {
        var gm = edgeGeometry(e);
        rec.geo = gm;
        if (!gm) return;
        if (gm.stub) {
          rec.path.setAttribute('d', 'M ' + gm.x1 + ' ' + gm.y1 + ' L ' + gm.x2 + ' ' + gm.y2);
          if (rec.label) {
            rec.label.setAttribute('x', (gm.x1 + gm.x2) / 2);
            rec.label.setAttribute('y', gm.y1 - 6);
          }
          return;
        }
        var dx = gm.x2 > gm.x1 ? 46 : -46;
        rec.path.setAttribute('d', 'M ' + gm.x1 + ' ' + gm.y1 + ' C ' + (gm.x1 + dx) + ' ' + gm.y1 + ', ' + (gm.x2 - dx) + ' ' + gm.y2 + ', ' + gm.x2 + ' ' + gm.y2);
        // 基数标记：目标端 "1"（一条竖线）；本端 unique→"1" 否则鸦脚
        drawOneMark(rec.markTo, gm.x2, gm.y2, gm.x2 > gm.x1 ? 1 : -1);
        var many = !e.field.unique;
        drawFoot(rec.markFrom, gm.x1, gm.y1, gm.x2 > gm.x1 ? -1 : 1, many);
        if (rec.label) {
          rec.label.setAttribute('x', (gm.x1 + gm.x2) / 2);
          rec.label.setAttribute('y', (gm.y1 + gm.y2) / 2 - 7);
        }
      }
      if (geo.stub) {
        rec.path = svgEl_('path', {
          d: 'M ' + geo.x1 + ' ' + geo.y1 + ' L ' + geo.x2 + ' ' + geo.y2,
          fill: 'none', style: 'stroke:var(--danger)', 'stroke-width': 1.4,
          'stroke-dasharray': '4 3', class: 'ln-edge'
        });
        edgesG.appendChild(rec.path);
        rec.label = svgEl_('text', {
          x: (geo.x1 + geo.x2) / 2, y: geo.y1 - 6, 'font-size': 10,
          'text-anchor': 'middle', style: 'fill:var(--danger)', class: 'er-edge-label'
        });
        rec.label.textContent = (e.field.name || '?') + ' → 未解析';
        g.appendChild(rec.label);
        warnings.push('字段 ' + (e.fromModel.name || '?') + '.' + (e.field.name || '?') + ' 的外键「' + e.field.fk + '」引用的实体不存在（检查拼写或先建实体）');
      } else {
        rec.path = svgEl_('path', {
          d: '', fill: 'none', style: 'stroke:var(--hairline-strong)', 'stroke-width': 1.3, class: 'ln-edge'
        });
        edgesG.appendChild(rec.path);
        // 标记（竖线 / 鸦脚）与标签
        rec.markTo = svgEl_('path', { d: '', fill: 'none', style: 'stroke:var(--text-2)', 'stroke-width': 1.4 });
        rec.markFrom = svgEl_('path', { d: '', fill: 'none', style: 'stroke:var(--text-2)', 'stroke-width': 1.4 });
        edgesG.appendChild(rec.markTo);
        edgesG.appendChild(rec.markFrom);
        rec.label = svgEl_('text', {
          x: 0, y: 0, 'font-size': 10, 'text-anchor': 'middle', style: 'fill:var(--text-3)', class: 'er-edge-label'
        });
        rec.label.textContent = (e.field.name || '?') + ' → ' + (e.targetColumn || '?');
        g.appendChild(rec.label);
      }
      rec.redraw = redraw;
      redraw();
      (edgeIndex[rec.from] || (edgeIndex[rec.from] = [])).push(rec);
      if (rec.to !== rec.from) (edgeIndex[rec.to] || (edgeIndex[rec.to] = [])).push(rec);
    });

    // "1" 标记：端点处的短竖线（垂直于水平切线）
    function drawOneMark(el, x, y, dir) {
      el.setAttribute('d', 'M ' + (x - dir * 4) + ' ' + (y - 6) + ' L ' + (x - dir * 4) + ' ' + (y + 6));
    }
    // 鸦脚（三叉）或 "1"：dir = 从端点指向盒外的方向
    function drawFoot(el, x, y, dir, many) {
      if (!many) { drawOneMark(el, x, y, dir); return; }
      var x0 = x - dir * 13, xs = x - dir * 3;
      el.setAttribute('d', 'M ' + x0 + ' ' + y + ' L ' + xs + ' ' + y
        + ' M ' + x0 + ' ' + y + ' L ' + xs + ' ' + (y - 6)
        + ' M ' + x0 + ' ' + y + ' L ' + xs + ' ' + (y + 6));
    }

    // ---- 实体卡片 ----
    models.forEach(function (m) {
      var p = pos[m.id];
      var color = 'var(--accent)';
      var box = svgEl_('g', { class: 'er-box ln-mbox', 'data-id': m.id, transform: 'translate(' + p.x + ',' + p.y + ')', cursor: 'pointer' });
      box.appendChild(svgEl_('rect', { width: BOX_W, height: boxH(m), rx: 8, style: 'fill:var(--panel);stroke:var(--line-2)', 'stroke-width': 1.2, class: 'er-box-body' }));
      box.appendChild(svgEl_('rect', { width: BOX_W, height: HEADER_H, rx: 8, style: 'fill:var(--panel-3)', class: 'er-box-head' }));
      box.appendChild(svgEl_('rect', { width: BOX_W, height: 12, y: HEADER_H - 12, style: 'fill:var(--panel-3)' }));
      var title = svgEl_('text', { x: 11, y: 15, 'font-size': 12, 'font-weight': 700, style: 'fill:var(--text)', class: 'er-title' });
      title.textContent = m.name || '（未命名实体）';
      box.appendChild(title);
      if (m.cnName) {
        var cn = svgEl_('text', { x: 11, y: 28, 'font-size': 10, style: 'fill:var(--text-3)' });
        cn.textContent = m.cnName;
        box.appendChild(cn);
      }
      var fields = m.fields || [];
      if (!fields.length) {
        var empty = svgEl_('text', { x: 11, y: HEADER_H + 15, 'font-size': 10.5, style: 'fill:var(--text-faint)' });
        empty.textContent = '（暂无字段）';
        box.appendChild(empty);
      }
      fields.forEach(function (f, i) {
        var ry = HEADER_H + i * ROW_H + ROW_H / 2 + 2;
        var marks = '';
        if (f.pk) marks += '🔑';
        if (f.fk) marks += '🔗';
        var t = svgEl_('text', { x: 11, y: ry, 'font-size': 11, class: 'ln-field', style: 'fill:var(--text-2)' });
        t.textContent = (marks ? marks + ' ' : '') + (f.name || '（空）');
        box.appendChild(t);
        var ty = svgEl_('text', { x: BOX_W - 11, y: ry, 'font-size': 9.5, 'text-anchor': 'end', class: 'er-ftype', style: 'fill:var(--text-faint)' });
        ty.textContent = f.type || '';
        box.appendChild(ty);
      });
      boxes[m.id] = box;

      attachNodeDrag(svg, box, { id: m.id }, pos, function (nodeId) {
        // 拖动：更新盒位置与相连连线/标签/标记
        var mm = null;
        models.forEach(function (x) { if (x.id === nodeId) mm = x; });
        if (mm && nodeByName[mm.name]) {
          var nd = nodeByName[mm.name];
          nd.x = pos[nodeId].x; nd.y = pos[nodeId].y;
          nd.fieldY = {};
          (mm.fields || []).forEach(function (f, i) { nd.fieldY[f.name] = nd.y + HEADER_H + i * ROW_H + ROW_H / 2 + 2; });
        }
        (edgeIndex[nodeId] || []).forEach(function (r) { if (r.redraw) r.redraw(); });
      }, {
        saveLayout: function (lay) {
          // 只保留当前实体的坐标（layout 键与血缘图共用，oltp 项目只有 ER 图）
          var out = {};
          models.forEach(function (x) { out[x.id] = { x: pos[x.id].x, y: pos[x.id].y }; });
          opts.saveLayout && opts.saveLayout(out);
        }
      }, { maxX: MAXX, maxY: MAXY });

      if (opts.onSelectModel) box.addEventListener('click', function () {
        if (box._skipClick) { box._skipClick = false; return; }
        opts.onSelectModel(m.id);
      });
      g.appendChild(box);
    });

    attachPanZoom(svg, g, totalW, totalH);
    return {
      warnings: warnings,
      entityCount: models.length,
      edgeCount: edges.filter(function (e) { return e.resolved; }).length,
      unresolved: edges.filter(function (e) { return !e.resolved; }).length
    };
  }

  return { renderER: renderER, computeEdges: computeEdges, parseFk: parseFk };
});
