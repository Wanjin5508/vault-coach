---
tags: [VaultCoach, v1.5, 里程碑6, WebWorker, Progress]
status: planned
updated: 2026-10-09
depends-on: [里程碑5-内置Embedding运行时与模型缓存.md]
---

# 里程碑 6：Worker 化与可观测索引进度

## 1. 目标

把模型加载和批量 embedding 移出 UI 主线程，建立有版本、可取消、可恢复的 Worker 协议；同时把当前粗粒度 `phase/busy` 扩展为真实的索引阶段、计数、字节和错误状态，为 M7 Setup Wizard 提供可靠进度。

学习重点：并发协议、transferable、取消、崩溃恢复、性能 trace、esbuild 资源打包与生命周期清理。

## 2. 设计约束

1. release 安装后不能依赖未随资产发布的 worker 文件；
2. Worker 每条消息都有 protocol version、request/job ID 和类型；
3. 大向量用 transferable `ArrayBuffer`，避免 JSON 拷贝；
4. 单 Worker 串行持有一个 pipeline，避免多份模型占用内存；
5. 取消在 batch 边界检查；硬取消可 terminate 并重建；
6. 旧任务或乱序消息不能覆盖新任务状态；
7. Worker crash 后 pending promise 全部得到结构化失败；
8. plugin unload 释放 Worker、listener、Blob URL 和 pipeline；
9. 百分比只在已知 total 时显示；未知总量显示阶段和 indeterminate；
10. 用户关闭 View 不应自动终止由应用层拥有的索引任务。

## 3. Worker 协议

建议新建 `src/infrastructure/embedding/embedding-worker-protocol.ts`：

```ts
type WorkerRequest =
  | { v: 1; type: "prepare"; requestId: string; policy: SerializedPolicy }
  | { v: 1; type: "embed"; requestId: string; jobId: string; texts: string[]; purpose: EmbeddingPurpose }
  | { v: 1; type: "cancel"; requestId: string; jobId: string }
  | { v: 1; type: "dispose"; requestId: string };

type WorkerResponse =
  | { v: 1; type: "ready"; requestId: string; fingerprint: EmbeddingFingerprint }
  | { v: 1; type: "progress"; requestId: string; jobId?: string; progress: WorkerProgress }
  | { v: 1; type: "result"; requestId: string; jobId: string; dimension: number; count: number; buffer: ArrayBuffer }
  | { v: 1; type: "error"; requestId: string; jobId?: string; error: SerializedError };
```

边界校验：

- 主线程和 Worker 都解析消息，不信任 type assertion；
- 收到未知 version/type 时明确失败；
- `count * dimension * 4 === buffer.byteLength`；
- error 序列化为 code/message/recoverable，避免跨线程传原生对象；
- 不通过消息传 API key、完整设置或不需要的 Vault 信息。

## 4. 索引进度模型

建议在现有 `src/app/index/` 下新增 `index-progress.ts`：

```ts
type IndexPhase =
  | "discovering-files"
  | "reading-files"
  | "chunking"
  | "preparing-model"
  | "embedding"
  | "persisting-index"
  | "building-graph"
  | "ready";

interface IndexProgress {
  jobId: string;
  phase: IndexPhase;
  completed?: number;
  total?: number;
  unit?: "files" | "chunks" | "bytes";
  messageKey: string;
  canCancel: boolean;
}
```

总进度不能简单平均各阶段。优先显示“阶段 + 局部计数”，例如 `Embedding chunks 320/900`。模型下载用 progress callback 的字节数；total 不可得时不要伪造 73%。

## 5. 涉及文件与模块

| 文件/模块 | 修改 |
| --- | --- |
| `src/infrastructure/embedding/builtin-embedding.worker.ts` | Worker entry、pipeline 生命周期、消息循环 |
| `src/infrastructure/embedding/embedding-worker-client.ts` | request map、timeout、cancel、crash/dispose |
| `src/infrastructure/embedding/embedding-worker-protocol.ts` | 可序列化协议与 runtime validator |
| `src/infrastructure/embedding/builtin-model-loader.ts` | 移入 Worker 可用边界 |
| `src/app/index/index-progress.ts` | 建议新增统一进度类型 |
| `src/app/index/knowledge-index-coordinator.ts` | 扩展现有 coordinator：job 状态、订阅、取消、过期事件过滤 |
| `src/app/vault-coach-runtime.ts`、`src/knowledge-base.ts` | 现有 rebuild/discovery/chunk 流程报告真实计数 |
| `src/app/application-api.ts` | 扩展现有 Index API：status/subscribe/cancel |
| `src/presentation/components/index-progress.ts` | 可访问的阶段、计数、错误与动作 |
| `src/presentation/components/vault-coach-header.ts` | 消费统一状态，不自行轮询 |
| `esbuild.config.mjs` | inline Worker/Blob 打包方案 |
| `tests/infrastructure/embedding-worker-client.test.ts` | fake Worker 协议测试 |
| `tests/app/indexing/index-job-coordinator.test.ts` | 乱序、取消、重启、订阅测试 |

