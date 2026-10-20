---
tags: [VaultCoach, v1.5, 里程碑2, 设置, 迁移, 检索, TransformersJS]
status: implemented
updated: 2026-10-18
depends-on: [里程碑0-基线冻结与产品契约.md]
---

# 里程碑 2：升级安全的默认体验与 Advanced 设置分层

## 1. 目标与本阶段决策

本里程碑同时解决三个问题：

1. **已有用户升级后继续按原偏好工作**：保留知识范围、聊天 provider、embedding provider、模型名、服务地址、检索模式和全部高级参数；
2. **降低新用户的设置负担**：主路径只要求选择知识范围和回答模型，embedding 与检索细节由默认策略处理；
3. **为未来内置模型保留稳定接口**：聊天模型与 embedding 模型分别选择 provider，不把两者绑成一个“本地/云端”总开关。

本阶段仍不引入 Transformers.js 运行时，不下载模型，也不改变现有索引格式。M2 必须先建立设置 schema、迁移入口、provider 选择语义和 UI 分层；内置 embedding 由 M4/M5 的证据门决定，内置聊天模型需要单独的技术验证门。

### 1.1 不可破坏的升级契约

- UI 重排不得改变用户已经保存的值；
- 旧用户的 Ollama 或 OpenAI-compatible 配置不得自动切换为 builtin；
- 旧用户保存的 `keyword | vector | hybrid` 必须继续作为显式偏好，不能迁移成 `auto`；
- 只有可确定的全新安装才使用新默认值；
- 移动设置项不触发索引重建，只有影响索引语义的有效值变化才使索引 stale；
- **API key 的实际值**继续由 Obsidian `SecretStorage` 管理，普通设置只保存 secret ID；
- 迁移失败时不得用默认值覆盖原设置，不得静默更换 provider；
- builtin 失败时不得自动把笔记发送给 Ollama 或云端服务。

## 2. 当前实现与设置实际存储位置

### 2.1 已核实的持久化路径

| 数据            | 当前存储位置                                                 | 当前写入入口                              | 升级要求                                           |
| ------------- | ------------------------------------------------------ | ----------------------------------- | ---------------------------------------------- |
| 普通插件设置        | `<Vault>/.obsidian/plugins/vault-coach/data.json`      | `Plugin.saveData()`                 | 保留已存在字段，只为缺失字段补默认值                             |
| API key 实际值   | Obsidian `SecretStorage`                               | `SecretComponent` / `secretStorage` | 不复制进 `data.json`、日志、fixture 或 migration result |
| API key 引用    | `data.json` 的 `cloudApiKeySecretName`                  | 设置页保存                               | 保留引用；目标设备缺少对应 secret 时显示 `needs-attention`     |
| 索引、图谱、考试与学习数据 | Vault 内现有 `.vault-coach/` 等存储                          | 各 storage adapter                   | 不是设置迁移对象；只根据有效配置决定是否 stale                     |
| Advanced 展开状态 | `data.json` 的 `uiPreferences.advancedSettingsExpanded` | `SettingsRepository`                | 作为 UI 偏好保存，不影响业务行为                             |
| builtin 模型缓存  | 尚未实现                                                   | M5 runtime/cache adapter            | 不能把 `ready` 只当布尔设置；必须检查真实缓存资源                  |

Obsidian API 明确说明 `loadData()` / `saveData()` 将插件数据存入插件目录的 `data.json`；`SecretStorage` 保存 secret，设置对象只持有引用。参考：[Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)、[Obsidian settings guide](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Settings.md)。

### 2.2 实施前加载逻辑（基线）

当前 `src/vault-coach-plugin.ts` 的核心行为是：

```ts
const savedSettings = ((await this.loadData()) as Partial<VaultCoachSettings> | null) ?? {};
this.settings = Object.assign({}, createDefaultSettings(), savedSettings);
```

它有一个有用特性：**只要字段名没有改变，已保存值会覆盖新默认值**。因此大多数老用户当前可以保留偏好。

它还存在以下风险：

- *没有 schema version，无法知道设置来自哪个版本；*
- TypeScript **类型断言**不会验证磁盘 JSON，错误类型和无效枚举会进入运行时；
- 无法可靠区分“全新安装”和“旧版本缺少新字段”；
- 字段改名或拆分时没有迁移步骤；
- 未知字段会随对象合并继续存在，并可能在下一次保存时被原样写回；
- 新默认值可能被误用于旧用户缺失字段，进而改变 provider、隐私边界或索引行为；
- 多个设置控件连续保存时缺少统一的迁移和序列化边界。

