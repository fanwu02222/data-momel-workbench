package main

// 数据库连接管理 + 物化执行（DDL 落库）+ 反向拉取（introspect → 模型）
// MySQL / PostgreSQL 直连（database/sql）；Hive 通过 beeline CLI 透传（零重量级依赖）。

import (
	"database/sql"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
)

func ensureConnTable() {
	db.Exec(`CREATE TABLE IF NOT EXISTS db_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- mysql | postgresql | hive
  host TEXT NOT NULL DEFAULT '127.0.0.1',
  port INTEGER NOT NULL DEFAULT 0,
  user_name TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  database_name TEXT NOT NULL DEFAULT '',
  created_at TEXT
)`)
}

type dbConn struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	Password  string `json:"password,omitempty"`
	Database  string `json:"database"`
	CreatedAt string `json:"createdAt"`
}

func defaultPort(kind string, port int) int {
	if port > 0 {
		return port
	}
	switch kind {
	case "mysql":
		return 3306
	case "postgresql":
		return 5432
	case "hive":
		return 10000
	}
	return 0
}

func dbListConnections() []map[string]any {
	dbMu.Lock()
	defer dbMu.Unlock()
	rows, err := db.Query(`SELECT id, name, kind, host, port, user_name, database_name, created_at FROM db_connections ORDER BY id`)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var c dbConn
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Host, &c.Port, &c.User, &c.Database, &c.CreatedAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": c.ID, "name": c.Name, "kind": c.Kind, "host": c.Host, "port": c.Port,
			"user": c.User, "database": c.Database, "createdAt": c.CreatedAt, "hasPassword": true,
		})
	}
	return out
}

func dbCreateConnection(c dbConn) (dbConn, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	res, err := db.Exec(`INSERT INTO db_connections (name, kind, host, port, user_name, password, database_name, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, c.Name, c.Kind, c.Host, defaultPort(c.Kind, c.Port), c.User, c.Password, c.Database, isoNow())
	if err != nil {
		return c, err
	}
	c.ID, _ = res.LastInsertId()
	c.Port = defaultPort(c.Kind, c.Port)
	c.CreatedAt = isoNow()
	return c, nil
}

func dbDeleteConnection(id int64) error {
	dbMu.Lock()
	defer dbMu.Unlock()
	_, err := db.Exec("DELETE FROM db_connections WHERE id = ?", id)
	return err
}

func dbGetConnection(id int64) (dbConn, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	var c dbConn
	err := db.QueryRow(`SELECT id, name, kind, host, port, user_name, password, database_name FROM db_connections WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Kind, &c.Host, &c.Port, &c.User, &c.Password, &c.Database)
	return c, err
}

// ---------- DSN 与打开 ----------

func mysqlDSN(c dbConn) string {
	u := c.User + ":" + c.Password + "@tcp(" + c.Host + ":" + fmt.Sprint(c.Port) + ")/" + c.Database
	return u + "?charset=utf8mb4&multiStatements=true&loc=Local"
}

func pgDSN(c dbConn) string {
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable", c.Host, c.Port, c.User, c.Password, c.Database)
}

func openSQLConn(c dbConn) (*sql.DB, error) {
	switch c.Kind {
	case "mysql":
		return sql.Open("mysql", mysqlDSN(c))
	case "postgresql":
		return sql.Open("postgres", pgDSN(c))
	}
	return nil, fmt.Errorf("该连接类型不走 SQL 通道（hive 请使用 beeline 透传）")
}

// ---------- 连接测试 ----------

func testConnection(c dbConn) (string, error) {
	if c.Kind == "hive" {
		return beelineExec(c, "SELECT 1")
	}
	h, err := openSQLConn(c)
	if err != nil {
		return "", err
	}
	defer h.Close()
	h.SetConnMaxLifetime(6 * time.Second)
	var ver string
	if err := h.Ping(); err != nil {
		return "", err
	}
	if c.Kind == "mysql" {
		h.QueryRow("SELECT VERSION()").Scan(&ver)
	} else {
		h.QueryRow("SELECT version()").Scan(&ver)
	}
	if ver == "" {
		ver = "connected"
	}
	return ver, nil
}

// ---------- 物化（执行 DDL） ----------

type matStmt struct {
	Model string `json:"model"`
	SQL   string `json:"sql"`
}

