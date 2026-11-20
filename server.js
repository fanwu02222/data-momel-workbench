/**
 * 数据建模工作台 · 本地服务（SQLite 版）
 *  - 静态文件服务（index.html / js / css）
 *  - workbench.db（SQLite，WAL）为唯一数据源；project.json 为每次保存自动导出的快照
 *    （首次启动若库为空且存在旧 project.json，会自动迁移入库）
 *  - GET  /api/project      读取完整项目 JSON（与 project.json 快照同构）
 *  - PUT  /api/project      整体保存（事务内全量替换）
 *  - POST /api/dsh          以 headless 模式调用 DSH 智能体执行复杂任务（后台运行）
 *  - GET  /api/dsh/status   查询 DSH 任务进度
 * 启动：node server.js   （默认端口 8130，可用 PORT 环境变量覆盖）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'workbench.db');
const SNAPSHOT_FILE = path.join(ROOT, 'project.json');
const PORT = parseInt(process.env.PORT || '8130', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

// ================= SQLite =================
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '未命名项目',
  dialect TEXT NOT NULL DEFAULT 'hive',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 1 REFERENCES project(id) ON DELETE CASCADE,
  layer TEXT NOT NULL DEFAULT 'ods',
  name TEXT NOT NULL DEFAULT '',
  cn_name TEXT NOT NULL DEFAULT '',
  descr TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  where_txt TEXT NOT NULL DEFAULT '',
  group_by TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'string',
  comment TEXT NOT NULL DEFAULT '',
  pk INTEGER NOT NULL DEFAULT 0,
  expr TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS partitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'string',
  comment TEXT NOT NULL DEFAULT '',
  expr TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  alias TEXT NOT NULL DEFAULT '',
  on_txt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
`);
// 旧库迁移：为扩展属性补 extra_json 列（自定义表列/字段列存这里）
function ensureColumn(table, col, ddl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
  if (!cols.includes(col)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + ddl);
}
ensureColumn('project', 'extra_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('models', 'extra_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('fields', 'extra_json', "TEXT NOT NULL DEFAULT '{}'");
const stmts = {
  hasProject: db.prepare('SELECT id FROM project WHERE id = 1'),
  getProject: db.prepare('SELECT name, dialect, extra_json FROM project WHERE id = 1'),
  insProject: db.prepare('INSERT INTO project (id, name, dialect, updated_at, extra_json) VALUES (1, ?, ?, ?, ?)'),
  updProject: db.prepare('UPDATE project SET name = ?, dialect = ?, updated_at = ? WHERE id = 1'),
  delAll: db.prepare('DELETE FROM project WHERE id = 1'), // 级联清空 models/fields/partitions/sources
  insModel: db.prepare(`INSERT INTO models
    (id, project_id, layer, name, cn_name, descr, source, notes, where_txt, group_by, sort_order, created_at, extra_json)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insField: db.prepare('INSERT INTO fields (model_id, name, type, comment, pk, expr, sort_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  insPart: db.prepare('INSERT INTO partitions (model_id, name, type, comment, expr, sort_order) VALUES (?, ?, ?, ?, ?, ?)'),
  insSource: db.prepare('INSERT INTO sources (model_id, name, alias, on_txt, sort_order) VALUES (?, ?, ?, ?, ?)'),
  getModels: db.prepare(`SELECT id, layer, name, cn_name, descr, source, notes, where_txt, group_by, created_at, extra_json
    FROM models WHERE project_id = 1 ORDER BY sort_order`),
  getFields: db.prepare('SELECT name, type, comment, pk, expr, extra_json FROM fields WHERE model_id = ? ORDER BY sort_order'),
  getParts: db.prepare('SELECT name, type, comment, expr FROM partitions WHERE model_id = ? ORDER BY sort_order'),
  getSources: db.prepare('SELECT name, alias, on_txt FROM sources WHERE model_id = ? ORDER BY sort_order'),
  countModels: db.prepare('SELECT count(*) AS c FROM models')
};

// 拆出已知键，其余打包为 extra JSON（自定义扩展列）；allowObjects 用于项目级配置（如 customCols）
function splitExtra(obj, known, allowObjects) {
  const extra = {};
  for (const k of Object.keys(obj || {})) {
    if (known.indexOf(k) >= 0) continue;
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !allowObjects) continue;
    extra[k] = v;
  }
  return JSON.stringify(extra);
}
function mergeExtra(row, extraKey) {
  let extra = {};
  try { extra = JSON.parse(row[extraKey] || '{}'); } catch (e) { extra = {}; }
  return Object.assign(extra, row, { [extraKey]: undefined });
}

function dbGetProject() {
  const projRow = stmts.getProject.get();
  if (!projRow) return null;
  const proj = mergeExtra(projRow, 'extra_json');
  const data = { name: proj.name, dialect: proj.dialect };
  // 还原项目级扩展键（如 customCols 自定义列配置）
  for (const k of Object.keys(proj)) {
    if (['id', 'name', 'dialect', 'updated_at', 'extra_json'].indexOf(k) < 0 && proj[k] !== undefined) data[k] = proj[k];
  }
  data.models = stmts.getModels.all().map(function (mRow, i) {
    const m = mergeExtra(mRow, 'extra_json');
    const model = {
      id: m.id, layer: m.layer, name: m.name, cnName: m.cn_name, desc: m.descr,
      source: m.source, notes: m.notes, where: m.where_txt, groupBy: m.group_by,
      createdAt: m.created_at
    };
    for (const k of Object.keys(m)) {
      if (['id', 'project_id', 'layer', 'name', 'cn_name', 'descr', 'source', 'notes', 'where_txt', 'group_by', 'sort_order', 'created_at', 'extra_json'].indexOf(k) < 0 && m[k] !== undefined) model[k] = m[k];
    }
    model.fields = stmts.getFields.all(m.id).map(function (fRow) {
      const f = mergeExtra(fRow, 'extra_json');
      const field = { name: f.name, type: f.type, comment: f.comment, pk: !!f.pk, expr: f.expr };
      for (const k of Object.keys(f)) {
        if (['model_id', 'name', 'type', 'comment', 'pk', 'expr', 'sort_order', 'extra_json'].indexOf(k) < 0 && f[k] !== undefined) field[k] = f[k];
      }
      return field;
    });
    model.partition = stmts.getParts.all(m.id).map(function (f) { return { name: f.name, type: f.type, comment: f.comment, expr: f.expr }; });
    model.sources = stmts.getSources.all(m.id).map(function (s) { return { name: s.name, alias: s.alias, on: s.on_txt }; });
    return model;
  });
  return data;
}

const MODEL_KNOWN = ['id', 'layer', 'name', 'cnName', 'desc', 'source', 'notes', 'where', 'groupBy', 'createdAt', 'fields', 'partition', 'sources'];
const FIELD_KNOWN = ['name', 'type', 'comment', 'pk', 'expr'];

function dbPutProject(data) {
  const now = new Date().toISOString();
  const models = Array.isArray(data.models) ? data.models : [];
  db.exec('BEGIN');
  try {
    stmts.delAll.run(); // 级联清空
    stmts.insProject.run(String(data.name || '未命名项目'), String(data.dialect || 'hive'), now,
      splitExtra(data, ['name', 'dialect', 'models'], true));
    models.forEach(function (m, i) {
      const id = String(m.id || 'm_' + Date.now().toString(36) + '_' + i);
      stmts.insModel.run(id, String(m.layer || 'ods'), String(m.name || ''), String(m.cnName || ''),
        String(m.desc || ''), String(m.source || ''), String(m.notes || ''),
        String(m.where || ''), String(m.groupBy || ''), i, m.createdAt || now,
        splitExtra(m, MODEL_KNOWN));
      (Array.isArray(m.fields) ? m.fields : []).forEach(function (f, j) {
        stmts.insField.run(id, String(f.name || ''), String(f.type || 'string'), String(f.comment || ''), f.pk ? 1 : 0, String(f.expr || ''), j,
          splitExtra(f, FIELD_KNOWN));
      });
      (Array.isArray(m.partition) ? m.partition : []).forEach(function (f, j) {
        stmts.insPart.run(id, String(f.name || ''), String(f.type || 'string'), String(f.comment || ''), String(f.expr || ''), j);
      });
      (Array.isArray(m.sources) ? m.sources : []).forEach(function (s, j) {
        stmts.insSource.run(id, String(s.name || ''), String(s.alias || ''), String(s.on || ''), j);
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  exportSnapshot();
}

// project.json 快照：DSH / 文件工作流兼容
function exportSnapshot() {
  const data = dbGetProject();
  if (data) fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 首次启动：库为空但存在旧 project.json → 自动迁移入库
function migrateIfNeeded() {
  if (stmts.hasProject.get()) return;
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
      if (data && Array.isArray(data.models)) {
        dbPutProject(data);
        console.log('[dw-workbench] 已从 project.json 迁移 ' + data.models.length + ' 个模型到 workbench.db');
      }
    }
  } catch (e) {
    console.error('[dw-workbench] project.json 迁移失败：' + e.message);
  }
}

// ================= Excel 导入 =================
// 解析 ZIP（EOCD → 中央目录 → 各条目；stored / deflate 均支持）
function zipParse(buf) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65558); i--) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const flags = buf.readUInt16LE(p + 8);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    const lnLen = buf.readUInt16LE(localOffset + 26);
    const leLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lnLen + leLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function xmlUnescape(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}
function xmlTexts(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'g');
  let out = '', m;
  while ((m = re.exec(xml)) !== null) out += m[1];
  return xmlUnescape(out.replace(/<[^>]*>/g, ''));
}

// 解析 worksheet → 行×列 的二维文本数组
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowIdx = parseInt(rm[1], 10);
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2])) !== null) {
      const attrs = cm[1] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!ref) continue;
      let col = 0;
      for (const ch of ref[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      const typeM = /\bt="(\w+)"/.exec(attrs);
      const type = typeM ? typeM[1] : '';
      const inner = cm[2] || '';
      let text = '';
      if (type === 'inlineStr') {
        text = xmlTexts(inner, 't');
      } else if (type === 's') {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        if (v) text = shared[parseInt(v[1], 10)] || '';
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        if (v) text = type === 'b' ? (v[1] === '1' ? '是' : '') : xmlUnescape(v[1]);
      }
      cells[col - 1] = text;
    }
    rows[rowIdx - 1] = cells;
  }
  // 压实稀疏数组
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function importExcel(buf, mode) {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('不是有效的 .xlsx 文件');
  const z = zipParse(buf);
  const enc = (s) => s.replace(/^\uFEFF/, '').trim();

  // 共享字符串
  const shared = [];
  if (z['xl/sharedStrings.xml']) {
    const xml = z['xl/sharedStrings.xml'].toString('utf8');
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) shared.push(xmlTexts(m[1], 't'));
  }

  // sheet 顺序：workbook.xml + rels
  const wbXml = z['xl/workbook.xml'].toString('utf8');
  const relsXml = z['xl/_rels/workbook.xml.rels'] ? z['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
  const relMap = {};
  const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml)) !== null) relMap[rm[1]] = rm[2];
  const sheetOrder = [];
  const sheetRe = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
  while ((rm = sheetRe.exec(wbXml)) !== null) {
    const target = (relMap[rm[2]] || '').replace(/^\//, '').replace(/^xl\//, '');
    const file = 'xl/' + target;
    if (z[file]) sheetOrder.push({ name: xmlUnescape(rm[1]), grid: parseSheet(z[file].toString('utf8'), shared) });
  }
  if (!sheetOrder.length) throw new Error('xlsx 中未找到工作表');

  const byName = {};
  sheetOrder.forEach(s => { byName[s.name] = s.grid; });
  const grid = (name) => byName[name] || [];
  const headerOf = (g) => (g[0] || []).map(x => String(x || '').trim());
  const findCol = (headers, names) => headers.findIndex(h => names.indexOf(h) >= 0);

  // ---------- 配置 ----------
  const imported = { name: null, dialect: null, customCols: null };
  const cfg = grid('配置');
  if (cfg.length > 1) {
    for (let i = 1; i < cfg.length; i++) {
      const k = String(cfg[i][0] || '').trim(), v = cfg[i][1] !== undefined ? String(cfg[i][1] || '') : '';
      if (k === '项目名') imported.name = v;
      else if (k === '方言') imported.dialect = v;
      else if (k === '表级自定义列' || k === '字段级自定义列') {
        try {
          const list = JSON.parse(v);
          if (!imported.customCols) imported.customCols = { model: [], field: [] };
          imported.customCols[k === '表级自定义列' ? 'model' : 'field'] = Array.isArray(list) ? list : [];
        } catch (e) { /* 非法 JSON 忽略 */ }
      }
    }
  }

  // ---------- 总览 → 模型基础信息 ----------
  const ov = grid('总览');
  const ovHead = headerOf(ov);
  const ovCol = {
    layer: findCol(ovHead, ['分层']), name: findCol(ovHead, ['表名']), cn: findCol(ovHead, ['中文名']),
    desc: findCol(ovHead, ['描述']), source: findCol(ovHead, ['源系统']), notes: findCol(ovHead, ['逻辑说明']),
    where: findCol(ovHead, ['WHERE']), groupBy: findCol(ovHead, ['GROUP BY'])
  };
  if (ovCol.name < 0) throw new Error('总览缺少「表名」列，无法识别模型');
  const modelCols = (imported.customCols && imported.customCols.model) || [];
  const models = [];
  for (let i = 1; i < ov.length; i++) {
    const row = ov[i];
    if (!row || !String(row[ovCol.name] || '').trim()) continue;
    const m = { layer: 'ods', name: String(row[ovCol.name]).trim(), cnName: '', desc: '', source: '', notes: '', where: '', groupBy: '', fields: [], partition: [], sources: [] };
    if (ovCol.layer >= 0) m.layer = String(row[ovCol.layer] || '').trim().toLowerCase() || 'ods';
    if (ovCol.cn >= 0) m.cnName = String(row[ovCol.cn] || '');
    if (ovCol.desc >= 0) m.desc = String(row[ovCol.desc] || '');
    if (ovCol.source >= 0) m.source = String(row[ovCol.source] || '');
    if (ovCol.notes >= 0) m.notes = String(row[ovCol.notes] || '');
    if (ovCol.where >= 0) m.where = String(row[ovCol.where] || '');
    if (ovCol.groupBy >= 0) m.groupBy = String(row[ovCol.groupBy] || '');
    modelCols.forEach(c => { m[c.key] = String(row[ovHead.indexOf(c.label)] || '') || ''; });
    models.push(m);
  }
  const modelByName = {};
  models.forEach(m => { modelByName[m.name] = m; });

  // ---------- 模型 sheet → 字段/分区 ----------
  const fieldCols = (imported.customCols && imported.customCols.field) || [];
  sheetOrder.forEach(s => {
    if (['配置', '总览', '源表映射', '血缘清单'].indexOf(s.name) >= 0) return;
    const m = modelByName[s.name];
    if (!m) {
      // Excel 里出现总览没有的新 sheet → 作为新模型导入（按 sheet 名当表名）
      models.push({ layer: 'ods', name: s.name, cnName: '', desc: '', source: '', notes: '', where: '', groupBy: '', fields: [], partition: [], sources: [] });
      return;
    }
    const head = headerOf(s.grid);
    const cName = findCol(head, ['字段名']), cType = findCol(head, ['类型']), cComment = findCol(head, ['注释']);
    const cPk = findCol(head, ['主键']), cExpr = head.findIndex(h => h.indexOf('业务逻辑') === 0), cPart = findCol(head, ['分区']);
    m.fields = []; m.partition = [];
    for (let i = 1; i < s.grid.length; i++) {
      const row = s.grid[i];
      const name = row && row[cName] !== undefined ? String(row[cName] || '').trim() : '';
      if (!name) continue;
      const f = {
        name, type: cType >= 0 ? String(row[cType] || 'string') : 'string',
        comment: cComment >= 0 ? String(row[cComment] || '') : '',
        pk: cPk >= 0 && String(row[cPk] || '').trim() === '是',
        expr: cExpr >= 0 ? String(row[cExpr] || '') : ''
      };
      fieldCols.forEach(c => { f[c.key] = String(row[head.indexOf(c.label)] || '') || ''; });
      if (cPart >= 0 && String(row[cPart] || '').trim() === '分区') m.partition.push(f);
      else m.fields.push(f);
    }
  });

  // ---------- 源表映射 → sources ----------
  const src = grid('源表映射');
  if (src.length > 1) {
    const head = headerOf(src);
    const cT = findCol(head, ['目标表']), cS = findCol(head, ['源表']), cA = findCol(head, ['别名']), cOn = findCol(head, ['JOIN 条件', 'JOIN条件']);
    if (cT >= 0 && cS >= 0) {
      for (let i = 1; i < src.length; i++) {
        const row = src[i];
        const target = row && row[cT] !== undefined ? String(row[cT] || '').trim() : '';
        const name = row && row[cS] !== undefined ? String(row[cS] || '').trim() : '';
        if (!target || !name) continue;
        const m = modelByName[target];
        if (!m) continue;
        m.sources.push({ name, alias: cA >= 0 ? String(row[cA] || '') : '', on: cOn >= 0 ? String(row[cOn] || '') : '' });
      }
    }
  }

  // ---------- 合并 / 替换 ----------
  const current = dbGetProject();
  let result;
  if (mode === 'replace') {
    result = {
      name: imported.name || (current ? current.name : '未命名项目'),
      dialect: imported.dialect || (current ? current.dialect : 'hive'),
      customCols: imported.customCols || (current ? current.customCols : undefined),
      models
    };
  } else { // merge：文件里的模型按表名覆盖/追加，其余保持
    result = Object.assign({}, current || { name: '未命名项目', dialect: 'hive', models: [] });
    if (imported.customCols) result.customCols = imported.customCols;
    // 合并模式保留当前项目名与方言，仅模型按表名覆盖/追加
    const base = Array.isArray(result.models) ? result.models : [];
    const added = [], updated = [];
    models.forEach(m => {
      const idx = base.findIndex(x => x.name === m.name);
      if (idx >= 0) { base[idx] = Object.assign({}, base[idx], m, { id: base[idx].id }); updated.push(m.name); }
      else { m.id = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); base.push(m); added.push(m.name); }
    });
    result.models = base;
    result._report = { added, updated };
  }
  dbPutProject(result);
  const saved = dbGetProject();
  const report = result._report || { added: models.map(m => m.name), updated: [] };
  delete result._report;
  return { project: saved, added: report.added, updated: report.updated, total: saved.models.length };
}
let dshJobs = {};
let dshJobSeq = 0;

