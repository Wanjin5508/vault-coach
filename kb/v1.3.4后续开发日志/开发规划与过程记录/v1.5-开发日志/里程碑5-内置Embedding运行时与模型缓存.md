---
tags: [VaultCoach, v1.5, 里程碑5, LocalAIRuntime, Cache]
status: implemented-runtime-smoke-passed-obsidian-e2e-pending
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
- [x] 已使用固定资产完成独立 Worker 的离线加载与真实 384 维推理；真实 Obsidian 重启后的暖缓存恢复仍待人工验证。
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
- `main.js`：21,886,715 bytes；包含 Worker、Transformers.js 执行代码与 ORT WASM，不包含模型权重
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
main.js      cd1d78689a9629d2d5ea192b6fedacdb4a89f1942b1715296b77c6ef76fdbd8f
manifest.json 061029dd3c9b0765322d7a30a911ee55487637366db47cc94342e1b81a8ea84d
styles.css   ccfe3f855d11579e3b5c1873806841a4efc52346296b44f65b7050afb45c582b
```

> 以上 SHA 对应本次工作区生产构建；任何后续源码、文档内嵌字符串或构建工具变化都会使 `main.js` SHA 改变，发版时应以 CI 产物为准。

### 7.6 仍需完成的发布前人工检查

1. 在测试 Vault 安装 `1.5.3` 三项产物，确认插件能加载且设置页可展开。
2. 选择 **内置多语言 Embedding**，点击 **下载并加载**，观察首次下载和 ready 状态。
3. 重建知识索引，以中/英/德各一个问题确认向量检索能返回来源。
4. 完全退出 Obsidian，断网后重新打开，再点击 **检查并加载**，确认从暖缓存恢复。
5. 执行 **清除内置 Embedding 模型缓存**，确认笔记、向量索引和考试数据没有被删除；查询在重新准备前能安全回退。
6. 检查开发者控制台没有残留 Worker 错误，并观察长索引期间 UI 是否仍可交互。

当前未声明完成的项目：真实 Obsidian 重启后的暖缓存 smoke、完整 RAG 重建与中/英/德查询、下载中取消按钮、按真实字节计算的下载进度、移动端兼容性。它们不应在发布说明中写成已验证能力。

## 8. 2026-10-24 发布预检与真实运行故障复盘

### 8.1 为什么要单独记录这一轮故障

本轮问题跨越了四个不同边界：社区插件静态规则、TypeScript 源码与发布 bundle 的同步、Electron Worker 的环境识别、ONNX Runtime JavaScript 工厂与 WASM 二进制的配对。任何一层通过都不能证明下一层可用。

故障按实际出现顺序如下：

| 阶段 | 用户可见现象 | 所属边界 | 最终结论 |
| --- | --- | --- | --- |
| 分支 Preview | 3 个 Error、2 个 Warning | Obsidian 社区插件静态检查 | API、DOM helper、类型和 ESLint 写法不符合发布规则 |
| 本地设置页 | Embedding provider 中没有内置模型 | 源码与安装产物 | Obsidian 加载的是旧版 `main.js`，不是当前 TypeScript |
| 首次准备 | `ONNX Runtime WebAssembly backend is unavailable` | Electron Worker 环境识别 | Transformers.js 把 Worker 误判成 Node 环境 |
| 模型下载完成后加载 | `no available backend found`，并提示无法解析 `worker_threads` | ORT 工厂解析 | 预填的 CDN `wasmPaths` 让 ORT 加载了外部工厂，外部工厂误走 Node 分支 |
| 修复过程的离线探针 | `_r.hc is not a function` | JS 工厂与 WASM ABI | WebGPU 入口内置 Asyncify 工厂，与标准 WASM 二进制不匹配 |
| 最终离线 smoke | 模型加载成功，输出 384 维向量 | 完整运行链 | WASM 专用入口、标准工厂和标准二进制配对正确 |

这组故障说明，发布验收至少要分别回答五个问题：源码是否正确、静态规则是否通过、构建产物是否最新、运行环境是否选中正确后端、模型是否真正完成一次推理。

### 8.2 Obsidian 分支 Preview 的五项问题

#### 8.2.1 Worker 中禁止无说明地关闭 ESLint 规则

Preview 报告：

```text
Unexpected undescribed directive comment.
Disabling 'no-restricted-globals' is not allowed.
src/infrastructure/local-ai/local-ai.worker.ts:82
```

原实现为了调用 Worker 的全局 `fetch`，使用了 `eslint-disable-next-line no-restricted-globals`。Obsidian 的发布检查不允许通过关闭规则绕开限制，而且 directive 没有符合检查器要求的说明。

最终修复：删除 directive，显式使用 `globalThis.fetch(...)`。

```ts
const response = await globalThis.fetch(url, { cache: "no-store" });
```

工程原因：`globalThis` 明确表达依赖的是 Worker 全局能力，也避免浏览器、Worker、Node 测试环境对裸全局名称作出不同解释。遇到 lint 规则时优先改成可读、可移植的代码，不把禁用规则作为常规解决方案。

#### 8.2.2 `setDestructive()` 超出声明的最低 Obsidian 版本

Preview 报告：

```text
Uses Obsidian APIs newer than the declared minAppVersion
obsidianmd/no-unsupported-api
src/settings.ts:635-637
```

`manifest.json` 声明的 `minAppVersion` 是 `1.11.4`，但按钮链式调用中的 `setDestructive()` 不在该兼容范围。仅仅因为本机安装的新 Obsidian 能编译和运行，不能证明社区目录声明的最低版本可用。

最终修复：保留旧版本支持的按钮 API，通过已存在的 Obsidian CSS class 表达警示按钮。

```ts
button.buttonEl.addClass("mod-warning");
```

工程原因：最低版本是发布契约。新增 API 时必须二选一：使用兼容写法，或者有意提高 `minAppVersion` 并同步 `versions.json`。不能只让 TypeScript 类型检查通过。

#### 8.2.3 无效类型断言

Preview 警告指出 `as UserSemanticDecision` 没有改变表达式类型。最终改为在变量声明处写明确类型：

```ts
const complete: UserSemanticDecision = { ... };
```

工程原因：变量注解会对对象字面量执行完整的结构检查；多余断言容易掩盖字段缺失或类型漂移，也增加审查噪声。

#### 8.2.4 直接使用 `document.createElement`

Preview 警告要求使用 Obsidian 的 `createEl` helper。Canvas 创建改为：

```ts
this.canvas = this.root.createEl("canvas", {
    cls: "vault-coach-learning-map-canvas",
    attr: { role: "img", "aria-label": options.accessibleTitle },
});
```

`createEl` 会直接把元素挂到目标容器，因此同步删除了后续 `appendChild`。工程收益是减少重复 DOM 操作，并与 Obsidian 的 UI 风格和插件检查保持一致。

#### 8.2.5 Preview 修复后的验证

修复后执行 `npm run lint`、`npm test` 和 `npm run build`。静态 Preview 问题全部对应到具体代码修改，不能用忽略 Warning 或提高 lint 容忍度解决。

### 8.3 设置页没有“内置模型”：旧 bundle 覆盖了新源码

#### 现象

`src/settings.ts` 已经在 `createEmbeddingProviderOptions()` 中返回 `builtin`，但本地测试 Vault 的下拉列表没有该选项。

#### 排查证据

当时工作区呈现出以下不一致：

- `package.json` 和 Git 中的 `manifest.json` 版本是 `1.5.3`；工作区里的 `manifest.json` 却被覆盖成 `1.5.2`。
- 当前 `main.js` 只有 `2,327,768` bytes，搜索不到内置 Embedding 的 UI 文案和 `builtin-worker-wasm` 标识。
- `dev`、`code`、`kaggle`、`kb` 四个 Vault 的插件副本均是相同的 1.5.2 旧产物。
- TypeScript 源码包含选项并不影响正在运行的 Obsidian；Obsidian 只执行插件目录中的 `main.js`。

#### 修复

1. 将 `manifest.json` 恢复为 `1.5.3`，与 `package.json` 和 Git 快照保持一致。
2. 使用 Node 20 执行生产构建：

```bash
npm run build
```

3. 在构建产物中检查内置 provider 文案和 Worker runtime 标识。
4. 完全重新加载插件，终止已经从旧 Blob 源创建的 Worker。

#### 防回归规则

- 调试设置页前同时检查源码、`manifest.json`、`main.js` 修改时间和 bundle 内关键字符串。
- 多 Vault 并存时先确认 Obsidian 当前打开的 Vault；每个 Vault 的 `.obsidian/plugins/vault-coach` 都是独立安装。
- 分支名、Git HEAD 和正在加载的 `main.js` 是三件事。切换分支不会自动重新构建，也不会自动把产物复制到其他 Vault。
- `main.js` 是生成物，不提交到仓库；本地人工测试前必须明确执行一次生产构建。

### 8.4 运行故障一：WASM backend unavailable

#### 错误

```text
内置 Embedding 模型准备失败：
ONNX Runtime WebAssembly backend is unavailable.
```

错误发生在 `prepare()` 的 `configureRuntime()` 阶段，早于 Cache API 访问和模型文件下载。代码读取 `env.backends.onnx.wasm` 时得到空值，于是主动抛出错误。

#### 根因链

1. Obsidian 桌面端基于 Electron，Worker 中可能暴露 `globalThis.process`。
2. Transformers.js 4.3.1 用 `process.release.name === "node"` 等条件判断 Node 环境。
3. Worker 实际需要浏览器版 `onnxruntime-web`，但环境探测却选择了 Node 分支。
4. Worker 的浏览器 bundle 没有携带 `onnxruntime-node`，所以 `env.backends.onnx` 保持空对象。
5. 单元测试使用 fake Worker，只验证协议和状态，无法暴露第三方库在 Electron 中的环境探测。

#### 修复

在生产 Worker 的 esbuild 边界加入：

```js
define: {
    process: "undefined",
}
```

这项定义只作用于内置 AI Worker，不修改 Obsidian 主线程。第三方依赖在打包时会把 Node 探测折叠为 false，从而稳定选择 Web runtime。

同时设置：

```ts
env.useWasmCache = false;
```

插件已经把受控版本的 WASM 二进制嵌入 `main.js`，无需 Transformers.js 再从 CDN 预加载另一份运行时。这里的“WASM cache”是 ORT 执行资源缓存开关，不是模型权重的 Cache Storage；关闭它不会删除或禁用模型缓存。

#### 第一层验证及其局限

环境探针在模拟 Electron 暴露 `process` 的 VM 中启动生产 Worker，并让 Cache API 抛出预设错误。探针能够到达 Cache API，证明 `env.backends.onnx.wasm` 已建立，但它没有创建 ONNX session，因此不能证明 JS 工厂、WASM 二进制和模型能够协同运行。下一次故障正是在更深一层验证中出现。

### 8.5 运行故障二：无法解析 `worker_threads`

#### 错误

```text
no available backend found. ERR: [wasm] TypeError:
Failed to resolve module specifier 'worker_threads'
```

这次模型下载、四项 SHA-256 校验和缓存写入已经成功，故障发生在 ONNX session 初始化阶段。因此不应让用户重新下载模型，也不应先怀疑模型权重损坏。

#### 根因链一：关闭预加载并不等于清除路径

Transformers.js 初始化浏览器 ONNX Runtime 时，会预填一个指向 jsDelivr 的 `env.backends.onnx.wasm.wasmPaths`。`env.useWasmCache = false` 只停止 Transformers.js 提前 fetch 这些文件，不会清除已经写入的路径。

ORT 初始化时仍看到 `wasmPaths`，于是动态导入外部 `.mjs` 工厂。该外部工厂没有经过本项目 esbuild 的 `process: undefined` 处理；它在 Electron 中再次看到 Node `process`，随后执行 `import("worker_threads")`。浏览器 Blob Worker 无法解析 Node 模块，最终把 WASM execution provider 标记为不可用。

修复是在设置嵌入二进制前显式清除路径：

```ts
wasmBackend.numThreads = 1;
wasmBackend.proxy = false;
wasmBackend.wasmPaths = undefined;
wasmBackend.wasmBinary = decodeBase64(__VAULT_COACH_ORT_WASM_BASE64__);
```

这四项共同表达完整策略：使用单线程、不再创建代理 Worker、不加载外部工厂、只使用插件嵌入的固定 WASM。

#### 根因链二：WebGPU bundle 的 Asyncify 工厂不能配标准 WASM

清除 `wasmPaths` 后，离线真实模型探针继续发现 `_r.hc is not a function`。这是工厂与二进制 ABI 不一致的典型表现：

- Transformers.js 默认导入 `onnxruntime-web/webgpu`。
- 该入口内置 `ort-wasm-simd-threaded.asyncify.mjs` 工厂，以兼容 WebGPU 路径。
- 项目嵌入的是 `ort-wasm-simd-threaded.wasm` 标准二进制。
- Asyncify 工厂与标准二进制的导入/导出表不同，不能交叉配对。

M5 的产品范围明确为 WASM CPU 推理，尚未承诺 WebGPU。因此没有把二进制扩大为 Asyncify 版本，而是在 Worker 的 esbuild 配置中把依赖定向到官方 WASM 专用入口：

```js
alias: {
    "onnxruntime-web/webgpu": "onnxruntime-web/wasm",
}
```

最终配对关系为：

```text
onnxruntime-web/wasm
  -> 标准 ort-wasm-simd-threaded.mjs 工厂
  -> 标准 ort-wasm-simd-threaded.wasm 二进制
  -> executionProviders: ["wasm"]
