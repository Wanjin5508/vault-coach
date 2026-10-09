---
tags:
  - 开发过程
  - KnowledgeEngine
  - 独立工作台
  - 知识训练
  - Agent
  - Docker
  - ANN
  - Graph
  - 开发路线图
status: planned
updated: 2026-07-26
depends-on:
  - VaultCoach-Lite-后续开发路线图.md
  - 三个项目协同架构与责任边界.md
related:
  - ../../knowledge-engine/00-开发者能力地图.md
  - ../../knowledge-engine/01-需求规格.md
  - ../../knowledge-engine/02-架构设计.md
  - ../../knowledge-engine/04-独立工作台、知识训练与Agent设计.md
  - ../../knowledge-engine/05-语言、客户端与桌面发行策略.md
  - AI-Career-Agent-知识接口与数据契约.md
---

# Knowledge Engine Local：独立知识训练平台开发路线图

## 1. 新的产品定位

Knowledge Engine 不再只是“大 Vault 时由 Vault Coach 调用的后端服务”。它是可通过 Docker 在本机启动、可在浏览器 GUI 中独立使用的知识训练平台，同时为 Vault Coach 和 AI Career Agent 提供可选的版本化协同接口。

```text
独立用户：Engine GUI → 导入资料 → 检索/图谱 → 考试/训练 → 受控 Agent
Vault 用户：Vault Coach → 显式 Connector → Engine 加速与调试
职业用户：Career Agent → 显式 Profile/Gap API → 有限能力证据
```

这三个路径共享 Engine Core，但互不构成可用性前提。Vault Coach Lite 不应被 Engine 停止阻断；Engine GUI 不需要 Obsidian 才能验证完整工作流；Career Agent 不得读取任意 Engine chunk 或 Vault。

## 2. 启动条件、非目标与不变量

### 2.1 启动条件

- Vault Coach Lite 已保留版本化 `KnowledgeEngineClient` 与 Lite fallback；
- KE-0 前先构造匿名基准语料，记录 Lite 的 chunk 数、索引时间、图谱首屏、内存、失败/恢复时间；
- 独立仓库的 API 以 OpenAPI/JSON Schema 为准，不能复用 Obsidian TypeScript 对象作为线上 DTO；
- 每个阶段都有可运行、可测试、可删除的最小产物，不以“Agent 能聊天”作为完成证明。

### 2.2 不做什么

- 不先做云托管、多租户、支付、跨设备账号、默认 LAN 监听或远程遥测；
- 不用 Electron/Tauri 作为首个 GUI 前置条件；首版采用 React + TypeScript loopback Web Workbench，KE-9 再引入 Electron 作为直装 macOS Host；
- 不让 Agent 获得任意文件系统、shell、SQL、ES DSL 或网络工具；
- 不让 Engine 缓存、embedding 分数、RRF 排名或 Agent 建议自动覆盖 Vault 事实、图谱治理、Assessment 或 mastery；
- 不因“架构完整”预装 Neo4j、Qdrant/Milvus、Kafka、Redis 或 ES；后者仅在独立基准证明收益后引入。

### 2.3 工作区事实边界

| 工作区 | 入口 | 权威 source revision | Engine 写入范围 |
| --- | --- | --- | --- |
| `managed` | GUI/CLI 显式导入 | Engine 数据卷内的已导入 revision | 自身的 chunk、图谱治理、Assessment、mastery、索引、job |
| `connector` | Vault Coach 通过 `KnowledgeChangeV1` 同步 | Vault 的原文、M2/M3 决策与插件 Assessment | 授权副本、搜索/图谱投影、任务与诊断；不写回 Vault |

## 3. 阶段总览

