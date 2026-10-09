---
tags:
  - VaultCoach
  - Issue36
  - PDF
  - RAG
  - 知识库
  - 踩坑复盘
---

# Issue 36 PDF 知识载体支持实现复盘

## 背景

Issue 36 的目标是让 Vault Coach 不再只依赖 Markdown 文件作为知识来源，而是能把 Vault 内的文本型 PDF 也纳入问答、检索、embedding 和来源引用。

这次只实现需求文档中的前三个里程碑：

1. 里程碑 0：向量存储基础设施重构。
2. 里程碑 1：多文档知识库架构。
3. 里程碑 2：文本型 PDF Beta。

这意味着首版支持的是带原生文本层的 PDF，不包含扫描型 PDF OCR、图表理解、复杂表格恢复、数学公式视觉识别和 Zotero 集成。

## 核心判断

最重要的判断是：PDF 支持不能简单做成“读 PDF 文本，然后塞进原来的 Markdown 索引”。

原因是原来的知识库底座默认知识来源都是 Markdown：

- 来源定位是文件加 heading。
- 切块逻辑围绕 Markdown 标题和自然段。
- 向量存储和文本索引耦合在 `VaultKnowledgeBase` 里。
- 快照里既存 chunk，又存 embedding，PDF 加入后体积会迅速变大。

PDF 加入后，必须先把系统抽象成：

```text
DocumentParser
→ ParsedDocument
→ ParsedDocumentBlock
→ IndexedChunk
→ KeywordIndex / VectorStore
→ RAG sources
```

这样 Markdown、PDF 和未来 Zotero 才能使用同一条检索链路。

## 里程碑 0：向量存储层重构

### 目标

把向量索引从 `VaultKnowledgeBase` 里拆出来，让知识库只负责文档、chunk 和关键词倒排索引，向量写入、删除、查询、持久化由独立 `VectorStore` 负责。

### 实现

新增 `src/vector-store.ts`，实现 `EmbeddedExactVectorStore`：

- 向量统一转成 `Float32Array`。
- 写入前做 L2 normalization。
- 查询时对 query vector 同样归一化，用点积表示余弦相似度。
- 用固定容量 top-k 逻辑保留最相关结果，避免对全量结果排序。
- 向量数据保存为 `knowledge-index/vectors/shard-000001.bin`。
- 元数据保存在 `knowledge-index/vectors/manifest.json`。

这个阶段没有引入 Qdrant、Chroma、pgvector 或 native HNSW。理由很实际：PDF Beta 的第一瓶颈是解析质量、来源定位和索引体积，不是 ANN 检索性能。提前引入外部向量数据库会增加部署成本，也会破坏 Obsidian 插件的轻量和移动端兼容目标。

### 收获

这一步让后续演进有了接口边界。现在 RAG 层只需要依赖向量存储能力，不需要知道底层是精确扫描、WASM ANN，还是外部服务。

## 里程碑 1：多文档知识库架构

### 目标

把 Markdown 专用知识库改造成多文档解析架构。关键不是“支持 PDF 后缀”，而是让不同载体都能输出统一结构。

### 实现

新增 `src/document-parser.ts`，定义：

- `DocumentParser`
- `DocumentParserRegistry`
- `createDocumentId()`
- `hashString()`
- `hashArrayBuffer()`

在 `src/types.ts` 中补齐统一文档模型：

- `KnowledgeDocumentType`
- `ParsedDocument`
- `ParsedDocumentBlock`
- `DocumentLocator`
- `MarkdownLocator`
- `PdfLocator`
- `PdfExtractionReport`

原来的 Markdown 解析被迁移到 `src/markdown-document-parser.ts`。它仍然按 heading 拆 section，但输出不再是 Markdown 专用 chunk，而是统一的 `ParsedDocument`。

`src/knowledge-base.ts` 变成调度层：

```text
TFile
→ DocumentParserRegistry.resolve()
→ parser.parse()
→ chunkParsedDocument()
→ addChunkToIndex()
```

`IndexedChunk` 也不再假设来源一定是 Markdown。它现在带有：

