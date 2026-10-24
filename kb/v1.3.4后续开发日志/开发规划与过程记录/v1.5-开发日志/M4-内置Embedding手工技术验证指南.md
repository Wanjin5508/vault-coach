---
tags: [VaultCoach, v1.5, 里程碑4, TransformersJS, ONNXRuntime, 手工验证]
status: executable-pending-results
updated: 2026-10-24
depends-on: [里程碑4-内置Embedding技术验证与多语言基准.md]
---

# M4：内置 Embedding 手工技术验证指南

## 1. 本指南验证什么

M4 不把内置模型接入 Vault Coach 的正式运行路径。它用两套隔离工具回答以下问题：

1. Transformers.js 4.3.1 的浏览器构建能否使用仓库内的 ONNX Runtime WASM 资源完成 embedding；
2. 真实 Obsidian 中能否创建 Worker、加载 WASM/WebGPU、下载模型、重启后离线加载并释放资源；
3. 候选模型在合成中英德语料上的 Recall@5/10、MRR、查询延迟和索引吞吐是否达到预登记门槛；
4. 缺文件、取消、缓存损坏和断网时是否产生可解释失败，而不是暗中加载远程执行代码；
5. 当前方案是否具备进入 M5 生产实现的证据。

Node CLI 是可复现的质量与性能参考。独立 Obsidian smoke 插件才是 Worker、CSP、安装资源路径和浏览器缓存的产品环境证据。任何一方单独通过都不能产生 M4 GO。

## 2. 已实现工具与边界

| 工具 | 命令/入口 | 用途 | 是否自动联网 |
|---|---|---|---|
| 静态资产校验 | `npm run m4:validate` | 检查协议、模型账本、三语语料、引用和指标自检 | 否 |
| Node embedding smoke | `npm run m4:smoke:embedding` | 验证 Node CPU/WebGPU、文件缓存、前缀和向量 contract | 默认否；必须显式加 `--allow-download` |
| Node retrieval benchmark | `npm run m4:benchmark` | 运行三语 embedding 与关键词基线，保存排名和性能 | 默认否；必须显式加 `--allow-download` |
| Obsidian smoke 构建 | `npm run m4:build:obsidian-smoke` | 生成独立临时插件和本地 WASM 资产 | 否 |
| Obsidian 命令 | **Command palette → M4 smoke: ...** | 真机 Worker、WASM/WebGPU、缓存、取消和断网验证 | 下载命令弹窗确认；offline 命令禁止远端模型 |

普通 `npm test`、`npm run lint` 和 `npm run build` 不执行模型下载，也不运行真实 benchmark。

## 3. 前置条件

### 3.1 环境

- 使用项目 `.nvmrc` 指定的 Node.js 20；当前开发机为 Node 20.20.2、npm 10.8.2，满足 Transformers.js 的 `sharp` 依赖所要求的 Node.js >= 20.9.0；
- npm 使用项目规定的 npm，不要改用 pnpm 或 yarn 生成第二份锁文件；
- 首次候选模型验证预留至少 1 GiB 磁盘和足够运行内存；账本中的 uint8 权重约 118 MB，但 tokenizer、配置、Cache API 开销、WASM 和 GPU buffer 需要额外空间；
- 使用一个不含私人笔记的干净测试 Vault；
- Desktop 验证需要可以打开 **Developer tools**；移动端验证应使用独立测试设备；
- 首次下载前人工核对候选模型许可证。当前 `multilingual-e5-small-uint8` 的许可证状态仍为 pending，不能用于正式分发决策。

### 3.2 安装依赖

在项目根目录执行：

```bash
npm ci
```

若 npm 在 macOS 上访问 registry 超时，而 `curl` 可以正常访问，可以临时强制 IPv4 重试：

```bash
NODE_OPTIONS=--dns-result-order=ipv4first npm ci
```

这只是网络诊断措施，不应写入 package script。

## 4. Step 0：冻结并校验实验协议

先阅读：

- `benchmarks/local-ai/protocol.json`；
- `benchmarks/local-ai/models.json`；
- `benchmarks/retrieval-v1/*.jsonl`。

