---
tags: [KnowledgeEngine, 教程, Concept, Relation, Evidence]
parent: README.md
milestone: KE-4
---

# D1 Concept、Relation、Evidence、Alias 与 Revision

## 学习目标

把知识图谱建模为“有类型、有方向、有证据、可演进的关系集合”，而不是一张节点连线图。

## 先理解

- Concept 是稳定标识与显示名称的组合；名称会变化，ID 与 alias/redirect 保持引用稳定；
- Relation 至少有 source、target、type、direction、状态、revision 和 evidence；
- evidence 指向 section/chunk/locator，是“为什么存在这条边”的依据；
- revision 使用户能判断图谱投影基于哪一版知识，而不是把缓存当实时事实；
- relation type 需要受控枚举，例如 prerequisite、explains、uses，而非任意 LLM 字符串。

## Engine 落点

在 `connector` 工作区中，effective Concept 与 confirmed relation 是 Vault M3 治理事实的副本；在 `managed` 工作区中，治理结果属于该 workspace。两者都通过同一 GraphProjection DTO 返回，不混淆所有权。

## 动手练习

1. 为三个 Concept 设计 stable ID、alias 与 redirect；
2. 写一条有方向的 prerequisite relation，并附两个 evidence ref；
3. 重命名概念后验证旧 ID/alias 仍能解析；
4. 对无 evidence 或 type 非法的 relation 写入失败测试。

## 通过检查

- 任何边都能回答“谁和谁、什么关系、方向为何、证据在哪里”；
- 显示名变化不会破坏 Assessment/图查询引用；
- 候选与 confirmed fact 尚未混在同一状态字段里。

## 下一步

阅读 [D2 邻接表、BFS 与有界子图](./D2-邻接表BFS与有界子图.md)。
