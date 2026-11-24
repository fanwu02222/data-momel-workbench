// 数据建模工作台 · Go 后端（与 server.js 行为对齐）
// 构建：go build -o dw-workbench-go .
// 运行：./dw-workbench-go        默认 http://127.0.0.1:8130
//
//	PORT / HOST / DW_DATA_DIR 环境变量覆盖（与 Node 版一致）
//	./dw-workbench-go -dev   前端从磁盘读取（改 js/css 后刷新即生效，联调用）
//
// 默认（无 -dev）：前端经 go:embed 打进二进制，交付为单文件。
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

//go:embed index.html css js
var staticFS embed.FS

var (
	dataDir       string // SQLite / project.json 快照目录（DW_DATA_DIR 可覆盖）
	appRoot       string // 静态资源根：-dev 时为 cwd，否则为可执行文件目录
	serveFromDisk bool
)

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func sendJSON(w http.ResponseWriter, code int, obj any) {
	b, _ := json.Marshal(obj)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	w.Write(b)
}

func sendText(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	w.Write([]byte(msg))
}

// 与 Node 版 readBody 一致：默认 20MB 上限，超限报 'body too large'
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 20*1024*1024)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if _, ok := err.(*http.MaxBytesError); ok || strings.Contains(err.Error(), "request body too large") {
			_ = maxErr
			return nil, errBodyTooLarge
		}
		return nil, err
	}
	return b, nil
}

var errBodyTooLarge = fmt.Errorf("body too large")

// sendAPIError: 业务错误统一回 {"error":"中文消息"}；apiError 携带状态码（400/404），其余按 400
func sendAPIError(w http.ResponseWriter, err error) {
	if ae, ok := err.(*apiError); ok {
		sendJSON(w, ae.Code, map[string]any{"error": ae.Msg})
		return
	}
	sendJSON(w, 400, map[string]any{"error": err.Error()})
}

// projectIDFromQuery: 解析 ?projectId=N（缺省/空 → 1，兼容旧行为；非法 → 报错）
func projectIDFromQuery(r *http.Request) (int64, error) {
	v := r.URL.Query().Get("projectId")
	if v == "" {
		return 1, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("projectId 无效")
	}
	return n, nil
}

