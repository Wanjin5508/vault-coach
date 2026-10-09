---
tags:
  - 开发过程
  - VaultCoach
  - 里程碑8
  - KnowledgeEngine
  - Lite
status: implementation-complete-awaiting-manual-vault-validation
updated: 2026-07-25
depends-on:
  - 里程碑7-复习建议与学习计划开发记录.md
  - VaultCoach-Lite-后续开发路线图.md
related:
  - ../../knowledge-engine/01-需求规格.md
  - ../../knowledge-engine/02-架构设计.md
---

# 里程碑 8：Lite 发布加固与 Knowledge Engine 接缝开发记录

## 1. 目标与决策

本里程碑不实现 Docker 服务，也不让插件开始联网。交付的是一个安全的**协议边界**：未来服务实现可以接入，但默认 Vault Coach Lite 仍是唯一运行路径。这样可以避免“Engine 未安装导致 Ask/Exam 不可用”、自动上传 Vault、或在 UI 中散落未经审计的 `fetch` 调用。

## 2. 实现结果

| 项目 | 实现 | 结果 |
|---|---|---|
| Engine port | `src/app/engine/knowledge-engine-types.ts` | 定义 protocol version、capability、availability、diagnostics 与 refresh contract。 |
| Lite fallback | `LiteEngineClient` | 默认 `mode: lite`，不含 endpoint、不调用网络、不传输数据；即使未来 Local 故障也可作为明确回退。 |
| Application seam | `KnowledgeEngineApplicationApi`、容器装配 | Presentation 只能读取 availability/diagnostics 或请求 refresh，不能直接连接任意服务。 |
| V1 DTO adapter | `knowledge-engine-dto-adapter.ts` | 构建 revisioned、幂等的 `KnowledgeChangeV1`；校验 delete、授权正文、confirmed/user graph relation、Assessment 最小证据和 profile consent。 |
| 隐私边界 | adapter + 文档 | 不存在 Vault 全量默认导出、聊天/密钥导出或后台同步路径。 |
| 性能/容量 | 复用既有 `graph-capacity` 与有界 Graph/ANN 策略 | 300/500 语义窗口策略和 Lite 降级保持生效；Engine 文档定义后续批任务、增量同步和服务端有界查询。 |

## 3. 传输边界

`KnowledgeChangeV1` 统一携带 `schemaVersion`、`protocolVersion`、`workspaceId`、`sourceId`、单调 `revision`、operation、hash 和时间。幂等键固定为 `workspaceId:sourceId:revision`。

允许的未来类别只有：

1. `content-change`：正文只能在 `contentAuthorized: true` 时出现；
2. `confirmed-graph-facts`：关系 trust 只能是 `confirmed` 或 `user`；
3. `assessment-evidence`：只含 event/concept/标准化分数/时间/revision，不含答案、rubric 或笔记；
4. `knowledge-profile-candidate`：必须有显式 `consent: granted`。

`delete` 事件不携带 payload。接缝不会读取 Vault 或生成 change；真正的选择范围、同步队列、服务健康协商和 Docker 部署属于独立 Knowledge Engine 的 KE-0 至 KE-7。

## 4. 已建立的 Engine 设计资料

在 `kb/knowledge-engine/` 新建：

- `01-需求规格.md`：用户价值、FR/NFR、隐私、依赖建议与退出标准；
- `02-架构设计.md`：API/DTO、Postgres + pgvector、HNSW/IVFFlat 选择、图邻接索引、作业队列、缓存、loopback 安全和插件性能路径。

首版建议从 PostgreSQL + pgvector、Postgres durable job table、OpenAPI/JSON Schema 和 Docker Compose 开始。Neo4j、Qdrant/Milvus、Redis/Kafka 不是预设依赖，只有真实基准证明 pgvector/关系邻接方案无法满足 p95、过滤或运维成本时才评估。

## 5. 验证

新增测试覆盖：

1. Lite client 是可用 fallback，`networkRequestsMade` 恒为 0，取消不会隐式依赖服务；
2. DTO 可稳定克隆数组、生成幂等键，并拒绝未授权正文、automatic relation 与带 payload 的 delete；
3. Application facade 暴露 Engine seam，但 Progress 等 Lite API 不依赖 Engine。

实施完成后的自动化命令：

~~~text
npm run lint
npm run build
npm test -- --run   # 54 files, 212 tests passed
git diff --check
~~~

## 6. 后续手工验收与 KE 启动条件

1. 在未安装 Docker/Engine 的 Vault 中验证 Ask、Exam、Learning Map、Mastery、Recommendation、历史和导出均完整可用；
2. 验证 301–500 与 >500 语义窗口容量提示不误导为“Engine 已连接”；
3. KE-0 开始前收集匿名基准：全量/增量索引时间、semantic build 时间、内存、图首屏、子图 p95、磁盘和取消/恢复时间；
4. 只有完成契约 fixture、loopback 安全、迁移、删除/备份和 Lite 回退演练后，才允许实现真正 Local client。
