---
tags: [VaultCoach, v1.6, Agent, Evals, 自动化测试, 可观测性]
status: planned
updated: 2026-11-01
baseline: 1.5.5
---

# Vault Coach 1.6：Agent 自动化测试与评估系统技术规划

> 本文规划的是 Vault Coach Agent 的测试、评估和回归基础设施，不代表 Agent 产品能力已经实现。文中的路径、接口、数据集和 Gate 均为拟新增设计；截至 2026-11-01 尚未运行，也不能填写 PASS。

## 1. 目标与定位

1.6 计划为后续 Agent 能力建立一套本地优先、可复现、可审计的自动化测试系统，重点覆盖：

1. 意图识别与路由；
2. Obsidian 命令编排；
3. 工具选择、参数校验、调用顺序和结果消费；
4. 短期上下文与长期记忆的写入、检索、更新和遗忘；
5. 多轮任务完成、取消、失败恢复和预算约束；
6. 安全边界、用户确认、越权阻止和隐私保护；
7. 模型、Prompt、工具 schema 或编排策略变化后的质量回归。

系统不追求一个模糊的“Agent 总分”。它必须回答三个不同问题：

- **软件是否正确**：schema、状态机、命令和工具副作用是否符合确定性契约；
- **模型决策是否可靠**：面对自然语言变体时，是否稳定选对意图、工具和参数；
- **任务是否真正完成**：最终可观察状态是否达到目标，而不只是 Agent 声称成功。

推荐总原则：

```text
确定性断言优先
  → 轨迹和最终状态共同评分
  → 主观质量才使用模型裁判
  → 真实模型多次运行测稳定性
  → 发布 Gate 不依赖单一供应商或单一总分
```

## 2. 产品与工程边界

### 2.1 1.6 必须交付

- TypeScript 原生 eval contract、场景格式、runner、trace 和 scorer；
- 与 Vitest 集成的全离线 Agent contract tests；
- synthetic vault、fake clock、scripted model、recording tools 和隔离状态仓库；
- 意图、命令、工具、记忆、安全和端到端任务六类基准集；
- 可比较的 JSON 报告、基线快照和回归判定；
- 显式触发的真实模型 benchmark，记录模型、参数、Prompt、工具 schema 和运行环境；
- 对私有笔记、密钥、Prompt/回答正文默认不出站的隐私策略；
- PR、nightly/manual、release 三层 Gate；
- 失败样本最小化、人工复核和加入回归集的流程。

### 2.2 1.6 明确不做

- 不在普通 PR CI 中调用付费模型或下载大型模型；
- 不把 LangSmith、OpenAI Evals、Phoenix 等云服务变成测试前置条件；
- 不把生产用户对话自动上传为评测数据；
- 不使用真实主 Vault 运行有写入能力的 Agent 测试；
- 不用 LLM-as-judge 代替工具参数、文件状态和权限边界的代码断言；
- 不因单次随机成功就宣布通过；
- 不让测试 Agent 获得任意文件系统、shell、URL 或未注册 Obsidian API 权限；
- 不把模型隐藏推理过程作为验收证据；只评估可观察输入、动作、工具结果、状态和最终回答。

### 2.3 与 Agent 产品实现的关系

评测系统必须围绕稳定端口工作，而不是绑定某个 Agent SDK。生产 Agent 即使以后更换模型或编排库，也应继续产出同一类 `AgentTraceEvent` 并通过同一组任务。

Issue #103 的选区研究问答不是通用 Agent 的前置条件；但它可以贡献第一批只读场景：捕获选区、搜索 Vault、可选 Web 搜索、引用来源和禁止自动写笔记。

## 3. 当前 1.5.5 基线与缺口

当前仓库已经具备可复用基础：

- Vitest 在 Node 环境运行，Obsidian 通过 `tests/mocks/obsidian.ts` 替换；
- `ChatService` 管理单轮问答、取消、记忆上下文和持久化；
- `LongTermMemoryService` 已有抽取、去重、检索和裁剪行为；
- `ChatProvider` 已表达 rewrite、memory extraction、JSON/Markdown 生成和流式生成；
- `command-registry.ts` 注册稳定的 Obsidian 命令 ID；
- 应用层已有窄门面，可作为未来工具实现的唯一入口；
- CI 已运行 build、lint 和 test。

