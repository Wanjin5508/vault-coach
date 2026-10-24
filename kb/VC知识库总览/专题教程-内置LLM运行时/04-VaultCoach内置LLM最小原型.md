---
tags: [VaultCoach, 教程, 内置LLM, ChatProvider, TransformersJS, 原型]
status: tutorial
updated: 2026-10-25
previous: 03-模型路径-下载与缓存设计.md
next: 05-Worker调试测试与CICD门禁.md
---

# 04：Vault Coach 内置 LLM 最小原型

## 1. 本章目标

本章把前三章的技术接到 Vault Coach 架构中。完成后，你应理解：

1. 为什么先写 loader/runtime，再写设置页；
2. 如何让 Built-in、Ollama 和 OpenAI-compatible 共享业务端口；
3. 如何实现 stream、cancel、dispose 和有界回退；
4. 如何逐步解开当前代码对 `LocalModelClient` 的具体依赖；
5. 哪些代码属于教学 spike，哪些经过 Gate 后才能进入正式产品。

## 2. 当前接入点

> [!info] 1.5.4 实现边界
> Built-in Embedding 已经通过 `EmbeddingProvider -> BuiltinEmbeddingProvider -> LocalAIRuntimePort` 进入生产代码。本章的 Built-in Chat、WebGPU 回退、流式 token 和 KV cache 仍是后续原型，不应从 Embedding 已发布推导为聊天模型已实现。

当前项目已经有：

```ts
export interface ChatProvider {
  rewriteQuery(...): Promise<QueryRewriteResult>;
  extractMemoryStatements(...): Promise<string[]>;
  generateMarkdownAnswer(...): Promise<string>;
  generateJsonAnswer(...): Promise<string>;
  streamMarkdownAnswer(...): Promise<string>;
}
```

`LocalModelClient implements ChatProvider`，但它仍承担用户配置的 Ollama/OpenAI-compatible 聊天调用。Embedding 已有独立 provider router，并可选 Built-in、Ollama 或 OpenAI-compatible；考试模块中仍存在对 `LocalModelClient` 的具体依赖。这意味着 Embedding 解耦已完成，Chat/考试的端口收窄仍需继续。

在 Built-in Chat 进入正式 router 前，应先完成：

```text
RAG / Exam / Memory
  从依赖 LocalModelClient
  改为依赖 ChatProvider 或更窄的 task port
```

不要让 `BuiltinTransformersChatProvider` 去继承 `LocalModelClient`。两者的资源、错误、取消和生命周期完全不同。

Built-in Chat 应复用已验证的基础设施思路，但不应直接把 Embedding runtime 当作 Chat runtime：

| 可复用 | 需新设计 |
| --- | --- |
| policy 生成、固定 revision/hash、Cache Storage、Worker client、prepare 去重、release size Gate | text generation pipeline、chat template、WebGPU/WASM 设备策略、流式协议、软/硬取消、KV cache、上下文预算 |

## 3. 原型的分阶段目标

### Phase A：独立 smoke

- 不接设置页；
- 不注册 provider；
- 加载固定模型/revision/dtype；
- 一条固定 prompt；
- WebGPU 与 WASM 各跑一次；
- 记录冷/暖性能并 dispose。

### Phase B：runtime service

- 加入状态机；
- 显式 prepare；
- WebGPU → WASM；
- progress、cancel、clear、dispose；
- fake loader/cache 单测。

### Phase C：ChatProvider adapter

- 先接 `streamMarkdownAnswer`；
- 通过 capability 明确未验证任务；
- router 可选择 Built-in；
- UI 仍由 feature flag 隐藏。

### Phase D：产品候选

- Worker 化；
- 多语言与结构化输出 Gate；
- 设置迁移；
- 真机与 release smoke；
- Gate 通过后才展示。

## 4. 建议模块结构

