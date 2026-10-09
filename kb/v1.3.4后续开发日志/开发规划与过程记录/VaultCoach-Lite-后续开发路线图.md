---
tags:
  - 开发过程
  - VaultCoach
  - Lite
  - LearningMap
  - AdaptiveExam
  - 开发路线图
status: implementation-complete-awaiting-manual-vault-validation
updated: 2026-07-25
depends-on:
  - 里程碑4A-学习图谱基础开发日志.md
  - 里程碑4B-知识掌握度引擎开发日志.md
  - 里程碑6.0-考试难度分级与自适应题型开发规划.md
related:
  - 三个项目协同架构与责任边界.md
  - KnowledgeEngine-Local-后续开发路线图.md
  - AI-Career-Agent-知识接口与数据契约.md
source-plan: /Users/wanjinli/code/obsidian_plugin/tech-docs/v1.3.4 重构与开发/v1.3.4 后续规划.md
---

# Vault Coach Lite：后续开发路线图

## 1. 决策与范围

VC-L5 已通过验收。下一优先级不是立即进入自适应考试或连接独立服务，而是先确保同一 Vault 更换知识域后不会恢复旧索引、图谱或掌握度；随后在完全离线、无需 Docker、无需账号的前提下继续完成 Vault Coach Lite 的学习闭环：

~~~text
带来源的对话
  → 发现知识与能力状态
  → 理解薄弱原因
  → 发起有理由的定向考试
  → 保存可追溯的评估证据
  → 获得下一步复习建议
~~~

本文将原总规划中的 M5、M6、M7 重排为以下交付阶段；其中 M6.0 是已进入实现与人工验收的前置能力。它们既是推荐开发顺序，也是后续提交、验收与回归的边界。

| 阶段                         | 对应原规划                     | 用户可见结果                                                        | 前置依赖                  |
| -------------------------- | ------------------------- | ------------------------------------------------------------- | --------------------- |
| VC-L5：能力地图工作区              | M5                        | 在 Obsidian 标签页查看 Dashboard 和有界 Learning Map                   | M4A、M4B               |
| VC-L5.8：知识域变更与派生数据生命周期     | 新增基础设施修复                  | 替换/离线修改 Vault 后不会读取旧派生数据，并可解释地回收缓存                            | VC-L5                 |
| VC-L6.0：考试模式与题型基础          | M6 前置交付（已实现，待真实 Vault 验收） | 用户在 simple/challenge 间选择；simple 为本地确定性客观题评分，challenge 使用已支持题型 | 既有 Exam/Assessment 契约 |
| VC-L6：自适应考试                | M6                        | 按薄弱、前置、低置信度状态创建有理由的考试，并复用用户选择的考试模式                            | VC-L5 查询契约、VC-L6.0    |
| VC-L7：复习建议与学习计划            | M7                        | 获得有限、可解释、可操作的复习队列，并可带可修改的考试模式建议                               | VC-L5、VC-L6、VC-L6.0   |
| VC-L8：Lite 发布加固与 Engine 接缝 | 新增收尾                      | 可靠的 Lite 发布、容量提示和未来可选服务边界                                     | VC-L5 至 VC-L7         |

这里的“简单知识图谱”是 M2/M3/M4A 已有事实的有界学习投影，不是全 Vault 无限画布；“能力地图”是图谱、掌握度、考试覆盖和建议的可解释主工作区。未来的 Local/Cloud Knowledge Engine 是性能升级，不能替代 Lite；服务不存在、不可用或被用户断开时，Ask、Exam、本地图谱、掌握度和本地数据必须保持可用。

## 2. 已有基线与不可破坏的约束

### 2.1 可复用能力

