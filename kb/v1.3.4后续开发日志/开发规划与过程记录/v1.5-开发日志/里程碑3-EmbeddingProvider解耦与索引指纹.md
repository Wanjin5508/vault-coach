---
tags: [VaultCoach, v1.5, 里程碑3, EmbeddingProvider, 索引指纹]
status: planned
updated: 2026-10-09
depends-on: [里程碑2-默认体验与Advanced设置分层.md]
---

# 里程碑 3：Embedding Provider 解耦与索引指纹

## 1. 目标

在不引入内置模型的前提下，将 embedding 从 `LocalModelClient` 和 `AdvancedRagEngine` 解耦为稳定 port，并建立能阻止新旧向量混用的索引 fingerprint。先让 Ollama 和 OpenAI compatible 走同一契约，再由 M5 加 builtin。

学习重点：依赖反转、adapter、contract test、持久化格式演进与安全迁移。

## 2. 当前问题

- `src/model-client.ts` 同时承担聊天、JSON、embedding、rerank；
- `src/rag-engine.ts` 直接依赖具体 client，并了解 Ollama CPU fallback；
- provider 特有的诊断从基础设施层泄漏到领域/服务层；
- `src/app/semantic-graph/semantic-graph-service.ts` 另有 embedding gateway，容易出现两套选择逻辑；
- 仅比较模型名不足以证明 corpus 与 query 向量兼容；
- 模型、revision、dtype、维数或归一化变化后，旧向量可能仍被读取。

## 3. 核心契约

### 3.1 最小 port

```ts
export interface EmbeddingRequest {
  texts: readonly string[];
  purpose: "document" | "query" | "graph";
  signal?: AbortSignal;
}

export interface EmbeddingBatch {
  vectors: Float32Array[];
  fingerprint: EmbeddingFingerprint;
  diagnostics: EmbeddingDiagnostics;
}

export interface EmbeddingProvider {
  readonly id: "builtin" | "ollama" | "openai-compatible";
  describe(): Promise<EmbeddingProviderStatus>;
  embed(request: EmbeddingRequest): Promise<EmbeddingBatch>;
}
```

port 不暴露 HTTP URL、Transformers pipeline 或 Ollama 的 keep-alive。它表达应用真正需要的能力。`purpose` 允许 E5 等模型对 query/document 使用不同前缀，并把该预处理写入 fingerprint。

### 3.2 Fingerprint

```ts
interface EmbeddingFingerprint {
  provider: string;
  model: string;
  revision: string;
  dimension: number;
  dtype: string;
  pooling: string;
  normalize: boolean;
  preprocessing: string;
  implementationVersion: number;
}
```

将字段按稳定顺序 canonicalize 后散列。`device`（WebGPU/WASM）通常只进入 diagnostics；只有设备改变数值语义时才进入 fingerprint。不能把 API key、URL 中的凭据或用户文本写入 fingerprint。

规则：

1. 建库时保存 fingerprint；
2. 查询前读取当前 provider fingerprint；
3. 完全相等才能做向量相似度；
4. 不相等时标记 vector stale 并触发明确重建流程；
5. 维数不匹配必须在 dot product 前失败；
6. keyword 数据可继续使用，不因向量失效而丢弃。

## 4. 涉及文件、建议模块与修改范围

| 文件/模块 | 修改 |
| --- | --- |
| `src/domain/embedding/embedding-provider.ts` | 新建 port 和请求/结果类型 |
| `src/domain/embedding/embedding-fingerprint.ts` | 新建 canonicalization、比较与 hash |
| `src/app/embedding/embedding-provider-router.ts` | 根据已验证设置选择 provider |
| `src/infrastructure/embedding/ollama-embedding-provider.ts` | 从 LocalModelClient 抽 adapter |
| `src/infrastructure/embedding/openai-compatible-embedding-provider.ts` | 抽 adapter，统一错误分类 |
| `src/model-client.ts` | 现有文件；暂保留 chat/json/rerank，embedding 走 adapter |
| `src/rag-engine.ts` | 现有文件；构造函数注入 port，不判断 provider |
| `src/app/semantic-graph/semantic-graph-service.ts` | 复用同一 port/router，避免第二套配置 |
| `src/infrastructure/storage/storage-types.ts` | 现有 snapshot 类型增加 fingerprint 与格式版本 |
| `src/knowledge-base.ts`、`src/vector-store.ts`、`src/persistent-store.ts` | 现有知识库、向量与持久化入口适配新 manifest |
| `src/app/application-container.ts` | 唯一 composition root，装配 adapter |
| `src/app/application-api.ts` | 扩展现有 API，暴露状态/重建，不暴露 provider 对象 |
| `tests/domain/embedding/*` | fingerprint 单测 |
| `tests/infrastructure/embedding/*` | adapter contract tests |
| `tests/services/advanced-rag-engine.test.ts` | fake provider 注入与故障测试 |

实际文件名以当前仓库结构为准；保持依赖方向 `presentation → app → domain ← infrastructure`。

## 5. 手动实施顺序

### Step 1：写 characterization 与 contract tests

