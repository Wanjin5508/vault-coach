---
title: Embedding 与本地推理运行时参数
status: current
updated: 2026-10-24
---

# Embedding 与本地推理运行时参数

## 1. 正确性参数

- 模型仓库、immutable revision、dtype、量化方式和文件 SHA-256。
- 输入前缀是否符合模型契约，例如 E5 的 `query:` 与 `passage:`。
- 向量维度、数量、有限值比例、零向量率和 L2 norm 分布。
- 相同输入重复运行的 cosine 一致性；不同执行后端允许设小浮点误差。
- query 与 corpus 是否使用同一模型指纹。指纹变化必须使旧向量失效。

向量 cosine 很高不等于检索质量好；必须最终用 Recall/MRR 验证。

## 2. 运行时性能

| 指标 | M4 当前建议门槛 | 说明 |
|---|---:|---|
| Query latency P95 | ≤ 300 ms | 桌面、预热后的单查询 embedding |
| 索引吞吐 | ≥ 8 chunks/s | 桌面批量 corpus embedding |
| 暖加载 | ≤ 5,000 ms | 已缓存权重到可推理 |
| 峰值 Node RSS | ≤ 1,024 MB | 仅 Node 参考，不等于 WASM/GPU 内存 |
| Recall@10 | 各语言 ≥ 0.80 | 质量门槛 |
| MRR | 各语言 ≥ 0.60 | 排序门槛 |

以上门槛来自 `benchmarks/local-ai/protocol.json`，仍需负责人批准。测试配置为 2 次预热、5 次测量，batch size 1/8/16/32；正式性能结论应增加重复次数。

## 3. WASM 与 WebGPU 分开报告

分别记录：设备和 OS、Obsidian/Electron 版本、execution provider、模型加载时间、首次推理、稳态 P50/P90/P95、吞吐、WASM heap、RSS、GPU memory（可得时）、取消延迟和释放后内存回落。

WebGPU API 可用不代表模型可运行。桌面通过也不能推导移动端通过。Node `onnxruntime-node` 结果只作算法与 CPU 参考，不能冒充 Obsidian Worker/WASM 证据。

## 4. 下载、缓存和离线

- 首次下载成功率、下载字节数、耗时和 SHA 校验成功率。
- 暖缓存命中率、断网重启加载成功率、缓存损坏检测率。
- 并发加载去重率，避免同一权重重复下载。
- 清理成功率和清理后残留字节。
- 所有下载必须由用户显式触发；网络请求记录只保留必要的去敏信息。

## 5. 量化比较

FP32、FP16、int8、int4 的比较必须使用同一数据集和设备。至少报告模型大小、峰值内存、加载时间、吞吐、Recall/MRR 绝对值，以及相对未量化模型的质量下降。量化方案只有在资源收益和质量损失同时可接受时才能入选。