结论：M8 可以继续做完整的跨版本和损坏恢复加固，但**第一个 settings schema 与 1.4.x → 1.5 的保值迁移必须在 M2 完成**，不能等全部功能开发完再补。

## 3. 设置持久化与迁移设计

### 3.1 1.5 采用兼容旧版本的平面文档

1.5 不立刻把现有字段包进 `{ schemaVersion, data }`，因为旧版本回退后只认识顶层字段。建议在现有平面 JSON 中增加版本号：

```ts
interface PersistedVaultCoachSettingsV1 extends SerializableVaultCoachSettings {
  settingsSchemaVersion: 1;
  uiPreferences?: {
    advancedSettingsExpanded?: boolean;
  };
}
```

约束：

1. `VaultCoachSettings` 是经过验证后供运行时使用的**对象**；
2. `PersistedVaultCoachSettingsV1` 是磁盘格式，两者不要直接等同；
3. `settingsSchemaVersion` 只描述设置 JSON，不代表索引、考试或图谱 schema；
4. 1.5 内不重命名现有持久化字段；
5. 旧版本未知字段先隔离为 passthrough，不提供给业务层，也不在 M2 无备份删除；
6. 发现高于当前版本的 schema 时进入只读保护，不用旧代码覆写未来设置。

采用平面格式可以让 1.4.x 在必要回退时仍读到原有核心字段。未来是否改为 envelope，应在 M8 结合 downgrade 策略另做 ADR。

### 3.2 建议的加载结果

```ts
type SettingsLoadResult =
  | {
      status: "ready";
      settings: VaultCoachSettings;
      source: "new-install" | "legacy" | "current";
      sourceSchemaVersion: number | null;
      migrated: boolean;
      warnings: SettingsMigrationWarning[];
      passthrough: Record<string, unknown>;
    }
  | {
      status: "future-schema";
      sourceSchemaVersion: number;
      warnings: SettingsMigrationWarning[];
    };
```

只有 `status === "ready"` 时运行时才能拿到 `settings`；future schema 只显示恢复提示并阻止旧版本保存。设置页可以读取脱敏的 `warnings`；原始 JSON、secret 和未知值不得进入普通日志。

### 3.3 加载顺序

```text
loadData(): unknown
  → 判断 null / 空对象 / legacy / current / future
  → 验证旧 schema
  → 顺序执行纯 migration
  → 验证当前 schema 和取值范围
  → 只为真正缺失字段补默认值
  → 计算索引影响，不在 onload 直接重建
  → 迁移成功后最多保存一次
  → 向运行时返回完整、已验证的 VaultCoachSettings
```

不要先与默认值合并再迁移，否则无法区分“用户保存的值”和“代码刚补的默认值”。

### 3.4 如何区分新安装和旧用户

| 输入证据                                               | 分类                    | 行为                            |
| -------------------------------------------------- | --------------------- | ----------------------------- |
| `loadData()` 返回 `null` 或空对象，且没有其他 Vault Coach 使用证据 | `new-install`         | 使用 1.5 新默认值，后续进入 Setup Wizard |
| 没有 `settingsSchemaVersion`，但存在任一已知旧字段              | `legacy` schema 0     | 保留旧值并迁移，不能按新安装处理              |
| `settingsSchemaVersion === CURRENT`                | `current`             | 校验后加载                         |
| schema 低于当前版本                                      | `legacy`              | 逐版本迁移                         |
| schema 高于当前版本                                      | `future`              | 拒绝保存，提示升级插件或恢复备份              |
| 设置不完整但已有索引、考试或学习数据                                 | `legacy/needs-review` | 不清空、不强制首次向导，交给 M8 的综合判定       |

“缺少某个新字段”不能作为新安装证据，因为所有老用户都会缺少新字段。

### 3.5 1.4.x → 1.5 保值映射

