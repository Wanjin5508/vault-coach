---
tags:
  - 开发过程
  - VaultCoach
  - v1.3.4
  - 里程碑2
  - KnowledgeGraph
  - 确定性图谱
  - 开发计划
status: in_review
branch: feature/kg-mvp
depends-on:
  - 里程碑1-结构化考试证据开发日志.md
source-plan: /Users/wanjinli/code/obsidian_plugin/tech-docs/v1.3.4 重构与开发/v1.3.4 后续规划.md
---

# 里程碑 2：确定性知识图谱 MVP 开发日志

## 1. 文档目的

本文把《v1.3.4 后续规划》中的“里程碑 2：确定性知识图谱 MVP”拆分为可逐项开发、审查、测试和提交的实施日志。

本里程碑的唯一目标是：**在完全不调用 LLM 的条件下，把当前已索引的 Vault 文档转换为可持久化、可查询、可全量重建且可按文件增量维护的*结构图谱*。**

完成后，图谱只表达 Vault 中**可客观读取的结构事实**：Document、Section、Tag，以及 `contains`、`links_to`、`embeds`、`tagged_with` 四类边。它是后续语义 Concept、掌握度、Progress 和图谱 UI 的数据底座，不是可视化功能的提前实现。

## 2. 当前基线与前置条件

盘点日期：2026-07-20。

```text
分支：refactor
基线提交：5870c03
里程碑 0：已完成
里程碑 1：已完成（结构化 Assessment Session 与 Markdown 投影）
```

当前已经具备下列可复用边界：

| 位置                                                                | 当前职责                                                                                 | 里程碑 2 如何使用                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `src/domain/documents/document-types.ts`                          | `IndexedChunk`、`KnowledgeBaseFileRecord`、`KnowledgeBaseSyncResult`、`DocumentLocator` | 图谱的文档、Section、Chunk 来源事实；不可复制为第二套索引      |
| `src/knowledge-base.ts`                                           | 全量索引与 `syncChangedFiles()`；按文件给出 changed/removed chunk                               | 图谱只消费其成功后的当前索引快照与文件变更结果                  |
| `src/app/vault-coach-runtime.ts`                                  | 索引重建、自动增量同步、删除/重命名路径事件、取消与持久化编排                                                      | 在索引成功后触发图谱全量重建或文件级同步                     |
| `src/vault-coach-plugin.ts`                                       | 注册 Vault create/modify/delete/rename 事件                                              | 保持薄适配器；只继续把事件交给 runtime，不在此解析图谱          |
| `src/app/application-container.ts`                                | Composition Root                                                                     | 创建图谱 Reader、Store、Builder、查询服务与协调器       |
| `src/app/vault-coach-application.ts`、`src/app/application-api.ts` | Presentation 可访问的应用层 Facade                                                          | 增加内部 `graph` 分组；现有 Ask/Exam/Index 接口不改语义 |
| `src/domain/assessment/*`                                         | 不可变 Assessment Event 与 provisional Concept binding                                   | 本阶段不读取、不改写事件；为里程碑 3/4 保留并列边界             |
| `.vault-coach/assessments/`                                       | 考试事实源                                                                                | 永远排除在图谱输入之外                              |

当前索引的关键时序：

```text
Vault 文件事件
  → VaultCoachRuntime 收集路径
  → VaultKnowledgeBase.syncChangedFiles()
  → KnowledgeBaseSyncResult
  → RAG 向量索引同步
  → 保存知识索引快照
```

里程碑 2 在“文本索引成功”之后增加图谱工作；图谱绝不能反向影响 RAG、题目生成、考试评分或 Assessment 事实。

开始每一个步骤前必须确认：

- [ ] 工作区没有与本步骤无关的未提交改动，或已明确隔离；
- [ ] 上一步已由维护者审查、手动测试、提交并合并；
- [ ] 当前基线的 `npm run build`、`npm run lint`、`npm test` 均通过；
- [ ] 不修改插件 ID、命令 ID、既有设置键、View Type、Exam/Assessment JSON schema 和现有索引快照 schema；
- [ ] 不把 Vault 运行数据、`main.js`、`node_modules` 或 `.vault-coach/` 提交到仓库。

## 3. 范围与非范围

### 3.1 必须完成

1. 定义领域 `GraphStore`、版本化图谱快照、节点、边、来源和查询契约；
2. 从现有已索引文件构建 Document、Section、Tag **节点**；
3. 使用 Obsidian metadata cache 与索引元数据读取双链、Embed、Tag、标题层级和 PDF 页级逻辑区段；
4. 构建并稳定去重 `contains`、`links_to`、`embeds`、`tagged_with`；
5. 将结构事实保存为 `.vault-coach/graph/graph-snapshot-v1.json`，并具备临时文件恢复与 schema 校验；
6. 在现有“重建索引”成功后完成图谱全量重建；
7. 在现有自动索引同步中只重算受影响文件，并正确处理创建、修改、删除、移出索引范围和重命名；
8. 提供节点、边和来源查询，以及可自动执行的完整性检查；
9. 用固定 fixture 和 golden snapshot 证明同一 Vault 的图谱语义输出确定；
10. 保持 Ask、Exam、历史、Assessment JSON、向量索引、设置和现有索引按钮的用户行为不变。

### 3.2 明确不做

- 不创建 `ConceptNode`，不解析 provisional topic binding，不做 Concept 映射、Alias 合并或概念编辑；
- 不调用聊天模型、Embedding、重排、网络服务或 `LocalModelClient`；
- 不实现 `mentions`、`same_as`、`related_to`、`prerequisite_of`、`part_of`、`contrasts_with`、`used_for` 等语义边；
- 不实现**掌握度计算**、Progress *Dashboard*、复习计划、自适应考试或图谱可视化库；
- 不增加图谱 Tab、图谱画布、节点点击 UI、布局算法或布局状态文件；
- 不扫描或纳入 `.vault-coach/`、`.obsidian/`、隐藏文件、超出当前知识范围的文件，且不为外部/缺失链接创建悬空节点；
- 不更改 Markdown 的链接语义、重命名行为、知识范围过滤、自动索引防抖参数或向量检索逻辑；
- 不把图谱快照塞入 `runtime-state.json`、知识索引快照或 Assessment Session JSON；
- 不将 `domain/graph/**` 绑定到 Obsidian、DOM、文件系统、设置页或任何具体模型实现。

## 4. MVP 的结构语义与确定性规则

### 4.1 图谱边界

图谱输入只来自当前 `VaultKnowledgeBase` 已接纳的文件记录、Chunk 和 Obsidian 本地 metadata cache：

