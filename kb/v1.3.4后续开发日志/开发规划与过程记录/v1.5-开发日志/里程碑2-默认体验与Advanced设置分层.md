---
tags: [VaultCoach, v1.5, 里程碑2, 设置, 检索]
status: planned
updated: 2026-10-09
depends-on: [里程碑0-基线冻结与产品契约.md]
---

# 里程碑 2：默认体验与 Advanced 设置分层

## 1. 目标

把默认体验收敛为“选择知识范围 + 配置聊天 LLM”，将 embedding、chunk、TopK、RRF、rerank 和检索模式放入 Advanced。默认检索选择 `auto`，由运行时根据索引状态选择实际模式。

本阶段只重排现有能力，不引入 Transformers.js，也不改变旧索引格式。学习重点是设置建模、UI 状态、兼容迁移和大文件拆分。

## 2. 当前差距

- `src/domain/retrieval/retrieval-types.ts` 的检索模式只有 `keyword | vector | hybrid`；
- `src/app/chat/chat-service.ts` 把设置值直接当作本次真实检索模式；
- `src/presentation/components/vault-coach-header.ts` 向默认用户展示三种检索模式；
- `src/settings.ts` 超过适合单一职责文件的体量，技术参数与用户主路径混排；
- 设置读取主要依赖默认值覆盖，无法清晰区分“旧用户值”和“新安装默认值”。

## 3. 关键设计

### 3.1 区分偏好与实际模式

```ts
type RetrievalPreference = "auto" | "keyword" | "vector" | "hybrid";
type RetrievalMode = "keyword" | "vector" | "hybrid";

interface RetrievalResolution {
  preference: RetrievalPreference;
  resolvedMode: RetrievalMode;
  reason: "explicit" | "vector-ready" | "vector-unavailable" | "vector-failed";
}
```

`auto` 是用户偏好，不应写进回答结果的 `retrievalMode` 字段。回答、日志和诊断记录本次真正使用的模式与原因。

建议规则：

1. 显式 keyword/vector/hybrid 尊重高级用户选择；
2. auto 且向量索引与 provider fingerprint 就绪时选择 hybrid；
3. auto 且向量不可用时选择 keyword，并显示非阻断状态；
4. 请求中向量失败时只允许本次降级，并记录结构化原因；
5. 不在失败后静默改写用户持久化设置。

### 3.2 设置分层

默认区只显示：

- 知识范围；
- 聊天 LLM provider、URL、model、API key；
- 连接测试；
- 语义搜索状态：“Built in / Preparing / Ready / Needs attention”；
- **Show advanced settings**。

Advanced 显示：检索偏好、embedding provider、chunk、TopK、RRF、rerank、诊断与清理操作。折叠状态是 UI 偏好，不影响业务设置。

## 4. 涉及文件与模块

| 文件/模块 | 预期修改 |
| --- | --- |
| `src/domain/retrieval/retrieval-types.ts` | 新增 `RetrievalPreference`，保留 `RetrievalMode` 表示执行事实 |
| `src/app/config/settings-types.ts` | 增加偏好、advanced 展开状态或 schema 版本 |
| `src/settings.ts` | 暂做兼容入口，逐步委派到小模块 |
| `src/presentation/settings/vault-coach-setting-tab.ts` | 建议新建，负责设置页装配 |
| `src/presentation/settings/sections/general-settings.ts` | 建议新建，默认主路径 |
| `src/presentation/settings/sections/advanced-retrieval-settings.ts` | 建议新建，专家参数 |
| `src/app/retrieval/retrieval-mode-resolver.ts` | 建议新建，纯函数解析偏好 |
| `src/app/chat/chat-service.ts` | 请求前解析实际模式，保留 fallback 证据 |
| `src/presentation/components/vault-coach-header.ts` | 默认隐藏模式选择器，展示简短状态 |
| `src/presentation/vault-coach-view.ts` | 订阅状态，不自行推导检索能力 |
| `src/i18n.ts` | 默认文案与 Advanced 文案 |
| `tests/app/retrieval/*` | resolver 单测 |
| `tests/settings*`、`tests/presentation/*` | 设置可见性和旧值兼容测试 |

不要一次把整个 `settings.ts` 重写。先抽取纯配置和一个 section，每一步保持构建通过。

## 5. 手动实施顺序

### Step 1：用测试固定现有行为

记录三种显式模式的请求路径、fallback 行为和 UI。给 `ChatService` 加 characterization tests，防止重构改变引用、消息或索引调用。

### Step 2：建立 resolver 纯函数