func dbMaterialize(connID int64, statements []matStmt) []map[string]any {
	c, err := dbGetConnection(connID)
	if err != nil {
		return singleErr("连接不存在")
	}
	results := []map[string]any{}
	if c.Kind == "hive" {
		for _, s := range statements {
			out, err := beelineExec(c, s.SQL)
			ok := err == nil
			results = append(results, map[string]any{"model": s.Model, "ok": ok, "error": errStr(err, out)})
		}
		return results
	}
	h, err := openSQLConn(c)
	if err != nil {
		return singleErr(err.Error())
	}
	defer h.Close()
	for _, s := range statements {
		if _, err := h.Exec(s.SQL); err != nil {
			results = append(results, map[string]any{"model": s.Model, "ok": false, "error": err.Error()})
		} else {
			results = append(results, map[string]any{"model": s.Model, "ok": true})
		}
	}
	return results
}

func singleErr(msg string) []map[string]any {
	return []map[string]any{{"model": "", "ok": false, "error": msg}}
}

func errStr(err error, out string) string {
	if err != nil {
		return err.Error()
	}
	return ""
}

// beeline 透传（Hive）：执行 SQL，返回版本/错误信息
func beelineExec(c dbConn, query string) (string, error) {
	beeline, err := exec.LookPath("beeline")
	if err != nil {
		return "", fmt.Errorf("未找到 beeline 命令（Hive 物化需要本机安装 Hive 客户端）")
	}
	url := fmt.Sprintf("jdbc:hive2://%s:%d/%s", c.Host, c.Port, c.Database)
	args := []string{"-u", url}
	if c.User != "" {
		args = append(args, "-n", c.User)
	}
	if c.Password != "" {
		args = append(args, "-p", c.Password)
	}
	args = append(args, "--silent=true", "-e", query)
	cmd := exec.Command(beeline, args...)
	out, err := cmd.CombinedOutput()
	s := string(out)
	if err != nil {
		// 提取有意义的错误行
		for _, ln := range strings.Split(s, "\n") {
			if strings.Contains(ln, "Error") || strings.Contains(ln, "ERROR") {
				return s, fmt.Errorf("%s", strings.TrimSpace(ln))
			}
		}
		return s, err
	}
	return s, nil
}

// ---------- 反向拉取（introspect） ----------