- `documentId`
- `documentType`
- `locator`
- `contentKind`
- `extractionQuality`

### 关键取舍

没有默认把 PDF 转成 Markdown 再切块。

这个决定来自补充说明里的核心判断：默认物化 Markdown 会产生两份内容源。如果同时索引 PDF 原文和生成的 Markdown，会造成重复召回、重复来源和向量膨胀。如果用户修改生成 Markdown，还会引入同步冲突。

更合理的方案是：

```text
PDF 原文件
→ PDF Parser
→ ParsedDocument
→ PDF-aware Chunker
→ IndexedChunk
```

未来可以做“解析预览”或“按需导出 Markdown”，但导出文件应该是用户审阅产物，而不是内部索引数据源。

## 里程碑 2：文本型 PDF Beta

### 目标

让 Vault 内的文本型 PDF 能参与：

- 文件发现。
- 文本提取。
- chunking。
- embedding。
- 关键词检索。
- 向量检索。
- hybrid 检索。
- rerank。
- 问答。
- 来源页码展示。

### 实现

新增 `src/pdf-document-parser.ts`，使用 `pdfjs-dist` 读取 PDF 原生文本层。

处理流程是：

```text
vault.readBinary(file)
→ pdfjsLib.getDocument()
→ page.getTextContent()
→ text items
→ lines
→ paragraphs
→ heading / paragraph blocks
→ ParsedDocument
```

解析器会记录 PDF 元信息和质量信号：

- 文件大小。
- 修改时间。
- 内容 hash。
- 页数。
- 提取方法。
- parser version。
- extraction quality。
- warnings。

设置页增加了 PDF 相关开关：

- 是否启用 Markdown 索引。
- 是否启用 PDF 索引。
- PDF 最大文件大小。
- PDF 最大页数。

默认策略是保守的：PDF 索引可以打开，但扫描型 PDF 不会自动 OCR，大 PDF 和超长 PDF 会被配置限制挡住。

### PDF 文本恢复策略

PDF.js 返回的不是自然段，而是一批带坐标的 text item。直接把 `item.str` 拼起来会得到错误阅读顺序，所以实现中做了几层整理。

第一层是 text item 到 line：

- 读取 transform 中的 x、y。
- 估算 font size。
- 按 y 接近程度合并成同一行。
- 行内按 x 排序。
- 根据 item 间距补空格。

第二层是 line 到 paragraph：

- 根据纵向间距判断新段落。
- 根据缩进判断新段落。
- 对断词换行做简单合并。
- 过滤纯页码。

第三层是结构清理：

- 检测多页重复出现的页眉页脚。
- 对疑似双栏页面做简化阅读顺序恢复。
- 根据字体大小和编号模式推断标题。
- 对低文本页、空页、疑似扫描 PDF、双栏不确定顺序打 warning。

这不是完整排版还原，而是面向 RAG 的“可检索文本恢复”。目标是尽量得到有意义的段落和页码定位，而不是复刻 PDF 原貌。

### 来源引用

PDF chunk 的 locator 是页码范围：

```ts
{
  type: "pdf",
  filePath,
  pageStart,
  pageEnd,
}
```

RAG 输出来源时，Markdown 仍然显示 heading，PDF 则显示：

```text
PDF 第 3 页
PDF 第 3-4 页
```

来源链接形如：

```text
[[paper.pdf#page=3|paper.pdf · 第 3 页]]
```

这样用户可以从回答跳回原 PDF 的对应页，而不是跳到一份自动生成的中间 Markdown。

## 开发过程

### 1. 先拆向量层

第一步没有碰 PDF，而是把向量存储从知识库里拆出去。这个顺序很重要，因为 PDF 会显著增加 chunk 和 embedding 数量。如果继续用 JSON 保存所有浮点数组，快照会变大，恢复也会更慢。

拆完以后，知识库和 RAG 的职责更清楚：

- `VaultKnowledgeBase`：负责解析文档、维护 chunk、关键词索引和文件记录。
- `EmbeddedExactVectorStore`：负责向量记录、二进制持久化和向量检索。
- `AdvancedRagEngine`：负责 embedding、召回、融合、rerank 和 prompt。

