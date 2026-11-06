---
tags: [KnowledgeEngine, 教程, FTS, BM25, HybridRetrieval]
parent: README.md
milestone: KE-3
---

# C2 FTS、BM25 与混合检索

## 学习目标

先建立可解释的词面召回，再理解为什么要和向量召回并行，而不是被 embedding 单独主导。

## 先理解

- Full-text search 将文本分析为 token，以倒排索引找候选；它擅长 API 名、专有术语、文件名、报错、短语；
- BM25 是常见词面排序信号；标题、heading、正文可有不同权重；
- 向量召回擅长语义近邻，词面召回擅长精确关键词；二者失败模式不同；
- Hybrid retrieval 先独立产生 lexical top-L 与 vector top-V，再去重/融合；RRF 按排名而不是不可比较的原始分数合并候选。

中文、英文、路径和代码不应使用同一 analyzer。是否引入 Elasticsearch 的中文 analyzer、highlight、RRF 见 [ES 加速层](../../03-Elasticsearch检索加速层.md)，前提是 benchmark 证明收益。

## Engine 落点

`mode: lexical | vector | hybrid` 是 RetrievalRequest 的显式字段。服务端限制 L/V/R/K，记录命中渠道、filter、索引版本和降级原因。RAG 只把最终少量 hit 交给模型。

## 动手练习

1. 准备“术语精确”“同义表达”“中英混合”“代码命令”查询集；
2. 分别运行 lexical、vector、hybrid，记录 top-K 差异；
3. 为标题/正文设置不同权重，验证没有 scope 泄露；
4. 在 Inspector 展示一个 hit 来自哪条渠道，而不是只显示总分。

## 通过检查

- 词面路径在模型/embedding 不可用时仍工作；
- 融合不会越过 filter；
- 开发者能针对查询质量调整数据或参数，而非盲目换模型。

## 下一步

阅读 [C3 Embedding、pgvector、HNSW 与 IVFFlat](./C3-EmbeddingpgvectorHNSW与IVFFlat.md)。
