---
tags: [VaultCoach, 教程, Agile, Scrum, 转型, 项目管理]
status: tutorial
updated: 2026-10-20
---

# Vault Coach 敏捷转型方案

## 1. 转型目标

Vault Coach 已有产品分析、版本里程碑、详细架构、自动化测试、CI/CD 和问题复盘。转向敏捷开发不需要推翻这些资产，而是把它们连接成稳定的短反馈循环：

```text
Product Goal
  → 有序 Product Backlog
  → 单一 Sprint Goal
  → 小批量设计/代码/测试/文档
  → 可用 Increment
  → 用户与运行证据
  → Review / Retrospective
  → Backlog 调整
```

转型是否成功，不看是否建立了更多表格，而看以下结果：

- 同一时刻更少工作处于“开始但未完成”；
- 每个短周期都有可运行、可检查的增量；
- 需求、架构、代码、验证和发布证据能互相追溯；
- 新人能找到下一步、依赖、完成条件和失败恢复方式；
- 用户反馈和运行证据能改变后续排序。

## 2. 当前资产如何映射到 Scrum

| 当前资产 | 在敏捷流程中的位置 | 需要补充什么 |
| --- | --- | --- |
| 产品优化文档 | Product Goal 与 Backlog 输入 | 价值、排序、验收和反馈指标 |
| 版本里程碑文档 | Roadmap / Epic 级计划 | 拆成一 Sprint 内可完成的纵向 PBI |
| GitHub Issue | Product Backlog Item 候选 | 验收标准、依赖、风险、DoD 增补项 |
| 功能分支与 PR | Increment 的变更载体 | 关联 Sprint Goal 和验证证据 |
| `tests/` 与 CI | Definition of Done 的自动化部分 | 真实 Obsidian 与隐私检查 |
| issue 实现复盘 | 技术案例与部分 Retro 证据 | 团队工作方式的单一改进行动 |
| 发布说明与论坛 | Sprint Review / Release 反馈渠道 | 反馈回流 Backlog 的负责人和时间 |
| 架构总览与接口文档 | 技术卓越与协作基线 | 决策变化时同步更新 |

现有里程碑仍可作为中期路线图，但不应直接成为一个 Sprint 的任务列表。一个里程碑通常要拆成多个可独立演示的纵向切片。

## 3. 建议的工作项层级

```text
Product Goal
└── Theme / Version outcome
    └── Epic / Milestone
        └── Product Backlog Item / User Story
            └── Engineering task
```

以可观测性为例：

| 层级 | 示例 |
| --- | --- |
| Product Goal | 本地优先地帮助用户理解和训练个人知识 |
| Theme | 提升插件可靠性与可维护性 |
| Epic | 建立隐私安全的本地可观测能力 |
| PBI | 维护者能定位一次索引重建的失败阶段 |
| Task | 定义 span 接口、实现内存 sink、埋点、测试、诊断 UI |

Task 不进入 Product Backlog 顶层排序。PO 排序的是价值与风险，Developer 再为选定 PBI 制定实现计划。

## 4. 角色与决策权

### 4.1 当前以单维护者为主时

| 决策 | 责任视角 | 规则 |
| --- | --- | --- |
| 做什么、先做什么 | Product Owner | 依据用户价值、风险、依赖和学习价值排序 |
| 如何设计和实现 | Developers | 遵守架构、测试、隐私和兼容约束 |
| 流程是否有效 | Scrum Master | 暴露阻塞、限制 WIP、推动改进行动 |

在 Sprint 记录中标记视角。例如：“PO 决策：远程 exporter 暂不进入 Sprint；Developer 决策：先实现本地端口和 sink。”这能防止技术兴趣未经价值判断就成为最高优先级。

### 4.2 引入贡献者后

- Product Owner 保持一人对 Backlog 顺序负责；
- Scrum Master 可以轮值，但要保证事件目的不丢失；
- Developers 共同对满足 DoD 的 Increment 负责；
- 新人可以拥有 Task，但不能独自改变稳定接口、数据 schema 或隐私边界；
- 架构决策通过 ADR 与 PR 评审形成共享理解。

## 5. 分阶段转型

## 阶段 A：建立基线和工作约定

### 内部依赖

- 当前产品优化文档和开发里程碑；
- `README.md`、`AGENTS.md`、架构总览；
- `package.json` 中现有验证命令；
- GitHub 当前 Issue、PR、workflow 与分支规则。

### 外部依赖

