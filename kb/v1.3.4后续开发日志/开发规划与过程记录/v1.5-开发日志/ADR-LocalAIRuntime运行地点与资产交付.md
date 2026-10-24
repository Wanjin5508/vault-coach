---
tags: [VaultCoach, ADR, LocalAIRuntime, Worker, WASM, WebGPU]
status: proposed-pending-m4-evidence
updated: 2026-10-24
decision: pending
---

# ADR：LocalAIRuntime 运行地点与资产交付

## 背景

Vault Coach 希望首先内置 embedding，并在后续复用相同生命周期基础设施承载 reranker 和 utility model。正式实现前必须证明运行地点、Worker、WASM/WebGPU、模型缓存和社区插件发布资产能够在真实 Obsidian 中工作。

M3 已建立 `EmbeddingProvider`、完整 fingerprint 和原子向量 generation。M4 只验证 runtime，不改变旧用户 provider，也不把候选模型设置为默认值。

## 当前候选决策

当前优先候选为：

```text
模型推理：独立 Web Worker
高性能路径：ONNX Runtime Web WebGPU / JSEP
兼容路径：ONNX Runtime Web WASM
上层 API：Transformers.js 4.3.1 browser build
执行资源：随插件发布并从安装目录加载
模型资源：用户明确授权后下载，按不可变 revision 缓存
默认并发：单 Worker、单活跃模型实例
外部 fallback：只保留用户主动选择的 Ollama/OpenAI-compatible
```

该结论目前是待验证候选，不是正式 accepted ADR。

## 为什么不直接采用其他路线

| 方案                       | 当前判断                                         |
| ------------------------ | -------------------------------------------- |
| 主线程 Transformers.js      | 只可用于最小诊断；长任务可能阻塞 Obsidian UI，不作为生产候选         |
| Web Worker + WASM/WebGPU | 首选；需要 M4 真机证据                                |
| Node/Electron 原生推理       | 会强化桌面依赖并失去移动端统一路线；可作单独桌面对照，不作为默认内置定义         |
| 本地 sidecar/Docker        | 适合高级用户或未来 Knowledge Engine，但增加安装、端口、安全和移动端限制 |
| 继续仅用 Ollama/云服务          | 保留兼容路径；不能实现新用户开箱即用 embedding 的产品目标           |

## 资产契约

Worker JS、ONNX Runtime `.mjs` 和 `.wasm` 是执行代码，必须随受支持的插件发布形式提供。模型权重、tokenizer 和 config 是模型数据，可以在用户确认后按固定 revision 下载。不能以“模型下载”为名远程加载 Worker 或 WASM 代码。

临时构建会额外生成 `asset-manifest.json`，记录主入口、Worker、WASM/JSEP 资源的字节数和 SHA-256。M5 应把这一做法提升为正式 release asset manifest，并在加载前验证。

当前 spike 构建包含：

```text
main.js                                约 8 KiB
worker-smoke.js                        约 1.3 MiB
ort-wasm-simd-threaded.mjs             约 24 KiB
ort-wasm-simd-threaded.wasm            约 13.6 MiB
ort-wasm-simd-threaded.jsep.mjs        约 46 KiB
ort-wasm-simd-threaded.jsep.wasm       约 27.0 MiB
合计                                   约 42 MiB
```

这是 smoke 资产快照。M5 必须决定是否同时发布 WASM 与 JSEP、是否按平台拆分，以及社区插件发布是否接受新增资产。不能直接把 `.m4-smoke-plugin` 复制成正式产品实现。

## 缓存与身份

缓存 key 必须至少受以下身份约束：

- repository；
- 不可变 revision；
- dtype；
- 文件名与 hash；
- Transformers.js / ONNX Runtime 资产版本。

缓存文件存在不等于模型 ready。加载前仍需验证必要资源，加载成功后再更新状态。离线测试必须在新进程或新 Worker 中完成。

embedding 数值空间继续使用 M3 fingerprint 管理。设备只进入诊断；除非 M4 证明 WASM/WebGPU 在同一模型策略下可复用索引，否则不能假设跨设备数值兼容。

## 安全与隐私

- 不把笔记或 query 写入 benchmark 结果；
- 不记录认证头和带 query 的 URL；
- 下载命令需要明确弹窗；
- offline 命令拒绝外部请求；
- smoke 只使用公开合成语料；
- 许可证未通过前不发布候选模型；
- 临时 smoke 插件与正式 Vault Coach 使用不同 plugin ID。

## 接受条件

ADR 从 `proposed` 改为 `accepted` 前需要：

- [[M4-内置Embedding手工技术验证指南]]中的全部 Desktop 必选项通过；
- 移动端分别给出 GO、NO-GO 或 pending；
- 协议和许可证批准时间早于正式结果；
- 资产缺失、取消、缓存损坏和离线重启有原始结果；
- 资源预算满足预登记门槛；
- 没有远程执行代码；
- M5 能据此冻结 worker protocol、缓存 manifest 和 provider policy。

## NO-GO 后的处理

若浏览器 runtime 失败：

1. 保留 M3 Ollama/OpenAI-compatible provider；
2. 保留 keyword fallback；
3. 记录失败的设备、资产和错误；
4. 可以评估更小模型、单独 WASM 路线或桌面 sidecar；
5. 不把未验证平台静默降级成云端传输。

## 当前证据

2026-10-24：静态验证和 smoke 构建通过，生成资产约 42 MiB。尚未下载模型或在真实 Obsidian 中运行，因此 decision 仍为 `pending`。
