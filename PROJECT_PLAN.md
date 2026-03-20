# Vault Coach — Project Plan

> 🌐 [English](#english-version) | [中文](#chinese-version)

---

<a id="chinese-version"></a>
## 项目计划（中文）

> 回到 README：[中文版](./README_CN.md) | [English](./README.md)

### 项目愿景

Vault Coach 的最终愿景是成为一个基于用户个人知识库的**智能面试准备助手**，能够从多个角色和维度帮助用户在自己的笔记中训练面试能力。整个项目分为三个插件阶段和一个独立应用阶段。

---

### ✅ Phase 1 — Advanced RAG 问答（已完成）

**目标**：构建一个高质量的本地知识库问答基础设施。

#### 已完成功能

- [x] **Markdown 解析与 Heading-aware Chunking**：按标题层级分 section，再按自然段聚合，超长段落字符窗口兜底
- [x] **TF-IDF 关键词检索**：倒排索引，含短语命中加分与标题命中加分
- [x] **向量检索**：Embedding 生成 + L2 归一化 + 余弦相似度检索
- [x] **混合检索（Hybrid）**：RRF（Reciprocal Rank Fusion）融合两路召回结果
- [x] **Query Rewrite**：LLM 将用户问题改写为更适合检索的查询，输出严格 JSON
- [x] **Rerank**：支持接入 /v1/rerank 风格外部服务，或使用本地启发式重排
- [x] **Prompt 构造**：含知识库范围、原始问题、检索查询、长期记忆、对话上下文、检索块
- [x] **流式输出**：基于 requestUrl 的伪流式，边接收边显示
- [x] **对话持久化**：本地 JSON 存储对话历史，重启后恢复
- [x] **长期记忆**：LLM 抽取稳定事实，跨会话注入，支持时效性排序与 LRU 淘汰
- [x] **增量索引同步**：监听 vault create/modify/delete/rename 事件，防抖+阈值双策略
- [x] **设置页 UI**：分 5 个 section，覆盖所有参数
- [x] **来源展示**：折叠式来源区域，点击跳转到对应文件位置

#### Phase 1 遗留问题（计划在 1.x 中修复）

- [ ] VIEW_TYPE_VAULT_COACH 常量值 typo 修复
- [ ] 流式输出迁移为真实 fetch + ReadableStream
- [ ] 向量索引重建进度反馈 UI

---

### 🔜 Phase 2 — 知识图谱增强检索（计划中）

**目标**：在 Phase 1 的 Advanced RAG 基础上，引入可选的知识图谱模块，提升对复杂关系型问题的回答能力。

#### 计划功能

- [ ] **实体与关系抽取**：
  - 使用本地 LLM 对 chunk 进行轻量级 NER（命名实体识别）
  - 抽取 (主体, 关系, 客体) 三元组
  - 维护内存中的轻量级图结构（邻接表）

- [ ] **图谱持久化**：
  - 将实体-关系三元组序列化为 JSON 文件
  - 支持增量更新（文件变化时只重算受影响节点）

- [ ] **智能查询路由**：
  - 分析用户问题类型：事实型（走 RAG）vs 关系型（走图谱）
  - 路由逻辑可由规则或轻量级分类器实现

- [ ] **图谱增强检索**：
  - 图谱路径查询：从问题实体出发，在图中做 BFS/DFS
  - 将图谱检索结果与 RAG 结果融合后进行 rerank

- [ ] **图谱可视化（可选）**：
  - 在右侧边栏展示简单的节点-边关系图

#### 技术约束

- 图谱仍为纯本地实现，不依赖 Neo4j 等外部服务
- 图谱模块为可选开关，关闭后退回纯 RAG 模式

---

### 🔜 Phase 3 — 智能体面试助手（计划中）

**目标**：在 RAG 与图谱的基础上，构建多角色 Agent 系统，让插件成为一个完整的面试准备训练平台。

#### 计划功能

- [ ] **多角色 Agent 架构**：
  - **导师 Agent**：基于知识库内容，制定个性化学习计划，识别知识盲区
  - **面试官 Agent**：模拟技术面试，根据用户回答动态调整问题难度
  - **评估 Agent**：对用户回答进行多维度评分（准确性、完整性、表达清晰度）

- [ ] **面试模拟流程**：
  - 选择面试类型（算法、系统设计、行为面试等）
  - 面试官根据知识库动态出题
  - 用户作答后获得即时反馈和参考答案

- [ ] **技能诊断与追踪**：
  - 统计用户在各知识域的答题正确率
  - 识别薄弱环节并推荐相关笔记复习
  - 生成学习进度报告

- [ ] **Agent 间协作**：
  - Agent 之间共享对话上下文与用户档案
  - 导师 Agent 可根据面试官 Agent 的评估结果调整学习计划

- [ ] **面试题库生成**：
  - 从知识库中自动提取和生成面试题
  - 支持用户手动标注和管理题库

---

### 🔜 Phase 4 — 独立应用（愿景）

**目标**：将三个阶段的功能打包为独立的前后端分离应用，突破 Obsidian 插件环境的限制。

#### 计划功能

- [ ] **独立后端**：
  - Node.js / Python 后端服务
  - 更完善的 RAG pipeline（支持更多文档格式）
  - 真实流式传输（SSE / WebSocket）

- [ ] **独立前端**：
  - React / Vue SPA，更丰富的 UI 组件
  - 类 ChatGPT 的多会话管理

- [ ] **语音交互**：
  - 语音输入（Whisper 本地 ASR）
  - 语音输出（本地 TTS）
  - 语音对话模拟面试模式

- [ ] **虚拟形象（Avatar）**：
  - 简单的 2D/3D 虚拟面试官形象
  - 与语音输出同步的口型动画

- [ ] **多用户 / 团队模式**（可选）：
  - 支持多人共享知识库进行协作备考

---

<a id="english-version"></a>
## Project Plan (English)

> Back to README: [中文版](./README_CN.md) | [English](./README.md)

### Vision

Vault Coach aims to become an **intelligent interview preparation assistant** built on top of the user's personal knowledge base, helping users train for interviews from multiple angles. The project is divided into three plugin phases and one standalone application phase.

---

### ✅ Phase 1 — Advanced RAG Q&A (Complete)

**Goal**: Build a high-quality local knowledge base Q&A infrastructure.

#### Completed Features

- [x] Markdown parsing with heading-aware chunking
- [x] TF-IDF keyword search with phrase/heading score bonuses
- [x] Vector search (embedding + L2 normalization + cosine similarity)
- [x] Hybrid retrieval with RRF fusion
- [x] Query rewrite via local LLM (JSON output, temperature=0)
- [x] Rerank: external /v1/rerank service or local heuristic fallback
- [x] Full prompt construction with scope, memories, context, and history
- [x] Pseudo-streaming output (requestUrl-based)
- [x] Conversation persistence (local JSON, restored on restart)
- [x] Long-term memory (LLM extraction, cross-session injection, LRU eviction)
- [x] Incremental index sync (debounce + threshold dual strategy)
- [x] Full settings UI (5 sections, all parameters configurable)
- [x] Collapsible source display with click-to-navigate

#### Phase 1 Remaining Tasks (planned for 1.x)

- [ ] Fix VIEW_TYPE_VAULT_COACH typo in constants.ts
- [ ] Migrate streaming to true fetch + ReadableStream
- [ ] Add progress feedback UI for vector index rebuild

---

### 🔜 Phase 2 — Knowledge Graph Enhanced Retrieval (Planned)

**Goal**: Add an optional knowledge graph module to improve answers on complex relational questions.

#### Planned Features

- [ ] **Entity & Relation Extraction**: Lightweight NER via local LLM, extract (subject, relation, object) triples
- [ ] **Graph Persistence**: Serialize entity-relation triples to JSON, support incremental updates
- [ ] **Smart Query Routing**: Classify queries as factual (→ RAG) or relational (→ graph traversal)
- [ ] **Graph-enhanced Retrieval**: BFS/DFS from query entities, fuse with RAG results before rerank
- [ ] **Graph Visualization (optional)**: Simple node-edge diagram in the sidebar
- Graph module is an opt-in toggle; disabling reverts to pure RAG mode

---

### 🔜 Phase 3 — Agentic Interview Assistant (Planned)

**Goal**: Build a multi-role Agent system on top of RAG + graph, turning the plugin into a full interview prep training platform.

#### Planned Features

- [ ] **Multi-role Agent Architecture**:
  - **Tutor Agent**: Personalizes learning plans, identifies knowledge gaps
  - **Interviewer Agent**: Simulates technical interviews, dynamically adjusts difficulty
  - **Evaluator Agent**: Multi-dimensional scoring (accuracy, completeness, clarity)
- [ ] **Interview Simulation Flow**: Select interview type → dynamic questions from knowledge base → instant feedback
- [ ] **Skill Tracking**: Accuracy statistics by domain, weakness identification, progress reports
- [ ] **Agent Collaboration**: Shared conversation context and user profile across agents
- [ ] **Question Bank Generation**: Auto-extract and generate interview questions from the knowledge base

---

### 🔜 Phase 4 — Standalone Application (Vision)

**Goal**: Package all features as an independent frontend/backend application.

#### Planned Features

- [ ] Independent backend (Node.js/Python, richer document support, true streaming via SSE/WebSocket)
- [ ] Independent frontend (React/Vue SPA, multi-session management)
- [ ] Voice interaction (Whisper ASR + local TTS + voice interview mode)
- [ ] Virtual avatar (2D/3D interviewer with lip-sync animation)
- [ ] Optional multi-user/team mode for collaborative exam prep
