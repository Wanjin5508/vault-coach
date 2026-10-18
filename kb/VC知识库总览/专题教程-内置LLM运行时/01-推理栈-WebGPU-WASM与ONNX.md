---
tags: [VaultCoach, 教程, WebGPU, WASM, ONNX, TransformersJS]
status: tutorial
updated: 2026-10-18
previous: 00-教程总览与学习路线.md
next: 02-模型量化-内存与质量取舍.md
---

# 01：推理栈——WebGPU、WASM 与 ONNX 如何协作

## 1. 学习目标

完成本章后，你应能：

1. 解释 Transformers.js 为什么不是直接执行 PyTorch 权重；
2. 解释 ONNX Runtime、execution provider、WebGPU 和 WASM 的分工；
3. 设计 WebGPU 优先、WASM 回退且不会无限重试的状态机；
4. 在 Obsidian 中区分 API 可见、session 成功和真实生成成功；
5. 找出 Worker、WASM 和社区插件单文件发布之间的冲突。

## 2. 一次聊天请求经过哪些层

```text
Vault Coach ChatRequest
  ↓ adapter 将项目消息映射为模型 chat messages
Transformers.js text-generation pipeline
  ↓ tokenizer 把文字变成 token IDs
ONNX 模型图与权重
  ↓ ONNX Runtime 创建 inference session
execution provider
  ├─ WebGPU：把支持的计算交给 GPU
  └─ WASM：在 CPU 上执行 WebAssembly runtime
  ↓ 自回归循环不断预测下一个 token
TextStreamer 将 token 解码为增量文本
  ↓
ChatProvider.onToken / final result
```