```text
当前知识范围内的文件
  ├─ KnowledgeBaseFileRecord / IndexedChunk
  ├─ metadataCache.resolvedLinks 与 file cache links
  ├─ file cache embeds
  ├─ file cache tags 与 frontmatter tags
  └─ Markdown headings / PDF 页级 Chunk
        ↓
确定性 GraphSourceDocument[]
        ↓
纯 DeterministicGraphBuilder
        ↓
GraphSnapshotV1
```

MVP 的关系粒度固定如下，防止在没有产品需求前把 Section 链接或推断关系混入结构事实：

| 类型 | 起点 | 终点 | 来源 | 规则 |
|---|---|---|---|---|
| `contains` | Document 或父 Section | Section | Markdown heading hierarchy、PDF 页级区段 | Document 包含根 Section；有可表示的父标题时父 Section 包含子 Section |
| `links_to` | Document | Document | 普通 Obsidian 双链/Markdown link | 仅当目标解析为当前知识范围内的文档时创建 |
| `embeds` | Document | Document | `![[...]]` 或 Markdown embed | 与普通链接是不同边；同一对文档可同时拥有两类边 |
| `tagged_with` | Document | Tag | inline tag 与 frontmatter tag | 多处相同 tag 只产生一条边，但保留全部来源位置 |

Document 与 Section 的来源都能回查至 `documentId`、`filePath`、`headingPath`、`chunkIds` 和 `DocumentLocator`。链接、Embed、Tag 边还要保留来源文件、来源类型、可获得时的缓存位置与相关 Chunk ID。这样后续 UI 不必重新解析 Vault 才能解释一条边为何存在。

### 4.2 稳定 ID、排序和去重

所有 ID 和快照排序必须是纯函数；不得用 `Date.now()`、随机数、读取顺序或 Map 遍历顺序生成图谱事实。

| 对象       | ID 规则                                                                    | 备注                                              |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Document | 复用现有 `KnowledgeBaseFileRecord.documentId`，例如 `markdown:notes/a.md`       | 当前文档 ID 已以规范化 Vault 相对路径为基础                     |
| Section  | `section:<documentId>:<stableHash(normalized headingPath + occurrence)>` | `occurrence` 是同一路径重复标题的零基顺序，避免标题重复碰撞            |
| Tag      | `tag:<normalizedTag>`                                                    | 去掉前缀 `#`，Unicode NFC、trim、压缩路径分隔符并小写；显示名使用规范化名称 |
| Edge     | `edge:<type>:<sourceNodeId>:<targetNodeId>`                              | 同类型、同起终点聚合为一条边，来源数组去重并排序                        |

写入快照前必须按 `id` 排序 nodes、edges 和每条 edge 的来源；对象字段使用固定 schema 顺序。快照不得写入“本次构建时间”一类运行时字段。文件的 `modifiedAt`、`contentHash` 和边的来源位置属于输入事实，可以保存。

因此“相同 Vault 重建结果确定”定义为：在相同的文件内容、路径、文件元数据和 metadata cache 解析结果下，`GraphSnapshotV1` 序列化后的 nodes、edges、来源和统计结果字节一致。运行时状态如最后执行时间只允许留在内存状态中，不能污染 snapshot。

### 4.3 链接解析与排除规则

1. Obsidian Reader 必须通过 metadata cache 解析 *link target*；不可把原始 `[[alias]]` 文本直接当作文件路径；
2. `links_to` 读取普通 links，`embeds` 读取 embed cache。`resolvedLinks` 用于目标解析/校验和回退，不得把 Embed 误写成普通 link；
3. 目标文件不在当前 `KnowledgeBaseFileRecord[]` 中时跳过此边，不创建“未知文档”节点；
4. `contains` 建立时应表示所有可读取标题。对于无正文的标题，Reader 仍需从 headings 产生 Section，不能仅依赖有 Chunk 的段落；
5. Markdown 文档的无标题正文建立一个 `headingPath: []` 的根 Section；PDF 每个有 Chunk 的页级逻辑区段建立一个 Section；
6. 重复、大小写不同、inline 与 frontmatter 重复的 tag 都归并到同一个规范化 Tag 节点；
7. `VAULT_COACH_HIDDEN_DIR_PATH` 下的所有路径在 Reader 的入口被拒绝；即使 metadata cache 仍有旧记录，也不得进入 nodes、edges 或来源；
8. 图谱来源不读取用户笔记正文以外的数据，也不向模型或开发者服务器发送内容。

### 4.4 文件变更、删除和重命名语义

全量重建用于显式“重建索引”和首次建立图谱；它不是文件变化后的默认路径。增量更新对每个 `affectedFiles` 只重新读取该文件的图谱来源，然后在内存 snapshot 中替换该文件贡献的节点和边，最后一次性**持久化整**个新的快照。**增量计算是文件级的，写入完整 snapshot 是 MVP 的恢复与一致性策略。**

| 文件事件 | 图谱操作 | 完成后的要求 |
|---|---|---|
| create / modify | 删除该 source file 旧贡献，读取当前图谱来源并重新构建该文件贡献 | 不影响无关文件的节点和边 |
| delete / 移出知识范围 | 删除该 Document、其 Sections、其发出和指向它的所有边 | 不遗留悬空边、Tag 孤儿可一并清理 |
| rename | 删除旧 source path 的本体贡献，建立新 path 的 Document/Section/发出边；将仍有效的入边目标从旧 Document 迁移到新 Document，再用当前 metadata 复核受影响文件 | 快照中无旧路径，无悬空关系；现有关系指向新文档 |
| hidden `.vault-coach` 写入 | 忽略 | 图谱自身写入不得触发递归同步 |

为实现重命名迁移，runtime 除了给文本索引传入旧/新路径，还必须保留成对的 `GraphRename` 记录。不能只依赖两个无关联字符串，否则无法安全迁移其他文档指向被重命名目标的边。

## 5. 目标架构与依赖规则

完成后形成下列最小结构。文件名可以随现有项目命名微调，但职责和依赖方向不得改变。

```text
src/
├── domain/
│   └── graph/
│       ├── graph-types.ts                 # Node、Edge、Snapshot、Source、查询/校验结果
│       ├── graph-store.ts                 # GraphStore 端口
│       ├── graph-id.ts                    # 纯规范化、稳定 ID、排序/去重 helper
│       ├── deterministic-graph-builder.ts # 纯 GraphSource → GraphSnapshot 构建器
│       ├── graph-query-service.ts         # 纯 Snapshot 查询
│       └── graph-integrity-service.ts     # 纯不变式检查
├── app/
│   ├── graph/
│   │   └── knowledge-graph-service.ts     # 全量/增量/rename 编排，维护内存 snapshot
│   ├── application-api.ts
│   ├── application-container.ts
│   ├── vault-coach-application.ts
│   └── vault-coach-runtime.ts
├── infrastructure/
│   ├── obsidian/
│   │   └── obsidian-graph-source-reader.ts # App、metadataCache、TFile → GraphSourceDocument
│   └── storage/
│       └── json-graph-store.ts             # VaultAdapter → graph-snapshot-v1.json
└── constants.ts
```

