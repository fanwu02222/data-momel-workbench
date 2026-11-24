# 数据建模工作台（Data Warehouse Workbench）

面向数仓工程师的可视化建模工具：按 **ODS / DIM / DWD / DWS / ADS** 五层管理数据模型，支持业务逻辑（字段表达式）维护、**字段级/表级血缘**可视化（节点可拖拽布局）、**SQL 生成**（DDL + ETL DML）与 **SQL 反解析入库**，复杂批量任务可一键交给 **DSH 智能体**执行。

## 快速开始

### 方式一：Go 单二进制（推荐，已内置前端资源）

```bash
go build -o dw-workbench-go .   # 或使用预编译二进制
./dw-workbench-go               # 默认 http://127.0.0.1:8130，PORT/HOST/DW_DATA_DIR 可覆盖
```

开发联调模式（前端从磁盘读取，改 js/css 刷新即生效）：`./dw-workbench-go -dev`

### 方式二：Node 版（零依赖，需 Node 22.5+）

```bash
node server.js                  # 默认 http://127.0.0.1:8130，可用 PORT 覆盖
```

两种方式共用同一份 `workbench.db`（SQLite/WAL）与数据迁移逻辑，可随时切换。

浏览器打开 `http://127.0.0.1:8130`。

- 首次访问自动载入「电商交易数仓」示例（11 个模型全链路，含 DIM 用户维度），可在右上 `⋯ → 加载示例项目` 重置。
- 所有编辑自动存浏览器；点 **💾 保存**（或 `Ctrl+S`）写入服务端 SQLite（`workbench.db`）。
- 不启动 server.js 也可单文件打开 `index.html` 使用（纯浏览器存储模式）。

### Docker

```bash
docker build -t dw-workbench .
docker run -d -p 8130:8130 -v dw-data:/data dw-workbench
```

数据持久化在 `dw-data` 卷（SQLite + 快照）；`PORT` / `HOST` / `DW_DATA_DIR` 三个环境变量可覆盖默认值。

## 与同类工具的定位对比

| | 本工具 | PowerDesigner / erwin | Excel 手工台账 |
|---|---|---|---|
| 授权 | **开源免费**（Apache-2.0） | 商业授权，数千元/席/年 | 免费 |
| 数仓五层建模（ODS/DIM/DWD/DWS/ADS） | ✅ 内置方法论 | ❌ 通用数据建模，需自行约定 | 手工约定 |
| ETL DML 骨架生成（FROM/JOIN/WHERE/GROUP BY） | ✅ | 部分（仅 DDL 为主） | ❌ |
| SQL 反解析入库（DDL/CTAS/DML → 模型） | ✅ | ❌ | ❌ |
| Excel 数据字典导出/导入回环 | ✅ 零依赖真 OpenXML | 有限 | — |
| 字段级血缘（表达式解析）+ 全局 DAG | ✅ | 强但重 | ❌ |
| 上手成本 | `node server.js` 即用 | 安装+学习成本高 | 低但难维护 |
| 适用场景 | 数仓团队轻量建模/文档/评审 | 企业级全生命周期 | 小团队临时台账 |

## 版本

- **社区版**（本仓库，免费开源）：全部建模能力——五层模型、SQL 生成/反解析、血缘、Excel 回环、模板引擎、DSH 集成
- **专业版**（规划中，闭源付费）：反向建模（连接存量库拉取表结构）、Doris / StarRocks / Oracle / SQL Server 方言、Word/PDF 数据字典、版本 diff 与发布定稿管理

社区版将始终保持免费并持续维护。

## 存储：SQLite + 快照

- **`workbench.db`（SQLite，WAL 模式）** 是唯一数据源，表结构：`project` / `models` / `fields` / `partitions` / `sources`，保存时整库事务替换，外键级联删除；`project/models/fields` 均带 `extra_json` 列存放自定义扩展属性（建表时自动迁移补列）。
- **`project.json`** 是每次保存自动导出的快照，保持与 API 同构，供 DSH、脚本、版本管理使用；首次启动若库为空且存在旧快照，会自动迁移入库。
- API：`GET /api/project` 读取完整 JSON；`PUT /api/project` 整体保存（body 为完整项目 JSON）。