### 2. 再抽统一文档模型

第二步把 Markdown parser 迁移到 `DocumentParser` 接口。这一步的目标是保证 Markdown 行为不变，但不再让 chunking 逻辑依赖 Markdown 原文。

迁移后，PDF parser 只需要输出同样的 `ParsedDocumentBlock`，后面的关键词索引、向量索引和 RAG 不需要关心文档来源。

### 3. 实现 PDF parser

第三步才接入 `pdfjs-dist`。

这里先支持 native text，而不是 OCR。原因是 OCR 涉及页面渲染、图像缓存、识别模型、性能控制和质量标记，如果和文本型 PDF 同时做，会把首版风险放大。

PDF parser 的重点不是调用库，而是把 PDF.js 的低层 text item 转成 RAG 可用的结构化块。

### 4. 打通来源和检索

PDF chunk 可以进入同一套：

- keyword search。
- vector search。
- hybrid RRF。
- rerank。
- answer sources。

但来源去重和显示必须区分文档类型。Markdown 用文件加 heading 去重，PDF 用文件加页码范围去重。

### 5. 验证和调参

开发过程中主要用三类验证：

- `npm run lint`
- `npm run build`
- PDF smoke test 和真实 vault 重建索引

真实 vault 的重建索引比单元级验证更有价值，因为它能暴露 PDF 数量、Markdown 数量、chunk 数量和快照体积变化。

## 踩坑经历

### 坑 1：PDF.js 抽出来的不是文章结构

`getTextContent()` 返回的是页面上的文本绘制项，不是段落、标题或自然阅读顺序。

如果直接拼接，会出现：

- 单词间缺空格。
- 行顺序错乱。
- 双栏论文左右栏交叉。
- 页眉页脚进入正文。
- 页码参与检索。

因此必须增加 line reconstruction、paragraph reconstruction、页眉页脚清理和页码过滤。

经验是：PDF parser 不能只看“能不能提取文字”，还要看提取后的文本是否适合作为 RAG chunk。

### 坑 2：双栏 PDF 不能完美解决，只能标记不确定性

双栏论文是 PDF RAG 的常见难点。首版实现只做启发式判断：

- 统计左右区域文本行。
- 用页面中线粗略分栏。
- 先处理横跨页面的标题，再处理左栏和右栏。

这个方法能改善一部分论文，但不能保证所有复杂排版正确。最后选择把这类页面标记为 `layout-order-uncertain`，并降低 extraction quality。

经验是：不应该把启发式恢复包装成“完全正确”。更好的做法是把不确定性传递到索引和来源层。

### 坑 3：扫描型 PDF 不应伪装成解析成功

扫描型 PDF 可能只有图片，没有有效文本层。如果强行输出空 chunk，用户会以为已经索引成功，但问答检索不到内容。

现在通过每页字符数统计判断：

- native text pages。
- low text pages。
- empty pages。
- likely scanned。
- quality score。

文本覆盖率太低时标记 `likely-scanned`，但不在首版自动 OCR。

经验是：PDF 支持要区分“解析失败”“低质量解析”和“等待 OCR”，不要把所有情况都吞掉。

### 坑 4：默认转 Markdown 会制造重复知识源

补充说明里曾讨论是否应该把 PDF 解析后保存成 Markdown 再切块。这个方案表面上方便用户审阅，实际会带来重复索引和同步冲突。

最终采用结构化解析缓存路线。PDF 原文仍然是唯一内容源，内部解析结果是派生数据。

经验是：用户可检查解析结果很重要，但检查能力不等于必须生成可索引 Markdown 文件。解析预览和按需导出更适合。

### 坑 5：向量不能继续用 JSON 浮点数组持久化

Markdown 规模较小时，JSON 快照还能接受。PDF 加入后，chunk 数和 embedding 体积都会上升，把所有向量作为 JSON number array 保存会带来：

- 文件体积膨胀。
- 读写慢。
- 解析 JSON 时内存峰值高。
- 快照结构和知识库逻辑耦合。

因此改成 `Float32Array` 加二进制 shard。

