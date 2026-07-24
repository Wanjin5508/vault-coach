# 里程碑 5.9：Issue #83 语义图谱全量覆盖与证据溯源

- 关联 Issue：[Issue #83](https://github.com/Wanjin5508/vault-coach/issues/83)
- 状态：已完成
- 范围：语义概念抽取调度、可恢复构建、构建进度、同名概念证据聚合与显式概念合并后的 evidence 投影
- 不在本里程碑范围：考试题的 chunk 级范围交接（见“后续工作”）

## 1. 里程碑目标

解决“Learning Map 中点击概念节点后，证据列表只出现一个文件”的实际问题，尤其是一个大型总览文档同时覆盖大量主题、且其他专题文档仍需被独立呈现和引用的知识库。

本里程碑的成功标准不是把用户文档改造成目录/MOC，而是让插件在**不修改原始知识库**的前提下做到：

1. 所有有效、非空的 Section 都能进入语义提取范围（受 5.10 Lite 单文件与全库预算限制；用户可显式放开单文件限制）；
2. 大型、路径靠前的文档不会饿死其他文档；
3. 每个有效概念节点可展示其真实、完整的来源证据；
4. 处理被中断或单个 Section 失败后，已完成的工作不会丢失；
5. 用户可以看见构建的总量和进度，而不是误以为“已经完成”。

## 2. 问题背景与复现

在测试知识库中，`00_prerequisites.md` 约有 4,090 行、83.8 KB、102 个标题 Section。它覆盖了大量主题，并且为许多专题文件提供了摘要。知识库总计约 498 个标题 Section。

旧实现的默认 `semanticGraphMaxSectionsPerRun = 30` 是一次语义重建的总处理上限。Section 先按文件路径进入队列，因此 `00_prerequisites.md` 的前 30 个 Section 会耗尽配额；后续文件在该次重建中完全没有进入模型抽取。

```text
旧调度（batch 上限被当作总上限）

00_prerequisites: S1, S2, …, S30  → 已抽取
01_… / 02_… / 其他专题文件         → 从未入队
```

Learning Map 只是渲染有效概念已有的 `evidence`，菜单没有“最多一个来源文件”的显示限制。因此用户看到的单文件证据是上游覆盖不足的结果，而不是弹窗本身截断了文件列表。

另一个独立问题出现在用户显式合并概念后：概念 ID 故意按 Section 隔离，以避免同名概念被系统擅自视为同一概念；但旧投影隐藏了被合并的成员概念，只保留主概念自己的 evidence，导致已确认的同一概念反而丢失其它来源。

## 3. 根因分析

| 根因 | 旧行为 | 用户可见后果 |
| --- | --- | --- |
| 配额语义错误 | `semanticGraphMaxSectionsPerRun` 截断整个手动任务 | 大型靠前文档独占抽取机会 |
| 顺序偏置 | 直接按输入/路径顺序取前 N 个 Section | 后续文档长期没有概念和 evidence |
| 中断不可恢复 | 仅在全轮结束后写入结果 | 中途取消或故障可能丢失有效工作 |
| 合并投影不完整 | 只显示 canonical 概念自身证据 | 显式合并后其它文件来源不可见 |
| 进度信息不足 | 仅有已处理/待处理的局部数据 | 用户难以判断是否仍有大量 Section 未覆盖 |

## 4. 方案设计与取舍

### 4.1 不采用的方案

| 方案 | 不采用原因 |
| --- | --- |
| 要求用户将总览文档改成 MOC 或拆分文件 | 原始文档是合法知识来源，且用户明确不能修改它 |
| 提高默认 `30` 为更大数字 | 只能推迟饥饿问题；大库仍会被截断，并增加一次模型任务成本 |
| 对每个 chunk 强制生成一个概念 | chunk 是抽取窗口，不是天然的概念；会制造大量低质量节点与伪证据 |
| 自动按相似度或别名合并跨文件概念 | 近似文本可能是不同概念，不能以 embedding 或别名候选伪造同一概念 |
| 自动同步也全量跑完 | 单个大文件变更可能触发无限制模型调用，成本和交互体验不可控 |

### 4.2 采用的行为契约

```text
手动 rebuildAll
  → 穷尽本次所有待处理 Section
  → 以可配置 batch 为 checkpoint 单位持久化
  → 在文档之间公平轮询

自动同步
  → 只处理一个 batch
  → 保留未完成 Section，等待下一次显式重建
```

这里设置值不再表达“本次最多处理多少个 Section”，而是表达“每完成多少个 Section 保存一次可恢复 checkpoint”。这保持了用户对模型用量的控制，也保证手动重建不会静默遗漏后半段知识库。

## 5. 开发规划与实际执行

| 阶段 | 计划 | 实际执行与结果 |
| --- | --- | --- |
| 5.9.1 诊断 | 确认问题发生在提取、投影还是 UI | 检查 Learning Map evidence 渲染与抽取队列，确认 UI 不限文件数，根因在队列截断和合并投影 |
| 5.9.2 调度改造 | 将手动重建改为全量、分 batch 处理 | `rebuildAll` 穷尽待处理 Section；自动同步保留单 batch 边界 |
| 5.9.3 公平性 | 避免大文件长期抢占 | 实现确定性的按文档 round-robin 调度 |
| 5.9.4 容错 | 让取消/失败后可续跑 | 每个 batch 保存一致状态；失败 Section 保留上一份有效抽取并可重试 |
| 5.9.5 证据修复 | 同一概念应保留全部真实来源 | 相同规范化概念名自动聚合 evidence；显式 merge 继续覆盖不同名称的同义概念 |
| 5.9.6 可见性 | 让用户知道真实进度 | 进度模型增加 `totalSections`，两个相关视图以“已处理/总数”显示 |
| 5.9.7 验证 | 覆盖调度、公平、持久化与投影 | 新增单元测试，并完成类型检查、lint、构建和测试套件验证 |

## 6. 技术实现

### 6.1 Section 是抽取调度和缓存的最小单位

Section 由标题范围内的已索引 chunk 组成。长 Section 保持原有窗口策略：每个直属、非空、已索引 chunk 都会成为一个提取输入窗口；仅模型真正引用的 chunk 才成为概念 evidence。

这实现了“每个**进入当前构建范围**的文件，其每个有效 Section/chunk 都能进入图谱提取范围”的要求，同时避免了“每个 chunk 强制产出一个概念”的错误语义。5.10 额外定义了 Lite 的单文件与全库范围边界，详见第 11 节。

缓存键包含 `inputHash` 和 extractor signature（provider、model、prompt version、schema version）。未变化窗口复用上次抽取；变更窗口只重提取所属 Section。

### 6.2 TypeScript 公平轮询调度

在 `src/app/semantic-graph/semantic-graph-service.ts` 中新增 `createFairSectionOrder`：

1. 将待处理 Section 按 `documentPath` 分组；
2. 每组按稳定 `sectionId` 排序；
3. 按文档路径稳定排序；
4. 每轮从每个文档取一个 Section，直到队列耗尽。

```text
新调度（两个文件）

00_prerequisites: S1 → S2 → S3 → …
01_topic:          T1 → T2 → …

执行顺序：S1, T1, S2, T2, S3, …
```

因此，即使 `00_prerequisites.md` 有上百个 Section，`01_topic.md` 的第一个 Section 也能在第一个轮次获得处理，不再被总览文档饿死。排序是确定性的，便于测试、重试和排查。

### 6.3 全量手动重建与 durable checkpoint

`refreshExtractions` 新增 `exhaustively` 和 `onCheckpoint` 参数：

- 手动 `rebuildAll` 使用完整公平队列；
- 自动同步只取第一个 batch；
- `semanticGraphMaxSectionsPerRun` 被重定义为 `batchSize`；
- 每 batch 完成后调用 `persistExtractionCheckpoint`。

checkpoint 使用 `SemanticGraphStore.save` 保存一致的 source-derived state：extractions、由它们重建的 concepts、模型候选、仍然有效的非模型候选与有效 embeddings。保存前运行完整性检查。若用户通过 `AbortSignal` 取消任务，或后续 batch 失败，已完成 checkpoint 不丢失；下一次重建只处理仍然待处理的 Section。

设置界面文案同步改为 **Semantic extraction batch size**，避免用户把它误解为总覆盖上限。

### 6.4 构建进度模型与 UI

`SemanticGraphBuildProgress` 增加：

```ts
{
  totalSections: number;
  processedSections: number;
  queuedSections: number;
  failedSections: number;
}
```

`SemanticIndexCoordinator` 统一持有该进度模型；Learning Map 和 Concept Review 视图展示 `processedSections / totalSections`。这是内存态进度，不会混入持久化的语义事实。

### 6.5 同名概念与显式合并后的证据聚合

在 `src/domain/semantic-graph/semantic-graph-projector.ts` 中：

1. 先依据用户的 `merge-concepts` decision 解析 canonical 概念；
2. 对尚未被人工重定向的 source-backed 概念，按**精确相同的 `normalizedName`**建立 display redirect；
3. 收集每个 effective canonical 概念的所有成员；
4. 对 evidence 用 `sectionId + chunkId + excerptId` 去重；
5. 按 `filePath → sectionId → chunkId → excerptId` 稳定排序；
6. 同时聚合 aliases 与 `sourceCandidateIds`。

这是一种**有效图谱/显示层聚合**：Section 级抽取记录仍独立保存，因而每个 evidence 都可回到原始 Section/chunk。相同规范化概念名（例如 `Retry` 与 `retry`）会默认显示为同一节点并汇总所有来源；相似度、别名或不同规范化名称不会自动聚合，仍需用户显式 merge。这样既能避免第一个文件遮蔽其它同名来源，也不会把模型相似度误写成事实。

## 7. 受影响模块

| 文件/层 | 改动目的 |
| --- | --- |
| `src/app/semantic-graph/semantic-graph-service.ts` | 公平调度、全量手动重建、checkpoint、失败保留与缓存复用 |
| `src/app/semantic-graph/semantic-index-coordinator.ts` | 使用统一的进度类型 |
| `src/domain/semantic-graph/semantic-graph-types.ts` | 扩展 `SemanticGraphBuildProgress.totalSections` |
| `src/domain/semantic-graph/semantic-graph-projector.ts` | 精确同名与显式合并的 provenance/evidence 聚合、稳定排序 |
| `src/presentation/views/concept-review-view.ts` | 显示已处理/总 Section 数 |
| `src/presentation/views/learning-map-view.ts` | 显示已处理/总 Section 数 |
| `src/settings.ts` | 将配置文案改为 checkpoint batch 语义 |
| `tests/app/semantic-graph/semantic-graph-service.test.ts` | 覆盖全量、公平、checkpoint 和进度 |
| `tests/domain/semantic-graph/semantic-graph-projector.test.ts` | 覆盖显式 merge 的多来源证据聚合 |

## 8. 验收与验证记录

### 自动化测试

新增服务测试以 batch size 为 `1` 构造两个文件、三个 Section：

```text
00-overview.md: Overview one
00-overview.md: Overview two
01-topic.md:    Topic
```

断言实际抽取顺序是：

```text
00-overview.md:Overview one
01-topic.md:Topic
00-overview.md:Overview two
```

同时断言：三个 Section 都被抽取、至少保存每 batch 的 checkpoint、最终进度为 `3 / 3`，且待处理/失败均为 `0`。

新增投影测试覆盖两类情况：三个来自不同文件的概念显式合并后，唯一 canonical 概念按稳定顺序保留全部 evidence；两个来自不同 Section、规范化名称同为 `retry` 的概念无需手工操作即可显示为一个节点，并列出两个文件来源。`Retry policy` 等不同规范化名称保持独立。

### 已执行检查

| 检查 | 结果 |
| --- | --- |
| `npm test` | 通过：46 个测试文件、181 个测试 |
| `npx tsc --noEmit --skipLibCheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |

### 运行时部署核查

一次真实 vault 检查发现：结构图已有 19 个文件、499 个 Section，其中 464 个非空；但语义图持久化状态只有 60 条抽取记录，且全部来自 `00_prerequisites.md`。同时被 Obsidian 加载的旧 `main.js` 仍包含旧的 `slice(0, limit)` 截断实现和旧证据投影，说明源码修改尚未重新 bundle 到运行时产物。

已重新执行 `npm run build`，生成的插件根目录 `main.js` 现包含全量 checkpoint 调度、`totalSections` 进度和同名概念 evidence 聚合。Obsidian 重新加载插件后，必须再执行一次 **Rebuild semantic concept graph**，才会以新逻辑填充此前只含 `00` 的持久化语义状态。

### 人工验收建议

1. 在含大型 `00_*.md` 和多个专题文档的 vault 中启用 semantic graph。
2. 将 batch size 设为 `1`，执行显式语义重建。
3. 观察进度从 `0 / N` 到 `N / N`，并确认不同文件交替进入模型处理。
4. 在 Learning Map 选择跨文件同名概念，显式合并。
5. 点击合并后的节点，确认 evidence 列表包含每个成员的真实文件/Section/chunk 定位。
6. 中途取消一次重建后重新开始，确认已完成 Section 不重复调用模型，未完成 Section 继续处理。

## 9. 运行与兼容性说明

- 本改动不会修改 vault 内原始 Markdown 文档，也不要求用户重组为 MOC。
- 手动重建在大库上会完成所有待处理 Section，因此模型调用量可能高于旧的、被静默截断的行为；batch size 控制 checkpoint 粒度，不是总量上限。
- 自动同步仍然有界，只跑一个 batch，防止一次编辑触发无界模型任务。需要确保整个队列完成时，用户应执行显式重建。
- 失败 Section 保留上次有效抽取并记录错误；它们会在后续重建中重试。
- evidence 会在精确相同的规范化概念名、或用户显式 merge 时汇总；相似度与规则候选不会伪造跨概念来源。

## 10. 后续工作：精确范围考试

`Test this knowledge` 目前仍按文件路径交接范围。对于“总览文件包含其他文件简介”的场景，这会把考试范围扩大到无关段落。

建议作为后续里程碑单独实现：

1. 将考试范围 schema 扩展为 `sectionId + chunkId` 的 evidence 集合；
2. 从 Learning Map 的 effective concept 直接传递该集合；
3. 在考试 UI 中展示、允许编辑并持久化所选 chunks；
4. 出题 prompt 仅使用已选证据及明确允许的同 Section 上下文；
5. 为范围迁移、权限过滤、删除/重索引后的失效证据增加测试。

该项与 5.9 的抽取覆盖、证据完整性问题相邻但不等价，因此没有为了赶工改变既有考试范围 schema。

## 11. 里程碑 5.10：Lite 构建预算、进度可见性与 Docker 交接

### 11.1 背景：全量覆盖不等于无限制本地运行

5.9 修复了“只处理第一个大文件”的错误：手动重建会公平地遍历所有待处理 Section。这意味着原先被静默遗漏的模型调用现在会真实发生。在本测试 vault 中，结构图有 19 个文件、499 个标题 Section、464 个非空语义输入窗口；其中 `00_prerequisites.md` 约有 83,840 个字符、4,090 行、102 个标题 Section，并产生约 98 个非空窗口。一次运行观察到在接近一小时后仍在持续从 `299 / 464` 向前推进，而不是死锁。

原因是每个窗口至少需要一次串行的“概念抽取”模型请求；当窗口有两个或以上候选概念时，通常还会追加一次“关系抽取”请求。抽取后还要按每批 8 个概念生成 embedding。因此文件数、字节数和 Section 数都只能近似预测耗时，最贴近实际成本的是**语义输入窗口数**。

5.10 的目标是在不回退 5.9 全量、公平、可恢复语义的前提下，为 Vault Coach Lite 增加明确的本地预算。`301–500` 个窗口仍允许用户明确选择本地构建，但先提示成本与 Knowledge Engine；`>500` 时不再启动本地任务，并明确交接到性能更强的 Knowledge Engine。

### 11.2 两层保护和用户可控边界

```text
索引完成
  → 全库容量评估（301–500：提示后允许；>500：停止本地构建）
  → 单文件 Lite 过滤（默认跳过异常大的 MD/PDF）
  → Section/window 公平轮询、checkpoint 持久化
  → 每个 checkpoint 推送进度事件和进度条
```

两层的职责不同：

| 层级 | 默认行为 | 用户能否覆盖 | 目的 |
| --- | --- | --- | --- |
| 单文件保护 | 跳过超过 Markdown/PDF 限制的来源 | 可以：设置中启用 **Include large source files** | 防止一个异常大概览、导出文档或 PDF 独占模型时间 |
| 全库容量 | 超过 Lite 预算时停止新的本地重建 | 不可以通过该开关覆盖 | 保护 Obsidian 进程、模型请求时间与本地内存；应改用 Docker 服务 |

因此，启用“大文件”只表示用户接受该文件进入图谱抽取；它不会绕过总库硬上限。

### 11.3 单文件阈值及计算依据

| 文件类型 | 默认阈值 | 判断 | 推导 |
| --- | ---: | --- | --- |
| Markdown | 60,000 字符 | 原始文本字符数 `> 60,000` | `00_prerequisites.md` 的 83,840 字符约为该阈值的 1.40 倍，并带来约 98 个窗口；60k 能覆盖普通长教程，同时将“全库总览型”来源默认隔离出 Lite 图谱。 |
| Markdown | 1,500 行 | 逻辑行数 `> 1,500` | 字符数会漏掉短行清单、表格和代码。测试文件 4,090 行约为阈值的 2.73 倍，能独立触发保护。两项是 OR，不要求同时超过。 |
| PDF | 20 MiB | 文件元数据 `fileSize > 20 × 1024 × 1024` | 现有文本索引 PDF 上限为 50 MiB；图谱需额外进行模型抽取和 embedding，采用其 40%（20 MiB）作为 Lite 默认。PDF 文件大小不能准确代表可提取文本量，所以总库窗口/字符预算仍是第二道保护。 |

阈值仅影响**语义图谱提取**，不修改原始 Markdown/PDF，也不影响已建立的文本索引、问答、考试或确定性结构图。用户若确实需要这些大文件的概念，打开 **Settings → VaultCoach → Semantic concept graph → Include large source files** 后重新构建即可；界面会显示本次默认跳过的大文件数量。

### 11.4 全库容量指标及计算过程

主指标为构建前可同步算出的语义工作量：

```text
N = count(createSectionExtractionInputs(snapshot, reader, 9000))
C = Σ window.excerpts[].text.length
```

- `N` 是整个已索引知识库在按 9,000 字符窗口切分后的总数；每个窗口至少对应 1 次概念抽取请求，因而比“文件数”或“标题数”更接近真实模型调用量。
- `C` 是整个候选窗口的文本字符总量；它补足了“许多短窗口”和“少数很长窗口”的差异。它在单文件过滤之前计算，故异常大的全库不会仅靠“跳过大文件”绕过总量保护。
- 本次观察中，`299` 个已处理窗口已经接近一小时。以约 8–12 秒/窗口的实测量级估算，`300 × 8–12s ≈ 40–60 分钟`，`500 × 8–12s ≈ 67–100 分钟`；这还不包含较多概念时的 embedding 阶段。模型、网络、语言和关系数量会改变实际时间，所以这些是预算依据而不是 SLA。

| 容量级别 | `N`（窗口数） | `C`（窗口字符） | 本地行为 |
| --- | ---: | ---: | --- |
| local | `≤ 300` | 仅作为辅助诊断，默认不因字符数阻止 | 允许手动重建与自动同步 |
| warning | `301–500` | 仅作为辅助诊断，默认不因字符数阻止 | 弹窗说明计算量较大；用户确认后允许本地手动重建，暂停自动同步，并推荐 Knowledge Engine |
| service-required | `> 500` | 仅作为辅助诊断，默认不因字符数阻止 | 不启动本地重建；弹窗要求使用性能更强的 Knowledge Engine |

语义窗口数是本地构建权限的唯一硬指标。还保留 warning-only 的辅助诊断，用来提示异常大的索引/向量状态，但它们不会让一个 `≤500` 窗口知识库被较早拒绝：窗口字符 `10 MiB`、chunks `8,000`、Section `1,000`、索引文件字节 `10 MiB`、概念 `2,000`、语义关系 `10,000`、原始 Float32 向量估算 `128 MiB`。这些辅助值不会升级为本地构建拒绝。

按此规则，当前测试 vault 的 `464` 个非空语义窗口位于允许本地继续的 `301–500` 区间：用户会先看到推荐 Knowledge Engine 的弹窗，确认后可以本地重建。`>500` 才会停止新任务。这一边界不影响已有语义图、问答、考试和确定性图。

### 11.5 实现记录

| 项目 | 实现 |
| --- | --- |
| 进度刷新 | `SemanticGraphService` 在任务开始、每个 Section 完成/失败、每个 durable checkpoint、完成/失败时发布状态；`VaultCoachApplication` 转发 `semantic-graph-state-changed`，所有已打开图谱视图随之刷新。 |
| 进度 UI | Learning Map 和 Concept Review 显示 `processed / total` 原生 progress bar，并显示“图谱构建较慢，请耐心等待。已完成的批次会自动保存。” |
| 单文件过滤 | 在创建 Section extraction inputs 前读取索引文件元数据和 Markdown 文本，按上述 MD 字符/行和 PDF 字节阈值建立 source plan；跳过来源的旧抽取记录会在下一 checkpoint 被移除。 |
| 显式大文件开关 | 新增持久化设置 `semanticGraphIncludeLargeFiles`，默认 `false`；打开后单文件过滤放行，但全库容量判断不变。 |
| 容量判断 | `GraphCapacityInput` 新增 `semanticInputCount` 与 `semanticInputCharacters`，由 `createSectionExtractionInputs` 在不调用模型的情况下计算。 |
| 容量弹窗 | 命令面板和 Concept Review 的手动重建会共享容量弹窗：`301–500` 显示继续/取消和 Knowledge Engine 建议；`>500` 只显示关闭按钮并阻止调用模型。 |

### 11.6 验证计划

1. 构造一个超过 60,000 字符的 `.md`、一个超过 20 MiB 的 `.pdf` 和一个普通 `.md`：默认重建只抽取普通文件，并在状态中报告两个跳过文件。
2. 打开 **Include large source files** 后再次重建：此前被跳过的 MD/PDF 进入公平队列；未变的普通文件复用缓存。
3. 对 `N = 300`、`301`、`500`、`501` 的容量输入分别断言 local、warning、warning、service-required；前三区间允许本地手动重建，最后一个不得启动模型任务。
4. 将 checkpoint batch size 设为 `1`：每完成一个 Section，两个图谱工作区的进度条都应更新；取消后已完成批次仍保留。
