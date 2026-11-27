package main

// 差异同步（模型 vs 真实库表结构对比 → ALTER 语句）与数据预览
// 挂在 dbconn.go 的连接体系上：MySQL / PostgreSQL 直连，Hive 走 beeline。

import (
	"fmt"
	"strings"
)

// ---------- 结构对比（DIFF） ----------

// dbDiffTable: 对比 connectionId 下指定表的真实结构与给定模型，生成差异与 ALTER 语句
// model 结构由前端传来（{name, fields:[{name,type,nullable,pk,default,unique}], indexes:[...]})
// 返回 {exists, changes:[{kind, sql, desc}], summary}
func dbDiffTable(connID int64, model map[string]any) (map[string]any, error) {
	c, err := dbGetConnection(connID)
	if err != nil {
		return nil, fmt.Errorf("连接不存在")
	}
	table, _ := model["name"].(string)
	if table == "" {
		return nil, fmt.Errorf("表名不能为空")
	}
	live, err := introspectOne(c, table)
	if err != nil {
		return nil, err
	}
	if live == nil {
		return map[string]any{"exists": false, "changes": []any{}, "summary": "库中不存在该表（可用「物化」创建）"}, nil
	}
	mfields, _ := model["fields"].([]any)
	changes := []any{}
	kind := c.Kind

	// 库内列索引
	liveCols := map[string]map[string]any{}
	var liveOrder []string
	if cols, ok := live["columns"].([]map[string]any); ok {
		for _, col := range cols {
			n, _ := col["name"].(string)
			liveCols[n] = col
			liveOrder = append(liveOrder, n)
		}
	}
	modelCols := map[string]bool{}
	for _, fv := range mfields {
		f, _ := fv.(map[string]any)
		n, _ := f["name"].(string)
		if n == "" {
			continue
		}
		modelCols[n] = true
		lc := liveCols[n]
		if lc == nil {
			// 模型有、库没有 → ADD COLUMN
			changes = append(changes, map[string]any{
				"kind": "add_column", "field": n,
				"desc": "新增字段 " + n,
				"sql":  alterAddColumn(kind, table, f),
			})
			continue
		}
		// 类型差异（忽略大小写与空白）
		mt := strings.ToLower(strings.TrimSpace(jsStr(f["type"])))
		lt := strings.ToLower(strings.TrimSpace(jsStr(lc["type"])))
		if mt != "" && lt != "" && mt != lt && !typeEquivalent(mt, lt) {
			changes = append(changes, map[string]any{
				"kind": "modify_column", "field": n,
				"desc": "类型变更 " + n + ": " + lt + " → " + mt,
				"sql":  alterModifyColumn(kind, table, f, lc),
			})
		}
		// NOT NULL 差异（库 nullable=true、模型 nullable=false → SET NOT NULL）
		mNotNull := f["nullable"] == false || jsTruthy(f["pk"])
		lNotNull := lc["nullable"] == false
		if mNotNull != lNotNull {
			changes = append(changes, map[string]any{
				"kind": "modify_column", "field": n,
				"desc": "可空性变更 " + n + ": " + nullableWord(lNotNull) + " → " + nullableWord(mNotNull),
				"sql":  alterModifyColumn(kind, table, f, lc),
			})
		}
		// 默认值差异
		md := jsStr(f["default"])
		ld := jsStr(lc["default"])
		if md != ld {
			changes = append(changes, map[string]any{
				"kind": "modify_column", "field": n,
				"desc": "默认值变更 " + n + ": " + orDash(ld) + " → " + orDash(md),
				"sql":  alterModifyColumn(kind, table, f, lc),
			})
		}
	}
	// 库有、模型没有 → DROP COLUMN（警示级，默认不勾选执行）
	for _, n := range liveOrder {
		if !modelCols[n] {
			changes = append(changes, map[string]any{
				"kind": "drop_column", "field": n, "risky": true,
				"desc": "库中多余字段 " + n + "（模型未定义，删除将丢失数据）",
				"sql":  alterDropColumn(kind, table, n),
			})
		}
	}
	return map[string]any{
		"exists":  true,
		"changes": changes,
		"summary": fmt.Sprintf("对比完成：%d 项差异", len(changes)),
	}, nil
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "（无）"
	}
	return s
}
func nullableWord(notNull bool) string {
	if notNull {
		return "NOT NULL"
	}
	return "NULL"
}

