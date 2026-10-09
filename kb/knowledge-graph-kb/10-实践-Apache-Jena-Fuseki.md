# 10 实践：Apache Jena、TDB2 与 Fuseki

## 目标

Apache Jena 是 Java 生态的 RDF 工具集：ARQ 提供 SPARQL，TDB2 提供持久三元组存储，Fuseki 可将数据集作为 HTTP SPARQL 服务暴露。本练习用一个小型 Turtle 文件理解“数据—验证—查询—服务”的闭环。

## 1. 创建教学数据

保存为 `research.ttl`：

```turtle
@prefix ex: <https://example.org/research/> .
@prefix schema: <https://schema.org/> .

ex:paper-1 a schema:ScholarlyArticle ;
  schema:name "Knowledge graphs in practice"@en ;
  schema:author ex:person-1 .

ex:person-1 a schema:Person ;
  schema:name "Li Ming" ;
  schema:affiliation ex:org-1 .

ex:org-1 a schema:Organization ; schema:name "Example Lab" .
```

真实项目应从第一天就规定 IRI 策略、语言标签、数据类型和命名图策略。不要让导入器临时拼接不可预测的 ID。

## 2. 在本地验证和查询

安装与运行方式随发行版本而变，应以 [Jena 官方入门和工具文档](https://jena.apache.org/documentation/) 为准。概念性流程为：

```text
Turtle/JSON-LD/N-Quads
  → RIOT 解析与语法检查
  → SHACL 验证
  → tdb2.tdbloader 批量导入 TDB2
  → ARQ / Fuseki 执行 SPARQL
```

对一个新数据源，先以小样本运行解析和 SHACL。若 shape 检出错误，应保留违规报告和源记录，而不要静默丢弃。

## 3. 查询数据集

```sparql
PREFIX schema: <https://schema.org/>

SELECT ?paperName ?authorName WHERE {
  ?paper a schema:ScholarlyArticle ;
         schema:name ?paperName ;
         schema:author ?author .
  ?author schema:name ?authorName .
}
```

将这条查询作为回归样例。每次变更词表、加载器或存储版本后，验证它返回相同语义结果，并额外检验执行时间是否退化。

## 4. 以 Fuseki 提供服务

Fuseki 可独立运行或嵌入应用，并提供 SPARQL 1.1 查询/更新协议以及 Graph Store 协议。上线时至少需要：

- 用反向代理、认证和网络隔离保护更新端点；不要默认公开写接口。
- 对查询设置超时、并发、结果大小和请求审计。
- 将批量加载、索引构建和在线更新分开，避免用户查询抢占重建资源。
- 对命名图、服务端点和数据目录配置做备份与恢复演练。

## 5. 文本索引的正确位置

Jena Text 可以用 Lucene 为文本字面量建立检索加速层。对于大批量发布，官方文档建议先加载 TDB 数据集，再独立构建文本索引；开启更新后，索引随修改维护。它说明一个通用原则：全文/向量索引应当是可重建的派生状态，而原始 RDF 和加载日志才是可恢复的权威数据。

下一章切换到属性图和 Cypher：[[11-实践-Neo4j-Cypher]]。

