/**
 * Excel 导出（零依赖真 .xlsx）
 *  - 手写 OpenXML SpreadsheetML + 无压缩 ZIP（stored），浏览器 / Node 通用
 *  - buildWorkbook(project) → Uint8Array
 *  - download(project)     → 浏览器触发下载
 *  - 导出结构：总览、每个模型一张字段表、血缘清单；首行冻结、表头样式、自适应列宽
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XlsxExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- CRC32 ----------
  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();
  function crc32(bytes) {
    var c = 0 ^ (-1);
    for (var i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ (-1)) >>> 0;
  }

  // ---------- ZIP（stored 无压缩） ----------
  function dosDateTime(d) {
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  function zipStore(files) { // files: [{name, data:Uint8Array}]
    var now = dosDateTime(new Date());
    var parts = [], central = [], offset = 0;
    var enc = new TextEncoder();

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var data = f.data;
      var crc = crc32(data);
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);   // local file header
      dv.setUint16(4, 20, true);           // version needed
      dv.setUint16(6, 0x0800, true);       // flags: UTF-8
      dv.setUint16(8, 0, true);            // method: stored
      dv.setUint16(10, now.time, true);
      dv.setUint16(12, now.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); // comp size
      dv.setUint32(22, data.length, true); // uncomp size
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);           // extra len
      lh.set(nameBytes, 30);
      parts.push(lh, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central dir header
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // comment
      cv.setUint16(34, 0, true);           // disk start
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // local header offset
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += lh.length + data.length;
    });

    var centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + centralSize + 22;
    var out = new Uint8Array(total), pos = 0;
    parts.concat(central, [eocd]).forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  // ---------- XML 工具 ----------
  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\t/g, ' ');
  }
  function colLetter(n) { // 1-based → A, B, ... AA ...
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  // rows: [[cell,...]]，cell: {v:值, n:数字, s:样式号}；字符串用 inlineStr
  function sheetXml(rows, widths) {
    var cols = '';
    if (widths && widths.length) {
      cols = '<cols>' + widths.map(function (w, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      }).join('') + '</cols>';
    }
    var body = rows.map(function (row, ri) {
      var r = ri + 1;
      var cells = row.map(function (cell, ci) {
        var ref = colLetter(ci + 1) + r;
        var s = cell.s ? ' s="' + cell.s + '"' : '';
        if (cell.n !== undefined && cell.n !== null && cell.n !== '') {
          return '<c r="' + ref + '"' + s + '><v>' + Number(cell.n) + '</v></c>';
        }
        var text = cell.v == null ? '' : String(cell.v);
        return '<c r="' + ref + '" t="inlineStr"' + s + '><is><t xml:space="preserve">' + xmlEsc(text) + '</t></is></c>';
      }).join('');
      return '<row r="' + r + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      cols + '<sheetData>' + body + '</sheetData></worksheet>';
  }

  var HEADER_STYLE = 1; // cellXfs 第二项：粗体 + 填充
  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE8EE"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '</cellXfs></styleSheet>';

  function contentTypesXml(sheetCount) {
    var overrides = '';
    for (var i = 1; i <= sheetCount; i++) {
      overrides += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      overrides + '</Types>';
  }

  // ---------- Sheet 构建 ----------
  function h(v) { return { v: v, s: HEADER_STYLE }; } // 表头单元格
  function t(v) { return { v: v }; }                  // 普通文本
  function num(v) { return { n: v }; }                // 数字

  function overviewSheet(project) {
    var modelCols = (project.customCols && project.customCols.model) || [];
    var head = ['序号', '分层', '表名', '中文名', '描述', '源系统', '字段数', '分区', '源表', 'WHERE', 'GROUP BY']
      .concat(modelCols.map(function (c) { return c.label; }));
    var rows = [head.map(h)];
    var byId = {};
    (project.models || []).forEach(function (m) { byId[m.id] = m; });
    // 按拓扑序输出
    var order = [];
    var visited = {};
    (function visit(m) {
      if (visited[m.id]) return;
      visited[m.id] = true;
      (m.sources || []).forEach(function (s) {
        var up = s.name && byId[s.name] && s.name !== m.name ? byId[s.name] : null;
        if (up && !visited[up.id]) visit(up);
      });
      order.push(m);
    })(project.models[0] || { id: '__none__', sources: [] });
    if (order.length && order[0].id === '__none__') order = [];
    (project.models || []).forEach(function (m) { if (!visited[m.id]) order.push(m); });

    order.forEach(function (m, i) {
      rows.push([
        num(i + 1),
        t(String(m.layer || '').toUpperCase()),
        t(m.name), t(m.cnName || ''), t(m.desc || ''), t(m.source || ''),
        num((m.fields || []).length),
        t((m.partition || []).map(function (p) { return p.name; }).join(', ')),
        t((m.sources || []).map(function (s) { return s.name + (s.alias ? '(' + s.alias + ')' : ''); }).join(', ')),
        t(m.where || ''), t(m.groupBy || '')
      ].concat(modelCols.map(function (c) { return t(m[c.key] || ''); })));
    });
    return { rows: rows, widths: [6, 7, 26, 20, 36, 26, 8, 12, 30, 24, 20].concat(modelCols.map(function () { return 14; })) };
  }

  function modelSheet(m) {
    var fieldCols = (m._fieldCols) || [];
    var head = ['序号', '字段名', '类型', '注释', '主键', '业务逻辑 / 表达式', '分区']
      .concat(fieldCols.map(function (c) { return c.label; }));
    var rows = [head.map(h)];
    var i = 0;
    (m.fields || []).forEach(function (f) {
      i++;
      rows.push([num(i), t(f.name), t(f.type), t(f.comment || ''), t(f.pk ? '是' : ''),
        t(f.expr || ''), ''].concat(fieldCols.map(function (c) { return t(f[c.key] || ''); })));
    });
    (m.partition || []).forEach(function (p) {
      i++;
      rows.push([num(i), t(p.name), t(p.type), t(p.comment || ''), '',
        t(p.expr || ''), '分区'].concat(fieldCols.map(function (c) { return t(p[c.key] || ''); })));
    });
    return {
      rows: rows,
      widths: [6, 22, 14, 32, 6, 44, 6].concat(fieldCols.map(function () { return 14; }))
    };
  }

  function lineageSheet(project) {
    var rows = [['序号', '源层', '源表', '目标层', '目标表'].map(h)];
    var byName = {};
    (project.models || []).forEach(function (m) { byName[m.name] = m; });
    var i = 0;
    (project.models || []).forEach(function (m) {
      (m.sources || []).forEach(function (s) {
        var up = byName[s.name];
        if (!up) return; // 外部表不进表级血缘清单
        i++;
        rows.push([num(i), t(String(up.layer || '').toUpperCase()), t(s.name),
          t(String(m.layer || '').toUpperCase()), t(m.name)]);
      });
    });
    return { rows: rows, widths: [6, 8, 28, 8, 28] };
  }

  function safeSheetName(name, used) {
    var base = String(name || '模型').replace(/[\\/?*\[\]:]/g, '_').slice(0, 28) || '模型';
    var n = base, k = 2;
    while (used[n]) { n = base + '_' + k; k++; }
    used[n] = true;
    return n;
  }

  // ---------- 主入口 ----------
  function buildWorkbook(project) {
    var used = {};
    var ov = overviewSheet(project);
    var sheets = [{ name: '总览', xml: sheetXml(ov.rows, ov.widths) }];
    (project.models || []).forEach(function (m) {
      var copy = Object.assign({}, m, { _fieldCols: (project.customCols && project.customCols.field) || [] });
      var s = modelSheet(copy);
      sheets.push({ name: safeSheetName(m.name, used), xml: sheetXml(s.rows, s.widths) });
    });
    var lin = lineageSheet(project);
    sheets.push({ name: '血缘清单', xml: sheetXml(lin.rows, lin.widths) });

    var files = [];
    var sheetRels = sheets.map(function (s, i) {
      return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    }).join('');
    var sheetTags = sheets.map(function (s, i) {
      return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join('');
    var enc = new TextEncoder();

    files.push({ name: '[Content_Types].xml', data: enc.encode(contentTypesXml(sheets.length)) });
    files.push({ name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
    files.push({ name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheetTags + '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheetRels + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') });
    files.push({ name: 'xl/styles.xml', data: enc.encode(STYLES_XML) });
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(s.xml) });
    });

    return zipStore(files);
  }

  function fileName(project) {
    var d = new Date();
    var date = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    return ((project && project.name) || '数据字典') + '_数据字典_' + date + '.xlsx';
  }

  function download(project) {
    var bytes = buildWorkbook(project);
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(project);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    return bytes.length;
  }

  return { buildWorkbook: buildWorkbook, download: download, fileName: fileName, crc32: crc32, zipStore: zipStore };
});