```text
src/domain/model/
  chat-provider.ts
  chat-capabilities.ts
src/app/chat/
  chat-provider-router.ts
  builtin-chat-runtime-service.ts
  builtin-chat-runtime-types.ts
src/infrastructure/chat/transformers/
  builtin-chat-model-policy.ts
  transformers-environment.ts
  transformers-chat-loader.ts
  transformers-chat-pipeline.ts
  builtin-chat-model-cache.ts
  builtin-chat.worker.ts
  builtin-chat-worker-client.ts
src/presentation/settings/sections/
  builtin-chat-status-settings.ts
tests/app/chat/
tests/infrastructure/chat/
scripts/spikes/builtin-chat/
```

spike 可以先放在 `scripts/spikes` 或 `src/infrastructure/chat/spikes`。GO 后将知识重新实现到正式模块，避免把一次性脚本直接升级为生产核心。

## 5. 第一步：固定 policy

```ts
export interface BuiltinChatModelPolicy {
  policyId: string;
  modelId: string;
  revision: string;
  dtype: "q4" | "q8" | "fp16";
  contextTokenLimit: number;
  maxNewTokens: number;
  implementationVersion: number;
}

export const TEACHING_CHAT_POLICY: BuiltinChatModelPolicy = {
  policyId: "teaching-qwen25-05b-q4-v1",
  modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
  revision: "<PINNED_HUB_COMMIT>",
  dtype: "q4",
  contextTokenLimit: 1024,
  maxNewTokens: 128,
  implementationVersion: 1,
};
```

注意：

- `contextTokenLimit` 和 `maxNewTokens` 是教学起点，不是已验证产品值；
- revision 占位符必须在运行前替换；
- policy 不包含 API key 或用户路径；
- 不从设置页让用户任意改 model ID/revision；
- 许可证、文件清单和 benchmark 与 policy 一起进入 ADR。

## 6. 第二步：定义 runtime contract

```ts
export type BuiltinChatDevice = "webgpu" | "wasm";

export interface ChatGenerationInput {
  messages: readonly {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
  temperature: number;
  maxNewTokens: number;
  onText: (text: string) => void;
  signal?: AbortSignal;
}

export interface BuiltinChatPipeline {
  warmUp(): Promise<void>;
  generate(input: ChatGenerationInput): Promise<string>;
  dispose(): Promise<void>;
}

export interface BuiltinChatLoader {
  load(input: {
    policy: BuiltinChatModelPolicy;
    device: BuiltinChatDevice;
    onProgress: (progress: ModelLoadProgress) => void;
  }): Promise<BuiltinChatPipeline>;
}
```

这个 contract 隔离 Transformers.js 类型。版本升级时只有 infrastructure adapter 需要处理 API 差异。

## 7. 第三步：配置 Transformers.js

```ts
let configured = false;

export async function configureTransformersOnce(
  cache: TransformersCacheLike,
): Promise<void> {
  if (configured) return;

  const { env } = await import("@huggingface/transformers");
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = cache;
  env.useWasmCache = true;

  configured = true;
}
```

为什么动态 import：

- 插件启动时不立即解析大型 runtime；
- 只有用户准备 Built-in Chat 时加载；
- 便于在 unsupported 平台保持原 provider 可用；
- 便于 spike 测量 bundle 与初始化边界。

动态 import 是否真的生成额外 chunk，取决于 esbuild 配置。当前插件输出单个 CommonJS `main.js`，必须检查生产构建结果，不能根据源代码语法判断最终资产。

## 8. 第四步：实现 loader

下面代码是**设计骨架**，真实类型和返回值要以锁定的 Transformers.js 版本为准：

```ts
export class TransformersChatLoader implements BuiltinChatLoader {
  async load(input: {
    policy: BuiltinChatModelPolicy;
    device: BuiltinChatDevice;
    onProgress: (progress: ModelLoadProgress) => void;
  }): Promise<BuiltinChatPipeline> {
    const transformers = await import("@huggingface/transformers");

    const deviceOptions = input.device === "webgpu"
      ? { device: "webgpu" as const }
      : {};

    const generator = await transformers.pipeline(
      "text-generation",
      input.policy.modelId,
      {
        revision: input.policy.revision,
        dtype: input.policy.dtype,
        ...deviceOptions,
        progress_callback: (event: unknown) => {
          input.onProgress(mapTransformersProgress(event));
        },
      },
    );

    return new TransformersChatPipelineAdapter(
      generator,
      transformers,
      input.policy,
    );
  }
}
```

