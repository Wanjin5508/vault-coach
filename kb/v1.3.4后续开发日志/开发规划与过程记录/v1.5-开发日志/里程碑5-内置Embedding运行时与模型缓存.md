---
tags: [VaultCoach, v1.5, 里程碑5, LocalAIRuntime, Cache]
status: planned
updated: 2026-10-23
depends-on: [里程碑4-内置Embedding技术验证与多语言基准.md]
---

# 里程碑 5：LocalAIRuntime 基础设施与首个内置 Embedding

## 1. 目标

使用 M4 通过 Gate 的策略建立统一模型资源生命周期，首个接入能力是 Embedding。缓存、下载、状态和释放归 LocalAIRuntime 管理；具体 embedding 输出归 BuiltinEmbeddingProvider。后续 reranker/utility 复用基础设施，不再复制三套下载器。

M5 不翻转新用户默认值。M4 已证明 Worker 可以交付；M5 先完成状态/资源逻辑与 adapter，M6 完成 Worker 生产化和索引接通。M5 任何真实重推理 smoke 也运行在已验证的 Worker 路径，不能先发布主线程推理后再优化。

## 2. 依赖和文件

内部：M3 provider/fingerprint/安全索引代际，M4 固定 policy/资产与平台结论；共用契约。

外部：M4 选定版本的 Transformers.js/ONNX Runtime，Cache API 或经验证的 Vault cache adapter，固定模型资产。

| 文件 | 状态 | 修改 |
| --- | --- | --- |
| `src/domain/local-ai/local-ai-types.ts` | M3 拟建 | 细化 per-role status、prepare request、错误 |
| `src/app/local-ai/local-ai-runtime.ts` | 拟新增 | 门面、任务状态、prepare/cancel/clear/subscribe |
| `src/app/local-ai/model-registry.ts` | 拟新增 | 不可变模型策略与能力注册 |
| `src/infrastructure/local-ai/model-loader.ts` | 拟新增 | 封装第三方加载、事件、dispose |
| `src/infrastructure/local-ai/model-cache.ts` | 拟新增 | 资产 manifest、hash、partial、namespace |
| `src/infrastructure/embedding/builtin-embedding-provider.ts` | 拟新增 | 实现 M3 窄端口，返回指纹与诊断 |
| `src/app/application-container.ts`、`src/app/application-api.ts` | 已有 | 注入唯一 runtime，暴露只读状态与动作 |
| `src/app/config/{settings-types,settings-schema,settings-migrations,settings-defaults}.ts` | 已有 | 增加 builtin 可选配置，旧值保持 |
| `src/settings.ts`、`src/presentation/settings/settings-section-model.ts`、`src/i18n.ts` | 已有 | 进阶设置内的模型状态和准备动作 |
| `tests/app/local-ai/*`、`tests/infrastructure/local-ai/*` | 拟新增 | fake loader/cache、状态与完整性测试 |

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

### Step 6：交给 M6 做生产 Worker 接入

内部依赖：完整 fake suites 与 Worker smoke。外部依赖：真实设备。

不在 M5 添加另一套正式 worker 协议。冻结 loader/cache/runtime 和未来 M6 client 之间的接口；M6 负责 IPC、调度和真实索引进度。M5 的 product flag 维持关闭，内部实测通过也不能直接称“开箱即用”。

Gate：M6 能只替换执行桥，继续复用缓存和状态逻辑。

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

- [ ] 模型 policy 和依赖固定；来源/许可证可追溯。
- [ ] 下载显式、可取消、可重试，真实字节进度。
- [ ] 每角色状态与资源身份独立；一个 runtime 管生命周期。
- [ ] 离线暖加载与缓存损坏验证完成。
- [ ] query/document/graph fingerprint 一致且受校验。
- [ ] 旧用户配置保留，默认值未提前翻转。
- [ ] M6 所需桥接接口、限制和 evidence 已交付。

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
