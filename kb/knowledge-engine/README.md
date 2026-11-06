---
status: archived-entrypoint
updated: 2026-11-06
---

# Knowledge Engine 知识库已迁移

新版 KE 的知识库、需求分析与初步实现规划统一维护于当前 KE 项目的 `doc/`，技术方向为 **Python + FastAPI + LangChain/LangGraph**，前端采用 **Next.js**。核心范围为大规模本地知识检索、多路召回/知识图谱及模拟面试多 Agent 与语音交互。

- [新版知识库入口](/Users/wanjinli/code/knowledge_engine/doc/README.md)
- [新版需求分析](/Users/wanjinli/code/knowledge_engine/doc/01-新版需求分析.md)
- [新版实现规划](/Users/wanjinli/code/knowledge_engine/doc/08-初步实现规划.md)
- [旧版内容提炼与现状审计](/Users/wanjinli/code/knowledge_engine/doc/00-旧版审计与内容提炼.md)
- [本目录旧版原文归档](archive/2026-11-06-legacy/README.md)
- [KE 内旧版快照与哈希清单](/Users/wanjinli/code/knowledge_engine/doc/archive/2026-11-06/README.md)

旧版 40 个文件完整移动到 `archive/2026-11-06-legacy/`，并有 KE 内逐字节副本。归档中的 `active`、TS/Fastify、旧阶段计划与已完成状态均为历史描述，不约束新版；归档仅供查阅，不继续双向维护。部分指向本目录以外的旧 Obsidian 链接保留原样。

当前仅完成文档重构与归档；Python 服务、检索/图数据库集成与面试语音链路仍按新版规划待实现。此次不修改 Vault Coach 插件代码或用户知识内容。

旧主文档 00–05 的原路径保留迁移说明，供既有引用跳转；原文只在归档中维护历史快照。
