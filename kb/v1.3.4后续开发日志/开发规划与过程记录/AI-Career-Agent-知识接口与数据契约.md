---
tags:
  - 架构
  - CareerAgent
  - KnowledgeProfile
  - API
  - 数据契约
status: planned
updated: 2026-07-23
depends-on:
  - 三个项目协同架构与责任边界.md
  - KnowledgeEngine-Local-后续开发路线图.md
related:
  - VaultCoach-Lite-后续开发路线图.md
---

# AI Career Agent：知识接口与数据契约

## 1. 目的与严格边界

AI Career Agent 是职位匹配、投递管理和面试模拟产品，不扫描 Obsidian Vault、不调用 Obsidian API，也不自行构建 Vault 的文本索引、向量库或知识图谱。它仅通过 Knowledge Engine 的版本化 Capability API 读取用户明确发布的【KnowledgeProfile】。

本文只规定跨项目接口、数据语义、授权与验证；不规划 Career Agent 的页面、数据库、职位爬取、简历解析或付费业务实现。

~~~text
Vault Coach 选择知识与证据
       ↓（用户预览并授权）
Knowledge Engine 发布 KnowledgeProfile revision
       ↓（最小权限 Capability API）
AI Career Agent 做职位/简历/面试领域决策
~~~

Career Agent 不得把“模型推断”“职位文本要求”“用户简历事实”和“用户授权的知识证据”混为同一种事实。

## 2. 资源模型与版本规则

### 2.1 KnowledgeProfileV1

~~~ts
interface KnowledgeProfileV1 {
  schemaVersion: "knowledge-profile/v1";
  profileId: string;
  ownerId: string;
  revision: number;
  status: "active" | "revoked" | "deleted";
  generatedAt: string;
  sourceRevision: {
    workspaceId: string;
    syncedAt: string;
    graphRevision?: number;
    masteryAlgorithmVersion?: string;
  };
  skills: ProfileSkillV1[];
  consent: ProfileConsentV1;
}

interface ProfileSkillV1 {
  conceptId: string;
  label: string;
  aliases?: string[];
  category?: string;
  evidence: ProfileEvidenceRefV1[];
  mastery?: {
    level: "unknown" | "weak" | "developing" | "proficient" | "mastered";
    confidence: number;
    calculatedAt: string;
    algorithmVersion: string;
  };
}

interface ProfileEvidenceRefV1 {
  evidenceId: string;
  sourceKind: "vault-note" | "assessment";
  sourceRef: string;
  title?: string;
  excerpt?: string;
  visibility: "reference-only" | "excerpt";
}

interface ProfileConsentV1 {
  purpose: "career-personalization";
  grantedAt: string;
  expiresAt?: string;
  scopes: Array<"skills" | "evidence-references" | "evidence-excerpts" | "mastery">;
}
~~~

规则：

1. 【revision】只增不减；同一【profileId】的较旧 revision 不能覆盖新 revision。
2. 【sourceRevision】表达派生来源的新鲜度，不表示 Career Agent 已读取整个 Vault。
3. 【excerpt】默认不发送。没有【evidence-excerpts】scope 时，Career Agent 只能看到 source reference 与用户主动选定的 skill。
4. mastery 是可选且带 algorithm version 的学习信号，不能被当作“职业能力已被客观验证”的事实。
5. profile 被 revoke/deleted 后，所有后续 API 请求必须拒绝返回内容；Career Agent 必须停止使用并删除缓存副本。

### 2.2 职业领域数据保持独立

Career Agent 自己保存以下数据，并与 Knowledge Profile 使用不同 schema/权限：

~~~text
ResumeFact / JobDescription / Application / InterviewRecord / CareerPreference
~~~

职位要求和简历经验不能写回 Knowledge Engine 的 Concept/Relation；Vault Coach 的考试结果也不能写入 Career Agent 的面试评分。若需要关联，只保存显示层的 provenance label。

## 3. Capability API

以下是 Local 或未来 Cloud Engine 必须保持相同语义的逻辑接口。实际 HTTP path、鉴权头和错误格式以 Engine 的 OpenAPI 为准。

| 接口 | 调用方 | 目的 | 关键限制 |
|---|---|---|---|
| 【GET /v1/knowledge-profiles/{profileId}】 | Career Agent | 读取当前 active profile | 验证 owner、consent、scope、revision |
| 【GET /v1/knowledge-profiles/{profileId}/revisions/{revision}】 | Career Agent | 读取指定历史 revision（未撤销时） | 仅用于可重现报告，不可绕过撤销 |
| 【POST /v1/capability-gap-analysis】 | Career Agent | 用抽象职位 skill 与 profile 做有证据的差距分析 | 不接受任意 Vault 文本检索 |
| 【POST /v1/knowledge-profiles/{profileId}/access-events】 | Career Agent | 记录已读取 revision 与用途 | 用于用户审计和撤销追踪 |
| 【POST /v1/knowledge-profiles/{profileId}/revoke】 | Vault Coach/用户界面 | 撤销共享 | 立即阻止新访问并触发删除协商 |
| 【DELETE /v1/knowledge-profiles/{profileId}】 | Vault Coach/用户界面 | 删除 profile 派生副本 | 不删除 Vault 原始事实 |

