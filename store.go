package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var (
	db         *sql.DB
	dbMu       sync.Mutex // 写事务 + 快照导出串行化
	dbFilePath string
	snapPath   string
)

func dbFile() string { return dbFilePath }

// projectSnapPath: 默认项目（id=1）沿用 <dataDir>/project.json，其他项目写 <dataDir>/project-{id}.json
func projectSnapPath(projectID int64) string {
	if projectID == 1 {
		return snapPath
	}
	return filepath.Join(dataDir, "project-"+strconv.FormatInt(projectID, 10)+".json")
}

// apiError: 业务错误（HTTP 状态码 + 中文消息），路由层据此回 {"error": ...}
type apiError struct {
	Code int
	Msg  string
}

func (e *apiError) Error() string { return e.Msg }

func errBadRequest(msg string) error { return &apiError{Code: 400, Msg: msg} }
func errNotFound(msg string) error   { return &apiError{Code: 404, Msg: msg} }

// models 表结构：project_id 不设外键（级联删除由应用层保证），catalog_id 挂 L1-L3 目录节点（L4=模型）
const modelsTableDDL = `CREATE TABLE IF NOT EXISTS %s (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 1,
  catalog_id TEXT,
  layer TEXT NOT NULL DEFAULT 'ods',
  name TEXT NOT NULL DEFAULT '',
  cn_name TEXT NOT NULL DEFAULT '',
  descr TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  where_txt TEXT NOT NULL DEFAULT '',
  group_by TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}'
)`

var schemaDDL = []string{
	// 旧单项目表：仅保留作兼容迁移来源，不再读写（多项目见 projects）
	`CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '未命名项目',
  dialect TEXT NOT NULL DEFAULT 'hive',
  updated_at TEXT
)`,
	// 多项目表：models.project_id 指向此表（级联删除由应用层保证）
	`CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '未命名项目',
  dialect TEXT NOT NULL DEFAULT 'hive',
  updated_at TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}'
)`,
	fmt.Sprintf(modelsTableDDL, "models"),
	`CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'string',
  comment TEXT NOT NULL DEFAULT '',
  pk INTEGER NOT NULL DEFAULT 0,
  expr TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
)`,
	`CREATE TABLE IF NOT EXISTS partitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'string',
  comment TEXT NOT NULL DEFAULT '',
  expr TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
)`,
	`CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  alias TEXT NOT NULL DEFAULT '',
  on_txt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
)`,
	// L1-L5 业务目录树：L1 业务域（树根）/ L2 主题域（任意深度嵌套）/ L3 业务对象；
	// L4=数据模型（models.catalog_id）、L5=字段（models→fields）
	`CREATE TABLE IF NOT EXISTS catalog (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  parent_id TEXT,
  level INTEGER NOT NULL,
  name TEXT NOT NULL,
  cn_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT NOT NULL DEFAULT '{}'
)`,
}

func openStore() error {
	dbFilePath = filepath.Join(dataDir, "workbench.db")
	snapPath = filepath.Join(dataDir, "project.json")
	var err error
	// DSN 每连接生效：外键 + WAL + 忙等待（连接池 >1 时保证语义一致）
	dsn := "file:" + dbFilePath + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(4) // dbGetProjectID 迭代模型行时嵌套查询字段/分区/源表，需要多连接
	for _, pragma := range []string{"PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"} {
		if _, err := db.Exec(pragma); err != nil {
			return err
		}
	}
	for _, s := range schemaDDL {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}
	ensureColumn("project", "extra_json", "TEXT NOT NULL DEFAULT '{}'")
	ensureColumn("models", "extra_json", "TEXT NOT NULL DEFAULT '{}'")
	ensureColumn("fields", "extra_json", "TEXT NOT NULL DEFAULT '{}'")
	migrateLegacyProject() // 旧单项目库 → 多项目结构（含 models 外键重建）
	ensureColumn("models", "project_id", "INTEGER NOT NULL DEFAULT 1")
	ensureColumn("models", "catalog_id", "TEXT")
	return nil
}