- [Agile Manifesto](https://agilemanifesto.org/)；
- [Scrum Guide 2020](https://scrumguides.org/docs/scrumguide/v2020/2020-Scrum-Guide-US.pdf)；
- GitHub Issues/Projects，若团队决定使用看板。

### 动作

1. 写出一个可持续数月的 Product Goal；
2. 将现有需求汇总为一个有序 Product Backlog；
3. 建立仓库级 Definition of Done；
4. 选择 1 周或 2 周 Sprint，并固定 Planning、Review、Retro 时间；
5. 约定工作项状态：`Backlog → Ready → In progress → Review → Done`；
6. 限制主要功能 WIP 为 1；
7. 记录负责人、决策位置和阻塞升级方式。

### 完成 Gate

- [ ] 只有一个权威 Product Backlog；
- [ ] 每个人能找到 Product Goal、当前 Sprint Goal 和 DoD；
- [ ] `Done` 明确要求工作软件与验证证据；
- [ ] 看板状态含义一致；
- [ ] 旧文档已映射而非重复复制。

### 失败处理

如果需求分散且无法排序，先建立目录和来源链接，不要在转录过程中改写需求。由 PO 逐项去重、明确证据后再排序。

## 阶段 B：进行一次 Backlog refinement

### 内部依赖

- 阶段 A 的 Product Goal、Backlog 和 DoD；
- 当前架构边界和接口；
- 相关用户反馈、缺陷或技术风险。

### 外部依赖

- 不要求新增运行依赖；
- 如需验证第三方 API，创建有时限 spike 并固定版本。

### 动作

对最优先的 5–10 个候选项逐一补齐：

1. 问题和受益者；
2. 价值假设；
3. Given/When/Then 验收标准；
4. 影响模块和内部依赖；
5. 外部依赖、许可证和版本风险；
6. 隐私、兼容、迁移和降级；
7. 自动化与手工验证；
8. 大小和拆分方式。

### 完成 Gate

- [ ] 至少有 1–2 个 PBI 能在一个 Sprint 中完成；
- [ ] 未知项被标成 spike，没有伪装成确定事实；
- [ ] 每个 PBI 都能产生可演示结果；
- [ ] 技术债说明它阻碍的产品目标或质量 Gate。

## 阶段 C：运行首个两周 Sprint

推荐首个 Sprint 选择“可观测性最小纵向切片”，因为它能同时训练架构、测试、调试、CI 和 Review。

### Sprint Goal

> 在默认本地且不记录用户内容的前提下，维护者能诊断一次索引重建的阶段、耗时、结果和降级。

### 计划

| 日程 | 重点 | 产出 |
| --- | --- | --- |
| D1 | Planning、接口草案、风险 | Sprint Backlog、trace 树、隐私字段表 |
| D2–D3 | 核心类型、脱敏、内存 sink | 可测试的基础设施 |
| D4–D5 | tracer/context | parent/child 关联测试 |
| D6–D7 | 索引纵向埋点 | 成功、失败、取消、降级 trace |
| D8 | 诊断 API 与最小 UI | 可查看/复制本地快照 |
| D9 | 回归与真实 Obsidian 验收 | 测试、构建、手工记录 |
| D10 | Review 与 Retro | 演示、反馈、一个改进行动 |

完成标准见 [[07-分阶段实现-测试调试与CICD]]。

## 阶段 D：把节奏固化到仓库

### 动作

- Issue 模板要求价值、验收、依赖、隐私和验证；
- PR 模板要求 Sprint Goal、范围、测试、手工验证和日志字段检查；
- CI 执行 lint、test、build、diff check；
- 稳定接口或持久化变更要求 ADR/迁移说明；
- 每次 Review 后把反馈写回 Product Backlog；
- 每次 Retro 最多承诺 1–2 个流程改进并跟踪完成。

### Gate

- [ ] 新 PBI 可以从需求追溯到 PR 和验证证据；
- [ ] 发布说明能从已 Done 的 Increment 生成；
- [ ] 未完成项回到 Backlog 重新排序，不自动滚入下一 Sprint；
- [ ] 复盘改进项进入下一 Sprint 并有验收方式。

## 6. 需求变化怎样处理

| 变化 | 处理方式 |
| --- | --- |
| 新想法，不影响当前目标 | 加入 Product Backlog，由 PO 排序 |
| 新信息改变实现细节 | Developers 调整 Sprint Backlog |
| 范围增大但目标仍有效 | 与 PO 协商删减或替换工作 |
| 严重缺陷威胁目标 | 立即处理并更新计划与风险 |
| Sprint Goal 已失效 | 由 PO 判断是否取消 Sprint |
| 架构假设被证伪 | 停止堆叠功能，记录证据并重做计划 |

不要把“敏捷响应变化”理解为所有新请求都立即插入当前 Sprint。

## 7. 连接 Git 与 Scrum

建议保持：

```text
PBI / Issue
  └── 短生命周期 feature/fix 分支
      ├── 小而有意图的 commits
      └── Pull Request
          ├── 验收标准
          ├── 自动化 Gate
          ├── Obsidian 手工证据
          └── 隐私与兼容检查
```

分支名和提交号用于追溯，不替代 Product Goal 或 Sprint Goal。PR 合并也不自动等于 Done；只有满足 DoD 且 Increment 可用才是 Done。

## 8. 转型期间不应同时做的事

- 不要同时更换 Issue 工具、分支模型、发布流程、日志框架和架构；
- 不要一次把全部旧里程碑重写为 Story；
- 不要用 story points 追求“速度提升”；
- 不要因为建立 Sprint 而停止接受用户反馈；
- 不要在没有隐私模型前连接远程遥测；
- 不要把流程文件写完当成转型完成。

每个 Sprint 只改少量工作方式，并在 Retro 检查是否真的改善了反馈周期。

## 9. 转型成效检查

首个三 Sprint 后检查：

| 问题 | 健康信号 | 风险信号 |
| --- | --- | --- |
| 目标 | 每个 Sprint 有一个清楚结果 | Task 很多但无法说明价值 |
| 完成 | 多数 PBI 满足 DoD | 大量工作自动滚入下一 Sprint |
| 质量 | CI 与真实环境证据同步形成 | 最后一天才测试和补文档 |
| 反馈 | Review 反馈改变 Backlog | Review 只是单向汇报 |
| 改进 | Retro 行动小且能验收 | 每次列很多问题但无人跟进 |
| 可观测 | 故障能按 trace 定位 | 继续依赖散落字符串和猜测 |

下一章：[[04-日志系统原理与工程规范]]
