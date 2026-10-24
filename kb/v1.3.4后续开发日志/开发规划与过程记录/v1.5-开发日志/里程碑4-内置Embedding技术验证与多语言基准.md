---
tags: [VaultCoach, v1.5, 里程碑4, LocalAIRuntime, Benchmark]
status: code-ready-pending-manual-validation
updated: 2026-10-24
depends-on: [里程碑3-EmbeddingProvider解耦与索引指纹.md]
gate: GO-NO-GO
---

# 里程碑 4：先确定运行地点，再验证内置 Embedding

## 1. 目标和范围

按 [[01-LocalAIRuntime架构与跨里程碑契约]]，在真实 Obsidian 中验证 Transformers.js/ONNX Runtime Web + Worker + WASM/WebGPU 的可行性，再选择 Embedding 模型。先完成这一 Gate，才能进入 M5；Reranker/Utility 这里只建立候选与评测协议，正式质量 Gate 分别留到 M6.1/M6.2。

优先评估浏览器兼容栈；sidecar 可以列入被比较方案，但不能无声地变成“内置”的实现，因为它会增加安装和移动端限制。若浏览器方案无法通过发布资产或资源门槛，记录 NO-GO 和替代 ADR，保留现有 HTTP/keyword。

## 2. 起点和依赖

内部：M3 窄端口、modelDtype 指纹、代际 store、fake suite；当前 esbuild/CJS、PDF.js 兼容补丁、manifest 的移动端声明。

外部：候选 Transformers.js 确切 npm 版本、匹配的 ONNX Runtime、ONNX 模型资产及许可证、真实 Obsidian 桌面和移动设备。新增依赖只进入隔离 spike，确认依赖树不会意外引入 Node-only 包。官方已发布 v4 公告，优先纳入验证；鉴于文档入口版本提示不一致，仍需核对 npm 实际版本及相应 API，详见共用契约的官方依据。

## 3. 文件与产物

| 文件 | 状态 | 工作 |
| --- | --- | --- |
| `package.json`、`package-lock.json`、`esbuild.config.mjs` | 已有 | 隔离 spike 验证版本与 bundle，不提前修改默认路由 |
| `scripts/spikes/local-ai/embedding-smoke.mjs` | 已新增 | 一句文本→向量、load/dispose、离线加载 |
| `scripts/spikes/local-ai/worker-smoke.mjs` | 已新增 | 发布形态下的 Worker/WASM/WebGPU smoke worker |
| `scripts/spikes/local-ai/obsidian-smoke-plugin.mjs` | 已新增 | 独立 smoke 插件、显式下载授权、取消与结果落盘 |
| `scripts/spikes/local-ai/build-obsidian-smoke.mjs` | 已新增 | 构建临时插件并复制本地 WASM/JSEP 资产 |
| `benchmarks/local-ai/protocol.json` | 已新增 | 固定指标、预算、设备、预热、失败标准；当前待负责人批准 |
| `benchmarks/local-ai/models.json` | 已新增 | 候选账本、资产清单、hash/revision 与许可证状态 |
| `benchmarks/retrieval-v1/{corpus,queries.zh,queries.en,queries.de}.jsonl` | 已新增 | 18 个合成 chunk、中英德各 20 个复核问题 |
| `scripts/run-local-ai-benchmark.mjs` | 已新增 | 统一测量、关键词基线、原始排名和决策结果 |
| `benchmark-results/local-ai/<run-id>/` | 运行时产物 | environment、metrics、failures、decision；默认忽略生成结果 |
| 本目录 `ADR-LocalAIRuntime运行地点与资产交付.md` | 已新增 | 候选运行地点、资产契约与 GO/NO-GO 条件 |
| 本目录 `M4-内置Embedding手工技术验证指南.md` | 已新增 | 安装、命令、Obsidian 真机和故障注入步骤 |

脚本已存在，但真实模型下载、benchmark 和真机 smoke 不会由普通测试自动触发。必须按 [[M4-内置Embedding手工技术验证指南]]显式执行。

## 4. 候选与证据边界

候选账本至少列出：