经验是：PDF 支持不是单纯解析问题，也会放大持久化和恢复性能问题。

### 坑 6：chunk flush 忘记清空会造成指数级膨胀

后续重建索引时暴露过一个严重问题：同一个测试知识库曾出现 57483 个片段，而预期只有约 660 个。

根因在 `chunkParsedDocument()` 的 `flushPendingBlocks()`：已经把 pending blocks 写成 chunk 后，没有及时清空 `pendingBlocks`。结果后续 block 会反复带着历史 block 一起 flush，导致 chunk 数量异常膨胀。

修复方式很小：

```ts
pendingBlocks = [];
```

但影响很大，因为 chunk 数量会进一步放大 embedding 请求、向量文件体积、检索耗时和 UI 状态。

同时把 `DOCUMENT_CHUNKER_VERSION` 提升到新版，让旧的错误快照失效。

经验是：chunker 的状态机必须非常谨慎。一个小的状态清理 bug，会在索引系统里被成倍放大。

### 坑 7：旧快照兼容和版本签名必须一起考虑

PDF 支持新增了：

- document type。
- document id。
- locator。
- extraction quality。
- parser version。
- chunker version。

旧快照没有这些字段。如果直接按新类型读取，会出现来源丢失或 chunk 元数据不完整。

实现中用 `normalizePersistedChunk()` 给旧 chunk 补默认值，同时把设置签名加入 parser/chunker 版本。这样当解析策略变化时，系统能识别索引已过期。

经验是：索引快照是派生数据，但它仍然有 schema 演进问题。新增知识载体时必须考虑旧索引如何恢复、何时失效。

### 坑 8：长时间索引需要停止和清理能力

PDF 加入后，默认索引整个 Vault 的风险变高。用户可能无意中把大量 PDF 加入索引，导致长时间解析和 embedding。

后续 issue 中补了停止索引和清除索引按钮。虽然不属于 Issue 36 的前三个里程碑，但它是 PDF 支持后自然暴露出来的容量治理问题。

经验是：一旦知识载体从轻量 Markdown 扩展到 PDF，就要把“停止、清理、限制、可见进度”当成基础体验，而不是高级功能。

## 后续修复记录：发布检查到 PDF 真正可用

初版 PDF 支持完成后，后续发布检查和真实 Obsidian 运行环境又暴露出一组更隐蔽的问题。这些问题不在 PDF 文本恢复算法本身，而集中在 pdf.js 的打包方式、Obsidian 自带 PDF 预览器的全局状态，以及索引中断后的 UI 状态恢复。

### 1. 发布检查触发的 pdf.js 升级

Obsidian 插件发布检验提示 `pdfjs-dist` 存在潜在漏洞 advisory。为了修复依赖 warning，将 `pdfjs-dist` 升级到了 `4.2.67`。

这个升级带来两个连锁变化：

- pdf.js 4.x 的 `pdf.mjs` 使用 top-level await。
- `pdf.worker.mjs` 在模块加载时会写入 `globalThis.pdfjsWorker`。

插件本身是 esbuild 打包成 CommonJS 的 Obsidian 插件，目标环境是 `es2018`。这意味着不能简单地把 pdf.js 4.x 当成普通同步 ESM 依赖打包进 `main.js`。

### 2. 第一次修复：绕开发布检查里的动态 script 问题

最开始为了让 pdf.js worker 能在插件里工作，尝试过通过 worker URL 或运行时注入方式接入 worker。发布检查报错：

```text
Found 1 dynamic <script> element creation
```

这类实现会被 Obsidian 视为高风险，因为动态创建 script 可能加载和执行任意外部代码。最终方向改成：不在运行时创建 script，也不通过外部 worker 文件 URL 加载，而是把 pdf.js worker 一起打包进插件，并通过内存里的 loopback port 让 pdf.js 主线程 API 和 worker handler 通信。

这个判断是正确的，但第一版实现还不完整，后面继续踩到了两个 pdf.js 运行时坑。

### 3. 第二次问题：插件污染了 Obsidian 自带 PDF 预览器

