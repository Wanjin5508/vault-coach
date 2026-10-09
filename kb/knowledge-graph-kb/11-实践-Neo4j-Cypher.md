# 11 实践：Neo4j 与 Cypher

## 目标

Neo4j 适合用属性图快速表达业务实体和关系，并通过 Cypher 读取、写入和分析图。本章以研究图谱为例，重点是约束、查询入口和多模态索引，而非产品特定的安装步骤。

## 1. 先创建唯一性约束

```cypher
CREATE CONSTRAINT person_id IF NOT EXISTS
FOR (p:Person) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT paper_id IF NOT EXISTS
FOR (p:Paper) REQUIRE p.id IS UNIQUE;
```

随后使用 `MERGE` 写入幂等数据。`MERGE` 的匹配键必须是稳定 ID，不能是显示名称：

```cypher
MERGE (a:Person {id: 'person-1'})
SET a.name = 'Li Ming'
MERGE (p:Paper {id: 'paper-1'})
SET p.title = 'Knowledge graphs in practice',
    p.publishedAt = date('2025-04-01')
MERGE (a)-[:AUTHORED {source: 'demo'}]->(p)
```

## 2. 写一个从选择性入口开始的查询

```cypher
MATCH (a:Person {id: $personId})-[:AUTHORED]->(p:Paper)
RETURN p.id, p.title, p.publishedAt
ORDER BY p.publishedAt DESC
LIMIT 20
```

用 `EXPLAIN` 或 `PROFILE` 检查计划是否由唯一索引定位 `Person`，再扩展作者边。若从全体 `Paper` 开始匹配，数据增长后必然退化。

## 3. 为不同检索问题使用不同索引

```cypher
CREATE RANGE INDEX paper_published IF NOT EXISTS
FOR (p:Paper) ON (p.publishedAt);

CREATE FULLTEXT INDEX paper_text IF NOT EXISTS
FOR (p:Paper) ON EACH [p.title, p.abstract];
```

向量索引的创建需要固定 embedding 维度和相似度函数；Neo4j 当前文档建议显式设置这些参数。示意如下（请依据部署版本核对语法和可用查询接口）：

```cypher
CREATE VECTOR INDEX paper_embedding IF NOT EXISTS
FOR (p:Paper) ON (p.embedding)
OPTIONS {indexConfig: {
  `vector.dimensions`: 1536,
  `vector.similarity_function`: 'cosine'
}};
```

全文、向量和图遍历各自产生不同含义的分数：全文受词项和分析器影响，向量是近似邻居相似度，图重排可能是路径或业务规则分数。先在每一路内排序，再使用 RRF 或经标注训练的重排器融合，切勿直接相加原始分数。

## 4. 建模含来源的关系

简单的来源可存在关系属性中；多个来源、相互冲突或需要审核时，把断言提升为节点：

```cypher
(s:Statement {id, predicate, confidence, status})
  -[:SUBJECT]->(a:Person)
(s)-[:OBJECT]->(o:Organization)
(s)-[:SUPPORTED_BY]->(e:Evidence {documentId, chunkId, offset})
```

这样可以让 canonical 图只公开已批准事实，而候选断言仍被保存、审核和回滚。

## 5. 生产检查清单

- 把 schema、约束和索引作为版本化迁移，不在应用请求中临时创建。
- 等待索引 `ONLINE` 后再压测；构建中索引不可用或结果不完整。
- 为变长路径、聚合和跨租户查询设限。
- 记录慢查询、计划变化、索引大小、构建滞后与权限过滤命中率。

Neo4j 的官方索引文档列出了 range、text、full-text、vector 等类型及版本能力，详见 [[参考资料]]。若需要可插拔分布式后端，继续 [[12-实践-JanusGraph-Gremlin]]。