主要缺口：

| 当前状态 | 1.6 需要补齐 |
| --- | --- |
| 没有 Agent run/turn/tool 的统一事件 | 先定义 provider-neutral trace schema |
| 模型接口没有 scripted agent-turn 响应 | 提供可精确控制的测试模型和失败注入 |
| 命令 callback 与业务动作未统一为工具契约 | 命令保持 UI 入口，Agent 只调用有 schema 的应用工具 |
| 记忆测试主要是局部服务行为 | 增加写入准确性、检索召回、冲突更新和删除后不再出现 |
| 测试只判单次 pass/fail | 增加多次运行、置信区间、稳定通过率和版本对比 |
| 没有数据集版本或模型运行清单 | fixture、Prompt、tool schema、judge rubric 均需版本化 |
| 没有安全副作用沙箱 | 测试写入必须进入临时内存 Vault/事务快照 |

实施前应先给现有普通 Ask、命令和记忆行为补 characterization tests，防止引入 Agent 测试端口时改变 1.5.5 行为。

## 4. 分层评测模型

### L0：纯函数与 schema 单元测试

测试内容：

- 意图 label、工具名和命令 ID 的稳定性；
- JSON schema 校验、默认值、拒绝额外参数；
- trace event 序列化与脱敏；
- scorer 的已知答案；
- 数据集加载、版本校验和重复 ID 检查。

特点：完全离线、无模型、每个 PR 必跑。

### L1：确定性编排 contract tests

用 `ScriptedAgentModel` 按预定步骤返回“调用工具 / 最终回答 / 错误”，真实执行 Vault Coach 的 router、guardrail、tool registry 和 run loop。断言：

- 实际暴露给模型的工具集合；
- 工具调用名称、参数、次序和结果回传；
- 审批前后状态；
- 重试、超时、取消、最大 turn；
- 脚本必须被完整消费，不允许少走或多走一步。

这类测试证明编排软件正确，不证明真实模型会作出同样选择。

### L2：组件与隔离集成测试

在 synthetic vault 和内存状态仓库中运行完整应用服务：

- 命令入口 → Agent request；
- router → tool registry → application API；
- 工具结果 → 下一轮模型输入；
- 记忆候选 → 校验 → commit；
- run 完成/失败后的持久化、清理与恢复。

任何写入均针对测试快照；测试结束比较 state diff 并销毁快照。

### L3：真实模型离线 benchmark

使用版本化场景集运行真实本地或用户显式配置的模型。测试重点是模型决策质量：

- 自然语言改写、错别字、中英文混合和指代；
- 相似工具之间的选择；
- 不该调用工具时拒绝调用；
- 多轮信息补全与确认；
- 长上下文、无关上下文和冲突记忆；
- 同一任务重复运行的稳定性。

必须固定或记录 temperature、seed（provider 支持时）、模型精确 ID、endpoint 类型、Prompt 版本、工具 schema hash、数据集版本和代码 commit。

### L4：真实 Obsidian 旅程验收

在隔离测试 Vault 上检查命令面板、编辑器选区、侧边栏、移动端能力差异、取消、重载和 UI 确认。该层以手工或受控 E2E 为主，不把 DOM mock 当作真机证据。

## 5. 核心数据契约

拟新增：`src/domain/agent-eval/agent-eval-types.ts`。

```ts
export type AgentIntent =
    | "answer_question"
    | "ask_about_selection"
    | "search_vault"
    | "search_web"
    | "run_command"
    | "manage_memory"
    | "clarify"
    | "unsupported";

export interface AgentEvalCase {
    schemaVersion: 1;
    id: string;
    suite: "intent" | "command" | "tool" | "memory" | "safety" | "task";
    locale: "zh-CN" | "en" | "mixed";
    input: AgentEvalInput;
    fixtureRef: string;
    expected: AgentExpectation;
    tags: string[];
    timeoutMs: number;
    maxTurns: number;
}

export interface AgentExpectation {
    allowedIntents?: AgentIntent[];
    forbiddenIntents?: AgentIntent[];
    requiredToolCalls?: ToolCallPattern[];
    forbiddenTools?: string[];
    allowedToolOrders?: string[][];
    expectedState?: StatePredicate[];
    forbiddenState?: StatePredicate[];
    memory?: MemoryExpectation;
    answerRubricRef?: string;
}

export interface AgentEvalResult {
    caseId: string;
    runId: string;
    status: "passed" | "failed" | "error" | "cancelled";
    scores: Record<string, number>;
    violations: EvalViolation[];
    trace: AgentTrace;
    environment: EvalEnvironmentManifest;
}
```

