/**
 * SQL 反解析器：把 CREATE TABLE / CTAS / INSERT INTO...SELECT 解析为数据模型
 * 支持多语句（按分号顺序解析），产出可直接并入工作台 project 的模型描述。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SQLParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var L = (typeof SQLLex !== 'undefined') ? SQLLex : require('./sql-lexer.js');

  var LAYER_PREFIX = { ods: 'ods', dim: 'dim', dwd: 'dwd', dws: 'dws', ads: 'ads', dm: 'ads', fact: 'dwd', o: 'ods' };

  // ---------- 工具 ----------
  function shortName(full) {
    var parts = String(full || '').split('.');
    return parts[parts.length - 1].replace(/["`]/g, '');
  }
  function detectLayer(name) {
    var m = /^([a-z]+)_/i.exec(name || '');
    if (!m) return null;
    var p = m[1].toLowerCase();
    return LAYER_PREFIX[p] || null;
  }
  function slug(name, i) { return name ? name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') : ('col_' + (i + 1)); }

  function parseSQL(sql) {
    var tokens = L.lexSQL(sql);
    var p = 0;
    var results = [];

    function peek(k) { return tokens[Math.min(p + (k || 0), tokens.length - 1)]; }
    function next() { return tokens[p++]; }
    function kw(word) { var t = peek(); return t.type === 'ident' && t.value.toUpperCase() === word; }
    function eatKw(word) { if (kw(word)) { p++; return true; } return false; }
    function isPunct(c) { var t = peek(); return t.type === 'punct' && t.value === c; }
    function eatPunct(c) { if (isPunct(c)) { p++; return true; } return false; }
    function srcText(a, b) {
      if (!a || !b || b.pos < a.pos) return '';
      return sql.slice(a.pos, b.end).replace(/\s+/g, ' ').trim();
    }
    function qualifiedName() {
      var parts = [];
      var t = peek();
      while (t.type === 'ident') {
        parts.push(t.value); next();
        if (isPunct('.')) { next(); t = peek(); continue; }
        break;
      }
      return parts.join('.');
    }

    // 在深度 0 上跳过直到出现给定关键字集合中的词或语句结束
    var STOP_AT_SELECT_TAIL = { GROUP: 1, ORDER: 1, HAVING: 1, LIMIT: 1, WINDOW: 1, QUALIFY: 1, UNION: 1, WHERE: 1 };
    var JOIN_WORDS = { JOIN: 1, LEFT: 1, RIGHT: 1, FULL: 1, INNER: 1, CROSS: 1, OUTER: 1, SEMI: 1, ANTI: 1, LATERAL: 1 };
    // OLTP 约束提取的暂存器（parseColumnDefs 收尾时回填到字段）
    var pendingFks = [];
    var pendingPks = [];
    var pendingUniqueCols = [];
    var TABLE_OPT_KW = { COMMENT: 1, PARTITIONED: 1, PARTITION: 1, STORED: 1, LOCATION: 1, ROW: 1, CLUSTERED: 1, TBLPROPERTIES: 1, ENGINE: 1, ORDER: 1, PRIMARY: 1, SETTINGS: 1, AS: 1, WITH: 1, SORT: 1, DISTRIBUTED: 1, LIFE: 1 };

    function parseTableRef() {
      if (isPunct('(')) { // 子查询/括号表：跳过并记录别名
        var depth = 0;
        do {
          var t = next();
          if (t.type === 'punct' && t.value === '(') depth++;
          if (t.type === 'punct' && t.value === ')') depth--;
        } while (depth > 0 && peek().type !== 'eof');
        var al2 = maybeAlias();
        return { name: null, alias: al2, on: '' };
      }
      var name = qualifiedName();
      if (!name) return null;
      var alias = maybeAlias();
      return { name: name, alias: alias, on: '' };
    }
    function maybeAlias() {
      var hasAs = eatKw('AS');
      var t = peek();
      if (t.type === 'ident' && !JOIN_WORDS[t.value.toUpperCase()] && !STOP_AT_SELECT_TAIL[t.value.toUpperCase()] &&
          t.value.toUpperCase() !== 'ON' && t.value.toUpperCase() !== 'SET' && !L.isKeyword(t.value.toLowerCase())) {
        next();
        return t.value;
      }
      if (hasAs) { // AS 后没有合法标识符，回退
        var t2 = peek();
        if (t2.type === 'ident') { next(); return t2.value; }
      }
      return null;
    }

    // 解析 SELECT 主体
    function parseSelect() {
      var sel = { items: [], from: null, joins: [], where: '', groupBy: '', having: '' };
      eatKw('SELECT');
      eatKw('DISTINCT') || eatKw('ALL');
      // select 项
      while (!kw('FROM') && peek().type !== 'eof' && !isPunct(';')) {
        var start = peek();
        var depth = 0, last = start, sawToken = false;
        while (peek().type !== 'eof') {
          var t = peek();
          if (depth === 0 && isPunct(',')) break;
          if (depth === 0 && t.type === 'ident' && t.value.toUpperCase() === 'FROM') break;
          if (t.type === 'punct' && t.value === '(') depth++;
          if (t.type === 'punct' && t.value === ')') depth--;
          next(); last = t; sawToken = true;
        }
        if (!sawToken) break;
        sel.items.push(makeSelectItem(start, last));
        if (isPunct(',')) next();
        else break;
      }
      // FROM
      if (eatKw('FROM')) {
        sel.from = parseTableRef();
        // JOIN 链与逗号交叉连接
        for (;;) {
          if (isPunct(',')) { next(); var cj = parseTableRef(); if (cj) sel.joins.push(cj); continue; }
          var jw = peek();
          if (jw.type === 'ident' && (JOIN_WORDS[jw.value.toUpperCase()])) {
            while (peek().type === 'ident' && JOIN_WORDS[peek().value.toUpperCase()] && !kw('JOIN')) next();
            if (!eatKw('JOIN')) break;
            var jt = parseTableRef();
            if (jt) {
              if (eatKw('ON')) {
                var os = peek(), ol = os, d2 = 0;
                while (peek().type !== 'eof') {
                  var tt = peek();
                  if (d2 === 0 && tt.type === 'punct' && tt.value === ',') break;
                  if (d2 === 0 && tt.type === 'ident' && (JOIN_WORDS[tt.value.toUpperCase()] || STOP_AT_SELECT_TAIL[tt.value.toUpperCase()])) break;
                  if (tt.type === 'punct' && tt.value === '(') d2++;
                  if (tt.type === 'punct' && tt.value === ')') d2--;
                  next(); ol = tt;
                }
                jt.on = srcText(os, ol);
              }
              sel.joins.push(jt);
            }
            continue;
          }
          break;
        }
        // WHERE
        if (kw('WHERE')) {
          next();
          var ws = peek(), wl = ws, d3 = 0;
          while (peek().type !== 'eof') {
            var wt = peek();
            if (d3 === 0 && wt.type === 'ident' && STOP_AT_SELECT_TAIL[wt.value.toUpperCase()] && wt.value.toUpperCase() !== 'WHERE') break;
            if (d3 === 0 && isPunct(';')) break;
            if (wt.type === 'punct' && wt.value === '(') d3++;
            if (wt.type === 'punct' && wt.value === ')') d3--;
            next(); wl = wt;
          }
          sel.where = srcText(ws, wl);
        }
        // GROUP BY
        if (kw('GROUP')) {
          next(); eatKw('BY');
          var gs = peek(), gl = gs, d4 = 0;
          while (peek().type !== 'eof') {
            var gt = peek();
            if (d4 === 0 && gt.type === 'ident' && (gt.value.toUpperCase() === 'HAVING' || STOP_AT_SELECT_TAIL[gt.value.toUpperCase()])) break;
            if (d4 === 0 && isPunct(';')) break;
            if (gt.type === 'punct' && gt.value === '(') d4++;
            if (gt.type === 'punct' && gt.value === ')') d4--;
            next(); gl = gt;
          }
          sel.groupBy = srcText(gs, gl);
        }
      }
      return sel;
    }

    // 由 token 区间构造 select 项（表达式 + 别名）
    function makeSelectItem(start, last) {
      var toks = tokens.filter(function (t) { return t.pos >= start.pos && t.end <= last.end; });
      // ClickHouse 风格 alias = expr
      if (toks.length > 2 && toks[0].type === 'ident' && toks[1].type === 'op' && toks[1].value === '=') {
        var exprToks = toks.slice(2);
        return { alias: toks[0].value, expr: srcText(exprToks[0], exprToks[exprToks.length - 1]) };
      }
      var alias = null, cut = toks.length;
      if (toks.length >= 2) {
        var lastT = toks[toks.length - 1];
        var prev = toks[toks.length - 2];
        if (lastT.type === 'ident' && prev.type === 'ident' && prev.value.toUpperCase() === 'AS') {
          alias = lastT.value; cut = toks.length - 2;
        } else if (lastT.type === 'ident' && (prev.type === 'ident' || prev.type === 'number' || prev.type === 'string' || (prev.type === 'punct' && prev.value === ')'))) {
          // 裸别名：expr 以标识符/数字/字符串/右括号结尾，且最后一token是普通标识符
          if (!L.isKeyword(lastT.value) && !JOIN_WORDS[lastT.value.toUpperCase()] && !STOP_AT_SELECT_TAIL[lastT.value.toUpperCase()]) {
            alias = lastT.value; cut = toks.length - 1;
          }
        }
      }
      var expr = cut > 0 ? srcText(toks[0], toks[cut - 1]) : srcText(start, last);
      return { alias: alias, expr: expr };
    }

    // 解析列定义块（含类型与 COMMENT），返回 {fields, partitions} 视上下文
    function parseColumnDefs() {
      var fields = [];
      var oltpIndexes = [];
      eatPunct('(');
      while (!isPunct(')') && peek().type !== 'eof') {
        if (isPunct(',')) { next(); continue; }
        var t0 = peek();
        // 约束行：PRIMARY KEY / UNIQUE / KEY / CONSTRAINT / INDEX / FOREIGN → 解析提取（OLTP）或跳过
        if (t0.type === 'ident' && ['PRIMARY', 'UNIQUE', 'KEY', 'CONSTRAINT', 'INDEX', 'FOREIGN'].indexOf(t0.value.toUpperCase()) >= 0) {
          parseTableConstraint(oltpIndexes);
          continue;
        }
        var nameTok = next();
        var fname = nameTok.value;
        // 类型：标识符 + 可选 (..) + 可选 <..>（Hive 复杂类型）
        var typeStart = peek(), typeEnd = typeStart;
        var depthT = 0;
        while (peek().type !== 'eof') {
          var tt = peek();
          if (depthT === 0 && tt.type === 'punct' && (tt.value === ',' || tt.value === ')')) break;
          if (depthT === 0 && tt.type === 'ident' && tt.value.toUpperCase() === 'COMMENT') break;
          if (depthT === 0 && tt.type === 'ident' && ['NOT', 'NULL', 'DEFAULT', 'AUTO_INCREMENT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'COLLATE', 'CHARACTER', 'PRECISION'].indexOf(tt.value.toUpperCase()) >= 0) break;
          if (tt.type === 'punct' && tt.value === '(') depthT++;
          if (tt.type === 'punct' && tt.value === ')') depthT--;
          next(); typeEnd = tt;
        }
        var ftype = srcText(typeStart, typeEnd) || 'string';
        if (/^(not|null|default)$/i.test(ftype)) ftype = 'string';
        // 修饰：NOT NULL / DEFAULT / PRIMARY KEY / UNIQUE / REFERENCES / COMMENT
        var comment = '';
        var fnullable, fdefault, funique, fpk, ffk;
        fnullable = fdefault = funique = fpk = ffk = undefined; // var 提升陷阱：列间显式重置
        while (peek().type !== 'eof') {
          if (isPunct(',') || isPunct(')')) break;
          if (kw('COMMENT')) { next(); var ct2 = peek(); if (ct2.type === 'string') { comment = ct2.value; next(); } continue; }
          if (kw('NOT')) { next(); if (kw('NULL')) next(); fnullable = false; continue; }
          if (kw('NULL')) { next(); fnullable = true; continue; }
          if (kw('DEFAULT')) {
            next();
            var dt = peek();
            if (dt.type === 'string') { fdefault = dt.value; next(); }
            else if (dt.type === 'op' && dt.value === '-') { next(); var dn = next(); fdefault = '-' + (dn ? dn.value : '0'); }
            else if (dt.type === 'ident' || dt.type === 'number') { fdefault = dt.value; next(); }
            continue;
          }
          if (kw('PRIMARY')) { next(); if (kw('KEY')) next(); fpk = true; fnullable = false; continue; }
          if (kw('UNIQUE')) { next(); if (kw('KEY')) next(); funique = true; continue; }
          if (kw('REFERENCES')) {
            next();
            var rname = next();
            if (rname && rname.type === 'ident') {
              var rcol = '';
              if (isPunct('(')) {
                next();
                var rc = next();
                if (rc && rc.type === 'ident') rcol = rc.value;
                if (isPunct(')')) next();
              }
              ffk = rname.value + (rcol ? '.' + rcol : '');
            }
            continue;
          }
          next();
        }
        var fd = { name: fname, type: ftype, comment: comment, pk: !!fpk };
        if (fnullable === false && !fpk) fd.nullable = false;
        if (funique) fd.unique = true;
        if (fdefault !== undefined && fdefault !== '') fd.default = fdefault;
        if (ffk) fd.fk = ffk;
        fields.push(fd);
      }
      eatPunct(')');
      if (oltpIndexes.length) fields._indexes = oltpIndexes;
      return fields;
    }

    // 表级约束行：CONSTRAINT fk FOREIGN KEY (a) REFERENCES t(b) / [UNIQUE] KEY idx (cols) / PRIMARY KEY (..)
    // OLTP 建模扩展：提取 FK/索引/唯一键/复合主键，暂存待收尾回填
    function parseTableConstraint(oltpIndexes) {
      var d0 = 0, toks = [];
      while (peek().type !== 'eof') {
        var ct = peek();
        if (d0 === 0 && ct.type === 'punct' && ct.value === ')') break;
        if (ct.type === 'punct' && ct.value === '(') d0++;
        if (ct.type === 'punct' && ct.value === ')') d0--;
        toks.push(ct); next();
        if (d0 === 0 && ct.type === 'punct' && ct.value === ',') { toks.pop(); break; }
      }
      var s = toks.map(function (t) { return t.value; }).join(' ');
      var fkM = /FOREIGN\s+KEY\s*\(\s*[`"']?([\w\u4e00-\u9fa5]+)[`"']?\s*\)\s*REFERENCES\s+[`"']?([\w\u4e00-\u9fa5]+)[`"']?\s*\(\s*[`"']?([\w\u4e00-\u9fa5]+)[`"']?\s*\)/i.exec(s);
      if (fkM) { pendingFks.push({ col: fkM[1], table: fkM[2], column: fkM[3] }); return; }
      var pkM = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(s);
      if (pkM) { pkM[1].split(',').forEach(function (c) { pendingPks.push(c.trim().replace(/[`"]/g, '')); }); return; }
      var ixM = /(?:(UNIQUE)\s+)?(?:KEY|INDEX)\s+[`"']?([\w\u4e00-\u9fa5]+)[`"']?\s*\(([^)]+)\)/i.exec(s);
      if (ixM && !/FOREIGN|PRIMARY/i.test(s)) {
        var cols = ixM[3].split(',').map(function (c) { return c.trim().replace(/[`"]/g, ''); }).filter(Boolean);
        if (cols.length === 1 && ixM[1]) {
          pendingUniqueCols.push(cols[0]);
        } else {
          oltpIndexes.push({ name: ixM[2], fields: cols, unique: !!ixM[1] });
        }
      }
    }

    // CREATE TABLE 后置选项循环
    function parseTableOptions(model) {
      for (;;) {
        if (kw('COMMENT')) {
          next();
          var te = peek(); // MySQL 风格 COMMENT='...'（= 是 op 类型 token）
          if (te.type === 'op' && te.value === '=') next();
          var t = peek();
          if (t.type === 'string') { model.cnName = t.value; next(); }
          continue;
        }
        if (kw('PARTITIONED')) {
          next(); eatKw('BY');
          var pf = parseColumnDefs();
          model.partition = pf.map(function (f) { return { name: f.name, type: f.type, comment: f.comment, expr: '' }; });
          continue;
        }
        if (kw('PARTITION') && peek(1).type === 'ident' && peek(1).value.toUpperCase() === 'BY') {
          next(); next();
          // PARTITION BY tuple(...) / PARTITION BY dt / PARTITION BY (dt, hour)
          var names = [];
          if (eatPunct('(')) {
            while (!isPunct(')') && peek().type !== 'eof') {
              var pt = peek();
              if (pt.type === 'ident') { names.push(pt.value); }
              if (pt.type === 'punct' && pt.value === '(') { var dd = 0; do { var x = next(); if (x.type === 'punct' && x.value === '(') dd++; if (x.type === 'punct' && x.value === ')') dd--; } while (dd > 0 && !isPunct(')')); }
              next();
            }
            eatPunct(')');
          } else if (peek().type === 'ident') { names.push(next().value); }
          model.partition = names.map(function (nm) { return { name: nm, type: 'string', comment: '', expr: '' }; });
          continue;
        }
        if (kw('AS')) { next(); return 'select'; }
        // STORED AS <格式>：其后的 AS 属于存储子句，不能误判为 CTAS
        if (kw('STORED')) {
          next();
          var asSeen = false, dS = 0;
          while (peek().type !== 'eof') {
            var st = peek();
            if (dS === 0 && isPunct(';')) break;
            if (dS === 0 && st.type === 'ident') {
              var sup = st.value.toUpperCase();
              if (sup === 'AS') { if (asSeen) break; asSeen = true; next(); continue; }
              if (TABLE_OPT_KW[sup] || sup === 'SELECT') break;
            }
            if (st.type === 'punct' && st.value === '(') dS++;
            if (st.type === 'punct' && st.value === ')') dS--;
            next();
          }
          continue;
        }
        // 其它选项（LOCATION / ENGINE / TBLPROPERTIES...）整体跳过一个选项
        if (peek().type === 'ident' && TABLE_OPT_KW[peek().value.toUpperCase()]) {
          next();
          // 跳到下一个已知选项关键字或 SELECT 或结尾（深度感知）
          var d5 = 0;
          while (peek().type !== 'eof') {
            var ot = peek();
            if (d5 === 0 && ot.type === 'ident' && ot.value.toUpperCase() === 'SELECT') return 'select';
            if (d5 === 0 && ot.type === 'ident' && TABLE_OPT_KW[ot.value.toUpperCase()]) break;
            if (d5 === 0 && isPunct(';')) break;
            if (ot.type === 'punct' && ot.value === '(') d5++;
            if (ot.type === 'punct' && ot.value === ')') d5--;
            next();
          }
          continue;
        }
        break;
      }
      return 'end';
    }

    function buildModelFromSelect(target, sel, partitionNames, colTypes) {
      var model = baseModel(target);
      var items = sel.items || [];
      model.fields = items.map(function (it, i) {
        var name = it.alias || deriveName(it.expr, i);
        return {
          name: name,
          type: (colTypes && colTypes[name]) || 'string',
          comment: '',
          pk: false,
          expr: it.expr === name ? '' : it.expr
        };
      });
      model.sources = [];
      if (sel.from && sel.from.name !== null) model.sources.push({ name: shortName(sel.from.name), alias: sel.from.alias || shortName(sel.from.name), on: '' });
      else if (sel.from && sel.from.alias) model.sources.push({ name: '', alias: sel.from.alias, on: '' });
      (sel.joins || []).forEach(function (j) {
        model.sources.push({ name: j.name ? shortName(j.name) : '', alias: j.alias || (j.name ? shortName(j.name) : ''), on: j.on || '' });
      });
      model.where = sel.where || '';
      model.groupBy = sel.groupBy || '';
      model.partition = (partitionNames || []).map(function (nm) {
        // 若 SELECT 项里有同名表达式则带出
        var hit = items.filter(function (it) { return (it.alias || '') === nm; })[0];
        return { name: nm, type: 'string', comment: '', expr: hit ? hit.expr : '' };
      });
      return model;
    }

    function deriveName(expr, i) {
      if (!expr) return 'col_' + (i + 1);
      var toks = L.lexSQL(expr).filter(function (t) { return t.type !== 'eof'; });
      if (!toks.length) return 'col_' + (i + 1);
      var last = toks[toks.length - 1];
      if (last.type === 'ident') {
        var prev = toks[toks.length - 2];
        if (prev && prev.type === 'punct' && prev.value === '.') return last.value;
        if (toks.length === 1) return last.value;
        if (toks.length === 2 && toks[0].type === 'ident' && toks[1].type === 'ident') return last.value; // cast(x int) 之类少见
      }
      if (last.type === 'op' && last.value === '*') {
        var t0 = toks[0];
        return (t0 && t0.type === 'ident') ? ('star_' + t0.value) : ('col_' + (i + 1));
      }
      if (toks.length >= 2 && toks[0].type === 'ident' && toks[1].type === 'punct' && toks[1].value === '(') return toks[0].value.toLowerCase();
      return 'col_' + (i + 1);
    }

    function baseModel(fullName) {
      var nm = shortName(fullName);
      var layer = detectLayer(nm) || 'dwd';
      return {
        id: null, layer: layer, name: nm, cnName: '', desc: '', source: '',
        fields: [], partition: [], sources: [], where: '', groupBy: '', notes: ''
      };
    }

    // ---------- 语句级解析 ----------
    function parseStatement() {
      if (kw('CREATE')) {
        next();
        eatKw('EXTERNAL'); eatKw('TEMPORARY');
        if (!eatKw('TABLE')) {
          if (kw('VIEW')) { // CREATE VIEW x AS SELECT → 视作模型
            next();
            var vn = qualifiedName();
            skipIfNotExists();
            var vm = baseModel(vn);
            vm.desc = '(由视图导入)';
            var vres = parseTableOptions(vm);
            if (vres === 'select') { var vsel = parseSelect(); return finish(buildModelFromSelect(vn, vsel, [], null), vm.cnName, vm.desc); }
            return null;
          }
          return null;
        }
        skipIfNotExists();
        var nameTok0 = peek();
        var fullName = qualifiedName();
        if (!fullName) return null;
        var model = baseModel(fullName);
        var colTypes = null;
        var colFields = null;
        pendingFks = []; pendingPks = []; pendingUniqueCols = [];
        if (isPunct('(')) {
          colFields = parseColumnDefs();
          // CREATE TABLE t (cols) AS SELECT —— 列名顺序映射
          colTypes = {};
          colFields.forEach(function (f) { colTypes[f.name] = f.type; });
        }
        var after = parseTableOptions(model);
        // OLTP 约束回填：表级 FK / 复合 PK / 单列唯一 / 索引（仅显式列定义时）
        var oltpIdx = colFields ? colFields._indexes : null;
        // 显式列定义优先（类型与注释完整）
        if (colFields && colFields.length) {
          model.fields = colFields.map(function (f) { return { name: f.name, type: f.type, comment: f.comment, pk: false, expr: '' }; });
          if (model.cnName && !model.desc) model.desc = '';
          // 保留列级 OLTP 属性（nullable/unique/default/fk/inline pk）
          var byCol = {};
          colFields.forEach(function (f) { byCol[f.name] = f; });
          model.fields.forEach(function (f) {
            var c = byCol[f.name];
            if (!c) return;
            if (c.pk) f.pk = true;
            if (c.nullable === false && !c.pk) f.nullable = false;
            if (c.unique) f.unique = true;
            if (c.default !== undefined && c.default !== '') f.default = c.default;
            if (c.fk) f.fk = c.fk;
          });
          if (oltpIdx && oltpIdx.length) model.indexes = oltpIdx;
        }
        if (after === 'select') {
          var sel = parseSelect();
          var m2 = buildModelFromSelect(fullName, sel, [], colTypes);
          // 保留显式列的注释/类型
          if (colFields) {
            var byName = {}; colFields.forEach(function (f) { byName[f.name] = f; });
            m2.fields.forEach(function (f) {
              if (byName[f.name]) { f.type = byName[f.name].type; f.comment = byName[f.name].comment; }
            });
          }
          if (model.partition) m2.partition = m2.partition.concat(model.partition);
          model = m2;
        }
        // 表级约束回填（PRIMARY KEY(...) / FOREIGN KEY / 单列 UNIQUE）
        if (model.fields && model.fields.length) {
          model.fields.forEach(function (f) {
            if (pendingPks.indexOf(f.name) >= 0) { f.pk = true; delete f.nullable; }
            if (pendingUniqueCols.indexOf(f.name) >= 0) f.unique = true;
            for (var i = 0; i < pendingFks.length; i++) {
              if (pendingFks[i].col === f.name) f.fk = pendingFks[i].table + '.' + pendingFks[i].column;
            }
          });
        }
        pendingFks = []; pendingPks = []; pendingUniqueCols = [];
        return finish(model, null, null);
      }
      if (kw('INSERT')) {
        next();
        eatKw('OVERWRITE') || eatKw('INTO');
        eatKw('TABLE');
        var iname = qualifiedName();
        if (!iname) return null;
        var im = baseModel(iname);
        var partNames = [];
        if (kw('PARTITION') && peek(1).type === 'punct' && peek(1).value === '(') {
          next(); next(); // 消费 PARTITION (
          var d6 = 0;
          while (!isPunct(')') || d6 > 0) {
            var pt2 = peek();
            if (pt2.type === 'eof') break;
            if (pt2.type === 'punct' && pt2.value === '(') d6++;
            if (pt2.type === 'punct' && pt2.value === ')') { if (d6 === 0) break; d6--; }
            // 形如 dt 或 dt = 'xx'
            if (pt2.type === 'ident' && (peek(1).type === 'punct' && (peek(1).value === ',' || peek(1).value === ')' || peek(1).value === '='))) {
              // 动态分区（无值）才作为分区字段
              if (peek(1).value !== '=' || true) { partNames.push({ name: pt2.value, dynamic: peek(1).value !== '=' }); }
            }
            next();
          }
          eatPunct(')');
          partNames = partNames.filter(function (x) { return x.dynamic; }).map(function (x) { return x.name; });
        }
        if (!kw('SELECT')) return null;
        var isel = parseSelect();
        var imm = buildModelFromSelect(iname, isel, partNames, null);
        return finish(imm, null, null);
      }
      return null;
    }

    function skipIfNotExists() {
      if (kw('IF')) { next(); eatKw('NOT'); eatKw('EXISTS'); }
    }
    function finish(m, cn, desc) {
      if (!m) return null;
      if (cn) m.cnName = cn;
      if (desc && !m.desc) m.desc = desc;
      return { type: 'model', model: m, raw: m.name };
    }

    // 主循环
    while (peek().type !== 'eof') {
      if (isPunct(';')) { next(); continue; }
      var before = p;
      var r = parseStatement();
      if (r && r.model && (r.model.name || r.model.fields.length)) results.push(r);
      if (p === before) next(); // 防死循环
    }
    return results;
  }

  return { parseSQL: parseSQL, detectLayer: detectLayer, shortName: shortName };
});