真实运行时出现了这样的控制台错误：

```text
PDF.js v5.3.34
The API version "5.3.34" does not match the Worker version "4.2.67".
```

这不是 Vault Coach parser 自己报的错，而是 Obsidian 自带 PDF 预览器报的错。根因是插件引入的 `pdfjs-dist` worker 覆盖了全局 `pdfjsWorker`，导致 Obsidian 自带的 PDF.js 5.3.34 API 拿到了插件打包进去的 4.2.67 worker。

一开始的问题来自显式写入：

```ts
window.pdfjsWorker = pdfjsWorker;
```

后来虽然删掉了这段显式赋值，但问题仍然存在，因为 `pdfjs-dist/build/pdf.worker.mjs` 自身在模块加载时包含：

```js
var __webpack_exports__ = globalThis.pdfjsWorker = {};
```

也就是说，只要导入 `pdf.worker.mjs`，即使插件代码没有显式写 `window.pdfjsWorker`，worker 模块仍然会污染 Obsidian 的全局 PDF.js worker。

最终修复放在 `esbuild.config.mjs` 里：构建时 patch `pdf.worker.mjs`，把全局赋值改成本地导出对象。

```js
var __webpack_exports__ = {};
```

这样 worker handler 仍然能被插件内部使用，但不会写入 `globalThis.pdfjsWorker`，也就不会再影响 Obsidian 自带 PDF 预览器。

### 4. 第三次问题：错误 patch top-level await 导致 `PDFWorker is not a constructor`

修掉全局污染后，PDF parser 又出现：

```text
TypeError: t.PDFWorker is not a constructor
```

这个错误一开始容易误判为动态 import 返回的模块形态不对，比如 API 被包在 `default` 里。后来用一个最小 smoke test 复现后，发现真正原因在 `pdf.mjs` 的 top-level await 补丁。

pdf.js 原始代码末尾大致是：

```js
__webpack_exports__ = globalThis.pdfjsLib = await (globalThis.pdfjsLibPromise = __webpack_exports__);
```

为了让 esbuild 以 `es2018` 目标打包，曾经把它粗暴改成同步赋值：

```js
__webpack_exports__ = globalThis.pdfjsLib = __webpack_exports__;
```

这个补丁能让构建通过，但语义错了。`__webpack_exports__` 在这里仍然可能是异步初始化过程中的 Promise 或 promise-like module，结果 `PDFWorker` 不是最终的 class，自然就会出现 `PDFWorker is not a constructor`。

最终修复不是把异步语义抹掉，而是把它显式暴露成可等待的 default export：

```js
var __vaultCoachPdfJsLibPromise = Promise.resolve(__webpack_exports__);
export { __vaultCoachPdfJsLibPromise as default };
```

然后在 `src/pdf-document-parser.ts` 中做模块归一化：

- 如果动态 import 结果本身就是 pdf.js API，就直接使用。
- 如果 `default` 是 Promise，就 `await` 后再使用。
- 如果存在 `pdfjsLibPromise`，也等待它。
- 只有确认存在 `getDocument` 和可构造的 `PDFWorker` 后，才进入 PDF 解析。

这个修复保留了 pdf.js 4.x 的真实初始化流程，同时满足 Obsidian 插件的 CommonJS 打包约束。

### 5. 最终 worker 方案：私有 loopback worker

最后稳定下来的 PDF 解析路径是：

```text
dynamic import pdf.js API
→ await pdf.js 初始化 Promise
→ dynamic import patched pdf.worker.mjs
→ WorkerMessageHandler.initializeFromPort(loopbackPort)
→ new PDFWorker({ port })
→ getDocument({ worker })
```

这里的关键是 `PdfJsLoopbackPort`。它实现了 pdf.js 需要的最小 message port 接口：

- `postMessage`
- `addEventListener("message", ...)`
- `removeEventListener("message", ...)`
- `terminate`

这样 PDF parsing 仍然走 pdf.js 的 worker handler 逻辑，但整个通信发生在插件内部的内存消息队列中，不依赖浏览器真实 Worker 文件，也不需要全局 `pdfjsWorker`。

