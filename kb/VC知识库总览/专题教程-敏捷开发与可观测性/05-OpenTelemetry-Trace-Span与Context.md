---
tags: [VaultCoach, 教程, OpenTelemetry, Trace, Span, Context]
status: tutorial
updated: 2026-10-20
---

# OpenTelemetry：Trace、Span 与 Context

## 1. OpenTelemetry 解决什么

OpenTelemetry（OTel）提供一组与供应商无关的 API、SDK、数据约定和协议，用来生成、处理和导出 traces、metrics、logs 等遥测信号。它不是存储和查询界面本身；Jaeger、Grafana、云平台或自建后端属于消费这些信号的系统。

Vault Coach 现阶段最有价值的是采用 OTel 的**数据模型与边界思想**：

- 一次用户意图形成一个 trace；
- 每个有开始和结束的关键阶段形成一个 span；
- 通过 context 保持 parent/child 关系；
- 用稳定、低基数名称和受控 attributes 描述结果；
- 日志自动关联当前 trace/span；
- exporter 是可替换基础设施，默认可以完全本地。

不必为了学习这些原则立即接入完整 SDK 或远程 Collector。

## 2. Trace：一次端到端操作

Trace 表示一组有因果关系的操作。对 Vault Coach，可把以下动作作为根 trace 候选：

- `ask.turn`：一次问答，从准备知识库到检索、生成和保存；
- `index.rebuild`：一次完整索引重建；
- `index.sync`：一次增量同步；
- `exam.generate`：一次考试生成；
- `exam.evaluate`：一次评分；
- `semantic_graph.rebuild`：一次语义图谱重建。

根 trace 边界应贴近用户意图或后台工作项，而不是 UI click 本身。如果两个按钮最终触发同一个应用用例，trace 应由应用边界开始，避免把展示层细节变成长期遥测契约。

## 3. Span：有时间范围的工作单元

[OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/) 将 span 视为 trace 的基本工作单元。典型 span 包含名称、父 span ID、开始/结束时间、span context、attributes、events、links 和 status。

### 3.1 索引重建例子

```text
Trace 7bba...  index.rebuild
├── Span 01  documents.scan
├── Span 02  documents.parse
├── Span 03  retrieval.keyword_index.build
├── Span 04  embedding.batch
│   ├── Span 05  model.embedding.request
│   └── Span 06  vector.normalize
├── Span 07  retrieval.vector_index.persist
└── Span 08  graph.rebuild
```

所有 span 共享 `traceId`，每个 span 有自己的 `spanId`，子 span 保存 `parentSpanId`。这样可以还原顺序、嵌套、耗时和失败传播。

### 3.2 什么值得成为 span

满足以下一项通常值得考虑：

- 影响用户可感知延迟；
- 跨越模块、线程、Worker、进程或网络边界；
- 有独立的失败或降级语义；
- 需要独立归因耗时；
- 是批处理或异步工作的重要阶段。

以下通常不值得：

- 简单 getter、格式化函数和纯映射；
- 循环中的每个 chunk；
- 只有一个瞬间、没有持续时间的状态点；
- 无法形成诊断决策的内部细节。

大量微小 span 会增加性能、存储和理解成本。

## 4. Span 名称与 attributes

### 4.1 名称必须稳定、低基数

推荐：

```text
index.rebuild
documents.parse
retrieval.search
model.chat.request
model.embedding.request
exam.generate
storage.snapshot.write
```

禁止把动态数据写进名称：

```text
index.rebuild:/Users/alice/private-vault
retrieval.search:what-is-my-salary
model.chat.request:7bba9f...
```

动态值会制造高基数，也可能泄漏隐私。

### 4.2 Attributes 描述受控元数据

```ts
{
    "vc.operation": "rebuild",
    "vc.retrieval.mode.requested": "hybrid",
    "vc.retrieval.mode.actual": "keyword",
    "vc.document.count": 420,
    "vc.chunk.count": 3180,
    "vc.outcome": "degraded",
    "vc.error.code": "VC_EMBEDDING_UNAVAILABLE"
}
```