// 类型宽松等价：int == integer、varchar(64) 与 varchar(64) 去空白等
func typeEquivalent(a, b string) bool {
	norm := func(s string) string {
		s = strings.Join(strings.Fields(s), "")
		s = strings.ReplaceAll(s, "integer", "int")
		return strings.ToLower(s)
	}
	return norm(a) == norm(b)
}

// ---------- ALTER 语句生成（MySQL / PG / Hive） ----------

func colTypeDefault(f map[string]any) string {
	t := jsStr(f["type"])
	if t == "" {
		t = "varchar(255)"
	}
	return t
}

func alterAddColumn(kind, table string, f map[string]any) string {
	n, _ := f["name"].(string)
	t := colTypeDefault(f)
	notNull := f["nullable"] == false || jsTruthy(f["pk"])
	def := jsStr(f["default"])
	switch kind {
	case "mysql":
		s := "ALTER TABLE `" + table + "` ADD COLUMN `" + n + "` " + t
		if notNull {
			s += " NOT NULL"
		}
		if def != "" {
			s += " DEFAULT " + def
		}
		if cm := jsStr(f["comment"]); cm != "" {
			s += " COMMENT '" + cm + "'"
		}
		return s + ";"
	case "postgresql":
		s := "ALTER TABLE \"" + table + "\" ADD COLUMN \"" + n + "\" " + t
		if notNull {
			s += " NOT NULL"
		}
		if def != "" {
			s += " DEFAULT " + def
		}
		return s + ";"
	default: // hive
		cmt := jsStr(f["comment"])
		extra := ""
		if cmt != "" {
			extra = " COMMENT '" + cmt + "'"
		}
		return "ALTER TABLE " + table + " ADD COLUMNS (" + n + " " + t + extra + ");"
	}
}

func alterModifyColumn(kind, table string, f, lc map[string]any) string {
	n, _ := f["name"].(string)
	t := colTypeDefault(f)
	notNull := f["nullable"] == false || jsTruthy(f["pk"])
	def := jsStr(f["default"])
	switch kind {
	case "mysql":
		s := "ALTER TABLE `" + table + "` MODIFY COLUMN `" + n + "` " + t
		if notNull {
			s += " NOT NULL"
		}
		if def != "" {
			s += " DEFAULT " + def
		}
		if cm := jsStr(f["comment"]); cm != "" {
			s += " COMMENT '" + cm + "'"
		}
		return s + ";"
	case "postgresql":
		// PG 分项：TYPE / SET NOT NULL / DROP NOT NULL / SET DEFAULT —— 合成多条
		var parts []string
		lt := strings.ToLower(jsStr(lc["type"]))
		if !typeEquivalent(t, lt) {
			parts = append(parts, "ALTER TABLE \""+table+"\" ALTER COLUMN \""+n+"\" TYPE "+t+";")
		}
		lNotNull := lc["nullable"] == false
		if notNull && !lNotNull {
			parts = append(parts, "ALTER TABLE \""+table+"\" ALTER COLUMN \""+n+"\" SET NOT NULL;")
		} else if !notNull && lNotNull {
			parts = append(parts, "ALTER TABLE \""+table+"\" ALTER COLUMN \""+n+"\" DROP NOT NULL;")
		}
		ld := jsStr(lc["default"])
		if def != ld {
			if def != "" {
				parts = append(parts, "ALTER TABLE \""+table+"\" ALTER COLUMN \""+n+"\" SET DEFAULT "+def+";")
			} else {
				parts = append(parts, "ALTER TABLE \""+table+"\" ALTER COLUMN \""+n+"\" DROP DEFAULT;")
			}
		}
		return strings.Join(parts, "\n")
	default: // hive：仅支持类型替换（含所有列定义）
		return "ALTER TABLE " + table + " CHANGE COLUMN " + n + " " + n + " " + t + ";"
	}
}