- 【src/app/learning-graph/】和【src/domain/learning-graph/】已提供 M2 结构事实与 M3 effective Concept 的学习图查询；
- 【src/app/mastery/mastery-service.ts】和【src/domain/mastery/】已提供可重算、可追溯的掌握度快照；
- 【src/exam/】、【src/domain/exam/】和【src/presentation/controllers/exam-controller.ts】已提供考试生成、评分、保存和历史记录；VC-L6.0 已新增 `ExamMode`（`simple | challenge`）、客观题答案键、确定性评分路由和与旧自由文本评分兼容的 Session 契约；
- VC-L6.0 的分析完成状态会锁定范围、文件、题量、智能筛选与考试模式；只有显式返回设置页、丢弃分析结果后才能改变这些输入；
- 【src/app/application-api.ts】已预留【ProgressApplicationApi】以及【learningGraph】、【mastery】Facade；
- 【src/presentation/views/learning-map-view.ts】、【src/presentation/controllers/learning-map-controller.ts】和【src/presentation/components/learning-graph-renderer.ts】是主工作区 Learning Map 的起点；
- 【src/domain/graph-capacity/】已有容量评估边界。

### 2.2 不可跨越的边界

1. Markdown/PDF、Assessment Session JSON、M2 结构图谱和 M3 用户决策仍是 Vault 内事实源；Dashboard、Recommendation、布局和快照均是可再生派生数据。
2. 仅 effective Concept 能参与掌握度、定向考试和高影响建议。pending/rejected 语义候选、纯 embedding 相似度和 renderer 临时状态不能进入这些计算。
3. Presentation 只能调用 Application API，不能读取 JSON Store、直接修改领域对象，或将 View 的 DOM 状态写成图谱事实。
4. 容量不足只能降低图谱呈现或提示切换 Local Engine；不能阻断对话、考试、Assessment 保存或已有掌握度读取。
5. Lite 阶段不增加联网、账号、云端同步、强制上传或 Docker 前置条件。
6. `ExamMode` 是本场考试的作答/评分策略，不是掌握度权重、能力标签或自适应选题目标；L6/L7 不得仅因用户选择 challenge 而放大或贬低 Assessment/Mastery 证据。
7. 任一已完成的范围分析、计划预览或待生成 Session 都必须绑定当时的 `ExamMode`。若用户希望切换模式，必须先返回设置页并重新分析/重新规划，不能在原结果上原地替换策略。

## 3. 阶段 VC-L5：能力地图工作区

### 3.1 目标

将 M4A 的学习图和 M4B 的掌握度转化为普通 Obsidian 主工作区标签页中的产品界面。用户应能在三步内完成：

~~~text
发现薄弱知识 → 查看证据与原因 → 启动定向考试
~~~

现有 Ask/Practice 侧栏继续保持紧凑，不在其中渲染大图画布。Concept Review 仍是 M3 图谱治理工具，不能被误当成最终学习地图。

### 3.2 实现步骤与代码落点

| 子步骤  | 变更位置                                                                                                               | 具体工作                                                                                                                | 完成结果                     |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| L5.1 | 新建【src/app/progress/】；【src/app/application-api.ts】                                                                 | 定义只读【ProgressSnapshot】、【ProgressRecommendationPreview】与完整【ProgressApplicationApi】；由应用层组合 graph、mastery、exam history | UI 获得单一、可测试查询入口          |
| L5.2 | 【src/app/vault-coach-application.ts】、【src/app/application-events.ts】、【src/app/application-container.ts】            | 装配 Progress service；在索引、有效图、掌握度、Assessment 变化后让派生状态失效并通知订阅者                                                         | 不在 onload 扫描全 Vault，刷新准确 |
| L5.3 | 【src/vault-coach-plugin.ts】、【src/presentation/views/】                                                              | 将 Progress / Learning Map 注册为稳定 View Type；提供打开命令、Ribbon 和侧栏轻量入口；复用/增强现有 Learning Map 主视图                            | 标签页可关闭、分屏、重新打开           |
| L5.4 | 【src/presentation/controllers/progress-controller.ts】、【src/presentation/views/progress-view.ts】                    | 实现 Dashboard：已评估/未评估、掌握度分布、低置信度、待复习、考试覆盖、数据新鲜度、容量状态                                                                 | 所有数字能追溯到 snapshot 与生成时间  |
| L5.5 | 【src/presentation/controllers/learning-map-controller.ts】、【src/presentation/components/learning-graph-renderer.ts】 | 添加节点状态样式、关系方向、搜索、目录/当前文件/掌握度过滤、聚焦和渐进展开                                                                              | renderer 只接收预算内的子图       |
| L5.6 | Learning Map Inspector 与 source opener                                                                             | 节点详情展示名称、Alias、掌握度/置信度/趋势、证据事件、关系、来源；支持跳转笔记和按此知识考试                                                                  | 图谱能进入学习动作                |
| L5.7 | View 生命周期、样式与测试                                                                                                    | 保存每个叶子的布局、筛选和选中状态；卸载时清理 renderer、listener、animation/timeout                                                         | 无遗留 WebGL/DOM/定时资源       |

