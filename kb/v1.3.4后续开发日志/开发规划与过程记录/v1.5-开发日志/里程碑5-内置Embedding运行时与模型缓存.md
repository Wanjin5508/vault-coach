---
tags: [VaultCoach, v1.5, 里程碑5, TransformersJS, 模型缓存]
status: planned
updated: 2026-10-09
depends-on: [里程碑4-内置Embedding技术验证与多语言基准.md]
entry-condition: M4-GO
---

# 里程碑 5：内置 Embedding 运行时与模型缓存

## 1. 目标

根据 M4 的 GO 决策实现正式 builtin provider：固定模型与 revision、显式首次下载、可检查和清除的本地缓存、WebGPU 优化、WASM 回退、离线暖启动，并接入 M3 的 provider port 与 fingerprint。

本阶段先允许后台/开发开关启用；在 M6 完成 Worker 化、M8 完成升级策略前，不把它对所有用户强制设为默认。

## 2. 用户与隐私契约

1. 首次模型下载由可见动作触发，显示来源、预计大小、真实进度和取消；
2. 下载的是模型权重/运行时资产，不上传用户笔记；
3. builtin embedding 在本机生成向量；
4. 聊天 LLM 仍可能接收检索到的上下文，设置页需单独说明；
5. 断网且缓存完整时可使用；缓存不完整时给出恢复动作；
6. 清除本地模型后，keyword 保持可用；
7. builtin 失败时不自动把笔记发给远程 embedding provider；
8. 外部模型 URL、revision、许可和隐私声明进入发布文档。

## 3. 涉及文件与正式模块建议

| 文件/模块 | 职责 |
| --- | --- |
| `src/infrastructure/embedding/builtin-transformers-embedding-provider.ts` | 实现 M3 port，不包含 UI |
| `src/infrastructure/embedding/builtin-model-loader.ts` | pipeline 创建、revision/dtype/device/fallback |
| `src/infrastructure/embedding/builtin-model-cache.ts` | cache inspect、clear、完整性与存储占用 |
| `src/infrastructure/embedding/builtin-model-policy.ts` | 固定 model/revision/pooling/normalize/preprocessing |
| `src/app/embedding/embedding-runtime-service.ts` | prepare/status/cancel/clear 用例 |
| `src/app/embedding/embedding-runtime-types.ts` | 状态、进度、错误码 |
| `src/app/application-container.ts` | 装配 builtin adapter 与 router |
| `src/app/application-api.ts` | 扩展现有 API，暴露只读状态和用户动作 |
| `src/app/config/settings-types.ts` | provider union 增加 `builtin`，默认翻转留到 M8 |
| `src/presentation/settings/sections/embedding-status-settings.ts` | 状态、下载、重试、清除 |
| `src/i18n.ts`、`styles.css` | 用户文案与状态样式 |
| `tests/infrastructure/embedding/*` | fake loader/cache 测试 |
| `tests/app/embedding/*` | 状态机与恢复测试 |

不要让 UI 直接 import `@huggingface/transformers`，也不要让 provider 直接创建 Obsidian Notice。

## 4. 固定模型策略

用不可变配置表达 M4 结果：

```ts
interface BuiltinModelPolicy {
  modelId: string;
  revision: string;
  dtype: string;
  dimension: number;
  pooling: "mean" | "cls";
  normalize: boolean;
  documentPrefix: string;
  queryPrefix: string;
  implementationVersion: number;
}
```

- revision 不使用 `main` 或 `latest`；
- model policy 修改必须触发 fingerprint 变化和重建；
- query 与 document 预处理分开测试；
- 输出复制为受控 `Float32Array`，拒绝 NaN/Infinity/错误维数；
- 第三方库返回的 tensor 生命周期及时释放；
- package 使用确切 lockfile，不在运行时拉取 JavaScript 代码。

## 5. 状态机

```text
not-installed
    │ prepare
    ▼
downloading ──cancel──► not-installed / partial
    │ complete
    ▼
loading ──WebGPU fails──► loading-wasm
    │                         │
    └──────── ready ◄─────────┘
              │ clear
              ▼
         not-installed

任一阶段错误 -> error(code, recoverable, action)
```

状态对象应含：model fingerprint、cached/total bytes、device、phase、可否取消、可否重试、脱敏错误码。不要用一个 `isReady` 布尔值承载全部信息。

## 6. 缓存设计

Transformers.js 支持浏览器缓存与 custom cache。为满足“查看/清除/验证”，优先使用可命名、可列举的 custom Cache API namespace；最终方案以 M4 spike 为准。

缓存规则：

1. namespace 包含插件、模型和 schema version；
2. 只把 marker 当提示，实际 readiness 要检查所需资源；
3. 下载成功后再写 complete manifest；
4. 下载中断的 partial 条目可清理或安全续传；
5. 清除只删除 Vault Coach 的目标模型，不清空整个 origin；
6. 清除后释放 pipeline/Worker，再删 cache，避免句柄继续占用；
7. `navigator.storage.estimate()` 仅作估计，UI 文案不可声称精确；
8. Cache 被系统驱逐后回到 `not-installed`，不循环报错。