## 功能总览

| 模块 | 说明 |
|---|---|
| 模型设计 | 元信息、字段表（名称/类型/注释/主键）、分区字段、源表映射（FROM/JOIN + 别名 + ON）、WHERE / GROUP BY、逻辑说明；**表级与字段级均可添加自定义扩展列**（自定义列名，如：责任人、敏感等级），随项目持久化 |
| 项目管理 | 多项目支持：新建 / 切换 / 删除，各项目模型与业务目录完全隔离；顶栏下拉切换，项目元信息独立保存 |
| 业务目录树 | L1 业务域 → L2 主题域（**支持多级子域嵌套**）→ L3 业务对象；L4 = 模型（通过「业务归属」挂载）、L5 = 字段；侧栏「按分层 / 按业务目录」双视图，目录节点可增删改、模型随节点展示 |
| 血缘关系 | 维度链路（ODS→DIM→ADS）/ 字段级血缘（表达式引用解析，SVG 交互图，悬停高亮连线，未解析引用红虚线告警）；全局模型血缘（四层 DAG，点击节点下钻）；**节点拖拽布局**（位置随项目持久化，「重置布局」一键还原）；视图自动适应窗口大小，不同分辨率/小窗口整图可见 |
| SQL 脚本 | 按依赖拓扑排序生成 Hive/SparkSQL、MySQL、ClickHouse、PostgreSQL 四种方言的 DDL + ETL DML，支持单模型/全量、复制与下载；**生成模板可自定义编辑**（见下方「SQL 模板」） |
| SQL 反解析 | 粘贴 `CREATE TABLE`（注释/分区）、`CTAS`、`INSERT INTO/OVERWRITE ... SELECT`，自动解析为模型：字段、类型、注释、分区、源表映射、表达式、WHERE/GROUP BY、按前缀归层；预览后选择导入或覆盖同名模型 |
| 规范校验 | 表名重复/前缀与分层不一致/字段缺注释/非 ODS 层缺源表映射/血缘断裂/循环依赖，逐条可定位 |
| Excel 导出 | 一键导出数据字典 .xlsx（零依赖，真 OpenXML）：配置（项目名/方言/自定义列定义）+ 总览（含逻辑说明）+ 每模型字段表（含分区标记与自定义列）+ 源表映射（含 JOIN 条件）+ 血缘清单，首行冻结、自适应列宽 |
| Excel 导入 | 与导出闭环：选择 .xlsx → 合并导入（按表名覆盖/追加）或替换整库，字段/分区/JOIN 条件/逻辑说明/自定义列全部还原；服务端解析（内置 zlib），支持 Excel/WPS 标准输出 |
| DSH 任务 | 把复杂工作交给 DSH：补注释、深度规范审查出报告、生成数据字典、批量反解析 sql/ 目录、设计 ETL 调度方案 |

## 数据文件：project.json

```jsonc
{
  "name": "项目名",
  "dialect": "hive",              // hive | mysql | clickhouse | postgresql
  "models": [{
    "id": "m_xxx", "layer": "dwd", // ods | dim | dwd | dws | ads
    "name": "dwd_order_info_di", "cnName": "订单明细事实表",
    "desc": "...", "source": "mysql://...",   // ODS 层源系统
    "fields":  [{ "name": "order_id", "type": "bigint", "comment": "订单ID",
                  "pk": true, "expr": "o.id" }],          // expr = 业务逻辑表达式
    "partition": [{ "name": "dt", "type": "string", "comment": "统计日期", "expr": "o.dt" }],
    "sources": [{ "name": "ods_order_info", "alias": "o", "on": "" }], // 第一个源表无需 on
    "where": "o.order_status in (...)", "groupBy": "", "notes": "清洗规则说明"
  }]
}
```