### 3.3 数据与交互规则

- 初始视图只加载一个有意义的投影：当前笔记、所选目录、弱项集合或最近评估集合；绝不默认加载完整 Vault。
- 默认节点/边上限集中配置于 graph-capacity 领域。超过预算时显示“显示了 N/M 个节点”的原因和筛选入口，不静默截断。
- 结构节点与 Concept 节点必须在形状、颜色和 Inspector 内容上可区分；掌握度颜色只覆盖 effective Concept。
- 节点详情中的 unknown 表示缺少可绑定证据，不表示用户答错；dirty 表示图或考试事实已变化而掌握度尚未重算。
- 图谱箭头表达关系方向；边详情同时显示 relation type、来源和是否人工确认。
- Dashboard 最多展示五条解释性行动预览，不在该阶段直接改写掌握度或图谱事实。

### 3.4 验收与回归

- 通过命令或 Ribbon 在主工作区打开 Learning Map；关闭后重新打开，状态合理恢复且不重复注册资源。
- 在普通 Vault 中完成“弱项 → 原因 → 定向考试”路径；空图、无考试历史、dirty snapshot、容量降级和读取失败都有明确状态。
- Ask/Practice 侧栏中不出现图谱画布，既有会话、考试和索引按钮行为不变。
- 最大投影仅渲染预算内节点/边；筛选、聚焦和渐进展开不会意外全量读图。
- 执行【npm run build】、【npm run lint】、【npm test】与【git diff --check】，并完成主工作区打开/关闭手动验证。

### 3.5 实施记录

- [x] L5.1：已新增 Progress read model、聚合服务、Application Facade 与测试。详见【里程碑5-能力地图工作区开发日志】。
- [x] L5.2：已实现惰性缓存、既有事件失效、并发读取合并与 revision 保护。
- [x] L5.3：已注册稳定的 Progress 主工作区 View、命令、Ribbon 与侧栏轻量入口；打开时不读取 Progress snapshot。
- [x] L5.4：已实现按需读取的本地 Dashboard，展示可追溯的概念、覆盖、掌握度、考试、证据质量、新鲜度与容量状态。
- [x] L5.5：Learning Map 已完成有界 Canvas、探索、筛选、方向和可读性优化。
- [x] L5.6：Inspector 已展示可追溯 Mastery 摘要、来源跳转，并能以来源文件范围进入既有考试流程。
- [x] L5.7：Learning Map 每个 leaf 已保存筛选、选择和固定节点；renderer/observer/timer 生命周期已完成回归。

### 3.6 VC-L5.8：知识域变更与派生数据生命周期

VC-L5 完成后发现，持久化快照只验证索引设置，不能发现插件关闭期间发生的整库替换。VC-L5.8 在 VC-L6 前增加来源 inventory、一致性门、可再生数据回收、语义治理记录的用户确认边界，以及 semantic embedding 的二进制存储与 shard GC。详细设计、代码落点、测试矩阵与 Definition of Done 见【里程碑5.8-知识域变更与派生数据生命周期开发规划】。

## 4. 阶段 VC-L6：自适应考试

### 4.1 目标

考试从“按范围随机生成”升级为“在用户明确选择的范围内，根据学习证据规划目标”。VC-L6.0 已解决“以何种作答形式出题”的基础问题：simple 固定为可本地确定性评分的客观题，challenge 才允许在已支持的客观题与自由文本题中选择。VC-L6 继续解决“为什么考、考哪些知识”的问题；规划负责选择与解释，既有 ExamEngine 仍负责题目生成、评分、保存和导出，因此图谱、掌握度和 UI 状态不会耦合进模型调用。