| 角色        | 起步候选范围                                                 | 本阶段结论                                 |
| --------- | ------------------------------------------------------ | ------------------------------------- |
| Embedding | 多语言 MiniLM / multilingual E5 small 类有 ONNX 资产的 encoder | 完成中英德质量和完整环境 Gate                     |
| Reranker  | 小型 cross-encoder；英文小模型可做性能对照，多语言模型独立候选                 | 核对资产、pair tokenizer、logits 语义；不承诺默认选型 |
| Utility   | 约 200M–600M instruct 探索范围；Qwen2.5-0.5B ONNX 可做教学起点     | 核对生成 smoke 与资源；不把短 JSON 成功等同业务达标      |

名称只是搜索起点。每个候选必须填精确 repo、revision、来源/模型许可证、ONNX 文件、tokenizer、参数量、dtype、下载实测字节、上下文上限、语言覆盖声明、实测支持设备。未填完的候选不能进入正式 policy。

下载容量不等于运行内存；“三模型不到 1 GB”仅是预算假设。量化精度、logits/score 解释、query/document 前缀都必须对应模型说明。

## 5. 按步骤实施

### Step 1：冻结实验协议

内部依赖：M3 指纹和消费者契约。外部依赖：合法可提交语料、目标设备清单。

先为中文、英文、德文各建立至少 20 个人工复核问题，覆盖同义表达、缩写、负样本、PDF 噪声、无答案与跨语言查询。划分调参集与锁定验收集；小样本不作总体质量保证。语料保存 chunk ID 与相关性标注，不包含私人 Vault。

在跑模型前填门槛：每语言 Recall@10 下限、相对基线允许下降、query P95、索引吞吐、冷/暖加载、内存与 bundle/缓存预算。每项写单位、设备、样本数、依据与通过方向。没有数值就保持 pending，不能产生 GO。

Gate：协议已冻结且可由另一开发者复跑；错误标注有修正记录。

### Step 2：先跑发布形态 smoke

内部依赖：当前 esbuild 与 release asset 契约。外部依赖：固定库版本与最小模型。

在独立干净 Vault 中只放正式安装资产，尝试创建 Worker、定位 WASM、加载一句文本并释放。检查最终 main.js 是否包含缺失路径、CDN import 或 Node-only 依赖。先验证此项再批量跑分，避免选中无法交付的 runtime。

Worker JS 和 WASM 的交付方式必须符合发布约束；模型权重可在授权后下载，远程执行代码不能伪装成模型资源。若需要修改发布资产契约，先证明社区安装路径能带齐资源；失败即 NO-GO。

Gate：记录实际文件清单、构建 hash、网络请求、CSP 和真机结论；浏览器网页 demo 不算插件证据。

### Step 3：验证资产与离线加载

内部依赖：M3 descriptor/fingerprint。外部依赖：固定模型 revision 和缓存 API。

验证 query/document/graph 预处理、pooling、normalization、dimension、modelDtype；输出条数、有限数和维数符合 contract。分别测试首次下载、取消、缓存缺文件、驱逐、断网重启、清除后重建。

`allowRemoteModels = false` 只是来源策略；权重、tokenizer、配置和执行资源都齐全才可能离线。记录哪些资源被 HTTP 请求，不上传查询和笔记。

Gate：offline warm 真正无网络且有向量输出；cache marker 单独存在不判 ready。

### Step 4：分别测质量与性能

内部依赖：冻结协议、黄金标注。外部依赖：真实 device/provider。

先对当前外部 embedding 和 keyword 建基线，再比较候选；固定 corpus/chunker/Top-K/RRF，避免归因混乱。测 Recall@5/10、MRR、每语言与失败切片，保存原始排名。

性能测 batch 1/8/16/32 中设备能承受的组合，记录 query P50/P95、chunks/s、初始化、CPU/GPU内存观察方式、主线程 long task。不要为了凑满 batch 矩阵导致移动端 OOM；失败本身是预算证据。

Gate：每组记录冷/暖、重复次数、设备/OS/Obsidian、库/模型版本和完整空间指纹。

### Step 5：验证跨角色复用假设

内部依赖：共用架构契约。外部依赖：候选 reranker/utility 资产或 fake loader。

做“加载 embedding → dispose → 加载另一 role → dispose”的小实验，记录资源回收和换入耗时。默认按单活跃模型设计；不依据磁盘体积声称可以三模型常驻。

验证 reranker 是否支持真实 pair 输入、正确 scoring head；utility 是否有兼容 chat template、量化和生成算子。不在本阶段优化它们的任务质量，也不要求为此下载所有候选。