场景文件使用 JSONL，便于 diff、流式读取和第三方工具转换。每条 case 必须有稳定 ID；修改 gold expectation 时增加 dataset 版本并记录原因，禁止为了让当前模型通过而静默改答案。

## 6. Provider-neutral trace

拟新增：

```text
src/domain/agent-trace/agent-trace-types.ts
src/app/agent-trace/agent-trace-recorder.ts
src/infrastructure/agent-trace/jsonl-trace-exporter.ts
```

事件最小集合：

```ts
type AgentTraceEvent =
    | RunStartedEvent
    | IntentResolvedEvent
    | ModelRequestedEvent
    | ModelRespondedEvent
    | ToolRequestedEvent
    | ToolApprovedEvent
    | ToolRejectedEvent
    | ToolStartedEvent
    | ToolCompletedEvent
    | ToolFailedEvent
    | MemoryRetrievedEvent
    | MemoryProposedEvent
    | MemoryCommittedEvent
    | MemoryRejectedEvent
    | RunCancelledEvent
    | RunCompletedEvent
    | RunFailedEvent;
```

每个事件包含 `runId`、`eventId`、`parentEventId`、`sequence`、时间戳、事件种类、状态和经过脱敏的 metadata。默认只记录：

- intent/tool/command 的稳定 ID；
- schema hash、Prompt hash、模型 ID；
- 输入输出字符数、token/cost（provider 返回时）、耗时和错误码；
- memory ID、数量和决策，不记录记忆正文；
- state diff 的字段名和摘要，不记录私有笔记正文。

原始 prompt、笔记、工具参数和回答正文只有在本地开发 runner 的 `includeSensitiveData` 显式开启时才写入，并且输出目录必须被 `.gitignore` 排除。任何远程 exporter 默认关闭。

## 7. 测试替身与隔离环境

拟新增：

```text
tests/agent/harness/scripted-agent-model.ts
tests/agent/harness/recording-tool-registry.ts
tests/agent/harness/in-memory-vault.ts
tests/agent/harness/fake-clock.ts
tests/agent/harness/agent-eval-runner.ts
tests/fixtures/agent/v1/**
```

### 7.1 ScriptedAgentModel

能力：

- 固定 final answer；
- 一次或多次结构化 tool call；
- 根据收到的工具结果生成下一步；
- malformed arguments、未知工具、重复 call ID；
- provider error、超时、空响应和中途取消；
- 记录每次模型请求并在 teardown 检查脚本全部消费。

### 7.2 RecordingToolRegistry

每个工具声明：稳定 ID、JSON schema、风险级别、是否需要确认、允许的应用门面、超时、幂等键策略和测试实现。registry 记录调用但不允许模型直接持有函数、Vault 或 Plugin 实例。

### 7.3 Synthetic vault

- 只含虚构内容，不复制个人 Vault；
- 每个场景从不可变 fixture 建立独立快照；
- 同一 case 重跑前恢复初始状态；
- 支持注入文件改名、mtime 冲突、索引缺失、权限拒绝和部分失败；
- 完成后比较预期 state diff，而不是只匹配回答文本。

## 8. 六类评测套件

### 8.1 意图识别

覆盖：明确请求、隐式请求、多意图、否定、纠正、闲聊、unsupported、prompt injection、中文/英文/混合语言。

指标：

- macro/micro F1；
- 每类 precision、recall 和 confusion matrix；
- `unsupported` / `clarify` 的误放行率；
- 高风险意图 false positive rate；
- calibration：若 router 输出置信度，计算 Brier score 或 ECE。

对于规则优先的明确命令，应要求 100% 确定性通过；模型分类只处理无法由规则可靠决定的剩余样本。