| 旧字段 | 1.5 行为 | 是否导致索引 stale |
| --- | --- | --- |
| `knowledgeScopeMode`、`knowledgeFolder` | 原值保留 | 只有有效 scope 实际变化时才 stale |
| `modelProvider` | 保留 `ollama` / `openai-compatible` | 否，影响后续聊天请求 |
| `llmBaseUrl`、`chatModel` | 原值保留 | 否 |
| `cloudBaseUrl`、`cloudChatModel` | 原值保留 | 否 |
| `cloudApiKeySecretName` | 保留 secret ID；检查 secret 是否可读取 | 否 |
| `embeddingProvider` | 保留 `ollama` / `openai-compatible`，不自动切 builtin | provider/fingerprint 实际变化时才 stale |
| embedding URL、model | 原值保留 | 有效 fingerprint 变化时 stale |
| `defaultRetrievalMode` | `keyword/vector/hybrid` 原样保留 | 否 |
| chunk、TopK、RRF、rerank 等 | 原值保留，即使 UI 被折叠 | 仅按各字段实际语义判断 |
| 新增 `retrievalPreference` | 旧用户由 `defaultRetrievalMode` 映射为同名显式偏好；新用户才用 `auto` | 否 |
| 新增 builtin provider | 旧用户不自动采用；只在用户主动选择后生效 | 选择 embedding builtin 后需要重建向量 |

### 3.6 保存边界

- 所有设置写入通过一个 `SettingsRepository` 或同等入口，不让 UI 到处直接调用 `saveData()`；
- 保存前再次验证 runtime settings；
- 串行化并发保存，避免快速切换控件时旧写入覆盖新写入；
- 只序列化设置、schema version、允许的 UI 偏好和兼容 passthrough；
- `saveData()` 失败时内存状态与磁盘状态必须可区分，并向用户显示可恢复错误；
- 外部同步修改 `data.json` 时，后续可实现 `onExternalSettingsChange()`，但不能在事件中启动重建或模型下载；
- migration 日志只记录来源版本、目标版本、warning code 和受影响字段名，不记录字段值。

## 4. 检索偏好与实际执行模式

```ts
type RetrievalPreference = "auto" | "keyword" | "vector" | "hybrid";
type RetrievalMode = "keyword" | "vector" | "hybrid";

interface RetrievalResolution {
  preference: RetrievalPreference;
  resolvedMode: RetrievalMode;
  reason: "explicit" | "vector-ready" | "vector-unavailable" | "vector-failed";
}
```

`auto` 是**用户偏好**，不应写入回答结果的 `retrievalMode` 字段。回答、日志和诊断记录本次真正使用的模式与原因。

规则：

1. 旧用户已保存 keyword/vector/hybrid 时保持显式选择；
2. 新安装默认 auto；
3. auto 且向量索引与 provider fingerprint 就绪时选择 hybrid；
4. auto 且向量不可用时选择 keyword，并显示非阻断状态；
5. 请求中向量失败时只允许本次降级并记录原因；
6. fallback 不得改写持久化偏好；
7. 显式 vector/hybrid 不可用时给出清晰错误或用户确认后的临时降级，不能伪装成已按偏好执行。

## 5. 重新设计设置分层

设置分层按“用户决策的重要性”划分，而不是按“是否包含模型参数”划分。

### 5.1 默认主路径

默认区显示：

1. **知识范围**：当前 Vault 或指定目录；
2. **回答模型**：Built-in local、Ollama local、Cloud / self-hosted compatible；
3. 当前回答模型必要的配置和连接测试；
4. **语义搜索状态**：Preparing / Ready / Needs attention，并给出修复动作；
5. 隐私摘要：问题、检索上下文和模型调用将在哪里处理；
6. **Show advanced settings**。

聊天 provider 不能整体藏进 Advanced，因为它直接决定功能是否可用、内容是否离开设备、费用和回答质量。

### 5.2 按选择渐进展示

| 回答模型选择 | 主路径立即显示 |
| --- | --- |
| Built-in local | 模型状态、首次下载/清除入口、能力和设备限制；只有通过独立 Gate 后才展示 |
| Ollama local | 服务地址、模型名、连接测试 |
| Cloud / self-hosted | Base URL、模型名、SecretStorage 选择器、连接测试和外发说明 |

已经配置 Ollama 或云端服务的老用户升级后，设置页必须自动选中原 provider，并直接显示其必要字段；不能要求用户先发现 Advanced 才能继续使用。

### 5.3 Advanced

Advanced 显示：

- embedding provider 覆盖和模型细节；
- 检索偏好；
- chunk、TopK、RRF、rerank；
- query rewrite、memory 与自动索引技术参数；
- provider fingerprint、索引诊断、重建和清理动作；
- 可脱敏导出的诊断摘要。

