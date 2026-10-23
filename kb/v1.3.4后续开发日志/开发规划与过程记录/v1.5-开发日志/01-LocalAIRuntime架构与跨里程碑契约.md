---
tags: [VaultCoach, v1.5, LocalAIRuntime, 架构, 接口]
status: proposed
updated: 2026-10-23
---

# LocalAIRuntime：职责、接口与跨里程碑不变量

## 1. 当前代码与目标边界

以下路径已存在：

| 当前模块 | 已有职责 | 规划调整 |
| --- | --- | --- |
| `src/model-client.ts` | HTTP chat/JSON、rewrite、memory、embedding、rerank | 分阶段抽出 adapter，保留外部兼容 |
| `src/domain/model/chat-provider.ts` | 生成接口同时含 rewrite/memory | M3 建立窄 utility 接缝，M6.2 完成消费者迁移 |
| `src/rag-engine.ts` | 构造 LocalModelClient；协调召回、重排、回答 | 依赖 embedding/rerank/utility/chat 四种端口 |
| `src/memory/memory-service.ts` | 通过 RAG 调抽取，管理记忆增删和裁剪 | M6.2 依赖 MemoryExtractionPort；保留存储所有权 |
| `src/app/application-container.ts` | 装配 RAG、图谱、考试、记忆 | 唯一创建各 adapter 和 LocalAIRuntime 的位置 |
| `src/app/vault-coach-runtime.ts` | 插件运行编排、索引恢复 | 继续做应用编排；它与 LocalAIRuntime 职责不同 |
| `src/app/config/*` | 设置校验、迁移、持久化、UI 偏好 | 增量增加独立角色选择，保留旧值 |
| `src/domain/model/structured-output-service.ts` | 结构化生成和解析协作 | Utility 的校验复用评估入口，不等于已经校验新 schema |

拟新增结构：

```text
src/domain/embedding/                 # M3 embedding 契约和空间指纹
src/domain/rerank/                    # M3 最小端口；M6.1 丰富实现
src/domain/utility/                   # M3 最小端口；M6.2 rewrite/memory 契约
src/domain/local-ai/                  # 状态、策略、错误、资源身份
src/app/embedding/                    # provider router
src/app/local-ai/                     # runtime 门面、注册表、调度
src/app/rerank/                       # role router
src/app/utility/                      # role router、校验和失败策略
src/infrastructure/local-ai/          # loader、cache、worker 协议/客户端
src/infrastructure/embedding/         # Ollama、OpenAI-compatible、builtin
src/infrastructure/rerank/            # HTTP、heuristic、builtin
src/infrastructure/utility/           # legacy chat adapter、builtin
```

这些目录不是已存在实现的声明。第三方 tensor、pipeline 和 session 类型只允许出现在 infrastructure；domain 无 Obsidian、模型 SDK 或 DOM 依赖。

## 2. 统一的是生命周期，职责通过窄端口表达

```text
RAG / Memory / Graph
  → EmbeddingProvider / RerankProvider / Utility ports
      → Builtin adapters
          → LocalAIRuntime
              → registry + cache + scheduler + worker runtime

Main Chat / Exam / 当前概念抽取
  → ChatProvider / JsonGenerationGateway
      → 用户配置的 Ollama 或 OpenAI-compatible
```

LocalAIRuntime 不知道 RRF、考试评分、记忆写库或图治理规则。它统一管理模型资源、任务、状态与释放。一个运行时门面也不意味着三个模型始终加载，或所有角色强制使用同一种模型架构。

以下接口是实现指导；引用的状态与请求类型需要由 M3 定义最小契约、M5 补齐生命周期细节，不能直接复制成一个万能 service：

```ts
type LocalAiRole = "embedding" | "reranker" | "utility";

interface LocalAIRuntime {
    getStatus(role: LocalAiRole): LocalAiStatus;
    prepare(role: LocalAiRole, request: PrepareRequest): Promise<void>;
    cancel(jobId: string): void;
    clearModel(role: LocalAiRole): Promise<void>;
    subscribe(listener: (event: LocalAiEvent) => void): () => void;
    dispose(): Promise<void>;
}
```