依赖方向：

```text
VaultCoachPlugin（仅转发 Vault path 事件）
              │
              ▼
VaultCoachRuntime（索引完成后选择 full / incremental graph sync）
              │
              ▼
VaultCoachApplication.graph（Facade，不暴露 Obsidian 对象）
              │
              ▼
KnowledgeGraphService（应用层编排）
    ┌─────────┴───────────┐
    ▼                     ▼
domain/graph          GraphStore port
(builder/query/check)       ▲
    ▲                        │ implements
    │                        │
ObsidianGraphSourceReader   JsonGraphStore
```

强制规则：

- `domain/graph/**` 是纯 TypeScript：不导入 `obsidian`、`App`、`VaultAdapter`、DOM、模型、RAG、Exam 或 Presentation；
- `ObsidianGraphSourceReader` 是唯一可读取 `metadataCache`、`TFile`、`resolvedLinks`、file cache 和 Obsidian path API 的图谱模块；
- `JsonGraphStore` 是唯一可接触图谱文件路径、VaultAdapter、临时文件和 JSON I/O 的模块；
- `DeterministicGraphBuilder` 只接收已规范化的 `GraphSourceDocument[]`，不读文件、不读时钟、不请求模型；
- `KnowledgeGraphService` 只编排“读来源 → 纯构建/替换 → 完整性校验 → 保存”；它不更新向量、不修改文本索引；
- `VaultCoachRuntime` 只在 `KnowledgeBaseSyncResult` 成功后调用图谱服务。图谱失败不得把已成功的文本索引回滚或清空；同时必须标记图谱为 dirty，禁止继续把旧快照当作最新图谱；
- `VaultCoachApplication` 提供图谱用例，Presentation 未来只能经由该 facade 调用，不能直接访问 `GraphStore`；
- M2 不在 `LegacyPluginApiAdapter`、`ExamController`、`ChatController` 或现有 View 中增加图谱专用调用。

## 6. 数据契约

### 6.1 图谱节点与边

在 `src/domain/graph/graph-types.ts` 定义以下最小可扩展契约。这里的 `KnowledgeGraphNode` 不包含 Concept，Concept 必须等里程碑 3 单独扩展为兼容 schema。

```ts
export type DeterministicKnowledgeNodeType = "document" | "section" | "tag";
export type DeterministicKnowledgeEdgeType =
    | "contains"
    | "links_to"
    | "embeds"
    | "tagged_with";

export interface DocumentGraphNode {
    id: string;
    type: "document";
    documentId: string;
    filePath: string;
    documentType: KnowledgeDocumentType;
    title: string;
    contentHash: string;
    modifiedAt: number | null;
}

export interface SectionGraphNode {
    id: string;
    type: "section";
    documentId: string;
    filePath: string;
    headingPath: string[];
    occurrence: number;
    chunkIds: string[];
    locator: DocumentLocator;
}

export interface TagGraphNode {
    id: string;
    type: "tag";
    normalizedName: string;
    displayName: string;
}

export type KnowledgeGraphNode =
    | DocumentGraphNode
    | SectionGraphNode
    | TagGraphNode;
```

边的来源必须是结构化数据，不能只记录一个给人看的说明字符串：

```ts
export type GraphEdgeOrigin =
    | "heading-structure"
    | "obsidian-link"
    | "obsidian-embed"
    | "obsidian-tag";

export interface GraphSourceLocation {
    sourceFilePath: string;
    sourceDocumentId: string;
    sourceKind: GraphEdgeOrigin;
    targetFilePath?: string;
    chunkIds: string[];
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

export interface KnowledgeGraphEdge {
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    type: DeterministicKnowledgeEdgeType;
    confidence: number;
    origin: GraphEdgeOrigin;
    sources: GraphSourceLocation[];
}
```

默认可信度必须是常量并写入测试：Markdown 标题层级 `0.90`、双链 `0.95`、Embed `0.90`、Tag `0.80`。同一 edge 的多个来源必须有相同的 `origin`；若同一对节点存在不同结构关系，应保存为不同 `type` 的 edge，而不是取最高置信度合并。

### 6.2 图谱来源输入、快照和 Store 端口

Reader 向领域层传递的输入必须脱离 Obsidian 类型。建议定义 `GraphSourceDocument`、`GraphSourceSection`、`GraphSourceReference` 和 `GraphSourceTag`；其字段足以构建第 6.1 节对象，但不包含 `TFile`、`CachedMetadata` 或其他 host 对象。

```ts
export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface GraphSnapshotV1 {
    schemaVersion: 1;
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
    stats: {
        documentCount: number;
        sectionCount: number;
        tagCount: number;
        edgeCount: number;
    };
}

export interface GraphStore {
    load(): Promise<GraphSnapshotV1 | null>;
    save(snapshot: GraphSnapshotV1): Promise<void>;
    clear(): Promise<void>;
}
```

快照是 M2 图谱事实源；它可以由当前 Vault 完全重建。它不属于 runtime state，不与 `.vault-coach/assessments/**` 共用 index，也不保存 UI layout。布局、语义抽取缓存与用户确认关系分别留给后续里程碑的独立 schema。

存储路径固定为：

```text
.vault-coach/
└── graph/
    └── graph-snapshot-v1.json
```

在 `src/constants.ts` 新增 `GRAPH_DIR_PATH` 和 `GRAPH_SNAPSHOT_PATH`，并从 `VAULT_COACH_HIDDEN_DIR_PATH` 派生。不得把字符串散落在 Reader、Store、runtime 或测试中。

### 6.3 查询与完整性契约

图谱查询须针对加载后的 snapshot 纯执行；MVP 不引入数据库或图查询语言。至少提供：

```ts
export interface GraphQueryService {
    getNode(snapshot: GraphSnapshotV1, nodeId: string): KnowledgeGraphNode | null;
    findNodesByDocumentPath(snapshot: GraphSnapshotV1, filePath: string): KnowledgeGraphNode[];
    findEdgesForNode(snapshot: GraphSnapshotV1, nodeId: string): KnowledgeGraphEdge[];
    findEdgesBySourceFile(snapshot: GraphSnapshotV1, filePath: string): KnowledgeGraphEdge[];
    getEdgeSources(snapshot: GraphSnapshotV1, edgeId: string): GraphSourceLocation[];
}
```

完整性检查返回诊断而不是静默修复：

```ts
export interface GraphIntegrityIssue {
    code:
        | "unsupported-schema"
        | "duplicate-node-id"
        | "duplicate-edge-id"
        | "missing-edge-endpoint"
        | "invalid-edge-shape"
        | "invalid-source"
        | "invalid-section-owner"
        | "invalid-snapshot-stats"
        | "hidden-path-leak"
        | "non-canonical-id"
        | "unsorted-snapshot";
    message: string;
    nodeId?: string;
    edgeId?: string;
}

export interface GraphIntegrityReport {
    valid: boolean;
    issues: GraphIntegrityIssue[];
}
```

