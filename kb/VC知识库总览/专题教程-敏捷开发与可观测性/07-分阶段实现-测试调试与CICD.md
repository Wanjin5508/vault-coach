---
tags: [VaultCoach, 教程, 实施指南, 测试, 调试, CICD, OpenTelemetry]
status: tutorial
updated: 2026-10-20
---

# 分阶段实现：测试、调试与 CI/CD

## 1. 实施策略

本里程碑使用“先建立安全契约，再完成一条纵向 trace，最后渐进迁移”的顺序。新人每完成一步，都应有独立测试和可回滚提交。

```mermaid
flowchart LR
    S0[0 基线与策略] --> S1[1 类型与脱敏]
    S1 --> S2[2 Buffer 与 Sinks]
    S2 --> S3[3 Tracer 与 Context]
    S3 --> S4[4 索引纵向切片]
    S4 --> S5[5 诊断 API 与 UI]
    S5 --> S6[6 渐进迁移 console]
    S6 --> S7[7 CI 与性能 Gate]
    S7 --> S8[8 可选 OTel/远程传播]
```

前七步不要求新增生产依赖。第一版用项目内接口和本地实现验证数据模型，避免把 SDK 选型、远程服务和业务埋点绑成一个不可评审的大 PR。

## 2. 开工前约定

### 分支与基线

```bash
git status --short --branch
git switch -c feature/local-observability-foundation
npm ci
npm run lint
npm test
npm run build
git diff --check
```

如果工作区已有修改，先确认来源和范围，不要用 reset/checkout 覆盖他人的工作。把基线失败原样记录在 Sprint 文档中；新变更不得伪称修复了未调查的旧失败。

### Sprint Goal

> 在默认本地且不记录用户内容的前提下，维护者能诊断一次索引重建的阶段、耗时、结果和降级。

### 本 Sprint 范围

- 最小 logger/tracer 端口；
- 安全字段、错误归一化、ID 与 clock；
- 有界内存 sink；
- `index.rebuild` 纵向 trace；
- 只读诊断 API、最小展示与手动复制；
- 自动化与真实 Obsidian 验收。

### 明确延期

- OTLP、Collector 和云平台；
- 全量 console 迁移；
- 长期持久化遥测；
- 完整 metrics 平台；
- 用户行为分析；
- 自动上传错误报告。

## 3. Step 0：冻结基线、诊断问题和隐私策略

### 学习目标

理解“先问要诊断什么，再决定记录什么”，并建立可比较的现状证据。

### 内部依赖

- `AGENTS.md` 的本地优先、隐私、性能和生命周期规则；
- `src/app/application-events.ts`；
- `src/app/application-container.ts`；
- `src/app/vault-coach-runtime.ts`；
- `tests/architecture/import-boundaries.test.ts`；
- 当前 `console.*` 调用清单。

### 外部依赖

