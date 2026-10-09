---
tags: [KnowledgeEngine, 教程, Job, Lease, Idempotency]
parent: README.md
milestone: KE-5
---

# E1 Durable Job、Lease 与幂等 Handler

## 学习目标

理解为什么 embedding、投影和批量计算必须在持久任务系统中运行，而不是由 HTTP 请求或浏览器页面“顺便完成”。

## 先理解

- durable job 的状态存在数据库中，进程重启后仍可恢复；
- worker 领取 job 时使用 lease：租约过期后其他 worker 可安全接手；
- handler 必须幂等：同一 job 重跑不会重复写结果或发布旧 revision；
- job 输入要记录 `input_revision`、algorithm/model version、attempt、created/started/finished 时间；
- `FOR UPDATE SKIP LOCKED` 是 PostgreSQL 单库队列的常见起点，不必一开始引入 Redis/Kafka。

## Engine 落点

embedding、ANN candidate、graph projection prewarm、批量 mastery、可选 ES projection 都创建 job。API 只做短事务入队，Workbench/Connector 再查询状态；worker 从 job/outbox 表领取工作。

## 动手练习

1. 设计 job 表与状态转换；
2. 启动两个 worker，验证同一 job 不会被同时处理；
3. 让 worker 在写结果前后崩溃，测试 handler 重跑；
4. 将 job ID 和 input revision 显示在 Workbench。

## 通过检查

- 浏览器关闭不影响任务；
- worker 重启不会使 job 永久卡在 running；
- 重跑不会把同一 revision 写两次或覆盖更新版本。

## 下一步

阅读 [E2 进度、取消、重试与错误模型](./E2-进度取消重试与错误模型.md)。
