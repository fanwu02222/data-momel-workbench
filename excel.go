package main

// Excel 导入：解析 ZIP（Go 标准库）→ xlsx 工作表 → 合并/替换入库
// 解析语义与 server.js 逐条对齐（共享字符串、sheet 顺序、配置/总览/源表映射、自定义列）

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	rowRe      = regexp.MustCompile(`(?s)<row[^>]*\br="(\d+)"[^>]*>(.*?)</row>`)
	cellRe     = regexp.MustCompile(`(?s)<c\b([^>]*?)(?:/>|>(.*?)</c>)`)
	vRe        = regexp.MustCompile(`(?s)<v(?:\s[^>]*)?>(.*?)</v>`)
	siRe       = regexp.MustCompile(`(?s)<si(?:\s[^>]*)?>(.*?)</si>`)
	relRe      = regexp.MustCompile(`<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*>`)
	sheetRe    = regexp.MustCompile(`<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*>`)
	refRe      = regexp.MustCompile(`\br="([A-Z]+)\d+"`)
	cellTypeRe = regexp.MustCompile(`\bt="(\w+)"`)
	numEntRe   = regexp.MustCompile(`&#(\d+);`)
	stripTags  = regexp.MustCompile(`<[^>]*>`)
)

func xmlUnescape(s string) string {
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&apos;", "'")
	s = numEntRe.ReplaceAllStringFunc(s, func(m string) string {
		d, err := strconv.Atoi(m[2 : len(m)-1])
		if err != nil {
			return m
		}
		return string(rune(d))
	})
	s = strings.ReplaceAll(s, "&amp;", "&")
	return s
}

// 取某标签全部内文（拼接），去内嵌标签，反转义 —— 对应 JS xmlTexts
func xmlTexts(xmlText, tag string) string {
	re := regexp.MustCompile(`(?s)<` + tag + `(?:\s[^>]*)?>(.*?)</` + tag + `>`)
	out := ""
	for _, m := range re.FindAllStringSubmatch(xmlText, -1) {
		out += m[1]
	}
	return xmlUnescape(stripTags.ReplaceAllString(out, ""))
}

// 解析 worksheet → 行×列 的二维文本数组（稀疏位补空串）
func parseSheet(xmlText string, shared []string) [][]string {
	var rows [][]string
	for _, rm := range rowRe.FindAllStringSubmatch(xmlText, -1) {
		rowIdx, _ := strconv.Atoi(rm[1])
		var cells []string
		for _, cm := range cellRe.FindAllStringSubmatch(rm[2], -1) {
			attrs, inner := cm[1], cm[2]
			ref := refRe.FindStringSubmatch(attrs)
			if ref == nil {
				continue
			}
			col := 0
			for _, ch := range ref[1] {
				col = col*26 + int(ch-64)
			}
			typ := ""
			if tm := cellTypeRe.FindStringSubmatch(attrs); tm != nil {
				typ = tm[1]
			}
			text := ""
			switch typ {
			case "inlineStr":
				text = xmlTexts(inner, "t")
			case "s":
				if v := vRe.FindStringSubmatch(inner); v != nil {
					idx, err := strconv.Atoi(strings.TrimSpace(v[1]))
					if err == nil && idx >= 0 && idx < len(shared) {
						text = shared[idx]
					}
				}
			default:
				if v := vRe.FindStringSubmatch(inner); v != nil {
					if typ == "b" {
						if v[1] == "1" {
							text = "是"
						}
					} else {
						text = xmlUnescape(v[1])
					}
				}
			}
			for len(cells) < col {
				cells = append(cells, "")
			}
			cells[col-1] = text
		}
		for len(rows) < rowIdx {
			rows = append(rows, []string{})
		}
		rows[rowIdx-1] = cells
	}
	for i := range rows {
		if rows[i] == nil {
			rows[i] = []string{}
		}
	}
	return rows
}

func cellAt(rows [][]string, r, c int) string {
	if r < 0 || r >= len(rows) {
		return ""
	}
	row := rows[r]
	if c < 0 || c >= len(row) {
		return ""
	}
	return row[c]
}

