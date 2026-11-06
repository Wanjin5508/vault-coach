---
tags: [KnowledgeEngine, 教程, HTTP, API]
parent: README.md
milestone: KE-0
---

# A1 HTTP 与版本化 API

## 学习目标

理解 HTTP API 是不同客户端之间的**稳定契约**，不是把内部函数直接暴露出去。Engine 的 Workbench、Vault Coach Connector 和 Career Agent 都只能通过契约协同。

## 先理解

- 资源地址表达“操作谁”，HTTP method 表达“做什么”；例如 `POST /v1/retrieval/search` 是有界查询，而不是任意数据库访问。
- `v1` 是兼容边界。破坏字段含义、删除必填字段或改变错误语义时，必须升主版本或提供迁移期。
- 每次请求带 `requestId`；每个响应带 schema/version、workspace/revision、可操作的错误码。
- `202 Accepted` 适合已入队的重计算；不要让 HTTP 请求同步等待全库 embedding。

## Engine 落点

先定义 health、version、workspace、retrieval、graph、job、training 与 agent run 的资源。API 接收的是 DTO，不接受 Obsidian 对象、SQL、ES DSL 或任意文件路径。Connector 请求另外带 capability 协商与 idempotency key。

```ts
interface VersionedEnvelopeV1<T> {
  schemaVersion: 1;
  requestId: string;
  workspaceId: string;
  payload: T;
}
```

## 动手练习

1. 为 `POST /v1/retrieval/search` 写 request/response/error 三个 DTO；
2. 写出 `400 invalid-request`、`403 scope-denied`、`409 revision-conflict`、`503 index-unavailable` 的机器码与用户安全文案；
3. 用 curl 或 API test 验证未知字段、无效 limit 与缺少 workspace 的行为；
4. 让 Workbench 和 Connector 都使用同一 fixture。

## 通过检查

- 不看实现代码也能从 API 文档知道输入、预算、输出和错误；
- 客户端不需要猜测服务状态；
- 新增字段可向后兼容，破坏性变化不会静默发生。

## 下一步

进入 [A2 JSON Schema 与 OpenAPI](./A2-JSONSchema与OpenAPI.md)，把上述契约变成可自动校验的文件。