M6.1–M6.7 的领域契约、Application 组装、Engine 桥接、持久化、状态机、Assessment 接缝与测试门禁见【里程碑6.1-6.7-自适应考试技术设计与开发规划】。

输入仅包括：用户选择范围与题数、**自适应目标模式**、已锁定的 **考试模式 `ExamMode`**、effective Concept catalog、掌握度快照、确认的前置关系和最近 Assessment 覆盖。输出是稳定排序的【ExamPlan】与有限【ExamTarget】列表。

两种模式刻意保持正交，避免把题型难度误作学习结论：

| 维度 | 负责的问题 | 值 | 不负责的事情 |
|---|---|---|---|
| 自适应目标模式 | 为什么考、优先考哪些 Concept | `diagnostic`、`weak-review`、`prerequisite`、`mixed` | 不决定 UI 题型、不得改写评分 |
| 考试模式 `ExamMode` | 用户如何作答、采用哪条评分路由 | `simple`、`challenge` | 不提高 mastery 权重、不代表用户能力等级 |

默认继续采用 simple，确保快速检查的结果可由答案键在本地复现；challenge 是用户主动选择的题型策略，不是 Planner 自动升级给用户的难度标签。

| 模式 | 选题倾向 | 证据不足时的降级 |
|---|---|---|
| diagnostic | 未评估、低置信度 Concept | 范围内的确定性基础题计划 |
| weak-review | weak/developing、到期复习 Concept | 范围内已知 Concept |
| prerequisite | 已选目标的确认前置节点 | 无有效前置边时回退 diagnostic |
| mixed | 上述信号的有界组合 | 显示实际采用的信号 |

Embedding 相似度、pending/rejected 关系、历史 Markdown 报告和 Concept 名模糊匹配均不得参与规划。

### 4.2 实现步骤与代码落点

| 子步骤  | 变更位置                                                              | 具体工作                                                                       |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| L6.1 | 新建【src/domain/adaptive-exam/】                                     | 定义【ExamPlanningInput】、【ExamTarget】、【ExamPlan】、理由代码与完整性校验；输入显式区分 adaptive target mode 与 `ExamMode`，固定输入必须得到固定计划 |
| L6.2 | 新建【src/app/exam/adaptive-exam-planner.ts】                         | 从 learning graph、mastery、Assessment history 构造规划输入；处理空快照、dirty、容量状态和范围变更；不将 `ExamMode` 当作能力信号 |
| L6.3 | 【src/exam/exam-engine.ts】、【src/exam/exam-blueprint-service.ts】    | 增加可选已选目标输入；只把确定的 target/source evidence 与已锁定 `ExamMode` 送入原有蓝图和题目服务，不让 ExamEngine 查询图谱/掌握度，也不改写 M6.0 评分路由 |
| L6.4 | 【src/app/application-api.ts】、【src/app/vault-coach-application.ts】 | 扩展 Exam API：预览计划、按计划创建 session；保存 Session 时同时记录 plan version、目标、理由与 `examMode` |
| L6.5 | 【src/presentation/controllers/exam-controller.ts】和考试 View         | 增加目标模式、计划摘要、每题“为什么考它”；`ExamMode` 仍只能在设置阶段选择，分析/计划预览出现后必须返回设置页才可变更；保留当前手动范围考试，不能强制自适应模式 |
| L6.6 | Assessment 绑定与 M4B 接缝                                             | 将题目目标稳定写入 AssessmentEvent 的 Concept 绑定；保留既有 deterministic/model evaluator metadata，不能安全解析时保留未绑定证据，绝不猜测 |
| L6.7 | domain/app/presentation tests                                     | 覆盖固定性、关系过滤、低数据降级、短期重复限制、模式锁定/返回重规划、simple 零模型评分、challenge/旧自由文本回归，以及提交后只更新受影响 Concept |

### 4.3 验收与回归