### 3.1 差距分析请求

~~~ts
interface CapabilityGapAnalysisRequestV1 {
  schemaVersion: "capability-gap-request/v1";
  profileId: string;
  profileRevision: number;
  jobRequirements: Array<{
    requirementId: string;
    label: string;
    importance: "required" | "preferred";
    source: { kind: "job-description"; reference?: string };
  }>;
  purpose: "job-match" | "interview-prep" | "learning-plan";
}
~~~

### 3.2 差距分析响应

~~~ts
interface CapabilityGapAnalysisV1 {
  schemaVersion: "capability-gap/v1";
  profileId: string;
  profileRevision: number;
  generatedAt: string;
  items: Array<{
    requirementId: string;
    status: "supported" | "partial" | "missing" | "insufficient-evidence";
    matchedSkillIds: string[];
    evidenceRefs: ProfileEvidenceRefV1[];
    explanation: string;
    provenance: Array<"knowledge-profile" | "job-description" | "model-inference">;
  }>;
  limitations: string[];
}
~~~

要求：

- 【supported】必须至少有一个用户授权 evidence reference；仅模型语义相似不能得到该结论。
- 【partial】与【insufficient-evidence】必须保留不确定性，UI 不能将其渲染成“没有能力”。
- Career Agent 可以据此推荐学习方向，但每条建议必须标明来自职位要求、Profile 事实还是模型推断。

## 4. 授权、撤销与隐私流程

### 4.1 发布流程

1. 用户在 Vault Coach 选择 Concept、文件夹、证据引用以及是否包含 mastery。
2. Vault Coach 显示实际发送字段、用途、接收方、是否包含 excerpt、有效期和撤销入口。
3. 用户确认后，Knowledge Engine 创建新的 profile revision；Career Agent 只能读取 active revision。
4. Career Agent 首次使用时记录 access event，并在界面展示“本结论使用了已授权知识画像”。

### 4.2 撤销与删除流程

1. 用户撤销时，Engine 立刻将 profile 标为 revoked，新的 GET/analysis 返回明确的授权错误。
2. Engine 向 Career Agent 发出删除协商或由 Career Agent 轮询 revision/status；Career Agent 删除缓存后回写删除确认。
3. 用户删除 profile 时，Engine 清理派生副本和访问 token；Vault Coach 的 Markdown、图谱事实、考试事实保持不变。
4. 云端上线前，必须另行规定备份保留期、删除 SLA、账号删除和法律合规流程。

Local Engine 模式下，Profile 默认仅在用户机器保存；Career Agent 若不在同一设备或未获单独连接授权，则不得访问。

## 5. 错误、兼容性与安全约定

| 情况 | API 语义 | Career Agent 行为 |
|---|---|---|
| profile revision 过期 | conflict，返回可用 revision 元数据 | 询问/刷新，不静默替换报告依据 |
| consent 过期或已撤销 | forbidden/revoked | 停止使用，移除缓存，提示重新授权 |
| Engine 不可用 | unavailable | 保留简历/JD 功能，不将缺少 profile 说成用户能力不足 |
| schema 不兼容 | upgrade-required | 禁止降级解析未知字段，提示升级服务/客户端 |
| evidence scope 不足 | partial response | 只显示允许字段，不尝试回查 Vault |

- 传输层必须携带用户/产品身份与最小 scope；Cloud 模式必须使用 HTTPS。
- Local 模式默认只监听 loopback，不能因 Career Agent 方便而暴露到局域网。
- Profile ID 不是访问凭证；不能以猜测 ID 获取其他用户资料。
- API 日志不可记录完整 Markdown、embedding 向量、聊天文本或 token。

## 6. 两端必须共同完成的契约测试

1. 用 JSON Schema 验证【KnowledgeProfileV1】、gap request/response、错误响应和未知字段处理。
2. 覆盖 active、expired、revoked、deleted、旧 revision、仅 reference scope、含 excerpt scope 等 fixture。
3. 验证同一 profile revision 的差距分析可重现，并保留 provenance；模型输出变化时必须标明版本/限制。
4. 验证 Career Agent 无 profile、无 scope 或 profile 被撤销时，无法请求任意 Vault content、检索接口或图谱全量数据。
5. 验证删除确认后，Career Agent 缓存和 Engine profile 副本均不能继续访问；Vault Coach 本地事实未被删除。

## 7. 交付边界

完成本接口文档和 contracts fixture 后，Career Agent 团队可以并行实现 API client、授权提示和 provenance 展示；但只有 Knowledge Engine 的 KE-6 实现并通过契约测试后，才可启用真实跨项目能力画像。

三个项目共享的是稳定、可撤销、最小化的数据产品，而不是共享数据库、共享 Vault 文件系统权限或复制一套知识图谱实现。