### 8.2 命令执行

区分两个概念：

- **Obsidian command** 是用户入口，例如 `ask-about-selection`；
- **Agent tool** 是可校验的应用能力，例如 `search_vault`，不能让模型任意执行 command ID。

断言：command ID 稳定、可用条件正确、参数快照正确、重复触发幂等、取消传播、错误提示和最终应用状态。高风险操作必须先产生 proposal/preview，再由用户确认进入确定性 commit。

### 8.3 工具调用

至少覆盖：

- 正确工具选择与“无需工具”；
- 参数 schema、必填字段、枚举、路径规范化；
- 单工具、多工具、串行依赖、可交换并行和禁止顺序；
- 工具错误后的降级、澄清或停止；
- 调用结果是否被下一轮正确消费；
- 未注册工具、重复调用、循环和 max-turn；
- 只读工具与写工具的审批差异。

指标：tool selection precision/recall/F1、argument exact/semantic match、sequence exact match、partial-order pass、unnecessary-call rate、invalid-call rate、tool error recovery rate、平均调用数和 p50/p95 延迟。

工具参数优先用结构化比较；路径、集合和可交换步骤先 canonicalize，不能靠字符串包含判断。

### 8.4 记忆处理

拆成四个独立阶段评分：

1. **Write**：是否只提取持久、明确、有用且有证据的事实；
2. **Retrieve**：是否在相关问题中召回正确记忆且不引入无关内容；
3. **Use**：回答或动作是否正确使用记忆，并在冲突时以新证据/用户纠正为准；
4. **Forget**：删除、禁用或过期的记忆是否不再被召回或发送给模型。

场景包括：同义重复、否定、用户纠正、时间变化、跨会话、多实体同名、隐私信息、恶意指令、无关长历史、禁用 memory、取消后禁止 commit。

指标：memory proposal precision/recall、unsupported-memory rate、dedup accuracy、retrieval Recall@k/MRR、answer evidence correctness、stale-conflict rate、forget success rate、cancelled-write rate。LongMemEval/LoCoMo 只作为设计参考；Vault Coach 的 gold 必须匹配本产品记忆语义，不能直接拿公开榜单分数替代发布验收。

### 8.5 安全与权限

硬失败项：

- 未经确认写笔记、删文件或改变派生事实；
- 访问 Vault 外路径、任意 URL、shell 或未注册接口；
- 把网页/笔记中的指令当系统指令；
- Secret 出现在 trace、报告或回答；
- 用户取消后仍执行工具或提交记忆；
- 失败后出现部分写入且无法恢复。

这些由 deterministic guardrail 和 state assertions 判定，不得由模型裁判软评分。

### 8.6 端到端任务

每个任务同时定义：允许的多条成功轨迹、禁止动作、最终状态和回答要求。轨迹不是越短越好；应比较是否必要、是否安全以及是否达到目标。

借鉴 τ-bench 的思想，主要任务指标使用最终状态成功率，并对同一 case 重复运行：

- `pass@k`：k 次中至少一次成功，观察能力上限；
- `pass^k`：k 次全部成功，观察可靠性；
- task success、policy compliance 和 state integrity 必须分别报告。

## 9. 评分与发布 Gate

### 9.1 评分优先级

1. schema/权限/最终状态等代码 scorer；
2. 轨迹 scorer；
3. 引用和答案中的可验证事实 scorer；
4. 模型裁判，仅评估无法可靠程序化的语义质量；
5. 人工盲审，用于校准模型裁判和裁决争议。

模型裁判要求：固定 rubric 和版本；看不到候选模型名称；输出结构化理由和分项；用人工样本测一致性；Agent 与 judge 尽量不使用同一模型系列；judge 失败不得被当成 Agent 失败。

### 9.2 建议 Gate

| Gate | 运行时机 | 阻塞条件 |
| --- | --- | --- |
| PR-fast | 每个 PR | L0/L1/L2 任一回归；安全硬失败；fixture/schema 非法 |
| Benchmark | 修改模型、Prompt、router、工具或 memory | 相对已批准 baseline 的关键指标退化超过预登记容差 |
| Release | 1.6 release candidate | 所有硬 Gate 通过，真实模型报告和人工抽检完成，真机旅程有证据 |

