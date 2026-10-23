---
tags: [VaultCoach, v1.5, 里程碑4, LocalAIRuntime, Benchmark]
status: planned
updated: 2026-10-23
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
| `scripts/spikes/local-ai/embedding-smoke.ts` | 拟新增 | 一句文本→向量、load/dispose、离线加载 |
| `scripts/spikes/local-ai/worker-smoke.ts` | 拟新增 | 发布三件套环境下的 Worker/WASM smoke |
| `benchmarks/local-ai/protocol.json` | 拟新增 | 固定指标、预算、设备、预热、失败标准 |
| `benchmarks/local-ai/models.json` | 拟新增 | 三角色候选账本、资产清单、hash/revision |
| `benchmarks/retrieval-v1/{corpus,queries.zh,queries.en,queries.de}.jsonl` | 拟新增 | 人工标注语料和相关 chunk |
| `scripts/run-local-ai-benchmark.mjs` | 拟新增 | 统一测量入口，记录原始结果 |
| `benchmark-results/local-ai/<run-id>/` | 拟新增产物 | environment、metrics、failures、decision |
| 本目录 `ADR-LocalAIRuntime运行地点与资产交付.md` | 实施时新增 | 运行地点、打包、缓存和设备结论 |

新建 benchmark 脚本后才执行它们；上述脚本目前不存在。

## 4. 候选与证据边界

候选账本至少列出：

| 角色 | 起步候选范围 | 本阶段结论 |
| --- | --- | --- |
| Embedding | 多语言 MiniLM / multilingual E5 small 类有 ONNX 资产的 encoder | 完成中英德质量和完整环境 Gate |
| Reranker | 小型 cross-encoder；英文小模型可做性能对照，多语言模型独立候选 | 核对资产、pair tokenizer、logits 语义；不承诺默认选型 |
| Utility | 约 200M–600M instruct 探索范围；Qwen2.5-0.5B ONNX 可做教学起点 | 核对生成 smoke 与资源；不把短 JSON 成功等同业务达标 |

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

2026-10-23：规划修订，未安装依赖或执行真实 benchmark。官方 API 依据见 [[01-LocalAIRuntime架构与跨里程碑契约]]。
