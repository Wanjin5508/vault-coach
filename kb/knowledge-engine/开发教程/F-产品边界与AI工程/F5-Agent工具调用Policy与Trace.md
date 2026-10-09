---
tags: [KnowledgeEngine, 教程, Agent, ToolCalling, Policy]
parent: README.md
milestone: KE-7
---

# F5 Agent 工具调用、Policy 与 Trace

## 学习目标

在 Engine 中使用 Agent 解决开放式、多步骤学习任务，同时保留权限、预算、证据和人类确认。

## 先理解

- Agent 适合决定“下一步检索什么、如何组合结果”；不适合 revision、删除、评分、图谱确认等确定性写操作；
- tool 是窄能力接口，不是让模型调用任意函数；每个 tool 有 schema、scope、预算、输出与错误模型；
- policy gate 在每次调用前检查 workspace、source scope、top-K/depth、轮次、deadline、用户授权；
- trace 记录目标、工具名、参数摘要、来源、revision、耗时、失败原因；不记录或展示思维链；
- 高影响动作采用 proposal → 用户确认 → 确定性 workflow，Agent 只产生草案。

## Engine 落点

首批只读工具：`search_chunks`、`get_graph_projection`、`get_concept_mastery`、`get_assessment_history`；纯计算草案：`draft_training_plan`、`draft_exam_request`。Agent 没有数据库、ES、文件系统、shell 或任意 HTTP 权限。

## 动手练习

1. 为 `search_chunks` 定义 JSON Schema、top-K 上限和 scope 检查；
2. 实现一个“制定两周训练计划”的 agent run，要求每项建议引用工具结果；
3. 模拟无证据、工具超时、循环调用、超预算和取消；
4. 让 Agent 生成 exam draft，再由 UI 确认后调用确定性 create-session；
5. 为 trace 做脱敏审查。

## 通过检查

- Agent 不能越权读取资料或修改领域事实；
- 每个用户可见结论都有来源或明确 abstain；
- 失败与取消不会遗留半完成高影响动作。

## 下一步

阅读 [F1 Lite Fallback、Capability 与 Connector](./F1-LiteFallbackCapability与Connector.md)。
