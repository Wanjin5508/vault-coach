



## 可以解决，而且根因很明确

Issue #46 不是“Advanced RAG 不够高级”，而是当前链路缺少一个独立的 **relevance gate（相关性准入层）**。

目前 Issue 描述的问题是：用户设置来源上限为 5 后，插件会尽量列出 5 个来源，即使后面的 chunk 已经明显不相关。citeturn777615view0

当前 `prepareAnswer()` 的实际流程是：

```text
召回候选
  ↓
rerank 排序
  ↓
直接取前 contextTopK 个作为上下文
  ↓
从全部 rerank 结果中取前 answerSourceLimit 个作为来源
```

当前 master 分支仍然是先对 `rerankedCandidates` 执行 `slice(0, contextTopK)`，然后又直接用全部 `rerankedCandidates` 构建来源，没有经过相关性过滤。citeturn871621view0

你上传的代码里，`buildAnswerSources()` 也只做了两件事：

1. 按文件和 heading 去重；
2. 达到 `answerSourceLimit` 后停止。

它没有判断候选是否足够相关。fileciteturn2file0

---

# 一、为什么 rerank 不能单独解决

rerank 解决的是：

> 这些候选谁排在前面？

Issue #46 真正需要解决的是：

> 这些候选是否应该被接受？

即使 reranker 给出的排序完全正确：

```text
chunk A：很相关
chunk B：一般相关
chunk C：不太相关
chunk D：完全无关
chunk E：完全无关
```

只要代码继续执行：

```ts
candidates.slice(0, 5);
```

仍然会得到 5 个结果。

所以必须把 **排序** 和 **过滤** 分开：

```text
Retrieve：尽量不漏掉相关内容
Rerank：把最相关的排在前面
Relevance gate：剔除不够相关的内容
Context selection：控制进入 prompt 的数量
Citation selection：决定展示哪些来源
```

---

# 二、首先修复一个明显的来源一致性问题

当前代码是：

```ts
const finalContextCandidates =
    rerankedCandidates.slice(0, settings.contextTopK);

const sources =
    this.buildAnswerSources(rerankedCandidates, answerLanguage);
```

这里存在一个逻辑问题：

> 展示给用户的来源，可能并没有被放进最终 prompt。

例如：

```text
contextTopK = 3
answerSourceLimit = 5
```

模型只看到了前三个 chunk，但插件可能展示五个来源。第四和第五个来源理论上没有参与回答生成。

最少应该改成：

```ts
const finalContextCandidates: RerankedCandidate[] =
    rerankedCandidates.slice(0, settings.contextTopK);

const sources: AnswerSource[] =
    this.buildAnswerSources(finalContextCandidates, answerLanguage);
```

这样至少可以保证：

```text
展示来源 ⊆ 模型实际看到的上下文
```

但这只是最低限度的修复，还没有彻底解决无关 chunk。

---

# 三、正确方案：增加 relevance gate

推荐把 `prepareAnswer()` 改成：

```ts
const rerankedCandidates: RerankedCandidate[] =
    await this.rerankCandidates(retrievalQuery, candidates);

const relevantCandidates: RerankedCandidate[] =
    this.filterRelevantCandidates(
        retrievalQuery,
        rerankedCandidates,
    );

if (relevantCandidates.length === 0) {
    return {
        promptMessages: [],
        sources: [],
        rerankedCandidates: [],
        retrievalModeUsed,
        rewriteResult,
        originalUserText: userText,
        noCandidates: true,
    };
}

const finalContextCandidates: RerankedCandidate[] =
    relevantCandidates.slice(0, settings.contextTopK);

const sources: AnswerSource[] =
    this.buildAnswerSources(
        finalContextCandidates,
        answerLanguage,
    );
```

这样：

```text
answerSourceLimit = 最大来源数量
```

而不是：

```text
answerSourceLimit = 必须凑齐的来源数量
```

最终可能返回：

```text
0、1、2、3、4 或 5 个来源
```

这是合理行为。

---