当前协议状态是 `pending-owner-approval`。负责人必须在第一次正式验收运行前确认 Recall、MRR、P95、吞吐、加载时间和内存阈值，然后把状态改为 `approved`。结果产生后不能为了让模型通过而修改验收集或门槛；需要调整时创建新的协议版本并保留旧结果。

执行：

```bash
npm run m4:validate
```

当前预期结果：

```text
18 chunks
60 queries（中文、英文、德文各 20）
2 candidates
校验 PASS
```

在协议未批准、许可证未确认、对照模型 revision 未锁定时，warning 是预期行为。warning 不能被解释为已经完成 Gate。

## 5. Step 1：运行 Node embedding smoke

### 5.1 首次下载与 CPU 参考推理

以下命令会显式允许从模型仓库下载候选资产：

```bash
npm run m4:smoke:embedding -- --allow-download --device cpu
```

脚本会：

1. 使用 Transformers.js Node 入口和 `onnxruntime-node` 执行 CPU 参考推理；
2. 把模型响应写入 `.m4-model-cache/`；
3. 分别使用 query、document、graph 前缀生成向量；
4. 校验输出条数、384 维、有限数和归一化结果；
5. 调用 `dispose()` 并写入 `benchmark-results/local-ai/<run-id>/smoke.json`。

结果中的 `requests` 只保存 origin、pathname 和是否为本地运行时资源，不保存请求 query、认证头或输入文本。

### 5.2 离线暖缓存

首次下载成功后，断开外部网络，再执行：

```bash
npm run m4:smoke:embedding -- --device cpu
```

没有 `--allow-download` 时，脚本禁止外部请求。通过条件：

- 状态为 `pass`；
- 仍然返回 384 维有限向量；
- `requests` 中没有外部 origin；
- 重新启动 Node 进程后仍能加载，不能只复用内存中的旧 pipeline。

如果没有暖缓存，离线命令失败是正确行为。

### 5.3 WebGPU CLI 的限制

Node CLI 的 WebGPU 能力取决于具体 Node/ONNX Runtime 版本和平台，不能代替 Obsidian/Electron 证据。可以探索：

```bash
npm run m4:smoke:embedding -- --allow-download --device webgpu
```

失败时记录完整环境和错误，不能自动改写成 WASM PASS。

## 6. Step 2：运行三语 retrieval benchmark

先完成协议批准和一次下载 smoke。运行锁定验收集：

```bash
npm run m4:benchmark -- --device cpu --batch-size 8 --split acceptance
```

缓存尚未准备好时，可以在第一次运行显式允许下载：

```bash
npm run m4:benchmark -- --allow-download --device cpu --batch-size 8 --split acceptance
```

需要探索 batch 1/8/16/32 时分别执行四次，不要覆盖结果目录：

```bash
npm run m4:benchmark -- --device cpu --batch-size 1 --split acceptance
npm run m4:benchmark -- --device cpu --batch-size 8 --split acceptance
npm run m4:benchmark -- --device cpu --batch-size 16 --split acceptance
npm run m4:benchmark -- --device cpu --batch-size 32 --split acceptance
```

每次运行生成独立 `benchmark.json`，包含：

- 环境、精确模型 revision 和 dtype；
- corpus 吞吐、query P50/P95、加载时间和进程 RSS；
- 中英德 Recall@5、Recall@10、MRR；
- no-answer top score 分布；
- 轻量字符/词项关键词基线；
- 每个 query 的 top-10 原始排名；
- 阈值失败原因和协议批准状态。

Node 的 RSS 只是观察值，不等于 Worker、WASM heap 或 GPU 显存的精确拆分。结果中 `scope=node-cli-reference-only`，不能单独批准 M4。

## 7. Step 3：构建并安装独立 Obsidian smoke 插件

构建：

```bash
npm run m4:build:obsidian-smoke
```

输出目录：

```text
.m4-smoke-plugin/
  manifest.json
  asset-manifest.json
  main.js
  worker-smoke.js
  ort-wasm-simd-threaded.mjs
  ort-wasm-simd-threaded.wasm
  ort-wasm-simd-threaded.jsep.mjs
  ort-wasm-simd-threaded.jsep.wasm
```

