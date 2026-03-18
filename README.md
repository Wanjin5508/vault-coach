
# Vault Coach

<p align="right">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

A local RAG-style Obsidian plugin for vault knowledge retrieval, question answering, and interview practice, powered by Ollama.

---

## English

<a id="english"></a>

### Overview

**Vault Coach** is a local-first Obsidian plugin designed for knowledge retrieval and interactive Q&A inside your vault.

It starts from a lightweight non-LLM retrieval backbone and gradually evolves into an advanced local RAG pipeline with:

- query rewrite
- vector retrieval
- hybrid retrieval
- reranking
- prompt/context optimization

The long-term goal is to turn your vault into a **local knowledge assistant and interview practice environment** without relying on external cloud services.

---

### Current Status

The project is currently planned and documented in **4 stages**.

**Implemented up to Stage 2:**
- non-LLM retrieval backbone
- advanced local RAG pipeline
- markdown-formatted assistant responses

**Planned next:**
- graph-enhanced retrieval
- lightweight knowledge graph exploration
- optional ontology layer for domain vaults
- interview mode orchestration

---

### Key Features

#### Implemented Features (up to Stage 2)

- **Extended settings panel**
  - configure plugin behavior and local model-related options
  - define retrieval scope and response preferences

- **Right sidebar chat view**
  - interactive assistant panel inside Obsidian
  - supports local Q&A workflow in the vault

- **Vault / folder scope scanning**
  - scan notes from the whole vault or selected folders
  - limit retrieval to user-defined ranges

- **Markdown chunking**
  - split notes into retrieval-friendly chunks
  - preserve source-note relationships for traceability

- **Keyword retrieval**
  - lightweight lexical retrieval without vector dependency
  - provides a usable local knowledge Q&A baseline

- **Source folding and jump-to-note**
  - show answer sources in collapsible form
  - jump back to the original note / section

- **Query rewrite**
  - optimize the user query before retrieval
  - improve recall for shorthand, vague, or noisy questions

- **Embedding / vector retrieval**
  - use embeddings for semantic search
  - retrieve relevant chunks beyond literal keyword overlap

- **Hybrid merge**
  - combine keyword retrieval and vector retrieval results
  - balance precision and semantic recall

- **Rerank**
  - rerank retrieved candidates before generation
  - improve final context quality for the LLM

- **Prompt and context construction optimization**
  - assemble cleaner, better-structured context
  - reduce noise and improve answer grounding

- **Markdown-formatted assistant output**
  - render answers as Markdown instead of plain text
  - better readability for lists, code blocks, headings, and references

---

### Retrieval Pipeline

Current pipeline (up to Stage 2):

`User Query`
→ `Query Rewrite`
→ `Keyword Retrieval + Vector Retrieval`
→ `Hybrid Merge`
→ `Rerank`
→ `Prompt / Context Builder`
→ `Local LLM Generation`
→ `Markdown Answer + Source Display`

This design keeps the system modular and allows each retrieval component to evolve independently.

---

### Project Structure

