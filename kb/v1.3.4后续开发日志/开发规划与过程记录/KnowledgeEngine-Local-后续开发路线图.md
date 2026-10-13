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
# Knowledge Engine 开发路线图（三阶段版）

基于《Knowledge Engine Local》路线图改写 · 2026-10-12

## 1. 定位与商业模式

Knowledge Engine（KE）是为大规模知识库提供检索、图谱投影与受控推理的独立服务。同一套 Engine Core 以两种形态交付：

|   |   |   |   |   |
|---|---|---|---|---|
|形态|用户|租户|默认网络|计费|
|自托管开源版|有技术基础的用户，Docker 本机或自建部署|单租户|仅 loopback|无|
|付费托管版|超出 Vault Coach Lite 阈值、愿意订阅的用户|多租户|公网 TLS + 认证|订阅套餐|

两种形态共用同一份业务代码，差异只在配置与部署层（认证方式、租户模式、计费开关、监听地址），禁止分叉出两套业务逻辑。

使用路径：

- Vault Coach 用户：Lite 仍是默认体验；知识库超过阈值时提示可选 Engine，用户在设置页填写服务地址与账号或 key（自托管填本地地址与 token，托管版填订阅 key）。
- 独立用户：通过 Workbench 查看服务状态、导入资料、检查检索与图谱（轻量诊断型 GUI）。
- Career Agent：Profile / Gap API 暂缓（见第 7 节）。

## 2. 不变量（沿用并补充）

1. Vault Coach Lite 永远可独立运行；Engine 停止、订阅过期、key 失效、协议不兼容时，必须清晰提示并回退 Lite，不丢本地数据。
2. Engine 的缓存、embedding 分数、RRF 排名、Agent 建议不得自动覆盖 Vault 事实、图谱治理、Assessment 或 mastery；Connector 不写回 Vault。
3. 同一 source 不能同时以 managed 导入与 connector 同步产生未标记覆盖（workspace 的 `sourceMode: managed | connector`）。
4. DTO 以 OpenAPI / JSON Schema 为准，不复用 Obsidian TypeScript 对象。
5. 无独立基准证明收益，不引入 Elasticsearch、图数据库、专用向量库、Kafka、Redis。
6. 云上只处理用户显式授权同步的范围，不静默上传；云端演示与压测只用匿名或合成数据。
7. Agent 不得获得任意文件系统、shell、SQL、ES DSL 或网络工具；高影响动作必须用户确认。
8. 自托管默认只监听 loopback，不开 LAN、不做远程遥测；托管版必须 TLS + 认证。

相对原路线图的变化：云托管、多租户、支付从「非目标」调整为 P2、P3 的范围；独立考试训练、Career Agent 协同、Electron / Store 发行移出主线（第 7 节）。

## 3. 阶段总览

|   |   |   |   |   |
|---|---|---|---|---|
|阶段|目标|主要产物|对应原阶段|时间盒（粗估）|
|P1|自托管单租户闭环|契约、导入与 revision、检索、有界图谱、job、Vault Coach Connector 最小版|KE-0 至 KE-5、KE-8 部分|4–6 周|
|P2|多租户与账号|租户隔离、账号与 key、限流配额、公平调度、云部署与可观测、数据生命周期|新增|4–6 周|
|P3|付费、合规与发布|套餐与计费、合规文档、Vault Coach 云接入体验、设计伙伴 beta、可选受控 Agent|KE-7、KE-9 部分|视反馈|

时间盒按每周 10–15 小时粗估，需按实际速度校准。每个阶段结束时无论完成度如何，都要把成果整理成可展示的内容（文档、基准报告、简历表述），再决定是否继续。

依赖顺序：P1 → P2 → P3。进入 P3 的计费之前，必须先确认 Vault Coach 中确有用户触碰阈值并愿意付费（见 P3 入口条件）。

## 4. P1：自托管单租户闭环

目标：用户在自己的机器上用 Docker 启动 Engine，Vault Coach 超过阈值后可连接并获得检索与图谱加速；Engine 停止时回退 Lite。

### P1-0 契约、事实边界与基准（原 KE-0）