输入只包含 preference、vector readiness 和 provider health；输出 `RetrievalResolution`。不要让函数访问 Obsidian、设置存储或网络。

先覆盖：auto ready、auto unavailable、每个显式模式。把“显式 vector 但不可用时是报错还是降级”写成产品契约；建议明确提示并允许用户主动切 keyword。

### Step 3：在 ChatService 接入解析结果

在一次 ask 开始时冻结 resolution。执行过程中索引状态变化不应改变同一个请求的模式。将 `resolvedMode` 传入 RAG engine，把 reason 写入可脱敏诊断。

### Step 4：设置类型先拆、界面后拆

先移动类型/默认值并从旧文件 re-export，确保 import 不同时爆炸。再逐节抽 UI builder。每个 section 接收窄依赖，例如设置 draft、保存回调和状态查询。

### Step 5：隐藏默认模式选择器

默认用户看到“Retrieval: Auto”状态，不需要知道 keyword/vector/hybrid。Advanced 内仍能选择与复位。不要删除旧 command ID 或保存字段。

### Step 6：实现兼容读取

- 已保存 keyword/vector/hybrid：保持原选择；
- 缺少字段且被识别为旧安装：暂保持当前默认，最终迁移在 M8 完成；
- 全新安装：目标为 auto；
- 无效值：记录迁移警告并回到安全值。

此处先创建迁移接缝，不要仅靠 `Object.assign(DEFAULT_SETTINGS, saved)` 猜安装类型。

## 6. 测试设计

### 单元测试

- `auto + vector ready -> hybrid`；
- `auto + vector missing -> keyword`；
- 显式偏好不会被 resolver 改写；
- 一次请求使用冻结的 resolution；
- fallback 不修改持久化设置；
- 无效枚举值被校验。

### UI/集成测试

- 默认设置页不显示 chunk/TopK/RRF；
- 展开 Advanced 后可查看并保存；
- 重新打开设置页保持值和合理的折叠策略；
- header 不再要求新用户选择检索算法；
- keyword fallback 有可理解提示，仍可 Ask。

### 手工验证矩阵

| 场景 | 预期 |
| --- | --- |
| 新 Vault，无向量索引 | auto 解析为 keyword，可立即提问 |
| 向量索引 ready | 下一次提问解析为 hybrid |
| 高级用户选 keyword | 始终 keyword |
| provider 请求失败 | 本次可诊断，不静默改配置 |
| 重载插件 | 设置和 UI 一致，无重复监听器 |

## 7. 调试训练

1. 在 resolver 边界加可开关的结构化日志，字段只含 request ID、preference、mode、reason；
2. 用断点观察一次 ask 的模式何时冻结；
3. 故意让向量 readiness 在请求途中变化，确认当前请求不漂移；
4. 注入无效设置 JSON，检查迁移提示和恢复；
5. 用 Vitest 的单文件和单用例筛选定位失败，再跑全套测试。

不要记录问题正文、笔记内容或 API key。

## 8. 工程实践与原因

- 用纯 resolver 集中策略，避免 Header、Settings 和 ChatService 各自判断；
- 分开 preference 与 mode，便于审计实际执行路径；
- 旧字段先兼容再移除，降低大爆炸式迁移风险；
- UI 只读 Application 状态，避免 presentation 直接碰索引文件；
- Advanced 隐藏复杂度但不删除能力，使默认体验和专家控制共存；
- fallback 必须进入诊断，防止“回答成功”掩盖向量链路故障。

## 9. PR 与提交切片

1. `test: characterize retrieval mode behavior`；
2. `refactor: separate retrieval preference from resolved mode`；
3. `refactor: extract settings sections`；
4. `feat: add auto retrieval preference`；
5. `feat: move retrieval controls to advanced settings`；
6. `docs: record settings migration decisions`。

## 10. 完成标准

- [ ] 默认用户只需选择知识和配置聊天 LLM；
- [ ] auto 在向量 ready/unavailable 时结果可预测；
- [ ] 日志和回答记录真实模式，不记录 auto 为执行事实；
- [ ] 旧显式设置未丢失；
- [ ] Advanced 可访问全部原有技术参数；
- [ ] 设置文件开始按职责拆分且兼容 import；
- [ ] 单测、lint、build 与手工矩阵通过；
- [ ] 没有把 M5 尚未完成的 builtin 状态显示为 Ready。

## 11. 实施记录

```text
Commit / PR：
新增或修改文件：
迁移样本：
自动测试：
手工场景：
故障注入：
行为偏差与原因：
下一里程碑输入：
```