func dbIntrospectTables(connID int64) ([]map[string]any, error) {
	c, err := dbGetConnection(connID)
	if err != nil {
		return nil, fmt.Errorf("连接不存在")
	}
	if c.Kind == "hive" {
		return hiveTables(c)
	}
	h, err := openSQLConn(c)
	if err != nil {
		return nil, err
	}
	defer h.Close()
	out := []map[string]any{}
	if c.Kind == "mysql" {
		rows, err := h.Query("SELECT TABLE_NAME, COALESCE(TABLE_COMMENT,'') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var n, cm string
			rows.Scan(&n, &cm)
			out = append(out, map[string]any{"name": n, "comment": cm})
		}
		return out, nil
	}
	// PostgreSQL：public 下的普通表
	rows, err := h.Query(`SELECT c.relname, COALESCE(obj_description(c.oid), '')
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var n, cm string
		rows.Scan(&n, &cm)
		out = append(out, map[string]any{"name": n, "comment": cm})
	}
	return out, nil
}

func hiveTables(c dbConn) ([]map[string]any, error) {
	out, err := beelineExec(c, "SHOW TABLES")
	if err != nil {
		return nil, err
	}
	res := []map[string]any{}
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.Contains(ln, "+") || strings.Contains(ln, "tab_name") || strings.Contains(ln, beelineMark) {
			continue
		}
		if regexp.MustCompile(`^[A-Za-z_][\w]*$`).MatchString(ln) {
			res = append(res, map[string]any{"name": ln, "comment": ""})
		}
	}
	return res, nil
}

const beelineMark = "beeline>"

// dbIntrospectDetail: 拉取指定表的结构（列/PK/FK/索引），结构对齐前端模型字段
func dbIntrospectDetail(connID int64, tables []string) ([]map[string]any, error) {
	c, err := dbGetConnection(connID)
	if err != nil {
		return nil, fmt.Errorf("连接不存在")
	}
	if c.Kind == "hive" {
		return hiveDetail(c, tables)
	}
	h, err := openSQLConn(c)
	if err != nil {
		return nil, err
	}
	defer h.Close()
	if c.Kind == "mysql" {
		return mysqlDetail(h, tables)
	}
	return pgDetail(h, tables)
}

func mysqlDetail(h *sql.DB, tables []string) ([]map[string]any, error) {
	out := []map[string]any{}
	for _, t := range tables {
		var comment string
		h.QueryRow("SELECT COALESCE(TABLE_COMMENT,'') FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", t).Scan(&comment)
		cols := []map[string]any{}
		rows, err := h.Query(`SELECT COLUMN_NAME, COLUMN_TYPE, COALESCE(COLUMN_COMMENT,''), IS_NULLABLE, COLUMN_DEFAULT, COALESCE(COLUMN_KEY,'')
			FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, t)
		if err != nil {
			return nil, err
		}
		pkCols := map[string]bool{}
		uniqCols := map[string]bool{}
		type idxRec struct {
			cols   []string
			unique bool
		}
		idxMap := map[string]*idxRec{}
		var colOrder []string
		colMeta := map[string]map[string]any{}
		for rows.Next() {
			var name, ctype, cmt, nullable, key string
			var def sql.NullString
			rows.Scan(&name, &ctype, &cmt, &nullable, &def, &key)
			col := map[string]any{"name": name, "type": ctype, "comment": cmt}
			if nullable == "NO" {
				col["nullable"] = false
			}
			if def.Valid {
				col["default"] = def.String
			}
			if key == "PRI" {
				col["pk"] = true
				pkCols[name] = true
			} else if key == "UNI" {
				uniqCols[name] = true
			}
			colOrder = append(colOrder, name)
			colMeta[name] = col
		}
		rows.Close()
		// 外键
		fkRows, err := h.Query(`SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
			FROM information_schema.KEY_COLUMN_USAGE
			WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL`, t)
		if err == nil {
			for fkRows.Next() {
				var col, rt, rc string
				fkRows.Scan(&col, &rt, &rc)
				if c, ok := colMeta[col]; ok {
					c["fk"] = rt + "." + rc
				}
			}
			fkRows.Close()
		}
		// 索引（跳过主键）
		ixRows, err := h.Query(`SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
			WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, t)
		if err == nil {
			for ixRows.Next() {
				var name, col string
				var nonUnique int
				ixRows.Scan(&name, &col, &nonUnique)
				if name == "PRIMARY" {
					continue
				}
				r := idxMap[name]
				if r == nil {
					r = &idxRec{unique: nonUnique == 0}
					idxMap[name] = r
				}
				r.cols = append(r.cols, col)
			}
			ixRows.Close()
		}
		_ = pkCols
		for _, n := range colOrder {
			if uniqCols[n] {
				colMeta[n]["unique"] = true
			}
			cols = append(cols, colMeta[n])
		}
		indexes := []map[string]any{}
		for name, r := range idxMap {
			indexes = append(indexes, map[string]any{"name": name, "fields": r.cols, "unique": r.unique})
		}
		out = append(out, map[string]any{"name": t, "comment": comment, "columns": cols, "indexes": indexes})
	}
	return out, nil
}

var pgTypeMap = map[string]string{
	"int2": "smallint", "int4": "int", "int8": "bigint", "varchar": "varchar",
	"bpchar": "char", "timestamptz": "timestamp", "timestamp": "timestamp",
	"numeric": "decimal", "bool": "boolean", "float4": "real", "float8": "double precision",
}

func pgDetail(h *sql.DB, tables []string) ([]map[string]any, error) {
	out := []map[string]any{}
	for _, t := range tables {
		var comment string
		h.QueryRow(`SELECT COALESCE(obj_description(c.oid), '') FROM pg_class c
			JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=?`, t).Scan(&comment)
		// 列
		rows, err := h.Query(`SELECT a.attname, t.typname, COALESCE(
				(SELECT col_description(a.attrelid, a.attnum)), ''),
				NOT a.attnotnull, COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '')
			FROM pg_attribute a
			JOIN pg_type t ON t.oid = a.atttypid
			LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
			WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
			ORDER BY a.attnum`, "public."+t)
		if err != nil {
			return nil, err
		}
		cols := []map[string]any{}
		for rows.Next() {
			var name, typ, cmt, def string
			var nullable bool
			rows.Scan(&name, &typ, &cmt, &nullable, &def)
			if mapped, ok := pgTypeMap[typ]; ok {
				typ = mapped
			}
			col := map[string]any{"name": name, "type": typ, "comment": cmt}
			if !nullable {
				col["nullable"] = false
			}
			if def != "" {
				col["default"] = stripPgCast(def)
			}
			cols = append(cols, col)
		}
		rows.Close()
		// 主键
		var pkStr string
		h.QueryRow(`SELECT COALESCE(string_agg(a.attname, ',' ORDER BY x.ordi), '')
			FROM (SELECT unnest(ix.indkey) AS attnum, generate_series(1, array_length(ix.indkey, 1)) AS ordi
				FROM pg_index ix WHERE ix.indrelid = $1::regclass AND ix.indisprimary) x
			JOIN pg_attribute a ON a.attrelid = $1::regclass AND a.attnum = x.attnum`, "public."+t).Scan(&pkStr)
		if pkStr != "" {
			for _, c := range cols {
				if strings.Contains(","+pkStr+",", ","+c["name"].(string)+",") {
					c["pk"] = true
				}
			}
		}
		// 外键
		fkRows, err := h.Query(`SELECT kcu.column_name, ccu.table_name, ccu.column_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
			JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
			WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`, t)
		if err == nil {
			for fkRows.Next() {
				var col, rt, rc string
				fkRows.Scan(&col, &rt, &rc)
				for _, c := range cols {
					if c["name"] == col {
						c["fk"] = rt + "." + rc
					}
				}
			}
			fkRows.Close()
		}
		// 唯一约束（单列 → unique；多列 → indexes）
		uqRows, err := h.Query(`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
			WHERE contype = 'u' AND conrelid = $1::regclass`, "public."+t)
		type pgIdx struct {
			cols   []string
			unique bool
		}
		idxList := []map[string]any{}
		if err == nil {
			for uqRows.Next() {
				var name, def string
				uqRows.Scan(&name, &def)
				cs := extractCols(def)
				if len(cs) == 1 {
					for _, c := range cols {
						if c["name"] == cs[0] {
							c["unique"] = true
						}
					}
				} else {
					idxList = append(idxList, map[string]any{"name": name, "fields": cs, "unique": true})
				}
			}
			uqRows.Close()
		}
		// 普通索引
		ixRows, err := h.Query(`SELECT indexname, indexdef FROM pg_indexes
			WHERE schemaname = 'public' AND tablename = $1`, t)
		if err == nil {
			for ixRows.Next() {
				var name, def string
				ixRows.Scan(&name, &def)
				if strings.Contains(def, "CREATE UNIQUE") || strings.Contains(def, "PRIMARY KEY") {
					continue
				}
				idxList = append(idxList, map[string]any{"name": name, "fields": extractCols(def), "unique": false})
			}
			ixRows.Close()
		}
		out = append(out, map[string]any{"name": t, "comment": comment, "columns": cols, "indexes": idxList})
	}
	return out, nil
}

// "((a), (b))" → [a, b]
func extractCols(def string) []string {
	m := regexp.MustCompile(`\(([^)]+)\)`).FindStringSubmatch(def)
	if m == nil {
		return nil
	}
	parts := strings.Split(m[1], ",")
	out := []string{}
	for _, p := range parts {
		p = strings.TrimSpace(strings.Trim(strings.TrimSpace(p), "\""))
		if p != "" && !strings.Contains(p, " ") {
			out = append(out, p)
		}
	}
	return out
}

func stripPgCast(def string) string {
	// '1'::integer → 1；nextval(...) 保留原样
	if i := strings.Index(def, "::"); i > 0 {
		if strings.HasPrefix(def, "'") && strings.HasSuffix(def[:i], "'") {
			return def[1 : i-1]
		}
	}
	return def
}

func hiveDetail(c dbConn, tables []string) ([]map[string]any, error) {
	out := []map[string]any{}
	for _, t := range tables {
		res, err := beelineExec(c, "DESCRIBE "+t)
		if err != nil {
			out = append(out, map[string]any{"name": t, "comment": "", "columns": []map[string]any{}, "error": err.Error()})
			continue
		}
		cols := []map[string]any{}
		for _, ln := range strings.Split(res, "\n") {
			fs := strings.Split(strings.TrimSpace(ln), "\t")
			if len(fs) < 2 {
				continue
			}
			name := strings.TrimSpace(fs[0])
			if name == "" || name == "col_name" || strings.HasPrefix(name, "#") {
				continue
			}
			col := map[string]any{"name": name, "type": strings.TrimSpace(fs[1])}
			if len(fs) >= 3 {
				col["comment"] = strings.TrimSpace(fs[2])
			}
			cols = append(cols, col)
		}
		out = append(out, map[string]any{"name": t, "comment": "", "columns": cols, "indexes": []map[string]any{}})
	}
	return out, nil
}
