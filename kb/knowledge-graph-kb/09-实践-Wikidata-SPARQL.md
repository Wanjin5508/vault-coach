# 09 实践：Wikidata 与 SPARQL

## 目标

Wikidata 是学习开放知识图谱的好入口：它公开展示实体 ID、语句、限定词、参考来源和 SPARQL 查询服务。本章只查询公共数据，不把它当成生产系统的权威来源。

打开 [Wikidata Query Service](https://query.wikidata.org/)，将以下查询逐段运行。

## 1. 最小查询：从实体到标签

```sparql
SELECT ?person ?personLabel WHERE {
  ?person wdt:P31 wd:Q5 .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en". }
}
LIMIT 10
```

这里 `wd:Q5` 是“人”，`wdt:P31` 是直接事实形式的“实例是”。`SERVICE wikibase:label` 将不易读的 QID 转为中文或英文标签。先使用 `LIMIT`，因为公共端点对代价高的查询会限流或超时。

## 2. 多跳查询与选择性

```sparql
SELECT ?person ?personLabel ?country ?countryLabel WHERE {
  ?person wdt:P31 wd:Q5 ;
          wdt:P27 ?country .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en". }
}
LIMIT 20
```

这相当于从“人”沿国籍关系走一跳。生产 SPARQL 的经验同样适用：先放选择性强的模式、限制返回量、避免无界路径，并观察端点提供的查询计划/耗时。

## 3. 直接事实与可追溯语句

Wikidata 具有两层常用路径：

```text
wdt:Pxxx  直接值，查询简洁，通常不返回限定词与参考来源
p:Pxxx    语句节点，可继续访问 ps:/pq:/pr: 的主值、限定词、参考来源
```

当问题带“何时”“依据什么来源”“采用何个排名”时，应查询语句节点；当只做快速实体筛选时，直接值路径更方便。这正是 [[01-基本理论与图模型]] 中“事实与证据分开”的现实例子。

## 4. 练习：设计一个可解释问题

选择一个主题，写出下列内容后再写查询：

1. 问题：例如“某类实体与哪些地点有关？”
2. 种子实体及 QID。
3. 每一跳的属性及为何需要它。
4. 需要的时间限定词或来源。
5. 结果规模、排序及失败/超时后的降级方案。

将最终查询保存为 `.rq`，并记录端点、运行日期、前缀、结果数。公共知识图谱数据会变化，可复现性来自查询和时间记录，而不是截图。

## 5. 可迁移的教训

- QID/IRI 是稳定连接点，标签只是展示文本。
- 直接关系很适合召回，语句层适合审计和时间限定。
- 图查询的成本由起点基数和连接顺序决定，而不是由 SQL/SPARQL/Cypher 的名字决定。

相关官方材料见 [[参考资料]] 中的 Wikidata Query Service 与 W3C SPARQL 文档。下一章在本地建立可控的 RDF 服务：[[10-实践-Apache-Jena-Fuseki]]。