1. 独立仓库 `contracts` 包，冻结 `VersionedEnvelopeV1`、`KnowledgeChangeV1`、`RetrievalRequest/HitV1`、`GraphProjectionV1`；Training、Agent trace、Profile 相关 DTO 延后到需要时再冻结。
2. 匿名小/中/大语料（Markdown、PDF、中英文、目录 filter、图关系、删除与重命名），不得使用私人 Vault 内容。
3. 记录 Lite 与 Engine 的对照指标：Recall@K、p50/p95、全量与 1% 增量耗时、内存、磁盘、取消与恢复时间；基准可一键重建，作为后续组件选型依据。
4. 量化「超过阈值」的真实体验差距：Lite 在哪个规模开始不可用，Engine 能提升多少。

### P1-1 运行时与 Workbench 骨架（原 KE-1）

1. `engine-api`、`engine-worker`、PostgreSQL + pgvector、migration、health/version、request ID、脱敏结构化日志、loopback-only Docker Compose。
2. 轻量 Workbench：服务状态、workspace 列表、存储占用、API 兼容状态、错误诊断；仅通过 contracts SDK 调用 API。
3. API contract test、Docker smoke test；覆盖首次启动、旧 schema、端口占用、数据库不可用、容器重启。

### P1-2 工作区、导入与 revision（原 KE-2）

1. managed workspace：导入预览、提交、取消、重试、删除、导出；source / section / chunk / hash / locator / revision。
2. connector workspace：`POST /v1/workspaces/{id}/changes`，实现 revision 与 idempotency、乱序冲突处理、rename/delete、waterline、outbox/job 入队。
3. Source / chunk Inspector；workspace 完全删除并清理索引与可识别副本。

### P1-3 检索与 RAG Inspector（原 KE-3）

1. PostgreSQL FTS + pgvector 基线，metadata pre-filter，lexical / vector / hybrid top-K，明确预算与降级。
2. Retrieval Inspector：查询、scope、模式、命中、locator、revision、阶段耗时、截断信息。
3. 有证据回答 API：先检索有限 hits，无证据时 abstain。
4. embedding 与重建走 job，支持限速、取消、重试、revision fencing。

### P1-4 有界图谱投影（原 KE-4，缩小范围）

1. 存储 effective Concept、alias/redirect、confirmed typed relation、evidence 与 revision；候选与已确认事实分层。
2. 一/两跳 projection 与有限路径查询，强制 depth / node / edge / time 预算；热点 projection 使用按 revision 精确失效的缓存。
3. 暂不做完整 Graph Explorer，只提供 API 与简单检查页；关系表方案基准通过前不引入图数据库。

### P1-5 Durable job 与可观测（原 KE-5）

1. 状态机 `queued | running | succeeded | failed | cancelled | stale`，含 lease、retry、cancel、checkpoint、revision fencing、worker 重启恢复；队列基于 Postgres（如 `FOR UPDATE SKIP LOCKED`）。
2. embedding、候选生成、projection 预热等重计算全部放入 job；候选默认 pending，不自动升格。
3. Job Inspector：输入 revision、阶段、进度、attempt、耗时、错误、index lag、取消与重试。
4. 失败注入与恢复测试：取消、过期 revision、模型故障、容器重启。

### P1-6 Vault Coach Connector 最小版（原 KE-8 部分）

1. health/version 握手、启动 token、schema 兼容检查、超时与退避、显式同步范围、revision 水位、任务状态查询。
2. 设置页只展示 Connector 所需状态（服务地址、token、同步范围、连接状态），并保留 Lite 回退。
3. 三方回归：Engine 停止、协议不兼容、同步进行中，Vault Coach 均保持 Lite 可用。

### P1 出口标准

- 无 Obsidian 时 Docker 可启动，Workbench 能显示状态并完成导入、检索、图谱检查；
- 重放、乱序、删除、重命名、服务重启不产生重复 chunk 或悬空引用；
- 所有重计算有 job、进度、取消、恢复，并有可重复的故障注入测试；
- Vault Coach 连接 Engine 后在超阈值语料上可用，断开后完整回退 Lite；
- 基准报告可复现，给出 Lite 与 Engine 的对比数据；
- 产出一页设计说明与基准报告，可直接用于 README 与简历。