| 阶段 | 名称 | 用户/开发者可见产物 | 前置 |
| --- | --- | --- | --- |
| KE-0 | 契约、事实边界与基准 | 独立/Connector DTO、fixture、匿名基准、验收矩阵 | VC-L8 |
| KE-1 | 本地运行时与 Workbench 骨架 | Docker、health/version、migration、浏览器 GUI、诊断页 | KE-0 |
| KE-2 | 工作区、导入与 revision | managed import、Connector sync、source/chunk Inspector、删除 | KE-1 |
| KE-3 | 高性能证据检索 | lexical/vector/hybrid、filter、RAG Inspector、基准 | KE-2 |
| KE-4 | 有界图谱与证据查询 | projection、路径/前置查询、Graph Explorer | KE-2 |
| KE-5 | Durable job 与可观测性 | queue、progress、cancel、retry、index lag、重建 | KE-3、KE-4 |
| KE-6 | 独立考试与知识训练 | exam mode、Assessment、mastery、训练建议、Exam Workbench | KE-3、KE-4、KE-5 |
| KE-7 | 受控知识训练 Agent | tool policy、trace、评估、确认工作流 | KE-3 至 KE-6 |
| KE-8 | Vault Coach / Career Agent Connector | health/sync/fallback、Profile/Gap API、协同回归 | KE-2 至 KE-7 |
| KE-9 | 发布加固、Electron Host 与设计伙伴验证 | 压测、备份/恢复、直装 macOS 包、隐私/部署文档、Local beta | KE-8 |
| KE-10（条件） | Store / 替代桌面壳可行性 | Mac App Store sandbox 或 Tauri/Rust 对照原型与 go/no-go 报告 | KE-9 |

## 4. KE-0：契约、事实边界与基准

### 工作项

1. 建立独立仓库的 `contracts` 包，冻结 `VersionedEnvelopeV1`、`KnowledgeChangeV1`、`RetrievalRequest/HitV1`、`GraphProjectionV1`、Training DTO、Agent trace DTO 和 `KnowledgeProfileV1`。
2. 给 workspace 增加 `sourceMode: managed | connector`，明确 revision、删除、导入/同步和跨端冲突语义。
3. 构造小/中/大匿名资料集，覆盖 Markdown、PDF、中文/英文、目录 filter、图关系、考试历史和删除/重命名；不得使用私人 Vault 内容。
4. 定义三条独立验收路径：Engine GUI、Vault Coach Lite、Career Agent；定义三条协同路径：Connector 检索、Connector 图查询、授权 Profile。
5. 记录 Lite 对照指标，以及 Engine 的 Recall@K、p50/p95、全量/1% 增量、内存、磁盘、取消/恢复时间。

### 完成标准

- fixture 可在 GUI client、Vault Coach connector 与服务端双向验证；
- 同一 source 不能同时以 managed 导入和 connector 同步产生未标记的覆盖；
- 所有基准可一键重建，并能作为后续 ES/Neo4j/向量库决策依据。

## 5. KE-1：本地运行时与 Workbench 骨架

### 工作项

1. 实现 `engine-api`、`engine-worker`、PostgreSQL+pgvector、migration、health/version、request ID、结构化脱敏日志和 loopback-only Docker Compose。
2. 创建 Web Workbench，至少有：服务状态、workspace 列表、空态、数据目录/版本/存储占用诊断、错误页和 API compatibility 状态。
3. Workbench 只能使用 contracts SDK 调用 API；禁止浏览器直连数据库或 worker 私有接口。
4. 建立 API contract test、Docker smoke test 和 GUI E2E 骨架；测试覆盖首次启动、旧 schema、端口占用、数据库不可用和容器重启。

### 完成标准

- 用户在没有 Obsidian 的机器上可启动 Docker、打开 Workbench、看到明确 readiness 与故障诊断；
- 数据卷重启后仍存在，测试数据可显式清除；
- 不需要任何图数据库、消息队列或桌面壳。

## 6. KE-2：工作区、导入与 revision

### 工作项

1. 实现 managed workspace 的导入预览、提交、取消、重试、删除和导出；只允许用户主动选择的资料进入数据卷。
2. 实现 source、section、chunk、hash、locator、revision、导入错误与存储占用；Workbench 展示 source/chunk Inspector。
3. 实现 Connector workspace 的 `POST /v1/workspaces/{id}/changes`：revision/idempotency、乱序冲突、rename/delete、waterline、outbox/job 入队。
4. 建立 source mode 策略：Connector 无写回 Vault 路径；managed 与 connector 的复制必须经显式导入/导出或授权 sync。
5. 支持 workspace 完全删除，删除索引与可识别副本，保留最小必要审计，不触及外部 Vault。

### 完成标准

- GUI 能直观看到“资料被如何切成 section/chunk、当前 revision 是什么、为什么某项失败”；
- 重放、乱序、删除、重命名和服务重启不产生重复 chunk 或悬空引用；
- Connector 未连接时，managed workspace 仍能独立导入和训练。

## 7. KE-3：高性能证据检索与 RAG Inspector

### 工作项