func alterDropColumn(kind, table, col string) string {
	switch kind {
	case "mysql":
		return "ALTER TABLE `" + table + "` DROP COLUMN `" + col + "`;"
	case "postgresql":
		return "ALTER TABLE \"" + table + "\" DROP COLUMN \"" + col + "\" CASCADE;"
	default:
		return "ALTER TABLE " + table + " DROP COLUMN " + col + ";"
	}
}

// introspectOne: 复用 dbIntrospectDetail 的单表拉取
func introspectOne(c dbConn, table string) (map[string]any, error) {
	var tables []map[string]any
	var err error
	switch c.Kind {
	case "mysql":
		h, e := openSQLConn(c)
		if e != nil {
			return nil, e
		}
		defer h.Close()
		tables, err = mysqlDetail(h, []string{table})
	case "postgresql":
		h, e := openSQLConn(c)
		if e != nil {
			return nil, e
		}
		defer h.Close()
		tables, err = pgDetail(h, []string{table})
	case "hive":
		tables, err = hiveDetail(c, []string{table})
	default:
		return nil, fmt.Errorf("不支持的连接类型")
	}
	if err != nil {
		return nil, err
	}
	if len(tables) == 0 {
		return nil, nil
	}
	return tables[0], nil
}

// ---------- 数据预览 ----------

// dbPreviewRows: SELECT * FROM table LIMIT n（列名 + 行数据）
func dbPreviewRows(connID int64, table string, limit int) (map[string]any, error) {
	c, err := dbGetConnection(connID)
	if err != nil {
		return nil, fmt.Errorf("连接不存在")
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if c.Kind == "hive" {
		return hivePreview(c, table, limit)
	}
	h, err := openSQLConn(c)
	if err != nil {
		return nil, err
	}
	defer h.Close()
	q := "SELECT * FROM " + quoteIdent(c.Kind, table) + " LIMIT " + fmt.Sprint(limit)
	rows, err := h.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	data := [][]string{} // [][]any 换成 string，避免数字精度/时间格式化问题
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			if v == nil {
				row[i] = "NULL"
			} else if b, ok := v.([]byte); ok {
				row[i] = string(b)
			} else {
				row[i] = fmt.Sprintf("%v", v)
			}
		}
		data = append(data, row)
	}
	return map[string]any{"columns": cols, "rows": data, "count": len(data)}, nil
}

func quoteIdent(kind, name string) string {
	switch kind {
	case "mysql":
		return "`" + name + "`"
	case "postgresql":
		return `"` + name + `"`
	}
	return name
}

func hivePreview(c dbConn, table string, limit int) (map[string]any, error) {
	out, err := beelineExec(c, "SELECT * FROM "+table+" LIMIT "+fmt.Sprint(limit))
	if err != nil {
		return nil, err
	}
	// beeline 表格输出解析：跳过头尾分隔行
	var lines []string
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "+") || strings.Contains(ln, beelineMark) {
			continue
		}
		lines = append(lines, ln)
	}
	if len(lines) == 0 {
		return map[string]any{"columns": []string{}, "rows": [][]string{}, "count": 0}, nil
	}
	// 第一行是列头（| col1 | col2 |）
	header := splitBeelineRow(lines[0])
	data := [][]string{}
	for _, ln := range lines[1:] {
		data = append(data, splitBeelineRow(ln))
	}
	return map[string]any{"columns": header, "rows": data, "count": len(data)}, nil
}

func splitBeelineRow(ln string) []string {
	ln = strings.TrimPrefix(ln, "|")
	ln = strings.TrimSuffix(ln, "|")
	parts := strings.Split(ln, "|")
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = strings.TrimSpace(p)
	}
	return out
}