可写进简历的产出（数字需自行实测后填写）：设计并实现幂等、乱序容忍的增量同步协议与基于 Postgres 的持久任务队列；在 [N] 万 chunk 规模下检索 p95 为 [X] ms，较 Lite 提升 [Y]；故障注入下无数据丢失。

## 5. P2：多租户与账号

目标：同一 Engine Core 以云部署形态服务多个互相隔离的租户，并能在压测下给出可信的容量与瓶颈结论。此阶段仅使用合成或匿名数据，不接收真实用户笔记。

### P2-1 租户模型与隔离

1. tenant → workspace 层级；所有表带 tenant 标识；Postgres 行级安全（RLS）作为最后防线；请求入口统一注入租户上下文。
2. 隔离范围覆盖：存储、查询、缓存键、job 队列、日志与 trace、导出文件。
3. 越权测试套件：租户 A 的凭证访问租户 B 的任何资源（含 job、日志、缓存）必须失败，并纳入 CI。

### P2-2 认证、授权与 key 管理

1. 账号体系（邮箱或 OIDC 登录二选一，先做最小可用）；角色与权限范围。
2. API key：签发、只存哈希与前缀、scope（可限定 workspace）、轮换、撤销、最近使用记录。
3. Vault Coach 侧：key 的存放位置要避免被 vault 同步或提交到仓库；key 失效时给出明确提示并回退 Lite。
4. 威胁模型文档：key 泄露、越权、重放、注入（笔记与 PDF 内容视为不可信输入）。

### P2-3 限流、配额与用量计量

1. 每租户请求限流；存储、chunk 数、查询次数、embedding 调用量的配额，在 API 层强制执行。
2. `usage_events` 计量表；套餐权益先以配置表达（尚不接支付）。
3. 记录每单位（chunk、查询、embedding）的真实成本，为 P3 定价提供数据。

### P2-4 公平调度与并发加固

1. 每租户 job 并发上限与公平调度，防止单租户的大批量任务饿死其他租户。
2. 连接池、超时、背压、模型提供方限速预算、幂等重试。
3. 压测（如 k6）：混合多租户负载，报告 p50/p95/p99、错误率、瓶颈定位与优化前后对比；至少做一次「噪声邻居」实验。

### P2-5 云部署与可观测

1. 以 IaC 描述环境；托管 Postgres、容器服务、对象存储（如需要）；先 staging 后 production；选欧盟区域。
2. OpenTelemetry trace、指标、告警；备份与恢复演练；migration 的灰度与回滚；CI/CD 流水线。
3. 成本控制：小规格实例、压测时开启、平时关闭、预算告警。

### P2-6 数据生命周期与隐私能力

1. 租户数据导出与硬删除：原文、chunk、向量、缓存、job 载荷同步清理，备份保留期写明。
2. 传输与静态加密、密钥与 secrets 管理、最小化审计日志。
3. 列出模型提供方（子处理方），支持租户选择可用的提供方；默认不将内容用于训练。

### P2 出口标准

- 越权测试套件全绿，且包含 job、缓存、日志的跨租户用例；
- 限流与配额在压测下生效，噪声邻居实验中其他租户的 p95 保持在目标范围内；
- 可脚本化部署到 staging，备份恢复演练通过；
- 删除一个租户后，各存储与缓存中无可识别残留（有验证脚本）；
- 产出容量与瓶颈报告、威胁模型、部署文档。

可写进简历的产出（数字需自行实测）：实现基于 RLS 的多租户隔离与越权测试套件；设计每租户限流、配额与公平调度；压测下 p95/p99 为 [X]，定位并优化 [瓶颈]，吞吐提升 [Y]；以 IaC 在 [云平台] 部署并实现可观测与备份恢复。

## 6. P3：付费、合规与发布

入口条件（先验证，再投入）：Vault Coach 中有一定数量的用户触碰过阈值；至少若干设计伙伴表达了付费意愿（可先用等待名单测试）；P2 出口标准已达成。条件不满足时，保留 P2 成果并回到需求验证，不推进计费。

