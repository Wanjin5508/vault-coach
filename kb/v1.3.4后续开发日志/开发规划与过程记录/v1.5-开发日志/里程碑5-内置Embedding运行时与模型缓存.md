---
tags: [VaultCoach, v1.5, 里程碑5, LocalAIRuntime, Cache]
status: implemented-manual-smoke-pending
updated: 2026-10-24
depends-on: [里程碑4-内置Embedding技术验证与多语言基准.md]
---

# 里程碑 5：LocalAIRuntime 基础设施与首个内置 Embedding

## 1. 目标

使用 M4 通过 Gate 的策略建立统一模型资源生命周期，首个接入能力是 Embedding。缓存、下载、状态和释放归 LocalAIRuntime 管理；具体 embedding 输出归 BuiltinEmbeddingProvider。后续 reranker/utility 复用基础设施，不再复制三套下载器。

M5 不翻转新用户默认值。根据 2026-10-24 的发布目标，本里程碑把原计划在 M6 完成的生产 Worker、WASM 交付和 RAG 索引接通提前实现：用户现在可以选择 `builtin` provider，显式下载模型并直接重建向量索引。推理始终运行在独立 Worker，不经过 UI 主线程。

> 范围变更：用户决定暂不继续 M4 的真实设备复测，优先交付支持内置 Embedding 的版本。因此“代码完成”和“真实 Obsidian 冷/暖缓存验证”必须分开记录；后者仍是发布前人工检查项，不能用 TypeScript 构建或单元测试替代。

## 2. 依赖和文件

内部：M3 provider/fingerprint/安全索引代际，M4 固定 policy/资产与平台结论；共用契约。

外部：M4 选定版本的 Transformers.js/ONNX Runtime，Cache API 或经验证的 Vault cache adapter，固定模型资产。

| 文件 | 状态 | 修改 |
| --- | --- | --- |
| `src/domain/local-ai/local-ai-types.ts` | 已新增 | runtime 窄接口、状态、请求与结果契约 |
| `src/app/local-ai/local-ai-runtime.ts` | 已新增 | 单 Worker 门面、状态订阅、prepare/embed/clear/dispose 与请求取消 |
| `src/app/local-ai/model-registry.ts` | 已新增 | 固定 repository/revision/dtype/prefix/维数、四个资产 SHA-256 |
| `src/infrastructure/local-ai/local-ai.worker.ts` | 已新增 | Cache API、下载、全资产校验、tokenizer/model 恢复、WASM 推理 |
| `src/infrastructure/embedding/builtin-embedding-provider.ts` | 已新增 | 实现统一 EmbeddingProvider，输出 fingerprint 与 diagnostics |
| `esbuild.config.mjs` | 已修改 | 把 Worker 和 ORT WASM 编入 `main.js`，保持社区插件三文件发布格式 |
| `src/app/application-container.ts`、`src/app/vault-coach-runtime.ts` | 已修改 | 注入唯一 runtime，接入 provider router，暴露准备/清理动作 |
| `src/app/config/settings-migrations.ts` | 已修改 | 接受 `builtin`，保留已有用户 provider，新安装仍默认 Ollama |
| `src/settings.ts`、`src/presentation/settings/settings-section-model.ts`、`src/i18n.ts` | 已修改 | 进阶设置内选择 provider、查看状态、显式准备和清缓存 |
| `src/vault-coach-plugin.ts` | 已修改 | 注册准备和清理模型缓存的稳定命令 ID |
| `tests/app/local-ai/*`、`tests/infrastructure/embedding/*` | 已新增/修改 | fake Worker 状态、取消、错误、adapter fingerprint 与迁移测试 |

旧计划中的 embedding 专属 builtin-model-cache/loader/runtime-service 不再另外创建。统一 infrastructure/local-ai 是唯一缓存/加载边界，避免 M6.1 又写一份。

## 3. 模型策略与授权

每个 policy 包含 role、model repo、revision、dtype、tokenizer、文件清单与 SHA-256、runtime version、资源预算；embedding 增加 dimension/pooling/normalization/三种 purpose 前缀。内容不可由任意模型 ID 文本框绕开允许清单。