WASM 分支没有传 `device`，让浏览器默认 CPU/WASM。不要凭记忆传入未在锁定版本验证的设备字符串。

`mapTransformersProgress()` 必须从 `unknown` 校验第三方事件，不能直接类型断言后写入应用状态。

## 9. 第五步：stream 与 cancel

Transformers.js 提供 `TextStreamer` 接收增量解码文本，也提供可中断 stopping criteria。参考：[Pipeline streaming](https://huggingface.co/docs/transformers.js/en/pipelines)、[InterruptableStoppingCriteria](https://huggingface.co/docs/transformers.js/api/generation/stopping_criteria)。

设计骨架：

```ts
class TransformersChatPipelineAdapter implements BuiltinChatPipeline {
  private disposed = false;

  constructor(
    private readonly generator: any,
    private readonly transformers: any,
    private readonly policy: BuiltinChatModelPolicy,
  ) {}

  async warmUp(): Promise<void> {
    await this.generate({
      messages: [{ role: "user", content: "Reply with OK." }],
      temperature: 0,
      maxNewTokens: 4,
      onText: () => undefined,
    });
  }

  async generate(input: ChatGenerationInput): Promise<string> {
    if (this.disposed) throw new Error("PIPELINE_DISPOSED");

    const stopper = new this.transformers.InterruptableStoppingCriteria();
    const streamer = new this.transformers.TextStreamer(
      this.generator.tokenizer,
      {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => input.onText(text),
      },
    );

    const onAbort = () => stopper.interrupt();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const sampling = input.temperature > 0
        ? { do_sample: true, temperature: input.temperature }
        : { do_sample: false };
      const output = await this.generator(input.messages, {
        max_new_tokens: Math.min(input.maxNewTokens, this.policy.maxNewTokens),
        ...sampling,
        streamer,
        stopping_criteria: [stopper],
      });
      return extractFinalAssistantText(output);
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.generator.dispose();
  }
}
```

工程注意：

- streamer callback 给出的可能是文本片段，不保证严格一 token 一次；
- stopping criteria 通常在生成循环检查点停止，未必能立即中断正在执行的 GPU kernel；
- 硬取消由 Worker terminate 提供，代价是需要重新加载 pipeline；
- `extractFinalAssistantText()` 必须校验返回结构；
- 不使用 `any` 进入正式代码，示例只用它表示第三方类型应封装在 adapter 内；
- 同一 pipeline 不并发执行多个 generation，使用 scheduler 串行化或返回 busy。

## 10. 第六步：runtime service

```ts
export interface BuiltinChatRuntime {
  getStatus(): BuiltinChatRuntimeStatus;
  subscribe(listener: (status: BuiltinChatRuntimeStatus) => void): () => void;
  prepare(options?: { preferredDevice?: "auto" | BuiltinChatDevice }): Promise<void>;
  generate(input: ChatGenerationInput): Promise<string>;
  cancelActiveGeneration(): Promise<void>;
  clearCache(): Promise<void>;
  dispose(): Promise<void>;
}
```

### 10.1 prepare 去重

```ts
private preparePromise: Promise<void> | null = null;

prepare(): Promise<void> {
  if (this.status.phase === "ready") return Promise.resolve();
  if (this.preparePromise) return this.preparePromise;

  this.preparePromise = this.runPrepare()
    .finally(() => {
      this.preparePromise = null;
    });

  return this.preparePromise;
}
```

重复点击“准备模型”不能创建多个下载和多个 pipeline。

### 10.2 回退

```ts
private async loadWithFallback(): Promise<void> {
  if (this.policyAllowsWebGpu() && this.webGpuApiVisible()) {
    try {
      await this.loadAndWarm("webgpu");
      return;
    } catch (error) {
      await this.disposePipeline();
      this.recordFallback(classifyRuntimeError(error));
    }
  }

  await this.loadAndWarm("wasm");
}
```

`loadAndWarm()` 必须在成功后才替换 active pipeline。若 reload 失败且旧 pipeline 仍可用，可保留旧实例；这需要明确 build-then-swap 语义。

## 11. 第七步：完善 ChatProvider capability

当前 `ChatProvider` 假定 provider 能执行所有聊天任务。小型 Built-in 模型可能只通过基础回答，未通过 JSON、记忆抽取或考试生成。

建议加入：

```ts
export type ChatCapability =
  | "markdown-answer"
  | "streaming"
  | "structured-json"
  | "query-rewrite"
  | "memory-extraction"
  | "exam-generation"
  | "semantic-extraction";

export interface ChatProviderDescriptor {
  id: string;
  displayName: string;
  capabilities: ReadonlySet<ChatCapability>;
  privacy: "on-device" | "local-service" | "remote-service";
}
```

然后让调用者在任务开始前检查 capability。未支持时返回结构化错误：

```ts
class UnsupportedChatCapabilityError extends Error {
  constructor(readonly capability: ChatCapability) {
    super(`Unsupported chat capability: ${capability}`);
  }
}
```

不要让考试模块调用 Built-in 后得到坏 JSON，再静默改走云模型。任何跨 provider fallback 都需要用户明确配置和数据边界说明。

## 12. 第八步：Builtin provider adapter

```ts
export class BuiltinTransformersChatProvider implements ChatProvider {
  constructor(private readonly runtime: BuiltinChatRuntime) {}

  async streamMarkdownAnswer(
    messages: LocalChatMessage[],
    temperature: number,
    handlers: ChatStreamHandlers = {},
  ): Promise<string> {
    try {
      const result = await this.runtime.generate({
        messages,
        temperature,
        maxNewTokens: 128,
        signal: handlers.abortSignal,
        onText: (text) => handlers.onToken?.(text),
      });
      handlers.onDone?.();
      return result;
    } catch (error) {
      handlers.onError?.(error);
      throw error;
    }
  }

  async generateMarkdownAnswer(
    messages: LocalChatMessage[],
    temperature: number,
  ): Promise<string> {
    return this.runtime.generate({
      messages,
      temperature,
      maxNewTokens: 128,
      onText: () => undefined,
    });
  }

  // 其余任务只有在对应 capability Gate 通过后实现。
}
```

当前接口要求所有方法存在，所以正式改造要么：

1. 先扩展 capability 并让不支持的方法抛出 typed error；
2. 或拆成 `MarkdownChatProvider`、`StructuredChatProvider`、`QueryRewriteProvider` 等窄端口。

第二种更符合接口隔离，但改动范围更大。不要为了尽快满足 TypeScript 而让未验证任务调用同一个通用 prompt。

## 13. 第九步：Provider router

```ts
type ChatProviderId =
  | "ollama"
  | "openai-compatible"
  | "builtin-transformers";

export class ChatProviderRouter {
  constructor(
    private readonly getSelectedId: () => ChatProviderId,
    private readonly providers: ReadonlyMap<ChatProviderId, ChatProvider>,
  ) {}

  resolve(capability: ChatCapability): ChatProvider {
    const id = this.getSelectedId();
    const provider = this.providers.get(id);
    if (!provider) throw new Error("CHAT_PROVIDER_NOT_REGISTERED");
    if (!supports(provider, capability)) {
      throw new UnsupportedChatCapabilityError(capability);
    }
    return provider;
  }
}
```

router 选择发生在一次请求开始时，然后冻结。本轮生成过程中设置变化不能把 provider 切到另一个实例。

## 14. 第十步：设置与迁移

只有 Gate 通过后才修改：

```ts
type ModelProvider =
  | "ollama"
  | "openai-compatible"
  | "builtin-transformers";
```

迁移规则：

- 旧用户的 `ollama`/`openai-compatible` 原值保留；
- 不清空 URL、model 或 Secret ID；
- 不把旧用户静默切换到 Built-in；
- Built-in Chat 和 embedding provider 独立；
- Built-in runtime policy 不由普通设置自由编辑；
- 模型准备状态来自 cache inspect/runtime，不存一个永久 `ready=true`；
- 用户切回 Ollama 后可以释放 Built-in pipeline，但模型 artifact 是否保留由明确策略决定。

## 15. UI 最小状态卡

```text
Built-in Chat
模型：Teaching model q4（本机运行）
状态：Not installed / Downloading / Loading / Ready / Error
后端：WebGPU / WASM
缓存：约 xxx MB

[准备模型] [取消] [重试] [清除模型]
```

UI 只调用 application API。它不 import Transformers.js、不读 Cache Storage、不直接创建 Worker。

隐私文案必须区分：

- 下载模型时向模型源请求公开模型文件；
- 本地推理时 prompt 和检索上下文不发送给模型服务；
- 插件不收集隐藏 telemetry；
- 切换到云 provider 时适用另一套数据传输说明。

## 16. 错误分类

```ts
type BuiltinChatErrorCode =
  | "MODEL_NOT_PREPARED"
  | "MODEL_DOWNLOAD_FAILED"
  | "CACHE_QUOTA_EXCEEDED"
  | "CACHE_INCOMPLETE"
  | "WEBGPU_UNAVAILABLE"
  | "WEBGPU_INITIALIZATION_FAILED"
  | "WASM_INITIALIZATION_FAILED"
  | "GENERATION_FAILED"
  | "GENERATION_CANCELLED"
  | "UNSUPPORTED_CAPABILITY"
  | "RUNTIME_DISPOSED";
```

错误对象保留：code、phase、recoverable、action。不要包含完整 prompt、笔记内容、API key、用户路径或模型输出。

## 17. 实施顺序与提交建议

```text
test(chat): freeze ChatProvider contracts and concrete dependencies
refactor(chat): replace downstream LocalModelClient types with ports
spike(chat): load pinned Transformers.js teaching model
feat(chat): add builtin runtime state machine and cache adapter
test(chat): cover WebGPU fallback cancel and dispose with fakes
feat(chat): add builtin provider behind feature flag
perf(chat): record desktop and mobile runtime evidence
docs(chat): add ADR and GO-NO-GO decision
```

每一步保持 Ollama 和 OpenAI-compatible 正常。不要在同一个提交中同时更改 migration、UI、runtime、Worker 和模型候选。

## 18. 本章练习

1. 用 `rg "LocalModelClient" src` 列出所有 concrete dependency；
2. 选择一个考试服务，将构造参数改为最窄的聊天 port；
3. 写 fake loader，模拟 progress → ready；
4. 写 WebGPU load failure → WASM ready 的状态测试；
5. 写两个并发 prepare，断言 loader 只调用一次；
6. 写 streaming fake，断言 abort 后不会继续向 UI 发文本；
7. 写 dispose 两次，断言第三方 pipeline 只释放一次；
8. 添加 provider router contract test，验证一次请求中 provider 冻结。

## 19. 本章完成标准

- [ ] spike 不直接注册为用户可见 provider；
- [ ] model/revision/dtype 固定在 policy；
- [ ] Transformers.js 类型留在 infrastructure adapter；
- [ ] runtime 拥有 prepare/generate/cancel/clear/dispose；
- [ ] prepare 去重，生成不并发占用同一 pipeline；
- [ ] WebGPU 失败只回退一次 WASM；
- [ ] stream、cancel 和 dispose 都有 fake test；
- [ ] 下游逐步从 `LocalModelClient` 改为端口；
- [ ] capability 未验证时返回 typed error；
- [ ] 旧用户 provider 和 Secret 配置不被改变；
- [ ] UI 不直接依赖 Transformers.js、Cache API 或 Worker。