func ensureColumn(table, col, ddl string) {
	rows, err := db.Query("SELECT name FROM pragma_table_info('" + table + "')")
	if err != nil {
		return
	}
	exists := false
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err == nil && name == col {
			exists = true
			break
		}
	}
	rows.Close()
	if !exists {
		db.Exec("ALTER TABLE " + table + " ADD COLUMN " + col + " " + ddl)
	}
}

// ===== 旧单项目库 → 多项目迁移（仅启动时执行一次）=====
// - models 表若带指向旧 project 表的外键则重建去除（否则 project_id>1 的插入会被外键拒绝）
// - 旧 project 表 id=1 行整体搬入 projects(id=1)（含 extra_json）；models.project_id=1 不动
// - 旧 project 表保留不删（数据目录仍被 Node 版服务共用的过渡期兼容）
func migrateLegacyProject() {
	dbMu.Lock()
	defer dbMu.Unlock()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM projects").Scan(&n); err != nil || n > 0 {
		return
	}
	var hasLegacy int
	if err := db.QueryRow("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project')").Scan(&hasLegacy); err != nil || hasLegacy == 0 {
		return
	}
	if modelsReferencesLegacyProject() {
		if err := rebuildModelsTable(); err != nil {
			fmt.Println("[dw-workbench] models 表迁移失败（将在下次启动重试）:", err)
			return
		}
		fmt.Println("[dw-workbench] models 表已重建：移除指向旧 project 表的外键，级联删除改由应用层保证")
	}
	res, err := db.Exec(`INSERT INTO projects (id, name, dialect, updated_at, extra_json)
		SELECT 1, name, dialect, updated_at, extra_json FROM project WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM projects)`)
	if err != nil {
		fmt.Println("[dw-workbench] project 表迁移失败:", err)
		return
	}
	if rows, _ := res.RowsAffected(); rows > 0 {
		fmt.Println("[dw-workbench] 已迁移旧单项目数据到 projects(id=1)，models.project_id=1 保持不变")
	}
}

func modelsReferencesLegacyProject() bool {
	rows, err := db.Query(`SELECT "table" FROM pragma_foreign_key_list('models')`)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil && t == "project" {
			return true
		}
	}
	return false
}

// rebuildModelsTable: 专用连接上关外键重建 models 表（SQLite 12 步 ALTER 的等价简化）
// 期间 DROP TABLE models 不会级联清空 fields/partitions/sources
func rebuildModelsTable() (err error) {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		conn.ExecContext(ctx, "PRAGMA foreign_keys = ON") // 归还连接池前恢复外键
		conn.Close()
	}()
	if _, err = conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	for _, s := range []string{
		`DROP TABLE IF EXISTS models_new`,
		fmt.Sprintf(modelsTableDDL, "models_new"),
		`INSERT INTO models_new (id, project_id, layer, name, cn_name, descr, source, notes, where_txt, group_by, sort_order, created_at, extra_json)
		 SELECT id, project_id, layer, name, cn_name, descr, source, notes, where_txt, group_by, sort_order, created_at, extra_json FROM models`,
		`DROP TABLE models`,
		`ALTER TABLE models_new RENAME TO models`,
	} {
		if _, err = tx.Exec(s); err != nil {
			return err
		}
	}
	err = tx.Commit()
	return err
}

// ================= JS 语义辅助 =================
// jsTruthy: JS 的真值判断（”/0/false/null/undefined 均为假）
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int:
		return t != 0
	case int64:
		return t != 0
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}

// jsStr: JS 的 String() 语义
func jsStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	}
	b, _ := json.Marshal(v)
	if len(b) > 0 && b[0] == '"' {
		var s string
		json.Unmarshal(b, &s)
		return s
	}
	return string(b)
}

// jsOr: JS 的 v || fallback 语义
func jsOr(v any, fallback string) string {
	if jsTruthy(v) {
		return jsStr(v)
	}
	return fallback
}

