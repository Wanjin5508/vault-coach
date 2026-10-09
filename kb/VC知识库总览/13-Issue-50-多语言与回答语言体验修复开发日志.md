---
tags:
  - VaultCoach
  - Issue50
  - i18n
  - 多语言
  - 流式输出
  - 踩坑复盘
---

# Issue 50 多语言与回答语言体验修复开发日志

## 背景

Issue 50 的核心问题不是简单的“把中文翻译成英文”，而是把 Vault Coach 的语言行为拆成两类独立决策：

1. 插件界面语言：跟随 Obsidian 当前语言。
2. 模型回答语言：只跟随用户当前问题的语言。

这两个决策不能混在一起。用户可能使用英文 Obsidian，但用中文提问；也可能使用中文 Obsidian，但用英文提问。插件 UI 应该尊重 Obsidian，回答内容则应该尊重用户问题。

## 问题清单

这次集中修复了几类语言体验问题：

- Obsidian 语言切换为英文后，插件界面没有跟着切换。
- 英文界面下，用户用英文提问，模型仍然用中文回答。
- Query rewrite prompt 写死了“改写成中文查询”，间接影响英文问答。
- 英文回答下方的 PDF sources 仍显示 `第 2 页`。
- 英文考试模式中，进度仍显示 `正在分析内容 2 / 47`。
- 英文流式输出完成后，Markdown 渲染期间回答会短暂跳成中文，然后又恢复英文。
- 语言监听最初使用了 2 秒轮询，但这种后台轮询没有必要。

## 最终行为

现在的行为是：

- 插件加载时读取 Obsidian 官方 `getLanguage()`，根据当时的 Obsidian 语言初始化 UI。
- 用户之后如果修改 Obsidian 语言，需要重启或重新加载插件，插件才会按新语言初始化。
- 问答回答语言只由用户当前问题决定。
- 英文问题输出英文，中文问题输出中文。
- Query rewrite 不再强制生成中文查询。
- PDF source 页码在英文 UI 下显示 `page 2` 或 `pages 2-4`。
- 考试模式进度在英文 UI 下显示 `Analyzing content 2 / 47`。
- 流式输出结束后直接在当前气泡中渲染最终 Markdown，不再整块重绘消息区，避免视觉闪烁。

## 主要改动

### 1. UI 语言改为读取 Obsidian 语言

最初插件使用的是浏览器环境的 `navigator.languages` 和 `navigator.language`。

问题是 Obsidian 的界面语言不等于 Electron 环境的浏览器语言。用户把 Obsidian 改成英文后，`navigator.language` 仍可能是 `zh-CN`，导致插件继续显示中文。

修复方式是在 `src/i18n.ts` 中引入 Obsidian 官方 API：

```ts
import { getLanguage } from "obsidian";
```

语言检测逻辑改为优先使用 `getLanguage()`：

```text
getLanguage()
→ zh / en 映射
→ 如果 API 不可用，再回退到 navigator.language
```

这里保留浏览器语言 fallback，是为了避免测试环境或特殊运行环境下 `getLanguage()` 不可用时整个翻译模块失效。

### 2. 去掉 2 秒语言轮询

第一版修复为了让语言切换即时生效，加了：

```text
setInterval(() => refreshLocaleIfChanged(), 2000)
```

后来判断这个方案不必要。

原因：

- 用户不会频繁切换 Obsidian 界面语言。
- 语言切换是低频设置行为，不值得长期轮询。
- 后台 interval 增加了生命周期复杂度。
- 命令面板、ribbon tooltip、设置页、默认欢迎语等静态 UI 本来更适合在插件加载时初始化。

最终方案是：插件加载时检测一次 Obsidian 语言。用户修改 Obsidian 语言后，重启或重新加载插件即可。

这让实现更简单，也更符合 Obsidian 插件的运行模型。

### 3. 回答语言只跟随用户问题

英文界面下英文问题仍得到中文回答，根因在 `src/rag-engine.ts` 的最终回答 prompt：

```text
1. 使用中文回答；
```

这条系统提示优先级高于用户问题语言，所以模型会稳定输出中文。