### P3-1 套餐与计费

1. 套餐与权益映射（存储、chunk、查询、并发等），基于 P2 实测成本定价。
2. 选择支付方案（可比较是否由平台代收代缴税费，选型前请核对当前条款）；webhook 处理必须幂等。
3. 订阅状态机：试用、有效、逾期、取消；各状态下 Engine 的行为（只读、降级、保留期、宽限期）与数据保留策略。

### P3-2 合规与信任文档

1. 隐私政策、数据处理协议、子处理方清单、数据所在地、保留与删除时限、安全概述、事故响应流程。
2. 营业主体、税务、Impressum 等事项咨询专业人士；涉及欧盟用户的 GDPR 要求需要法律意见，不凭猜测。
3. Vault Coach 的 README 与设置页披露：云服务需要账号或付费、网络使用、数据发往何处、无账号时 Lite 仍可用（对应 Obsidian 社区插件政策的披露要求；提交前核对最新政策）。

### P3-3 Vault Coach 云接入体验

1. 设置页：账号与 key 状态、套餐与用量、同步范围、连接诊断；触碰阈值时的提示与引导。
2. 订阅过期、key 失效、限流、云端不可用时给出明确提示并回退 Lite；无静默上传，授权范围可随时修改与撤销。

### P3-4 受控 Agent 窄场景（可选，可提前到 P1 之后）

1. `AgentRun`、tool registry、policy gate（含租户与 workspace scope）、预算、取消、trace、评估集。
2. 只开放受限工具：`search_chunks`、`get_graph_projection`、`draft_*`；每步前校验 scope、top-K、depth、调用次数与 deadline；无证据返回结构化失败或 abstain。
3. 只生成草案；资料导入、大 job 启动、图谱治理等高影响动作由用户确认后调用确定性 API；不保存思维链。
4. 自动化评估：越权 scope、无来源、循环调用、超预算、模型不可用、取消、过期 revision。

### P3-5 设计伙伴 beta

少量设计伙伴试用，度量：连接成功率、检索收益、支持成本、单位成本与毛利、留存意愿；据此调整套餐与路线。

### P3 出口标准

- 订阅全状态（含逾期与取消）在测试环境走通，webhook 重放不重复计费；
- 合规文档与披露就绪并经专业人士审阅；
- Vault Coach 的云接入体验在 key 失效、订阅过期、服务不可用下均能回退 Lite；
- 设计伙伴 beta 给出单位成本与付费意愿数据；
- （若做 P3-4）Agent 评估集通过，且无高权限旁路。

## 7. 暂缓与移出主线

|   |   |   |
|---|---|---|
|事项|原阶段|处理|
|独立考试与训练（Exam Workbench、Assessment、mastery）|KE-6|暂缓：Vault Coach 已有考试；仅当设计伙伴明确需要独立训练时再启动|
|Career Agent Profile / Gap API|KE-8 部分|暂缓，不影响主线|
|完整 Graph Explorer|KE-4 部分|暂缓，P1 只做 API 与简单检查页|
|Electron Host、签名公证、Mac App Store、Tauri 对照|KE-9、KE-10|移出：对云服务与并发能力无贡献；仅在用户明确提出安装门槛时再评估|
|Elasticsearch、图数据库、专用向量库、消息队列|各阶段条件引入|仍须独立基准证明收益后才引入|

## 8. 风险与止损

- 范围膨胀：每个阶段设日历上限，到点即整理成果；未完成的条目回到第 7 节的暂缓列表，不顺延。
- 隐私与信任：本产品的卖点是本地优先；任何导致用户内容离开本机的功能，都必须显式授权、可撤销、可删除，并在文档中披露。
- 成本：云资源设预算告警；压测使用合成数据；定价以 P2 实测单位成本为准。
- 需求不确定：计费前先验证确有用户触碰阈值并愿意付费，否则只保留自托管与多租户技术成果。
- 工程质量：使用 AI 辅助编码时，契约、隔离规则、核心算法与测试用例由人审定；用依赖方向检查、越权测试和 CI 把约束固化。






---
下面是旧版本：
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