```text
src/
  main.ts
  settings.ts
  view.ts
  types.ts
  constants.ts
styles.css
````

---

### Development Roadmap

## Stage 1: Build the non-LLM backbone first

* [x] Extend settings
* [x] Implement right sidebar view
* [x] Implement vault/folder scope scanning
* [x] Implement markdown chunking
* [x] Implement keyword retrieval
* [x] Implement source folding and jump

At this point, the plugin already becomes a **working local knowledge Q&A plugin without vector search**.

---

## Stage 2: Add Advanced RAG

* [x] Add query rewrite
* [x] Add embedding / vector retrieval
* [x] Add hybrid merge
* [x] Add rerank
* [x] Optimize prompt and context construction
* [x] Improve assistant output rendering with Markdown

This stage upgrades the plugin from a lexical retriever into a more complete **local advanced RAG assistant**.

---

## Stage 3: Explore more fine-grained retrieval modes

### Layer 1: Weak graph enhancement

Leverage the existing vault structure directly:

* note ↔ wikilink note
* note ↔ heading
* note ↔ tag
* note ↔ folder / topic
* chunk ↔ source note

Then apply **graph-aware expansion / rerank** after retrieval.

This layer has the highest cost-performance ratio.

### Layer 2: Lightweight knowledge graph

Extract chunk-level signals such as:

* entities
* synonyms
* co-occurrence relations
* citation / reference relations
* topic communities

Then use them for:

* query expansion
* neighborhood expansion recall
* multi-hop candidate completion
* path-based explanation

At this stage, a strict ontology is still unnecessary.

### Layer 3: Optional ontology overlay

Enable only for specialized vaults, such as:

* high-voltage test equipment manuals
* technical specifications
* experimental procedures
* regulations / contracts
* medical knowledge bases

Then define:

* concept hierarchies
* relation schema
* synonym normalization
* alias mapping
* rule-based reasoning

---

## Stage 4: Interview Mode

* [ ] Question generation
* [ ] Conversation state machine
* [ ] User answer evaluation
* [ ] Next question / finish interview / review summary

**Why this comes last:**
Interview mode is not infrastructure.
It is a higher-level orchestration layer built on top of retrieval, ranking, grounding, and generation.

---

### Long-Term Vision

Vault Coach is intended to evolve from:

**local note retrieval tool**
→ **advanced local RAG assistant**
→ **graph-enhanced knowledge navigator**
→ **interactive interview and study coach**

---

### Tech Direction

* **Local-first**
* **Obsidian-native workflow**
* **Ollama-powered generation**
* **Modular retrieval architecture**
* **Extensible toward graph and ontology reasoning**

---

## 中文

<a id="中文"></a>

### 项目简介

**Vault Coach** 是一个面向 Obsidian 的本地化 RAG 风格插件，用于在你的 vault 中进行知识检索、问答和面试练习。

它的设计思路是：
先搭建一个轻量的**非 LLM 检索骨架**，再逐步演进为一个完整的**本地 Advanced RAG 系统**，并在后续继续探索图增强检索、轻量知识图谱以及面试模式。

项目长期目标是让你的 vault 成为一个：

* 本地知识助手
* 学习辅助工具
* 面试练习环境

并尽量减少对外部云服务的依赖。

---

### 当前状态

当前项目总共规划为 **4 个阶段**。

**截至第二阶段，已经实现：**

* 非 LLM 检索骨架
* Advanced RAG 检索链路
* Markdown 格式回答显示

**后续待实现：**

* 图增强检索
* 轻量知识图谱探索
* 面向专业领域 vault 的本体层
* 面试模式编排

---

### 核心功能

#### 已实现功能（截至第二阶段）

* **扩展 settings 设置面板**

  * 支持插件行为配置
  * 支持本地模型与检索相关参数配置
  * 支持回答偏好与检索范围控制

* **右侧边栏视图**

  * 在 Obsidian 内提供独立 assistant 面板
  * 支持在 vault 中进行本地问答交互

* **vault / folder 范围扫描**

  * 支持扫描整个 vault 或指定文件夹
  * 支持将检索范围限制在用户指定区域内

* **Markdown chunking**

  * 将笔记切分为适合检索的 chunk
  * 保留 chunk 与源笔记之间的可追溯关系

* **关键词检索**

  * 在不依赖向量库的前提下实现词法召回
  * 作为可运行的本地知识问答基础版本

* **来源折叠展示与跳转**

  * 支持对答案来源进行折叠展示
  * 支持跳转回原始笔记或相关片段

* **Query Rewrite**

  * 在检索前对用户问题进行改写
  * 提高对模糊问题、简写表达和不完整提问的召回能力

* **Embedding / Vector Retrieval**

  * 引入向量化语义检索
  * 能够召回关键词不完全重合但语义相关的内容

* **Hybrid Merge**

  * 将关键词检索与向量检索结果融合
  * 平衡精确匹配与语义召回能力

* **Rerank**

  * 对候选检索结果进行重排序
  * 提升最终送入 LLM 的上下文质量

* **Prompt 与上下文构造优化**

  * 对检索结果进行更合理的上下文组织
  * 降低噪声，提高回答的 grounded 程度

* **Assistant 回答按 Markdown 渲染**

  * 回答不再只是纯文本
  * 更适合展示标题、列表、代码块、引用和结构化内容

---

### 当前检索链路

截至第二阶段，当前链路为：

`用户问题`
→ `Query Rewrite`
→ `关键词检索 + 向量检索`
→ `Hybrid Merge`
→ `Rerank`
→ `Prompt / Context Builder`
→ `本地 LLM 生成`
→ `Markdown 回答 + 来源展示`

这种设计是模块化的，后续便于替换或增强每一个环节。

---

### 项目结构

```text
src/
  main.ts
  settings.ts
  view.ts
  types.ts
  constants.ts
styles.css
```

---

### 开发路线图

## 第一阶段：先把“非 LLM 的骨架”搭起来

* [x] 扩展 settings
* [x] 实现右侧边栏 view
* [x] 实现 vault/folder 范围扫描
* [x] 实现 markdown chunking
* [x] 实现关键词检索
* [x] 实现来源折叠展示和跳转

做到这一步，你就已经有一个**可运行的无向量版本地知识问答插件**了。

---

## 第二阶段：再接 Advanced RAG

* [x] 接入 query rewrite
* [x] 接入 embedding / vector retrieval
* [x] 接入 hybrid merge
* [x] 接入 rerank
* [x] 优化 prompt 和上下文构造
* [x] 优化 assistant 回答的 Markdown 显示效果

做到这一步，插件就从一个基础检索器升级成了一个更完整的**本地 Advanced RAG 助手**。

---

## 第三阶段：更精细化的检索模式探索

### 第 1 层：弱图增强

直接利用 vault 现成结构：

* note ↔ wikilink note
* note ↔ heading
* note ↔ tag
* note ↔ folder/topic
* chunk ↔ source note

然后在检索后做一个 **graph-aware expansion / rerank**。
这一层通常是性价比最高的增强方式。

### 第 2 层：轻量知识图谱

在 chunk 级别抽取：

* 实体
* 同义词
* 共现关系
* 引用关系
* 主题社区

然后用于：

* query expansion
* 邻域扩展召回
* 多跳候选补全
* 路径解释

在这一层，还不需要正式引入 ontology。

### 第 3 层：可选本体覆盖层

只对特定专业 vault 启用，例如：

* 高压测试设备手册
* 技术规范
* 实验流程
* 法规 / 合同库
* 医疗知识库

这时再定义：

* 概念层级
* 关系 schema
* 同义词规范
* 别名映射
* 规则推理

---

## 第四阶段：最后上面试模式

* [ ] 题目生成
* [ ] 会话状态机
* [ ] 用户回答评估
* [ ] 下一题 / 结束面试 / 复盘总结

这样做的原因是：
**面试模式不是基础设施，而是构建在基础设施之上的高级编排功能。**

---

### 长期演进方向

Vault Coach 的目标演进路径是：

**本地笔记检索工具**
→ **本地 Advanced RAG 助手**
→ **图增强知识导航器**
→ **交互式面试与学习教练**

---

### 技术方向

* **本地优先**
* **Obsidian 原生工作流**
* **Ollama 驱动生成**
* **模块化检索架构**
* **可扩展到图推理与本体增强**



