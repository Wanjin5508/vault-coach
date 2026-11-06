---
tags: [KnowledgeEngine, 教程, Chunk, Provenance, Filter]
parent: README.md
milestone: KE-3
---

# C1 Section、Chunk、Locator 与 Metadata Filter

## 学习目标

理解 RAG 的最小可信单位不是“整篇笔记”，而是能回到来源、可被范围约束的 section/chunk。

## 先理解

- section 是文档的结构片段，如标题及其内容；chunk 是为检索/模型窗口切分的稳定语义窗口；
- chunk 必须带稳定 ID、source ID、revision、section ID、ordinal、文本、token count 与 locator；
- locator 是返回用户的证据桥梁：Markdown 标题/行范围或 PDF 页码，而不是内存数组下标；
- filter 先决定“用户有权/选择看什么”，再决定“什么相关”。workspace、source scope、folder、tag、type、active 都应下推。

## Engine 落点

`managed` 导入和 `connector` 同步都要生成统一的 section/chunk DTO。Retrieval API 强制 `workspaceId`，并将 scope filter 写入 query 和 trace；任何命中都要返回 locator 与 `sourceRevision`。

## 动手练习

1. 用一份匿名 Markdown 和一份 PDF fixture 生成 section/chunk 清单；
2. 为每个 chunk 在 Workbench 中实现“打开来源”的 locator；
3. 写 filter 测试：不同 workspace、删除 source、folder/tag 条件不可相互泄露；
4. 对一个超大文件检查每个 section 都能进入索引，而不是只取文件首段。

## 通过检查

- 每个 retrieval hit 可定位回真实来源；
- 过滤在检索之前发生；
- chunk 边界变化会通过 revision/模型版本被明确记录。

## 下一步

阅读 [C2 FTS、BM25 与混合检索](./C2-FTSBM25与混合检索.md)。