2026-10-24 的构建快照约 42 MiB：Worker bundle 约 1.3 MiB，WASM 约 13.6 MiB，JSEP WASM 约 27.0 MiB。每次升级依赖后都应重新测量，不能把这些数字写成永久常量。

`asset-manifest.json` 记录每个执行资产的字节数与 SHA-256。复制到测试 Vault 后应保留该文件，用它判断失败是资产损坏还是 runtime 不兼容。

把整个目录复制到干净测试 Vault：

```bash
M4_VAULT="/absolute/path/to/clean-test-vault"
mkdir -p "$M4_VAULT/.obsidian/plugins/vault-coach-m4-smoke"
cp -R .m4-smoke-plugin/. "$M4_VAULT/.obsidian/plugins/vault-coach-m4-smoke/"
```

然后：

1. 打开测试 Vault；
2. 进入 **Settings → Community plugins**；
3. 启用 **Vault Coach M4 Smoke**；
4. 打开 Developer Tools 的 Console 和 Network；
5. 勾选 Network 的 **Preserve log**。

该临时插件 ID 与正式插件不同，可以独立启停。不要把 `.m4-smoke-plugin` 作为 Vault Coach 发布资产提交。

## 8. Step 4：Obsidian WASM / WebGPU 验证矩阵

### 8.1 WASM 首次下载

执行命令：

**Command palette → M4 smoke: Download model and run with WASM**

确认弹窗会显示模型、revision、估计权重和许可证 pending 状态。选择 **Download and run** 后观察：

- Worker 是否成功创建；
- WASM 是否来自安装目录的 `app://` 资源，而不是 CDN；
- 模型请求是否只访问预期模型仓库；
- UI 在下载和推理期间是否仍可操作；
- 结果是否保存到 Vault 根目录 `vault-coach-m4-smoke-results/`；
- `dimension=384`、`status=pass`、`worker=true`。

### 8.2 真正的离线重启

1. 完全退出 Obsidian；
2. 在操作系统层断开网络；
3. 重新启动 Obsidian和测试 Vault；
4. 执行 **M4 smoke: Verify WASM cache offline**；
5. 确认结果 `status=pass`，且 `requests` 没有外部请求。

只在同一个 Worker 内第二次推理不算离线重启证据。

### 8.3 WebGPU

联网准备：

**Command palette → M4 smoke: Download model and run with WebGPU**

离线重启后：

**Command palette → M4 smoke: Verify WebGPU cache offline**

记录：

- `webgpuApiAvailable`；
- 实际运行是否通过；
- `secureContext` 与 `crossOriginIsolated`；
- load/inference 时间；
- 设备、操作系统、Obsidian 版本。

`webgpuApiAvailable=true` 但推理失败仍然是 FAIL。

### 8.4 取消

在下载或加载期间执行：

**Command palette → M4 smoke: Cancel active run**

通过条件：

- Worker 被终止；
- UI 恢复；
- 结果文件状态为 `cancelled`；
- 之后能够重新执行一次 smoke；
- 被取消的旧 Worker 不再写入 pass 结果。

### 8.5 缓存损坏和缺失资产

缓存损坏验证：

1. 完成一次联网下载；
2. 在 Developer Tools → Application → Cache Storage 中删除该模型的一项缓存；
3. 断网并运行 offline smoke，应得到 FAIL；
4. 恢复网络并运行下载 smoke，应重新补齐缓存；
5. 再次离线重启，应该 PASS。

执行资源缺失验证：

1. 关闭 Obsidian；
2. 在临时插件目录暂时移走当前设备使用的 `.wasm` 或 `.mjs`；
3. 重启并运行 smoke，应得到明确 FAIL；
4. 恢复文件后重新验证。

不要用 CDN URL修复缺失执行资源；缺失说明发布资产契约没有满足。

## 9. Step 5：移动端验证

把相同临时插件资产复制到移动测试 Vault，分别记录 iOS 和 Android：

- 插件能否加载；
- Worker 能否创建；
- WASM 是否完成一句文本推理；
- WebGPU 是否存在并实际运行；
- 首次下载、暖启动、离线重启和取消；
- 系统终止、OOM 或明显 UI 卡顿。

没有设备时状态保持 `pending`。Desktop PASS 不能填写为移动端 PASS。

