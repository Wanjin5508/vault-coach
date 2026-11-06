---
tags: [KnowledgeEngine, 教程, PostgreSQL, Transaction]
parent: README.md
milestone: KE-2
---

# B1 PostgreSQL、事务与数据模型

## 学习目标

理解为什么 Engine 先选择 PostgreSQL：它为 revision、事实、审计与 job 提供事务边界；向量或搜索只是附加读能力。

## 先理解

- 表表达长期业务事实；主键、外键、唯一约束与 check constraint 是把不变量交给数据库执行；
- transaction 把一组“要么全部成功、要么全部失败”的写入包在一起；`BEGIN`、`COMMIT`、`ROLLBACK` 是基本语义；
- 索引服务查询模式，不是每个字段都要索引；先从 workspace/source/revision、job state、relation 邻接等实际谓词出发；
- JSON 适合版本化扩展字段，不替代需要约束、连接和过滤的核心列。

参见 [PostgreSQL transaction processing](https://www.postgresql.org/docs/current/transactions.html)。

## Engine 落点

核心表包括 `workspace(source_mode)`、`source_revision`、`section`、`chunk`、`concept`、`relation`、`assessment_evidence`、`job` 与 `profile_revision`。Connector 的事实写入与 outbox/job 入队必须在同一事务；managed 工作区也必须把导入 revision 与其派生工作原子关联。

## 动手练习

1. 为 `(workspace_id, source_id, revision)` 建唯一约束；
2. 在一个 transaction 中写入 source revision、chunk 和 outbox/job；故意让最后一步失败，确认前面的写入回滚；
3. 为“某工作区最新 revision 的 chunk”写 SQL，并用 `EXPLAIN` 检查索引；
4. 写 migration 和 fixture，而不是在 GUI 按钮中拼 SQL。

## 通过检查

- 能说清每张表是事实、派生数据还是审计数据；
- 失败不会留下“revision 已更新但 job 未创建”的状态；
- schema 约束能拒绝明显无效的数据。

## 下一步

阅读 [B2 Revision、Hash、幂等性与水位线](./B2-RevisionHash幂等性与水位线.md)。
