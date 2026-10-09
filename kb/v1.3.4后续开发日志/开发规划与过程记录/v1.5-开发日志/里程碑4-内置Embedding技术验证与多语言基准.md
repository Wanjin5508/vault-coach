---
tags: [VaultCoach, v1.5, 里程碑4, Benchmark, ADR]
status: planned
updated: 2026-10-09
depends-on: [里程碑3-EmbeddingProvider解耦与索引指纹.md]
gate: GO-NO-GO
---

# 里程碑 4：内置 Embedding 技术验证与多语言基准

## 1. 目标

用可复现证据选择内置 embedding 模型与运行方案，并验证 Obsidian 单文件发布、浏览器缓存、WASM/WebGPU、Worker 和移动端是否可行。本里程碑只做 spike 与 benchmark，不把候选模型直接设为产品默认值。

学习重点：基准设计、数据标注、性能分析、浏览器运行时、架构决策记录（ADR）和 GO/NO-GO 判断。

## 2. 必须回答的问题

1. 中文、英文、德文检索质量是否都有可接受下限？
2. 冷启动下载、暖启动、索引吞吐、查询延迟和峰值内存是多少？
3. batch 8/16/32 的收益和内存代价是什么？
4. 量化 dtype 对质量、体积和运行时有何影响？
5. 模型、tokenizer、WASM 文件如何被缓存、清理和离线复用？
6. WebGPU 不可用或失败时，WASM 是否稳定回退？
7. Worker 能否与当前 esbuild CommonJS 和 release assets 兼容？
8. Obsidian Mobile 是否能在内存和 API 约束下完成最小索引？
9. 首次下载时能否获得真实字节进度并取消？
10. 用户笔记是否始终不离开本机？

## 3. 候选与控制变量

从产品文档候选开始：multilingual MiniLM、multilingual E5 small、BGE micro/小型多语言模型。实际 model ID、immutable revision、dtype、pooling、normalize、query/document prefix 必须写入 benchmark config，不能只记录营销名称。

至少包含：

- 一个当前外部 provider 作为质量参考，不参与默认本地隐私声明；
- 每个候选的推荐预处理；
- 相同 corpus、chunk 与标注；
- 相同 TopK 和度量；
- 固定随机种子及硬件/浏览器/Obsidian 版本。

Transformers.js 版本必须固定到 lockfile 中的确切版本。文档当前说明 pipeline 支持 revision、dtype、缓存和进度回调，但不要据此假设任一具体模型能在 Obsidian 运行。

## 4. 基准数据集设计

建议新增：

```text
benchmarks/retrieval-v1/
  README.md
  schema.json
  corpus.jsonl
  queries.zh.jsonl
  queries.en.jsonl
  queries.de.jsonl
  model-configs.json
  expected-metrics.json
scripts/
  run-retrieval-benchmark.mjs
  summarize-retrieval-benchmark.mjs
benchmark-results/
  .gitkeep
```

每种语言至少 20 个经过人工核对的问题；每个问题标注 1 个或多个相关 chunk。问题应覆盖：

- 原词匹配；
- 同义改写；
- 跨段概念；
- 缩写；
- 专有名词；
- 易混淆负样本；
- 短问与长问；
- PDF 提取后的噪声。

使用可公开、脱敏或自建内容，不提交私人 Vault。两人标注时记录分歧；只有一人时做隔日复核，并在报告中写明限制。

JSONL 示例：

```json
{"id":"de-001","query":"...","relevantChunkIds":["doc-3#2"],"notes":"paraphrase"}
```

## 5. 指标与报告

### 5.1 检索质量

- Recall@5、Recall@10；
- MRR；
- 每种语言单独报告，再给 macro average；
- zero-result、语言、query 类型的切片；
- 混合检索还需固定 RRF 参数，避免把调参收益误归因于 embedding。

### 5.2 运行指标

| 指标 | 冷/暖 | 记录方式 |
| --- | --- | --- |
| 下载字节与时间 | 冷 | Network/progress callback |
| pipeline 初始化 | 冷、暖 | `performance.mark/measure` |
| query p50/p95 | 暖 | 多轮，去掉首次预热或单列 |
| chunks/sec | 暖 | batch 8/16/32 |
| 峰值 JS/WASM/GPU 内存 | 冷、暖 | DevTools + 平台说明 |
| main.js 增量 | build | 构建前后文件大小 |
| Cache 占用 | 暖 | Cache API/Storage estimate |
| 主线程 long task | 索引 | Performance timeline |

不得只报最快一次，也不要混用不同设备的数字。报告原始 JSON、汇总脚本版本和 commit。

## 6. 技术 spike 与涉及文件