模型 cache 与知识库索引是两种存储。清模型不必删除文字索引；向量索引因 provider 不可用标记 unavailable，重新安装相同 fingerprint 后可复用或按验证策略重建。

## 7. 设备选择与回退

建议流程：

1. 用户配置允许且运行时报告 WebGPU 能力时尝试 WebGPU；
2. 做一次最小 warm-up 并验证输出；
3. 初始化或运行失败时销毁该 pipeline；
4. 用 WASM 重试一次；
5. 记录 `requestedDevice`、`actualDevice`、`fallbackReason`；
6. WASM 也失败时返回结构化错误，由 auto 检索使用 keyword。

不要把 WebGPU API 存在当作运行成功。避免无限重试和每次 query 重建 pipeline。

## 8. 手动实施步骤

### Step 1：按 M4 ADR 固定依赖与 policy

安装依赖后检查 lockfile diff、许可证、main.js 增量和 transitive dependencies。把模型配置集中在一个只读模块，并建立 fingerprint snapshot test。

### Step 2：先实现 loader facade

用接口包住 Transformers.js 动态/静态 import，使 unit tests 注入 fake loader。loader 负责 progress callback 转换、pipeline 创建、dispose；provider 不解析第三方事件细节。

### Step 3：实现 cache adapter

用 fake CacheStorage 完成 inspect/clear/partial/error 测试，再接真实 Cache API。明确 Obsidian desktop/mobile 上 cache key 和 origin 行为。

### Step 4：实现 runtime service 状态机

保证同一时刻只有一个 prepare：重复点击返回同一任务或明确 busy。每次任务有 job ID；取消、过期 callback 和页面重建不能把旧任务写回 ready。

### Step 5：实现 provider

provider 调用已准备的 runtime；若未准备，返回 `not-ready`，不能在一次普通 Ask 中暗中下载。embedding batch 前后验证维数、有限数和 fingerprint。

### Step 6：接入 Application API 与设置状态卡

UI 只调用 `prepareBuiltinEmbedding`、`cancel`、`clearCache`、`getStatus/subscribe`。清除是破坏本地缓存的用户动作，需明确显示影响并避免误触；执行完成后给出可验证结果。

### Step 7：做真实 Obsidian 手工验证

在干净 Vault 依次验证：首次下载、取消、重试、暖启动、断网、清缓存、WebGPU 失败、WASM、插件卸载/重载。

## 9. 测试与故障注入

### 自动测试

- 状态转换及非法转换；
- 并发 prepare 去重；
- 旧 job 的进度/结果被忽略；
- cache complete/partial/missing/corrupt；
- WebGPU 失败后只回退一次；
- WASM 失败返回可恢复错误；
- clear 只删除目标 namespace；
- query/document prefix 和 fingerprint；
- NaN、维数错误拒绝落盘；
- dispose 后不接受新任务。

### 手工故障注入

1. 下载到一半断网并重启 Obsidian；
2. 删除 cache 中一个文件但保留 manifest；
3. mock WebGPU device lost；
4. 将存储配额降到不足；
5. 下载时关闭 View/卸载插件；
6. 缓存完成后断网重启；
7. 清除缓存后检查 Storage 与状态。

记录“如何判断成功”，不能只写“没有报错”。

## 10. 工程实践与原因

- 显式 prepare 将大下载从隐式 Ask 路径移开；
- loader/cache/provider 分开，便于用 fake 验证并隔离第三方 API；
- immutable revision 保证结果可复现；
- 单一 runtime 实例避免重复模型占用内存；
- structured error 让 UI、fallback 和诊断共享事实；
- complete manifest 加资源探测避免缓存假阳性；
- builtin 失败只降级本地检索，遵守数据不被静默外发的边界。

## 11. 完成标准

- [ ] 依赖与模型 revision 固定，许可证已记录；
- [ ] 首次下载有真实进度、取消、重试和明确来源；
- [ ] 暖启动离线可用；
- [ ] WebGPU 失败可验证地回退 WASM；
- [ ] cache 状态可检查，清除范围准确；
- [ ] 输出满足 M3 contract 与 fingerprint；
- [ ] 未准备的 Ask 不触发隐藏下载；
- [ ] 单测使用 fake，不在普通 CI 下载真实模型；
- [ ] Desktop 实机矩阵通过，Mobile 结果记录给 M8；
- [ ] 功能仍受 flag/设置控制，等待 M6 与 M8。

## 12. 实施记录

```text
Transformers.js 版本：
Model/revision/license：
Fingerprint：
main.js 体积变化：
冷/暖启动：
Cache namespace：
Desktop/Mobile 结果：
故障注入：
未解决风险：
```
