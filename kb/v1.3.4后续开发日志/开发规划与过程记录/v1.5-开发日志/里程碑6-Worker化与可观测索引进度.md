---
tags: [VaultCoach, v1.5, 里程碑6, Worker, Scheduler, Observability]
status: planned
updated: 2026-10-23
depends-on: [里程碑5-内置Embedding运行时与模型缓存.md]
---

# 里程碑 6：统一 Worker、资源调度与可观测索引

## 1. 目标与边界

将 M5 的真实模型执行接到生产 Worker，首先完成 Embedding 索引闭环；用角色化协议和受控调度为 M6.1/M6.2 复用。M4 已验证运行地点与发布资产，M6 负责生产级消息、取消、崩溃恢复和卸载，不到这里才研究 Worker 能否运行。

通过后可交增量 A 的 M7–M9；不用等待 reranker/utility。当前文件发现/PDF parser 的所有 CPU 工作并不会因模型 Worker 化自动迁出，trace 发现的主线程瓶颈要单列处理。

## 2. 依赖与文件

内部：M3 generation store，M4 资产方案/预算，M5 runtime/cache/loader，现有 KnowledgeIndexCoordinator。

外部：Web Worker、ArrayBuffer transfer、经 M4 验证的 WASM/WebGPU；实际移动端。不新增 sidecar。

| 文件 | 状态 | 工作 |
| --- | --- | --- |
| `src/infrastructure/local-ai/local-ai-worker-protocol.ts` | 拟新增 | discriminated union、运行时 validator |
| `src/infrastructure/local-ai/local-ai-worker-client.ts` | 拟新增 | pending map、epoch、超时、取消、释放 |
| `src/infrastructure/local-ai/local-ai.worker.ts` | 拟新增 | registry/loader 的执行宿主 |
| `src/app/local-ai/local-ai-scheduler.ts` | 拟新增 | 优先级、公平性、实例预算、角色切换 |
| `src/app/index/index-progress.ts` | 拟新增 | 阶段、数量、单位与 job ID |
| `src/app/index/knowledge-index-coordinator.ts` | 已有 | 作业所有权、进度订阅、取消 |
| `src/app/vault-coach-runtime.ts`、`src/knowledge-base.ts`、`src/rag-engine.ts` | 已有 | 从发现、分块、embed、persist 上报事实 |
| `src/app/application-api.ts`、`src/app/application-container.ts` | 已有 | status/subscribe/cancel 与 dispose |
| `src/presentation/components/index-progress.ts` | 拟新增 | 可访问阶段、已知计数、恢复动作 |
| `esbuild.config.mjs` | 已有 | M4 验证方案正式化，兼顾现有 PDF.js 补丁 |
| `tests/infrastructure/local-ai/*`、`tests/app/local-ai/*` | 拟新增 | fake Worker/clock/调度测试 |

不要并存 embedding-worker-protocol 和三角色各一套重复协议；共享 envelope，payload 按角色严格区分。

## 3. 协议约束

所有请求/响应包含 `v, requestId, jobId, workerEpoch, role, policyId`。操作至少包括 prepare、embed、cancel、dispose；rerank/utility 类型可定义能力协商但未实现时返回 unsupported-operation。

Embedding 结果包含 count、dimension、fingerprint、ArrayBuffer；必须验证 `count * dimension * 4 === byteLength`。之后还需验证有限数、请求数量与身份，不能只验证 buffer 长度。后续 rerank 是稳定 candidate ID/score 列表，utility 是已标记 schema 的结果，两者不伪装成向量。

边界输入按 unknown 解析。不要跨线程传 API key、全部插件设置、Obsidian App、Vault 实例或原生 Error；错误传 code/recoverable/safeMessage。原文只限完成任务必要的文本 batch，不写日志。

## 4. 按步骤实施

### Step 1：用 fake Worker 完成协议

内部依赖：M5 runtime adapter。外部依赖：Vitest fake timers。

建立 pending map；覆盖乱序、重复、未知 version/type、错误 policyId、过期 epoch。每个请求最多 settle 一次，完成后移除 timeout 和 AbortSignal listener。

Gate：无模型也能复现协议失败；unsupported-operation 不使 Worker 崩溃。

### Step 2：落实 Worker 和执行资源打包

内部依赖：M4 ADR、esbuild 与 PDF.js 现有补丁。外部依赖：Worker/CSP/ORT。

将加载和 embedding 放入 worker entry。使用 M4 已证实的发布方式；若为 Blob，源码打包入 main.js，dispose 时 revokeObjectURL；WASM 使用已固定且可安装的资源路径。