Gate：M5 能得到统一 loader/cache/scheduler 所需信息；不兼容项进入各自里程碑，不隐瞒。

### Step 6：输出 ADR 和分平台结论

内部依赖：前五步证据。外部依赖：无。

按“模型 + dtype + runtime + device”给 GO、NO-GO、pending。桌面 GO 不推导移动端 GO。WebGPU API 存在不代表模型运行通过；WASM 也需独立验证速度和内存。

失败时可缩小模型、减少 batch 或调整资产方案后重新执行受影响实验；保持原协议或明确新版本，不篡改旧结果。

## 6. Gate 和交接

- [ ] Embedding 各语言下限通过，失败样本已解释。
- [ ] 发布形态 Worker/WASM 可运行；无隐式远程代码加载。
- [ ] 冷/暖/离线/取消/缓存损坏有证据。
- [ ] 实际平台能力矩阵已记录，未测项保持 pending。
- [ ] dtype 与前缀进入 M3 fingerprint；数值兼容性有证据。
- [ ] 三角色候选与资源策略有账本，不把估计当测量。
- [ ] M5 收到固定 policy、资产 manifest、执行资源交付方案与资源预算。

## 7. 工程练习与记录

练习定位一次“维数正确但召回变差”：检查前缀、pooling、tokenizer、截断和 normalization，不能只增加 Top-K。再复现一次 Worker 资源路径失败，区分构建、安装、运行三层原因。

```text
实验 commit / Node / npm：
依赖版本 / 文档版本：
设备 / Obsidian / 执行后端：
模型 repo / revision / dtype / license：
协议版本 / 预登记门槛：
每语言质量与排名文件：
下载、磁盘、峰值运行内存：
发布形态 / 离线 / 故障结果：
GO / NO-GO / pending：
交给 M5、M6.1、M6.2 的限制：
```

## 8. 2026-10-24 开发日志：代码与文档快照

### 8.1 已完成

- 锁定 `@huggingface/transformers@4.3.1` 为开发依赖并更新 lockfile；正式 `src/` 未引用该依赖；
- 增加 `m4:validate`、`m4:smoke:embedding`、`m4:benchmark`、`m4:build:obsidian-smoke` 四个显式命令；
- 实现 Node 文件缓存配置、向量 contract 校验、cosine 排名、Recall/MRR、延迟分位数、关键词基线和原子结果写入；
- 构建独立 `vault-coach-m4-smoke` 插件，支持 WASM/WebGPU、下载确认、offline-only、Worker 取消和结果落盘；
- 建立 18 个公开合成 chunk 和中英德各 20 个 query；验收集包含跨语言、PDF 噪声和 no-answer；
- 建立候选模型账本。默认候选锁定 `Xenova/multilingual-e5-small` revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78` 和 uint8 权重 SHA-256；许可证仍 pending；
- 写入 [[M4-内置Embedding手工技术验证指南]]和 [[ADR-LocalAIRuntime运行地点与资产交付]]。

### 8.2 已执行验证

```text
npm run m4:validate: PASS
dataset: 18 chunks / 60 queries / 2 candidates
npx eslint scripts/spikes/local-ai scripts/run-local-ai-benchmark.mjs: PASS
npm run m4:build:obsidian-smoke: PASS
smoke output: approximately 42 MiB
worker bundle: approximately 1.3 MiB
Node model smoke preflight before environment upgrade: BLOCKED on Node v18.16.0; script correctly required Node >= 20.9.0 and saved a failure snapshot
Development environment upgrade: Node v20.20.2 / npm 10.8.2
npm ci, npm run lint, npm test (261), npm run build: PASS on Node v20.20.2
```

构建成功只证明工具链可以产出文件，不证明模型已经在 Obsidian 运行。

### 8.3 尚未完成

- 协议负责人批准；
- 模型和 upstream 许可证人工核对；
- 真实模型下载和 Node smoke；
- 三语真实 benchmark；
- Obsidian Desktop WASM/WebGPU、离线重启、取消和缓存损坏验证；
- iOS / Android 验证；
- 最终 GO/NO-GO 和 accepted ADR。

### 8.4 工程限制

- 项目以 `.nvmrc` 和 `package.json#engines` 固定 Node 20 开发基线，Release workflow 读取同一版本文件；
- Node CLI 使用 Transformers.js Node 入口，只提供质量和 CPU/WebGPU 参考，不把 `onnxruntime-node` 结果冒充浏览器 Worker/WASM 证据；
- 约 42 MiB 是同时携带 WASM 与 JSEP 的 spike 体积，M5 必须重新决定生产资产组合；
- benchmark 的 Node RSS 不是精确 GPU 显存；
- 协议状态不是 `approved` 时，脚本最多输出 pending；
- `.m4-smoke-plugin/`、`.m4-model-cache/` 和普通 run 结果均不进入版本控制。