## 10. 结果检查与隐私审计

检查结果目录：

```bash
find benchmark-results/local-ai -name '*.json' -maxdepth 3 -print
```

提交任何结果前搜索敏感字段：

```bash
rg -n "Authorization|Bearer|api[_-]?key|/Users/|C:\\\\Users\\\\" benchmark-results/local-ai
```

结果可以包含公开模型仓库、revision、dtype、设备类别、耗时和安全错误码。不得提交用户名、本地绝对路径、私人 Vault 文件名、笔记文本或认证信息。

## 11. GO / NO-GO 判定

只有同时满足下列条件才允许在 ADR 中写 GO：

- 协议在结果产生前已批准；
- 候选模型与上游许可证已人工核对；
- 三语锁定验收集通过；
- Worker/WASM 发布形态通过；
- 冷启动、暖启动、离线重启、取消、缓存损坏均有结果文件；
- Desktop WASM 至少通过；WebGPU 按设备单独判定；
- iOS、Android 未测试时保持 pending；
- 没有 CDN 运行时代码；
- M5 获得精确资产 manifest、缓存策略、设备矩阵和资源预算。

若浏览器路线无法交付本地执行资源、离线缓存不可靠或目标设备资源超限，应写 NO-GO 或缩小平台范围，继续保留现有 Ollama/OpenAI-compatible/keyword 路径。

## 12. 官方依据

- [Transformers.js v4 发布说明](https://huggingface.co/blog/transformersjs-v4)：v4 的 WebGPU runtime、ModelRegistry、缓存和环境控制；
- [Transformers.js env API](https://huggingface.co/docs/transformers.js/api/env)：远程模型、本地模型、缓存、fetch 与 WASM cache 配置；
- [ONNX Runtime Web 部署](https://onnxruntime.ai/docs/tutorials/web/deploy.html)：Worker、WASM、JSEP、CSP 和 `wasmPaths`；
- [ONNX Runtime Web 概览](https://onnxruntime.ai/docs/tutorials/web/)：Electron/browser 执行 provider 与平台边界；
- [Xenova/multilingual-e5-small 模型页](https://huggingface.co/Xenova/multilingual-e5-small)：Transformers.js 使用入口和 ONNX 资产。

## 13. 当前执行状态

2026-10-24 已完成：

- 依赖和 lockfile；
- 脚本 lint；
- 18 chunks / 60 queries 静态校验；
- 独立 Obsidian smoke 构建；
- 发布资产文件清单和体积测量。
- Node CPU 首次联网 smoke：384 维归一化向量生成通过；
- revision 缓存中的 uint8 ONNX 权重 SHA-256 与候选账本一致。

开发机已从 Node 18.16.0 切换到 Node 20.20.2，并在新环境中完成 `npm ci`、lint、261 项测试、生产构建、M4 静态校验和 Obsidian smoke 构建。切换前保存的 `Node.js >= 20.9.0` 失败快照只证明前置条件检查生效，不是模型/runtime 失败证据。

真实模型已完成一次允许下载的 CPU smoke。第一次 offline-only 暴露 `TypeError: this.tokenizer is not a function`；根因是 Transformers.js 4.3.1 的 pipeline/tokenizer 文件预扫描没有转发 revision。Node 参考实现已改为显式加载 tokenizer/model，离线时直接使用 revision 本地目录。移除遗留 `main/config.json` 后，两个独立进程连续离线 PASS，网络请求为 0，暖加载分别为 493.42 ms 和 496.14 ms。

首轮三语 acceptance benchmark 也已完成：三种语言 Recall@10 均通过建议值；英文 MRR 通过，中文和德文 MRR 未通过。协议仍未批准，因此总状态继续为 pending。详细证据见 [[里程碑4-内置Embedding技术验证与多语言基准#8.6 离线缓存修复与首轮三语 benchmark]]。

尚未完成：

- 候选许可证人工确认；
- 中文和德文 MRR 诊断与排序优化；
- 扩大 no-answer 样本并校准相关性准入阈值；
- 负责人批准实验协议；
- Obsidian Desktop 真机运行；
- iOS / Android 运行；
- 最终 GO/NO-GO。