- 同一范围、快照、时间、历史和 `ExamMode` 输入始终产生同一顺序的计划；计划输出必须可审计地记录这两个模式维度。
- 每个被选 Concept 显示选择原因、当前状态、验证目标和来源；缺失证据时明确说明降级。
- 用户仍可使用原范围考试；自适应规划失败不能使提交、保存、报告导出失败。
- simple 的自适应考试只出现可本地确定性评分的客观题；challenge 的题型选择遵循 M6.0 已支持的受限工作流，且不得改变旧自由文本评分。
- 用户必须在返回设置页后才能切换 `ExamMode` 并触发重新分析/规划；不得在已有计划或待生成 session 上静默替换模式。
- 题目只获得最小的限定资料、目标列表和已锁定的模式策略；模型输出不得突破既有来源/范围约束。

## 5. 阶段 VC-L7：复习建议与学习计划

> 实施状态（2026-07-25）：L7.1–L7.7 的 Lite 本地链路已实现并通过自动化回归；详细边界、存储格式和手工验收见《里程碑7-复习建议与学习计划开发记录》。日历/提醒只保留 opt-in adapter 接缝，不接入任何外部服务。

### 5.1 目标

把能力地图和考试结果转为少量、可解释、用户可控制的行动项，形成长期回访闭环。建议系统不是待办清单替代品，也不是不可解释的单一分数排序。它可以根据建议的学习动作提出 **simple** 或 **challenge** 作为下一场考试的默认作答策略，但该建议不影响优先级、掌握度或考试结果，且用户始终可以在考试设置页修改。

新建【src/domain/recommendation/】和【src/app/recommendation/】。核心对象如下：

~~~text
Recommendation（派生结果，可重算）
  - id / algorithmVersion / generatedAt
  - type: review-concept | review-prerequisite | practice-topic | explore-gap
  - targetConceptIds / priority / reasonCodes
  - mastery / confidence / lastAssessedAt / nextReviewAt
  - evidenceRefs / suggestedAction / optional suggestedExamMode

ReviewActionEvent（用户事实）
  - recommendationId / action / at / optional note
~~~

Recommendation 可删除重建；ReviewActionEvent 单独保存，不修改 Concept、关系或考试得分。用户点击“已阅读”最多更新界面状态和人工复习元数据；只有真正提交并保存考试证据才可改变 mastery score。

### 5.2 实现步骤与代码落点

| 子步骤 | 变更位置 | 具体工作 |
|---|---|---|
| L7.1 | 【src/domain/recommendation/】 | 确定性排序：弱项、置信度、复习到期、近期覆盖、确认前置关系、局部图重要性；版本化权重和理由代码。`suggestedExamMode` 只能由可解释的行动类型导出，不能作为 priority/mastery 权重 |
| L7.2 | 【src/app/recommendation/recommendation-service.ts】 | 输入 Mastery、LearningGraph、Assessment、ReviewActionEvent，输出最多五项主建议和可分页队列；不依赖 renderer，也不把 deterministic/model evaluator 类型误读为能力高低 |
| L7.3 | 新建 Review Action Store | 以 schema/version 存储 dismiss、defer、complete 行动事实；删除派生建议不丢失用户操作 |
| L7.4 | 【src/app/application-api.ts】与 Progress API | 暴露只读建议、行动提交、重新计算和 Markdown 导出；图或 mastery 变化时失效重算 |
| L7.5 | Progress Dashboard 与 Learning Map | 显示解释卡片、来源跳转、启动 targeted exam、稍后处理/忽略/恢复；可预选但不强制 `suggestedExamMode`，用户仍须在考试设置页确认，分析后遵循“返回才可改模式”的锁定规则；不以 modal 阻塞 Ask/Exam |
| L7.6 | 导出与未来集成 seam | 导出用户选定计划为 Markdown；只定义 Reminder/Calendar adapter，不接入第三方日历或后台网络请求 |
| L7.7 | tests 与可访问性 | 测试排序固定性、忽略/恢复可逆性、来源跳转、无 evidence 降级和键盘/屏幕阅读器文案 |

### 5.3 验收与回归

