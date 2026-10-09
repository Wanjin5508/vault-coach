---
tags: [VaultCoach, v1.5, 里程碑7, SetupWizard, UX]
status: planned
updated: 2026-10-09
depends-on: [里程碑6-Worker化与可观测索引进度.md]
---

# 里程碑 7：首次启动 Setup Wizard 与首个成功动作

## 1. 目标

实现一个可恢复的首次启动流程：选择知识范围 → 配置聊天 LLM → 准备语义搜索 → 进入第一个 Ask/Test。向导使用 M5/M6 的真实状态，不复制 embedding、索引或设置逻辑。

学习重点：显式状态机、草稿与提交、流程恢复、可访问性、端到端调试以及“首次成功”指标设计。

## 2. 产品流程

```text
Step 1  Choose knowledge
        Current folder（推荐） / Current note / Entire vault / Selected folder
                         ↓
Step 2  Connect your AI
        Chat provider + model + connection test
        Semantic search: Built in, prepared locally
                         ↓
Step 3  Prepare your knowledge
        Reading notes x/y → Chunking → Downloading model bytes
        → Embedding chunks x/y → Saving
                         ↓
Step 4  Start learning
        Ask my notes / Test my knowledge
```

“Current folder”只在当前活动文件有父目录时推荐；根目录、附件或无活动文件要有确定 fallback。向导不能自动发送问题或调用付费 LLM。

## 3. 状态模型

建议使用 discriminated union，而不是多个布尔值：

```ts
type SetupState =
  | { step: "knowledge"; draft: KnowledgeDraft }
  | { step: "chat"; draft: ChatDraft; knowledge: ValidKnowledgeScope }
  | { step: "preparing"; setupId: string; jobId: string; progress: IndexProgress }
  | { step: "ready"; completedAt: number; suggestedActions: SetupAction[] }
  | { step: "error"; from: SetupRecoverableStep; error: SetupError };
```

持久化字段至少包含 `setupSchemaVersion`、`status`、已确认知识范围、非秘密聊天配置、最近完成步骤和 `completedAt`。API key 使用现有安全/设置存储方式，不复制到 setup state、日志或截图。

## 4. 知识范围扩展

当前 folder 模式不能完整表达“当前笔记”。若产品确认该入口，需正式扩展 scope，而非把文件路径伪装成目录：

```ts
type KnowledgeScope =
  | { mode: "vault" }
  | { mode: "folder"; path: string }
  | { mode: "file"; path: string };
```

选择“当前笔记”时保存当时文件路径。后续切换 active file 不应让索引范围静默漂移。rename/delete 事件要么更新路径，要么将 scope 标记为 needs-attention，并给出重新选择操作。

涉及：

- `src/app/config/settings-types.ts` 的知识范围设置；
- `src/knowledge-base.ts` 的文件发现过滤；
- inventory/settings signature；
- 文件 rename/delete listener；
- settings UI 与测试 fixture；
- index fingerprint 中的 scope identity。

## 5. 涉及文件与建议模块

| 文件/模块 | 职责 |
| --- | --- |
| `src/app/setup/setup-types.ts` | state、draft、error、action 类型 |
| `src/app/setup/setup-service.ts` | 状态转换、校验、恢复、完成 |
| `src/app/setup/setup-migration.ts` | setup schema 读取，完整迁移留 M8 |
| `src/app/knowledge/knowledge-scope.ts` | scope union、规范化和验证 |
| `src/app/application-api.ts` | 扩展现有 API：setup commands/state subscription |
| `src/presentation/controllers/setup-wizard-controller.ts` | 将 UI 事件映射为 use case |
| `src/presentation/views/setup-wizard-view.ts` | 步骤装配与焦点管理 |
| `src/presentation/components/setup-knowledge-step.ts` | scope 选择 |
| `src/presentation/components/setup-chat-step.ts` | 聊天 provider 与连接测试 |
| `src/presentation/components/setup-progress-step.ts` | 订阅 M6 真实进度 |
| `src/presentation/components/setup-ready-step.ts` | Ask/Test 首动作 |
| `src/presentation/vault-coach-view.ts` | 修改现有主 View，根据 setup 状态路由 wizard/main UI |
| `src/vault-coach-plugin.ts`、`src/app/vault-coach-runtime.ts` | 现有 lifecycle/runtime 负责轻量恢复，不在 onload 执行重任务 |
| `src/i18n.ts`、`styles.css` | 文案、响应式和可访问状态 |
| `tests/app/setup/*` | 状态机、恢复、错误测试 |
| `tests/presentation/setup-*` | DOM、键盘和动作测试 |

## 6. 手动实施顺序

### Step 1：先画状态与事件表

为每个状态列允许事件：`selectScope`、`saveChat`、`testConnection`、`startPrepare`、`cancel`、`retry`、`openAsk`、`openExam`。非法事件返回可诊断错误，不能悄悄跳步。

### Step 2：实现纯 setup service

先用内存 repository/fake embedding runtime/fake index coordinator 完成状态机测试。setup service 不创建 DOM，不直接读 Vault。

### Step 3：实现 knowledge scope