优先使用 OTel 已定义且语义匹配的 semantic conventions；项目专用字段使用稳定命名空间，如 `vc.*`。不要把近似含义硬塞进不匹配的标准字段。

## 5. Span event：span 内有意义的瞬间

OTel 将 span event 视为 span 生命周期中的结构化时间点。判断方式是：**这个瞬间的时间是否有诊断意义？**

```text
span: retrieval.search
  event: vector_fallback.activated
    at: 12:03:14.220
    attributes:
      vc.error.code = VC_EMBEDDING_TIMEOUT
      vc.retrieval.mode.actual = keyword
```

适合 event：

- fallback 被启用；
- 首个 token 到达；
- 批处理进入重试；
- 用户发出取消；
- 快照恢复完成。

只描述 span 最终特征且时间不重要时，使用 attribute。例如最终 `chunk.count`。

## 6. Status、Outcome 与异常

OTel span status 有 `Unset`、`Error`、`Ok`。默认 `Unset` 可表示没有错误；`Ok` 是调用方明确确认成功。项目还需要单独的业务 outcome：

```ts
type OperationOutcome = "ok" | "cancelled" | "degraded" | "error";
```

二者不要混为一谈：

| 场景 | span status | `vc.outcome` | 说明 |
| --- | --- | --- | --- |
| 正常完成 | `Unset` 或按策略 `Ok` | `ok` | 团队统一一种策略 |
| 用户主动取消 | 按项目约定，通常不视为系统错误 | `cancelled` | 保留取消原因类别，不记录原文 |
| 子阶段失败但顶层成功降级 | 失败子 span 为 `Error`；根 span 可不报错 | `degraded` | 让可用结果和内部失败同时可见 |
| 当前操作失败 | `Error` | `error` | 记录稳定错误码 |

异常记录不代表 catch 后可以吞掉错误。业务控制流仍通过返回值、typed error 或异常契约表达；遥测只是旁路证据。

## 7. SpanKind

OTel 定义 `Internal`、`Client`、`Server`、`Producer`、`Consumer`：

| Kind | 含义 | Vault Coach 示例 |
| --- | --- | --- |
| `Internal` | 进程内部操作 | parse、rerank、索引持久化编排 |
| `Client` | 等待结果的出站远程调用 | 调用 Ollama、云 LLM、未来 Knowledge Engine |
| `Server` | 处理远程入站请求 | 当前插件通常没有；未来 Engine 服务端有 |
| `Producer` | 创建稍后处理的工作 | 将索引任务提交给 Worker/队列 |
| `Consumer` | 处理先前创建的工作 | Worker 消费索引任务 |

不要因为函数使用 `async/await` 就把它称为异步消息。`Client` 与 `Producer` 的区别在于请求响应和延迟处理语义。

## 8. Context：让关联跨越调用边界

