---
tags: [KnowledgeEngine, 教程, OpenAPI, JSONSchema]
parent: README.md
milestone: KE-0
---

# A2 JSON Schema 与 OpenAPI

## 学习目标

把“接口约定”变成可验证、可生成文档、可供多客户端复用的 schema，而不是散落的 TypeScript interface。

## 先理解

- **JSON Schema** 描述 JSON 的形状、必填字段、枚举、范围与嵌套结构；
- **OpenAPI** 将路径、method、认证、request/response schema 和错误组合成 HTTP 合同；
- 编译期 TypeScript 类型不能替代运行时校验；外部输入永远不可信；
- schema 校验的是格式，不校验“revision 是否更新”“用户是否有 scope”；这些属于 service/domain 规则。

Fastify 可用 JSON Schema 校验 request 并序列化声明过的 response；业务异步检查应放在 handler/service，而不是塞进 schema validator。参见 [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)。

## Engine 落点

在 `packages/contracts` 保存版本化 schema 与 fixture。`RetrievalRequestV1` 必须限制 `limit`、filter 数量和 mode；`KnowledgeChangeV1` 必须区分 kind 对应的 payload schema。Workbench、Connector 和 API contract test 共用它们。

## 动手练习

1. 写 `RetrievalRequestV1` schema：query 最小长度、`limit` 上限、合法 mode、scope 数量上限；
2. 为每个 schema 编写 valid / invalid fixture；
3. 在路由层验证输入，在 service 层验证 workspace、授权和 index 状态；
4. 从 OpenAPI 生成或手写一个 Workbench client，确保 client 不复制字段定义。

## 通过检查

- 无效输入在访问数据库前被拒绝；
- response 不会意外泄露正文、密钥或内部堆栈；
- 插件和 GUI 的兼容性可由 fixture 自动验证。

## 下一步

阅读 [A3 配置、健康检查、取消与退避](./A3-配置健康检查取消与退避.md)。
