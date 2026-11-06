---
tags: [KnowledgeEngine, 教程, Lite, Connector, Capability]
parent: README.md
milestone: KE-8
---

# F1 Lite Fallback、Capability 与 Connector

## 学习目标

让 Engine 成为 Vault Coach 的可选增强，而不是把 Docker、网络或新服务变成用户学习的前置条件。

## 先理解

- capability negotiation 比“某个 URL 能访问”更可靠：客户端读取 protocol version、能力集合、诊断与兼容状态；
- Lite、available、unavailable 是产品状态，不是异常分支；
- Connector 同步用户明确选择的 revisioned DTO，不发送整个 Vault，也不让 Engine 直接读取 Obsidian 文件系统；
- fallback 必须在 UI、数据和用例上验证：Engine 失败时继续使用 Lite 的本地事实与功能。

## Engine 落点

现有插件已有窄 `KnowledgeEngineClient`/`LiteEngineClient` 接缝。未来 Local client 在显式设置、loopback 验证、协议兼容与用户同意后才创建；GUI 与 Connector 共用 Engine API，但 GUI 不依赖插件。

## 动手练习

1. 写 version/capabilities fixture，测试兼容、缺少能力、主版本冲突；
2. 模拟 Engine 停止、超时、认证失败、索引 lag；
3. 验证 Vault Coach Ask/Exam/Map/Mastery 仍可完成 Lite 路径；
4. 在 Connector UI 显示模式、版本、同步范围、waterline 与“断开/删除副本”。

## 通过检查

- 插件不因 Engine 不可用而报致命错误；
- 用户知道当前使用 Lite 还是 Engine、为什么；
- Engine Standalone 不启动 Vault Coach 也能工作。

## 下一步

阅读 [F6 Benchmark、SLO 与技术取舍](./F6-BenchmarkSLO与技术取舍.md)。
