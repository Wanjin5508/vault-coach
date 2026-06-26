# VaultCoach 考试模式技术文档

## 目标

考试模式用于让用户基于当前 VaultCoach 知识库创建一次测试。测试创建与答题过程仍只存在于当前插件视图内存中；用户提交评分后，插件会默认把结果保存到隐藏历史目录。用户也可以从结果页手动导出一份 Markdown 到指定目录。

问答模式仍保持原有行为：临时对话可随时重置，答案生成和来源渲染逻辑不因考试模式改变。

## 用户流程

1. 用户在右侧栏点击 **考试模式**。
2. 插件显示创建测试界面，而不是直接进入对话页面。
3. 用户选择测试范围：
   - 当前完整知识库。
   - 当前知识库范围内的一个或多个目录。
4. 用户选择题目数量，当前限制为 1 到 10 题。
5. 插件调用用户已配置的聊天模型生成题目、参考答案、评分标准和来源路径。
6. 用户逐题作答。
7. 用户提交后，插件调用同一个聊天模型评分。
8. 评分完成后，插件默认保存到 `.vault-coach/exams`。
9. 用户可以在结果页手动导出到指定目录，或通过 **考试历史** 查看过往记录。

## 主要代码结构

- `src/types.ts`
  - 新增 `ExamScopeOption`、`ExamQuestion`、`ExamEvaluation`、`ExamSession`、`ExamHistoryItem` 等考试模式数据结构。
- `src/knowledge-base.ts`
  - 新增 `getExamFolderScopeOptions()`，从当前已索引 chunk 中统计可选目录。
  - 新增 `getChunksForExamScope()`，根据用户选择过滤考试上下文。
  - 排除 `.vault-coach` 隐藏目录，避免保存的考试结果被再次纳入知识库。
- `src/rag-engine.ts`
  - 新增 `generateExamSession()`，负责生成测试题。
  - 新增 `evaluateExamSession()`，负责评分。
  - 使用低温度、严格 JSON schema 和输出归一化提升模型输出稳定性。
- `src/main.ts`
  - 对视图暴露考试创建、评分、默认隐藏保存、手动导出、历史读取和删除方法。
  - 默认保存结果到 `.vault-coach/exams`。
  - 自动索引事件忽略 `.vault-coach` 隐藏目录。
- `src/view.ts`
  - 新增考试模式 UI 状态机：`setup`、`generating`、`taking`、`evaluating`、`review`、`history`。
  - 问答模式和考试模式使用不同界面，互不覆盖。
- `styles.css`
  - 新增考试模式布局、范围选择、答题卡片、评分结果样式。
- `src/i18n.ts`
  - 新增考试模式中英文文案。

## 数据模型

一次考试使用 `ExamSession` 表示：

```ts
interface ExamSession {
  id: string;
  title: string;
  createdAt: number;
  scopeLabel: string;
  selectedFolderPaths: string[];
  questions: ExamQuestion[];
  userAnswers: string[];
  evaluation: ExamEvaluation | null;
  savedPath: string | null;
  status: "draft" | "submitted" | "saved";
}
```

其中：

- `questions` 保存题目、参考答案、评分标准和来源路径。
- `userAnswers` 保存用户作答。
- `evaluation` 保存总分、逐题得分和反馈。
- `savedPath` 在提交评分并完成默认隐藏保存后写入。

历史列表使用 `ExamHistoryItem` 表示：

```ts
interface ExamHistoryItem {
  path: string;
  title: string;
  createdAt: number | null;
  score: number | null;
  maxScore: number | null;
  modifiedAt: number | null;
}
```

## 保存策略

评分完成后，考试结果默认保存到 vault 内的隐藏目录：

```text
.vault-coach/exams/
```

保存文件为 Markdown，并带有轻量 YAML 元数据，便于历史列表读取标题、时间和分数。正文内容包括：

- 测试 ID。
- 创建时间。
- 测试范围。
- 题目数量。
- 总分和总体反馈。
- 每题题目、用户答案、参考答案、评分标准、逐题评分反馈和来源路径。

该目录会被知识库扫描和自动增量索引事件忽略，避免保存结果污染后续检索语料。

用户在结果页输入 vault 相对目录后，可以手动导出一份 Markdown 副本到指定目录。导出会自动创建缺失目录，且不会改变隐藏历史记录。

## LLM 生成策略

当前实现只使用提示词工程和上下文工程，不引入复杂工作流或工具调用。

### 题目生成

`generateExamSession()` 会从选定范围内抽取一组代表性 chunk，并构造如下约束：

- 只能基于给定上下文出题。
- 不引入上下文之外的事实。
- 题目考察理解、解释、对比、应用。
- 输出严格 JSON，不使用 Markdown 或代码块。
- 每题必须包含题目、参考答案、评分标准和来源路径。
- 题干、参考答案和评分标准不得出现 `EXCERPT_ID`、`SOURCE_PATH`、`HEADING`、片段编号或“上下文 n”等内部标记。
- 评分标准必须统一为 100 分制。

生成温度设置为 `0.1`，降低题目漂移，同时保留少量多样性。

上下文块传给模型时使用机器可读的 `<excerpt id="E1">` 结构，而不是“上下文 1”这类自然语言标签，降低模型把内部标签写进题目的概率。归一化阶段还会再次清理题目、参考答案和评分标准中的内部上下文标签。

### 评分

`evaluateExamSession()` 会把题目、参考答案、评分标准和用户答案一起发送给模型，并要求：