# 四、怎样判断一个 chunk 是否“足够相关”

不能只使用一个固定的 `finalScore > 0.5`，因为你现在的三种分数并不在同一个尺度上：

| 分数 | 含义 |
|---|---|
| `keywordScore` | TF-IDF 风格关键词分数 |
| `vectorScore` | 余弦相似度 |
| `retrievalScore` | Hybrid 模式下可能是 RRF 分数 |
| `rerankScore` | 远程 reranker 或本地启发式分数 |
| `finalScore` | 多种分数混合后的排序分数 |

尤其是 RRF：

```ts
1 / (60 + rank)
```

它主要表达排名，不适合直接解释成“相关概率”。

建议 relevance gate 同时判断三个方面。

## 1. 与第一名的相对差距

```ts
candidate.finalScore >= topScore * 0.55
```

例如：

```text
第一名：0.82
第二名：0.75
第三名：0.69
第四名：0.21
第五名：0.18
```

相对阈值可以自然地排除第四、第五名。

## 2. 是否存在真实检索证据

至少满足一种：

```text
关键词覆盖率足够高
向量相似度足够高
同时被 keyword 和 vector 召回
远程 reranker 分数超过阈值
```

## 3. 绝对最低门槛

只使用相对阈值有一个问题：

```text
所有候选都不相关时，第一名仍然是第一名。
```

所以仍然需要某种绝对门槛，例如：

```text
vectorScore >= minVectorSimilarity
remote rerankScore >= minRerankScore
keyword token coverage >= minKeywordCoverage
```

---

# 五、可直接采用的初版实现

下面的数值适合作为第一轮测试值，不应该视为所有 embedding 和 rerank 模型通用的最终阈值。

```ts
private filterRelevantCandidates(
    query: string,
    candidates: RerankedCandidate[],
): RerankedCandidate[] {
    if (candidates.length === 0) {
        return [];
    }

    const settings: VaultCoachSettings = this.getSettings();

    const topScore: number = candidates[0]?.finalScore ?? 0;
    const queryTokens: string[] = Array.from(
        new Set(this.tokenize(query)),
    );

    const useRemoteRerank: boolean =
        settings.enableRerank
        && settings.rerankBaseUrl.trim().length > 0
        && settings.rerankModel.trim().length > 0;

    return candidates.filter((candidate: RerankedCandidate) => {
        /*
         * 条件一：候选分数不能与第一名相差太大。
         */
        const passesRelativeThreshold: boolean =
            topScore <= 0
                ? candidate.finalScore >= topScore
                : candidate.finalScore >= topScore * 0.55;

        if (!passesRelativeThreshold) {
            return false;
        }

        /*
         * 条件二：关键词证据。
         */
        const keywordCoverage: number =
            queryTokens.length === 0
                ? 0
                : candidate.matchedTokens.length / queryTokens.length;

        const hasKeywordEvidence: boolean =
            keywordCoverage >= 0.2;

        /*
         * 条件三：向量证据。
         *
         * 0.35 只是初始测试值，需要根据实际 embedding
         * 模型和测试集调整。
         */
        const hasVectorEvidence: boolean =
            (candidate.vectorScore ?? -1) >= 0.35;

        /*
         * 条件四：两个召回通道同时命中。
         */
        const hasChannelAgreement: boolean =
            candidate.retrievalChannels.includes("keyword")
            && candidate.retrievalChannels.includes("vector");

        /*
         * 条件五：独立 reranker 判断。
         *
         * relevance_score 的分布依赖具体模型，
         * 0.15 同样只是初始校准值。
         */
        const hasRemoteRerankEvidence: boolean =
            useRemoteRerank
            && candidate.rerankScore >= 0.15;

        return (
            hasKeywordEvidence
            || hasVectorEvidence
            || hasChannelAgreement
            || hasRemoteRerankEvidence
        );
    });
}
```

这里最重要的不是 `0.35` 或 `0.15` 本身，而是架构上明确区分了：

```text
排序分数
```

和：