从现有 Ollama/OpenAI 请求中提取共同可观察行为：批量输入顺序、空输入、维数、HTTP 错误、超时、取消、非有限数。先用现有实现让测试通过。

contract test 应可由 provider factory 重用：

```ts
embeddingProviderContract("ollama", () => createFakeBackedOllamaProvider());
embeddingProviderContract("openai-compatible", () => createFakeBackedOpenAIProvider());
```

CI 使用 mock transport，不访问真实模型服务。

### Step 2：创建 port 与 Ollama adapter

先让 adapter 内部调用旧 client，减少同时改动。将 provider-specific fallback 转换为 `EmbeddingDiagnostics`，例如 runtime、fallbackReason、latencyMs；上层不再调用 `consumeOllamaEmbeddingCpuFallbackUsed()`。

### Step 3：增加 OpenAI compatible adapter

统一 error code：`auth`、`network`、`unsupported-model`、`dimension-mismatch`、`cancelled`、`unknown`。保留原始 error 作为 cause，用户界面只显示脱敏摘要。

### Step 4：在 composition root 注入

`ApplicationContainer` 创建 router 与 provider，并将 port 注入 `AdvancedRagEngine` 和 semantic graph service。测试直接注入 fake provider，不全局 monkey patch。

### Step 5：设计并落地 fingerprint

先写 canonicalization 测试，保证对象 key 顺序不改变 hash。provider 在首次成功加载或 describe 时给出完整 fingerprint。不要用会漂移的“latest/main”作为 revision。

### Step 6：升级知识库格式

建议将 snapshot/manifest 升为下一格式版本：

- 老版本文字 chunk、BM25/keyword 数据仍可读；
- 老向量因缺少完整 fingerprint 标记 stale；
- 首次读取不立即阻塞式全量重建；
- UI 提示“Semantic index needs rebuilding”；
- 新索引采用临时文件/事务式替换，成功后才替换 active manifest。

确切版本号以当前常量为基线递增，不在文档中硬编码成未核实值。

### Step 7：删除上层 provider 分支

用 `rg` 查找 `ollama|openai-compatible|embeddingModel`。允许设置、router 和 adapter 知道 provider；RAG/graph 业务层不应知道。

## 6. 测试与故障注入

### Fingerprint 测试

- 相同字段、不同 key 插入顺序得到相同值；
- model/revision/dtype/dimension/pooling/normalize/preprocessing 任一变化都会不匹配；
- device 变化按 ADR 结果决定是否匹配；
- fingerprint JSON 不含秘密；
- 旧 manifest 被识别为 stale，而非被当成当前向量。

### Provider contract

- 保持输入输出顺序；
- 空 batch 行为明确；
- vectors 都是有限数且维数一致；
- AbortSignal 取消；
- 超时和非 2xx 分类；
- malformed response 不落盘；
- 一个 batch 失败时不返回部分伪成功。

### 集成场景

1. 建索引后切换模型，Ask 自动走 keyword 并提示重建；
2. 重建中旧 active index 仍完整；
3. 写入中断后重启，临时索引被清理或恢复；
4. graph 与 Ask 使用同一个 fingerprint；
5. provider 返回错误维数时在持久化前失败。

## 7. 调试训练

1. 使用 fake provider 在第 N 个 batch 抛错，观察事务边界；
2. 人为修改 manifest 中 dimension，确认在相似度计算前被挡住；
3. 比较 query/document preprocessing 日志，找出前缀遗漏；
4. 用 `git bisect` 在一系列小提交中定位一个 contract 回归；
5. 记录调用耗时、batch size、provider ID、fingerprint 短前缀，不记录文本。

## 8. 工程实践与原因

- port 由应用需求定义，避免由第三方 SDK 类型主导架构；
- composition root 集中装配，业务类只接收接口；
- contract tests 让三个 provider 满足同一行为，而不是只实现同名方法；
- fingerprint 表示向量语义，避免“维数碰巧相同”被误判兼容；
- 索引采用 build-then-swap，防止崩溃污染可用版本；
- 文字索引与向量索引分开失效，保证可降级可恢复；
- 错误类型结构化，UI 文案与底层 cause 分离。

## 9. PR 切片

1. `test: define embedding provider contract`；
2. `refactor: introduce embedding provider port`；
3. `refactor: adapt ollama and openai embedding providers`；
4. `refactor: inject embedding port into rag and graph services`；
5. `feat: persist embedding fingerprint`；
6. `feat: invalidate incompatible vector indexes safely`。

## 10. 完成标准

- [ ] `AdvancedRagEngine` 不导入具体 provider/client；
- [ ] Ask 与 graph 共享 provider 选择和 fingerprint 规则；
- [ ] Ollama/OpenAI adapter 通过同一 contract；
- [ ] 任一语义字段变化都会使向量 stale；
- [ ] 旧索引不会与新 query vector 混用；
- [ ] vector stale 时 keyword 仍可用；
- [ ] 重建失败不替换最后一个完整索引；
- [ ] 测试、lint、build 通过且没有真实网络依赖。

## 11. 实施记录

```text
采用的 port：
Fingerprint ADR：
知识库格式变化：
迁移样本与结果：
Contract test：
故障注入：
回滚方案：
遗留 provider 分支：
```