| 文件/模块 | 任务 |
| --- | --- |
| `package.json`、`package-lock.json` | 在 spike 分支固定候选 Transformers.js 版本 |
| `esbuild.config.mjs` | 验证 Worker/WASM/资源加载策略，不先污染正式配置 |
| `scripts/spikes/builtin-embedding-smoke.*` | 最小 feature-extraction、revision、dtype、device |
| `src/infrastructure/embedding/spikes/*` | 必要时隔离原型，GO 后再重写为正式 adapter |
| `benchmarks/retrieval-v1/*` | corpus、query、标注、模型配置 |
| `scripts/run-retrieval-benchmark.mjs` | 统一运行与原始结果输出 |
| `kb/.../ADR-内置Embedding模型与运行时.md` | 记录选择、被拒方案与证据 |

Community release 通常只提供 `main.js`、`manifest.json` 和可选 `styles.css`。必须证明 Worker/WASM/运行时资产的加载方案与此发布约束兼容。不要在正式实现后才发现额外文件没有随 release 上传。

## 7. 手动实施步骤

### Step 1：先写 benchmark protocol

在跑模型前冻结数据 schema、指标、设备信息、预热规则和结果格式。预先写决策门槛，避免看完结果后移动标准。

### Step 2：建立最小浏览器 smoke

只加载一句文本并生成向量，验证：

- 确切 revision；
- 输出维数与有限数；
- query/document preprocessing；
- WebGPU 与 WASM；
- 首次下载、缓存命中、断网暖启动；
- 清缓存后确实重新下载；
- AbortSignal/worker termination 的行为。

### Step 3：验证打包

研究 `new Worker(new URL(...))` 在当前 esbuild/CJS 输出中的结果。优先验证 inline worker 或 Blob URL，使 release 不依赖未上传 worker 文件；若必须增加 asset，就要同时修改 release contract 和社区安装验证。

对构建后的 `main.js` 做静态检查，查找指向本地缺失文件、CDN JavaScript 或开发路径的 URL。

### Step 4：跑质量基准

每个候选先生成 corpus embeddings，再逐语言查询。保存原始排名，不只保存分数，以便检查失败样本。

### Step 5：跑性能基准

至少一台桌面设备和一台实际移动设备。记录系统、CPU/GPU、内存、Obsidian、Transformers.js、浏览器内核、模型 fingerprint。模拟小知识库和接近当前语义窗口上限的知识库。

### Step 6：分析失败样本

为每个 query 标记：chunk 问题、语言问题、模型问题、ground truth 问题或 hybrid 组合问题。不要仅通过增加 TopK 掩盖模型弱点。

### Step 7：写 ADR 和决策

ADR 至少包含：背景、候选、证据、选项、决定、后果、回滚条件、未验证项。

## 8. GO/NO-GO 门槛

在跑分前将精确门槛写入 ADR。建议用相对与底线组合：

- 选定模型 macro Recall@10 与最佳候选差距在预设范围内；
- 三种语言均达到单独下限，不能由英语平均值掩盖；
- 下载/缓存占用满足产品预算；
- Worker 后索引过程无持续主线程卡顿；
- 目标规模在桌面成功，移动端至少有明确安全上限或降级；
- 断网缓存命中可用；
- 清除模型可验证；
- release 安装后不依赖缺失本地 asset；
- 内容未发往远程 embedding 服务。

数字门槛由 M0 基线与真实设备数据填写。若任何关键证据缺失，结论写“未验证”，不是默认通过。

## 9. 测试、调试与 CI 边界

- PR CI 只跑 parser、metric calculator、fixture 和 fake provider 测试；
- 真实模型不进入普通 PR CI，避免下载大文件和不稳定 GPU 差异；
- 可增加 `workflow_dispatch` benchmark，固定 runner 并缓存模型；
- 原始结果包含 schema version，汇总脚本拒绝未知版本；
- 故意破坏 relevant ID，验证数据校验能失败；
- 故意断网、清缓存、禁用 WebGPU、终止 Worker，记录恢复路径；
- Performance trace 与截图放本地证据或 release 附件，避免提交敏感路径。

## 10. 完成标准

- [ ] 数据集 schema、标注说明和三语言问题齐全；
- [ ] 指标脚本有小 fixture 的已知答案测试；
- [ ] 每个候选使用固定 revision 和完整 fingerprint；
- [ ] 质量、冷/暖性能、内存、体积均有原始证据；
- [ ] Worker/WASM 打包经过 release 形态验证；
- [ ] 至少一个实际移动端测试或明确记录未验证；
- [ ] ADR 给出 GO/NO-GO 及理由；
- [ ] 没有仅因平均分高就忽略某种语言或平台；
- [ ] NO-GO 时 M5 不开始默认接入。

## 11. 实施记录

```text
Benchmark commit：
设备与运行时：
候选及 fingerprint：
原始结果路径：
失败样本分类：
打包结论：
移动端结论：
ADR：
GO / NO-GO：
遗留风险：
```
