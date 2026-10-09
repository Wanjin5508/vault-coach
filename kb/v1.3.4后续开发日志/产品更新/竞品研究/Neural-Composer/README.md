---
tags: [VaultCoach, 竞品研究, NeuralComposer, LightRAG, GraphRAG]
reviewed: 2026-09-20
status: source-reviewed
---

# Neural Composer 与 LightRAG：源码导读

> 研究对象：[Obsidian 社区页面](https://community.obsidian.md/plugins/neural-composer) · [Neural Composer 源码](https://github.com/oscampo/obsidian-neural-composer) · [LightRAG 源码](https://github.com/HKUDS/LightRAG) · [LightRAG 论文](https://arxiv.org/html/2410.05779v3)。2026-09-20 查阅公开页面和 GitHub `main`；上游继续变化时，应重新核对。未运行插件、Python 服务或真实 Vault 基准。

## 阅读顺序

1. [01｜Neural Composer 的实际实现](01-Neural-Composer的实际实现.md)：从 Obsidian 事件、上传 API 到问答返回值，区分插件与 LightRAG 服务。
2. [02｜LightRAG 原理与检索路径](02-LightRAG原理与检索路径.md)：实体关系抽取、双层检索、五种查询模式及其成本。
3. [03｜检索优化、受欢迎原因与 Vault Coach 借鉴](03-检索优化与产品分析.md)：可验证的优化路径、竞争力推断和适配边界。

## 一页结论

Neural Composer 的核心产品体验是“在 Obsidian 中使用 LightRAG”：用户选择笔记或文件夹摄入、配置本地或远端 Python 服务、查看处理状态和图、在聊天中获得带来源的回答。其图索引和 `local/global/hybrid/naive/mix` 检索由 LightRAG 服务完成；插件并没有在 TypeScript 中重写整套 LightRAG。证据：[插件 README](https://github.com/oscampo/obsidian-neural-composer#readme)、[插件 `ragEngine.ts`](https://github.com/oscampo/obsidian-neural-composer/blob/main/src/core/rag/ragEngine.ts)、[LightRAG 官方模式说明](https://github.com/HKUDS/LightRAG#selecting-query-modes)。

社区页面展示了下载量和功能介绍，但下载数不等于活跃用户数，也不能单独证明 Graph RAG 比其他方案效果更好。“受欢迎原因”在第 03 篇中作为**基于功能与体验的推断**陈述，不作为实测结论。

## 研究边界

- **论文机制**解释 LightRAG 的设计思想；**现行仓库**增加了 `mix`、重排、多种解析器等功能，不能把后续工程特性倒写成原论文实验结果。
- **社区页面**是功能宣称；**源码**用于核对插件如何调用服务；**本仓库代码**用于判断 Vault Coach 当前已具备什么。三者证据等级不同。
- GitHub `main` 与社区页面会变化；本文保留直达源码文件的链接，未锁定 commit，因此数值、默认值和接口应在实施前复核。
- 本目录只整理知识与候选实验，未修改 Vault Coach 的检索、图谱或隐私策略。
