---
tags:
  - KnowledgeEngine
  - 教程
  - MOC
  - 开发者学习路径
status: living-curriculum
updated: 2026-07-26
parent:
  - ../00-开发者能力地图.md
related:
  - ../01-需求规格.md
  - ../02-架构设计.md
  - ../04-独立工作台、知识训练与Agent设计.md
  - ../05-语言、客户端与桌面发行策略.md
---

# Knowledge Engine 开发教程

这是《[00 开发者能力地图](../00-开发者能力地图.md)》的教程化展开。目标不是让开发者先背完所有框架，而是在每个 Engine 里程碑开始前，先理解该阶段所需的概念、边界、最小实现和验证方法；项目推进时再回到相应页面深入。

## 如何使用这套教程

每篇教程遵循同一节奏：

1. **先理解**：知道它解决什么问题、哪些概念不能混淆；
2. **再映射项目**：找到它在 Engine 的 domain、API、job 或 GUI 中的职责；
3. **动手验证**：用匿名 fixture、日志、SQL 或 API 测试确认行为；
4. **通过检查**：达到可进入下一篇的最小标准；
5. **按需深入**：只在真实瓶颈出现时阅读官方文档和高级主题。

不要跳过 B（revision/事实边界）、E（job/恢复）和 F（隐私/Agent policy）。它们决定 Engine 是否可靠；单纯让 RAG 或图谱“跑起来”不等于完成项目。

## 能力树导航

| 分支 | 学习问题 | 对应 Engine 阶段 |
| --- | --- | --- |
| [A 后端契约与服务基础](./A-后端契约与服务基础/README.md) | 如何提供可启动、可兼容、可诊断的本地 API | KE-0、KE-1 |
| [B 数据与一致性](./B-数据与一致性/README.md) | 如何让导入、同步、删除和重放不丢/不重/不覆盖 | KE-0、KE-2 |
| [C 搜索与向量检索](./C-搜索与向量检索/README.md) | 如何构建带范围、来源和基准的高性能 RAG | KE-3 |
| [D 图谱与知识治理](./D-图谱与知识治理/README.md) | 如何区分候选与事实，并有界地查询图谱 | KE-4 |
| [E 作业与可靠性](./E-作业与可靠性/README.md) | 如何让重计算可进度、取消、重试和恢复 | KE-5 |
| [F 产品边界与 AI 工程](./F-产品边界与AI工程/README.md) | 如何做好 React Workbench、Electron Host、考试、Connector、隐私和受控 Agent | KE-6 至 KE-9 |

## 推荐学习顺序

```text
A1 → A2 → A3 → A4
         ↓
B1 → B2 → B3 → B4
         ↓
C1 → C2 → C3 → C4
         ↓
D1 → D2 → D3 → D4
         ↓
E1 → E2 → E3 → E4
         ↓
F4 → F2 → F3 → F5 → F1 → F6
```

在项目实际推进中，建议按里程碑切换阅读：KE-1 先完成 A 与 F4；KE-2 重点读 B 与 F2；KE-3 与 C；KE-4 与 D；KE-5 与 E；KE-6 读 F3，KE-7 读 F5，KE-8 读 F1，最后以 F6 进入发布验证。

## 全局实践约定

- 使用**匿名 fixture**，不把私人 Vault、密钥、完整聊天记录放入测试或截图；
- 每项接口都返回 request ID、版本、范围和可解释错误；
- 所有大计算放入 job，所有用户可见结论尽量携带来源和 revision；
- `managed` 与 `connector` workspace 的事实边界必须显式验证；
- Agent 只能通过工具白名单调用有限 API，高影响动作必须经确定性 workflow 与用户确认；
- 每完成一个小节，就把“通过检查”的证据写入项目测试、基准或 Workbench Inspector，而不是停留在笔记里。

## 权威资料入口

- [Fastify documentation](https://fastify.dev/docs/latest/)：HTTP、schema、生命周期与日志；
- [PostgreSQL documentation](https://www.postgresql.org/docs/current/)：事务、锁、索引与查询计划；
- [pgvector README](https://github.com/pgvector/pgvector)：向量类型、HNSW、IVFFlat、评估与调优；
- [Docker Compose documentation](https://docs.docker.com/compose/)：本地服务编排、volume 与 healthcheck；
- [Elasticsearch 检索加速层](../03-Elasticsearch检索加速层.md)：仅当基准证明需要时阅读；
- [Engine 独立工作台、训练与 Agent 设计](../04-独立工作台、知识训练与Agent设计.md)：本教程的产品边界来源。
- [语言、客户端与桌面发行策略](../05-语言、客户端与桌面发行策略.md)：TypeScript/React/Electron 基线、Docker 与 macOS 发行取舍；
- [Electron documentation](https://www.electronjs.org/docs/latest/)：桌面 Host 的进程模型、生命周期与签名资料。