```

如果后续里程碑启用 WebGPU，必须把它作为新的 runtime policy：重新选择 JSEP/Asyncify 工厂和匹配的 WASM，单独测试回退行为，不能只把 `device` 改成 `webgpu`。

### 8.6 最终运行时配置的职责边界

最终方案分为构建期和运行期两层：

| 层 | 配置 | 目的 |
| --- | --- | --- |
| Worker 构建期 | `platform: "browser"`、browser conditions | 使用 Web API 和浏览器依赖导出 |
| Worker 构建期 | alias 到 `onnxruntime-web/wasm` | 固定标准 WASM 工厂，排除 WebGPU/Asyncify 变体 |
| Worker 构建期 | `process: "undefined"` | 消除 Electron 对第三方环境探测的干扰 |
| Worker 构建期 | 注入 WASM base64 | 保持三文件 Release，不在运行时下载执行代码 |
| Worker 运行期 | `numThreads = 1` | 不依赖 cross-origin isolation 和嵌套线程 |
| Worker 运行期 | `proxy = false` | 当前 Worker 直接执行，不再代理到另一个 Worker |
| Worker 运行期 | `useWasmCache = false` | 不从 CDN 预加载另一份执行资源 |
| Worker 运行期 | `wasmPaths = undefined` | 禁止外部工厂 URL 覆盖 bundle 内工厂 |
| Worker 运行期 | `wasmBinary = ...` | 使用构建时固定的 WASM 二进制 |
| 模型资源 | Cache Storage + SHA-256 | 用户授权后下载权重，可离线复用并检测损坏 |

执行代码与模型数据必须继续分开治理。`main.js` 中的 Worker/ORT 属于受版本控制的 Release 执行资源；Hugging Face 上的模型权重属于用户显式授权后下载并校验的数据资源。

### 8.7 最终验证证据

#### 自动化检查

在 Node 20.20.2 下重新执行：

```bash
npm run lint
npm test
npm run build
```

结果：

- ESLint：通过。
- Vitest：65 个测试文件、267 项测试通过。
- TypeScript 与生产 esbuild：通过。
- `git diff --check`：通过。
- 最终 `main.js` 不包含 `worker_threads` 字符串。

#### 完整离线模型 smoke

验证使用 M4 留存的固定 revision 资产，未访问网络：

```text
repository: Xenova/multilingual-e5-small
revision: 761b726dd34fb83930e26aab4e9ac3899aa1fa78
model: onnx/model_uint8.onnx
model bytes: 118,054,630
```

探针使用与生产完全相同的 Worker entry、esbuild alias、`process` define 和嵌入 WASM，并在 VM 中主动暴露一个 Electron 风格的 `process`。Cache API 返回真实 tokenizer、config 和 ONNX 模型，随后执行一条中文 query embedding。

结果：

```json
{
  "prepare": "pass",
  "inference": "pass",
  "dimension": 384,
  "latencyMs": 79
}
```

79 ms 是本机一次 smoke 的观察值，不是性能承诺。该验证证明环境选择、缓存读取、tokenizer 恢复、ONNX session 创建、标准 WASM ABI 和向量输出能够贯通；它不能替代不同操作系统、Obsidian 版本和移动端测试。

#### 当前生产产物快照

```text
main.js       21,886,715 bytes
main.js SHA-256       cd1d78689a9629d2d5ea192b6fedacdb4a89f1942b1715296b77c6ef76fdbd8f
manifest.json SHA-256 061029dd3c9b0765322d7a30a911ee55487637366db47cc94342e1b81a8ea84d
styles.css SHA-256     ccfe3f855d11579e3b5c1873806841a4efc52346296b44f65b7050afb45c582b
```

这些值只用于定位本次快照。后续任何源码或构建工具变化都必须重新构建并记录新值。

### 8.8 人工复测步骤

修复后必须完全重启 Obsidian，仅关闭设置页不够，因为失败的 Blob Worker 仍可能存活在当前插件生命周期中。

1. 确认当前 Vault 的插件目录确实是本次构建所在目录。
2. 完全退出并重新启动 Obsidian，或关闭再启用 Vault Coach。
3. 选择 **内置多语言 Embedding**。
4. 点击 **下载并加载**。已有完整缓存时应直接校验并加载，不应再次下载约 129 MiB。
5. 确认状态进入 ready，开发者控制台没有 `worker_threads`、backend unavailable 或 WASM link 错误。
6. 重建知识索引，执行至少一个查询，确认结果来自 builtin provider 且引用正常。
7. 完全退出 Obsidian，断网重启，再点击 **检查并加载**，验证真实 Cache Storage 暖启动。

如果仍报错，记录完整控制台堆栈、Obsidian 版本、操作系统、插件目录、`manifest.json` 版本、`main.js` 字节数和是否命中缓存。只保留 Notice 的最后一行通常不足以判断失败发生在下载、校验、tokenizer、session 还是推理阶段。

### 8.9 后续开发规范

1. **增加真实运行层测试。** fake Worker 单测保留，但涉及第三方 ML runtime 时必须再有一个创建真实 session 并执行最小推理的离线 smoke。
2. **工厂与二进制视为同一制品。** 文件名相似不代表 ABI 兼容；标准、JSEP、JSPI、Asyncify 必须成对固定版本与 hash。
3. **不要依赖第三方自动环境探测。** Electron 同时具有浏览器和 Node 特征；在构建边界明确选择 runtime，比运行时报错后回退更可靠。
4. **关闭开关后检查残留配置。** `useWasmCache = false` 没有清除 `wasmPaths`，说明布尔开关和路径状态需要分别核对。
5. **验证要逐层加深。** 能到达 Cache API、能下载模型、能创建 session、能输出向量、能完成 RAG 查询是五个不同 Gate。
6. **发布前检查实际安装物。** 对测试 Vault 中的 `main.js` 做版本、大小和关键字符串检查，避免把源码完成误报为插件已更新。
7. **WebGPU 作为独立里程碑。** 引入 WebGPU 时重新做模型、ORT 变体、WASM、缓存、回退、内存和兼容性验证，不复用本次 WASM 结论作替代。