路径使用 Vault 相对路径并规范化；拒绝越界和不存在目标。文件过滤逻辑只存在一处，index inventory、signature 和 discovery 共用同一 scope。

### Step 4：实现聊天连接测试

测试必须由用户点击触发，并显示正在连接、成功、auth/network/model 错误。优先使用最小能力请求；若 provider 无无计费健康检查，文案要说明可能产生请求。测试成功不等于保存 API key 成功，两者分别处理。

### Step 5：连接真实 prepare 进度

用户在 Step 3 开始任务后保存 `setupId/jobId`。View 重新创建时通过 Application API 重新订阅现有 job；不要启动第二次索引。

取消后返回可继续的步骤，保留有效草稿并清临时索引。失败展示错误类别和下一动作，而不是只显示 stack trace。

### Step 6：实现首个成功动作

- **Ask my notes**：进入 Ask 页并预填一个可编辑问题，不自动发送；
- **Test my knowledge**：进入 exam setup，使用已选 scope，不自动调用 LLM；
- ready 状态持久化后再导航，防止重启重新进入向导。

### Step 7：接入主 View

主 View 根据 `needsSetup()` 决定入口。不要在 UI 里通过“有没有消息”猜。旧用户跳过策略和新旧默认由 M8 正式完成，本阶段可使用 feature flag 和测试 fixture。

### Step 8：可访问性和响应式

- 每步一个明确 heading；
- Back/Next/Cancel 是可聚焦按钮；
- 步骤切换后焦点移动到 heading；
- 进度用 `aria-live` 适度播报，不逐 chunk 刷屏；
- 错误与输入通过 `aria-describedby` 关联；
- 不只用颜色表示状态；
- 窄屏、触屏和软键盘下按钮可用。

## 7. 验证场景

### 自动测试

- 各合法/非法状态转换；
- draft 未确认时不污染正式设置；
- folder/file/vault scope 的 discovery；
- file rename/delete；
- 重开 View 重连同一 job；
- stale job event 被忽略；
- connection error 分类；
- Ask 只预填不发送；
- Test 只打开配置不调用 LLM；
- completed setup 不重复出现；
- keyboard/focus/ARIA 基本行为。

### 手工旅程

1. 全新小 Vault，current folder → 成功 Ask；
2. current note → 成功 Test；
3. 整个 Vault → 用户取消并恢复；
4. 无 active file 打开向导；
5. chat auth 失败后修改并重试；
6. 模型下载断网后重试；
7. 索引时关闭/重开侧栏；
8. 索引时重载插件；
9. 窄屏/mobile 完整走一次；
10. 用户选择的 note 被重命名或删除。

## 8. 调试练习

1. 为状态转换记录 setup ID、from/to、event、结果，不记录凭据；
2. 在每步设置断点，观察 draft 何时提交；
3. 使用 fake clock/controlled promise 模拟慢连接和乱序进度；
4. 故意在导航前崩溃，验证 completedAt 的事务顺序；
5. 用 Obsidian Developer Console 检查 View 重建后订阅数；
6. 使用键盘完成全流程并用 accessibility tree 检查名称。

## 9. 产品指标与隐私

如果暂时没有经用户同意的 telemetry，用本地开发测量和可复现人工测试：

- 打开向导到 ready 的时间；
- 首次下载与索引耗时；
- 每步错误类型；
- 首次 Ask/Test 是否成功；
- 中断恢复所需动作数。

不要为测量首次成功而新增隐藏遥测。未来若加入 analytics，需明确 opt-in、最小数据、文档和关闭方式。

## 10. 工程实践与原因

- 状态机使恢复和非法路径可测试；
- draft 与正式设置分离，Back/Cancel 不留下半配置；
- Application 层拥有 job，View 生命周期不等于任务生命周期；
- scope 是显式 union，避免路径字符串多义；
- 首动作由用户确认，避免意外费用和外发内容；
- 真实进度复用 M6，避免向导与 Header 产生两套事实；
- 可访问性在组件设计时实现，避免发布前补丁式修改。

## 11. PR 切片

1. `test: define setup state machine`；
2. `feat: add explicit knowledge scope model`；
3. `feat: add recoverable setup service`；
4. `feat: build setup wizard steps`；
5. `feat: connect real index progress`；
6. `feat: add first ask and exam actions`；
7. `fix: improve wizard accessibility and mobile layout`。

## 12. 完成标准

- [ ] 新用户只配置知识范围和聊天 LLM；
- [ ] current note/folder/vault 语义准确且可迁移；
- [ ] prepare 显示 M6 的真实阶段与计数；
- [ ] 关闭 View、取消、失败、重启都有确定恢复路径；
- [ ] API key 不进入 setup 日志或普通 state dump；
- [ ] Ask/Test 首动作不会自动产生外部请求；
- [ ] 键盘、ARIA、窄屏验证通过；
- [ ] 旧用户处理仍受 feature flag，等待 M8 矩阵；
- [ ] 自动测试、lint、build 和手工旅程通过。

## 13. 实施记录

```text
Setup schema version：
状态图偏差：
Scope 迁移：
连接测试语义：
中断恢复结果：
首次成功用时：
Accessibility：
Mobile：
未解决风险：
```