修复方式是新增 `src/question-language.ts`，专门判断当前用户问题语言：

```text
detectQuestionLanguage(question) -> "zh" | "en"
```

判断不是简单地“出现汉字就算中文”，而是同时考虑：

- 汉字数量。
- 英文单词数量。
- 英文问句信号，例如 `what`, `why`, `how`, `explain`。
- 中文问句信号，例如 `什么`, `如何`, `为什么`, `解释`。

这样可以避免误判：

```text
What does “批量归一化” mean?
```

这类问题应该按英文回答，而不是因为包含中文术语就切到中文。

### 4. Prompt 标签也要跟随回答语言

只改“使用英文回答”还不够。

如果 user prompt 里仍然充满中文标签，例如：

```text
知识库范围：
原始问题：
检索查询：
长期记忆：
检索上下文如下：
```

模型仍可能被中文上下文诱导，输出中文。

因此 `buildAnswerMessages()` 被拆成：

- `buildAnswerSystemPrompt(answerLanguage)`
- `buildAnswerUserPrompt(answerLanguage)`
- `buildContextBlock(answerLanguage)`

英文问题时，外层 prompt 标签也改成英文：

```text
Knowledge base scope:
Original question:
Retrieval query:
Retrieved context:
```

关键经验是：LLM 输出语言不只受一条规则影响，也受整个 prompt 的语言分布影响。要想稳定英文输出，系统提示、用户提示、上下文标签都应该一致。

### 5. Query rewrite 不能强制中文

`src/model-client.ts` 中 query rewrite 的旧 prompt 写的是：

```text
把用户问题改写成更适合检索的中文查询。
```

这会导致英文问题被改写成中文查询。即使最终回答要求英文，检索查询和上下文标签仍可能把模型拉回中文。

修复后 query rewrite 规则变成：

- 不回答问题，只生成检索查询。
- 保留用户问题语言。
- 不强制中文或英文。
- 保留重要技术术语、缩写和常见别名。
- 必要时允许保留双语技术别名以提高检索召回。

这个改动也更符合 RAG 目标：query rewrite 的职责是改写检索查询，不应该顺便决定回答语言。

### 6. PDF sources 页码要分生成侧和渲染侧处理

PDF source 链接文本原来在 `src/rag-engine.ts` 中硬编码：

```text
file.pdf · 第 2 页
```

第一层修复是在生成 `AnswerSource.displayLink` 时根据用户问题语言输出：

```text
file.pdf · page 2
file.pdf · pages 2-4
```

但这里还有一个坑：旧会话里已经持久化的 `displayLink` 可能仍是中文。如果只改生成侧，新回答正常，旧消息重新渲染时还是中文。

所以又在 `src/view.ts` 增加渲染侧兜底：

```text
formatSourceDisplayLink(source)
```

当 source 是 PDF 且有页码时，不直接使用已保存的 `displayLink`，而是按当前 UI 语言动态生成链接文本。

经验是：可展示文本如果会持久化，就不要只在生成时做本地化；渲染时也要能根据当前语言重建展示文本。

### 7. 考试进度不要直接信任后端 label

考试模式里 `ExamEngine` 的 progress label 是中文硬编码：

```text
正在分析内容
正在分析内容 2 / 47
正在生成题目 0 / 5
```

如果 view 直接显示 `progress.label`，英文 UI 就会混入中文。

修复方式是在 `src/i18n.ts` 增加进度翻译 key：

- `exam.progress.resolvingScope`
- `exam.progress.ruleFiltering`
- `exam.progress.semanticFiltering`
- `exam.progress.semanticFilteringCount`
- `exam.progress.planning`
- `exam.progress.generating`
- `exam.progress.generatingCount`
- `exam.progress.validating`
- `exam.progress.repairing`
- `exam.progress.completed`

然后在 `src/view.ts` 中用 `progress.phase` 和 `current / total` 重新格式化：

```text
phase + current + total -> 本地化展示文案
```

经验是：跨层传递的 progress 对象应该把 `phase` 当作语义字段，`label` 只作为 fallback。UI 层才是最终决定展示语言的地方。