`prepare` 必须核对资产授权记录、模型策略和设备能力。推理调用由各角色 adapter 访问类型明确的 worker client，UI 只获得 status 和动作，不能直接调用 pipeline。

## 3. 三种身份不能混用

| 身份 | 字段与目的 | 改变后的影响 |
| --- | --- | --- |
| ModelArtifactIdentity | repo、不可变 revision、文件清单/哈希、tokenizer、dtype、runtime artifact 版本 | 下载/缓存校验和加载兼容 |
| EmbeddingFingerprint | 模型与量化、pooling、归一化、query/document/graph 预处理、dimension、实现版本 | corpus/query 必须兼容；不匹配就拒绝向量检索 |
| TaskPolicyIdentity | rerank score 解释与截断版本，utility prompt/schema/token budget 版本 | 重排/改写/抽取结果与缓存失效，不重建 corpus vectors |

新增模型权重 dtype 字段，例如 `modelDtype`；不能用恒定的 `outputDtype: "float32"` 代替量化身份。即使 q4/q8 都返回 Float32Array，也可能产生不同向量空间。设备只进入诊断；只有 M4 证明同策略 CPU/GPU 可兼容时才允许复用。runtime 更新若改变数值语义，更新实现版本。

corpus 范围、parser/chunker 和源版本组成独立的索引内容身份；改变范围需要重建索引内容，但不意味着 embedding 模型发生变化。更换 reranker 或 utility 模型不应删除现有 embedding 代际。

## 4. 状态、下载与资源策略

每个 role 独立持有状态：

```text
not-installed → downloading → verifying → loading → ready
                      ↘ cancelled / error
ready → evicted（权重在磁盘，实例已释放）→ loading → ready
ready → clearing → not-installed
任一运行状态 → unavailable（设备/策略不满足）
```

下载资源存在、模型可加载、单次任务完成是三件事。complete marker 必须与实际资源校验一起使用；重启后不恢复旧 promise 或 ready 布尔值。

- 首次准备展示模型来源、大小、许可证、磁盘使用和角色；授权与策略 revision 关联。
- 权重、tokenizer 是模型数据；Worker JS 和 WASM runtime 是执行资源。代码随受支持发布形态固定提供，不能用首次模型下载绕过远程代码限制。
- M4 必须验证 Worker/CSP、WASM 定位和最终三件套安装。如果运行时资产无法按允许方式交付，Gate 为 NO-GO，不退到 CDN 运行时代码。
- 不依赖 DOM 中的本地文件路径能被 fetch；缓存 URL 与 Vault adapter path 由 adapter 映射。
- 模型下载字节、持久化占用、JS/WASM/GPU 峰值内存分别计量；三模型累计预算只是一项待测产品目标。

## 5. 调度与取消

起步采用一个受控执行队列、单个活跃模型实例的保守策略，M4/M6 实测后才开放多实例。优先级：前台 query embedding / rerank / rewrite > 后台索引 > turn 后记忆抽取；长期后台任务要有等待上限和公平性。

模型切换先释放旧实例再加载新角色，记录换入换出成本。不要假设浏览器能准确读取 GPU 剩余内存，也不要在 UI 中保证硬件无法提供的内存精度。

任务携带 `jobId + requestId + workerEpoch + policyId`。变更 provider 或 scope、清缓存、取消、卸载后，迟到结果不能更新 ready、索引或记忆。soft cancel 停止新 batch；hard cancel 终止 worker，并拒绝该 worker 全部 pending 请求，不假装只终止一个并发任务。

## 6. 角色路由和失败策略