`JsonGraphStore.save()` 和 `KnowledgeGraphService` 都必须在写入前验证；验证不通过时拒绝覆盖最后一份有效快照。加载到损坏或未知 schema 时，保留原始文件、报告可诊断错误，并将图谱标记为需全量重建。

### 6.4 应用层 API

在 `src/app/application-api.ts` 增加一个独立的 `GraphApplicationApi`，再挂到 `VaultCoachApplicationApi.graph`。M2 没有 UI 消费者，但必须先确立唯一入口，避免未来 View 直接耦合 Store。

```ts
export interface GraphApplicationApi {
    rebuild(signal?: AbortSignal): Promise<GraphSnapshotV1>;
    getSnapshot(): Promise<GraphSnapshotV1 | null>;
    getNode(nodeId: string): Promise<KnowledgeGraphNode | null>;
    findEdgesForNode(nodeId: string): Promise<KnowledgeGraphEdge[]>;
    getEdgeSources(edgeId: string): Promise<GraphSourceLocation[]>;
    checkIntegrity(): Promise<GraphIntegrityReport>;
}
```

此 API 不暴露 `App`、`TFile`、VaultAdapter、Graph Builder、GraphStore 或内部 mutable array。M2 不需要把它接入任何现有按钮、命令、Legacy API 或 Progress tab。

## 7. 推荐提交顺序与逐步开发日志

每一步完成后必须暂停。维护者先审查代码、执行本步骤的自动化和手动测试、提交并合并；确认后才开始下一步。一个提交只解决一个可回滚的目标，不能把 schema、全量构建、增量/rename 和 UI 混在一起。

### 步骤 1：冻结当前索引行为并准备确定性图谱 fixture

状态：`[x] 已开发，待维护者验证`

目标：在改动生产代码前固定 M2 所依赖的索引/事件语义，并建立可复用的本地 Vault fixture。

修改位置：

- 新建 `tests/fixtures/vault-graph/basic/`：两份 Markdown 文档、标题层级、普通双链、Embed、inline tag、frontmatter tag 和无标题正文；
- 新建 `tests/fixtures/vault-graph/rename/`：指向将被重命名文档的 links/embeds；
- 新建 `tests/fixtures/vault-graph/pdf/`：使用已规范化的 PDF `IndexedChunk` fixture，不要求在单元测试中加载真实 PDF；
- 新建 `tests/fixtures/vault-graph/expected-graph-v1.json`：只放稳定的 semantic snapshot，不放运行时间；
- 扩展 `tests/document-index-reader.test.ts` 或新增 `tests/knowledge-base-graph-contract.test.ts`：固定 `getFileRecords()`、`getChunksByFilePath()`、`rebuildIndexDetailed()`、`syncChangedFiles()` 的文件路径与 removed chunk 语义；
- 扩展 `tests/architecture/import-boundaries.test.ts`：预先断言 `domain/graph/**` 不得导入 `obsidian`、模型/RAG、Exam、Presentation，且图谱持久化不进入 runtime state。

验收：仅新增测试和 fixture，不修改生产代码；明确覆盖同名标题、重复 tag、link 与 embed 指向同一文件、范围外 link、隐藏 `.vault-coach` 路径、删除与 rename 的输入样本。

建议提交：`test(graph): add deterministic vault graph fixtures and boundaries`

### 步骤 2：建立纯领域图谱契约、ID 与快照完整性骨架

状态：`[x] 已开发，待维护者验证`

目标：先让图谱可以被类型系统和测试精确定义，避免 Reader 与存储各自发明 schema。

修改位置：

- 新建 `src/domain/graph/graph-types.ts`：实现第 6 节的节点、边、来源、`GraphSnapshotV1`、Graph source 输入、查询和校验类型；
- 新建 `src/domain/graph/graph-store.ts`：只声明 `load/save/clear` 端口；
- 新建 `src/domain/graph/graph-id.ts`：实现 path、heading、tag 规范化、Section occurrence、稳定 ID、edge ID、来源去重与 canonical sort；
- 新建 `src/domain/graph/graph-integrity-service.ts`：先实现 schema、重复 ID、端点存在、节点/边类型组合、隐藏路径、Section owner、来源与排序检查；
- 新建 `tests/domain/graph/graph-id.test.ts`、`tests/domain/graph/graph-integrity-service.test.ts`：用固定输入验证 ID、Unicode/tag 归一化、重复标题、确定排序和各类错误报告；
- 更新 `tests/architecture/import-boundaries.test.ts`：将新领域目录纳入既有域隔离检查。

实现注意：在这个步骤不要读取 Obsidian，也不要把 `createdAt`、`updatedAt`、随机 UUID 作为快照字段。若后续语义图谱需要可变时间线，应以新 schema 或独立 event 存储扩展，不能破坏 M2 的确定性快照。

验收：相同 Graph source input 在不同执行次序下生成相同 ID、排序和校验结果；`GraphSnapshotV1` 的非法形态能得到稳定的 issue code；领域目录零 Obsidian import。

建议提交：`feat(graph): define deterministic graph contracts and integrity rules`

### 步骤 3：实现版本化 JSON GraphStore

状态：`[x] 已开发，待维护者验证`

目标：让经过校验的 Graph snapshot 有独立、可恢复的本地事实存储。

修改位置：

- `src/constants.ts`：新增 `GRAPH_DIR_PATH`、`GRAPH_SNAPSHOT_PATH` 和私有临时/备份路径生成规则；
- 新建 `src/infrastructure/storage/json-graph-store.ts`：以 `VaultAdapter` 实现 `GraphStore`，负责逐级建目录、JSON 序列化、读回校验、临时写入、rename/backup 恢复和清除；
- 复用或抽取 M1 `JsonAssessmentSessionStore` 中经过验证的“不允许 rename 覆盖时先备份再替换”策略；不要复制一份未测试的简化 I/O；
- 新建 `tests/infrastructure/storage/json-graph-store.test.ts`：使用最小 VaultAdapter fake 覆盖首次保存、覆盖已有快照、临时文件残留恢复、损坏 JSON、未知 schema、save 校验失败与 clear；
- 在 fixture 中加入 `graph-snapshot-v1.json`、损坏 snapshot 和旧 `.tmp/.bak` 场景。

持久化规则：

```text
有效 snapshot
  → 写 graph-snapshot-v1.json.tmp
  → 读回并执行完整性检查
  → 替换 graph-snapshot-v1.json（必要时 .bak）
  → 清理临时/备份文件
```