准备前读取对应 revision 的授权：来源、预期字节、用途、是否外发正文。用户确认“准备本地搜索”后可自动完成下载和加载，普通 Ask 未准备时返回 not-ready，不偷偷下载。

执行资源与模型数据分开：loader/Worker JS/WASM 只使用 M4 验证的交付方式；权重和 tokenizer 可以按授权从固定来源获取。

## 4. 按步骤实施

### Step 1：定义纯状态机和 registry

内部依赖：M3 LocalAI types、M4 policy。外部依赖：无网络。

先实现 not-installed/downloading/verifying/loading/ready/evicted/error/clearing 转换；为每个 role 保存独立状态。相同 role/policy 的重复 prepare 返回同一任务，不加载第二份实例。request ID、policy ID 和生命周期 epoch 防止旧回调写 ready。

Gate：fake loader 驱动状态可复现；新增 reranker 的 fake policy 不需要复制状态机。

### Step 2：实现可审计缓存

内部依赖：registry、artifact identity。外部依赖：选定 CacheStorage/Vault adapter。

下载先写临时资源，逐文件校验，最后写 complete manifest。读取时验证实际文件，marker 不作为唯一证据。namespace 必须属于插件和目标模型；共用 tokenizer 等资产有引用关系，清一角色不能误删另一个角色需要的文件。

缓存路径转换由 adapter 做，UI 不拿操作系统绝对路径 fetch。大小未知时显示已收字节，不能伪造百分比。quota、partial、损坏、驱逐均返回稳定错误。

Gate：fake 缓存中每类异常可恢复；清理只作用于目标命名空间。

### Step 3：实现 loader facade 与初始化策略

内部依赖：缓存完成判定。外部依赖：M4 固定库与 backend。

统一封装 import、创建 pipeline、warm-up、progress、tensor dispose。不要在并发任务中反复改写全局 env；Worker 初始化一次配置，角色加载使用已验证隔离方式。

WebGPU 失败先释放 session，再按同一政策允许的 WASM 重试一次。若必须换 dtype，产生新 artifact 和 embedding fingerprint，经调用方决定重建，不能冒充原空间继续查询。

Gate：返回 requested/actual backend 和失败原因；不得无限初始化或每次 Ask 重载。

### Step 4：实现 BuiltinEmbeddingProvider

内部依赖：M3 embed request/result、M5 runtime。外部依赖：已准备模型。

先扩展 M3 的 EmbeddingProviderId 联合类型与 diagnostics transport，使 builtin 是可识别的正式能力；补充 not-ready/unavailable 等结构化错误，并同步 schema、router、fake 和调用方的穷尽分支。内置 descriptor 的 endpointIdentity 使用固定本地资源命名空间，不能套用 HTTP URL 校验或放入随设备变化的绝对路径。

query/document/graph 各自预处理，输出 Float32Array 并检查维数、数量、有限数。用 M4 固定样本比对 reference 输出和检索质量；预处理、pooling 和 normalize 的变化必须升级策略。

尚未准备返回 not-ready，禁用或不可用返回结构化原因；交给检索策略做 keyword fallback，不自行调用远程 embedding。

Gate：同一 contract suite 对 fake、HTTP、builtin adapter 生效；普通 CI 不下载模型。

### Step 5：应用装配、设置与清理

内部依赖：application-container、设置迁移与 M2.1 分类。外部依赖：Obsidian 交互测试。

组合根创建一个 LocalAIRuntime，设置页订阅其状态，关闭设置页只取消订阅。准备、重试、取消、清模型都是应用动作；折叠进阶标题不释放运行模型。

清理先阻止新任务、取消/等待受影响任务、释放实例、删除资产、更新 availability；保留文本索引与用户学习数据。相同 fingerprint 模型恢复后，经校验可复用向量。

Gate：反复开关设置页不重复下载/加载；UI 偏好保存不改变业务设置；unload 后无存活任务。

### Step 6：生产 Worker 接入（由 M6 提前到 M5）

内部依赖：完整 fake suites 与 Worker smoke。外部依赖：真实设备。

