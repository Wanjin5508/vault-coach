我查下来之后，Vault Curate 对你很有参考价值，甚至比 Copilot、Smart Connections 更值得研究，因为它和 Vault Coach **几乎同期进入市场、开发者也是个人开发者、都做本地知识库检索，而且都面向中文用户**。

但现在两者数据已经明显分化：Vault Curate 当前约 **6k downloads、31 次 release、约 130 GitHub stars**，创建约 6 个月；Vault Coach 当前约 **484 downloads、19 次 release**，创建约 7 个月。也就是说，这次已经不能主要用“老插件时间复利”解释了。([Obsidian Community](https://community.obsidian.md/plugins/vault-curate?utm_source=chatgpt.com "Vault Curate - Obsidian Plugin"))

我的判断是：

> **Vault Curate 并不是靠某一次成功宣传获得 6000 下载，而是产品定位、零配置体验、中文垂直优势、内容营销、社区运营和高频迭代叠加后的结果。**

而其中有几件事情，你几乎可以原样学习。

---

# 一、先看他到底是怎么宣发 Vault Curate 的

我能查到的公开传播轨迹很完整。

## 1. 他在产品出现之前，就先“经营问题”

这是最值得你注意的一点。

Jacob Mei 自己有一个长期维护的个人博客，目前网站列出了 **359 篇文章**。2026 年 Vault Curate 发布前，他并不是突然写一篇：

> “我开发了一个 Obsidian 插件，请大家下载。”

而是从 **繁体中文搜索本身**开始连续写。

公开时间线大致是：

```text
3 月 20 日
繁体中文全文搜索引擎实战（一）
繁体中文全文搜索引擎实战（二）
繁体中文全文搜索引擎实战（三）

3 月 23 日
繁体中文搜索预处理工具 trad-zh-search 开源

4 月 4 日
繁体中文专用 Obsidian 语义搜索插件 Vault Curate

4 月 27 日
繁体中文全文搜索引擎实战（四）
Hit@1 从 39% → 64%

5 月 18 日
Vault Curate：工具帮你看见，不帮你思考
```

这不是普通广告。

这是：

> **Problem content → Technical proof → Product solution**

的完整内容漏斗。([小梅子 / Jacob Mei Labs](https://jacobmei.com/blog/?utm_source=chatgpt.com "文章列表 | 小梅子 / Jacob Mei Labs"))

所以读者第一次看到 Vault Curate 时，可能已经知道：

> 中文搜索确实存在问题。

甚至已经相信：

> 这个作者真的研究过中文检索。

这和你直接告诉用户：

> “Vault Coach 使用 Advanced RAG。”

心理效果完全不同。

---

# 二、他的第一篇产品文章几乎完全从用户痛点开始

2026 年 4 月 4 日的文章开头非常典型。

他没有先介绍 RAG，而是讲：

> 自己积累了上千篇笔记，明明记得写过一个想法，却因为想不起原来的关键词而找不到。

然后举一个极容易理解的例子：

> 搜“财务”，找不到标题叫“预算规划”的笔记。

再指出现有方案的问题：

> Smart Connections 很好，但中文 embedding 效果不够理想；其他工具又太重，包含自己不需要的 Chat 功能。

最后才自然引出：

> 所以自己做了一个插件。

整篇文章核心产品描述只有一句：

> **用你想表达的“意思”搜索笔记，不只是关键词。**

([小梅子 / Jacob Mei Labs](https://jacobmei.com/blog/2026/0404-n6nst4/ "繁體中文專用 Obsidian 語意搜尋插件 Vault Curate | 小梅子 / Jacob Mei Labs"))

你会发现它比：

> Hybrid retrieval + Embedding + RRF + rerank

有效得多。

因为任何 Obsidian 用户都能在两秒内理解：

> “噢，就是我忘记原来用了什么词的时候，也能找到。”

---

# 三、他同时占领了中文和英文 Obsidian 社区

这是第二个非常重要的渠道策略。

### 中文论坛

5 月 18 日，他在 Obsidian 中文论坛发帖。

标题不是：

> Vault Curate v1.5 Release

而是：

> **中文友善的 Obsidian 语意搜寻外挂**

正文第一句话又是：

> 用“意思”搜笔记，不只是关键词，而且对中文友善。

然后马上突出：

> 内置 `bge-small-zh-v1.5`

> Built-in WebGPU

> 零配置

> Hot/Cold Rediscovery

([Obsidian 中文论坛](https://forum-zh.obsidian.md/t/topic/61655 "〖插件發布〗Vault Curate 1.5 — 中文友善的 Obsidian 语意搜寻外挂（桌机/手机 , 本地 WebGPU + AI 整理层，皆 opt-in） - 开发讨论 - Obsidian 中文论坛"))

### 英文官方论坛

仅仅几天后，5 月 21 日又发布英文帖：

> Vault Curate - search + discover plugin built around CJK notes

但内容不是简单把中文稿翻译成英文。

英文用户的切入口变成了两个问题：

> Built-in search cannot handle my Traditional Chinese/private vocabulary/domain terminology well.

以及：

> I have hundreds of notes that I no longer remember writing.

([Obsidian Forum](https://forum.obsidian.md/t/vault-curate-search-discover-plugin-built-around-cjk-notes/114527 "Vault Curate - search + discover plugin built around CJK notes - Plugins - Obsidian Forum"))

这说明他做得很好的一点是：

**同一个产品，不同社区使用不同的问题切入。**

这正是你目前可以提高的地方。

---

# 四、他没有把论坛当成“发广告的地方”，而是当成产品开发现场

这一点我认为甚至比曝光本身更重要。

看他的中文帖子会发现一个很明显的模式。

用户 5 月 21 日提出：

- hover preview；
    
- 锁定当前文档。
    

几个小时后开发者回复。

**当天就发布了 v1.0.3：**

- 加 Hover Preview；
    
- 加 Pin Discover。
    

([Obsidian 中文论坛](https://forum-zh.obsidian.md/t/topic/61655 "〖插件發布〗Vault Curate 1.5 — 中文友善的 Obsidian 语意搜寻外挂（桌机/手机 , 本地 WebGPU + AI 整理层，皆 opt-in） - 开发讨论 - Obsidian 中文论坛"))

后来用户又提出：

> 要不要增加关联图？

开发者最初说要评估。

结果到 7 月 7 日：

> “你在 #10 许愿的关联图做出来了。”

然后直接在原帖子回复新版本、截图、功能解释。([Obsidian 中文论坛](https://forum-zh.obsidian.md/t/topic/61655 "〖插件發布〗Vault Curate 1.5 — 中文友善的 Obsidian 语意搜寻外挂（桌机/手机 , 本地 WebGPU + AI 整理层，皆 opt-in） - 开发讨论 - Obsidian 中文论坛"))

后来继续：

```text
用户反馈
 ↓
开发者讨论
 ↓
功能开发
 ↓
回到原帖 @ 用户
 ↓
截图展示
 ↓
新用户看到活跃项目
 ↓
更多反馈
```

形成了非常典型的 Community Development Loop。

这实际上也是宣发。

因为每次更新都会重新把帖子推上论坛。

而且潜在用户看到的不是：

> “开发者说自己的插件很好。”

而是：

> “有人真的在用 → 提问题 → 开发者真的改了。”

这种社会证明非常强。

---

# 五、他还在 Reddit 用了一种非常聪明的“非广告式推广”

这一点尤其值得学习。

有一个 Reddit 用户讨论：

> 用 Obsidian 做数字收藏/curation 是否合适？

Jacob 没有直接贴：

> “Try my plugin!”

而是先给了一大段真正有帮助的建议：

- migration 应该脚本化；
    
- capture friction 很重要；
    
- 不要过度分类；
    
- 最大的问题是几百篇以后，你会忘记自己保存过什么。
    

最后才 disclosure：

> 我后来正是因为这个问题做了 Vault Curate。

([Reddit](https://www.reddit.com/r/ObsidianMD/comments/1ua8qxr/obsidian_for_curation_is_a_bad_idea/?utm_source=chatgpt.com "Obsidian for curation is a bad idea?"))

这是非常标准而且很有效的社区营销：

```text
Answer the problem
      ↓
Demonstrate expertise
      ↓
Mention product only when relevant
```

而不是：

```text
Here is my product
please download
```

尤其 Reddit r/ObsidianMD 在 2026 年已经明确强调反对开发者只来做自我推广。([Reddit](https://www.reddit.com/r/ObsidianMD/comments/1s8nt0m/if_your_first_post_is_to_promote_your_app_you/?utm_source=chatgpt.com "If your first post is to promote your app, you will be banned."))

所以这种方式不仅效果更好，也更符合社区规则。

---

# 六、他有自己的“内容分发基础设施”

这个因素不要低估。

他的个人博客已经有几百篇文章，并且有 RSS；首页长期写 AI、搜索、Obsidian、知识管理等相关内容。([小梅子 / Jacob Mei Labs](https://jacobmei.com/ "小梅子 / Jacob Mei Labs"))

7 月他又做了一篇：

> Notoriouslab GitHub 开源项目总览

其中继续展示 Vault Curate。当时文章记录的数据已经是：

> GitHub ★136  
> Obsidian 下载 4,500+

([小梅子 / Jacob Mei Labs](https://jacobmei.com/blog/2026/0726-osslab/?utm_source=chatgpt.com "Notoriouslab Github 開源專案總覽 | 小梅子 / Jacob Mei Labs"))

也就是说产品不是发布一次就结束，而是在：

```text
个人博客
↓
技术文章
↓
开源项目汇总
↓
论坛
↓
GitHub
↓
Reddit
```

持续获得入口。

至于 X、Facebook、LinkedIn 等渠道，我没有找到足够可靠的 Vault Curate 专门宣发记录，因此不应该把这些算作主要增长来源。

---

# 七、但仅靠宣发还解释不了 6000 下载

真正重要的还是产品。

Vault Curate 做了一个很聪明的市场切口：

> **不是“AI for Obsidian”，而是“Obsidian 搜索不好用，尤其是中文”。**

这是一个极其直接的问题。

当前产品页面直接列出几个场景：

> 大致记得写过，但忘了关键词。

> 几篇相关笔记散落各处。

> 几年前写的笔记已经忘了存在。

([Obsidian Community](https://community.obsidian.md/plugins/vault-curate?utm_source=chatgpt.com "Vault Curate - Obsidian Plugin"))

这些问题对 Obsidian 用户来说都有一个共同特点：

**不需要用户先理解为什么自己需要它。**

---

# 八、最关键的竞争优势：它几乎没有首次使用门槛

这与你刚才决定给 Vault Coach 做内置 embedding 完全吻合。

Vault Curate 最初其实也需要 Ollama。

开发者自己明确写过：

> 以前需要先装 Ollama 做 embedding，但这就是一个门槛。

后来改成：

```text
Install
 ↓
Enable
 ↓
Welcome
 ↓
Built-in embedding
 ↓
Download ~110 MB
 ↓
Index
 ↓
Search
```

默认使用：

> `bge-small-zh-v1.5`

通过 WebGPU/WASM 本地运行。

**不需要 Ollama，不需要 API key，不需要用户理解 embedding 是什么。**

([小梅子 / Jacob Mei Labs](https://jacobmei.com/blog/2026/0518-1g8vmf/ "Vault Curate：工具幫你看見，不幫你思考 | 小梅子 / Jacob Mei Labs"))

这实际上正好验证了我们上一轮对 Vault Coach 的判断。

现在你的 Quick Start 仍然要求用户理解：

- chat provider；
    
- embedding provider；
    
- embedding model；
    
- rebuild index；
    
- Keyword / Vector / Hybrid。
    

官方页面甚至还明确告诉用户：

> “Enable vector retrieval only after configuring an embedding provider.”

([Obsidian Community](https://community.obsidian.md/plugins/vault-coach "Vault Coach - Obsidian Plugin"))

Vault Curate 则是：

> **装完直接搜。**

这是非常大的 Activation 差异。

---

# 九、他还选中了一个非常好的“楔子市场”：中文搜索

Vault Curate 并没有一开始说：

> 世界上最好的 semantic search plugin。

而是：

> **中文尤其好。**

具体甚至细化到：

- 中文人名；
    
- 专有名词；
    
- 宗教词；
    
- 口语；
    
- 繁体/简体字符差异。
    

开发者还用自己的真实 Vault 做 A/B testing 和性能 benchmark。某次版本甚至专门针对：

> 規劃/規画  
> 臺北/台北  
> 計劃/計畫

这种繁中搜索问题优化。([GitHub](https://github.com/notoriouslab/vault-curate/releases?utm_source=chatgpt.com "Releases · notoriouslab/vault-curate · GitHub"))

于是它形成了非常容易传播的产品标签：

> **如果你有中文 Obsidian Vault，就试 Vault Curate。**

这是一种非常好的 wedge strategy。

先占：

> Chinese semantic search

然后再扩：

> Find → Connect → Rediscover。

---

# 十、他后来又做了非常聪明的定位升级

早期：

> Chinese semantic search.

后来他发现产品已经不只是搜索。

于是 v1.3.1 **专门发了一个没有任何功能变化的版本，只改定位和文档。**

Release Note 直接写：

> Positioning & docs release — no functional changes.

然后把整个产品定义成：

> **Find → Connect → Rediscover**

并明确说：

> Vault Curate is a local-first second brain, not just Chinese search.

同时把 marketplace description 改成用户真正会搜索的：

> semantic search  
> related notes  
> relation graph  
> rediscover  
> second brain

([GitHub](https://github.com/notoriouslab/vault-curate/blob/main/CHANGELOG.md?utm_source=chatgpt.com "vault-curate/CHANGELOG.md at main · notoriouslab/vault-curate · GitHub"))

这件事我非常建议你学习。

开发者非常明确地意识到了：

> **产品定位本身值得单独发版本。**

不是只有写代码才算迭代。

---

# 十一、Find → Connect → Rediscover 是非常强的产品表达

今天 Vault Curate 的首页基本围绕三个动词：

### Find

找出已经忘了关键词的笔记。

### Connect

找到语义相关、但尚未建立 wikilink 的内容。

### Rediscover

把几年前已经忘记的笔记重新推到你面前。

([GitHub](https://github.com/notoriouslab/vault-curate?utm_source=chatgpt.com "GitHub - notoriouslab/vault-curate: Find, connect, rediscover your notes — a local-first second brain for Obsidian. Semantic search with strong Chinese/CJK, relation graphs and semantic paths for connections you never drew, Hot/Cold rediscovery of forgotten notes. Desktop builds the index; phones and tablets search it. No API keys. · GitHub"))

这远比：

```text
BM25
+
Embedding
+
Jaro-Winkler
+
RRF
+
HDBSCAN
```

容易记住。

技术栈放到了 README 后半部分。

---

# 十二、它实际上刻意避开了“Chat with your Vault”红海

这个点我觉得非常高明。

作者从最初就明确表达：

> AI 应该帮你重新看见自己的知识，而不是替你思考。

([小梅子 / Jacob Mei Labs](https://jacobmei.com/blog/2026/0518-1g8vmf/ "Vault Curate：工具幫你看見，不幫你思考 | 小梅子 / Jacob Mei Labs"))

所以 Vault Curate **故意没有把 Chatbot 放在核心位置**。

这就避免了与：

- Copilot；
    
- Khoj；
    
- BMO；
    
- Smart Second Brain
    

直接竞争。

它卖的是：

> Search / Discovery / Connection。

用户甚至不需要 LLM。

这也意味着：

> **插件安装之后马上就能产生价值。**

---

# 十三、他的功能会产生非常明显的“Aha Moment”

例如：

用户随便输入：

> “我之前是不是写过关于笔记本上跑量化模型的东西？”

突然搜出来一篇自己两年前的笔记。

Aha。

或者打开一篇笔记：

> Discover → 出现一篇早忘了的旧文章。

Aha。

或者：

> 生成 Canvas → 发现两篇自己从没 link 过的文章其实很相关。

Aha。

这种价值是**一次操作就能感知的**。

---

# 十四、这正是 Vault Coach 目前相对弱的一点

Vault Coach 的价值链更长：

```text
Install
↓
Configure model
↓
Configure embedding
↓
Index
↓
Ask
↓
Exam
↓
Exam history
↓
Concept extraction
↓
Review Concept
↓
Learning Map
↓
Mastery
```

你的终极价值可能更高。

但：

**Aha Moment 更晚。**

用户必须投入更多时间，才能第一次体验：

> “原来它真的知道我哪部分没掌握。”

这就是为什么我之前一直强调：

> Time-to-first-value。

---

# 十五、6000 Downloads 还有一个技术性原因：发布频率

必须把这个因素单独拿出来。

Vault Curate：

> 31 releases

Vault Coach：

> 19 releases

([Obsidian Community](https://community.obsidian.md/plugins/vault-curate?utm_source=chatgpt.com "Vault Curate - Obsidian Plugin"))

而 Obsidian 的 download 并不是独立用户。

官方统计实际上来自 GitHub release 的 `manifest.json` 下载次数；**用户更新一个新版本同样会产生新的 download**。([Obsidian Forum](https://forum.obsidian.md/t/how-are-community-plugin-download-stats-calculated/24725?utm_source=chatgpt.com "How are community plugin download stats calculated? - Devs: Plugins & API - Obsidian Forum"))

因此：

> 6000 downloads ≠ 6000 users。

Vault Curate 高频发布本身会放大累计数字。

例如：

```text
500 active users
×
多次版本更新

≈
几千 cumulative downloads
```

这是完全可能的。

---

# 十六、但 release 数量不能解释全部差距

这一点同样重要。

Vault Curate：

> 31 releases / 6000 downloads

Vault Coach：

> 19 releases / 484 downloads

release 数量只相差：

> **1.6 倍左右**

Downloads 却相差：

> **约 12 倍**

所以即使剔除累计版本下载的放大效应：

**Vault Curate 的真实安装/活跃规模大概率还是明显高于 Vault Coach。**

因此不能只解释成：

> “他更新比较频繁。”

---

# 十七、还有一个不能忽视的因素：作者本身有一定个人影响力

Jacob Mei 并不是一个完全没有网络存在的新开发者。

他的 Obsidian Community profile 显示，他此前长期从事电商、银行数字化、台湾数字金融等工作；个人网站长期发表文章。([Obsidian Community](https://community.obsidian.md/users/notoriouslab?utm_source=chatgpt.com "Jacob Mei (@notoriouslab) - Obsidian Community"))

他的博客也已经积累 359 篇文章。([小梅子 / Jacob Mei Labs](https://jacobmei.com/blog/?utm_source=chatgpt.com "文章列表 | 小梅子 / Jacob Mei Labs"))

所以至少可以合理判断：

> 他拥有比一个全新的匿名 GitHub account 更好的初始内容分发能力和可信度。

但这里需要控制结论：

**我没有找到网站流量、RSS 订阅量、社交媒体粉丝量等数据，因此不能说这就是 6000 downloads 的主要来源。**

我认为它只是助推因素，不是根因。

---

# 十八、如果把 Vault Curate 的增长公式拆出来

我会写成：

```text
非常明确的痛点
「我写过，但找不到」
        ×
明确细分优势
「中文尤其准」
        ×
零配置
「不用 Ollama / API Key」
        ×
即时 Aha Moment
「搜索一次就看到效果」
        ×
个人技术内容
        ×
中英文论坛
        ×
社区互动开发
        ×
高频 release
        ×
Marketplace SEO
```

于是形成现在约 6000 cumulative downloads。

而不是：

```text
因为 RAG 算法很好
→ 6000 downloads
```

事实上，它和你的 RAG 技术并没有数量级上的差距。

---

# 十九、Vault Curate 和 Vault Coach 放在一起看，差异非常明显

||Vault Curate|Vault Coach|
|---|---|---|
|第一问题|“我写过，但找不到”|“我看懂了，但没真正掌握”|
|受众|几乎所有大型 Vault 用户|学习者/研究者|
|首次价值|搜一次即可|通常需要完整学习流程|
|Embedding|内置|目前需配置|
|LLM|非核心，可选|多个核心功能需要|
|核心入口|Search|多功能 Learning System|
|认知成本|低|较高|
|特色楔子|中文/CJK|Exam + Mastery + KG|
|核心 Loop|Find → Connect → Rediscover|Ask → Test → Diagnose → Learn|
|当前 downloads|~6k|~484|
|Releases|31|19|
|GitHub stars|~130|8|

([Obsidian Community](https://community.obsidian.md/plugins/vault-curate?utm_source=chatgpt.com "Vault Curate - Obsidian Plugin"))

这张表其实暴露出了你的真正问题：

> **Vault Coach 产品价值更深，但是表达复杂度也高很多。**

---

# 二十、你最应该直接抄 Vault Curate 的第一件事：内置 Embedding

你前一轮已经决定做。

现在 Vault Curate 等于给了我们一个非常好的现实验证：

> **Transformers.js + WebGPU/WASM + 内置 embedding，在 Obsidian 产品中确实已经经过用户验证。**

它目前使用：

> `@huggingface/transformers`  
> `bge-small-zh-v1.5 q8`  
> ~110 MB  
> WebGPU / WASM

([Obsidian Community](https://community.obsidian.md/plugins/vault-curate?utm_source=chatgpt.com "Vault Curate - Obsidian Plugin"))

于是 Vault Coach 可以变成：

```text
Install
 ↓
Choose Knowledge
 ↓
Configure LLM
 ↓
Ready
```

甚至进一步：

如果用户只想 semantic search：

```text
Install
 ↓
Ready
```

---

# 二十一、第二件值得抄：给 Vault Coach 设计三个动词

Vault Curate：

> **Find → Connect → Rediscover**

Vault Coach 现在应该有一个同级别表达。

我建议：

> **Ask → Test → Improve**

或者我其实更喜欢：

> **Learn → Test → Improve**

进一步展开：

```text
LEARN
Ask your notes.
Understand concepts.
Inspect sources.

↓

TEST
Generate exams.
Answer questions.
Measure mastery.

↓

IMPROVE
Find weak concepts.
Follow prerequisites.
Review what matters next.
```

然后 Knowledge Graph、RAG、Embedding、Mastery 都退到后台。

这会比现在：

> cited RAG + scoped exams + knowledge graph + mastery tracking

容易传播很多。

---

# 二十二、第三件值得抄：开始“经营问题”，不要只经营产品

这是我认为你目前宣发最大的提升空间。

你拥有一个 Vault Curate 开发者没有的渠道：

**你的微信公众号。**

而且已经有以 ML/RL 学习内容为主的受众。

所以完全可以做同样的内容漏斗：

```text
文章 1
为什么 AI 时代“看懂”越来越容易，“学会”反而越来越难？

↓

文章 2
为什么 RAG 能帮你找到答案，却不能证明你掌握了知识？

↓

文章 3
为什么笔记数量不是知识掌握程度？
从 Knowledge Graph 和 Mastery 说起

↓

文章 4
如何让自己的 Obsidian 知识库给自己出考试？

↓

Vault Coach
```

这样你的产品不是突然出现。

读者会经历：

> 认识问题 → 接受问题 → 理解方法 → 发现工具。

这就是 Jacob Mei 在 Vault Curate 上做得非常好的事情。

---

# 二十三、论坛也应该学习他的运营方式

你现在已经有 Vault Coach 英文主帖。([Obsidian Forum](https://forum.obsidian.md/t/vault-coach-i-built-an-obsidian-plugin-to-solve-a-growing-ai-era-problem-i-understand-it-when-i-see-it-but-i-haven-t-really-learned-it/118567?utm_source=chatgpt.com "[Vault Coach] I Built an Obsidian Plugin to Solve a Growing AI-Era Problem: “I Understand It When I See It, but I Haven’t Really Learned It” - Plugins - Obsidian Forum"))

不要再新开帖子。

后续应该类似 Vault Curate：

```text
1.5 released

The biggest change:
You no longer need an embedding provider.

Vault Coach now includes
a built-in local embedding model.

Install
→ configure your LLM
→ start learning
```

附一张 Setup GIF。

再下个版本：

```text
1.6 released

Vault Coach can now identify
which concepts you repeatedly get wrong.
```

再附 Dashboard。

不要只是：

> Added X / Fixed Y。

每一个 Release 都应该重新讲一个用户问题。

---

# 二十四、还有一个特别值得学习的小细节

Vault Curate 的作者经常写：

> “我自己 dogfood。”

并且给出真实数字：

> 342 notes  
> 5004 chunks  
> M2 MacBook Air  
> 1m23s

([Obsidian Forum](https://forum.obsidian.md/t/vault-curate-search-discover-plugin-built-around-cjk-notes/114527 "Vault Curate - search + discover plugin built around CJK notes - Plugins - Obsidian Forum"))

甚至会写：

> 在 2500-note 的真实 Vault 中测试发现……

([Obsidian 中文论坛](https://forum-zh.obsidian.md/t/topic/61655 "〖插件發布〗Vault Curate 1.5 — 中文友善的 Obsidian 语意搜寻外挂（桌机/手机 , 本地 WebGPU + AI 整理层，皆 opt-in） - 开发讨论 - Obsidian 中文论坛"))

这建立了一种非常强的可信度：

> **作者真的每天使用自己的工具。**

Vault Coach 以后也应该公开：

```text
My test vault:
312 Markdown notes
47 PDFs
18,420 chunks
xxx concepts
xxx confirmed relations

Initial indexing:
xx seconds

Exam generation:
xx seconds

Learning Map:
xx nodes
```

比：

> Advanced RAG

有说服力得多。

---

# 最后我的判断

Vault Curate 这 6000 Downloads **并不是因为作者做了比你强一个数量级的 RAG 系统**。

真正领先的是产品化和传播：

> **他先找到了一个人人都理解的问题，再做了一个几乎零配置的解决方案，然后不断用技术文章证明这个问题、用社区用户验证这个问题、用高频迭代让用户参与产品形成。**

而 Vault Coach 恰好相反：

> **你已经做出了一个技术上更复杂、甚至潜在价值更深的系统，但用户需要花更长时间才能理解“为什么我要这个东西”。**

所以这次研究 Vault Curate 之后，我会更坚定之前给你的两个建议：

**第一，1.5 优先做内置 embedding，把配置压缩到只剩 LLM。**

**第二，不要再主要宣传“RAG + Exam + KG + Mastery”这四项技术/功能，而要把 Vault Coach 压缩成一个极容易传播的闭环：**

> **Learn → Test → Improve**

下面一句：

> **Vault Coach turns the notes you already have into a learning system that shows what you know—and what to review next.**

我认为这才是你真正有机会把 **484 → 1,000 → 5,000 downloads** 的路径，而不是继续向 RAG Pipeline 再加一个算法模块。