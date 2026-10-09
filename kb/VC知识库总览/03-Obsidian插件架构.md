---
tags:
  - VaultCoach
  - Obsidian插件
  - 架构设计
---

# Obsidian 插件架构

## 架构视图

Vault Coach 是一个 TypeScript 编写的 Obsidian 社区插件，入口是 `src/main.ts`，通过 esbuild 打包为 `main.js`。插件主要模块如下：

- `VaultCoach`：插件主类，负责生命周期、命令、视图注册、索引调度、状态持久化。
- `VaultCoachView`：右侧栏 UI，负责问答模式、考试模式和历史展示。
- `VaultKnowledgeBase`：知识库索引层，负责扫描 Markdown、切块、关键词索引和向量检索。
- `AdvancedRagEngine`：RAG 编排层，负责 query rewrite、召回、融合、rerank、prompt 和考试逻辑。
- `LocalModelClient`：模型调用层，屏蔽 Ollama 和 OpenAI-compatible API 差异。
- `VaultCoachPersistentStore`：运行时状态和索引快照的 JSON 持久化。

## Obsidian 插件关键点

- 通过 `this.registerView()` 注册自定义右侧栏视图。
- 通过 `this.addCommand()` 注册命令面板动作。
- 通过 `this.addRibbonIcon()` 注册左侧 ribbon 入口。
- 通过 `this.registerEvent()` 监听 vault 文件 create / modify / delete / rename。
- 使用 `app.vault.adapter` 读写插件状态和考试历史。
- 使用 `MarkdownRenderer.render()` 渲染 Markdown，使用 `openLinkText()` 跳转内部链接。

## 面试问答

### 1. 这个插件的主流程是什么？

插件加载时读取设置、恢复运行时状态和索引快照，注册视图、命令、ribbon 图标和 vault 文件事件。用户打开右侧栏后，可以提问或进入考试模式。提问时主类确保知识库可用，再调用 RAG 引擎生成答案，最后由视图渲染消息和来源。

### 2. 为什么把功能拆成多个模块？

因为插件包含 UI、索引、RAG、模型调用、持久化和设置页，如果都放在 `main.ts` 会难以维护。拆分后每个模块职责清晰：`knowledge-base` 不关心模型，`model-client` 不关心 UI，`rag-engine` 只编排流程。

### 3. `main.ts` 在架构中承担什么职责？

`main.ts` 是协调层。它不直接实现检索算法，而是负责插件生命周期、设置读取保存、状态恢复、视图刷新、索引重建、自动同步、考试保存和对视图暴露 API。

### 4. 为什么使用右侧栏 `ItemView`？

问答助手适合常驻在侧边栏：用户可以一边看笔记一边提问。相比 Modal，`ItemView` 更适合长期交互，能承载消息列表、输入框、索引状态和考试模式的多阶段界面。

### 5. 如何保证插件卸载时不泄漏事件？

文件事件使用 Obsidian 的 `this.registerEvent()` 注册，定时器在 `onunload()` 中清理。这样插件禁用或重载时，事件监听和 interval / timeout 不会残留。

### 6. 为什么要做运行时状态和索引快照持久化？

如果每次打开 Obsidian 都重新扫描文件、生成 embedding，启动成本会很高。项目把对话、长期记忆、索引 chunk、embedding 和文件 hash 持久化到 JSON，启动时能恢复上次状态，并在配置或 embedding 签名变化时判断是否需要重建。

### 7. Obsidian 内部链接跳转是怎么实现的？

问答来源通过 `openSource()` 构造 `filePath#heading`，调用 `app.workspace.openLinkText()`。考试历史 Markdown 渲染出的 `[[path]]` 链接在插件自定义视图里不一定自动跳转，所以额外绑定 `.internal-link` click 事件并统一走 `openLinkText()`。

### 8. 这个架构对移动端有什么影响？

`manifest.json` 中 `isDesktopOnly` 为 `false`，说明目标上支持移动端。但 Ollama 本地服务通常不适合移动端，因此后续如果支持移动端 embedding，需要考虑 Transformers.js 或云端服务，同时避免使用桌面专属 API。

