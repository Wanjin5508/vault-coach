---
tags: [KnowledgeEngine, 教程, Docker, Migration, Logging]
parent: README.md
milestone: KE-1
---

# A4 Docker、迁移、日志与本地诊断

## 学习目标

掌握“可重复启动、可升级、可备份、可删除”的本地服务交付，而不是只在开发机上能跑。

## 先理解

- Docker image 是运行环境；Compose 描述 API、worker、PostgreSQL、volume 和 healthcheck 的关系；
- migration 是版本化数据库变更，必须可审计、按顺序执行，并和应用版本兼容；
- named volume 保存用户数据；`down -v` 是破坏性动作，文档与 UI 必须明确后果；
- 结构化日志记录 request/job/revision、耗时、错误类别和 hash 前缀，不记录正文、向量、密钥或思维链。

## Engine 落点

首版用 loopback 端口启动 `engine-api`、`engine-worker`、PostgreSQL+pgvector，并由 API 或静态资源提供 Workbench。启动顺序由 readiness，而不是 `sleep`，决定。迁移后才允许 Connector/GUI 接收写请求。

## 动手练习

1. 写最小 Compose：数据库 healthcheck 后启动 API，worker 使用同一 migration version；
2. 创建一条 migration 和回滚/恢复说明；
3. 重启容器，确认 volume 中的数据仍在；
4. 模拟错误配置和数据库不可用，检查日志能关联到 request ID；
5. 写出“备份、恢复、完全删除”三条可执行操作手册。

## 通过检查

- 新机器能通过一份文档启动 Workbench；
- 升级不依赖手工改表；
- 用户能区分停止服务、删除 workspace 与删除 Docker volume 的影响。

## 下一步

进入 [B 数据与一致性](../B-数据与一致性/README.md)。
