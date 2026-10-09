# 12 实践：JanusGraph 与 Gremlin

## 目标

JanusGraph 是面向大图的属性图引擎，使用 TinkerPop/Gremlin 接口，并将持久化和索引交给可插拔后端。它非常适合学习“图的邻接存储、分布式后端、索引生命周期”之间的关系。

## 1. 从本地探索开始，但不要把它当生产配置

官方提供 `inmemory` 后端，适合快速试验：

```groovy
graph = JanusGraphFactory.build().set('storage.backend', 'inmemory').open()
g = graph.traversal()
g.addV('person').property('uid', 'person-1').property('name', 'Li Ming').iterate()
```

关闭内存后端会失去数据，因此它只适合探索和测试。生产需要选择持久化后端并设计备份、事务和容量策略。

## 2. 在数据之前定义模式和索引

```groovy
mgmt = graph.openManagement()
uid = mgmt.makePropertyKey('uid').dataType(String.class).make()
person = mgmt.makeVertexLabel('person').make()
mgmt.buildIndex('byUid', Vertex.class).addKey(uid).unique().buildCompositeIndex()
mgmt.commit()
```

然后再批量加载。对已存在的数据后加索引必须经历注册、重索引、启用等生命周期；若未等待索引可用就切流，查询可能退化为全图扫描或结果不完整。

## 3. 复合索引、混合索引和顶点中心索引

| 类型 | 使用条件 | 例子 |
| --- | --- | --- |
| Composite graph index | 高选择性等值查询 | 按 `uid` 找唯一实体 |
| Mixed graph index | 全文、范围、地理、多条件过滤 | 从文本/日期候选找顶点 |
| Vertex-centric index | 已知顶点的局部邻接过滤/排序 | 某作者近两年论文 |

JanusGraph 的官方说明指出，混合索引需配置外部索引后端，常见支持包括 Elasticsearch、Solr 和 Lucene；分布式场景通常选择可分布部署的后端。生产可以启用 `force-index` 一类防护，阻止意外全图扫描，但要先确保所有查询入口都有索引。

## 4. 架构思考题

JanusGraph 的邻接表存储会把每个顶点的邻边紧凑组织，使固定起点的遍历很快；代价是超级节点可能形成超宽行和热点。请为下列场景设计分片方案：

```text
一个“全站标签”连接 5,000 万个内容；
用户经常查询“该标签下最近 7 天的内容”。
```

可行答案通常包括：按时间分桶的中间节点、把公共标签查询交给倒排/搜索索引、为入口做预聚合，以及控制在线遍历的返回上限。仅增加机器不能消除不受约束的超级节点查询。

## 5. 何时选择它

当数据量和并发要求促使你组合 Cassandra/HBase 类存储与外部搜索索引、团队也能承担多组件运维时，JanusGraph 值得评估。若主要目标是规范 RDF 互操作，优先看 Jena/Fuseki；若主要目标是小中规模业务图的快速交付，Neo4j 往往更直接。

这些只是技术选型的输入。生产成功还要求组织流程、质量、权限和运营能力，见 [[13-工业知识图谱工程]]。