同时在 parser 的 `finally` 中做双层清理：

```ts
try {
  await loadingTask.destroy();
} finally {
  pdfWorker.destroy();
}
```

这样即使 PDF loading task 销毁过程抛错，私有 worker 也会被释放。

### 6. 索引中断后的 UI 锁死

测试中还发现一个和 PDF 解析并行暴露的交互问题：用户手动停止索引后，问答输入框、重置会话、重建索引等按钮可能保持禁用状态。

控制台里会出现：

```text
VaultCoach index build aborted by user.
```

这个异常本身是预期的 abort 信号，但 UI 的 busy 状态没有完整恢复。修复方式是在 `handleRebuildIndex()` 的 `finally` 中统一：

- `this.isBusy = false`
- `this.refresh()`
- 如果当前是问答模式，则重新 focus 输入框

经验是：对用户主动 abort 的流程，不能只把它当异常吞掉。它应该进入完整的状态收尾逻辑，否则长任务停止后 UI 会看起来像插件挂死。

### 7. 验证方式升级

这轮问题说明，单纯 `npm run build` 和 `npm run lint` 不足以证明 PDF 支持真的可用，因为构建能过但运行时仍可能拿到错误形态的 pdf.js API。

最后增加了几类验证：

```text
npm run build
npm run lint
```

产物扫描：

```text
main.js 中不能出现 globalThis/window/self.pdfjsWorker = {}
main.js 中不能出现 document.createElement("script")
```

真实 PDF smoke test：

```text
pages 3 page1Items 401 page1Chars 861 globalWorker undefined
```

这个 smoke test 的意义是同时验证三件事：

- `PDFWorker` 是可构造对象。
- `getTextContent()` 能从真实 PDF 页面拿到文本。
- 执行前后没有写入 `globalThis.pdfjsWorker`。

经验是：第三方 ESM 库被打包进 Obsidian 插件时，必须验证“构建产物的运行语义”，不能只验证源码层面的类型和 lint。

## 最终效果

实现完成后，Vault Coach 的知识库底座从 Markdown-only 变成了多文档架构：

- Markdown 仍然按 heading-aware 方式索引。
- 文本型 PDF 可以通过 native text parser 进入同一套 RAG pipeline。
- PDF parser 使用插件私有 pdf.js worker，不污染 Obsidian 自带 PDF 预览器。
- 向量存储独立于知识库文本索引。
- PDF 来源可以显示页码并跳转。
- 扫描型 PDF 会被识别为低质量或等待 OCR，而不是静默失败。
- 索引被用户手动停止后，UI 能恢复可操作状态。
- 后续 Zotero、OCR、视觉摘要都可以继续复用 `ParsedDocument` 模型。

## 面试讲法

如果面试官问“你是怎么支持 PDF 的”，不要只回答“用了 pdfjs-dist”。

更好的回答是：

> 我先把原来 Markdown 专用的知识库拆成三层：文档解析层、统一 chunk 层和向量存储层。PDF parser 只负责把 PDF native text 转成 `ParsedDocumentBlock`，后面的关键词索引、embedding、hybrid retrieval、rerank 和来源展示都复用原来的 RAG pipeline。这样首版支持文本型 PDF，同时为后续 OCR、视觉摘要和 Zotero 留出了接口。

如果继续追问“为什么不直接转 Markdown”，可以回答：

> 默认转 Markdown 会产生第二份内容源，容易重复索引，也会污染用户 Vault。PDF 原文件应该是唯一事实来源，解析结果作为派生缓存进入索引。用户需要检查时，可以提供解析预览或按需导出 Markdown，但不把导出文件当内部索引源。

如果追问“为什么不用向量数据库”，可以回答：

> PDF Beta 阶段真正的问题是解析质量、页码来源和索引体积，不是 ANN 检索。引入外部向量数据库会提高部署成本，也影响 Obsidian 插件的轻量和跨平台目标。所以我先抽象 `VectorStore`，用 `Float32Array` 和二进制分片实现内置精确检索；以后如果真实数据证明规模瓶颈存在，可以替换为 ANN 或外部后端。