### 8. 流式输出结束后的闪烁

用户看到的问题是：英文流式输出结束后，到 Markdown 渲染完成前，回答会短暂跳成中文，然后又恢复英文。

根因在 `src/view.ts` 的发送流程。

旧流程是：

```text
流式 token 追加到临时气泡
→ streamAssistantTurn 保存最终 assistant message
→ clearStreamingAssistantBubble()
→ renderMessages()
```

这里有一个视觉空档：

1. 临时英文气泡被移除。
2. 整个消息列表异步重绘。
3. MarkdownRenderer 完成前，用户可能看到旧 DOM 或旧持久化消息状态。

如果旧状态里存在上一轮中文回答，就会造成“闪一下中文”的错觉。

修复方式是新增：

```text
finalizeStreamingAssistantBubble(answer)
```

新流程变成：

```text
流式 token 追加到临时气泡
→ streamAssistantTurn 保存最终 assistant message
→ 在同一个临时气泡里直接渲染最终 Markdown
→ 在同一个 wrapper 下渲染 sources
→ 清空 streaming 引用，但不移除 DOM
```

这样用户看到的是同一个气泡从纯文本流式态升级为 Markdown 态，不再经历“删除旧气泡 -> 重建消息列表”的闪烁。

## 关键经验

### UI 语言和内容语言要分开建模

这次最重要的经验是：国际化有两套语言来源。

```text
Obsidian getLanguage() -> UI 文案
用户当前问题 -> 模型回答语言
```

如果把它们混在一起，会出现：

- 英文 Obsidian 下中文问题被迫英文回答。
- 中文 Obsidian 下英文问题被迫中文回答。
- Query rewrite、sources、考试进度各自用不同语言。

### 不要让底层 label 直接成为最终 UI 文案

`ExamGenerationProgress.label` 这种字段很容易变成“后端顺手写的中文字符串”。更好的结构是：

```text
phase: "semantic-filtering"
current: 2
total: 47
```

UI 层再根据当前语言翻译成：

```text
正在分析内容 2 / 47
Analyzing content 2 / 47
```

### Prompt 语言会污染模型输出

LLM 不会只看“请用英文回答”这一句。它会被整个 prompt 的语言环境影响。

英文回答要稳定，至少要处理：

- system prompt。
- user prompt 外层标签。
- fallback 文案。
- query rewrite prompt。
- 上下文 metadata 标签。

### 持久化展示文本要谨慎

`AnswerSource.displayLink` 是一个典型例子。它既是数据，又包含展示文案。

如果把 `第 2 页` 直接持久化，后续 UI 切到英文时就不好处理。

更好的方向是长期把 source 数据结构化：

```text
filePath
locator.pageStart
locator.pageEnd
```

展示时再格式化本地化文案。

### 流式 UI 尽量就地升级，不要整区重绘

流式输出期间，用户正在盯着一个具体气泡。结束时如果把它删掉再重建，会带来：

- 闪烁。
- 滚动位置跳动。
- 旧状态短暂暴露。
- Markdown 渲染前后内容跳变。

更好的方式是保留 wrapper 和 bubble，只替换 bubble 内部渲染内容。

## 验证

本次修改后执行：

```bash
npm run lint
npm run build
```

两者均通过。

## 面试可讲点

如果面试官问“多语言是怎么设计的”，可以这样回答：

- UI 语言跟随 Obsidian 的 `getLanguage()`，在插件加载时初始化。
- 回答语言不跟随 UI，而是通过当前用户问题检测。
- RAG prompt 会根据问题语言切换 system prompt、user prompt 标签和 fallback 文案。
- Query rewrite 只负责检索查询，不决定回答语言。
- Sources 和考试进度由 UI 层按当前语言格式化，避免后端中文 label 泄漏。
- 流式输出结束时就地升级当前气泡为 Markdown，避免整区重绘导致闪烁。

这次修复的重点不是翻译词条，而是把语言归属边界理清楚：界面语言属于 Obsidian，回答语言属于用户问题，进度与来源展示属于 UI 层格式化。