若读写/校验失败，最后一份有效正式快照必须保持不变；Store 不得用空 snapshot 覆盖损坏文件。`clear()` 仅在用户明确清除知识索引或图谱重建后的受控路径调用。

验收：snapshot 可独立加载、覆盖和恢复；不读写 `runtime-state.json`、Assessment 或 Markdown 报告；Obsidian Adapter 不支持 rename 覆盖时仍可成功保存。

建议提交：`feat(storage): persist validated deterministic graph snapshots`

### 步骤 4：读取 Obsidian 的确定性图谱来源

状态：`[x] 已开发，待维护者验证`

目标：把 Obsidian host 数据一次性转换为无 host 类型的 `GraphSourceDocument`，并明确 Markdown/PDF、标题、tag、link 和 embed 的边界。

修改位置：

- 新建 `src/infrastructure/obsidian/obsidian-graph-source-reader.ts`：注入 `App`，接收 `DocumentIndexReader` 或最小 `VaultKnowledgeBase` 只读端口；读取当前文件记录和 chunks，输出排序后的 `GraphSourceDocument[]`；
- Reader 使用 `metadataCache.getFileCache()`、`metadataCache.getFirstLinkpathDest()` 和 `metadataCache.resolvedLinks` 解析普通 link、embed、tag 与前端缓存位置；
- Reader 使用 Markdown headings（metadata cache 或与现有 parser 等价的纯 heading 解析器）构造所有标题 Section；无正文标题也必须保留；以 `IndexedChunk.headingPath` 归属 chunk；
- Reader 为 PDF 按 `IndexedChunk.locator` 的页级信息构造 Section，不尝试 OCR 或视觉关系抽取；
- Reader 在入口按当前知识索引的 file records 建 allowed-path set，排除隐藏、范围外、删除和不支持文件；
- 新建 `tests/infrastructure/obsidian/obsidian-graph-source-reader.test.ts`，扩展 `tests/mocks/obsidian.ts` 所需的 metadata cache fake；覆盖 alias、相对路径、普通 link、Embed、frontmatter/inline tag、重复标题、无标题正文、PDF、外部目标和 `.vault-coach`。

实现注意：普通 link 与 Embed 必须从各自 cache collection 建模；不能仅遍历 `resolvedLinks` 后猜测关系类型。若具体 Obsidian cache 缺少位置，来源位置字段保持 absent，而不是伪造行号。对 metadata 尚未刷新导致的未解析 target，跳过并在 Reader 返回的诊断中记录；不创建裸路径节点。

验收：Reader 的输出不含 `App`、`TFile`、`CachedMetadata`；同一 fake Vault 反复读取的 source 数组稳定；`.vault-coach` 和范围外文档完全不出现。

建议提交：`feat(graph): read deterministic structure from Obsidian metadata`

### 步骤 5：实现纯 DeterministicGraphBuilder

状态：`[x] 已开发，待维护者验证`

目标：从步骤 4 的 Graph source 生成 M2 的全部三类节点、四类边和稳定统计，且不依赖存储或 Obsidian。

修改位置：

- 新建 `src/domain/graph/deterministic-graph-builder.ts`：实现 `buildGraphSnapshot(sources)`；
- 先构建 Document、Section、Tag nodes，再构建 `contains`、`links_to`、`embeds`、`tagged_with`；边以 `(type, sourceNodeId, targetNodeId)` 聚合，并合并/排序 `sources`；
- 用 `GraphIntegrityService` 验证 builder 输出；builder 自身不抛出静默丢数据，遇到无法表示的输入应返回明确的 diagnostic 或由调用层拒绝构建；
- 新建 `tests/domain/graph/deterministic-graph-builder.test.ts`：以 Graph source fixture 做 golden snapshot 比较，并覆盖 node/edge 去重、confidence、同一 pair 的 link+embed、无标题正文、无正文标题、PDF section、范围外目标；
- 将 `tests/fixtures/vault-graph/expected-graph-v1.json` 固定为排序后的完整目标结果；增加乱序输入测试，证明输出字节一致。

验收：builder 不调用文件、时间、随机数或模型；对同一来源的 snapshot 严格相等；每条边的端点存在且来源可回查；Document/Section/Tag 数与 fixture 相符。

建议提交：`feat(graph): build deterministic document structure snapshots`

### 步骤 6：接通全量图谱重建与应用层 Graph API

状态：`[x] 已开发，待维护者验证`

目标：在不改变任何现有 UI 的前提下，使成功的索引重建自动生成并保存完整结构图谱。

修改位置：

- 新建 `src/app/graph/knowledge-graph-service.ts`：加载已有 snapshot、执行 `rebuildAll()`、调用 Reader/Builder/Integrity/Store，并维护只读内存 snapshot 与 dirty/error 状态；
- `src/app/application-container.ts`：创建 Reader、`JsonGraphStore`、Builder/Query/Integrity 服务，注入 `VaultCoachApplication` 与 services；
- `src/app/vault-coach-application.ts`、`src/app/application-api.ts`：增加第 6.4 节的 `graph` Facade；查询只读，重建委托 service；
- `src/app/vault-coach-runtime.ts`：在 `rebuildKnowledgeBase()` 的文本索引成功后调用全量 graph rebuild。即使向量索引因模型不可用而降级，图谱仍必须完成；
- runtime 初始化时尝试加载 graph snapshot；schema 不兼容/损坏只标记 graph dirty，不阻断插件启动和其他功能；
- 新增 `tests/app/graph/knowledge-graph-service.test.ts`、`tests/app/vault-coach-application.test.ts`、`tests/app/vault-coach-runtime.test.ts`：覆盖成功顺序、图谱保存失败不回滚文本索引、向量失败仍建图、加载损坏 snapshot、API 查询不可变返回值。

全量时序：

```text
文本索引全量成功
  → 尝试向量索引（失败可降级）
  → Reader.readAll(current index)
  → DeterministicGraphBuilder.build
  → integrity check
  → GraphStore.save
  → 更新 graph 内存状态
```

验收：用户点击现有“重建索引”后会产生 graph snapshot；文本索引和图谱错误相互隔离；现有 Index API、按钮状态、Ask 与 Exam 不因 graph 失败失效；断网或无模型时仍可建图。

建议提交：`feat(app): rebuild deterministic graph with the document index`

### 步骤 7：实现文件级增量更新、删除与重命名迁移

状态：`[x] 已开发，待维护者验证`

目标：将图谱从“可重建”提升为“随 Vault 文件变化保持正确”，默认不做全 Vault 图谱重算。

修改位置：

