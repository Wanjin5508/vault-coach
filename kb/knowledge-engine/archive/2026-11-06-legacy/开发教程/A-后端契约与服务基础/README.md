---
tags: [KnowledgeEngine, 教程, 后端, API]
parent: ../README.md
---

# A 后端契约与服务基础

这一分支让 Engine 成为一个可独立启动、可由 Workbench/Connector 调用的服务，而不是只能在某个 UI 中运行的脚本。

1. [A1 HTTP 与版本化 API](./A1-HTTP与版本化API.md)
2. [A2 JSON Schema 与 OpenAPI](./A2-JSONSchema与OpenAPI.md)
3. [A3 配置、健康检查、取消与退避](./A3-配置健康检查取消与退避.md)
4. [A4 Docker、迁移、日志与本地诊断](./A4-Docker迁移日志与本地诊断.md)

完成本分支后，应能在没有 Obsidian 的环境启动 Engine，打开 Workbench，并用 schema 校验一个 versioned API 请求。