如果老用户存在非默认高级值，即使面板折叠，也应显示 **Custom advanced settings active** 摘要，不得让用户误以为默认值已经接管。Advanced 展开状态可以保存为 UI 偏好，但它不参与检索和索引 fingerprint。

## 6. 聊天与 Embedding 必须独立选择

未来建议的 provider 集合：

```ts
type ChatProviderId = "builtin" | "ollama" | "openai-compatible";
type EmbeddingProviderId = "builtin" | "ollama" | "openai-compatible";
```

为了降低 1.4.x 升级风险，1.5 仍保留磁盘字段名 `modelProvider` 与 `embeddingProvider`。代码内部可以把 `ModelProvider` 逐步重命名为 `ChatProviderId`，但必须保留兼容导出或通过 migration 显式转换，不能只改 TypeScript 名称后假设磁盘会自动迁移。

支持的组合应包括：

| 聊天 | Embedding | 典型用途 |
| --- | --- | --- |
| Built-in | Built-in | 完全本地、最低配置；仅在两项 Gate 都通过后提供 |
| Ollama | Built-in | 使用更强本地聊天模型，同时免配置 embedding 服务 |
| Cloud/self-hosted | Built-in | 云端回答质量 + 本地检索向量 |
| Ollama | Ollama | 延续当前本地部署偏好 |
| Cloud/self-hosted | OpenAI-compatible | 延续当前远程或自托管配置 |

不要提供一个会同时改写两个 provider 的总开关。用户更换聊天模型不应导致向量索引重建；更换 embedding fingerprint 才需要重建向量。

## 7. Transformers.js 能否实现内置聊天 LLM

配套原理与实战教程：[[00-教程总览与学习路线|以 Vault Coach 内置 LLM 为例：WebGPU、WASM、量化与模型缓存教程]]。

### 7.1 技术结论

**可以实现，但不能因为 API 可调用就直接作为默认聊天模型。**