- `src/app/graph/knowledge-graph-service.ts`：新增 `syncChangedFiles(syncResult, renamePairs)`；从当前 snapshot 删除受影响 source path 的贡献，读取当前文件来源，合并重建，校验后保存；
- 增加 `GraphRename { oldPath: string; newPath: string }` 纯类型；服务在 rename 时迁移指向旧 Document 的有效入边、重建新文档的出边和 sections，随后校验；
- `src/app/vault-coach-runtime.ts`：新增待处理 rename pair 集合；`handleVaultPathRenamed()` 同时排队文本索引旧/新路径和 graph rename pair；自动同步成功后把 `KnowledgeBaseSyncResult` 与 rename pair 交给图谱服务；
- `clearKnowledgeIndex()`：在文本索引、向量及相关持久化清除时清除 graph snapshot/内存状态，避免展示已删除知识范围的旧图谱；
- 保持 `src/vault-coach-plugin.ts` 的事件注册形状不变；它只调用 runtime 的现有路径方法；
- 新增 `tests/app/graph/knowledge-graph-service.test.ts` 与 runtime 集成测试，覆盖修改单文件、删除、移出范围、rename、多个快速事件去重、`.vault-coach` 自身写入不触发图谱同步、同步失败后的 dirty 状态。

增量时序：

```text
Vault create / modify / delete / rename
  → 现有防抖队列
  → 文本索引 syncChangedFiles(paths)
  → 当前 index + affectedFiles + renamePairs
  → GraphService 文件级替换 / 删除 / 迁移
  → integrity check
  → 原子写入新的完整 snapshot
```

验收：修改单文件不调用 `readAll()` 或全量 builder；删除后无对应 Document/Section/incident edge；rename 后无旧 path，其他文档的入边已指向新 Document；图谱同步失败不破坏上一次有效快照且下次可重试。

建议提交：`feat(graph): incrementally synchronize renamed and changed vault files`

### 步骤 8：完成查询、完整性诊断与端到端回归

状态：`[x] 已开发，待维护者验证`

目标：确保快照不仅能存，还能安全供后续里程碑消费，并在提交前把所有图谱不变式锁住。

修改位置：

- 新建 `src/domain/graph/graph-query-service.ts`：实现按 node、document path、关联边、source file、edge source 查询，始终返回深拷贝或只读副本；
- 完善 `src/domain/graph/graph-integrity-service.ts`：校验 canonical ID、排序、来源 target path、每类 edge 的合法 node type、没有 `.vault-coach` 泄漏、没有孤立 Section owner、没有悬空端点；
- `src/app/graph/knowledge-graph-service.ts`：暴露 `checkIntegrity()`；加载、全量和增量保存均保存最近诊断，不用 `console.error` 替代结构化检查；
- `src/app/application-api.ts` 与 `src/app/vault-coach-application.ts`：完成第 6.4 节查询 Facade；不新增 UI；
- 新增/扩展 domain、store、application integration 测试：从 fixture 建索引 → 建图 → 查询节点/边/来源 → 修改 → rename → 删除 → check integrity；
- 扩展 `tests/architecture/import-boundaries.test.ts`：Graph domain 零 Obsidian/模型依赖，presentation 不直接导入 graph store/service，runtime state 不含 graph snapshot。

验收：每条 API 查询都不暴露可修改内部 snapshot 的引用；固定 Vault 的 golden snapshot、查询返回和 integrity report 一致；所有删除、rename、范围变更测试后报告 `valid: true`。

建议提交：`test(graph): cover graph queries integrity and lifecycle regressions`

### 步骤 9：完成文档、性能抽样与发布前审查

状态：`[x] 已开发，待维护者最终验收`

目标：验证本里程碑建立了数据底座，但没有偷渡语义功能或改变既有功能。

修改位置：

- 更新本日志的每个步骤状态、Definition of Done 与开发记录；
- 更新 README 或开发者存储说明：明确 `.vault-coach/graph/graph-snapshot-v1.json` 是本地结构图谱事实、不会上传、可由当前 Vault 重建；
- 审查 `.gitignore`：确认 `.vault-coach/` 已被忽略，且不加入真实 graph snapshot/fixture 之外的用户数据；
- 复核 `src/constants.ts`、GraphStore 路径、隐私说明和 schema version；
- 使用固定 100/1,000 文档 synthetic fixture 或可控测试 Vault 记录全量重建与单文件增量耗时；性能数据只进开发记录，不提交用户 Vault 数据；
- 执行完整验证：

```bash
npm ci
npm run build
npm run lint
npm test
```

验收：所有命令通过；无任何 LLM 调用、Concept、Mastery、UI 图库或外部网络依赖；维护者完成第 9 节手动验收。

建议提交：`docs(graph): verify deterministic graph mvp release readiness`

## 8. 自动化测试矩阵

| 层级 | 测试重点 | 最低覆盖 |
|---|---|---|
| domain/graph ID | path、heading、tag 规范化；重复标题 occurrence；stable sort | 乱序输入、Unicode、`#tag`/`tag`、大小写、重复路径 |
| domain/graph builder | 三类节点、四类边、去重、confidence、golden snapshot | link+embed 同目标、无标题正文、无正文 heading、PDF page section、范围外 target |
| domain/graph integrity/query | 端点、合法关系、来源、隐藏路径、immutable query | 每个 issue code 至少一个 fixture，查询返回不可修改内部 state |
| infrastructure reader | metadata cache → Graph source | alias/relative link、frontmatter/inline tag、line location 缺失、隐藏/范围外文件 |
| infrastructure store | schema、临时写入、覆盖、恢复、clear | rename 不可覆盖、损坏 JSON、未知 schema、写入失败不损坏有效 snapshot |
| application graph service | full build、dirty、失败隔离、加载 | vector 失败仍建图、graph 失败不回滚文本索引、重复调用幂等 |
| runtime incremental | modify/delete/rename/debounce/clear | 不全量重读、旧路径清除、入边迁移、隐藏路径不触发 |
| regression | 现有 Ask/Exam/Assessment/Index | 自动索引、清除索引、考试自动保存、历史兼容仍通过 |

建议 fixture 布局：

```text
tests/fixtures/
└── vault-graph/
    ├── basic/
    │   ├── overview.md
    │   └── details.md
    ├── rename/
    │   ├── source.md
    │   ├── target-before.md
    │   └── target-after.md
    ├── graph-source-basic.json
    ├── expected-graph-v1.json
    ├── graph-snapshot-v1.json
    ├── corrupt-graph-snapshot.json
    └── unsupported-graph-snapshot.json
```

golden 文件必须经过 canonical sort；任何预期变化都必须在 code review 中说明是“源结构变化”还是“schema 迁移”，不能用无序 JSON 掩盖差异。

## 9. 手动验收脚本

在专用测试 Vault 中执行。不要直接删除或改名真实 Vault 中的重要笔记。

1. 创建 `A.md`、`B.md`：让 A 含多级标题、普通 `[[B]]`、`![[B]]`、inline tag 与 frontmatter tag；同时在 `.vault-coach/` 放一份含链接的测试文件；
2. 保持聊天模型不可用或断网，点击现有的**重建索引**；确认 Ask/Exam 仍可打开，且出现：

   ```text
   .vault-coach/graph/graph-snapshot-v1.json
   ```

