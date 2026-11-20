/**
 * 血缘关系模块：
 *  - 表达式引用提取（字段级血缘解析）
 *  - 单模型字段级血缘图（SVG）
 *  - 全局模型级血缘图（按层分列）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Lineage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var L = (typeof SQLLex !== 'undefined') ? SQLLex : require('./sql-lexer.js');

  var NON_REF_KW = new Set(('as and or not null is in like between exists distinct all any some asc desc case when then else end ' +
    'interval day days month months year years hour hours minute minutes second seconds true false by on if').split(' '));

  // 提取表达式中的字段引用：alias.field / bare_field / alias.*
  function extractRefs(expr) {
    var refs = [];
    if (!expr || !expr.trim()) return refs;
    var toks = L.lexSQL(expr).filter(function (t) { return t.type !== 'eof'; });
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.type !== 'ident') continue;
      var prev = toks[i - 1], next = toks[i + 1];
      // prev 是 '.' 的一部分则已处理
      if (prev && prev.type === 'punct' && prev.value === '.') continue;
      // 函数名（后跟 '('）跳过
      if (next && next.type === 'punct' && next.value === '(') continue;
      // 字面量前缀（DATE '2020-01-01'）
      if (next && next.type === 'string') continue;
      // 关键字不作为引用
      if (NON_REF_KW.has(t.value.toLowerCase())) continue;
      // 别名后的输出名（前一个是 AS）跳过
      if (prev && prev.type === 'ident' && prev.value.toUpperCase() === 'AS') continue;
      if (next && next.type === 'punct' && next.value === '.') {
        var fld = toks[i + 2];
        if (fld && fld.type === 'ident') { refs.push({ qualifier: t.value, field: fld.value, star: false }); i += 2; continue; }
        if (fld && fld.type === 'op' && fld.value === '*') { refs.push({ qualifier: t.value, field: '*', star: true }); i += 2; continue; }
      }
      refs.push({ qualifier: null, field: t.value, star: false });
    }
    return refs;
  }

  // 计算某模型的字段级血缘
  // 返回 { sources:[{key,name,alias,model,fields:[names]}], target:{name, fields:[{name,refs:[{sourceKey,field,resolved}]}]}, warnings:[] }
  function computeFieldLineage(project, model) {
    var modelsByName = {};
    (project.models || []).forEach(function (m) { modelsByName[m.name] = m; });
    var warnings = [];
    var sources = [];
    var sourceIndex = {}; // key: alias(lower) or name(lower) -> source obj
    (model.sources || []).forEach(function (s) {
      var srcModel = s.name ? modelsByName[s.name] : null;
      var alias = (s.alias || s.name || 'src').toLowerCase();
      var key = alias + '#' + sources.length;
      var src = { key: key, name: s.name || '（未知源表）', alias: s.alias || s.name || '', model: srcModel, on: s.on || '' };
      sources.push(src);
      if (s.alias) sourceIndex[s.alias.toLowerCase()] = src;
      if (s.name) {
        sourceIndex[s.name.toLowerCase()] = src;
        var short = s.name.split('.').pop().toLowerCase();
        sourceIndex[short] = src;
      }
      if (!srcModel && s.name) warnings.push('源表「' + s.name + '」在当前项目中不存在（外部表或未建模型）');
    });

    var targetFields = [];
    var allFields = (model.fields || []).concat(model.partition || []);
    allFields.forEach(function (f) {
      var refs = extractRefs(f.expr || '');
      var resolvedRefs = refs.map(function (r) {
        var src = null;
        if (r.qualifier) {
          src = sourceIndex[r.qualifier.toLowerCase()] || null;
          if (!src) {
            // qualifier 可能直接是模型名（未在 sources 中声明）
            var m2 = modelsByName[r.qualifier] || modelsByName[r.qualifier.split('.').pop()];
            if (m2) {
              src = { key: r.qualifier.toLowerCase() + '#ghost', name: m2.name, alias: r.qualifier, model: m2, ghost: true };
              sources.push(src);
              sourceIndex[r.qualifier.toLowerCase()] = src;
            }
          }
        } else {
          // 裸字段：按源表顺序查找第一个包含该字段的模型
          for (var i = 0; i < sources.length; i++) {
            var sm = sources[i].model;
            if (sm && ((sm.fields || []).concat(sm.partition || [])).some(function (x) { return x.name === r.field; })) { src = sources[i]; break; }
          }
        }
        var resolved = false;
        if (src && r.star) resolved = true;
        else if (src && src.model) {
          resolved = ((src.model.fields || []).concat(src.model.partition || [])).some(function (x) { return x.name === r.field; });
        } else if (src && !src.model) {
          resolved = false;
        }
        if (src && !resolved && !r.star) warnings.push('字段 ' + model.name + '.' + f.name + ' 引用了 ' + (src.alias || src.name) + '.' + r.field + '，但源模型中无此字段');
        return { sourceKey: src ? src.key : null, sourceName: src ? src.name : (r.qualifier || '未知'), field: r.field, star: r.star, resolved: resolved, qualifier: r.qualifier };
      });
      targetFields.push({ name: f.name, refs: resolvedRefs, isPartition: !!(f.expr !== undefined && !(model.fields || []).some(function (x) { return x === f; })) });
    });

    return { sources: sources, target: { name: model.name, layer: model.layer, model: model, fields: targetFields }, warnings: Array.from(new Set(warnings)) };
  }

  // 全局模型级血缘
  function computeModelLineage(project) {
    var nodes = (project.models || []).map(function (m) { return { id: m.id, name: m.name, cnName: m.cnName, layer: m.layer, fieldCount: (m.fields || []).length }; });
    var byName = {}; nodes.forEach(function (n) { byName[n.name] = n; });
    var edges = [];
    (project.models || []).forEach(function (m) {
      (m.sources || []).forEach(function (s) {
        if (s.name && byName[s.name]) edges.push({ from: byName[s.name].id, to: m.id, fromName: s.name, toName: m.name });
      });
    });
    return { nodes: nodes, edges: edges };
  }

  // ================= SVG 渲染 =================
  var LAYER_COLORS = { ods: '#3672f0', dim: '#0aa2c0', dwd: '#159a62', dws: '#d97e00', ads: '#8256f0' };

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs || {}) el.setAttribute(k, attrs[k]);
    return el;
  }

  // 字段级血缘图
  function renderFieldLineage(container, lin) {
    container.innerHTML = '';
    var sources = lin.sources.filter(function (s) { return !s.ghost; });
    var ghost = lin.sources.filter(function (s) { return s.ghost; });
    sources = ghost.concat(sources);

    var BOX_W = 250, HEADER_H = 40, ROW_H = 22, PAD = 16;
    var SRC_X = 40, TGT_X = 560;

    function boxHeight(src) { return HEADER_H + ((src.model ? (src.model.fields || []).length + (src.model.partition || []).length : 1) * ROW_H) + PAD; }
    function targetBoxHeight() { return HEADER_H + (lin.target.fields.length * ROW_H) + PAD; }

    var y = 40, placed = [];
    sources.forEach(function (src) {
      placed.push({ src: src, y: y });
      y += boxHeight(src) + 40;
    });
    var totalH = Math.max(y, 40 + targetBoxHeight()) + 40;
    var totalW = TGT_X + BOX_W + 60;

    var svg = svgEl('svg', { viewBox: '0 0 ' + totalW + ' ' + totalH, width: totalW, height: totalH });
    var g = svgEl('g', { class: 'viewport' });
    svg.appendChild(g);
    container.appendChild(svg);

    var rowY = {}; // key: srcKey|fieldName -> y 中心
    var tgtY = {}; // fieldName -> y

    // 源盒子
    placed.forEach(function (pl) {
      var src = pl.src, by = pl.y;
      var color = src.model ? (LAYER_COLORS[src.model.layer] || '#8d99a5') : '#8d99a5';
      var box = svgEl('g', { class: 'ln-box', transform: 'translate(' + SRC_X + ',' + by + ')' });
      box.appendChild(svgEl('rect', { width: BOX_W, height: boxHeight(src), rx: 8, style: 'fill:var(--panel)', stroke: color, 'stroke-width': 1.5 }));
      var hdr = svgEl('rect', { width: BOX_W, height: HEADER_H, rx: 8, fill: color, opacity: 0.92 });
      box.appendChild(hdr);
      var label = svgEl('text', { x: 12, y: 25, fill: '#fff', 'font-size': 13, 'font-weight': 600 });
      label.textContent = (src.alias ? src.alias + ' · ' : '') + src.name;
      box.appendChild(label);
      var rows = src.model ? (src.model.fields || []).concat(src.model.partition || []).map(function (f) { return { name: f.name, part: false }; }) : [{ name: '(源模型缺失)', part: false }];
      rows.forEach(function (r, i) {
        var ry = HEADER_H + i * ROW_H + ROW_H / 2 + 2;
        rowY[src.key + '|' + r.name] = by + ry;
        var t = svgEl('text', { x: 12, y: ry, 'font-size': 11.5, style: 'fill:var(--text-2)', class: 'ln-field' });
        t.textContent = r.name;
        box.appendChild(t);
        var dot = svgEl('circle', { cx: BOX_W - 8, cy: ry - 4, r: 2.5, fill: color, opacity: 0.5 });
        box.appendChild(dot);
      });
      g.appendChild(box);
    });

    // 目标盒子
    var tColor = LAYER_COLORS[lin.target.layer] || '#8d99a5';
    var tBox = svgEl('g', { class: 'ln-box', transform: 'translate(' + TGT_X + ',' + 40 + ')' });
    var tH = targetBoxHeight();
    tBox.appendChild(svgEl('rect', { width: BOX_W, height: tH, rx: 8, style: 'fill:var(--panel)', stroke: tColor, 'stroke-width': 2 }));
    tBox.appendChild(svgEl('rect', { width: BOX_W, height: HEADER_H, rx: 8, fill: tColor }));
    var tl = svgEl('text', { x: 12, y: 25, fill: '#fff', 'font-size': 13, 'font-weight': 700 });
    tl.textContent = lin.target.name;
    tBox.appendChild(tl);
    lin.target.fields.forEach(function (f, i) {
      var ry = HEADER_H + i * ROW_H + ROW_H / 2 + 2;
      tgtY[f.name] = 40 + ry;
      var t = svgEl('text', {
        x: 12, y: ry, 'font-size': 11.5,
        style: f.isPartition ? 'fill:var(--text-faint)' : 'fill:var(--text);font-weight:600',
        class: 'ln-field'
      });
      t.textContent = f.name + (f.isPartition ? '（分区）' : '');
      tBox.appendChild(t);
    });
    g.appendChild(tBox);

    // 连线
    var edgesG = svgEl('g', { class: 'ln-edges' });
    g.insertBefore(edgesG, g.firstChild);
    lin.target.fields.forEach(function (f) {
      f.refs.forEach(function (r) {
        if (!r.sourceKey) return;
        var fromY = rowY[r.sourceKey + '|' + r.field];
        var toY = tgtY[f.name];
        if (fromY == null) {
          // 星号引用或未命中字段：连到源盒子头部中央
          var pl = placed.filter(function (x) { return x.src.key === r.sourceKey; })[0];
          if (!pl) return;
          fromY = pl.y + 20;
        }
        var x1 = SRC_X + BOX_W, x2 = TGT_X;
        var path = svgEl('path', {
          d: 'M ' + x1 + ' ' + fromY + ' C ' + (x1 + 90) + ' ' + fromY + ', ' + (x2 - 90) + ' ' + toY + ', ' + x2 + ' ' + toY,
          fill: 'none', style: r.resolved ? 'stroke:var(--hairline-strong)' : 'stroke:var(--danger)', 'stroke-width': r.resolved ? 1.2 : 1.4,
          'stroke-dasharray': r.resolved ? 'none' : '4 3', class: 'ln-edge', 'data-target': f.name
        });
        edgesG.appendChild(path);
      });
    });

    // 交互：hover 目标字段高亮其连线
    var fieldTexts = Array.prototype.slice.call(g.querySelectorAll('.ln-field'));
    fieldTexts.forEach(function (ft) {
      ft.addEventListener('mouseenter', function () {
        var name = ft.textContent.replace('（分区）', '');
        Array.prototype.forEach.call(edgesG.children, function (e) {
          if (e.getAttribute('data-target') === name) e.classList.add('hl');
        });
      });
      ft.addEventListener('mouseleave', function () {
        Array.prototype.forEach.call(edgesG.children, function (e) { e.classList.remove('hl'); });
      });
    });

    attachPanZoom(svg, g, totalW, totalH);
    return { warnings: lin.warnings };
  }

  // 模型级血缘图（全局）
  function renderModelLineage(container, graph, onSelectModel) {
    container.innerHTML = '';
    var layers = ['ods', 'dim', 'dwd', 'dws', 'ads'];
    var COL_W = 280, BOX_W = 220, BOX_H = 56, GAP_Y = 26, TOP = 40, GAP_X = 60;
    var colCount = {};
    var maxRows = 0;
    layers.forEach(function (ly) {
      colCount[ly] = graph.nodes.filter(function (n) { return n.layer === ly; }).length;
      maxRows = Math.max(maxRows, colCount[ly]);
    });
    var totalW = layers.length * COL_W + 80;
    var totalH = TOP + Math.max(maxRows, 1) * (BOX_H + GAP_Y) + 60;

    var svg = svgEl('svg', { viewBox: '0 0 ' + totalW + ' ' + totalH, width: totalW, height: totalH });
    var g = svgEl('g', { class: 'viewport' });
    svg.appendChild(g);
    container.appendChild(svg);

    // 层标题
    layers.forEach(function (ly, ci) {
      var t = svgEl('text', { x: 40 + ci * COL_W, y: 24, 'font-size': 13, 'font-weight': 700, fill: LAYER_COLORS[ly] });
      t.textContent = ly.toUpperCase() + ' 层（' + colCount[ly] + '）';
      g.appendChild(t);
    });

    var pos = {};
    layers.forEach(function (ly, ci) {
      var idx = 0;
      graph.nodes.filter(function (n) { return n.layer === ly; }).forEach(function (n) {
        var x = 40 + ci * COL_W, by = TOP + idx * (BOX_H + GAP_Y);
        pos[n.id] = { x: x, y: by };
        idx++;
        var color = LAYER_COLORS[ly] || '#64748b';
        var box = svgEl('g', { class: 'ln-mbox', 'data-id': n.id, cursor: 'pointer' });
        box.appendChild(svgEl('rect', { x: x, y: by, width: BOX_W, height: BOX_H, rx: 8, style: 'fill:var(--panel)', stroke: color, 'stroke-width': 1.5 }));
        box.appendChild(svgEl('rect', { x: x, y: by, width: 4, height: BOX_H, rx: 2, fill: color }));
        var t1 = svgEl('text', { x: x + 14, y: by + 22, 'font-size': 12.5, 'font-weight': 600, style: 'fill:var(--text)' });
        t1.textContent = n.name;
        box.appendChild(t1);
        var t2 = svgEl('text', { x: x + 14, y: by + 40, 'font-size': 11, style: 'fill:var(--text-2)' });
        t2.textContent = (n.cnName || '') + (n.fieldCount ? ' · ' + n.fieldCount + ' 字段' : '');
        box.appendChild(t2);
        if (onSelectModel) box.addEventListener('click', function () { onSelectModel(n.id); });
        g.appendChild(box);
      });
    });

    graph.edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x, y2 = b.y + BOX_H / 2;
      var path = svgEl('path', {
        d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 40) + ' ' + y1 + ', ' + (x2 - 40) + ' ' + y2 + ', ' + x2 + ' ' + y2,
        fill: 'none', style: 'stroke:var(--hairline-strong)', 'stroke-width': 1.3, class: 'ln-edge'
      });
      g.insertBefore(path, g.firstChild);
    });

    attachPanZoom(svg, g, totalW, totalH);
  }

  // SVG 平移缩放
  function attachPanZoom(svg, g, w, h) {
    var vx = 0, vy = 0, scale = 1;
    function apply() { g.setAttribute('transform', 'translate(' + vx + ',' + vy + ') scale(' + scale + ')'); }
    var dragging = false, lx = 0, ly = 0, moved = false;
    svg.addEventListener('mousedown', function (e) { dragging = true; moved = false; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      moved = true;
      vx += e.clientX - lx; vy += e.clientY - ly; lx = e.clientX; ly = e.clientY;
      apply();
    });
    window.addEventListener('mouseup', function () { dragging = false; });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.12 : 0.89;
      var ns = Math.min(2.5, Math.max(0.3, scale * factor));
      vx = e.offsetX - (e.offsetX - vx) * (ns / scale);
      vy = e.offsetY - (e.offsetY - vy) * (ns / scale);
      scale = ns; apply();
    }, { passive: false });
    svg._resetView = function () { vx = 0; vy = 0; scale = 1; apply(); };
  }

  return {
    extractRefs: extractRefs,
    computeFieldLineage: computeFieldLineage,
    computeModelLineage: computeModelLineage,
    renderFieldLineage: renderFieldLineage,
    renderModelLineage: renderModelLineage,
    LAYER_COLORS: LAYER_COLORS
  };
});
