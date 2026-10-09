---
tags: [KnowledgeEngine, 教程, Revision, Idempotency]
parent: README.md
milestone: KE-2
---

# B2 Revision、Hash、幂等性与水位线

## 学习目标

让同一变更重发十次仍得到一次正确结果，让旧变更永远不能覆盖新变更。

## 先理解

- **revision** 是某个 `workspaceId + sourceId` 的单调版本号，表达先后；
- **content hash** 表达内容是否相同，可减少不必要重算，但不能替代 revision 顺序；
- **idempotency** 指同一请求重放不会重复创建事实或任务；
- **waterline** 是服务确认已接收/已投影到哪里的可观察进度，不是客户端凭感觉猜测的状态。

不要用时间戳排序替代 revision：时钟可能不一致，重放和离线恢复也会失去明确顺序。

## Engine 落点

`KnowledgeChangeV1` 的复合身份是 `(workspaceId, sourceId, revision)`。写入时：重复 revision 返回先前结果；更小 revision 返回冲突；更大 revision 成为新事实并创建派生 job。响应报告 accepted revision 与 indexed/projection waterline。

## 动手练习

1. 依次发送 revision 1、1、0、2；为每次设计预期 HTTP 与数据库结果；
2. 使用唯一约束与事务，而非内存 Map，保证服务重启后仍幂等；
3. 让 revision 2 的 job 未完成，GUI 显示“accepted=2, indexed=1”；
4. 测试同内容不同 revision 与不同内容相同 hash 的策略，写出原因。

## 通过检查

- 重放不产生重复 chunk/job；
- 乱序不导致旧内容复活；
- UI 能显示同步与索引之间的滞后。

## 下一步

阅读 [B3 变更同步、删除、重放与部分失败](./B3-变更同步删除重放与部分失败.md)。