1. 实现 PostgreSQL FTS + pgvector 基线、metadata pre-filter、embedding model/version、lexical/vector/hybrid top-K 与明确的预算。
2. Workbench 提供 Retrieval Inspector：查询、scope、模式、结果、chunk excerpt、locator、revision、命中渠道、阶段耗时、截断/降级信息。
3. 实现有证据回答 API：先检索有限 hits，再把最小上下文交给模型；无证据时返回 abstain。
4. embedding/rebuild 必须走 job，支持模型限速、取消、重试与 revision fencing。
5. 只有在 benchmark 证明中文分析、复杂 filter、highlight、RRF 或 p95 有明确收益后，才以可选 profile 引入 Elasticsearch Search Projection。

### 完成标准

- 相同输入、scope 和 index version 有稳定排序或明确并列规则；
- RAG 回答可在 Inspector 中定位每条引用，模型不可用/索引落后时有可解释降级；
- 不存在先全库召回、再在应用层做权限过滤的路径。

## 8. KE-4：有界图谱与证据查询

### 工作项

1. 存储 effective Concept、alias/redirect、confirmed typed relation、evidence 与 revision；候选与 confirmed fact 分层。
2. 实现邻接索引、一/两跳 projection、前置关系与有限路径查询；所有请求强制 depth/node/edge/time budget。
3. Workbench Graph Explorer 展示节点、边方向/类型、证据、revision、预算裁剪和来源 filter；不提供默认全图按钮。
4. 对热点 projection 建立 revision-keyed cache，精确失效。

### 完成标准

- 每条可见边都能追溯来源和 effective revision；
- 删除/合并/redirect 不产生悬空引用；
- 关系表方案在 benchmark 通过前不引入图数据库。

## 9. KE-5：Durable job 与可观测性

### 工作项

1. 实现 `queued | running | succeeded | failed | cancelled | stale` 状态机、lease、retry、cancel、checkpoint、revision fencing 和 worker 重启恢复。
2. 将 embedding、候选生成、聚类、中心性、projection 预热、批量 mastery 和 ES projection（如采用）全部移入 job。
3. Workbench 提供 Job Inspector：输入 revision、阶段、进度、attempt、耗时、错误摘要、index lag、取消和重试。
4. 候选关系采用 blocking → ANN top-K → filter → 小集合 rerank；候选默认 pending，永不自动升格为 confirmed。

### 完成标准

- 不因 UI 关闭丢失任务；取消、过期 revision、模型故障和容器重启不发布半成品事实；
- 有可重复的失败注入/恢复测试，且任务状态可由 GUI 和 Connector 查询。

## 10. KE-6：独立考试与知识训练

### 工作项

1. 建立 Training domain：范围分析、训练计划、`simple | challenge`、题目来源、评分、Assessment、mastery 和训练建议。
2. Workbench Exam 实现“设置 → 分析并锁定 → 生成 → 作答 → 提交 → 复盘”的状态机；已分析状态不得就地切换考试模式。
3. simple 只走确定性客观题评分；challenge 的自由文本评分记录 evaluator/model/prompt version；两者输出兼容 Assessment。
4. 将题目与 chunk/Concept 证据绑定；不能安全绑定时保存未绑定事件，禁止猜测。
5. 设计 Connector 对 Assessment 的显式兼容同步策略；默认不跨端静默合并历史。

### 完成标准

- 用户不安装 Obsidian 也能完成带来源、可复盘、可重算 mastery 的考试闭环；
- 考试模式不会改变图谱事实或 mastery 权重；
- 每次分数、建议和训练计划可追溯到 assessment/session/revision。

## 11. KE-7：受控知识训练 Agent

### 工作项

1. 实现 `AgentRun`、tool registry、policy gate、budget、cancellation、trace store 与 evaluation fixture。
2. 首版只允许 `search_chunks`、`get_graph_projection`、`get_concept_mastery`、`get_assessment_history`、`draft_training_plan`、`draft_exam_request` 等受限工具。
3. Agent 在每一步执行前验证 workspace、scope、top-K/depth、调用次数和 deadline；工具无证据/超时必须返回结构化失败而不是让模型猜测。
4. Workbench Agent Console 显示目标、工具调用摘要、来源、revision、耗时和最终答复；不显示或保存思维链。
5. 高影响动作经单独 workflow：Agent 只能生成草案；资料导入、创建考试、启动大 job、发布 Profile、图谱治理必须由用户确认后调用确定性 API。

### 完成标准

- 覆盖越权 scope、无来源、循环调用、过预算、模型不可用、取消和过期 revision 的自动化评估；
- Agent 的每个事实性回答附证据，不足时 abstain；
- Agent 从不拥有数据库直连、任意 HTTP、文件系统或 shell 权限。

