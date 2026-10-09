---
tags: [KnowledgeEngine, 教程, Evidence, Abstain, Assessment]
parent: README.md
milestone: KE-6
---

# F3 证据、置信度、不确定性与 Abstain

## 学习目标

让 RAG、图谱、考试和 Agent 都能诚实表达“依据是什么”与“我不知道”，而不是以流畅文字掩盖证据缺失。

## 先理解

- evidence 是可定位来源与 revision；confidence 是基于证据质量/覆盖度的计算信号；两者不能混成模型自信语气；
- 检索分数、ANN 相似度、RRF 排名、模型评分和 mastery 是不同量纲，不能直接互相替代；
- abstain 是正确输出：无命中、范围无权、revision 过期、模型不可用、证据冲突都应返回明确状态；
- 考试的 `simple` 走可复现客观评分；`challenge` 的模型评分必须带 evaluator/model/prompt version 与不确定性；
- 不安全的 Concept binding 要保留未绑定 Assessment，不得为了仪表盘完整而猜测。

## Engine 落点

RAG answer 返回来源；GraphProjection 返回 evidence；Training session 返回题目来源、评分路径、Assessment event 与 mastery revision；Agent trace 返回使用的工具和证据。所有 UI 都把缺证据展示为状态，不静默生成结论。

## 动手练习

1. 为无匹配、scope-denied、stale-index 设计响应和 UI；
2. 为一题 simple 与 challenge 考试记录不同 evaluator metadata；
3. 编写“只有 confirmed relation 可参与训练计划”的测试；
4. 让 Agent 对没有证据的问题明确 abstain，并显示它已调用的 search 工具。

## 通过检查

- 每个事实性结论可回到来源/revision；
- 不确定性不会被包装成 confirmed fact；
- 考试模式改变题型和评分，不改变 mastery 权重。

## 下一步

阅读 [F5 Agent 工具调用、Policy 与 Trace](./F5-Agent工具调用Policy与Trace.md)。