- 任何建议均显示原因、关联知识、掌握度、置信度、最近评估时间、建议操作和来源。
- “忽略”“稍后处理”“完成”均可撤销或恢复；用户操作不会不可逆地污染图谱。
- 可从建议进入来源或带目标的考试；若带有 `suggestedExamMode`，必须显示理由并允许用户在分析前更改。完成考试后仅更新相关状态。
- simple/challenge 选择本身不得改变建议优先级、掌握度权重或“已完成”的判定；建议只消费有来源的 Assessment 事实。
- 无考试历史时显示“尚无足够证据”的合理起点，不能输出貌似精确的结论。

## 6. 阶段 VC-L8：Lite 发布加固与 Engine 接缝

> 实施状态（2026-07-25）：离线 Lite fallback、版本化 Engine port、最小化同步 DTO adapter、自动化测试和使用说明已完成；真实 Docker 服务、loopback health handshake、用户同步范围设置与服务端删除流程属于独立 Knowledge Engine 的 KE-0 至 KE-7。详见《里程碑8-Lite发布加固与KnowledgeEngine接缝开发记录》。

### 6.1 目标

Lite 功能完成后，先把边界、迁移和性能提示稳定下来，再开始独立 Knowledge Engine 实现。本阶段不连接真实服务、不要求 Docker；它避免未来服务接入时破坏成熟的本地产品。

### 6.2 实现步骤

1. 对 Ask、Exam、Learning Map、Recommendation、本地存储执行端到端回归；Exam 覆盖 simple 本地确定性评分、challenge 混合题型、旧自由文本评分和“分析后返回才可改模式”的状态机，修复把 Engine 可用性误当作 Lite 可用性的逻辑。
2. 将本地图谱容量、索引规模、构建耗时和设备能力判断集中在 Application/Domain 边界；超过门槛时提示“可选 Local Engine”，但继续提供有界投影和所有 Lite 功能。
3. 在【src/app/engine/】定义尚未联网的【KnowledgeEngineClient】、【KnowledgeEngineAvailability】和版本化 DTO adapter；实现【LiteEngineClient】作为本地降级实现。
4. 只为未来同步导出用户明确选择的内容变更、confirmed graph facts、Assessment evidence 和 Knowledge Profile 候选；绝不默认纳入 Vault 全量内容、聊天上下文或密钥。
5. 补齐 JSON schema 迁移、损坏快照恢复、隐私说明、离线行为、数据删除说明和性能诊断导出。

### 6.3 Lite 发布 Definition of Done

- [ ] 无 Engine 时，Ask、Exam、Learning Map、掌握度、推荐、历史和导出完整可用。
- [ ] 图谱始终有节点/边预算、容量提示、过滤和渐进展开；不会因大 Vault 全量渲染。
- [ ] 对话保持现有来源范围与会话行为；不以重写聊天功能为代价引入新依赖。
- [ ] 考试、掌握度和建议的高影响结论都能回溯到 effective Concept 与 Assessment/来源证据。
- [ ] 图谱治理、考试和复习操作可恢复、可撤销，或有明确事实记录。
- [ ] 从空 Vault、小 Vault、已有历史 Vault 到容量降级 Vault 均有可理解状态。
- [ ] 通过 build、lint、完整测试、差异检查和 Obsidian 手动验收，并完成 Lite 使用说明。

## 7. 推荐提交顺序

每个小步骤先提交独立领域/API 变更，再提交 UI，最后提交测试、文档和样式；不要将布局重构、算法改动和功能交互混在一个提交中。

~~~text
VC-L5.1/2 API 与查询测试
→ VC-L5.3/4 Dashboard View
→ VC-L5.5/6 Learning Map 交互
→ VC-L5.7 生命周期与回归
→ VC-L5.8 来源 inventory、数据一致性门与派生数据回收
→ VC-L6.0 考试模式/题型与评分路由（已实现；完成真实 Vault 验收）
→ VC-L6 领域规划
→ VC-L6 ExamEngine/API/UI
→ VC-L6 测试与手动验收
→ VC-L7 推荐领域与事实存储
→ VC-L7 Dashboard 交互与导出
→ VC-L8 加固、迁移、性能提示与 Engine 接缝
~~~

完成 VC-L8 后，才进入【KnowledgeEngine-Local-后续开发路线图】的 KE-0。这样独立服务是对已验证 Lite 产品的性能升级，而不是替代尚未完成的用户体验。
