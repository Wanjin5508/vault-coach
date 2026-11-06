---
tags: [KnowledgeEngine, 教程, Graph, BFS, Projection]
parent: README.md
milestone: KE-4
---

# D2 邻接表、BFS 与有界子图

## 学习目标

学会用关系表和有界 BFS 返回可渲染、可缓存、不会拖垮客户端的图谱投影。

## 先理解

- 邻接表以 relation 行保存边，配合 `(workspace, source_concept, type)` 及反向索引支持邻居查询；
- BFS 按层扩展，适合 `depth=1|2` 的概念邻域；
- “全图”不是默认 API。请求必须有 root、depth、nodeLimit、edgeLimit、relation filter、scope 和 deadline；
- 当预算不足时，按稳定优先级裁剪，并返回 `truncated` 与数量，不静默丢节点；
- cache key 应包含 workspace revision、root、filter 和预算，revision 变化后精确失效。

## Engine 落点

`GET /v1/graph/projection` 是 GUI Graph Explorer 与 Vault Coach Learning Map 的共同后端。服务端查询与裁剪，客户端只画有限结果；路径查询同样有时间、长度和结果上限。

## 动手练习

1. 以 10 个匿名 Concept 建表，分别查入边和出边；
2. 实现 depth 1/2 BFS，并设 node=5、edge=8 的预算；
3. 验证同一输入输出稳定排序，revision 改变后 cache miss；
4. 对高连接度 root 压测，确保不会返回全图或无限循环。

## 通过检查

- 图查询成本与预算相关，而非与全库大小无界相关；
- 每个返回 relation 仍含 evidence/revision；
- Canvas/GPU 压力由服务端预算控制，而非 UI 事后补救。

## 下一步

阅读 [D3 候选、确认事实与有效图](./D3-候选确认事实与有效图.md)。
