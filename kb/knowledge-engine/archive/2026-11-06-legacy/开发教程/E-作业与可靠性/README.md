---
tags: [KnowledgeEngine, 教程, Job, 可靠性]
parent: ../README.md
---

# E 作业与可靠性

这一分支将 embedding、图计算和索引重建从 HTTP 请求与 GUI 生命周期中剥离出来，使任务可恢复、可取消、可观测。

1. [E1 Durable Job、Lease 与幂等 Handler](./E1-DurableJobLease与幂等Handler.md)
2. [E2 进度、取消、重试与错误模型](./E2-进度取消重试与错误模型.md)
3. [E3 Checkpoint、Revision Fencing 与 Stale](./E3-CheckpointRevisionFencing与Stale.md)
4. [E4 故障注入、备份、恢复与删除演练](./E4-故障注入备份恢复与删除演练.md)

完成本分支后，应能关闭浏览器或重启容器，并解释一个运行中任务最终为什么会成功、失败、取消或变为 stale。