func parseExtra(s string) map[string]any {
	m := map[string]any{}
	if s != "" {
		_ = json.Unmarshal([]byte(s), &m)
	}
	return m
}

// splitExtra: 拆出已知键，其余打包为 extra JSON；allowObjects 用于项目级配置
func splitExtra(obj map[string]any, known []string, allowObjects bool) string {
	extra := map[string]any{}
	for k, v := range obj {
		if containsStr(known, k) || v == nil {
			continue
		}
		switch v.(type) {
		case map[string]any, []any:
			if !allowObjects {
				continue
			}
		}
		extra[k] = v
	}
	b, _ := json.Marshal(extra)
	return string(b)
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func indexOfStr(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

func inPlaceholders(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = "?"
	}
	return strings.Join(parts, ",")
}

// 对应 JS Math.random().toString(36).slice(2, 7)
func randSeq(n int) string {
	letters := "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, n)
	for i := range out {
		out[i] = letters[rand.Intn(len(letters))]
	}
	return string(out)
}

var modelKnown = []string{"id", "layer", "name", "cnName", "desc", "source", "notes", "where", "groupBy", "createdAt", "catalogId", "fields", "partition", "sources"}
var fieldKnown = []string{"name", "type", "comment", "pk", "expr"}
var modelRowSkip = []string{"id", "project_id", "catalog_id", "layer", "name", "cn_name", "descr", "source", "notes", "where_txt", "group_by", "sort_order", "created_at", "extra_json"}
var fieldRowSkip = []string{"model_id", "name", "type", "comment", "pk", "expr", "sort_order", "extra_json"}

// ================= 项目读取/保存 =================

// dbGetProject: DSH/默认项目流程用（project.json 同构的默认项目读取）
func dbGetProject() (map[string]any, bool) { return dbGetProjectID(1) }

// dbGetProjectID: 与 Node 版 dbGetProject 同构（camelCase 键 + extra 合并），按 projectId 读取
func dbGetProjectID(projectID int64) (map[string]any, bool) {
	dbMu.Lock()
	defer dbMu.Unlock()
	return dbGetLocked(projectID)
}

func dbGetLocked(projectID int64) (map[string]any, bool) {
	var name, dialect, extraJSON string
	if err := db.QueryRow("SELECT name, dialect, extra_json FROM projects WHERE id = ?", projectID).Scan(&name, &dialect, &extraJSON); err != nil {
		return nil, false
	}
	proj := parseExtra(extraJSON)
	proj["name"], proj["dialect"] = name, dialect
	delete(proj, "extra_json")
	data := map[string]any{"name": name, "dialect": dialect}
	for k, v := range proj {
		if k == "name" || k == "dialect" || k == "id" || k == "updated_at" || v == nil {
			continue
		}
		data[k] = v
	}

	mrows, err := db.Query(`SELECT id, COALESCE(catalog_id, ''), layer, name, cn_name, descr, source, notes, where_txt, group_by, created_at, extra_json FROM models WHERE project_id = ? ORDER BY sort_order`, projectID)
	if err != nil {
		data["models"] = []any{}
		return data, true
	}
	defer mrows.Close()
	models := []any{}
	for mrows.Next() {
		var id, catalogID, layer, mName, cnName, descr, source, notes, whereTxt, groupBy, extraJSON string
		var createdAt sql.NullString
		if err := mrows.Scan(&id, &catalogID, &layer, &mName, &cnName, &descr, &source, &notes, &whereTxt, &groupBy, &createdAt, &extraJSON); err != nil {
			continue
		}
		m := parseExtra(extraJSON)
		m["id"], m["layer"], m["name"], m["cn_name"], m["descr"], m["source"], m["notes"], m["where_txt"], m["group_by"] = id, layer, mName, cnName, descr, source, notes, whereTxt, groupBy
		if createdAt.Valid {
			m["created_at"] = createdAt.String
		} else {
			m["created_at"] = nil
		}
		delete(m, "extra_json")

		model := map[string]any{
			"id": id, "layer": layer, "name": mName, "cnName": cnName, "desc": descr,
			"source": source, "notes": notes, "where": whereTxt, "groupBy": groupBy,
			"createdAt": m["created_at"],
		}
		for k, v := range m {
			if containsStr(modelRowSkip, k) || v == nil {
				continue
			}
			model[k] = v
		}
		if catalogID != "" {
			model["catalogId"] = catalogID
		}

		// fields
		fields := []any{}
		if frows, err := db.Query("SELECT name, type, comment, pk, expr, extra_json FROM fields WHERE model_id = ? ORDER BY sort_order", id); err == nil {
			for frows.Next() {
				var fname, ftype, fcomment, fexpr, fextra string
				var pk int
				if err := frows.Scan(&fname, &ftype, &fcomment, &pk, &fexpr, &fextra); err != nil {
					continue
				}
				f := parseExtra(fextra)
				f["name"], f["type"], f["comment"], f["pk"], f["expr"] = fname, ftype, fcomment, pk != 0, fexpr
				delete(f, "extra_json")
				field := map[string]any{"name": fname, "type": ftype, "comment": fcomment, "pk": pk != 0, "expr": fexpr}
				for k, v := range f {
					if containsStr(fieldRowSkip, k) || v == nil {
						continue
					}
					field[k] = v
				}
				fields = append(fields, field)
			}
			frows.Close()
		}
		model["fields"] = fields

		// partitions
		partition := []any{}
		if prows, err := db.Query("SELECT name, type, comment, expr FROM partitions WHERE model_id = ? ORDER BY sort_order", id); err == nil {
			for prows.Next() {
				var n, t, c, e string
				if err := prows.Scan(&n, &t, &c, &e); err != nil {
					continue
				}
				partition = append(partition, map[string]any{"name": n, "type": t, "comment": c, "expr": e})
			}
			prows.Close()
		}
		model["partition"] = partition

		// sources
		sources := []any{}
		if srows, err := db.Query("SELECT name, alias, on_txt FROM sources WHERE model_id = ? ORDER BY sort_order", id); err == nil {
			for srows.Next() {
				var n, a, o string
				if err := srows.Scan(&n, &a, &o); err != nil {
					continue
				}
				sources = append(sources, map[string]any{"name": n, "alias": a, "on": o})
			}
			srows.Close()
		}
		model["sources"] = sources

		models = append(models, model)
	}
	data["models"] = models
	return data, true
}

func dbPutProjectID(projectID int64, data map[string]any) error {
	dbMu.Lock()
	defer dbMu.Unlock()
	return dbPutLocked(projectID, data)
}

func dbPutLocked(projectID int64, data map[string]any) (err error) {
	now := isoNow()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	name := jsOr(data["name"], "未命名项目")
	dialect := jsOr(data["dialect"], "hive")
	extra := splitExtra(data, []string{"name", "dialect", "models"}, true)
	// upsert：与旧版「删了重插」等价——项目行存在则更新，不存在则建（PUT 语义保持总是成功）
	if _, err = tx.Exec(`INSERT INTO projects (id, name, dialect, updated_at, extra_json) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, dialect = excluded.dialect, updated_at = excluded.updated_at, extra_json = excluded.extra_json`,
		projectID, name, dialect, now, extra); err != nil {
		return err
	}
	// 级联清空旧模型（fields/partitions/sources 为 models 的外键级联，这里显式删除保证无外键场景同样干净）
	for _, stmt := range []string{
		`DELETE FROM fields WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)`,
		`DELETE FROM partitions WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)`,
		`DELETE FROM sources WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)`,
		`DELETE FROM models WHERE project_id = ?`,
	} {
		if _, err = tx.Exec(stmt, projectID); err != nil {
			return err
		}
	}
	models, _ := data["models"].([]any)
	for i, mv := range models {
		m, ok := mv.(map[string]any)
		if !ok {
			continue
		}
		id := jsOr(m["id"], "m_"+strconv.FormatInt(time.Now().UnixMilli(), 36)+"_"+strconv.Itoa(i))
		if _, err = tx.Exec(`INSERT INTO models (id, project_id, catalog_id, layer, name, cn_name, descr, source, notes, where_txt, group_by, sort_order, created_at, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, projectID, jsOr(m["catalogId"], ""), jsOr(m["layer"], "ods"), jsOr(m["name"], ""), jsOr(m["cnName"], ""), jsOr(m["desc"], ""), jsOr(m["source"], ""), jsOr(m["notes"], ""), jsOr(m["where"], ""), jsOr(m["groupBy"], ""), i, jsOr(m["createdAt"], now), splitExtra(m, modelKnown, false)); err != nil {
			return err
		}
		if farr, ok := m["fields"].([]any); ok {
			for j, fv := range farr {
				f, ok2 := fv.(map[string]any)
				if !ok2 {
					continue
				}
				pk := 0
				if jsTruthy(f["pk"]) {
					pk = 1
				}
				if _, err = tx.Exec("INSERT INTO fields (model_id, name, type, comment, pk, expr, sort_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					id, jsOr(f["name"], ""), jsOr(f["type"], "string"), jsOr(f["comment"], ""), pk, jsOr(f["expr"], ""), j, splitExtra(f, fieldKnown, false)); err != nil {
					return err
				}
			}
		}
		if parr, ok := m["partition"].([]any); ok {
			for j, pv := range parr {
				p, ok2 := pv.(map[string]any)
				if !ok2 {
					continue
				}
				if _, err = tx.Exec("INSERT INTO partitions (model_id, name, type, comment, expr, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
					id, jsOr(p["name"], ""), jsOr(p["type"], "string"), jsOr(p["comment"], ""), jsOr(p["expr"], ""), j); err != nil {
					return err
				}
			}
		}
		if sarr, ok := m["sources"].([]any); ok {
			for j, sv := range sarr {
				s, ok2 := sv.(map[string]any)
				if !ok2 {
					continue
				}
				if _, err = tx.Exec("INSERT INTO sources (model_id, name, alias, on_txt, sort_order) VALUES (?, ?, ?, ?, ?)",
					id, jsOr(s["name"], ""), jsOr(s["alias"], ""), jsOr(s["on"], ""), j); err != nil {
					return err
				}
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return exportSnapshotLocked(projectID)
}

// project.json 快照：DSH / 文件工作流兼容；默认项目 project.json，其他项目 project-{id}.json
func exportSnapshotLocked(projectID int64) error {
	data, ok := dbGetLocked(projectID)
	if !ok {
		return nil
	}
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(projectSnapPath(projectID), b, 0o644)
}

// 首次启动：库为空但存在旧 project.json → 自动迁移入库（默认项目）
func migrateIfNeeded() {
	dbMu.Lock()
	var n int
	err := db.QueryRow("SELECT COUNT(*) FROM projects").Scan(&n)
	dbMu.Unlock()
	if err == nil && n > 0 {
		return
	}
	b, err := os.ReadFile(snapPath)
	if err != nil {
		return
	}
	var data map[string]any
	if err := json.Unmarshal(b, &data); err != nil {
		return
	}
	if ms, ok := data["models"].([]any); ok {
		if err := dbPutProjectID(1, data); err == nil {
			fmt.Println("[dw-workbench] 已从 project.json 迁移 " + strconv.Itoa(len(ms)) + " 个模型到 workbench.db")
		}
	}
}

// ================= 多项目管理 =================

// projectInfo: 项目列表/管理用行结构
type projectInfo struct {
	id         int64
	name       string
	dialect    string
	updatedAt  sql.NullString
	modelCount int
}

func (p projectInfo) toMap() map[string]any {
	var updated any
	if p.updatedAt.Valid {
		updated = p.updatedAt.String
	}
	return map[string]any{"id": p.id, "name": p.name, "dialect": p.dialect, "updatedAt": updated, "modelCount": p.modelCount}
}

func dbListProjects() []map[string]any {
	dbMu.Lock()
	defer dbMu.Unlock()
	rows, err := db.Query(`SELECT p.id, p.name, p.dialect, p.updated_at,
		(SELECT COUNT(*) FROM models m WHERE m.project_id = p.id) AS model_count
		FROM projects p ORDER BY p.id`)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var p projectInfo
		if err := rows.Scan(&p.id, &p.name, &p.dialect, &p.updatedAt, &p.modelCount); err != nil {
			continue
		}
		out = append(out, p.toMap())
	}
	return out
}

func dbCreateProject(name, dialect string) (projectInfo, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	res, err := db.Exec("INSERT INTO projects (name, dialect, updated_at, extra_json) VALUES (?, ?, ?, '{}')", name, dialect, isoNow())
	if err != nil {
		return projectInfo{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return projectInfo{}, err
	}
	var modelCount int
	db.QueryRow("SELECT COUNT(*) FROM models WHERE project_id = ?", id).Scan(&modelCount)
	p := projectInfo{id: id, name: name, dialect: dialect, updatedAt: sql.NullString{String: isoNow(), Valid: true}, modelCount: modelCount}
	_ = exportSnapshotLocked(id)
	return p, nil
}

// dbUpdateProject: body 里出现 name/dialect 才更新对应字段（空值回退当前值），返回更新后的项目行
func dbUpdateProject(id int64, fields map[string]any) (projectInfo, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	var p projectInfo
	p.id = id
	err := db.QueryRow("SELECT name, dialect, updated_at FROM projects WHERE id = ?", id).Scan(&p.name, &p.dialect, &p.updatedAt)
	if err == sql.ErrNoRows {
		return projectInfo{}, errNotFound("项目不存在")
	}
	if err != nil {
		return projectInfo{}, err
	}
	if v, has := fields["name"]; has && v != nil {
		p.name = jsOr(v, p.name)
	}
	if v, has := fields["dialect"]; has && v != nil {
		p.dialect = jsOr(v, p.dialect)
	}
	if _, err = db.Exec("UPDATE projects SET name = ?, dialect = ?, updated_at = ? WHERE id = ?", p.name, p.dialect, isoNow(), id); err != nil {
		return projectInfo{}, err
	}
	db.QueryRow("SELECT COUNT(*) FROM models WHERE project_id = ?", id).Scan(&p.modelCount)
	db.QueryRow("SELECT updated_at FROM projects WHERE id = ?", id).Scan(&p.updatedAt)
	_ = exportSnapshotLocked(id)
	return p, nil
}

// dbDeleteProject: 级联删除 models/fields/partitions/sources/catalog 及项目快照文件
func dbDeleteProject(id int64) error {
	dbMu.Lock()
	defer dbMu.Unlock()
	var one int
	if err := db.QueryRow("SELECT id FROM projects WHERE id = ?", id).Scan(&one); err == sql.ErrNoRows {
		return errNotFound("项目不存在")
	} else if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range []string{
		`DELETE FROM fields WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)`,
		`DELETE FROM partitions WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)`,
		`DELETE FROM sources WHERE model_id IN (SELECT id FROM models WHERE project_id = ?)`,
		`DELETE FROM models WHERE project_id = ?`,
		`DELETE FROM catalog WHERE project_id = ?`,
		`DELETE FROM projects WHERE id = ?`,
	} {
		if _, err = tx.Exec(stmt, id); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	_ = os.Remove(projectSnapPath(id)) // 同步清理快照，避免 migrateIfNeeded 复活已删项目
	return nil
}

// ================= L1-L5 业务目录树 =================

type catalogRow struct {
	id     string
	parent string
	level  int
	name   string
	cnName string
}

func loadCatalogRows(projectID int64) ([]catalogRow, error) {
	rows, err := db.Query(`SELECT id, COALESCE(parent_id, ''), level, name, cn_name FROM catalog WHERE project_id = ? ORDER BY sort_order, id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []catalogRow{}
	for rows.Next() {
		var r catalogRow
		if err := rows.Scan(&r.id, &r.parent, &r.level, &r.name, &r.cnName); err != nil {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

// dbGetCatalogTree: 服务端组树，同层按 sort_order（次按 id）；父节点缺失/脏环的节点升为根，避免数据丢失
func dbGetCatalogTree(projectID int64) []map[string]any {
	dbMu.Lock()
	defer dbMu.Unlock()
	rows, err := loadCatalogRows(projectID)
	if err != nil {
		return []map[string]any{}
	}
	byID := map[string]map[string]any{}
	parentOf := map[string]string{}
	order := []string{}
	for _, r := range rows {
		if _, dup := byID[r.id]; dup {
			continue
		}
		byID[r.id] = map[string]any{"id": r.id, "level": r.level, "name": r.name, "cnName": r.cnName, "children": []any{}}
		parentOf[r.id] = r.parent
		order = append(order, r.id)
	}
	roots := []map[string]any{}
	for _, id := range order {
		node := byID[id]
		if pm, ok := byID[parentOf[id]]; ok && parentOf[id] != id {
			pm["children"] = append(pm["children"].([]any), node)
		} else {
			roots = append(roots, node)
		}
	}
	return roots
}

// dbCatalogNodeProject: 节点 id 全局唯一 → 反查所属项目
func dbCatalogNodeProject(id string) (int64, bool) {
	dbMu.Lock()
	defer dbMu.Unlock()
	var projectID int64
	if err := db.QueryRow("SELECT project_id FROM catalog WHERE id = ?", id).Scan(&projectID); err != nil {
		return 0, false
	}
	return projectID, true
}

// catalogSubtreeIDs: 收集 rootID 的全部后代（不含自身），内存 BFS
func catalogSubtreeIDs(rows []catalogRow, rootID string) []string {
	childrenOf := map[string][]string{}
	for _, r := range rows {
		if r.parent != "" && r.parent != r.id {
			childrenOf[r.parent] = append(childrenOf[r.parent], r.id)
		}
	}
	out := []string{}
	queue := append([]string{}, childrenOf[rootID]...)
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		out = append(out, next)
		queue = append(queue, childrenOf[next]...)
	}
	return out
}

func newCatalogID() string {
	return "c_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + randSeq(5)
}

// dbCreateCatalogNode: 建节点；level∈{1,2,3}、name 非空、project/parent 存在性校验
func dbCreateCatalogNode(projectID int64, parentID string, level int, name, cnName string) (map[string]any, error) {
	if level < 1 || level > 3 {
		return nil, errBadRequest("level 必须为 1、2 或 3")
	}
	if strings.TrimSpace(name) == "" {
		return nil, errBadRequest("节点名称不能为空")
	}
	dbMu.Lock()
	defer dbMu.Unlock()
	var one int
	if err := db.QueryRow("SELECT id FROM projects WHERE id = ?", projectID).Scan(&one); err == sql.ErrNoRows {
		return nil, errNotFound("项目不存在")
	} else if err != nil {
		return nil, err
	}
	if parentID != "" {
		var pid int64
		if err := db.QueryRow("SELECT project_id FROM catalog WHERE id = ?", parentID).Scan(&pid); err == sql.ErrNoRows {
			return nil, errNotFound("父节点不存在")
		} else if err != nil {
			return nil, err
		} else if pid != projectID {
			return nil, errBadRequest("父节点不属于该项目")
		}
	}
	id := newCatalogID()
	var parentVal any
	if parentID != "" {
		parentVal = parentID
	}
	if _, err := db.Exec(`INSERT INTO catalog (id, project_id, parent_id, level, name, cn_name, sort_order, extra_json)
		VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM catalog WHERE project_id = ? AND IFNULL(parent_id, '') = ?), '{}')`,
		id, projectID, parentVal, level, name, cnName, projectID, parentID); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "parentId": parentVal, "level": level, "name": name, "cnName": cnName, "children": []any{}}, nil
}

// dbUpdateCatalogNode: 改名/移动（body 出现 name/cnName/parentId 才生效）；
// 环检测——新父不能是自身或自身后代
func dbUpdateCatalogNode(projectID int64, id string, fields map[string]any) (map[string]any, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	var projID int64
	var level int
	var curName, curCN, curParent string
	err := db.QueryRow("SELECT project_id, level, name, cn_name, COALESCE(parent_id, '') FROM catalog WHERE id = ?", id).Scan(&projID, &level, &curName, &curCN, &curParent)
	if err == sql.ErrNoRows {
		return nil, errNotFound("节点不存在")
	}
	if err != nil {
		return nil, err
	}
	if projID != projectID {
		return nil, errNotFound("节点不存在")
	}
	newName, newCN := curName, curCN
	if v, has := fields["name"]; has && v != nil {
		newName = jsOr(v, curName)
		if strings.TrimSpace(newName) == "" {
			return nil, errBadRequest("节点名称不能为空")
		}
	}
	if v, has := fields["cnName"]; has && v != nil {
		newCN = jsOr(v, curCN)
	}
	parentSet := false
	parentID := ""
	if v, has := fields["parentId"]; has {
		parentSet = true
		if v != nil {
			parentID = jsOr(v, "")
		}
	}
	if parentSet && parentID == id {
		return nil, errBadRequest("不能移动到自身或其子节点下")
	}
	if parentSet && parentID != "" {
		var pid int64
		if err := db.QueryRow("SELECT project_id FROM catalog WHERE id = ?", parentID).Scan(&pid); err == sql.ErrNoRows {
			return nil, errNotFound("父节点不存在")
		} else if err != nil {
			return nil, err
		} else if pid != projID {
			return nil, errBadRequest("父节点不属于该项目")
		}
		if rows, err := loadCatalogRows(projID); err == nil {
			for _, desc := range catalogSubtreeIDs(rows, id) {
				if desc == parentID {
					return nil, errBadRequest("不能移动到自身或其子节点下")
				}
			}
		}
	}
	if _, err = db.Exec("UPDATE catalog SET name = ?, cn_name = ? WHERE id = ?", newName, newCN, id); err != nil {
		return nil, err
	}
	if parentSet {
		var parentArg any
		if parentID != "" {
			parentArg = parentID
		}
		if _, err = db.Exec(`UPDATE catalog SET parent_id = ?,
			sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM catalog WHERE project_id = ? AND IFNULL(parent_id, '') = ?) WHERE id = ?`,
			parentArg, projID, parentID, id); err != nil {
			return nil, err
		}
	}
	var parentVal any
	if parentSet {
		if parentID != "" {
			parentVal = parentID
		}
	} else if curParent != "" {
		parentVal = curParent
	}
	return map[string]any{"id": id, "parentId": parentVal, "level": level, "name": newName, "cnName": newCN}, nil
}

// dbDeleteCatalogNode: 删除整棵子树，子树内 models.catalog_id 置空；返回删除的节点数
func dbDeleteCatalogNode(projectID int64, id string) (int, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	var projID int64
	err := db.QueryRow("SELECT project_id FROM catalog WHERE id = ?", id).Scan(&projID)
	if err == sql.ErrNoRows {
		return 0, errNotFound("节点不存在")
	}
	if err != nil {
		return 0, err
	}
	if projID != projectID {
		return 0, errNotFound("节点不存在")
	}
	rows, err := loadCatalogRows(projID)
	if err != nil {
		return 0, err
	}
	subtree := append([]string{id}, catalogSubtreeIDs(rows, id)...)
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	placeholders := inPlaceholders(len(subtree))
	args := make([]any, len(subtree))
	for i, v := range subtree {
		args[i] = v
	}
	if _, err = tx.Exec("UPDATE models SET catalog_id = '' WHERE catalog_id IN ("+placeholders+")", args...); err != nil {
		return 0, err
	}
	if _, err = tx.Exec("DELETE FROM catalog WHERE id IN ("+placeholders+")", args...); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return len(subtree), nil
}