Gate：只有发布资产的干净 Vault 能完成初始化和一次 embed；开发服务器、node_modules、浏览器缓存不能替安装资源兜底。

### Step 3：实现 scheduler 和资源租约

内部依赖：M5 registry/status、worker client。外部依赖：M4 设备预算。

先单活跃模型，索引在 batch 边界让出；前台检索优先，后台任务有最大等待与公平性策略。维护 lease，只有无活跃租约时才正常释放模型；硬取消/崩溃另有终止路径。

用 fake reranker/utility 参与竞争，证明三角色不会各自偷偷创建 pipeline。批大小以 token/字符上限与设备证据约束，batch 8/16/32 是实验值而非所有设备默认。

Gate：前台请求不会被整库索引长期阻塞；取消排队任务后不会启动推理；后台不永久饥饿。

### Step 4：接入索引代际与真实进度

内部依赖：M3 store、existing coordinator、RAG build。外部依赖：Vault adapter。

阶段为 discovering/reading/chunking/preparing-model/embedding/persisting/ready。只有完成 manifest/shard 校验并激活后才 ready；模型已加载不等于索引完成。

每个 batch 前后检查 job/epoch/fingerprint，再提交 staging 结果；source/scope 或 provider 改变时旧 job 不激活。UI 显示阶段和局部计数，未知 total 显示不定进度。图谱构建是单独授权任务，不因为建向量就自动调用概念抽取 LLM。

Gate：故障时保住最后完整代际；如果旧代际与当前 provider 不兼容，只允许 keyword，不能回退使用错误空间。

### Step 5：取消、崩溃和清理

内部依赖：协议、scheduler、staging。外部依赖：Worker termination。

soft cancel 停止新 batch 并忽略已取消结果；若底层推理不能立即停止，准确展示“正在停止”。hard cancel 终止 Worker，拒绝该 epoch 全部 pending；清资源后下一次用户任务才重建，避免 crash loop。

清缓存与正在索引互斥。插件 unload 取消任务、断订阅、释放 tensor/session/worker/URL；关闭 View 只解除 UI 订阅，任务由应用层拥有。

Gate：取消后没有 ready/持久化/记忆迟到写入；重开 View 可看到当前真实任务。

### Step 6：接入日志与性能证据

内部依赖：轻量事件端口、job/request/epoch。外部依赖：DevTools performance/memory。

以 `index.rebuild → model.prepare → embedding.batch → index.persist` 记录 trace/span 关系。后续 M6.1/M6.2 复用同一事件 envelope。SDK 未引入时先用无正文结构化日志，不把“设计了 trace”写成已部署遥测。

分别采集初始化、tokenizer、推理、transfer、持久化、GC、主线程长任务。输出节流但不丢终态；日志只含角色、策略短 ID、数量、耗时、错误码。

Gate：达到 M4 预登记预算；性能不达标时找真实瓶颈，不以循环动画掩盖。

## 5. 必测场景

| 场景 | 预期 |
| --- | --- |
| 第三批 embed 失败 | staging 不激活，旧兼容代际或 keyword 可用 |
| 中途改 provider/scope | 旧指纹任务不能激活 |
| UI 关闭再开 | 继续订阅同一 job，不重复建索引 |
| Worker crash | 所有 pending 得到失败；无悬挂 promise |
| A epoch 迟到消息 | B epoch 状态不受影响 |
| WebGPU lost | 按 M5 同策略有限回退；变 dtype 则拒绝旧空间 |
| 转移 ArrayBuffer 后再次访问 | 测试识别 detached buffer，生产不复用 |
| 一角色清缓存、另一角色活跃 | 租约与引用关系保护无关资源 |
| unload/reload | 监听、Worker、URL 和 timer 数恢复 |

## 6. 交付、下一步与记录

- [ ] 发布形态真实 Worker 推理和离线加载通过。
- [ ] scheduler 预算、公平性、role 切换有证据。
- [ ] 进度真实；取消/crash/迟到消息不污染索引。
- [ ] plugin unload 幂等，用户事实保留。
- [ ] 真机性能记录注明未验证平台。
- [ ] 可以交付增量 A 的 M7–M9。
- [ ] M6.1 收到角色化协议、缓存注册方式与资源预算。

```text
Commit / M4 ADR / 模型策略：
Worker 交付与协议版本：
Scheduler / batch / timeout：
索引正确性与故障测试：
Trace / 主线程长任务 / 内存：
桌面、iOS、Android 分别结果：
增量 A 发布候选状态：
```

2026-10-23：从 embedding 专属 Worker 调整为共享宿主和角色调度；规划完成不等于 Worker 已实现。
