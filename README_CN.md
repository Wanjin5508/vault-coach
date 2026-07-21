# Vault Coach

> 语言版本：[English](./README.md) | 中文

Vault Coach 可以把你的 Obsidian vault 变成本地优先的学习和研究助手。你可以直接向 Markdown 笔记和文本型 PDF 提问，查看可点击来源，也可以基于自己的知识库生成练习题和考试记录。

插件默认使用本地 [Ollama](https://ollama.com)，不会默认把笔记发送到远程服务。只有当你显式配置 OpenAI-compatible 的云端或自托管模型服务时，插件才会调用对应远程接口。

![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)
![Version](https://img.shields.io/badge/version-1.3.4-1E90FF)
![Local RAG](https://img.shields.io/badge/Local--first-RAG-10b981)
![Ollama](https://img.shields.io/badge/Powered%20by-Ollama-111827)
[![License](https://img.shields.io/badge/License-MIT-84cc16)](./LICENSE)

![alt text](assets/screenshots/vault-coach-qa.png.png)

## 为什么使用 Vault Coach

Vault Coach 不是简单的聊天窗口，而是围绕 Obsidian 知识库设计的长期学习工具。

- **向你的 vault 提问**：回答前先检索 Markdown 笔记和文本型 PDF 页面。
- **回答可追溯**：回答下方展示来源、摘录、标题路径和 PDF 页码。
- **从笔记生成测试**：考试模式可以把指定目录或文件生成练习题。
- **默认本地优先**：默认使用 Ollama，本地完成聊天和 embedding。
- **不只支持 Markdown**：文本型 PDF 可以被解析、切块、向量化、检索和引用。
- **模型服务可替换**：可以使用本地 Ollama，也可以显式配置 OpenAI-compatible 服务。
- **中英文都可用**：插件界面和文档都提供英文与中文版本。

## 核心功能

### 知识库问答

在 Vault Coach 侧边栏中输入自然语言问题。插件会检索相关片段，可选地改写查询、重排候选内容，然后以流式方式生成带来源的回答。

支持的检索方式：

- 关键词检索
- 向量检索
- 关键词 + 向量混合检索
- 可选 rerank 服务，未配置时使用本地启发式 rerank

![alt text](assets/screenshots/retrieval-sources.png.png)

### 文本型 PDF 支持

Vault Coach 可以索引 vault 中带原生文本层的 PDF。插件会提取 PDF 文本和页码信息，将其转换成可检索片段，并在回答中显示页码级来源。

当前支持：

- 提取文本型 PDF 的原生文本层
- 设置 PDF 文件大小和页数上限
- 展示页码级来源，例如 `paper.pdf · 第 3 页`
- PDF 片段参与关键词检索、向量检索、混合检索、rerank、问答和考试模式
- 基础清理页眉、页脚、页码和部分阅读顺序问题
- 当模型从 PDF 内容生成公式时，对回答中的行内公式和块级公式做 Obsidian/KaTeX 兼容的 Markdown 规范化

当前限制：

- 扫描型 PDF 会被识别为低文本或疑似扫描，但暂不包含 OCR。
- 复杂表格、图表和视觉公式不会被完整还原。
- 双栏论文的阅读顺序通过启发式方式改善，但不能保证所有版式都完全正确。

![alt text](assets/screenshots/pdf-source-page.png.png)


### 考试模式

考试模式可以把你的知识库、某个目录或一组文件转换成练习测试。

它支持：

- 全库、目录和文件级考试范围选择
- 长期保存考试范围中的包含/排除规则
- 智能过滤 TODO、日志、链接索引、占位笔记、草稿等不适合出题的内容
- 先规划知识覆盖蓝图，再生成题目
- 基于索引知识库生成问题
- 使用已配置 LLM 评分并给出反馈
- 本地隐藏考试历史
- 手动导出考试记录到可见 vault 目录

适合用于面试准备、课程复习、论文阅读、项目交接和技术笔记自测。

#### 结构化考试记录

评分后的考试会将可追溯事实保存到当前 vault 的以下位置：

```text
.vault-coach/assessments/sessions/<session-id>.json
.vault-coach/assessments/index-v1.json
```

session JSON 是唯一事实源，包含考试、用户答案、评分证据、来源引用、concept binding 和评分模型元数据。`.vault-coach/exams/` 中对应的 Markdown 是可读投影：删除后可由 JSON 重建，且不会改动证据。即使 Markdown 报告缺失，历史列表仍会显示结构化记录。

这些文件只保存在你的 vault 中，可能包含笔记摘录、答案和模型反馈；它们不是遥测或云同步服务。请把它们当作私有 vault 数据，不要提交到插件仓库。导出的 Markdown 报告仍是你选择目录中的普通 vault 文件。

### 本地结构图谱快照

成功完成知识索引重建或文件级同步后，Vault Coach 还会在当前 vault 中维护以下版本化结构快照：

```text
.vault-coach/graph/graph-snapshot-v1.json
```

它只记录可确定读取的 Vault 结构：已索引文档的路径和标题、标题 Section、标签、已解析的本地链接/Embed，以及用于解释关系的来源位置。该快照不会创建 Concept、掌握度、复习推荐或图谱 UI；构建和更新图谱不会调用聊天模型、Embedding 模型或网络服务。

快照只保留在当前 vault 内，插件仓库会忽略它，并且可以根据当前知识范围重新生成。它可能包含私有文件路径、标题、标签名和链接元数据，请将其作为私有 vault 数据处理，不要提交到公开仓库。

### 可选语义概念图谱

**语义概念图谱** 是建立在本地结构快照之上的显式选择功能，默认关闭；它不会在插件启动或普通“重建索引”时自动运行。启用后，请在命令面板执行 **Rebuild semantic concept graph**，或在普通工作区标签页打开 **Concept review**。

- 插件只会把已索引的 Section 摘录发送给已配置的聊天模型，用于产生带证据的 Concept 候选和受限关系候选；需要相似候选时，只会把简短的 Concept 名称、Alias 和描述发送给 embedding 模型。
- Ollama 请求只发送到你配置的本地地址。只有当你显式选择 OpenAI-compatible 服务并主动运行该功能时，才会向该服务发送相同范围的有限内容。
- 语义数据保存在 vault 本地且被本仓库忽略：`.vault-coach/graph/semantic/`。其中包含候选、Chunk 证据、embedding 和你的审核决策；它与确定性的 `graph-snapshot-v1.json` 完全分离。
- 相似 Concept 候选使用独立且有 Top-K 上限的近似近邻查询。插件不会执行无上限的全 Concept 两两比较，也不会只因 embedding 相似就自动合并概念。
- **Concept review** 中，虚线是未确认候选，实线是已确认关系。你可以确认、拒绝、合并、撤销合并、编辑 Alias 或新增附带用户说明的手工关系。决策作为追加式本地事实保存，并优先于之后的模型重跑结果。

![alt text](assets/screenshots/exam-mode-scope.png.png)

用户同样可以手动管理测试题目的范围：
![alt text](assets/screenshots/exam-mode-scope-m.png)

### 长期记忆

Vault Coach 可以从对话中提取长期有用的信息，并在后续相关问题中注入。长期记忆保存在本地，也可以在设置中关闭。

### 流式回答

模型生成时，回答会实时流式显示。你可以中断过长的回答，并保留已经生成的部分文本。生成完成后，完整回答会渲染为 Obsidian Markdown。

## 快速开始

1. 在 Obsidian 中安装并启用 Vault Coach。
2. 通过左侧 ribbon 图标或命令面板打开侧边栏。
3. 打开 **设置 → Vault Coach**。
4. 选择知识库范围：整个 vault 或指定目录。
5. 选择要索引的文件类型：Markdown，以及可选的文本型 PDF。
6. 配置模型：
   - 如果希望本地使用，保持 **本地 Ollama**，并填写已经存在于 Ollama 中的聊天模型和 embedding 模型。
   - 如果使用远程或自托管 API，选择 **OpenAI 兼容**，并配置 endpoint、模型和 API key。
7. 点击 **重建索引**。
8. 开始提问，或切换到 **考试模式**。

Ollama 的基础地址通常是：

```text
http://127.0.0.1:11434
```

不要在基础地址后追加 `/api/chat`、`/api/embed` 或 `/api/embeddings`。Vault Coach 会在内部自动拼接 API 路径。

## 推荐 Ollama 配置

Vault Coach 需要一个聊天模型和一个 embedding 模型。

示例：

```bash
ollama pull gemma3:4b
ollama pull embeddinggemma
```

然后在设置中填写：

| 用途 | 示例 |
|------|------|
| 本地聊天模型 | `gemma3:4b` |
| 本地 embedding 模型 | `embeddinggemma` |
| 本地推理服务地址 | `http://127.0.0.1:11434` |

你也可以使用其他 Ollama 模型。更大的模型可能回答更好，但会占用更多内存，生成速度也更慢。

## 设置概览

### 基础

- 助手名称
- 默认欢迎语
- 启动时自动打开右侧边栏
- 默认检索模式
- 来源默认折叠

### 知识库

- 扫描整个 vault 或指定目录
- 启用 Markdown 索引
- 启用文本型 PDF 索引
- 设置 PDF 文件大小和页数上限
- 配置 chunk 大小和重叠
- 启用自动增量同步
- 为考试模式排除路径
- 启用考试内容智能筛选

### 模型

- 本地 Ollama 聊天模型
- 本地 Ollama embedding 模型
- OpenAI-compatible 聊天 endpoint
- OpenAI-compatible embedding endpoint
- 基于 Obsidian SecretStorage 的云端 API key
- 可选独立 rerank 服务

### 长期记忆

- 开启或关闭长期记忆抽取
- 控制每次回答注入的记忆数量
- 限制本地保存的记忆条数
- 限制持久化对话消息数量

### 高级 RAG

- Query rewrite
- 向量检索
- Rerank
- 关键词、向量和混合召回候选数量
- 最终注入 prompt 的上下文片段数量
- 来源展示数量
- 生成温度

## 隐私与网络使用

Vault Coach 默认本地优先。

使用默认 Ollama 配置时，聊天和 embedding 请求只会发送到你配置的本地 Ollama endpoint，通常是 `http://127.0.0.1:11434`。

只有当你显式选择 OpenAI-compatible 的聊天或 embedding 服务，并配置对应服务后，插件才会发起远程请求。

启用远程聊天模型时，对应服务可能收到：

- 当前用户问题
- 被检索到的 Markdown 片段
- 从 PDF 中提取出的文本片段
- 少量最近对话上下文
- 如果启用长期记忆，则包含与当前问题相关的记忆条目
- 使用考试模式时的笔记摘录、生成题目、参考答案、评分标准、用户答案和评分上下文

启用远程 embedding 时，构建向量索引期间，对应服务可能收到被索引的 Markdown 和 PDF 文本片段。

Vault Coach 不包含隐藏遥测。

确定性图谱快照同样只在本地生成。创建或更新 `.vault-coach/graph/graph-snapshot-v1.json` 不会把图谱事实发送给 Ollama、OpenAI-compatible 服务或其他任何服务。

## 当前限制

- PDF 支持面向文本型 PDF，暂不包含扫描型 PDF OCR。
- PDF 版式恢复是启发式的。复杂论文版式、表格、图表和视觉公式需要人工核对。
- 考试评分由你配置的 LLM 生成，适合作为学习反馈，不应视为权威评分。
- 长期记忆检索目前基于关键词匹配。
- 流式输出期间先显示纯文本，生成完成后再渲染为 Markdown。

## 适合谁使用

Vault Coach 特别适合：

- 在 Obsidian 中沉淀技术笔记、论文和项目文档的人
- 想基于自己的笔记准备面试或考试的人
- 希望使用本地优先 RAG，并能查看引用来源的人
- 需要同时检索 Markdown 笔记和文本型 PDF 的人
- 希望把问答、复习和自测都留在 Obsidian 工作流里的人

## 路线图

后续方向包括 OCR 支持、更好的 PDF 版式恢复、更完整的考试工作流、更强的记忆检索、更丰富的来源检查，以及可选外部向量后端。

更多计划见 [PROJECT_PLAN.md](./PROJECT_PLAN.md)。

## 贡献

欢迎提交 Issue 和 PR。

反馈 bug 时，请尽量附上：

- 复现步骤
- Obsidian 版本
- Vault Coach 版本
- 模型服务和模型名称
- 相关设置
- 控制台错误或截图

## 许可证

[MIT License](./LICENSE)