3. 打开 snapshot，确认只有当前知识范围内的 A/B Document，A 的 Section/Tag、四类规定边和来源信息；确认 `.vault-coach` 中的文件没有节点或边；
4. 连续执行两次重建，在不改动测试 Vault 的前提下比较 snapshot 内容；确认 nodes、edges、sources 和 stats 完全一致；
5. 修改 A 的标题、tag 和链接，等待现有自动增量索引完成；确认只更新 A 的结构贡献，B 的无关节点/边保持不变；
6. 删除 B，确认 B 的 Document/Section 及所有指向 B 的 `links_to`/`embeds` 均消失，完整性检查通过；
7. 恢复 B 后将其重命名为 `C.md`，确认 A 的关系已指向 C、没有 B 路径或悬空 edge；
8. 将 A 移到当前知识范围外或关闭 Markdown 索引，等待同步；确认 A 的节点和 incident edge 被移除，Tag 孤儿按规则清理；
9. 点击现有**清除索引**，确认图谱 snapshot 被清除或内存状态明确为空，不能继续查询旧图谱；
10. 重启 Obsidian，确认有效 snapshot 可加载；再次验证问答、考试生成、提交自动保存、历史读取、删除 Markdown 报告和设置页均正常。

## 10. 风险、决策与回滚边界

| 风险 | 预防措施 | 回滚策略 |
|---|---|---|
| metadata cache 与文件内容短暂不同步 | 只接受已解析且在当前 index allowed set 的 target；记录 diagnostics，下一次增量重试 | 保留最后有效 snapshot，不创建猜测节点/边 |
| 标题重复导致 Section ID 冲突 | heading path + occurrence 的纯 ID 规则与 fixture | 修复 ID 算法后全量重建；不改 Assessment 数据 |
| rename 只按 old/new 两个字符串处理而丢失入边 | runtime 保留 `GraphRename` 成对记录，service 显式迁移入边并校验 | 标记 graph dirty，执行一次全量 rebuild；文本/向量索引不回滚 |
| 删除后留下悬空边 | 删除 node 时统一删除所有 incident edges，save 前强制 integrity check | 拒绝写入非法 snapshot，重建有效图谱 |
| GraphStore 写入中断 | tmp → 读回校验 → backup/replace → recovery | 保留正式旧 snapshot，清理或恢复暂存文件 |
| 图谱更新影响索引/问答可用性 | graph 与 text/vector 失败隔离；Graph 不依赖模型 | 暂停 graph sync、标记 dirty；Ask/Exam 继续使用既有索引 |
| `.vault-coach` 自身事件形成递归 | Reader 和 runtime 均过滤 hidden path | 删除错误 snapshot 后重建；不扫描用户 Assessment 文件 |
| 过早接入 Concept/UI | Definition of Done 明确限制节点和边类型；架构测试阻止模型/UI 依赖 | 回退越界提交，不迁移 M2 snapshot |

回滚只回滚程序代码，不删除用户已经生成的 `.vault-coach/graph/graph-snapshot-v1.json`。未知 schema 或损坏的 graph 文件必须保留；后续版本可以提供诊断、导出或迁移，但不得静默以空数据覆盖。

## 11. Definition of Done

- [x] `GraphStore` 端口与 `GraphSnapshotV1` 已定义，Graph snapshot 有独立 schema version；
- [x] `.vault-coach/graph/graph-snapshot-v1.json` 是已校验的结构图谱事实源，不写入 runtime state 或 Assessment JSON；
- [x] 已实现 Document、Section、Tag 节点，且 ID、排序和序列化在相同输入下稳定；
- [x] 已从 Obsidian 双链、Embed、Tag、标题层级、文档路径和 PDF 页级 Chunk 读取结构来源；
- [x] 已构建并测试 `contains`、`links_to`、`embeds`、`tagged_with`，包括 confidence 和可追溯来源；
- [x] 相同 Vault 的全量重建得到字节一致的 semantic snapshot；
- [x] 成功重建文本索引后会完成图谱全量重建；聊天/Embedding 模型不可用不会阻止图谱构建；
- [x] 文件修改只进行文件级图谱更新；未受影响文件不会被重新读取或重算；
- [x] 文件删除、移出范围与重命名后对应节点和边已正确清理/迁移，完整性报告为 valid；
- [x] `.vault-coach`、隐藏路径、范围外文件和未解析 target 不会进入图谱；
- [x] 节点、边、来源查询通过 Application Facade 提供，返回值不可修改内部 snapshot；
- [x] `domain/graph/**` 没有 Obsidian、DOM、模型、RAG、Exam 或 Presentation 依赖；
- [x] 未引入 Concept、语义关系、掌握度、Progress、复习、图谱 UI 或可视化依赖；
- [x] 现有 Ask、Exam、Assessment、索引、自动同步、清除索引和设置功能自动化回归通过；
- [x] `npm ci`、`npm run build`、`npm run lint`、`npm test` 全部通过；
- [ ] 维护者已完成第 9 节手动验收、最终审查和独立提交。

## 12. 与后续里程碑的接口

M2 只交付可验证的结构事实；后续功能必须在此边界上增加数据，而不是修改或猜测 M2 边。

```text
M2：GraphSnapshotV1
  Document / Section / Tag
  contains / links_to / embeds / tagged_with
                ↓
M3：ConceptNode、Section 级候选、Alias、受限语义关系与来源证据
                ↓
M4：AssessmentEvent[] + Concept 映射
                ↓
    ConceptMasteryState[]
                ↓
M5/M7：Progress、图谱 UI、复习推荐
```

约束：

- M3 只能新增/迁移到包含 Concept 的兼容 graph schema，不能把 Tag 直接当作 Concept，也不能用 LLM 改写 M2 结构边；
- M4 只消费 Assessment Event 与明确的 Concept 映射，不读取 Markdown 报告，不把 provisional topic ID 当作 M2 的正式节点；
- M5 的图谱 UI 只能使用 `VaultCoachApplication.graph` 查询 API；布局状态必须独立于 `graph-snapshot-v1.json`；
- 任一后续模块发现 snapshot 不完整时，可以请求 rebuild，但不得绕过 Reader/Builder 直接写 JSON。

## 13. 开发记录

