# Vault Coach

> 🌐 语言版本：[English](./README.md) | 中文

一个运行在 [Obsidian](https://obsidian.md) 中的本地智能问答插件，通过 Advanced RAG（检索增强生成）技术，让你在自己的 Markdown 知识库中进行高质量的自然语言问答。完全依赖本地 [Ollama](https://ollama.com) 服务，**数据不出本地**。
![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)
![Version](https://img.shields.io/badge/version-0.0.2-1E90FF)
![Local RAG](https://img.shields.io/badge/Local-RAG-10b981)
![Ollama](https://img.shields.io/badge/Powered%20by-Ollama-111827)
[![License](https://img.shields.io/badge/License-MIT-84cc16)](./LICENSE)

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [插件设置](#插件设置)
- [项目计划](#项目计划)
- [技术架构](#技术架构)
- [已知问题](#已知问题)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 功能特性

### ✅ 第一阶段（当前版本 v0.0.2）

| 功能 | 说明 |
|------|------|
| 🔍 混合检索 | 关键词（TF-IDF）+ 语义向量（Embedding）+ RRF 融合 |
| ✏️ Query Rewrite | 本地 LLM 自动改写问题，提升检索效果 |
| 📊 Rerank | 支持外部 rerank 服务，或回退到本地启发式重排 |
| 🧠 长期记忆 | 跨会话提取并注入用户偏好与项目上下文 |
| 🔄 增量索引同步 | 监听 vault 文件变化，自动增量更新索引 |
| 🌊 流式输出 | 伪流式渲染回答，降低感知延迟 |
| 💾 对话持久化 | 会话历史本地持久化，重启后恢复 |
| 🔒 完全本地 | 通过 Ollama REST API，数据不出本地 |

---

## 快速开始

### 前置要求

- [Obsidian](https://obsidian.md) v1.5.0+
- [Ollama](https://ollama.com) 本地运行中
- 至少拉取一个聊天模型（如 `gemma3:4b`）和一个 Embedding 模型

### 安装（开发版本）

```bash
# 1. 克隆仓库到 vault 插件目录
cd <your-vault>/.obsidian/plugins
git clone https://github.com/Wanjin5508/vault-coach vault-coach

# 2. 安装依赖并构建
cd vault-coach
npm install
npm run build

# 3. 在 Obsidian 设置 > 社区插件中启用 Vault Coach
```

### 基础配置

1. 打开 **设置 → Vault Coach**
2. 填写本地 Ollama 地址（默认 `http://127.0.0.1:11434`）
3. 填写聊天模型名（如 `gemma3:4b`）和 Embedding 模型名
4. 点击 **重建索引** 或等待自动索引完成
5. 点击右侧边栏的 💬 图标开始问答

---

## 插件设置

### 基础设置

| 设置项 | 说明 |
|--------|------|
| 助手名称 | 右侧边栏头部显示的名称 |
| 默认欢迎语 | 重置会话时显示的第一条消息（支持 Markdown） |
| 启动时自动打开边栏 | Obsidian 启动后自动打开 Vault Coach |
| 默认检索模式 | keyword / vector / hybrid（推荐 hybrid） |
| 来源默认折叠 | 回答下方的来源区域是否默认折叠 |

### 知识库设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 扫描范围 | 整个 vault | 或只扫描指定目录 |
| Chunk 大小 | 600 字符 | 每个片段的最大字符数 |
| Chunk 重叠 | 120 字符 | 相邻片段的重叠量 |
| 启用自动增量同步 | ✅ | 监听文件变化自动更新索引 |
| 防抖等待时间 | 15,000 ms | 最后一次文件变化后等待多久 |
| 最大等待时间 | 120,000 ms | 强制同步的最大等待时间 |
| 文件变化触发阈值 | 8 个文件 | 达到此数量时立即触发同步 |

### Advanced RAG 设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用 Query Rewrite | ✅ | LLM 自动改写问题以提升检索质量 |
| 启用向量检索 | ✅ | 开启后重建索引时生成 Embedding |
| 启用 Rerank | ✅ | 对召回结果进行重排 |
| 关键词 top-k | 10 | 关键词召回候选数 |
| 向量 top-k | 10 | 向量召回候选数 |
| Hybrid 候选上限 | 12 | 融合后保留的候选数 |
| Rerank top-k | 8 | 进入重排的候选数 |
| 上下文 chunks 数 | 8 | 注入 prompt 的最终 chunk 数 |
| 来源数量上限 | 5 | 每条回答展示的最多来源数 |
| 生成温度 | 0.2 | 控制回答随机性（RAG 建议保持低值） |

### 本地模型设置

| 设置项 | 说明 |
|--------|------|
| 本地推理服务地址 | Ollama 地址，默认 `http://127.0.0.1:11434` |
| 聊天模型 | 用于 Query Rewrite 与最终回答生成 |
| Embedding 模型 | 用于向量检索，修改后需重建索引 |
| 独立 Rerank 服务地址 | 可选，留空时使用本地启发式 rerank |
| Rerank 模型 | 配置了 rerank 服务时使用 |

### 长期记忆设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用长期记忆 | ✅ | 每轮对话后自动抽取并保存有价值信息 |
| 记忆注入数量 | 4 条 | 每次回答最多注入多少条相关记忆 |
| 最大记忆条数 | 150 条 | 超出后保留最近更新/访问的记忆 |
| 最大持久化消息数 | 60 条 | 对话历史保留的最大条数 |

---

## 项目计划

详见 [PROJECT_PLAN.md](./PROJECT_PLAN.md) 查看完整的三阶段开发计划。

### 阶段概览

| 阶段 | 名称 | 状态 | 核心目标 |
|------|------|------|----------|
| Phase 1 | Advanced RAG 问答 | ✅ **已完成** | 混合检索 + Rerank + 长期记忆 + 增量索引 |
| Phase 2 | 知识图谱增强 | 🔜 计划中 | 实体抽取 + 图谱构建 + 智能查询路由 |
| Phase 3 | 智能体面试助手 | 🔜 计划中 | 多角色 Agent + 面试模拟 + 技能诊断 |
| Phase 4 | 独立应用 | 🔜 愿景 | 独立前后端 + 语音交互 + 虚拟形象 |

---

## 技术架构

```
┌─────────────────────────────────────────────────┐
│                   view.ts (UI)                    │
│         Obsidian ItemView · 右侧边栏               │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│                   main.ts                         │
│   Plugin 入口 · 状态管理 · Vault 事件监听          │
└──────┬─────────────┬──────────────┬─────────────┘
       │             │              │
┌──────▼──────┐ ┌────▼─────┐ ┌────▼──────────────┐
│  rag-engine │ │knowledge │ │ persistent-store   │
│  Advanced   │ │  -base   │ │ runtime-state.json │
│  RAG 流程    │ │ 索引/检索  │ │ index-snapshot.json│
└──────┬──────┘ └──────────┘ └───────────────────┘
       │
┌──────▼──────────────────────────────────────────┐
│                model-client.ts                    │
│     Ollama REST API · /api/chat · /api/embed      │
└─────────────────────────────────────────────────┘
```

详细技术文档请参阅 [TECHNICAL_DOC.docx](./TECHNICAL_DOC.docx)。

---

## 已知问题

- **流式输出非真实流式**：requestUrl 一次性返回完整响应，视觉上有延迟
- **记忆搜索无语义相似度**：当前仅用关键词匹配，Phase 2 中将引入 Embedding
- **VIEW_TYPE 存在 typo**：constants.ts 中的 ID 值（非影响性 bug，计划在下一版本修复）

---

## 贡献

欢迎提交 Issue 和 PR！请先查看 [PROJECT_PLAN.md](./PROJECT_PLAN.md) 了解当前开发方向。

---

## 许可证

[MIT License](./LICENSE)