## SQL 模板

「SQL 脚本」页 → **⌗ 模版** 可自定义每个方言 × DDL/DML 的生成模板，随项目保存（SQLite）。

- 语法：`{{变量}}` 插值；`{{if:变量}}…{{/if}}` 条件块（变量有值时才渲染内部）
- 未定制的方言自动使用内置默认模板（与历史输出一致）；「恢复内置默认」一键还原
- 自定义 DDL 时输出完全由模板掌控（不再自动追加 ODS 同步说明）

DDL 可用变量：`tableName` / `rawTableName` / `tableComment` / `layerUpper` / `columns`（普通字段）/ `partitionColumns` / `allColumns` / `pkClause`（MySQL 主键）/ `orderByKeys` / `chPartition`（ClickHouse 分区）/ `partitionHint`（MySQL 提示）/ `tableCommentClause` / `columnCommentClauses`（PG 注释语句）

DML 可用变量：`headerComments` / `insertVerb` / `targetTable` / `dmlPartitionSpec`（Hive 动态分区）/ `selectList` / `fromClause` / `whereClause` / `groupByClause`

编辑器内点击变量芯片即插入光标处，带实时预览（以当前选中模型渲染）。

## DSH 集成

两种方式：

1. **界面引导**：顶栏 `🤖 DSH任务` → 选模板 → 复制提示词 → 在 DSH 会话中粘贴执行；
2. **直接执行**：对话框内点「直接调用 DSH 执行」，本地服务以 `dsh --profile headless --permission-mode danger-full-access -` 后台运行任务，实时回显输出；任务结束后服务对比数据快照，若 DSH 通过 API 改动了数据，工作台自动刷新。

模板提示词统一指导 DSH 通过 `GET/PUT http://127.0.0.1:8130/api/project` 读写数据；可在 `js/dialogs.js` 的 `DSH_TEMPLATES` 中按需增改。

## 测试

```bash
node test/test.js     # 75 项断言：词法/解析/生成/血缘/拓扑排序/生成↔反解析回环
```

另有 Excel 导出/导入回环（`xlsx-export-test.js` / `excel-roundtrip.js`）与服务端 PUT 回环（`server-roundtrip.js`）测试。

## 目录结构

```
index.html          入口页面
css/style.css       视觉系统（分层色板 + 等宽技术字体）
js/sql-lexer.js     SQL 词法分析（方言友好，支持中文标识符）
js/sql-parser.js    反解析器：DDL/CTAS/DML → 模型
js/sql-generator.js 生成器：模型 → 多方言 DDL/DML（含拓扑排序）
js/lineage.js       血缘计算 + SVG 渲染（字段级/全局，全局图支持拖拽布局）
js/store.js         数据层：localStorage 自动保存 + 服务端持久化
js/editor.js        模型编辑器
js/dialogs.js       导入/校验/DSH/JSON 导入导出对话框
js/app.js           布局、侧栏、页签、SQL 预览、全局变更监听
server.js           本地服务：静态文件 + SQLite API + DSH headless 代理
workbench.db        SQLite 数据库（数据源，首次运行自动创建）
project.json        自动导出的数据快照（DSH/文件工作流用）
js/xlsx-export.js   Excel 导出（零依赖 OpenXML：CRC32 + stored ZIP + SpreadsheetML）
js/sample.js        示例项目数据
test/test.js        解析/生成/血缘测试套件
test/xlsx-export-test.js  Excel 导出测试（Node 生成 + Python zip/XML 深度校验）
test/excel-roundtrip.js   Excel 导出→导入回环测试（合并/替换/非法文件拒绝）
test/server-roundtrip.js  服务端 PUT 回环测试（node test/server-roundtrip.js）
```

## License

[Apache-2.0](LICENSE)