## 6. 手动实施步骤

### Step 1：先实现协议 validator 和 fake Worker

不加载真实模型。用内存 fake 模拟 progress/result/error/crash，完成 request map、乱序和取消测试。协议文件不得 import Obsidian 或 DOM UI。

### Step 2：实现 Worker client

client 建立 `Map<requestId, pending>`，为每个请求清理 timeout/abort listener。`onerror`/`onmessageerror` 时拒绝全部 pending，并把 runtime 标记 crashed。

### Step 3：迁移模型 runtime

把 pipeline 的创建和 embed 放进 worker entry。先完成单条，再批量；比较迁移前后 fingerprint 和近似数值，允许量化浮点容差，不允许维数/归一化变化。

### Step 4：落实 inline 打包

按 M4 ADR 实现并验证构建产物。若用 Blob URL：

- Worker source 被打进 `main.js`；
- 创建后保留 URL，dispose 时 `URL.revokeObjectURL`；
- CSP/Obsidian desktop/mobile 都实际测试；
- release 目录只放正式资产也能运行。

不要只在开发服务器环境测试。

### Step 5：让每个索引阶段上报真实数据

文件发现结束后才知道 file total；chunking 结束后才知道 chunk total。将阶段事件从 runtime 传给 coordinator，UI 不通过定时器猜测。

### Step 6：实现取消和 crash recovery

soft cancel：停止投递下一 batch、清临时索引、保留 active index。hard cancel：terminate Worker、拒绝任务、下次 prepare 新 Worker。崩溃自动重试次数固定，避免 crash loop。

### Step 7：做性能 trace

分别采集下载、初始化、索引、查询。关注主线程 Long Task、消息序列化、数组复制和 GC。以 M4 基线比较，而不是只看主观“不卡”。

## 7. Batch 策略

M4 已比较 8/16/32。本阶段将选定默认写入 policy，并允许 runtime 因设备/内存安全下调。不要根据一次耗时不断抖动 batch。

每个 batch：

1. 检查 cancel；
2. 发送文本到 Worker；
3. Worker 生成扁平 `Float32Array`；
4. transfer buffer；
5. 主线程验证 count/dimension/fingerprint；
6. 临时索引写入或聚合；
7. 报告 completed；
8. 再检查 cancel。

## 8. 测试与故障注入

### 自动测试

- request/response correlation；
- 两个 request 乱序返回；
- 未知 version/type；
- malformed buffer；
- timeout/AbortSignal；
- cancel 后迟到 result 被忽略；
- crash 拒绝全部 pending；
- dispose 幂等并清 listener；
- 旧 job progress 不覆盖新 job；
- total 未知时不产生百分比；
- 构建产物不引用缺失 worker 文件。

### 手工故障注入

1. embedding 第 3 个 batch 抛错；
2. 下载中取消；
3. 索引中 terminate Worker；
4. indexing 时关闭并重开 View；
5. plugin unload/reload；
6. WebGPU device lost 后走 WASM；
7. 低内存移动设备使用安全 batch。

检查临时索引、active index、listener 数量和内存是否恢复。

## 9. 调试练习

- 在日志中按 `jobId/requestId` 重建时序；
- 用 DevTools Worker 面板在 worker 和主线程分别设断点；
- 用 Performance flame chart 找 serialization/GC/long task；
- 用 Memory snapshot 比较 prepare 前、索引后、dispose 后；
- 故意发送未知协议版本，验证兼容失败可理解；
- 将 worker client 的 fake clock 用于 timeout 测试，避免真实等待。

## 10. 工程实践与原因

- 版本化协议使主/Worker 演进有明确兼容边界；
- transferable 避免复制大矩阵；
- coordinator 拥有任务，View 只订阅，关闭面板不会破坏后台工作；
- build-then-swap 保住最后一个可用索引；
- 真实阶段计数为向导、诊断和性能分析提供同一事实；
- dispose 幂等，防止插件重载泄漏；
- timeout、取消、crash 是三种不同状态，不能都叫 failed。

## 11. 完成标准

- [ ] 模型加载和 embedding 在 Worker 执行；
- [ ] release 形态无缺失 Worker/WASM 资源；
- [ ] 进度来自真实阶段/计数/字节；
- [ ] 取消、崩溃、重载不污染 active index；
- [ ] late/out-of-order 消息被正确处理；
- [ ] 大向量使用 transferable；
- [ ] 主线程性能达到 M4 预设门槛或记录阻断证据；
- [ ] unload 后 Worker、listener、Blob URL 被清理；
- [ ] 自动测试不下载真实模型，实机 trace 已保存。

## 12. 实施记录

```text
Worker 打包方案：
Protocol version：
默认 batch：
构建资产检查：
Performance trace：
取消/crash 结果：
Desktop/Mobile：
内存前后对比：
遗留风险：
```
