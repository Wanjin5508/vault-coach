---
tags:
  - KnowledgeEngine
  - 架构
  - 需求
  - VaultCoach
status: active-design
updated: 2026-07-26
---

# Knowledge Engine 开发文档

本目录用于独立的 **Knowledge Engine Local** 开发。它既可以作为用户通过 Docker 在本机启动的知识训练工作台，也可以作为 Vault Coach 与 AI Career Agent 的可选协同服务；三者均可独立运行。

阅读顺序：

1. [开发者能力地图](./00-开发者能力地图.md)：说明项目对开发者的能力要求、学习路线和可展示产物；
2. [需求规格](./01-需求规格.md)：说明用户价值、边界、功能、隐私和验收标准；
3. [架构设计](./02-架构设计.md)：说明协议、数据、存储、索引、任务、性能和部署实现；
4. [Elasticsearch 检索加速层](./03-Elasticsearch检索加速层.md)：说明 ES 作为 PostgreSQL 之后的全文、向量和混合检索投影；
5. [独立工作台、知识训练与 Agent 设计](./04-独立工作台、知识训练与Agent设计.md)：说明 GUI、独立/Connector 工作区、RAG、考试、受控 Agent 与可验证性；
6. [语言、客户端与桌面发行策略](./05-语言、客户端与桌面发行策略.md)：冻结 TypeScript/React/Electron、Docker、直装 macOS 与 Mac App Store 后置策略；
7. [开发教程](./开发教程/README.md)：按能力树分层讲解完成 Engine 所需的后端、数据、检索、图谱、可靠性、Workbench 与 Agent 技术；
8. [Knowledge Engine Local 路线图](../v1.3.4后续开发日志/开发规划与过程记录/KnowledgeEngine-Local-后续开发路线图.md)：按 KE-0 至 KE-9 推进独立平台与 Connector；KE-10 仅作条件性发行形态评估。

当前 Vault Coach 只实现版本化的 **Lite Engine seam**。默认模式仍是完全本地、无网络、无 Docker 依赖的 Lite；服务不存在、停止或协议不兼容时，Ask、Exam、Learning Map、Mastery 和 Recommendation 必须继续可用。Engine 的 GUI 是服务自身的第一个客户端，不依赖 Obsidian；它也不授权 Career Agent 读取整个 Vault，跨项目只通过用户明确授权的版本化 DTO 协同。