### 8.5 真实 CPU smoke 结果与分析

2026-10-24 在 Node v20.20.2、macOS arm64、CPU、Transformers.js 4.3.1 环境执行：

```bash
npm run m4:smoke:embedding -- --allow-download --device cpu
```

联网首次运行结果为 `pass`，原始结果位于忽略目录：

```text
benchmark-results/local-ai/embedding-smoke-2026-10-24T18-58-08-453Z/smoke.json
```

| 观察项 | 结果 | 解释 |
| --- | ---: | --- |
| 候选 | multilingual-e5-small-uint8 | revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78` |
| loadMs | 9,067.46 ms | 包含首次下载/冷准备，不能与 5,000 ms 暖加载门槛比较 |
| inferenceMs | 27.28 ms | 三次单文本 smoke 的一次汇总，不是 query P95 |
| dimension | 384 | 符合候选 contract |
| query/document/graph norm | 约 1.0 | normalize 生效，向量为有限值 |
| RSS | 594.59 MiB | 低于 1,024 MiB 建议门槛，但只是进程时点 RSS，不是可靠峰值 |
| cachedBefore / cachedAfter | false / true | 首次运行写入了模型缓存 |
| 缓存目录体积 | 129 MiB | 包含配置、tokenizer 和 uint8 ONNX 权重 |
| 权重 SHA-256 | `ee13574a...cc9c8f1` | 与候选账本完全一致 |

该结果证明：Node CPU 入口可以在联网状态下载候选、实例化 pipeline，并为 query、document 和 graph 前缀生成符合 384 维及归一化 contract 的向量。它不证明检索质量、P95、吞吐、暖加载、Obsidian Worker/WASM/WebGPU 或移动端可用。

请求日志同时出现 `resolve/main/...` 和锁定 revision 路径。虽然最终 revision 目录中的 ONNX 权重哈希匹配，前置的 `main` 请求仍破坏了“所有候选资产都来自不可变 revision”的严格证据边界。正式实现必须找出请求来源，并确保配置、tokenizer 和权重全部按锁定 revision 获取和验证。

随后在新进程中禁止下载执行：

```bash
npm run m4:smoke:embedding -- --device cpu
```

离线复跑结果为 `fail`，原始结果位于：

```text
benchmark-results/local-ai/embedding-smoke-2026-10-24T19-03-42-016Z/smoke.json
```

失败信息：

```text
TypeError: this.tokenizer is not a function
```

该运行没有产生网络请求，说明 offline-only 门禁生效；但磁盘缓存重新加载后的 pipeline tokenizer 没有形成可调用对象。当前证据指向 Transformers.js v4 Node FS cache 重载路径、ModelRegistry 预取路径或两者组合的缓存兼容问题。尚未完成根因定位，不能直接归因于模型文件损坏，因为 tokenizer 文件存在且模型权重哈希正确。

本轮判定：

```text
Node CPU 首次联网 smoke：PASS
权重完整性：PASS
离线进程重启：FAIL
暖加载指标：UNMEASURED
检索质量和吞吐：UNMEASURED
Obsidian WASM/WebGPU：UNMEASURED
M4 GO/NO-GO：PENDING（离线缓存是阻断项）
```

进入下一轮验证前必须：

1. 为离线 pipeline 加载问题建立最小复现，检查 tokenizer 实例类型及 FS cache 路径；
2. 消除或解释 `resolve/main` 请求，保证全部资产由不可变 revision 约束；
3. 修复后重新执行一次允许下载、两次独立进程 offline-only，并保存三次结果；
4. 只有离线重启通过后，才运行三语 retrieval benchmark，避免在失效缓存路径上生成无意义性能结论。

### 8.6 离线缓存修复与首轮三语 benchmark

#### 根因与修复

`@huggingface/transformers@4.3.1` 的 `pipeline()` 会先调用内部 `get_pipeline_files()` 判断 pipeline 需要哪些资产，但该预扫描没有转发调用方提供的 `revision`、`cache_dir` 和 `local_files_only`。`AutoTokenizer.from_pretrained()` 的 tokenizer 文件发现也存在同类行为。由此产生两个现象：

1. 联网运行额外查询 `main`；
2. 离线运行无法通过仓库 ID 发现锁定 revision 中已经缓存的 tokenizer，最后构造出不可调用的 tokenizer。

修复策略：

- 不再用 `pipeline()` 创建 Node 参考 pipeline；
- 显式调用 `AutoTokenizer` 和 `AutoModel`，再构造 `FeatureExtractionPipeline`；
- offline-only 模式直接以 `.m4-model-cache/<repo>/<revision>/` 作为本地模型目录，完全绕过 Hub 元数据发现；
- 不再用存在相同 revision 缺陷的 `ModelRegistry` 判断 Node 缓存，改为检查账本要求的四个具体文件；
- 保留 ONNX SHA-256 校验作为内容完整性证据。

为确认修复不依赖遗留的 `main/config.json`，验证前将该文件移出缓存目录。随后两个独立 Node 进程连续通过：

| 运行 | loadMs | 三文本 inferenceMs | RSS MiB | 网络请求 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| offline-1 | 493.42 | 19.56 | 697.56 | 0 | PASS |
| offline-2 | 496.14 | 18.19 | 684.61 | 0 | PASS |

两次运行均为 `cachedBefore=true`、`cachedAfter=true`，向量维度为 384，三个向量 norm 与首次联网运行一致。由此关闭“Node FS cache 无法离线重启”的阻断项。该修复只证明 Node 参考路径；Obsidian Cache API、Worker 和 WASM 仍需独立验证。

#### 首轮 acceptance benchmark

修复后以 CPU、batch size 8、offline-only 运行三语 acceptance 集。首次运行发现 benchmark 局部变量 `performance` 遮蔽 Node 全局对象，导致 temporal dead zone；将结果变量改名为 `performanceMetrics` 后运行成功。结果文件位于忽略目录：

```text
benchmark-results/local-ai/retrieval-benchmark-2026-10-24T19-11-53-105Z/benchmark.json
```

性能结果：

| 指标 | 结果 | 建议门槛 | 本轮判断 |
| --- | ---: | ---: | --- |
| 暖加载 | 504.38 ms | ≤ 5,000 ms | 通过建议值 |
| corpus throughput | 179.13 chunks/s | ≥ 8 chunks/s | 通过建议值 |
| query latency P95 | 4.58 ms | ≤ 300 ms | 通过建议值 |
| RSS | 752.41 MiB | ≤ 1,024 MiB | 通过建议值，但仍是 Node 时点 RSS |

质量结果：

| 语言 | Recall@10 | 门槛 | MRR | 门槛 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| 中文 | 0.9286 | ≥ 0.80 | 0.5110 | ≥ 0.60 | MRR 未通过 |
| 英文 | 0.9643 | ≥ 0.80 | 0.6495 | ≥ 0.60 | 通过建议值 |
| 德文 | 0.9286 | ≥ 0.80 | 0.5643 | ≥ 0.60 | MRR 未通过 |

Embedding 的三语 Recall@10 均高于关键词基线；英文 MRR 明显高于关键词基线，中文 MRR 略低于关键词基线，德文 MRR 仅小幅提高。说明候选有较好的候选集覆盖能力，但中文和德文的首个相关结果排序仍需通过 hybrid、query 前缀/标注复核或 rerank 改善。

无答案查询只有每语言 2 个，且 embedding Top1 cosine 仍较高（中文约 0.867–0.877、英文约 0.801–0.806、德文约 0.773–0.789）。样本不足以确定拒答阈值，同时说明 cosine 绝对值不能跨语言直接套用单一阈值。

本轮状态仍为 `pending`，原因是协议尚未批准、中文和德文 MRR 未达到建议值，并且 Obsidian 与移动端矩阵尚未执行。离线缓存已经从阻断项变为 PASS。

2026-10-23：规划修订，未安装依赖或执行真实 benchmark。官方 API 依据见 [[01-LocalAIRuntime架构与跨里程碑契约]]。
