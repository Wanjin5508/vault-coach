<p align="right">
  <a href="README.md">English</a> | 中文
</p>

# Vault Coach

一个面向 Obsidian 的本地化 RAG 风格插件，用于 vault 内的知识检索、问答和面试练习，由 Ollama 驱动。
![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)
![Version](https://img.shields.io/badge/version-0.0.1-1E90FF)
![Local RAG](https://img.shields.io/badge/Local-RAG-10b981)
![Ollama](https://img.shields.io/badge/Powered%20by-Ollama-111827)
[![License](https://img.shields.io/badge/License-MIT-84cc16)](./LICENSE)
---

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

## 第一阶段：先把"非 LLM 的骨架"搭起来

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