[OTel Context specification](https://opentelemetry.io/docs/specs/otel/context/) 将 Context 定义为携带执行范围值、跨 API 边界传播的机制，并要求它不可变。对项目而言，最小 context 可以是：

```ts
export interface TraceContext {
    readonly traceId: string;
    readonly spanId: string;
    readonly traceFlags: number;
}
```

### 8.1 显式传播

在 Obsidian/Electron 插件中，回调、Promise、事件监听器和 Worker 可能打断隐式上下文。第一阶段优先显式传递：

```ts
await tracer.withSpan("index.rebuild", {}, async (root) => {
    await scanDocuments(root.context);
    await rebuildVectorIndex(root.context, signal);
});
```

显式传播更啰嗦，但依赖清楚、容易测试，不会依赖全局可变的“当前 span”。未来若引入 OTel JS context manager，应先验证 Obsidian 的 Electron 版本、Promise/事件边界、卸载和包体。

### 8.2 Context 不是业务参数仓库

只放跨切面关联值。不要把 settings、用户问题、Vault 路径或权限状态塞进 trace context。业务参数仍通过函数接口显式传递。

## 9. Links：关联但不强行成为父子

当工作异步排队，生产 span 可能早于消费 span 结束，或者一个新任务由多个来源触发。此时 link 可以表达因果关联，而不伪造同步父子结构。

例子：多个文件变更被 debounce 后合并成一次 `index.sync`：

- 每个变更产生一个轻量触发 context；
- 合并任务产生新的 root span；
- 用 links 关联触发来源；
- 不记录文件名，只记录触发类别和数量。

首个版本可以不实现 links，但接口设计不要假定所有因果关系都是严格树形。

## 10. 日志与 trace 关联

日志发生在活动 span 中时，应自动带上 `traceId` 和 `spanId`：

```json
{
  "severity": "warn",
  "eventName": "retrieval.vector.fallback",
  "traceId": "7bba9f33312b3dbb8b2c2c62bb7abe2d",
  "spanId": "086e83747d0e381e",
  "outcome": "degraded",
  "errorCode": "VC_EMBEDDING_TIMEOUT",
  "attributes": {
    "requestedMode": "hybrid",
    "actualMode": "keyword"
  }
}
```

这样先从 error log 找到 trace，再查看整个端到端路径；也可以从慢 trace 找到具体日志。

## 11. 跨远程服务传播

未来 Vault Coach 调用受信任的 Knowledge Engine 时，可使用 [W3C Trace Context](https://www.w3.org/TR/trace-context/) 的 `traceparent`/`tracestate` 传播关联。`traceparent` 包含版本、trace ID、parent ID 和 flags。

项目必须先定义信任边界：

- 只向明确参与追踪的可信服务注入 header；
- 不向任意用户配置的 LLM endpoint 自动发送追踪 header；
- `traceparent`/`tracestate` 不包含 PII 或敏感内容；
- 随机 ID 的生成不能使用用户可识别数据；
- 入站 header 必须验证长度和格式；
- 跨信任边界时可按策略重启 trace；
- baggage 默认禁用，直到有明确的字段 allowlist 和威胁模型。

W3C 规范明确禁止在这些字段中放入个人或敏感信息。

## 12. 生命周期模板

一个安全 span 必须恰好结束一次：

```ts
return tracer.withSpan("retrieval.search", attributes, async (span) => {
    try {
        const result = await search();
        span.setAttribute("vc.result.count", result.length);
        span.setOutcome("ok");
        return result;
    } catch (error) {
        if (isAbortError(error)) {
            span.setOutcome("cancelled");
            throw error;
        }
        const safe = normalizeError(error);
        span.recordError(safe);
        span.setOutcome("error");
        throw error;
    }
});
```

`withSpan` 在 `finally` 内结束 span，调用者不手动重复 `end()`。sink/exporter 错误由 tracer 隔离。

## 13. 采样与本地有界保留

第一阶段默认只在本地保留最近 N 条 span/log，并对高频 debug 记录关闭或限速。若未来连接后端，才评估：

- head sampling：开始时决定是否记录；
- tail sampling：看到结果后保留慢或失败 trace；
- 错误 trace 优先保留；
- 单用户插件的样本是否足够；
- 采样是否掩盖罕见故障；
- 成本、隐私和网络影响。

采样不能用于业务正确性。任何降级和恢复逻辑不得依赖“这条 span 是否被记录”。

## 14. 新人练习与 Gate

为 `ask.turn` 画一棵 trace 树，至少包含知识库准备、query rewrite、keyword/vector retrieval、rerank、prompt build、model request 和持久化。

逐个 span 写出：name、kind、parent、safe attributes、event、status/outcome、失败与降级。

### 完成 Gate

- [ ] 根 span 对应一次用户意图；
- [ ] 名称稳定且不包含动态/敏感值；
- [ ] 只为关键工作单元创建 span；
- [ ] 降级在子 span 和根 outcome 中都有合理表达；
- [ ] context 跨异步边界不依赖全局可变状态；
- [ ] 远程传播遵守信任边界；
- [ ] 日志可通过 ID 与 trace 关联。

下一章：[[06-VaultCoach可观测性架构与接口]]