| 能力 | 新用户通过 Gate 后的目标 | 失败处理 | 旧用户 |
| --- | --- | --- | --- |
| Embedding | builtin，用户授权准备 | keyword，可见原因；不暗中改用云端 | 原 provider/model/endpoint 保留 |
| Rerank | builtin 或暂时 heuristic | heuristic 或保持输入排名 | 远程配置继续生效；关闭开关继续关闭 |
| Rewrite | builtin utility 或关闭 | 原 query，受预算约束 | 显式标记 existing chat 路由 |
| Memory | builtin utility，且长期记忆开关开启 | 本轮不写入，保留旧记忆 | 已有开关、内容和偏好保留 |
| Main Chat | 用户选择 Ollama/云 API | 报连接/模型错误，可继续查看检索结果 | 完全保留 |

外部兼容路径属于用户已选择的模式，不是 builtin 失败后的隐式备用。用户可以主动改路由，界面解释哪些文本将发送出去。只有 weights 暖缓存、模型实例恢复、所有必要辅助路径本地且网络断开实测通过，才标记“本地检索前处理可离线”。

## 7. Settings 与派生状态

拟新增字段在引入对应能力的里程碑迁移：`rerankProvider`、`utilityProvider`，以及 role-specific model policy 引用。不要在 M3 就给旧用户填 builtin 默认。实际字段名、schema bump 在 ADR 冻结，文档名称是提案。

业务偏好、`uiPreferences.advancedSettingsExpanded`、setup 草稿、下载授权、缓存清单、模型运行状态分别管理。折叠标题不会停用模型，清模型不会清理考试/聊天/记忆记录。

未来未知 schema 不向下覆盖；旧用户缺新字段按旧行为推断。只凭缺少新字段不能判断“全新安装”。

## 8. 统一验证协议

M4 开始冻结评测配置：候选清单、hash/revision、语料版本、设备、预热、指标和门槛。每项记录具体数值、方向、单位及依据；不得在结果产生后更改门槛来制造 GO。数值尚未批准或设备未测，即状态 pending，不允许翻转默认。

三层证据分开：fake contract 测试；真实 runtime smoke；目标设备产品 Gate。普通 PR CI 不下载真实模型，手工 benchmark workflow 固定资源和预算。各里程碑都有待填写记录；本次文档修订不填运行 PASS。

## 9. 官方依据与技术选型状态

核对日期 2026-10-23：

- [Transformers.js 版本化文档](https://huggingface.co/docs/transformers.js/v3.8.1/en/index)：浏览器推理通过 ONNX Runtime，支持多类 NLP 任务。
- [dtype 指南](https://huggingface.co/docs/transformers.js/v3.8.1/en/guides/dtypes)：量化类型取决于模型资产；可作为 Qwen2.5-0.5B ONNX 教学候选入口，不能据此保证 JSON 或中文记忆质量。
- [env 配置](https://huggingface.co/docs/transformers.js/v3.8.1/en/api/env)：模型来源和缓存配置。禁用远程访问本身不保证所有权重、tokenizer、WASM 已经缓存。
- [ONNX Runtime Web 部署](https://onnxruntime.ai/docs/tutorials/web/deploy.html)：JS/WASM 版本与资源加载、Worker 和运行环境需要共同验证。

[官方 v4 发布公告](https://huggingface.co/blog/transformersjs-v4)已明确宣布 npm 发布与运行时改进；但本次读取的[主文档入口](https://huggingface.co/docs/transformers.js/en/index)仍显示 main/source，并将稳定版链接指向 v3.8.1。这是来源版本信息不一致，不能据此否定 v4，也不能混用两版接口。M4 应优先把 v4 纳入候选，核对实际 npm 发布版本、对应文档、lockfile 与模型支持矩阵后决定；以上 v3.8.1 链接是可复查的版本化 API 依据，不是最终选型。

## 10. 文档修订记录

2026-10-23：根据《06-实现顺序》建立统一跨里程碑契约；尚未安装依赖、下载模型或实施接口。交付各角色时同步维护本文件与 M3–M10，禁止在不同里程碑创造第二套缓存身份或 Worker 协议。
