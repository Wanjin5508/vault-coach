---
tags: [KnowledgeEngine, 教程, Embedding, pgvector, ANN]
parent: README.md
milestone: KE-3
---

# C3 Embedding、pgvector、HNSW 与 IVFFlat

## 学习目标

理解向量是模型版本相关的检索表示，ANN 是性能/召回取舍，而不是“语义事实”。

## 先理解

- embedding 将 chunk/query 映射到同一维度向量空间；不同模型或维度不能直接混用；
- exact search 扫描候选并精确排序，适合小范围与评估；ANN 以少量召回损失换取速度；
- HNSW 通常查询性能/召回较好，但构建和内存成本更高；IVFFlat 构建较快、内存较少，但需选择 lists/probes；
- 过滤会影响 ANN 的召回，必须在真实 scope 上评测；小范围可能直接 exact 更好。

pgvector 的 HNSW/IVFFlat 参数、索引构建与 recall 评估参见 [pgvector 官方 README](https://github.com/pgvector/pgvector)。

## Engine 落点

embedding 表至少含 `chunkId`、`workspaceId`、`modelVersion`、dimension、revision。生成 embedding 必须走 job；查询必须带 workspace/scope filter、top-K 上限和 index/model version。相似度只作为 retrieval/candidate 信号。

## 动手练习

1. 对匿名小语料实现 exact top-K，作为真值基线；
2. 分别建立 HNSW 与 IVFFlat，记录 build time、磁盘、p95、Recall@K；
3. 改变 HNSW 搜索预算或 IVFFlat probes，观察召回/延迟曲线；
4. 用 `EXPLAIN (ANALYZE, BUFFERS)` 检查查询计划；
5. 模拟模型版本变化，验证旧向量不会与新向量混排。

## 通过检查

- 选择索引有测量依据；
- 任何向量命中都可追溯模型和 revision；
- 不会把向量分数直接写入 confirmed relation 或 mastery。

## 下一步

阅读 [C4 检索评估、基准与 Inspector](./C4-检索评估基准与Inspector.md)。