| 日期 | 步骤 | 状态 | 审查/测试结论 | 提交 |
|---|---|---|---|---|
| 2026-07-20 | 文档创建 | 已完成 | 已依据主规划、里程碑 1 的完成状态、当前索引/运行时边界形成分步实施计划 | — |
| 2026-07-20 | 步骤 1：fixture 与测试基线 | 已开发，待验证 | 已新增确定性 Vault/rename/PDF/预期快照 fixture；锁定全量索引、隐藏目录排除、标题路径与 rename 的 changed/removed Chunk 语义；已通过全量自动化测试、lint 和构建 | — |
| 2026-07-20 | 步骤 1：CI fixture 修复 | 已开发，待验证 | 将被 `.gitignore` 忽略的隐藏目录 fixture 移至受版本控制的测试目录，并在虚拟 Vault 中映射回 `.vault-coach/ignored.md`；避免 GitHub Runner 出现 ENOENT | — |
| 2026-07-20 | 步骤 2：领域契约与完整性骨架 | 已开发，待验证 | 已新增纯 `domain/graph` 契约、稳定 ID/规范化/排序工具、GraphStore 端口与 GraphIntegrityService；覆盖合法快照、重复 ID、悬空端点、关系形状、来源、隐藏路径、孤立 Section 与排序诊断 | — |
| 2026-07-20 | 步骤 3：JSON GraphStore | 已开发，待验证 | 已实现独立版本化 Graph Snapshot JSON、tmp/backup 替换与恢复、schema/结构/统计/完整性校验和仅快照清除；覆盖首次写入、禁止覆盖 rename、失败恢复、tmp/bak 恢复、损坏/未知 schema 与非法快照保护 | — |
| 2026-07-20 | 步骤 4：Obsidian 图谱来源 Reader | 已开发，待验证 | 已实现 `ObsidianGraphSourceReader`：仅以当前 `DocumentIndexReader` 文件记录为 allowed set，读取 metadata cache 的 headings、links、embeds、tags/frontmatter tags 与 resolvedLinks 回退；保留无正文标题和 PDF 页级 Section，跳过隐藏/范围外/未解析目标并返回结构化诊断。已覆盖 alias、相对路径、普通 link 与 Embed 分离、重复标题、无标题正文、无正文标题、PDF、inline/frontmatter tag、缺失索引文件和 `.vault-coach` 排除；`npm run build`、`npm run lint`、`npm test` 通过（24 files / 86 tests） | — |
| 2026-07-21 | 步骤 5：确定性 Builder | 已开发，待验证 | 已新增纯 `DeterministicGraphBuilder` 与 `buildGraphSnapshot()`：从脱离 Obsidian 的 Graph source 生成 Document/Section/Tag 节点和四类结构边，按端点聚合/规范排序来源，排除范围外 target，并在返回前执行 GraphIntegrityService 校验。覆盖 golden snapshot、无标题正文、无正文标题、重复标题、PDF 页级 Section、link 与 Embed 同目标、重复 tag、范围外目标、乱序输入和非法 hidden/重复 source；同时把 evidence canonical 排序调整为优先文件/关系/位置，便于按笔记行号审计。`eslint.config.mts` 现排除本地 `kb/**`，避免 Obsidian 开发知识库产物被 lint 误扫。`npm run build`、`npm run lint`、`npm test` 通过（25 files / 90 tests） | — |
| 2026-07-21 | 步骤 6：全量重建与 Application API | 已开发，待验证 | 已新增应用层 `KnowledgeGraphService`，负责加载、全量重建、完整性校验、GraphStore 写入、诊断/dirty/error 状态与不可变查询副本；Container 注入 Obsidian Reader、纯 Builder 与 JsonGraphStore；`VaultCoachApplication.graph` 提供 rebuild、snapshot、node、边、来源和 integrity API。Runtime 在启动时安全加载图谱，在文本索引成功后重建图谱；图谱写入失败或向量索引失败均不会回滚文本索引。新增 service、facade 与 runtime 集成测试，覆盖持久化、损坏 snapshot、图谱失败隔离、向量失败仍建图和返回值不可变。另兼容历史/异常索引 Chunk 的非字符串 `headingPath` 元素，规范化时安全忽略，避免图谱 Reader 阻断全量重建。`npm run build`、`npm run lint`、`npm test` 通过（27 files / 98 tests） | — |
| 2026-07-21 | 步骤 7：文件级增量、删除与 rename | 已开发，待验证 | `KnowledgeGraphService.syncChangedFiles()` 现在接收成功的 `KnowledgeBaseSyncResult` 与成对 `GraphRename`，只读取受影响路径并以 fragment 合并完整快照；删除/移出范围会清理 Document、Section、incident edge 与孤儿 Tag，rename 会迁移未改动来源文件的入边及其 `targetFilePath` 证据。`VaultCoachRuntime` 保留并合并 rename 队列，文本同步成功后分别隔离向量/图谱错误；图谱失败保留上一次有效快照、标记 dirty 并保留受影响路径供下一轮同步重试。清除知识索引时同步清除图谱快照和内存状态，插件事件注册未改动。新增 pure fragment、单文件增量、删除、rename、失败保留旧快照、运行时 rename、重复路径去重、隐藏 `.vault-coach` 事件忽略和 clear 回归测试。`npm run build`、`npm run lint`、`npm test` 通过（27 files / 107 tests）。 | — |
| 2026-07-21 | 步骤 8：查询、完整性与端到端回归 | 已开发，待验证 | 已新增纯 `GraphQueryService`，集中实现按 node、document path、关联 edge、source file 与 edge source 的查询，并对节点、Section locator/heading/chunk、边与来源深拷贝，禁止外部改写内存 snapshot。`KnowledgeGraphService` 现在保存最近一次完整性报告，与 Reader 结构化诊断一同暴露于 state；加载、全量和增量构建均在写入前记录并校验该报告。Application Facade 新增 document path/source file 查询。完整性测试补足 link source 的 `targetFilePath` 与 endpoint 一致性；Runtime 生命周期回归覆盖“建图 → 查询 → 修改 → rename → 删除 → valid integrity”。架构测试明确禁止 Graph domain 引入运行时/Container 依赖，Presentation 禁止直连 Graph service/store/builder。`npm run build`、`npm run lint`、`npm test` 通过（28 files / 111 tests）。 | — |
| 2026-07-21 | 步骤 9：文档、性能与发布审查 | 已开发，待维护者最终验收 | 已在中英文 README 说明 `.vault-coach/graph/graph-snapshot-v1.json` 的本地事实、可重建性、潜在私有元数据与零网络调用；`.gitignore` 明确忽略 Vault 本地生成事实、报告与图谱快照；已复核 constants 路径与 schema 边界，未引入 Concept/语义关系/Mastery/Progress/UI 图形库。固定 synthetic Graph source 的本机纯 Builder 抽样（不含 metadata、I/O）：100 文档 full 5.622 ms、单文件 fragment 0.079 ms；1,000 文档 full 35.787 ms、单文件 fragment 0.322 ms。数据仅供本机开发参考，非 CI 性能门槛。已通过 `npm ci`、`npm run build`、`npm run lint`、`npm test`（28 files / 111 tests）；仍待维护者完成第 9 节 Obsidian 手动验收与独立提交。 | — |