只保留一套正式 Worker 协议。`LocalAIRuntime` 负责请求 ID、状态和生命周期；Worker 负责 Transformers.js、Cache API、完整性校验和 ONNX Runtime。`BuiltinEmbeddingProvider` 只做领域端口适配，RAG 不依赖 Worker 消息格式。

为了继续沿用 Obsidian 社区插件的 `main.js + manifest.json + styles.css` 三文件发布方式，构建脚本把 Worker 源码与 ORT WASM 二进制嵌入 `main.js`，运行时再创建 Blob Worker。这样不会在插件启动时访问 CDN，也不需要额外 Release 资产；代价是生产 `main.js` 约 21 MiB。模型权重不进入 Release，只有用户明确点击准备后才从固定 Hugging Face revision 下载。

Gate：生产构建只有标准三项 Release 资产；主线程不加载 pipeline；unload 直接终止 Worker；模型结果继续经过 M3 fingerprint 兼容检查。

## 5. 故障与测试

| 注入 | 必须观察 |
| --- | --- |
| 下载一半断网 | partial/error，不显示 ready，可取消/重试 |
| complete marker 在但文件缺失 | 重新验证失败，需准备；不循环加载 |
| 同时点 prepare | 一个 job，多个订阅者 |
| 切模型后旧下载完成 | 旧 job 不能覆盖新 policy 状态 |
| WebGPU 失败、WASM 也失败 | 一次有限回退后终止，keyword 可用 |
| 下载时清缓存 | 取消与清理有序，不在清理后写回 |
| 卸载后迟到事件 | 不改变 UI、缓存 manifest 或索引 |
| 升级缺 UI 新字段 | 保留 provider 与高级设置，补默认展示偏好 |

单测使用 fake clock/cache/loader；真实安装测试记录网络、磁盘变化与内存。只测状态序列不足以证明 WASM 或模型资产存在。

## 6. 完成与记录

- [x] 模型 policy 和依赖固定；来源、revision、许可证与资产 hash 可追溯。
- [ ] 下载由显式操作触发且可重试；目前显示文件级进度，尚无下载中的 UI 取消按钮与真实字节进度。
- [x] 当前 Embedding 角色由一个 runtime 管理，插件卸载会立即终止 Worker。
- [ ] 已实现离线暖加载和全资产损坏校验；仍待真实 Obsidian 冷/暖缓存人工验证。
- [x] query/document/graph 前缀进入 fingerprint，输出数量、维数和有限值受校验。
- [x] 旧用户配置保留，新安装仍默认 Ollama，只有用户主动选择才启用 builtin。
- [x] 生产 Worker、RAG router、设置、命令、构建和发布文档已经接通。

```text
实现 commit / PR：
M4 ADR 与 policy ID：
Cache namespace / manifest schema：
依赖与执行资源交付：
状态、并发、取消、清理测试：
真实设备 / 冷暖 / 网络 / 内存：
未解决项与 M6 输入：
```

2026-10-23：规划改为统一 LocalAIRuntime 基础设施，首个能力 Embedding；未执行实现测试。

## 7. 2026-10-24 开发记录：v1.5.3 内置 Embedding 代码快照

### 7.1 本次范围决定

用户要求暂停继续验证 M4，直接实现可发布的 M5。为避免发布一个“设置中能选但索引仍不能用”的半成品，本次同步提前完成原 M6 中与首个 Embedding 必须绑定的部分：生产 Worker、WASM 打包、provider router 和索引路径。没有提前实现内置聊天 LLM、reranker 或 WebGPU；当前后端固定为单线程 WASM。

### 7.2 最终调用链

```text
设置/命令中的显式准备动作
  -> VaultCoachRuntime.prepareBuiltinEmbedding()
  -> LocalAIRuntime.prepare(true)
  -> Blob Worker
  -> 固定 revision 下载/Cache API/四项 SHA-256 校验
  -> XLMRobertaTokenizer + AutoModel + FeatureExtractionPipeline

知识索引或查询
  -> EmbeddingProviderRouter
  -> BuiltinEmbeddingProvider
  -> LocalAIRuntime.embed()
  -> Worker 中按 query/document/graph 添加 E5 前缀
  -> mean pooling + L2 normalize
  -> Float32Array + EmbeddingFingerprint
```