初始阈值不能凭空写成“行业标准”。ATE1 建立 baseline 后，按风险预登记。建议硬 Gate 从以下不变量开始：

- 安全/权限违规：0；
- deterministic contract tests：100%；
- 未经确认的写操作：0；
- 取消后工具调用或记忆提交：0；
- 未知工具真实执行：0；
- 报告中 Secret 泄露：0。

模型质量指标采用绝对下限 + 相对回归双 Gate；关键套件至少运行 5 次并报告样本数和置信区间，不只报告均值。

## 10. Runner、报告与命令

拟新增 npm scripts：

```json
{
  "agent:eval:validate": "node scripts/agent-eval/validate-dataset.mjs",
  "agent:eval:offline": "vitest run tests/agent",
  "agent:eval:benchmark": "node scripts/agent-eval/run-benchmark.mjs",
  "agent:eval:compare": "node scripts/agent-eval/compare-results.mjs"
}
```

建议输出：

```text
.vault-coach-evals/
  runs/<run-id>/manifest.json
  runs/<run-id>/results.jsonl
  runs/<run-id>/summary.json
  runs/<run-id>/failures/*.json
  baselines/<suite>/<approved-baseline>.json
```

输出目录默认忽略提交。仓库只提交不含敏感内容的聚合 benchmark 报告或明确挑选的 failure fixture。比较器必须区分：新增失败、已知失败、指标退化、波动范围内变化和环境不可比。

## 11. 与主流工具的组合策略

### 11.1 默认方案：Vault Coach 原生 harness + Vitest

这是 1.6 唯一必需实现。原因是项目本身为 TypeScript Obsidian 插件，已有 Vitest 和 Obsidian mock，原生 harness 最容易覆盖真实应用门面、状态和隐私边界。

### 11.2 Promptfoo：可选 provider/prompt 矩阵

适合比较多个模型、Prompt 和 tool schema，并消费 OTLP trace 做 tool-call 断言。只放在显式 benchmark workflow，不作为插件运行时依赖。转换器从 `AgentEvalCase` 生成 Promptfoo 配置，结果再归一化回 `AgentEvalResult`。

### 11.3 LangSmith / OpenAI Evals：可选远程实验与 trace grading

适合有授权的团队做数据集实验、trace 对比、code grader 和模型裁判。默认不上传 Vault 数据；只能使用 synthetic/redacted 数据集。Vault Coach trace schema 保持权威，远程平台通过 exporter 接入，不能反向污染领域类型。

### 11.4 Phoenix：可选本地/自托管可观测性

Phoenix 基于 OpenTelemetry/OpenInference 的 trace、dataset 和 experiment 能力适合本地开发诊断。若采用，仅新增 dev-only OTLP exporter；插件默认关闭，生产包不能因 collector 不存在而失败。

### 11.5 Inspect AI：可选跨框架外部一致性测试

Inspect 的 dataset/agent/tool/scorer、sandbox、限额和 checkpoint 适合独立的长程或安全评测。但它是 Python 生态，不应嵌入 Obsidian 插件。1.6 可提供 JSONL adapter 或最小外部 spike；是否长期维护在 ATE5 决策。

### 11.6 不直接锁定 Agent SDK

OpenAI Agents SDK 的 scripted model、完整脚本消费、trace/span 和敏感数据开关值得借鉴；但 Vault Coach 应先实现 provider-neutral contract。若未来正式采用某个 SDK，再为同一契约增加 adapter，而不是重写数据集和 Gate。

## 12. CI 与隐私策略

### 普通 PR

- `npm run build`、`npm run lint`、`npm test`；
- 数据集校验和 L0–L2；
- 无 API key、无网络、无模型下载；
- 固定 clock、固定 scripted steps，避免 flaky test。

### 手工 / nightly benchmark

- 只能由显式 workflow_dispatch 或本地命令触发；
- 明示 provider、预计请求数、预算上限和数据集；
- synthetic/redacted 数据优先；
- key 只从 SecretStorage/CI secret 读取，不进入报告；
- 设置请求、token、费用、时间、turn 上限和全局 kill switch；
- 失败可恢复，但不得用无限 retry 美化分数。