```text
准入条件
```

---

# 六、阈值不建议直接暴露给普通用户

Vault Coach 允许用户自行更换 embedding 和 rerank 模型，不同模型的分数分布可能不同。因此不建议在设置页直接展示：

```text
最低余弦相似度：0.37
最低 rerank 分数：0.18
```

普通用户很难理解，也很容易调坏。

更合适的 UI 是：

```text
检索严格度：
- 宽松
- 平衡
- 严格
```

内部映射成不同参数：

```ts
const RELEVANCE_PROFILES = {
    lenient: {
        relativeScoreRatio: 0.40,
        minVectorSimilarity: 0.30,
        minKeywordCoverage: 0.10,
    },
    balanced: {
        relativeScoreRatio: 0.55,
        minVectorSimilarity: 0.35,
        minKeywordCoverage: 0.20,
    },
    strict: {
        relativeScoreRatio: 0.70,
        minVectorSimilarity: 0.45,
        minKeywordCoverage: 0.30,
    },
};
```

但第一版甚至不必开放 UI，可以先使用内部常量，通过测试集校准。

---

# 七、更严格的来源方案：让模型声明使用了哪些 chunk

即使经过 relevance gate，当前的来源含义仍然只是：

> 这些 chunk 被放进了模型上下文。

它并不能严格证明：

> 模型回答实际使用了每一个 chunk。

若以后希望做到真正的 citation，可以给每个上下文分配 ID：

```text
[S1] RAG/embedding.md
[S2] RAG/rerank.md
[S3] RAG/chunking.md
```

要求模型在回答中引用：

```text
向量检索使用 embedding 计算语义相似度。[S1]
```

然后解析实际出现的 ID：

```ts
const usedSourceIds: Set<string> =
    this.extractUsedSourceIds(answerText);
```

最后只展示这些来源：

```ts
const sources = finalContextCandidates
    .filter((_, index) => usedSourceIds.has(`S${index + 1}`))
    .map(...);
```

不过本地小模型对格式约束的遵循并不总是稳定，因此建议采用：

```text
relevance gate
    +
模型 citation ID
    +
解析失败时回退到 filtered context sources
```

而不是完全依赖模型自己选来源。

---

# 八、推荐按两个版本实现

## Issue #46 的第一阶段修复

改动小，风险低：

1. `answerSourceLimit` 明确作为上限；
2. 来源只从 `finalContextCandidates` 构建；
3. 增加 `filterRelevantCandidates()`；
4. 过滤后为空则返回“未检索到足够相关内容”；
5. 增加分数调试日志。

核心链路：

```text
retrieve
→ rerank
→ relevance filter
→ contextTopK
→ sourceLimit
```

## 后续增强

增加真正的 citation：

```text
模型输出 source IDs
→ 插件解析使用过的 IDs
→ 只展示实际引用来源
```

---

# 九、必须增加的测试用例

| 场景 | 预期结果 |
|---|---|
| 来源上限为 5，但只有 1 个强相关 chunk | 只展示 1 个 |
| 有 3 个相关、5 个无关 chunk | 只展示 3 个 |
| 所有 chunk 都不相关 | 0 个来源，并提示信息不足 |
| `contextTopK = 3`、`answerSourceLimit = 5` | 来源最多 3 个 |
| 同一 heading 命中多个 chunk | 去重后只展示一次 |
| 远程 rerank 失败 | 启发式过滤仍能工作 |
| keyword/vector/hybrid 三种模式 | 都不会机械填满来源 |
| 修改严格度 | 来源数量随严格度合理变化 |

---

## 最终判断

这个 Issue 完全有办法解决，而且不需要更换整个 RAG 架构。

最关键的修改不是“使用更强的 rerank 模型”，而是：

> 在 rerank 后增加独立的相关性过滤，并把来源数量从目标值改成真正的最大值。

另外，应同步修复“来源可能未进入模型上下文”的问题。建议将 Issue #46 定义为 **RAG correctness bug**，而不仅是普通 UX 优化。