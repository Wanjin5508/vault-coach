---
tags:
  - VaultCoach
  - RAG
  - 检索
  - 向量检索
---

# RAG 原理与检索实现

## 本项目的 RAG Pipeline

Vault Coach 的问答流程可以概括为：

1. 扫描 Markdown 文件。
2. 按标题和自然段切分 chunk。
3. 建立关键词倒排索引。
4. 可选生成 embedding 并建立向量索引。
5. 用户提问后进行 query rewrite。
6. 根据当前模式进行 keyword、vector 或 hybrid 召回。
7. 对候选 chunk 做 rerank。
8. 构造包含上下文、长期记忆和对话摘要的 prompt。
9. 调用模型生成回答。
10. 返回 Markdown 回答和可点击来源。

## 切块策略

项目采用 heading-aware chunking：先识别 Markdown 标题层级，形成 `headingPath`，再按自然段聚合。如果段落超过 chunk size，则用字符窗口切分。chunk 的 searchable text 会包含文件名、标题路径和正文，提升检索命中率。

## 检索策略

- 关键词检索：倒排索引 + TF-IDF + 短语命中加分 + 标题命中加分。
- 向量检索：embedding 后 L2 归一化，检索时用点积计算余弦相似度。
- Hybrid：关键词和向量两路召回后，用 RRF 融合排名。
- Rerank：优先使用外部 `/v1/rerank` 服务，失败或未配置时使用本地启发式重排。

## 面试问答

### 1. RAG 是什么？为什么这个项目需要 RAG？

RAG 是 Retrieval-Augmented Generation，先从知识库检索相关材料，再让模型基于材料生成答案。这个项目需要 RAG，是因为用户问的是个人笔记内容，LLM 本身不知道用户 vault 里的知识。直接问模型会幻觉，RAG 可以把回答约束在检索上下文中。

### 2. 为什么不把整个 vault 一次性塞进 prompt？

整个 vault 太大，会超过上下文窗口，也会让模型难以聚焦。RAG 的关键是只选取和问题最相关的少量 chunk。这样既降低 token 成本，也提升回答可控性和来源可追溯性。

### 3. 为什么使用 heading-aware chunking？

Markdown 笔记天然有标题层级。按标题切 section 能保留语义边界，避免把不同主题混在一个 chunk 里。标题路径还可以放进 searchable text 和 prompt，帮助关键词检索、rerank 和模型理解上下文位置。

### 4. 关键词检索怎么适配中文？

项目 tokenizer 对英文和数字按词切分，对中文同时拆成单字和双字 token。这样不依赖复杂分词器，也能提升中文词语级命中。比如“向量检索”会产生单字 token 和“向量”“量检”“检索”等双字 token。

### 5. 向量检索为什么要做 L2 归一化？

归一化后向量长度为 1，两个向量的点积就等价于余弦相似度。这样可以避免向量长度影响相似度判断，检索时也更简单。项目在写入 embedding 和查询时都会归一化。

### 6. Hybrid 检索为什么用 RRF？

关键词分数和向量相似度量纲不同，直接相加不合理。RRF 只依赖排名，用 `1 / (k + rank)` 把不同召回通道的排名融合，能减少分数归一化问题。它适合轻量级、多路召回融合。

### 7. Rerank 在这里解决什么问题？

召回阶段负责尽量找全，但排序未必最佳。Rerank 用更细的相关性判断把最相关 chunk 排到前面，减少无关上下文进入 prompt。项目支持远程 rerank，同时提供本地启发式 fallback，避免外部服务失败导致功能不可用。

### 8. 如果 embedding 模型被删除或不可用，系统如何降级？

向量召回失败时，`retrieveCandidates()` 会捕获错误并回退到关键词检索。Hybrid 模式中如果向量失败，也会继续使用关键词召回。这样用户不会因为 embedding 环境问题完全无法问答。

### 9. Query rewrite 的价值是什么？

用户问题可能口语化、含指代或不包含笔记中的关键词。Query rewrite 用模型把问题改写为更适合检索的查询，提升召回质量。项目要求输出 JSON，并保留原始问题和改写查询，便于调试。

### 10. 如何防止 RAG 回答幻觉？

prompt 明确要求模型严格基于检索上下文，信息不足时说明不足；来源由插件单独展示，模型不要伪造来源编号；最终只把 rerank 后的少量 chunk 注入 prompt。这些措施不能完全消除幻觉，但能显著约束模型行为。

