---
tags: [KnowledgeEngine, 教程, Evaluation, Benchmark, Inspector]
parent: README.md
milestone: KE-3
---

# C4 检索评估、基准与 Inspector

## 学习目标

把“感觉检索不错”转换成质量、延迟、资源和可解释性的证据。

## 先理解

- Recall@K 衡量正确来源是否进入前 K；nDCG@K 同时关注排序位置；
- p50 表示典型延迟，p95 暴露慢尾；还要测导入、1% 增量、删除、重建、内存和磁盘；
- 回答质量不能掩盖检索错误：先评估 retrieval，再评估生成是否忠实引用；
- Inspector 是工程工具：它显示 filter、候选数、命中渠道、locator、revision、截断和降级，不展示密钥或思维链。

## Engine 落点

KE-0 的匿名 benchmark 同时驱动 pgvector 参数、是否采用 ES、Lite/Engine 推荐阈值和 Workbench 检索诊断。检索 request 可保存安全摘要，以重放问题但不长期保存完整用户 query/正文。

## 动手练习

1. 建 20–50 条匿名 query 与人工相关 chunk 标注；
2. 对 lexical/vector/hybrid 输出 Recall@K、nDCG@K、p50/p95；
3. 用相同输入比较 Lite、Postgres 基线和可选 ES；
4. 在 GUI 中重放一次 request，验证能解释“为什么没有某个结果”；
5. 为空索引、过期 revision、模型失败和超预算分别写回归测试。

## 通过检查

- 技术选型与阈值有可重跑数据；
- 用户可看见降级，而非得到伪精确答案；
- Inspector 使问题可在不安装 Obsidian 时定位。

## 下一步

进入 [D 图谱与知识治理](../D-图谱与知识治理/README.md)。