- 只评价用户答案是否覆盖关键点。
- 表达方式不同但含义正确时不扣分。
- 未作答或明显无关答案给低分。
- 每题 `max_score` 固定为 100。
- 每题 `score` 是 0 到 100 的百分制分数。
- 总分 `score` 是所有题目百分制得分的平均值，`max_score` 固定为 100。
- 输出严格 JSON。

评分温度设置为 `0`，尽量提升稳定性。

## JSON 稳定性处理

模型输出仍可能出现代码块、额外文字或字段缺失。因此代码中做了以下处理：

- `parseJsonObject()` 会先移除常见 JSON 代码块包裹。
- 如果完整解析失败，会截取第一个 `{` 到最后一个 `}` 再解析。
- 如果仍然解析失败，会把原始输出交给同一个聊天模型执行一次“只修复 JSON 语法”的低温重试。
- `normalizeGeneratedExamQuestions()` 会过滤缺少题目、参考答案或评分标准的题目。
- `stripInternalContextLabels()` 会清理模型泄漏的内部上下文标签。
- `normalizeRubricText()` 会补齐 100 分制说明，并清理常见的非 100 分总分口径。
- `normalizeExamEvaluation()` 会按题目 ID 对齐评分项，缺失时使用默认反馈。
- 分数使用 `clampScore()` 限制在合法范围内，并强制单题 `maxScore` 为 100。

## 范围选择

考试范围基于当前已经索引的知识库，而不是全 vault 重新扫描：

- 完整知识库：使用当前知识库全部 chunk。
- 目录范围：从当前 chunk 的文件路径中推导父目录，用户可多选目录。

这样可以保证考试模式尊重设置页中的知识库范围。

## UI 状态机

考试模式前端不复用问答消息列表，而是独立渲染：

- `setup`：创建测试，选择范围和题目数量。
- `generating`：显示动态忙碌状态。
- `taking`：显示题目和答案输入框。
- `evaluating`：显示动态评分状态。
- `review`：展示得分、反馈、参考答案，并提供手动导出、删除和新建测试。
- `history`：展示隐藏目录中的历史测试列表，并在插件内渲染所选记录的 Markdown 内容。

提交评分前的数据只保存在当前 `VaultCoachView` 实例内。评分完成后会默认保存到隐藏历史目录。

## 近期修复记录与坑

### 历史记录中的来源链接

隐藏历史记录保存为 Markdown，来源路径写成 `[[path/to/file.md]]`。历史详情页使用 `MarkdownRenderer.render()` 渲染这些 Markdown 内容，但在自定义插件视图里，渲染出的 `.internal-link` 不一定会自动执行 Obsidian 的文件跳转。

修复方式：

- 历史详情渲染完成后，对容器绑定 click 事件委托。
- 点击 `.internal-link` 时，优先读取 `data-href`，其次读取 `href` 和文本内容。
- 统一交给 `app.workspace.openLinkText()` 打开。
- 这样历史页中的来源链接和考试反馈页中的来源按钮都走同一套打开逻辑。

### 创建考试时无法选择目录

之前默认选中“完整知识库”时，目录 checkbox 被禁用。结果用户必须先取消完整知识库，但目录项本身不可点，体验上就像“无法选择目录”。

修复方式：

- 目录 checkbox 不再因完整知识库选中而禁用。
- 用户直接点击任意目录时，前端会清除 `__all__` 选择并选中该目录。
- 如果用户重新选择完整知识库，则清空其他目录选择。

### 字段标题加粗不明显

最初使用 `strong` 标签和 `var(--font-bold)`，但某些 Obsidian 主题会让这个变量不明显，用户看到的标题仍像普通文本。

修复方式：

- 字段标题仍使用 `strong` 保留语义。
- CSS 明确设置 `font-weight: 700 !important`。
- 标题颜色改为 `var(--text-normal)`，不再使用偏弱的 muted 色。

### 题目泄漏内部上下文标签

题目生成早期使用“上下文 n”作为 prompt 里的片段标题，模型有概率把“上下文 1”等内部标记写进题干或答案。

修复方式：

- prompt 中改用机器可读的 `<excerpt id="E1">` 包裹片段。
- 明确要求模型不要输出 `EXCERPT_ID`、`SOURCE_PATH`、`HEADING`、片段编号等内部标记。
- 本地归一化阶段使用 `stripInternalContextLabels()` 二次清理。

### 评分口径不统一

模型可能生成“本题 2 分”之类的评分标准，同时评分结果又使用 100 分制，造成认知冲突。

修复方式：

- 出题提示词要求评分标准使用 100 分制。
- 评分提示词要求每题 `max_score` 固定为 100。
- `normalizeExamEvaluation()` 强制单题 `maxScore = 100`。
- `normalizeRubricText()` 会补齐 100 分制说明，并清理常见非 100 分总分口径。

## 隐私与外部服务

考试模式复用用户当前配置的聊天模型服务。如果用户选择云端模型，题目生成和评分会向该服务发送选定知识库片段、题目、参考答案、评分标准和用户答案。

这一行为与问答模式的云端模型调用一致，应在设置和 README 中持续明确披露。

## 已知限制

- 题目生成当前只抽取部分代表性 chunk，不保证覆盖所选范围内全部知识点。
- 评分依赖 LLM，本质上不是完全确定性的标准化考试评分。
- 当前没有实现题型选择、限时或错题集。
- 当前没有实现考试结果的结构化数据库索引，保存结果以 Markdown 文件为准。
