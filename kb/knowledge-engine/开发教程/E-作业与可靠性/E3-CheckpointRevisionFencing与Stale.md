---
tags: [KnowledgeEngine, 教程, Checkpoint, Revision, Stale]
parent: README.md
milestone: KE-5
---

# E3 Checkpoint、Revision Fencing 与 Stale

## 学习目标

防止“任务开始时正确、结束时已过期”的结果覆盖当前知识库。

## 先理解

- checkpoint 是可安全恢复的阶段边界，如已处理 chunk ordinal、已写 shard 或已完成 batch；
- revision fencing 指发布结果前比较 `input_revision` 与当前 revision；不一致时不提升结果；
- `stale` 不是失败：计算可能正确，但它针对旧输入，不适合成为当前 effective 结果；
- checkpoint 数据也需版本化，模型/算法版本变化时不能盲目续跑。

## Engine 落点

每个 job 保存 input revision、model/algorithm version 与 checkpoint。worker 在每批次和最终 publish 前比较 waterline；Connector 接到新 revision、managed 导入新版本或治理变化时，使相关 job stale/重新排队。

## 动手练习

1. 启动长 embedding job，在中途导入 source revision +1；
2. 断言旧 job 不能写入当前向量/有效图；
3. 用 checkpoint 重启任务，验证只处理未完成的 batch；
4. 对模型版本改变写出“重建而非续跑”的测试。

## 通过检查

- 当前 projection 永远标注且匹配输入 revision；
- 旧计算不会悄悄覆盖新数据；
- stale 对用户和自动恢复都有清晰语义。

## 下一步

阅读 [E4 故障注入、备份、恢复与删除演练](./E4-故障注入备份恢复与删除演练.md)。