### 7.3 关键工程决定及原因

1. **旧用户设置不迁移到 builtin。** `builtin` 只是新增合法枚举；默认值继续为 Ollama。升级不会改变已有向量空间或突然下载 129 MiB 模型。
2. **下载必须由用户明确触发。** 选择 provider 本身不会下载，普通 Ask 也不会静默联网；未准备时返回 `not-ready`，上层可以回退关键词检索。
3. **执行资源进入 Release，模型权重不进入 Release。** Worker 与 ORT WASM 随 `main.js` 交付，避免运行时获取代码；固定模型权重按用户授权下载并缓存。
4. **每次加载验证四个资产。** `config.json`、`tokenizer.json`、`tokenizer_config.json` 和 `model_uint8.onnx` 均有固定 SHA-256。损坏资产会被删除并要求重新准备，不能进入 ready。
5. **向量空间身份进入 fingerprint。** provider、repo、revision、dtype、pooling、normalization 和三类前缀变化都会造成不兼容，防止旧向量被新模型静默复用。
6. **卸载直接终止 Worker。** 不等待长下载或推理队列先处理 dispose，确保插件卸载不会留下后台任务。
7. **缓存清理不删除向量索引。** 相同固定模型重新准备后可继续使用同一 fingerprint；清缓存只释放模型资源。模型未准备期间查询会明确失败并回退。

### 7.4 发布版本与产物

- 版本：`1.5.3`
- Node：`20.20.2`，npm：`10.8.2`
- `main.js`：21,932,065 bytes；包含 Worker、Transformers.js 执行代码与 ORT WASM，不包含模型权重
- Release 资产仍为：`main.js`、`manifest.json`、`styles.css`
- `versions.json` 已增加 `1.5.3 -> 1.11.4`，并依据本地 Git tag 中各版本的 `manifest.json` 补齐历史发布映射
- `version-bump.mjs` 已修复为每个插件版本都写入映射，而不是错误地按最低 Obsidian 版本去重
- 第三方依赖与模型许可证记录在 `THIRD_PARTY_NOTICES.md`

### 7.5 自动化验证结果

在 Node 20.20.2 下执行：

```bash
npm test -- --run
npm run lint
npm run build
```

结果：65 个测试文件、267 个测试全部通过；ESLint 通过；TypeScript 与生产 esbuild 通过。新增测试覆盖旧默认值保留、`builtin` 迁移合法性、设置项按 provider 显示、adapter fingerprint、runtime 状态序列、错误和取消边界。

生产产物校验值：

```text
main.js      55670717d55f8798bb745637a0b1fd1a748d696247fe8667c389c811847a9834
manifest.json 061029dd3c9b0765322d7a30a911ee55487637366db47cc94342e1b81a8ea84d
styles.css   ccfe3f855d11579e3b5c1873806841a4efc52346296b44f65b7050afb45c582b
```

> 以上 SHA 对应本次工作区生产构建；任何后续源码、文档内嵌字符串或构建工具变化都会使 `main.js` SHA 改变，发版时应以 CI 产物为准。

### 7.6 发布前人工检查（因暂停 M4 复测而保留）

1. 在测试 Vault 安装 `1.5.3` 三项产物，确认插件能加载且设置页可展开。
2. 选择 **内置多语言 Embedding**，点击 **下载并加载**，观察首次下载和 ready 状态。
3. 重建知识索引，以中/英/德各一个问题确认向量检索能返回来源。
4. 完全退出 Obsidian，断网后重新打开，再点击 **检查并加载**，确认从暖缓存恢复。
5. 执行 **清除内置 Embedding 模型缓存**，确认笔记、向量索引和考试数据没有被删除；查询在重新准备前能安全回退。
6. 检查开发者控制台没有残留 Worker 错误，并观察长索引期间 UI 是否仍可交互。

当前未声明完成的项目：真实 Obsidian 冷/暖缓存 smoke、下载中取消按钮、按真实字节计算的下载进度、移动端兼容性。它们不应在发布说明中写成已验证能力。