function startDshJob(prompt) {
  const id = 'job_' + Date.now().toString(36) + '_' + (++dshJobSeq);
  const job = { id, prompt, status: 'running', output: '', startedAt: new Date().toISOString(), endedAt: null };
  dshJobs[id] = job;
  const before = JSON.stringify(dbGetProject());
  const child = spawn('dsh', ['--profile', 'headless', '--permission-mode', 'danger-full-access', '-'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DSH_NON_INTERACTIVE: '1' }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.write(prompt);
  child.stdin.end();
  child.stdout.on('data', d => { job.output += d.toString(); });
  child.stderr.on('data', d => { job.output += d.toString(); });
  child.on('error', err => {
    job.status = 'failed';
    job.output += '\n[启动失败] ' + err.message + '（请确认 dsh 已安装并在 PATH 中）';
    job.endedAt = new Date().toISOString();
  });
  child.on('close', code => {
    job.status = code === 0 ? 'done' : 'exit_' + code;
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    try { job.projectChanged = JSON.stringify(dbGetProject()) !== before; } catch (e) { job.projectChanged = false; }
  });
  job.pid = child.pid;
  return job;
}

// ================= HTTP =================
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 20 * 1024 * 1024)) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks))); // 返回 Buffer，文本方自行 toString
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    // 本地工具：禁用缓存，保证改代码后浏览器立即生效
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

  if (pathname === '/api/health') return sendJSON(res, 200, { ok: true, service: 'dw-workbench', storage: 'sqlite', time: new Date().toISOString() });

  if (pathname === '/api/project') {
    if (req.method === 'GET') {
      migrateIfNeeded();
      const data = dbGetProject();
      if (!data) return sendJSON(res, 404, { error: '项目尚未初始化' });
      return sendJSON(res, 200, data);
    }
    if (req.method === 'PUT') {
      try {
        const body = (await readBody(req)).toString('utf-8');
        const data = JSON.parse(body); // 校验
        dbPutProject(data);
        return sendJSON(res, 200, { ok: true, storage: DB_FILE });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    return sendJSON(res, 405, { error: 'method not allowed' });
  }

  if (pathname === '/api/import/excel' && req.method === 'POST') {
    try {
      const buf = await readBody(req, 20 * 1024 * 1024);
      const mode = u.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
      const result = importExcel(buf, mode);
      return sendJSON(res, 200, result);
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/dsh' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf-8'));
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJSON(res, 400, { error: 'prompt 不能为空' });
      const job = startDshJob(prompt);
      return sendJSON(res, 200, { ok: true, jobId: job.id, note: 'DSH 已在后台启动，请轮询 /api/dsh/status' });
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/dsh/status') {
    const job = dshJobs[u.searchParams.get('id')];
    if (!job) return sendJSON(res, 404, { error: '任务不存在' });
    return sendJSON(res, 200, { ok: true, id: job.id, status: job.status, output: job.output, projectChanged: !!job.projectChanged, startedAt: job.startedAt, endedAt: job.endedAt });
  }

  return serveStatic(req, res, pathname);
});

migrateIfNeeded();
server.listen(PORT, '127.0.0.1', () => {
  console.log('[dw-workbench] 数据建模工作台已启动： http://127.0.0.1:' + PORT);
  console.log('[dw-workbench] 数据库： ' + DB_FILE + '（SQLite/WAL）');
  console.log('[dw-workbench] 快照： ' + SNAPSHOT_FILE + '（每次保存自动导出，供 DSH/文件工作流使用）');
});