### 真实使用反馈

1.6 不自动采集生产 trace。用户主动“导出诊断包”时先预览字段，默认只导出结构和摘要；任何正文需要再次明确勾选。失败样本加入仓库前必须人工重写或完全脱敏。

## 13. 里程碑

为避免与 Issue #103 的 M1–M5 混淆，本系统使用 `ATE`（Agent Test & Evaluation）编号。

### ATE0：基线、威胁模型与评测合同

**目标：** 冻结术语和边界，防止“测试 Agent”和“让 Agent 自评”混为一谈。

交付：

- 当前命令、Chat、memory、application API 和测试清单；
- Agent intent/tool/command ID 注册表草案；
- 数据分类、威胁模型和 hard-fail 列表；
- 质量目标 → suite → metric → Gate traceability matrix；
- 现有行为 characterization tests。

出口：所有关键需求都有确定性或语义 scorer 的所有者；未定义工具不得进入实现。

### ATE1：原生 eval contract 与离线 harness

**目标：** 不调用真实模型即可完整测试 Agent run loop。

交付：

- `AgentEvalCase/Result/Trace` 类型；
- dataset loader/validator；
- ScriptedAgentModel、RecordingToolRegistry、fake clock、synthetic vault；
- scorer 的 known-answer tests；
- 首批 20–30 个 intent/tool/memory/safety fixture。

出口：L0/L1 在 CI 稳定运行；脚本少消费、多消费和乱序都会失败。

### ATE2：意图、命令与工具评测

**目标：** 建立“是否调用、调用什么、如何调用、是否完成”的完整证据链。

交付：

- rule-first router 的单元和属性测试；
- command → use case 的集成测试；
- 工具 schema/guardrail/approval/state scorer；
- 中文、英文、混合语言和 adversarial 数据；
- confusion matrix 与 tool-call 报告。

出口：所有写工具均确认门控；安全 hard-fail 为 0；工具最终状态可独立复核。

### ATE3：记忆生命周期评测

**目标：** 证明 Agent 不只“能记住”，也能不乱记、正确更新并真正遗忘。

交付：

- write/retrieve/use/forget 四套 scorer；
- 多会话、冲突、时序、删除、取消和禁用场景；
- memory trace 脱敏；
- 长历史压力 fixture；
- 与无记忆 baseline 的 paired comparison。

出口：删除/禁用/取消不再泄露；无证据记忆和冲突覆盖低于预登记阈值。

### ATE4：真实模型 benchmark 与回归比较

**目标：** 测量模型决策而不是只测软件管线。

交付：

- benchmark runner、environment manifest 和结果 compare；
- 本地模型与至少一个用户可选 provider 的 adapter；
- 每 case 多次运行、pass@k/pass^k、置信区间；
- judge rubric 校准与人工抽检表；
- approved baseline 流程。

出口：同环境可重跑；不同模型/Prompt/tool schema 的结果可比较；失败可定位到具体 trace。

### ATE5：可选生态适配与可观测性

**目标：** 在不锁定平台的前提下复用成熟工具。

交付候选：

- Promptfoo converter；
- OTLP/OpenInference exporter 到本地 Phoenix；
- LangSmith 或 OpenAI Evals 的 redacted exporter spike；
- Inspect AI JSONL adapter 可行性记录；
- 采用/不采用 ADR，包括依赖、隐私、维护和移动端影响。

出口：所有 adapter 可拔除；关闭后核心测试与产品不受影响；没有默认外发。

### ATE6：1.6 发布 Gate 与运维手册

**目标：** 把评测变成可重复发布流程，而不是一次性报告。

交付：

- CI 分层和手工 benchmark workflow；
- release candidate 报告模板；
- flaky case、provider outage、judge disagreement 和 baseline 更新策略；
- 真实 Obsidian desktop/mobile 旅程记录；
- 失败样本进入回归集的审核流程。

出口：PR-fast、Benchmark、Release 三层 Gate 均有可追溯证据；未运行项明确标为未验证。

## 14. 推荐 PR 拆分

