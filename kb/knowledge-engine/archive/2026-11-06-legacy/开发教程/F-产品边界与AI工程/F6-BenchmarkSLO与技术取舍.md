---
tags: [KnowledgeEngine, 教程, Benchmark, SLO, Architecture]
parent: README.md
milestone: KE-9
---

# F6 Benchmark、SLO 与技术取舍

## 学习目标

用可重跑指标决定是否增加复杂组件，而不是因为“技术先进”或单次演示速度快就引入新基础设施。

## 先理解

- benchmark 固定语料、查询、过滤比例、更新比例、硬件和模型版本；
- SLI 是测量值，如 p95、Recall@K、失败率、恢复时间；SLO 是面向产品的目标，如“检索 p95”“取消响应时间”；
- 需要同时测全量导入、1% 更新、delete/rename、模型故障、重启、图投影、考试生成和 Agent 工具调用；
- 新组件有收益也有安装、资源、备份、升级、排障和许可成本；
- PostgreSQL + pgvector 是基线。ES、Neo4j、专用向量库、消息队列只有在同一基准中有明确净收益才进入可选 profile。

## Engine 落点

KE-9 发布硬件建议、Lite/Engine 选择标准、Docker 诊断、备份恢复和设计伙伴报告。结果不仅服务性能，也验证独立 Workbench、Connector fallback 与 Agent policy 是否值得维护。

## 动手练习

1. 为小/中/大匿名 workspace 定义 workload 和成功阈值；
2. 输出 Lite、Postgres 基线、可选 ES 的质量/延迟/资源表；
3. 做一次容量回归：数据增长后 p95、Recall、磁盘、恢复时间是否仍达标；
4. 写“采用/不采用 ES 或 Neo4j”的 ADR，列成本、替代方案和回滚路径；
5. 将关键指标展示在安全的 Workbench diagnostics 中。

## 通过检查

- 每个基础设施决策可由数据解释；
- SLO 失败会触发可操作诊断，而非沉默变慢；
- Engine 的复杂度始终与用户得到的独立训练/性能收益相匹配。

## 下一步

回到 [开发教程总览](../README.md)，按实际里程碑选择下一轮需要深入的页面。
