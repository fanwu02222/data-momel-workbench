/**
 * SQL 词法分析器（轻量、方言友好：Hive/Spark/MySQL/ClickHouse/PostgreSQL）
 * 产出 token: { type: 'ident'|'string'|'number'|'op'|'punct'|'eof', value, pos, end }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SQLLex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KEYWORDS = new Set(('select from where group by having order limit as and or not null is in like between ' +
    'exists distinct all any some asc desc case when then else end union join left right full inner outer cross ' +
    'semi anti on insert into overwrite table create external if partition partitioned stored as location ' +
    'row format delimited fields terminated clustered distributed sort buckets tblproperties engine primary key ' +
    'unique constraint references default comment values with cast interval true false window qualify lateral view explode').split(' '));

  function lexSQL(input) {
    var tokens = [];
    var i = 0, n = input.length;

    function push(type, value, pos, end) { tokens.push({ type: type, value: value, pos: pos, end: end }); }

    while (i < n) {
      var c = input[i];
      if (/\s/.test(c)) { i++; continue; }
      // 行注释
      if (c === '-' && input[i + 1] === '-') { while (i < n && input[i] !== '\n') i++; continue; }
      // 块注释
      if (c === '/' && input[i + 1] === '*') {
        i += 2;
        while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
        i += 2; continue;
      }
      // 字符串字面量
      if (c === "'") {
        var j = i + 1, s = '';
        while (j < n) {
          if (input[j] === "'") {
            if (input[j + 1] === "'") { s += "'"; j += 2; continue; }
            break;
          }
          if (input[j] === '\\' && j + 1 < n) { s += input[j + 1]; j += 2; continue; }
          s += input[j]; j++;
        }
        push('string', s, i, j + 1); i = j + 1; continue;
      }
      // 反引号 / 双引号 / 方括号标识符
      if (c === '`' || c === '"') {
        var q = c, k = i + 1, name = '';
        while (k < n && input[k] !== q) { name += input[k]; k++; }
        push('ident', name, i, k + 1); i = k + 1; continue;
      }
      if (c === '[') {
        var m = i + 1, nm = '';
        while (m < n && input[m] !== ']') { nm += input[m]; m++; }
        push('ident', nm, i, m + 1); i = m + 1; continue;
      }
      // 数字
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] || ''))) {
        var d = i, num = '';
        while (d < n && /[0-9]/.test(input[d])) { num += input[d]; d++; }
        if (input[d] === '.') { num += '.'; d++; while (d < n && /[0-9]/.test(input[d])) { num += input[d]; d++; } }
        if (input[d] === 'e' || input[d] === 'E') {
          var save = d;
          num += input[d]; d++;
          if (input[d] === '+' || input[d] === '-') { num += input[d]; d++; }
          if (/[0-9]/.test(input[d] || '')) { while (d < n && /[0-9]/.test(input[d])) { num += input[d]; d++; } }
          else { num = num.slice(0, save - i); d = save; }
        }
        push('number', num, i, d); i = d; continue;
      }
      // 标识符（含中文，兼容中文注释场景）
      if (/[A-Za-z_$\u4e00-\u9fa5]/.test(c)) {
        var e = i, id = '';
        while (e < n && /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(input[e])) { id += input[e]; e++; }
        push('ident', id, i, e); i = e; continue;
      }
      // 双字符操作符
      var two = input.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '||' || two === '==' || two === '->' || two === '=>') {
        push('op', two, i, i + 2); i += 2; continue;
      }
      if ('+-*/%<>=!&|~^?'.indexOf(c) >= 0) { push('op', c, i, i + 1); i++; continue; }
      if ('(),.;:'.indexOf(c) >= 0) { push('punct', c, i, i + 1); i++; continue; }
      i++; // 跳过无法识别的字符
    }
    push('eof', '', n, n);
    return tokens;
  }

  return { lexSQL: lexSQL, KEYWORDS: KEYWORDS, isKeyword: function (w) { return KEYWORDS.has(String(w).toLowerCase()); } };
});