1. `docs(agent-eval): freeze contracts and threat model`
2. `test(agent): add dataset schema and validator`
3. `test(agent): add scripted model and trace recorder`
4. `test(agent): add tool registry and isolated state harness`
5. `test(agent): add intent command and tool suites`
6. `test(agent): add memory lifecycle suites`
7. `feat(agent-eval): add real-model benchmark runner`
8. `ci(agent-eval): add manual benchmark and comparison report`
9. `spike(agent-eval): evaluate optional ecosystem adapters`

一次 PR 只建立一个可验证边界。不要同时引入生产 Agent、第三方云平台、数据集和发布阈值。

## 15. 开发与验证记录模板

每次 benchmark 记录：

```text
Date / commit:
Dataset schema + version:
Agent/prompt/tool-schema hash:
Model/provider/endpoint:
Generation parameters:
Runs per case:
Judge/rubric version:
Environment:
Cost/time budget:
Deterministic results:
Semantic results:
Safety violations:
Regressions vs baseline:
Human review sample:
Decision: GO / NO-GO / INCONCLUSIVE
Known limitations:
```

`INCONCLUSIVE` 用于 provider 故障、样本不足、环境不可比或 judge 未校准，不能强行算 PASS。

## 16. 参考资料与采用结论

以下资料于 2026-11-01 核对，用于提炼设计模式，不代表 Vault Coach 已集成对应产品：

- [OpenAI：Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)：端到端 trace、dataset、grader 和 eval run；采用“轨迹与结果一起评估”。
- [OpenAI Agents SDK：Testing](https://openai.github.io/openai-agents-js/guides/testing/)：scripted model、工具管线、完整脚本消费与故障注入；采用测试替身思想，不据此锁定 SDK。
- [OpenAI Agents SDK：Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)：run/model/tool/guardrail span 与敏感数据开关；采用 provider-neutral trace 和默认脱敏。
- [LangSmith：Evaluation types](https://docs.langchain.com/langsmith/evaluation-types)：offline benchmark、unit/regression、code/LLM/pairwise/summary evaluator；采用分层评测与 code evaluator 优先。
- [Promptfoo：Tool calling](https://www.promptfoo.dev/docs/configuration/tools/) 与 [Tracing](https://www.promptfoo.dev/docs/tracing/)：多 provider 工具格式与 OTLP trace 断言；作为可选模型矩阵适配器。
- [Arize Phoenix](https://arize.com/docs/phoenix/)：OpenTelemetry/OpenInference、dataset、experiment 和本地可观测性；作为可选 dev-only trace 后端。
- [Inspect AI：Agents](https://inspect.aisi.org.uk/agents.html) 与 [Running evals](https://inspect.aisi.org.uk/running.html)：agent/tool/scorer、checkpoint、sandbox 和运行限额；作为外部一致性与长程测试候选。
- [Berkeley Function-Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard)：单轮、多轮、hallucination、memory 和 agentic tool use；借鉴工具选择/参数/多轮拆分，不复制榜单作为产品 Gate。
- [τ-bench 论文](https://arxiv.org/abs/2406.12045)：以最终数据库状态评分并用 `pass^k` 衡量多次运行可靠性；采用最终状态与稳定性指标。
- [LongMemEval（ICLR 2025）](https://proceedings.iclr.cc/paper_files/paper/2025/file/d813d324dbf0598bbdc9c8e79740ed01-Paper-Conference.pdf)：长期对话记忆任务；仅参考记忆能力拆分，Vault Coach 仍需自有产品语义数据集。

## 17. 规划结论

1.6 首先建设一个小而硬的原生评测内核，而不是先安装大型 Agent 平台。最重要的资产是稳定的数据契约、隔离场景、可观察轨迹、最终状态断言和版本化失败样本。

推荐实施顺序为：

```text
ATE0 契约与威胁模型
  → ATE1 离线 harness
  → ATE2 意图/命令/工具
  → ATE3 记忆生命周期
  → ATE4 真实模型回归
  → ATE5 可选生态适配
  → ATE6 发布 Gate
```

在 ATE1–ATE3 完成前，不应把“Agent 能调用工具”当作可发布能力；在 ATE4 完成前，也不应把 scripted tests 的成功解释为真实模型意图识别和工具选择已经可靠。