func headerOf(g [][]string) []string {
	if len(g) == 0 {
		return []string{}
	}
	out := make([]string, len(g[0]))
	for i, x := range g[0] {
		out[i] = strings.TrimSpace(x)
	}
	return out
}

func findCol(head []string, names []string) int {
	for i, h := range head {
		for _, n := range names {
			if h == n {
				return i
			}
		}
	}
	return -1
}

func importExcel(buf []byte, mode string, projectID int64) (map[string]any, error) {
	if len(buf) < 4 || buf[0] != 0x50 || buf[1] != 0x4b {
		return nil, errors.New("不是有效的 .xlsx 文件")
	}
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		return nil, errors.New("不是有效的 ZIP 文件（未找到 EOCD）")
	}
	z := map[string][]byte{}
	for _, f := range zr.File {
		rc, e := f.Open()
		if e != nil {
			continue
		}
		b, e := io.ReadAll(rc)
		rc.Close()
		if e == nil {
			z[f.Name] = b
		}
	}

	// 共享字符串
	shared := []string{}
	if sb, ok := z["xl/sharedStrings.xml"]; ok {
		xml := string(sb)
		for _, m := range siRe.FindAllStringSubmatch(xml, -1) {
			shared = append(shared, xmlTexts(m[1], "t"))
		}
	}

	// sheet 顺序：workbook.xml + rels
	wbXml, ok := z["xl/workbook.xml"]
	if !ok {
		return nil, errors.New("xlsx 中未找到工作表")
	}
	relMap := map[string]string{}
	if relsXml, ok := z["xl/_rels/workbook.xml.rels"]; ok {
		for _, m := range relRe.FindAllStringSubmatch(string(relsXml), -1) {
			relMap[m[1]] = m[2]
		}
	}
	type sheetEntry struct {
		name string
		grid [][]string
	}
	var sheetOrder []sheetEntry
	for _, m := range sheetRe.FindAllStringSubmatch(string(wbXml), -1) {
		target := relMap[m[2]]
		target = strings.TrimPrefix(target, "/")
		target = strings.TrimPrefix(target, "xl/")
		file := "xl/" + target
		if sb, ok := z[file]; ok {
			sheetOrder = append(sheetOrder, sheetEntry{name: xmlUnescape(m[1]), grid: parseSheet(string(sb), shared)})
		}
	}
	if len(sheetOrder) == 0 {
		return nil, errors.New("xlsx 中未找到工作表")
	}

	byName := map[string][][]string{}
	for _, s := range sheetOrder {
		byName[s.name] = s.grid
	}
	grid := func(name string) [][]string { return byName[name] }

	// ---------- 配置 ----------
	importedName, importedDialect := "", ""
	var importedCC map[string]any
	cfg := grid("配置")
	if len(cfg) > 1 {
		for i := 1; i < len(cfg); i++ {
			k := strings.TrimSpace(cellAt(cfg, i, 0))
			v := cellAt(cfg, i, 1)
			if k == "项目名" {
				importedName = v
			} else if k == "方言" {
				importedDialect = v
			} else if k == "表级自定义列" || k == "字段级自定义列" {
				var list []any
				if err := json.Unmarshal([]byte(v), &list); err == nil {
					if importedCC == nil {
						importedCC = map[string]any{"model": []any{}, "field": []any{}}
					}
					if k == "表级自定义列" {
						importedCC["model"] = list
					} else {
						importedCC["field"] = list
					}
				}
			}
		}
	}

	// ---------- 总览 → 模型基础信息 ----------
	ov := grid("总览")
	ovHead := headerOf(ov)
	cLayer := findCol(ovHead, []string{"分层"})
	cName := findCol(ovHead, []string{"表名"})
	cCn := findCol(ovHead, []string{"中文名"})
	cDesc := findCol(ovHead, []string{"描述"})
	cSource := findCol(ovHead, []string{"源系统"})
	cNotes := findCol(ovHead, []string{"逻辑说明"})
	cWhere := findCol(ovHead, []string{"WHERE"})
	cGroupBy := findCol(ovHead, []string{"GROUP BY"})
	if cName < 0 {
		return nil, errors.New("总览缺少「表名」列，无法识别模型")
	}
	var modelCols []any
	if importedCC != nil {
		if mc, ok := importedCC["model"].([]any); ok {
			modelCols = mc
		}
	}
	var models []map[string]any
	byModelName := map[string]map[string]any{}
	for i := 1; i < len(ov); i++ {
		if strings.TrimSpace(cellAt(ov, i, cName)) == "" {
			continue
		}
		m := map[string]any{"layer": "ods", "name": strings.TrimSpace(cellAt(ov, i, cName)), "cnName": "", "desc": "", "source": "", "notes": "", "where": "", "groupBy": "", "fields": []any{}, "partition": []any{}, "sources": []any{}}
		if cLayer >= 0 {
			if s := strings.TrimSpace(cellAt(ov, i, cLayer)); s != "" {
				m["layer"] = strings.ToLower(s)
			}
		}
		if cCn >= 0 {
			m["cnName"] = cellAt(ov, i, cCn)
		}
		if cDesc >= 0 {
			m["desc"] = cellAt(ov, i, cDesc)
		}
		if cSource >= 0 {
			m["source"] = cellAt(ov, i, cSource)
		}
		if cNotes >= 0 {
			m["notes"] = cellAt(ov, i, cNotes)
		}
		if cWhere >= 0 {
			m["where"] = cellAt(ov, i, cWhere)
		}
		if cGroupBy >= 0 {
			m["groupBy"] = cellAt(ov, i, cGroupBy)
		}
		for _, c := range modelCols {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			key, _ := cm["key"].(string)
			label, _ := cm["label"].(string)
			m[key] = cellAt(ov, i, indexOfStr(ovHead, label))
		}
		models = append(models, m)
		byModelName[m["name"].(string)] = m
	}

	// ---------- 模型 sheet → 字段/分区 ----------
	var fieldCols []any
	if importedCC != nil {
		if fc, ok := importedCC["field"].([]any); ok {
			fieldCols = fc
		}
	}
	for _, s := range sheetOrder {
		if s.name == "配置" || s.name == "总览" || s.name == "源表映射" || s.name == "血缘清单" {
			continue
		}
		m, exists := byModelName[s.name]
		if !exists {
			// Excel 里出现总览没有的新 sheet → 作为新模型导入（按 sheet 名当表名）
			models = append(models, map[string]any{"layer": "ods", "name": s.name, "cnName": "", "desc": "", "source": "", "notes": "", "where": "", "groupBy": "", "fields": []any{}, "partition": []any{}, "sources": []any{}})
			continue
		}
		head := headerOf(s.grid)
		cFName := findCol(head, []string{"字段名"})
		cFType := findCol(head, []string{"类型"})
		cFComment := findCol(head, []string{"注释"})
		cFPk := findCol(head, []string{"主键"})
		cFExpr := indexOfPrefix(head, "业务逻辑")
		cFPart := findCol(head, []string{"分区"})
		fields := []any{}
		partition := []any{}
		for i := 1; i < len(s.grid); i++ {
			name := strings.TrimSpace(cellAt(s.grid, i, cFName))
			if name == "" {
				continue
			}
			ftype := "string"
			if cFType >= 0 {
				if v := cellAt(s.grid, i, cFType); v != "" {
					ftype = v
				}
			}
			fcomment := ""
			if cFComment >= 0 {
				fcomment = cellAt(s.grid, i, cFComment)
			}
			pk := cFPk >= 0 && strings.TrimSpace(cellAt(s.grid, i, cFPk)) == "是"
			fexpr := ""
			if cFExpr >= 0 {
				fexpr = cellAt(s.grid, i, cFExpr)
			}
			f := map[string]any{"name": name, "type": ftype, "comment": fcomment, "pk": pk, "expr": fexpr}
			for _, c := range fieldCols {
				cm, ok := c.(map[string]any)
				if !ok {
					continue
				}
				key, _ := cm["key"].(string)
				label, _ := cm["label"].(string)
				f[key] = cellAt(s.grid, i, indexOfStr(head, label))
			}
			if cFPart >= 0 && strings.TrimSpace(cellAt(s.grid, i, cFPart)) == "分区" {
				partition = append(partition, f)
			} else {
				fields = append(fields, f)
			}
		}
		m["fields"] = fields
		m["partition"] = partition
	}

	// ---------- 源表映射 → sources ----------
	src := grid("源表映射")
	if len(src) > 1 {
		head := headerOf(src)
		cT := findCol(head, []string{"目标表"})
		cS := findCol(head, []string{"源表"})
		cA := findCol(head, []string{"别名"})
		cOn := findCol(head, []string{"JOIN 条件", "JOIN条件"})
		if cT >= 0 && cS >= 0 {
			for i := 1; i < len(src); i++ {
				target := strings.TrimSpace(cellAt(src, i, cT))
				sname := strings.TrimSpace(cellAt(src, i, cS))
				if target == "" || sname == "" {
					continue
				}
				m, ok := byModelName[target]
				if !ok {
					continue
				}
				on := ""
				alias := ""
				if cOn >= 0 {
					on = cellAt(src, i, cOn)
				}
				if cA >= 0 {
					alias = cellAt(src, i, cA)
				}
				if arr, ok := m["sources"].([]any); ok {
					m["sources"] = append(arr, map[string]any{"name": sname, "alias": alias, "on": on})
				}
			}
		}
	}

	// ---------- 合并 / 替换 ----------
	current, hasCurrent := dbGetProjectID(projectID)
	added := []string{}
	updated := []string{}
	var result map[string]any

	if mode == "replace" {
		result = map[string]any{"models": modelsToAny(models)}
		result["name"] = orFallback(importedName, current, hasCurrent, "name", "未命名项目")
		result["dialect"] = orFallback(importedDialect, current, hasCurrent, "dialect", "hive")
		if importedCC != nil {
			result["customCols"] = importedCC
		} else if hasCurrent {
			if cc, ok := current["customCols"]; ok && cc != nil {
				result["customCols"] = cc
			}
		}
		for _, m := range models {
			added = append(added, m["name"].(string))
		}
	} else { // merge：文件里的模型按表名覆盖/追加，其余保持
		result = map[string]any{}
		if hasCurrent {
			for k, v := range current {
				result[k] = v
			}
		} else {
			result["name"] = "未命名项目"
			result["dialect"] = "hive"
			result["models"] = []any{}
		}
		if importedCC != nil {
			result["customCols"] = importedCC
		}
		base, _ := result["models"].([]any)
		for _, m := range models {
			name := m["name"].(string)
			found := -1
			for j, bv := range base {
				if bm, ok := bv.(map[string]any); ok && bm["name"] == m["name"] {
					found = j
					break
				}
			}
			if found >= 0 {
				merged := map[string]any{}
				if bm, ok := base[found].(map[string]any); ok {
					for k, v := range bm {
						merged[k] = v
					}
				}
				for k, v := range m {
					merged[k] = v
				}
				merged["id"] = baseID(base[found])
				base[found] = merged
				updated = append(updated, name)
			} else {
				m["id"] = "m_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "_" + randSeq(5)
				base = append(base, m)
				added = append(added, name)
			}
		}
		result["models"] = base
	}
	if err := dbPutProjectID(projectID, result); err != nil {
		return nil, err
	}
	saved, _ := dbGetProjectID(projectID)
	total := 0
	if arr, ok := saved["models"].([]any); ok {
		total = len(arr)
	}
	return map[string]any{"project": saved, "added": added, "updated": updated, "total": total}, nil
}

func indexOfPrefix(head []string, prefix string) int {
	for i, h := range head {
		if strings.HasPrefix(h, prefix) {
			return i
		}
	}
	return -1
}

func baseID(v any) any {
	if bm, ok := v.(map[string]any); ok {
		return bm["id"]
	}
	return nil
}

func modelsToAny(models []map[string]any) []any {
	arr := make([]any, len(models))
	for i, m := range models {
		arr[i] = m
	}
	return arr
}

// orFallback: imported 值为空时回退 current 的对应键，再回退 default
func orFallback(imported string, current map[string]any, hasCurrent bool, key, def string) string {
	if imported != "" {
		return imported
	}
	if hasCurrent {
		if v, ok := current[key]; ok && jsTruthy(v) {
			return jsStr(v)
		}
	}
	return def
}