Transformers.js 提供模型、tokenizer、生成算法和易用的 pipeline API；它在浏览器中使用 ONNX Runtime 执行 ONNX 模型。官方文档说明浏览器默认走 CPU/WASM，传入 `device: "webgpu"` 才请求 WebGPU。[Transformers.js 总览](https://huggingface.co/docs/transformers.js/index)

### 2.1 ONNX 是什么

ONNX 描述计算图、算子、张量形状和权重。它让模型不依赖原训练框架的 Python runtime。对本项目而言：

- 模型训练可能发生在 PyTorch；
- 发布给 Transformers.js 的仓库需要包含兼容的 ONNX 权重；
- ONNX Runtime 读取模型图；
- execution provider 决定每个算子在哪里执行。

“模型支持 Transformers.js”不仅是模型名字存在。至少需要：

- ONNX 文件完整；
- tokenizer/config/generation config 可解析；
- 模型架构已被当前 Transformers.js 支持；
- 所选 dtype 文件存在；
- 所需 ONNX 算子被目标后端支持；
- chat template 与输出格式符合项目需要。

## 3. WebGPU 原理

### 3.1 它解决什么问题

WebGPU 是浏览器中的低层 GPU API，可把矩阵乘法、归一化、注意力等计算映射到 GPU kernel。ONNX Runtime Web 的 WebGPU execution provider 在模型 session 创建时选择支持的图节点，并通过 WebGPU 提交计算。

它的价值主要来自：

- GPU 对大规模并行数值计算更合适；
- 模型权重可以驻留 GPU 侧，减少重复传输；
- 对自回归 LLM，首次初始化后每个 token 仍需多次执行模型图，GPU 往往比 CPU 更有意义。

官方 Transformers.js 的启用方式是：

```ts
const generator = await pipeline(
  "text-generation",
  modelId,
  {
    device: "webgpu",
    dtype: "q4",
  },
);
```

参考：[Transformers.js WebGPU guide](https://huggingface.co/docs/transformers.js/guides/webgpu)、[ONNX Runtime WebGPU guide](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)。

### 3.2 `navigator.gpu` 不是 Ready

下面的检测只能说明宿主暴露了 WebGPU 入口：

```ts
const apiVisible = typeof navigator !== "undefined" && "gpu" in navigator;
```

它不能证明：

- 能获得 adapter/device；
- 目标 dtype 被设备支持；
- 目标模型的全部算子都能运行；
- GPU 内存足够；
- session 初始化不会失败；
- 生成过程中不会 device lost；
- 当前 Obsidian/Electron 版本与驱动组合稳定。

正确的 capability 证据分三层：

```text
API visible
  → pipeline/session created
  → warm-up generation returned valid output
```

Vault Coach 只能在第三层成功后把 runtime 标记为 `ready`。

### 3.3 WebGPU 的数据移动

即使计算在 GPU，输入 token、输出 logits 或解码结果仍可能跨 CPU/GPU 边界。频繁创建 tensor、复制大数组或每个 token 重建 session 会抵消加速效果。

工程规则：

1. 一个 runtime 实例持有一个 pipeline；
2. 同一生成任务不重复加载权重；
3. 不把 pipeline 放入 React/Obsidian View 的局部生命周期；
4. 释放时显式调用库提供的 dispose 能力；
5. 只把必要的 token/text 结果发回主线程；
6. 用 Performance trace 观察 CPU↔GPU、GC 和序列化，而不是只看 tokens/s。

## 4. WASM 原理

### 4.1 WASM 在这里是什么

WebAssembly 是可在浏览器/Electron 中执行的可移植二进制格式。ONNX Runtime Web 把推理 runtime 编译成 WASM，在 CPU 上执行模型算子。

WASM 不是模型量化格式，也不是模型文件缓存：

- `.wasm` 是 runtime 代码；
- `.onnx` 是模型图和权重数据；
- q4/q8 描述模型权重/模块 dtype；
- Cache Storage 或文件系统缓存负责持久化资产。

### 4.2 为什么必须保留 WASM 路径

WebGPU 受 Electron 版本、操作系统、GPU、驱动和模型算子支持影响。WASM 能提供更广的 CPU 兼容路径。官方 ONNX Runtime Web 支持矩阵也显示，WASM 覆盖范围通常比 WebGPU 广。[ONNX Runtime Web 支持矩阵](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)

但“可回退”不等于“任何 LLM 都能在 WASM 上提供可接受体验”。一个 0.5B 模型可能仍有：

- 初始化慢；
- 首 token 延迟高；
- 长上下文内存高；
- 移动设备发热；
- 主线程阻塞；
- 生成速度低于产品下限。

因此 WASM 回退也要通过独立性能 Gate。

### 4.3 线程与宿主限制

ONNX Runtime Web 文档指出 WASM 多线程依赖宿主能力和 cross-origin isolation。Obsidian 并不是普通 HTTPS 页面，不能根据浏览器文章假设线程数。应在真实宿主记录：

```ts
const diagnostics = {
  crossOriginIsolated: globalThis.crossOriginIsolated,
  hardwareConcurrency: navigator.hardwareConcurrency,
};
```

不要主动修改 Obsidian 全局安全策略。先用 runtime 实际值和性能 trace 判断单线程/多线程行为。

ONNX Runtime 的环境 flag 必须在首次创建 session 之前设置，否则可能不生效。[ORT env flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)

## 5. WebGPU → WASM 回退状态机

### 5.1 状态

```ts
type BuiltinChatPhase =
  | "idle"
  | "checking-cache"
  | "downloading"
  | "loading-webgpu"
  | "warming-webgpu"
  | "loading-wasm"
  | "warming-wasm"
  | "ready"
  | "error"
  | "disposed";

type RuntimeDevice = "webgpu" | "wasm";
```

状态对象还应记录：

```ts
interface BuiltinChatRuntimeStatus {
  phase: BuiltinChatPhase;
  requestedDevice: "auto" | RuntimeDevice;
  actualDevice: RuntimeDevice | null;
  fallbackReason: string | null;
  modelFingerprint: string;
  cachedBytes: number | null;
  totalBytes: number | null;
  canCancel: boolean;
  recoverable: boolean;
}
```

### 5.2 有界回退算法

```text
用户点击 Prepare
  → 检查缓存/下载
  → 若策略允许且 WebGPU API 可见：尝试创建 WebGPU pipeline
  → 运行一个固定、短小、不可采样的 warm-up
      ├─ 成功：ready(webgpu)
      └─ 失败：dispose WebGPU pipeline，记录错误分类
  → 创建 WASM pipeline（不传 device，使用浏览器 CPU 默认）
  → 运行同一个 warm-up
      ├─ 成功：ready(wasm)
      └─ 失败：error
```

约束：

1. WebGPU 只尝试一次；
2. 回退前必须释放失败 pipeline；
3. WASM 只尝试一次；
4. 单次 Ask 不触发隐式 prepare 或无限重试；
5. 记录错误 code，不记录 prompt 或完整模型输出；
6. 下次重试由显式用户动作触发；
7. 如果用户明确选择“仅 WebGPU”，失败后返回不支持，不擅自改变其偏好。

### 5.3 loader facade

第三方 API 放在一个窄接口后面：

```ts
export interface BuiltinChatPipeline {
  warmUp(signal: AbortSignal): Promise<void>;
  generate(
    messages: readonly ChatMessage[],
    options: ChatGenerationOptions,
  ): Promise<ChatGenerationResult>;
  dispose(): Promise<void>;
}

export interface BuiltinChatLoader {
  load(input: {
    policy: BuiltinChatModelPolicy;
    device: RuntimeDevice;
    onProgress: (event: ModelLoadProgress) => void;
    signal: AbortSignal;
  }): Promise<BuiltinChatPipeline>;
}
```

`BuiltinChatRuntime` 依赖这个接口；真实实现才动态 import Transformers.js。单测可注入 fake loader，模拟 WebGPU 失败和 WASM 成功。

## 6. WASM 与 Worker/发布资产

ONNX Runtime Web 生产部署至少涉及：

- JavaScript bundle；
- WASM binary；
- 可能的 Worker 代码；
- 模型和 tokenizer 文件。

官方部署文档说明，如果 WASM 文件没有复制到预期路径，runtime 会初始化失败，并允许通过 `wasmPaths` 指定位置。[ONNX Runtime Web deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html)

Vault Coach 的社区插件形态目前以根目录 `main.js`、`manifest.json` 和 `styles.css` 为正式资产，因而必须在 spike 中验证：

1. esbuild 将哪些 runtime 代码打入 `main.js`；
2. `.wasm` 是否仍以外部 URL 请求；
3. Worker 是否引用开发机路径或未发布 chunk；
4. 是否会从 CDN 下载 WASM runtime 代码；
5. 干净 Vault 只安装正式 release 资产后是否可运行；
6. Mobile 是否采用相同 URL/origin 和缓存行为。

生产版本不应依赖远程 CDN JavaScript、Worker 或 WASM 代码。模型权重下载属于显式模型数据下载，也必须固定来源/revision并向用户披露；runtime 代码应随插件受版本管理。最终如何内联/定位 WASM 必须由构建 spike 证明，不能仅凭开发服务器成功决定。

## 7. Vault Coach 中的 runtime 归属

错误做法：

```ts
class ChatView {
  async display() {
    this.generator = await pipeline(...);
  }
}
```

这会让关闭/重开 View 重复加载模型，并让 UI 掌握下载和资源生命周期。

推荐归属：

```text
VaultCoachPlugin
  → ApplicationContainer
    → BuiltinChatRuntimeService（单例、应用生命周期）
      → WorkerClient
        → TransformersChatLoader（一个 pipeline）
```

View 只订阅状态。插件 `onunload()` 通过 runtime service 取消任务、终止 Worker、释放 pipeline 并撤销 Blob URL。

## 8. 第一个实验：能力探测与 warm-up

### 8.1 预登记

先写下：

```text
Obsidian version：
Electron/Chromium：
OS / CPU / GPU / RAM：
Transformers.js exact version：
Model/revision/dtype：
预期 WebGPU：available / unavailable：
WASM 性能下限：
最大允许峰值内存：
```

### 8.2 实验步骤

1. 记录 `navigator.gpu`、`crossOriginIsolated`、hardware concurrency；
2. 创建 WebGPU pipeline；
3. 用固定 prompt、`do_sample: false`、少量 `max_new_tokens` warm-up；
4. 记录下载、初始化、首 token、总时长、峰值内存；
5. dispose；
6. 创建 WASM pipeline；
7. 重复相同 warm-up；
8. 重启 Obsidian做暖启动；
9. 断网重启并再次 warm-up；
10. 保存原始 JSON 和 trace。

### 8.3 结果 schema

```ts
interface RuntimeProbeResult {
  schemaVersion: 1;
  commit: string;
  environment: {
    obsidian: string;
    electron: string;
    platform: string;
    webgpuApiVisible: boolean;
    crossOriginIsolated: boolean;
  };
  policy: {
    modelId: string;
    revision: string;
    dtype: string;
  };
  run: {
    requestedDevice: RuntimeDevice;
    actualDevice: RuntimeDevice | null;
    cache: "cold" | "warm";
    initMs: number | null;
    firstTokenMs: number | null;
    tokensPerSecond: number | null;
    peakMemoryMb: number | null;
    errorCode: string | null;
  };
}
```

## 9. 常见误区

| 误区 | 正确理解 |
| --- | --- |
| `navigator.gpu` 为真，所以支持内置 LLM | 还需要 session 和真实 warm-up 成功 |
| WebGPU 会自动使用独立显卡 | adapter 选择由宿主与系统决定，需要记录实际行为 |
| WASM 是低精度模型 | WASM 是 CPU runtime；量化由模型 dtype 决定 |
| WebGPU 失败时不断重试即可 | 会形成 crash loop；只回退一次并等待显式重试 |
| pipeline 放在 View 最方便 | 会随 UI 生命周期重复加载和泄漏 |
| 开发环境加载到 WASM 即完成 | 还要验证 release 安装资产和离线启动 |
| GPU 推理不会卡主线程 | tokenization、解码、消息复制和部分算子仍可能占用 CPU |

## 10. 本章练习

1. 画出当前 `LocalModelClient` 的 HTTP 调用链，再画 Built-in adapter 调用链；
2. 为 `BuiltinChatLoader` 写 fake：WebGPU load 抛错、WASM warm-up 成功；
3. 断言 runtime 最终为 `ready`、`actualDevice === "wasm"`，并保存一次 fallback reason；
4. 再让 WASM 失败，断言不会进行第三次 load；
5. 设计 unload 测试，确认进行中的 prepare 被取消且 pipeline dispose 只调用一次；
6. 打开生产 `main.js`，检查是否包含外部 `.wasm`、Worker 或 CDN URL。

## 11. 本章完成标准

- [ ] 能解释 Transformers.js、ONNX Runtime 和 execution provider 的边界；
- [ ] 能解释 WASM 作为 CPU runtime 的作用；
- [ ] capability 以 warm-up 结果判断，不以 API 存在判断；
- [ ] WebGPU → WASM 回退次数有界；
- [ ] pipeline 由应用 runtime 持有，不由 View 持有；
- [ ] 记录冷/暖启动和实际设备；
- [ ] 明确 WASM/Worker 的 release 资产验证方法；
- [ ] 没有把一次 demo 运行写成正式产品 Gate 通过。