func projectIDFromAny(v any, fallback int64) int64 {
	switch t := v.(type) {
	case nil:
		return fallback
	case float64:
		if t > 0 {
			return int64(t)
		}
	case string:
		if n, err := strconv.ParseInt(t, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return -1
}

func intFromAny(v any, fallback int) int {
	switch t := v.(type) {
	case nil:
		return fallback
	case float64:
		return int(t)
	case string:
		if n, err := strconv.Atoi(t); err == nil {
			return n
		}
	}
	return fallback
}

func handler(w http.ResponseWriter, r *http.Request) {
	// Node 版对 pathname 做了第二次 decodeURIComponent，这里保持一致
	p := r.URL.Path
	if q, err := url.PathUnescape(p); err == nil {
		p = q
	}

	if p == "/api/health" {
		sendJSON(w, 200, map[string]any{"ok": true, "service": "dw-workbench", "storage": "sqlite", "time": isoNow()})
		return
	}

	// projectId 查询参数（GET/PUT /api/project、Excel 导入共用）；缺省 1 保持旧行为
	projectID, err := projectIDFromQuery(r)
	if err != nil {
		sendJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}

	if p == "/api/project" {
		switch r.Method {
		case "GET":
			migrateIfNeeded()
			data, ok := dbGetProjectID(projectID)
			if !ok {
				sendJSON(w, 404, map[string]any{"error": "项目尚未初始化"})
				return
			}
			sendJSON(w, 200, data)
		case "PUT":
			body, err := readBody(w, r)
			if err != nil {
				if err == errBodyTooLarge {
					sendJSON(w, 400, map[string]any{"error": "body too large"})
				} else {
					sendJSON(w, 400, map[string]any{"error": err.Error()})
				}
				return
			}
			var data map[string]any
			if err := json.Unmarshal(body, &data); err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			if err := dbPutProjectID(projectID, data); err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true, "storage": dbFile()})
		default:
			sendJSON(w, 405, map[string]any{"error": "method not allowed"})
		}
		return
	}

	if p == "/api/import/excel" && r.Method == "POST" {
		body, err := readBody(w, r)
		if err != nil {
			if err == errBodyTooLarge {
				sendJSON(w, 400, map[string]any{"error": "body too large"})
			} else {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
			}
			return
		}
		mode := "merge"
		if r.URL.Query().Get("mode") == "replace" {
			mode = "replace"
		}
		result, err := importExcel(body, mode, projectID)
		if err != nil {
			sendJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(w, 200, result)
		return
	}

	// ================= 多项目管理 =================
	if p == "/api/projects" {
		switch r.Method {
		case "GET":
			sendJSON(w, 200, map[string]any{"projects": dbListProjects()})
		case "POST":
			body, err := readBody(w, r)
			if err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			var req struct {
				Name    string `json:"name"`
				Dialect string `json:"dialect"`
			}
			if err := json.Unmarshal(body, &req); err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			name := strings.TrimSpace(req.Name)
			if name == "" {
				name = "未命名项目"
			}
			dialect := strings.TrimSpace(req.Dialect)
			if dialect == "" {
				dialect = "hive"
			}
			proj, err := dbCreateProject(name, dialect)
			if err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true, "project": proj.toMap()})
		default:
			sendJSON(w, 405, map[string]any{"error": "method not allowed"})
		}
		return
	}
	if strings.HasPrefix(p, "/api/projects/") {
		idStr := strings.TrimPrefix(p, "/api/projects/")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil || id <= 0 {
			sendJSON(w, 400, map[string]any{"error": "无效的项目 id"})
			return
		}
		switch r.Method {
		case "PUT":
			body, err := readBody(w, r)
			if err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			var fields map[string]any
			if err := json.Unmarshal(body, &fields); err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			proj, err := dbUpdateProject(id, fields)
			if err != nil {
				sendAPIError(w, err)
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true, "project": proj.toMap()})
		case "DELETE":
			if err := dbDeleteProject(id); err != nil {
				sendAPIError(w, err)
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true})
		default:
			sendJSON(w, 405, map[string]any{"error": "method not allowed"})
		}
		return
	}

	// ================= L1-L5 业务目录树 =================
	if p == "/api/catalog" {
		switch r.Method {
		case "GET":
			sendJSON(w, 200, map[string]any{"nodes": dbGetCatalogTree(projectID)})
		case "POST":
			body, err := readBody(w, r)
			if err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			var req struct {
				ProjectID any    `json:"projectId"`
				ParentID  string `json:"parentId"`
				Level     any    `json:"level"`
				Name      string `json:"name"`
				CnName    string `json:"cnName"`
			}
			if err := json.Unmarshal(body, &req); err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			catProjectID := projectIDFromAny(req.ProjectID, projectID)
			if catProjectID <= 0 {
				sendJSON(w, 400, map[string]any{"error": "projectId 无效"})
				return
			}
			level := intFromAny(req.Level, 0)
			node, err := dbCreateCatalogNode(catProjectID, req.ParentID, level, req.Name, req.CnName)
			if err != nil {
				sendAPIError(w, err)
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true, "node": node})
		default:
			sendJSON(w, 405, map[string]any{"error": "method not allowed"})
		}
		return
	}
	if strings.HasPrefix(p, "/api/catalog/") {
		id := strings.TrimPrefix(p, "/api/catalog/")
		if id == "" {
			sendJSON(w, 400, map[string]any{"error": "无效的节点 id"})
			return
		}
		// 节点 id 全局唯一 → 从节点解析所属项目（PUT/DELETE 不需要 projectId）
		projID, ok := dbCatalogNodeProject(id)
		if !ok {
			sendJSON(w, 404, map[string]any{"error": "节点不存在"})
			return
		}
		switch r.Method {
		case "PUT":
			body, err := readBody(w, r)
			if err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			var fields map[string]any
			if err := json.Unmarshal(body, &fields); err != nil {
				sendJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			node, err := dbUpdateCatalogNode(projID, id, fields)
			if err != nil {
				sendAPIError(w, err)
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true, "node": node})
		case "DELETE":
			n, err := dbDeleteCatalogNode(projID, id)
			if err != nil {
				sendAPIError(w, err)
				return
			}
			sendJSON(w, 200, map[string]any{"ok": true, "deleted": n})
		default:
			sendJSON(w, 405, map[string]any{"error": "method not allowed"})
		}
		return
	}

	if p == "/api/dsh" && r.Method == "POST" {
		body, err := readBody(w, r)
		if err != nil {
			sendJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		var req struct {
			Prompt string `json:"prompt"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			sendJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		prompt := strings.TrimSpace(req.Prompt)
		if prompt == "" {
			sendJSON(w, 400, map[string]any{"error": "prompt 不能为空"})
			return
		}
		job := startDshJob(prompt)
		sendJSON(w, 200, map[string]any{"ok": true, "jobId": job.ID, "note": "DSH 已在后台启动，请轮询 /api/dsh/status"})
		return
	}

	if p == "/api/dsh/status" {
		job := getDshJob(r.URL.Query().Get("id"))
		if job == nil {
			sendJSON(w, 404, map[string]any{"error": "任务不存在"})
			return
		}
		sendJSON(w, 200, map[string]any{
			"ok": true, "id": job.ID, "status": job.Status, "output": job.Output,
			"projectChanged": job.projectChanged, "startedAt": job.StartedAt, "endedAt": job.EndedAt,
		})
		return
	}

	serveStatic(w, p)
}

func serveStatic(w http.ResponseWriter, pathname string) {
	rel := "index.html"
	if pathname != "/" {
		rel = strings.TrimPrefix(pathname, "/")
	}
	var content []byte
	var err error
	var ext string
	if serveFromDisk {
		file := filepath.Clean(filepath.Join(appRoot, rel))
		if !strings.HasPrefix(file, appRoot) {
			sendText(w, 403, "forbidden")
			return
		}
		content, err = os.ReadFile(file)
		ext = filepath.Ext(file)
	} else {
		content, err = staticFS.ReadFile(rel)
		ext = filepath.Ext(rel)
	}
	if err != nil {
		sendText(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", mimeOf(ext))
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Write(content)
}

var mimeMap = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "application/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".md":   "text/markdown; charset=utf-8",
}

func mimeOf(ext string) string {
	if m, ok := mimeMap[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

func main() {
	dev := flag.Bool("dev", false, "前端从磁盘读取（默认读取内嵌资源）")
	flag.Parse()
	serveFromDisk = *dev

	if serveFromDisk {
		appRoot, _ = os.Getwd()
	} else {
		exe, err := os.Executable()
		if err != nil {
			exe = "."
		}
		appRoot = filepath.Dir(exe)
	}

	dataDir = os.Getenv("DW_DATA_DIR")
	if dataDir == "" {
		dataDir = appRoot
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		fatalErr("数据目录创建失败", err)
	}
	if err := openStore(); err != nil {
		fatalErr("数据库打开失败", err)
	}
	migrateIfNeeded()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8130"
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	displayHost := host
	if displayHost == "0.0.0.0" {
		displayHost = "127.0.0.1"
	}

	// 端口先行监听：被占用时自动 +1 重试（最多 20 个），本地工具友好行为（Jupyter 式）
	basePort, _ := strconv.Atoi(port)
	ln, err := net.Listen("tcp", host+":"+port)
	tried := 0
	for err != nil && tried < 20 {
		tried++
		fmt.Println("[dw-workbench] 端口 " + port + " 已被占用，尝试 " + strconv.Itoa(basePort+tried) + " …")
		port = strconv.Itoa(basePort + tried)
		ln, err = net.Listen("tcp", host+":"+port)
	}
	if err != nil {
		fatalErr("监听端口失败（连续 20 个端口均不可用） "+host+":"+strconv.Itoa(basePort), err)
	}

	fmt.Println("[dw-workbench] 数据建模工作台已启动： http://" + displayHost + ":" + port)
	if tried > 0 {
		fmt.Println("[dw-workbench] 提示：默认端口被占用，本次使用 " + port + "（浏览器已打开正确地址）")
	}
	fmt.Println("[dw-workbench] 数据库： " + filepath.Join(dataDir, "workbench.db") + "（SQLite/WAL）")
	fmt.Println("[dw-workbench] 快照： " + filepath.Join(dataDir, "project.json") + "（每次保存自动导出，供 DSH/文件工作流使用）")
	if serveFromDisk {
		fmt.Println("[dw-workbench] 开发模式： 前端从磁盘加载（" + appRoot + "）")
	}

	go func() {
		if err := http.Serve(ln, http.HandlerFunc(handler)); err != nil {
			fatalErr("服务异常退出", err)
		}
	}()

	// 桌面软件体验：启动成功后自动打开默认浏览器
	url := "http://" + displayHost + ":" + port + "/"
	openBrowser(url)

	select {} // 阻塞主协程（Windows 下保持控制台窗口 = 服务运行指示）
}

// fatalErr：打印错误；Windows 双击运行时等用户按键再退出，避免窗口闪退看不到信息
func fatalErr(msg string, err error) {
	fmt.Println("[dw-workbench] " + msg + ": " + err.Error())
	fmt.Println("[dw-workbench] 运行中止。")
	if runtime.GOOS == "windows" {
		fmt.Print("按回车键关闭窗口…")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
	os.Exit(1)
}

// openBrowser：调用系统默认浏览器打开地址（失败仅忽略，不影响服务）
func openBrowser(u string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// start 的第一个 "" 是窗口标题占位，防止 URL 被当作标题
		c = exec.Command("cmd", "/c", "start", "", u)
	case "darwin":
		c = exec.Command("open", u)
	default:
		c = exec.Command("xdg-open", u)
	}
	_ = c.Start()
}

// 供静态 embed 校验引用（避免 import 未用报错的显式引用）
var _ = staticFS
var _ fs.FS = staticFS
