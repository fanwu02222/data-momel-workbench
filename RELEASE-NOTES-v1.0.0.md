# 数据建模工作台 v1.0.0 发行说明

面向数仓工程师的可视化建模工具：按 ODS / DIM / DWD / ADS 五层管理数据模型，支持业务逻辑维护、字段级/全局血缘可视化、SQL 生成与反解析、Excel 数据字典导入导出，复杂批量任务可交给 DSH 智能体。

## 功能亮点

- **五层建模**：ODS / DIM / DWD / DWS / ADS，`dim_` 前缀自动归层；元信息、字段表、分区、源表映射（JOIN/别名/ON）、WHERE / GROUP BY、逻辑说明
- **血缘可视化**：字段级（表达式引用解析，SVG 交互图，未解析引用红虚线告警）+ 全局模型 DAG（点击下钻）
- **SQL 生成**：按依赖拓扑排序输出 Hive/SparkSQL、MySQL、ClickHouse、PostgreSQL 四方言 DDL + ETL DML
- **SQL 模板**：四方言 × DDL/DML 模板可自定义（`{{变量}}` / `{{if:变量}}` 语法，实时预览）
- **SQL 反解析**：CREATE TABLE / CTAS / INSERT INTO...SELECT → 模型（含注释、分区、JOIN 条件、动态分区、自动归层）
- **Excel 数据字典**：导出/导入闭环（配置、总览、模型字段表、源表映射、血缘清单五个维度），合并/替换两种导入模式
- **自定义扩展列**：表级/字段级均可增加自定义属性列，随项目持久化
- **规范校验**：命名重复、前缀与分层不一致、血缘断裂、循环依赖等，逐条定位
- **DSH 集成**：补注释、深度规范审查、数据字典文档、批量反解析、ETL 调度方案等模板任务

## 快速开始

```bash
node server.js        # 启动 → http://127.0.0.1:8130（默认端口，PORT 可覆盖）
```

- 零第三方依赖，仅需 Node.js ≥ 22（推荐 24）
- 首次启动自动载入「电商交易数仓」示例（11 模型全链路）
- 数据存 SQLite（`workbench.db`，自动创建）；`project.json` 为每次保存自动导出的快照
- 也可直接双击 `index.html` 使用纯浏览器模式（不持久化到服务端）

## 运行测试

```bash
node test/test.js              # 解析/生成/血缘 75 项
node test/server-roundtrip.js  # 服务端 API 回环
node test/xlsx-export-test.js  # Excel 导出（需 python3）
node test/excel-roundtrip.js   # Excel 导入回环（需服务已启动）
```

## 压缩包内容

`dw-workbench-v1.0.0.zip` 为源码发行包（`git archive` 生成，24 个文件），解压后目录：

```
index.html  css/  js/  server.js  test/  README.md  .gitignore
```

不含任何用户数据（workbench.db / project.json 不在包内）。