Transformers.js 已支持 `text-generation`，官方示例可用量化后的 Qwen2.5 0.5B Instruct 通过 WebGPU 生成聊天文本；它也支持 q4/q8/fp16 等 dtype、WASM/WebGPU 运行以及本地模型路径和缓存配置。参考：[Transformers.js](https://huggingface.co/docs/transformers.js/en/index)、[量化模型指南](https://huggingface.co/docs/transformers.js/guides/dtypes)、[环境与本地模型配置](https://huggingface.co/docs/transformers.js/api/env)。

但内置聊天与内置 embedding 的工程成本不同：

| 维度 | 内置 Embedding | 内置 Chat LLM |
| --- | --- | --- |
| 推理形态 | 一次前向生成固定维度向量 | 自回归逐 token 生成，持续占用算力 |
| 模型规模 | 通常可使用较小 encoder | 即使小模型也需要更大权重、KV cache 和上下文内存 |
| 输出契约 | 数值向量，容易验证维数和有限值 | 自由文本/JSON，需要质量、格式和拒答验证 |
| Vault Coach 任务 | 检索和相似度 | 问答、改写、考试出题、评分辅助、概念抽取 |
| 失败降级 | 可退回 keyword 检索 | 没有聊天模型就无法生成最终回答，不能假装成功 |
| 移动端风险 | 可通过小模型、batch 和 WASM 控制 | 首 token、持续生成、内存和发热风险更高 |

WebGPU 能显著改善性能，但并非所有目标设备都可用；官方文档仍要求准备 WASM 或明确的不支持路径。[WebGPU guide](https://huggingface.co/docs/transformers.js/guides/webgpu)。Obsidian 是 Electron 宿主，Transformers.js 在 Electron 中选择 Node 或 Web backend、加载 ONNX/WASM 和使用 WebGPU 需要单独验证；官方 Electron 教程目前仍主要指向示例工程，[相关 runtime 选择问题](https://github.com/huggingface/transformers.js/issues/1240)也说明不能直接把普通浏览器 demo 等同于 Obsidian 插件。

### 7.2 产品建议

采用三级回答模型：

1. **Built-in local**：零外部服务、适合基础问答；只有通过质量和性能 Gate 后才成为可见选项；
2. **Ollama local**：用户在本机运行更强模型，保留当前能力；
3. **Cloud / self-hosted compatible**：使用更强或企业托管模型，保留当前 OpenAI-compatible 能力。

“Built-in”不得被描述为与大型 Ollama/云模型同等质量。UI 应说明其设备要求、上下文上限和适用任务。用户可以独立选择 builtin embedding 与更强聊天模型，这是比“全部 builtin 或全部外部”更实用的默认组合。

### 7.3 架构预留

M2 先定义聊天 port，不接真实 builtin adapter：

```ts
interface ChatProvider {
  readonly id: ChatProviderId;
  describe(): Promise<ChatProviderStatus>;
  stream(request: ChatRequest, handlers: ChatStreamHandlers): Promise<ChatResult>;
  generateStructured<T>(request: StructuredChatRequest<T>): Promise<T>;
  dispose(): Promise<void>;
}
```

`ChatRequest` 表达消息、最大上下文、温度、取消和任务用途；不要暴露 Transformers pipeline 或 Ollama HTTP 类型。回答、query rewrite、考试和语义抽取通过同一 port，但可以声明不同 capability，避免小型 builtin 模型被迫执行其未通过验证的任务。

### 7.4 Built-in Chat GO/NO-GO 门

在显示 builtin chat 选项前，至少验证：

- 中文、英文、德文的引用问答质量；
- 长上下文截断策略与引用忠实度；
- 考试题和概念抽取所需的结构化输出成功率；
- 冷启动下载、暖启动、首 token 延迟、生成速度和峰值内存；
- 主线程无持续卡顿，取消和卸载能终止生成；
- Desktop WebGPU、Desktop WASM 和实际移动端结果；
- 模型 revision、量化方式、许可证和缓存完整性；
- 断网暖启动、缓存清除和损坏恢复；
- builtin 失败时只提示选择其他聊天 provider，不静默外发内容。

该 Gate 应有单独 ADR 和 benchmark 结果。M4 当前 embedding 的 GO 不能自动代表 chat GO。

## 8. 涉及文件与模块

| 文件/模块 | M2 预期修改 |
| --- | --- |
| `src/app/config/settings-types.ts` | 区分 persisted/runtime 类型，增加 schema/UI 偏好类型，保留旧字段名 |
| `src/app/config/settings-schema.ts` | 新建；从 `unknown` 校验枚举、字符串、布尔和数值边界 |
| `src/app/config/settings-migrations.ts` | 新建；schema 0 → 1 的纯迁移和迁移注册表 |
| `src/app/config/settings-repository.ts` | 新建；唯一 `loadData/saveData` 边界、保存串行化、future-schema 保护 |
| `src/app/config/settings-defaults.ts` | 建议新建；分别定义新安装默认值和 runtime fallback |
| `src/settings.ts` | 暂做兼容导出和旧 UI 入口，逐步委派到小模块 |
| `src/vault-coach-plugin.ts` | 调用 repository 加载结果，不直接 `Object.assign` 原始 JSON |
| `src/domain/retrieval/retrieval-types.ts` | 新增 `RetrievalPreference`，保留 `RetrievalMode` 为执行事实 |
| `src/app/retrieval/retrieval-mode-resolver.ts` | 新建；纯函数解析偏好，不访问设置存储或网络 |
| `src/domain/model/chat-provider.ts` | 建议新建稳定 port；M2 不实现 Transformers adapter |
| `src/app/model/chat-provider-router.ts` | 根据已验证设置选择现有 Ollama/OpenAI adapter |
| `src/presentation/settings/vault-coach-setting-tab.ts` | 建议新建；设置页装配 |
| `src/presentation/settings/sections/general-settings.ts` | 知识范围、回答模型和隐私摘要 |
| `src/presentation/settings/sections/advanced-retrieval-settings.ts` | embedding、检索和专家参数 |
| `src/presentation/components/vault-coach-header.ts` | 默认隐藏算法选择器，展示 resolved 状态 |
| `src/app/chat/chat-service.ts` | 请求开始时冻结实际检索模式和 chat provider |
| `src/i18n.ts` | 迁移 warning、provider 层级、Advanced 摘要与隐私文案 |
| `tests/fixtures/settings/*` | 脱敏的空安装、1.4 Ollama、1.4 cloud、自定义 Advanced、损坏/future schema fixture |
| `tests/app/config/*` | schema、migration、repository 和 round-trip 测试 |

不要一次重写整个 `settings.ts`。先建立 schema/repository 和 fixture，再抽一个 section；每一步保持旧 import 和构建通过。

## 9. 手动实施顺序

### Step 1：冻结真实旧设置 fixture

从 1.4.1 的设置结构制作脱敏 fixture：

```text
tests/fixtures/settings/
  empty-install.json
  v1.4.1-ollama-custom.json
  v1.4.1-cloud-custom.json
  v1.4.1-advanced-custom.json
  invalid-types.json
  future-schema.json
```

fixture 不能包含真实 Vault 路径、模型服务凭据或 API key。为每个 fixture 写出必须保留的字段清单。

### Step 2：先写 round-trip 与保值测试

测试 `load legacy → migrate → save → reload`。逐字段断言 provider、URL、model、secret ID、scope、检索模式和 Advanced 参数保持不变。不要只做快照；关键字段要有明确断言。

### Step 3：实现 schema 和迁移纯函数

输入为 `unknown`，输出 `SettingsLoadResult`。migration 不访问 Vault、不调用网络、不加载模型、不重建索引。重复运行迁移必须幂等。

### Step 4：引入 SettingsRepository

把 `loadData/saveData` 收口。先让旧 UI 继续工作，再逐步替换直接保存入口。模拟保存失败和快速连续保存，确认最新有效值不会被旧 Promise 覆盖。

### Step 5：接入 retrieval resolver

在一次 Ask 开始时冻结 `RetrievalResolution`。把 `resolvedMode` 传入 RAG engine，把 reason 写入脱敏诊断；fallback 不修改设置。

### Step 6：拆分设置 UI

先抽默认区，再抽 Advanced。老用户的 provider 和自定义值从 repository 的 validated settings 渲染，不从 UI 默认值重新推导。

### Step 7：整理聊天 provider 边界

先让 Ollama 和 OpenAI-compatible 通过统一 port；不安装 Transformers.js，不显示 builtin chat 选项。用 fake provider 验证 stream、cancel、structured output 和错误分类，为后续 spike 留接口。

### Step 8：执行升级手工矩阵

在 1.4.1 安装中分别保存 Ollama、cloud 和高级参数，升级到当前构建，验证设置、连接和 Ask；再回到设置页保存一次并重载插件，确认值仍保持。

## 10. 测试设计

### 10.1 设置迁移单元测试

- `null/empty → new-install`；
- 无 schema 且含旧字段 → legacy，不误判新安装；
- 旧 Ollama/cloud provider、URL、model、secret ID 保留；
- 旧 `keyword/vector/hybrid` 保留为显式偏好；
- 新安装得到 `auto`；
- 缺失字段只补默认值，不覆盖显式 `false`、`0` 或空字符串；
- 无效枚举和越界数字产生 warning，并按字段策略恢复；
- future schema 不允许保存；
- migration 幂等；
- round-trip 后关键字段相等；
- migration 不包含 secret 值和私人路径日志。

### 10.2 UI/集成测试

- 老用户升级后自动显示原聊天 provider 及必要配置；
- 默认设置页不显示 chunk/TopK/RRF；
- 自定义 Advanced 生效时折叠区外有摘要；
- 展开 Advanced 后可查看并保存原值；
- chat 与 embedding provider 可以独立组合；
- header 显示实际检索模式，不把 `auto` 当执行事实；
- SecretStorage 缺失时显示 needs attention，不清除 secret ID 或切 provider；
- 重载插件后设置和 UI 一致，无重复监听器。

### 10.3 手工升级矩阵

| 场景 | 预期 |
| --- | --- |
| 1.4.1 Ollama chat + Ollama embedding | 两个 provider、URL 和模型均保留，不下载 builtin |
| 1.4.1 cloud chat + Ollama embedding | 组合保持，secret 可用时继续工作 |
| secret ID 存在但当前设备无 secret | 显示 needs attention，不静默切换 |
| 高级用户选 keyword | 升级后仍始终 keyword |
| 高级用户改过 chunk/TopK | 值保留，显示 custom advanced 摘要 |
| 新 Vault，无向量索引 | auto 解析为 keyword，可进入 Ask 流程 |
| 向量索引 ready | 新用户下一次 Ask 解析为 hybrid |
| provider 请求失败 | 本次错误可诊断，不改持久化配置 |
| future schema | 插件不覆写文件，给出恢复提示 |

## 11. 调试训练

1. 在 settings repository 边界加可开关日志，只记录 schema、source、warning code 和字段名；
2. 在迁移前后使用结构化 diff，确保敏感值被统一遮盖；
3. 用断点观察 `loadData → migrate → validate → defaults → runtime` 的顺序；
4. 注入无效 JSON、未知 schema、保存失败和外部设置变更；
5. 快速连续修改两个控件，检查保存顺序；
6. 在 resolver 边界观察一次 Ask 的模式何时冻结；
7. 用 Vitest 单文件定位失败，再跑设置、应用集成和全套测试。

不要记录问题正文、笔记内容、API key、完整本地路径或模型上下文。

## 12. 工程实践与原因

- 先迁移后补默认值，才能区分用户选择与产品默认；
- persisted/runtime 类型分离，阻止磁盘脏数据直接进入业务层；
- 保留现有顶层字段，提高升级和必要回退时的兼容性；
- provider 独立选择，避免聊天模型变化导致无关的向量重建；
- chat provider 留在主路径，因为它影响功能、隐私、成本和质量；
- embedding 与检索参数进入 Advanced，降低首次配置认知负担；
- 纯 migration 和 fixture 让升级行为可复现、可回归；
- UI 只读取已验证设置与 Application 状态，不自行判断索引或缓存；
- builtin 下载必须显式，不能在 Ask 或 migration 中隐藏触发；
- Transformers.js adapter 只能实现 port，第三方 SDK 类型不能扩散到业务层；
- fallback 必须进入诊断，不能用“回答成功”掩盖配置或检索故障。

## 13. PR 与提交切片

1. `test: add legacy settings fixtures and round-trip assertions`；
2. `feat: add versioned settings schema and migrations`；
3. `refactor: centralize settings persistence`；
4. `refactor: separate retrieval preference from resolved mode`；
5. `refactor: introduce chat provider port for existing adapters`；
6. `refactor: extract settings sections`；
7. `feat: add auto retrieval for new installs`；
8. `feat: add progressive model settings and advanced summary`；
9. `docs: record upgrade and built-in chat decisions`。

每个 PR 都应包含对应 fixture 或 contract test，不把 migration、UI 重写和 Transformers runtime 塞入同一个提交。

## 14. 完成标准

- [x] 文档和代码明确普通设置、secret、派生数据和模型缓存的存储边界；
- [x] 1.4.x Ollama、cloud、混合 provider 和自定义 Advanced fixture 全部保值；
- [x] 旧用户不被自动切换到 builtin 或 auto；
- [x] 新安装与旧安装有可靠判定，不依赖“缺少新字段”；
- [x] schema migration、校验和 future-schema 保护已接入加载入口；
- [x] 默认用户只需选择知识范围和回答模型；
- [x] 已有外部 provider 用户无需进入 Advanced 就能继续使用；
- [x] auto 在向量 ready/unavailable 时结果可预测；
- [x] 回答结果和 header 使用解析后的真实模式，不把 auto 当执行事实；
- [x] Advanced 可访问并保留全部原有技术参数；
- [x] chat 与 embedding provider 可独立组合；
- [x] builtin chat 只完成 port 与验证计划，没有被显示成已实现能力；
- [x] 单测、lint、build 与 fixture 升级矩阵通过；
- [ ] 在 Obsidian GUI 中执行 10.3 的手工升级矩阵；
- [x] 没有把 M5 尚未完成的 builtin embedding 状态显示为 Ready。

## 15. 实施记录

### 15.1 实施范围

实施日期：2026-10-13

开发分支：`feature/v1.5`

Commit / PR：当前工作区实现，尚未创建提交或 PR。

本次实现包含以下代码边界：

- `src/app/config/settings-defaults.ts`：新安装默认值的唯一来源；
- `src/app/config/settings-schema.ts`：schema v1、加载结果和迁移 warning 契约；
- `src/app/config/settings-migrations.ts`：纯函数迁移、逐字段校验、旧检索模式映射与未知字段保留；
- `src/app/config/settings-repository.ts`：`loadData/saveData` 唯一边界、迁移落盘、future-schema 拒绝覆盖和串行保存；
- `src/presentation/settings/settings-section-model.ts`：Advanced 自定义摘要计算；
- `src/settings.ts`：默认层、Advanced 层、provider 条件字段、语义检索状态和 secret 缺失提示；
- `src/app/retrieval/retrieval-mode-resolver.ts`：`auto`、显式偏好、向量不可用和向量失败的解析规则；
- `src/rag-engine.ts`：在单轮请求开始时冻结解析结果，向量失败时记录真实 keyword fallback；
- `src/domain/model/chat-provider.ts`：聊天能力 port；现有 `LocalModelClient` 作为 adapter 实现该 port；
- `src/presentation/components/vault-coach-header.ts`：只读显示 `Auto → 实际模式`，不再要求普通用户选择检索算法。

### 15.2 设置迁移结果

设置 schema 版本：`1`。

旧版本 fixture：

- `legacy-local.json`：Ollama chat + Ollama embedding，并包含自定义 chunk、rerank 和 vector 偏好；
- `legacy-cloud.json`：cloud chat + cloud embedding，覆盖 secret ID、`false` 和温度 `0`；
- `legacy-mixed.json`：cloud chat + Ollama embedding，验证 provider 独立组合；
- `invalid-values.json`：验证逐字段回退和不含配置值的 warning；
- `future-schema.json`：验证较新 schema 不加载、不保存、不覆盖。

保留字段检查：知识范围、folder、chat/embedding provider、URL、模型、secret ID、旧检索偏好、chunk、TopK、rerank、query rewrite 和布尔开关均由 fixture 断言。旧 `defaultRetrievalMode` 映射到显式 `retrievalPreference`；只有 `null` 或空对象代表全新安装并得到 `auto`。

迁移 warning：只包含 `code`、`field` 和固定文案，不包含 API key、URL、路径或模型配置值。无效字段单独回退，不影响同一文件内的其他合法字段。

Round-trip：未知字段通过 `passthrough` 原样保存；`false`、`0` 和空字符串不会因为真假值判断而丢失；`uiPreferences` 与运行设置共同落盘但保持独立类型。

### 15.3 UI 与运行时决策

- 默认层显示知识范围、回答模型、对应 URL/模型/secret、语义检索状态和 Advanced 开关；
- Advanced 折叠时显示自定义参数数量，展开后保留原有 embedding、索引、检索、重排、记忆、考试和图谱设置；
- `cloudApiKeySecretName` 存在但本机 SecretStorage 无对应值时显示 `Needs attention`，不清空引用、不切换 provider；
- chat 与 embedding provider 继续使用两个独立字段，修改 chat provider 不触发向量索引失效；
- 全新安装的 `retrievalPreference` 为 `auto`：向量 ready 时解析为 hybrid，否则解析为 keyword；显式偏好原样保留；
- 向量调用失败时本轮回退 keyword，并在 `AssistantAnswer.retrievalReason` 记录 `vector-failed`；持久化偏好不改变；
- header 显示解析后的模式，例如 `Auto → Hybrid`，算法选择只存在于 Advanced；
- M2 未增加 Transformers.js 依赖、模型下载或 Built-in Chat 选项。`ChatProvider` 仅建立稳定 port，后续实现仍需单独质量 Gate。

### 15.4 验证记录

自动测试：`npm test -- --run` 通过，56 个测试文件、225 个测试全部通过。新增 9 个 settings migration/repository 测试和 3 个 retrieval resolver 测试。

静态验证：

- `npx tsc -noEmit -skipLibCheck`：通过；
- `npm run lint`：通过，0 error、0 warning；
- `npm run build`：通过；
- `git diff --check`：通过。

保存故障注入：首次 `saveData` 抛出错误后，调用方收到失败；后续保存队列可以恢复并成功写入。并发保存按调用顺序串行执行，最后一次设置不会被较早写入覆盖。

升级手工场景：fixture 升级矩阵已通过；Obsidian GUI 中的 10.3 手工矩阵尚未执行，因此没有把 GUI 观察写成已验证结论。

### 15.5 行为偏差、限制与下一步

- 文档建议的 `settings-default-section.ts` 和 `settings-advanced-section.ts` 没有机械拆成两个大型文件；共享判断已提取到 settings config、repository 和 `settings-section-model.ts`，现有命令式回退渲染继续留在 `settings.ts`，避免同一里程碑同时重写两套 Obsidian 设置 API；
- Built-in Chat ADR / Gate：本次只落实 `ChatProvider` port 和“不在 UI 暴露未实现能力”的 Gate。模型候选、包体、内存、首 token 延迟和回答质量实验仍需单独 ADR；
- 下一里程碑可以直接读取 `SettingsRepository` 的 schema v1，并使用 `RetrievalResolution` 作为诊断与评测字段；M4/M5 不得通过修改 `retrievalPreference` 来伪装 builtin embedding 已 ready；
- 合并前需在真实 Obsidian Vault 执行 10.3 手工升级矩阵，重点检查 SecretStorage 跨设备缺失提示、设置搜索、重载后的 Advanced 展开状态和 header 实际模式。
