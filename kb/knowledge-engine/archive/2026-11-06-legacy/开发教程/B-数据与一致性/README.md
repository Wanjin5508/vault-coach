---
tags: [KnowledgeEngine, 教程, PostgreSQL, 一致性]
parent: ../README.md
---

# B 数据与一致性

这一分支定义 Engine 最重要的可靠性基础：什么是事实、什么可重建，以及重复、乱序、删除和重启时如何保持正确。

1. [B1 PostgreSQL、事务与数据模型](./B1-PostgreSQL事务与数据模型.md)
2. [B2 Revision、Hash、幂等性与水位线](./B2-RevisionHash幂等性与水位线.md)
3. [B3 变更同步、删除、重放与部分失败](./B3-变更同步删除重放与部分失败.md)
4. [B4 事实源、派生投影与数据删除](./B4-事实源派生投影与数据删除.md)

完成本分支后，应能解释为什么 Engine 不能直接“双写数据库和搜索索引”，并用测试证明一条 revision 流可重放。