## 12. KE-8：Vault Coach / Career Agent Connector

### 工作项

1. 实现 Vault Coach Local adapter：health/version handshake、启动 token、schema compatibility、超时/退避、显式同步范围、revision 水位、任务状态与 Lite fallback。
2. Vault Coach 设置只显示 Connector 所需状态，不把 Engine GUI 嵌入或变成 Obsidian 的隐式依赖。
3. Engine GUI 可区分 managed/connector 工作区，并诊断索引同步、来源 revision 和运行的 jobs。
4. 实现 Knowledge Profile 的预览、发布、撤销、删除和受限 capability gap API；Career Agent 只能获取用户授权的摘要与证据。
5. 建立三方回归：Engine 停止、协议不兼容、Connector 同步中、Profile 撤销和 Career Agent 不可用时，另外两端保持独立核心功能。

### 完成标准

- Vault Coach 无 Engine 时完整回退 Lite；
- Engine GUI 不连接 Vault Coach 时仍完整可用；
- Career Agent 没有 Profile 授权时不能搜索 Engine chunk，更不能访问 Vault。

## 13. KE-9：发布加固与设计伙伴验证

1. 用 KE-0 基准做全量/1% 增量、重命名/删除、模型故障、服务重启、数据库恢复、ES projection 重建（如采用）和 Agent 评估。
2. 发布分档硬件建议、磁盘估算、支持模型、首次构建时间、Lite/Engine 选择建议和 GUI 问题诊断手册。
3. 提供 Docker 升级、备份、恢复、完整删除、日志导出、隐私边界和模型外发说明；默认不开放 LAN 端口。
4. 实现 Electron Desktop Host POC：同一 React Workbench 和 HTTP API，负责本地 Engine 的启动、health 检查、停止、崩溃诊断与数据目录提示；禁止创建桌面端专属业务旁路。
5. 为 `.dmg` 或 `.pkg` 建立 Developer ID 签名、Hardened Runtime、公证与 staple 验证流水线；验收首次启动、端口冲突、服务未就绪、升级、卸载、备份以及数据保留/清除。
6. 以少量设计伙伴验证：独立训练完成率、Connector 成功率、检索收益、Agent 可控性、支持成本、桌面安装成功率和用户对重度工作台的真实需求。

## 14. KE-10（条件）：Store / 替代桌面壳可行性

KE-10 不是当前交付前置条件。仅当 KE-9 的数据表明 macOS 用户的安装、内存、包体积或发行渠道存在明确问题时启动，并且必须保持 Core、contracts 和 Web Workbench 不变。

1. 若 Store 渠道有明确需求，建立 Mac App Store sandbox POC：只允许用户显式选择资料，验证 security-scoped bookmark、沙盒数据目录、导入/删除和受限后台行为。
2. 若 Electron 的启动时间、空闲内存或安装包大小超出目标，建立 Tauri/Rust Host 对照原型；它仍调用同一 API，不允许用重写领域逻辑换取表面指标。
3. 在匿名基准与真实安装遥测（仅 explicit opt-in）下比较直装 Electron、Store POC 或 Tauri POC 的安装成功率、启动时间、空闲内存、包体积、升级/恢复成功率和维护成本。
4. 产出明确的 go/no-go 决策：继续 Electron、维护额外 Store 构建或迁移桌面壳；没有数据不得增加第二个长期维护目标。

## 15. Definition of Done

- [ ] 无 Obsidian 时，用户能在 Engine GUI 完成导入、索引、检索、图谱、考试和受控 Agent 的独立闭环；
- [ ] managed / connector 的 source ownership、revision、删除和审计语义均明确且自动化验证；
- [ ] 任何检索、图谱、考试、mastery 与 Agent 结果都带范围、版本、来源和预算/降级信息；
- [ ] 所有重计算均有 job、进度、取消、错误、恢复与基准；
- [ ] Vault Coach 断开 Engine 后完整回退 Lite；Career Agent 只能消费经授权的 Profile/Gap DTO；
- [ ] Agent 没有高权限旁路，所有高影响动作由确定性 workflow 和用户确认控制；
- [ ] KE-9 的 Electron 直装包复用同一 Workbench/API，并通过签名、公证、升级、卸载与数据生命周期验证；
- [ ] 仅当 benchmark 显示明确收益时才增加 Elasticsearch、图数据库、专用向量库或消息队列。