- [OpenTelemetry logs](https://opentelemetry.io/docs/concepts/signals/logs/)；
- [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/)；
- 不新增 npm package。

### 动作

1. 用 `rg` 生成当前 console 清单并按组件分类：

```bash
rg -n 'console\.(debug|info|log|warn|error)' src --glob '*.ts'
rg -l 'console\.(debug|info|log|warn|error)' src --glob '*.ts' | wc -l
```

2. 写出首个 trace 要回答的问题：阶段、耗时、错误码、取消、降级；
3. 建立禁止字段与允许字段表；
4. 画出当前索引重建实际调用图，标出新旧兼容层；
5. 记录性能预算，例如每个已记录 span 的同步开销、缓冲区上限和导出大小；
6. 在 ADR 中说明为何先做本地薄层，而不是直接接远程 OTel；
7. 给 Sprint PBI 写 Given/When/Then 验收标准。

### 完成 Gate

- [ ] 诊断问题能映射到具体字段或 span；
- [ ] 禁止记录正文、prompt、回答、凭据、绝对路径和默认文件名；
- [ ] 当前调用图确认只有一个 root span 创建位置；
- [ ] 缓冲容量和性能预算有明确数字；
- [ ] 远程传输不在当前 Sprint；
- [ ] 现有基线命令结果已记录。

### 失败处理

- 找不到真实入口：从 UI command/API 逆向跟踪到 `vault-coach-runtime`，先补时序图；
- 当前基线失败：记录完整命令、错误和分支提交，单独判断是否阻塞本 Story；
- 字段是否敏感有争议：默认禁止，只有明确用途和 threat model 后才加入 allowlist。

### 建议提交

```text
docs(observability): define local trace scope and privacy policy
```

## 4. Step 1：实现核心类型、Clock、ID 和安全错误

### 学习目标

用小而稳定的项目接口隔离时间、随机性、第三方 SDK 与敏感异常。

### 内部依赖

- Step 0 的字段策略和 trace 图；
- `src/app/` 的端口命名和导出习惯；
- 当前 TypeScript strict 配置；
- 现有错误/取消识别方式。

### 外部依赖

- Web Crypto `crypto.getRandomValues`，需验证目标 Electron/移动端；
- 必要时以可注入 `IdGenerator` 包装，不直接让业务调用全局；
- 不新增 OTel 依赖。

### 目标文件

```text
src/app/observability/observability-types.ts
src/app/observability/safe-error.ts
src/infrastructure/observability/system-clock.ts
src/infrastructure/observability/random-id-generator.ts
tests/app/observability/safe-error.test.ts
tests/infrastructure/observability/random-id-generator.test.ts
```

### 动作

1. 定义 `TelemetryValue`，禁止任意嵌套对象；
2. 定义只读 `TraceContext`、`LogInput`、`CompletedSpanRecord`；
3. 定义 `Clock.now(): number` 和 `IdGenerator`；
4. 生成 16-byte trace ID 和 8-byte span ID 的小写十六进制表示；
5. 拒绝全零 ID；
6. 实现 `normalizeError(unknown): SafeErrorDescriptor`；
7. 明确 `AbortError`/用户取消不会归类为未知系统错误；
8. 加入 attribute key、value 长度和数组长度限制；
9. 对未知字段采用丢弃或拒绝策略，并写测试固定行为。

### 关键测试

- 相同 fake clock 得到可预测时间；
- fake ID generator 能产生确定 trace 树；
- ID 长度、字符集和非全零检查；
- 异常包含 API key、绝对路径、prompt 时，归一化结果不包含它们；
- `Error`、字符串、对象、`null` 都能安全处理；
- 超长 key/value 被拒绝或截断时有明确 dropped count；
- 取消与 timeout 映射到不同 category。

### 验证命令

```bash
npm test -- tests/app/observability tests/infrastructure/observability
npm run lint
npm run build
```

### 完成 Gate

- [ ] 应用接口不导入任何 `@opentelemetry/*` 类型；
- [ ] 不接受任意 object 作为 attribute；
- [ ] Error 归一化测试包含恶意/敏感字符串；
- [ ] 时间和 ID 可注入、可确定性测试；
- [ ] 取消、超时、验证、存储和未知错误可区分。

### 失败处理

- 目标平台缺少 Web Crypto：通过 adapter 使用 Obsidian/Electron 可用的安全随机源；不能用时间戳或用户信息生成 ID；
- TypeScript 类型过于宽泛：收紧端口，不在 sink 内补救；
- 错误类别不断膨胀：保留少量稳定 category，把模块差异放在 error code。

### 建议提交

```text
feat(observability): add safe telemetry types and identifiers
```

## 5. Step 2：实现有界缓冲与可替换 Sink

### 学习目标

理解容量控制、复制边界、故障隔离和生命周期。

### 内部依赖

- Step 1 类型；
- `src/app/application-container.ts` 的生命周期；
- 现有存储空间 diagnostics 只用于参考，不复用业务存储。

### 外部依赖

- 无生产依赖；
- Vitest fake timers/fixtures 可用于测试。

### 目标文件

```text
src/infrastructure/observability/bounded-diagnostic-buffer.ts
src/infrastructure/observability/console-log-sink.ts
src/infrastructure/observability/composite-sink.ts
tests/infrastructure/observability/bounded-diagnostic-buffer.test.ts
tests/infrastructure/observability/composite-sink.test.ts
```

### 动作

1. 定义 `DiagnosticSink.append(record)` 与 `dispose()`；
2. 实现按记录数和估算字节的双限制 ring buffer；
3. 超限删除最旧记录并增加 `droppedRecordCount`；
4. `snapshot()` 返回副本并按时间稳定排序；
5. `clear()` 只清本 buffer；
6. `dispose()` 后 append 为 no-op；
7. composite sink 逐个调用，单个 sink 抛错不能中断后续 sink 或业务；
8. console sink 只在开发/明确设置启用，并输出已脱敏 record；
9. 防止递归：sink 自己失败时不能再调用同一个 logger。

### 关键测试

- 容量刚好、超出一条、单条超字节预算；
- 覆盖顺序和 dropped count；
- snapshot 修改不影响内部记录；
- clear 不影响传入的领域 store fake；
- 一个 sink 抛错，另一个仍收到记录；
- dispose 可重复调用；
- 大量 append 不出现无界数组增长；
- record 中注入函数/对象时入口拒绝。

### 验证命令

```bash
npm test -- tests/infrastructure/observability
npm run lint
npm run build
```

### 完成 Gate

- [ ] 内存上限可配置但有安全默认值；
- [ ] sink 错误不改变业务返回值；
- [ ] 缓冲清理与领域数据完全分离；
- [ ] snapshot 不泄露可变内部引用；
- [ ] console 输出也经过同一安全模型。

### 失败处理

- 字节估算过于昂贵：采用有上界的近似函数并用基准验证，不在每次 append 深度 stringify；
- record 过大：整条丢弃并计数，不能绕过上限；
- console 影响测试输出：默认使用 no-op sink，由测试显式注入 memory sink。

### 建议提交

```text
feat(observability): add bounded local diagnostic sinks
```

## 6. Step 3：实现 Logger、Tracer 与显式 Context

### 学习目标

理解 parent/child 关系、恰好结束一次和旁路失败隔离。

### 内部依赖

- Step 1 的类型、clock、ID、safe error；
- Step 2 的 sinks；
- 本章定义的 `withSpan` 接口。

### 外部依赖

- [OTel trace concepts](https://opentelemetry.io/docs/concepts/signals/traces/)；
- [OTel Context specification](https://opentelemetry.io/docs/specs/otel/context/)；
- 暂不引入 OTel JS runtime。

### 目标文件

```text
src/app/observability/logger.ts
src/app/observability/tracer.ts
src/infrastructure/observability/local-logger.ts
src/infrastructure/observability/local-tracer.ts
tests/infrastructure/observability/local-tracer.test.ts
tests/infrastructure/observability/local-logger.test.ts
```

### 动作

1. 根 span 生成 trace ID 和 span ID；
2. 子 span 继承 trace ID，生成新 span ID，并记录 parent span ID；
3. `withSpan` 在 `finally` 中结束；
4. 记录 started/ended/duration，负 duration 归零并保留安全诊断；
5. 默认 status=`unset`，outcome 按项目策略初始化并在结束时确定；
6. `recordError` 只接受 `SafeErrorDescriptor`；
7. span 结束后修改 attribute/event 为 no-op 或在开发模式抛出受控错误，团队选定一种并固定测试；
8. 限制每个 span 的 event/attribute 数量；
9. logger 接受可选 context 并写入关联 ID；
10. sink 抛错时 tracer/logger 吞掉基础设施错误，但可增加内部 dropped counter。

### 关键测试

- root/child 共享 trace ID；
- child 的 `parentSpanId` 正确；
- 同级 span ID 不同；
- async `await` 后 context 仍由显式参数保持；
- run 成功、抛错、取消时 span 都只结束一次；
- callback 同步抛错也产生完成 record；
- sink 失败不覆盖原业务异常；
- logger 在活动 span 中带关联 ID；
- 超过 event/attribute 上限时 dropped count 正确；
- no-op 配置不产生业务差异。

### 验证命令

```bash
npm test -- tests/infrastructure/observability/local-tracer.test.ts
npm test -- tests/infrastructure/observability/local-logger.test.ts
npm run lint
npm run build
```

### 完成 Gate

- [ ] 没有全局可变 `currentSpan`；
- [ ] span 在所有控制流中恰好结束一次；
- [ ] sink 故障不改变原异常和返回值；
- [ ] parent/child 与日志关联由测试证明；
- [ ] 记录上限和结束后行为有明确契约。

### 失败处理

- context 在事件回调中丢失：把 context 纳入任务对象或 callback 闭包，不临时使用模块全局变量；
- 双重 end：只暴露 `withSpan`，不让普通调用者拿到 `end()`；
- span 代码挤满业务逻辑：把公共模式提成应用层 helper，但不要隐藏关键 outcome 决策。

### 建议提交

```text
feat(observability): implement local trace and log correlation
```

## 7. Step 4：完成 `index.rebuild` 纵向切片

### 学习目标

在真实用例边界埋点，并保持原有取消、降级和状态通知语义。

### 内部依赖

- Step 3 tracer/logger；
- `src/app/vault-coach-runtime.ts`；
- `src/app/index/knowledge-index-coordinator.ts`；
- 知识库、向量索引、图谱和持久化现有接口；
- `tests/app/vault-coach-runtime.test.ts`；
- `tests/app/index/knowledge-index-coordinator.test.ts`。

### 外部依赖

- 无新增 package；
- 真实 Obsidian 桌面环境用于手工 Gate。

### 目标改动

```text
src/app/application-container.ts
src/app/vault-coach-runtime.ts
src/app/index/knowledge-index-coordinator.ts（只在职责需要时）
tests/app/vault-coach-runtime.test.ts
tests/app/application-integration.test.ts
```

### 动作

1. 在组合根创建 clock、ID、buffer、logger、tracer；
2. 通过依赖对象注入 runtime，不从全局 import singleton；
3. 用户/应用触发重建时创建唯一 root `index.rebuild`；
4. 为扫描、解析、关键词索引、向量、持久化和图谱创建关键 child span；
5. 记录 file/chunk/batch count，禁止路径和内容；
6. 将向量失败后的关键词可用记录为子 span error + root degraded；
7. 将 `AbortSignal` 取消记录为 cancelled，并保持现有 busy state 复位；
8. 未知失败映射稳定 error code，继续按原契约抛出/通知；
9. 保留 `index-state-changed` 作为 UI 失效事件，不向事件载荷塞 trace；
10. 确认兼容层不会重复建 root span。

### 行为矩阵

| 场景 | 根 outcome | 关键子 span | 产品行为 |
| --- | --- | --- | --- |
| 全部成功 | ok | 全部完成 | 索引可用 |
| 用户取消 | cancelled | 活动阶段取消 | busy state 复位 |
| 向量失败、关键词成功 | degraded | vector=error | 关键词检索保持可用 |
| 图谱失败、文本成功 | degraded | graph=error | 文本检索保持可用 |
| 文档扫描致命失败 | error | scan=error | 操作失败并通知用户 |
| sink 失败 | 与无 sink 相同 | 可能 dropped | 产品行为不变 |

### 自动化验证

```bash
npm test -- tests/app/vault-coach-runtime.test.ts
npm test -- tests/app/index/knowledge-index-coordinator.test.ts
npm test -- tests/app/application-integration.test.ts
npm run lint
npm run build
```

### 手工验证

在测试 Vault 中依次执行：

1. 小 Vault 成功重建；
2. 较大 Vault 重建并观察 UI 是否卡顿；
3. 重建中取消；
4. 关闭/破坏 embedding provider，验证关键词降级；
5. 重载插件，确认没有监听器、timer 或 buffer 泄漏；
6. 检查诊断快照不含笔记正文、文件名、绝对路径、API key；
7. 记录 Obsidian、操作系统、Vault 规模和结果，不保存私人内容。

### 完成 Gate

- [ ] 一个操作只有一个 root span；
- [ ] 成功、取消、两种降级和致命失败均有测试；
- [ ] busy state 与应用事件语义不变；
- [ ] sink 失败注入不影响索引结果；
- [ ] 真实 Obsidian 验收通过；
- [ ] 诊断快照隐私检查通过。

### 失败处理

- 行为与旧测试冲突：先确定是遥测侵入控制流还是旧契约缺失，禁止为让测试通过而改变降级；
- UI 卡顿：检查同步序列化、每 chunk span 和 console 输出，减少粒度并批量生成 record；
- 出现重复 root：明确所有权，兼容适配器只传播 context；
- 取消后未结束 span：将 span 生命周期与实际 Promise/AbortSignal 绑定。

### 建议提交

```text
feat(index): trace rebuild stages without user content
```

## 8. Step 5：诊断 API、最小 UI 与手动导出

### 学习目标

让运行证据可用，同时保持只读边界、用户控制和脱敏。

### 内部依赖

- Step 2 buffer snapshot；
- `src/app/application-api.ts`；
- `src/app/vault-coach-application.ts`；
- `src/presentation/` 的 controller/view 模式；
- i18n 与设置页规范。

### 外部依赖

- Obsidian Modal/Setting/Clipboard API；
- 不接入网络和第三方错误上报。

### 目标文件

```text
src/app/observability/diagnostics-reader.ts
src/infrastructure/observability/diagnostic-exporter.ts
src/presentation/observability/diagnostics-controller.ts
src/presentation/observability/diagnostics-modal.ts
tests/presentation/observability/diagnostics-controller.test.ts
```

并更新：

```text
src/app/application-api.ts
src/app/vault-coach-application.ts
src/app/application-container.ts
src/i18n.ts（按当前实际结构）
```

### 动作

1. 应用 API 返回不可变 snapshot，不暴露 sink；
2. 按 trace ID 将 spans 组装成树，孤儿 span 标记为 orphan；
3. UI 显示根操作、开始时间、耗时、outcome 和子阶段；
4. 提供“复制脱敏诊断”和“清除诊断”；
5. 导出前再次执行字段 allowlist 和大小限制；
6. 导出带 schema、插件版本、平台类别，不带 Vault/用户名；
7. 明示诊断仅本地，复制行为由用户触发；
8. 清除前说明只删除诊断记录；
9. 空状态、缓冲溢出和 dropped count 有清楚文案；
10. UI 卸载时清理监听器。

### 关键测试

- parent/child 树顺序稳定；
- orphan/cycle 防御不会无限递归；
- 复制内容二次脱敏；
- 导出大小上限；
- clear 只调用诊断 API；
- clipboard 失败给出可理解反馈；
- modal 关闭后监听器释放。

### 验证命令

```bash
npm test -- tests/presentation/observability
npm test -- tests/app/vault-coach-application.test.ts
npm run lint
npm run build
```

### 完成 Gate

- [ ] UI 只依赖应用 API；
- [ ] 无网络请求；
- [ ] 复制/清除均由用户主动操作；
- [ ] 导出经过二次 allowlist；
- [ ] 清除不影响索引、设置、考试和掌握度；
- [ ] 无 trace、overflow 和 clipboard error 状态均可用。

### 失败处理

- 大 trace 导致 UI 卡顿：分页或只显示最近 root traces，展开时再构建子树；
- 复制内容仍含敏感值：停止交付，补充入口和出口双重测试；
- cycle：视为损坏诊断数据，截断并显示安全错误，不影响插件其他功能。

### 建议提交

```text
feat(observability): expose local sanitized diagnostics
```

## 9. Step 6：按风险渐进迁移 `console.*`

### 学习目标

学习“语义迁移”，避免机械替换字符串。

### 内部依赖

- 已通过真实流程验证的 logger/tracer；
- Step 0 console 清单；
- 各模块现有降级与错误契约。

### 外部依赖

- 无。

### 迁移顺序

1. 模型和远程调用：timeout、fallback、provider 错误；
2. 索引和存储：损坏、恢复、维度不兼容；
3. RAG：vector/keyword/rerank 降级；
4. 考试：生成、验证、评分与自动保存；
5. Presentation：复制、打开来源等 UI 错误；
6. debug 候选统计：决定保留、采样或删除。

### 每个调用点的判断

```text
它回答什么诊断问题？
  ├─ 有持续时间/子步骤？ → span
  ├─ span 内有意义瞬间？ → span event
  ├─ 独立时间点且需要细节？ → structured log
  └─ 无决策价值？ → 删除
```

### 动作

1. 每个 PR 只迁移一个组件；
2. 先写/补失败行为测试，再替换输出；
3. 使用事件目录中的名称和 allowlist；
4. 原异常控制流保持不变；
5. 若调用点在 Domain，优先返回 typed result/diagnostics，由 Application 边界记录；
6. 迁移后用 `rg` 检查剩余 console，并记录允许保留的开发入口；
7. 不设置“一刀切禁止 console”前先完成必要 adapter。

### 每批验证

```bash
rg -n 'console\.(debug|info|log|warn|error)' src --glob '*.ts'
npm run lint
npm test
npm run build
git diff --check
```

### 完成 Gate

- [ ] 每次减少 console 都有语义分类；
- [ ] Domain 未被 logger 反向依赖；
- [ ] 原降级与异常传播不变；
- [ ] 新日志可关联活动 trace；
- [ ] 高频循环没有逐项日志；
- [ ] 事件目录和测试同步。

### 失败处理

- 无法注入 logger：检查是否在正确的应用边界记录，避免扩大依赖；
- 测试依赖 console spy：迁移为 in-memory sink 断言；
- 一个 PR 变得过大：按组件拆分，保留兼容 console 直至下一批。

### 建议提交

```text
refactor(retrieval): migrate fallback logs to structured events
refactor(storage): normalize recovery diagnostics
```

## 10. Step 7：加入架构、性能与 CI Gate

### 学习目标

把设计规范变成自动反馈，同时保留必须人工判断的 Gate。

### 内部依赖

- 完成的端口、adapter 和第一条纵向 trace；
- `tests/architecture/import-boundaries.test.ts`；
- `.github/workflows/`；
- esbuild 的 production 输出。

### 外部依赖

- GitHub Actions 当前 Node/npm 环境；
- 不要求 SaaS 可观测后端。

### 自动化 Gate

1. 架构测试：Domain 不得导入 observability/OTel/Obsidian；
2. 隐私测试：禁止字段、token/path/prompt fixture；
3. 契约测试：context、结束一次、sink 隔离、buffer 上限；
4. 行为测试：成功、取消、降级、失败；
5. build：确认浏览器兼容和 bundle；
6. 体积预算：记录变更前后 `main.js`，异常增长必须解释；
7. 可选 benchmark：固定 N spans/logs，记录 append/snapshot 耗时；
8. `git diff --check`。

### 命令

```bash
npm run lint
npm test
npm run build
git diff --check
wc -c main.js
```

`main.js` 是本地构建验证产物，按仓库规则不提交 Git。

### 人工 Gate

- [ ] Obsidian 桌面成功、取消、降级、失败；
- [ ] 重载/禁用插件后没有活动 timer、listener 或 exporter；
- [ ] 小型与较大测试 Vault 没有可感知卡顿；
- [ ] 导出样本由另一位评审者检查敏感字段；
- [ ] 设置与文档说明默认本地；
- [ ] 移动端若未实测，结论明确标为 pending，不宣称支持。

### 失败处理

- CI 与本地不同：记录 Node/npm、lockfile 和完整命令，先复现环境；
- bundle 明显增长：用 metafile 分析来源，延期非必要 SDK；
- benchmark 波动：固定设备/样本、预热和重复次数，不用一次结果宣称改进；
- 真实 Obsidian 失败但单测通过：以真实环境结论为阻塞，补集成边界测试。

### 建议提交

```text
test(observability): enforce privacy lifecycle and architecture gates
```

## 11. Step 8：可选 OTel Adapter 与远程传播

本步骤属于后续 Epic，不能与本地基础一起默认发布。

### 启动前 Gate

- [ ] 本地 trace 已证明能回答真实诊断问题；
- [ ] 需要跨 Vault Coach 与 Knowledge Engine 关联的用例明确；
- [ ] 用户价值大于网络、隐私、体积和运维成本；
- [ ] endpoint、保留期、删除、访问控制和数据处理者明确；
- [ ] 用户显式 opt-in；
- [ ] Lite/离线能力在 exporter 缺失时完整可用。

### 内部依赖

- 稳定的项目 tracer/logger 端口；
- Knowledge Engine 协议和可信 loopback/remote 配置；
- 设置迁移、权限披露和诊断 UI；
- 本地 fallback 与 exporter 熔断。

### 外部依赖

- 与当前版本匹配的 OpenTelemetry JS packages；
- 可选 OTel Collector/OTLP endpoint；
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)；
- 许可证、供应链和 bundle 审查。

### 动作

1. 在 spike 分支验证 OTel JS 与 esbuild、Electron 和移动端；
2. 只在 Infrastructure 实现 adapter；
3. 项目接口到 OTel 类型做单向映射；
4. 对可信 Knowledge Engine 请求注入 `traceparent`；
5. 对任意 LLM endpoint 默认不注入；
6. 拒绝/清理非法入站 header；
7. exporter 使用批量、容量、超时、重试和熔断上限；
8. 网络失败不阻塞模型、检索或索引；
9. 设置页显示发送字段、目标、开关和清除/停止方式；
10. 做端到端 trace 相关性与隐私渗透测试。

### 完成 Gate

- [ ] 无 opt-in 时零远程遥测请求；
- [ ] 关闭后立即停止新导出；
- [ ] exporter 不包含正文、prompt、回答、凭据、路径；
- [ ] 不可信 endpoint 不接收 trace header；
- [ ] Collector 不可用时核心功能正常；
- [ ] bundle、启动和内存预算通过；
- [ ] 文档披露与实际行为一致。

### 失败处理

- OTel 包体/兼容性超预算：保持项目内本地实现，远程 tracing 放到独立 Knowledge Engine/Connector；
- context manager 在 Obsidian 丢上下文：继续显式传播，不用全局补丁掩盖；
- Collector 重试造成资源压力：熔断并丢弃遥测，绝不阻塞产品主流程；
- 隐私 Gate 失败：NO-GO，关闭 exporter 并保留本地能力。

## 12. 最终回归矩阵

| 维度 | 场景 | 自动化 | 手工 |
| --- | --- | ---: | ---: |
| Trace | root/child/sibling | ✅ | 抽查 |
| 生命周期 | success/error/cancel/throw | ✅ | ✅ |
| 降级 | vector→keyword、graph failure | ✅ | ✅ |
| 隐私 | token/path/prompt/content fixtures | ✅ | 导出复核 |
| 容量 | count/bytes/event/attribute limits | ✅ | 大 Vault |
| Sink | throw/dispose/clear | ✅ | reload/unload |
| UI | empty/tree/copy/clear/overflow | ✅ | ✅ |
| 架构 | import boundaries | ✅ | PR review |
| 构建 | TypeScript/esbuild/bundle size | ✅ | Obsidian load |
| 远程 | opt-in/trust/offline | 后续 | 后续 |

## 13. Sprint Review 证据包

Review 前准备：

```text
Sprint Goal
验收标准逐项结果
架构图与接口
成功 trace 样本
取消 trace 样本
降级 trace 样本
脱敏导出样本
测试/lint/build 结果
真实 Obsidian 环境与步骤
bundle/性能基线
已知限制与下一 Backlog 建议
```

Review 展示运行软件，不只展示文档或测试截图。

## 14. Definition of Done 增补

- [ ] 完成 Step 0–7 的适用 Gate；
- [ ] 事件目录与实际字段一致；
- [ ] 所有 context/record 类型有稳定 schema；
- [ ] sink 故障、取消和卸载已验证；
- [ ] 隐私入口与导出双层检查通过；
- [ ] 真实 Obsidian 证据已记录；
- [ ] 文档更新并链接到 PR；
- [ ] 未实现远程 tracing 时明确标记，不暗示已经可用；
- [ ] Review 反馈进入 Product Backlog；
- [ ] Retrospective 只承诺少量可验证改进。

下一章：[[08-团队协作模板与新人训练]]
