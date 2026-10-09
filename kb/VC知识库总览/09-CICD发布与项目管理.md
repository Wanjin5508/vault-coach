---
tags:
  - VaultCoach
  - CICD
  - 发布
  - 项目管理
---

# CI/CD 发布与项目管理

## 当前工程工具链

- 包管理器：npm。
- 语言：TypeScript。
- 打包：esbuild。
- 类型检查：`tsc -noEmit -skipLibCheck`。
- lint：ESLint + obsidianmd 规则。
- 构建产物：`main.js`、`manifest.json`、`styles.css`。
- 版本文件：`manifest.json`、`versions.json`、`package.json`。

## GitHub Actions

`lint.yml`：

- 在 push 和 pull request 触发。
- Node 20.x 和 22.x 矩阵。
- 执行 `npm ci`、`npm run build --if-present`、`npm run lint`。

`release.yml`：

- 在 tag 匹配 `x.y.z` 时触发。
- 使用 Node 18。
- 执行 `npm ci`、`npm run build`。
- 用 GitHub CLI 创建 release，并上传 `main.js`、`manifest.json`、`styles.css`。

## 面试问答

### 1. Obsidian 插件发布需要哪些产物？

社区插件发布通常需要 `main.js`、`manifest.json` 和可选的 `styles.css`。源码不直接被 Obsidian 加载，TypeScript 需要先通过 esbuild 打包到 `main.js`。

### 2. 为什么不能随意提交构建产物？

源码仓库中提交构建产物容易造成 diff 噪音和版本不一致。项目约定不提交 `node_modules` 和生成产物；release workflow 在打 tag 时自动构建并上传产物。

### 3. 为什么 CI 要跑多个 Node 版本？

本地开发环境可能不同，CI 用 Node 20 和 22 做构建验证，可以提前发现依赖、语法或工具链兼容问题。release 使用 Node 18，是更接近 LTS 的保守构建环境。

### 4. 版本发布流程是什么？

更新代码后运行 build 和 lint，调整 `manifest.json`、`versions.json` 和 `package.json` 中的版本。创建与 manifest 版本完全一致的 tag，例如 `1.2.6`，push tag 后 release workflow 自动创建 GitHub Release 并上传产物。

### 5. Obsidian 官方审核可能关注什么？

它会关注 manifest 合规、版本格式、构建产物、禁用不允许的 ESLint 规则、跨窗口 DOM 类型判断、远程网络请求披露、是否隐藏遥测、是否执行远程代码等。项目曾遇到过 directive comment 和 `instanceof HTMLButtonElement` 的审核问题，需要按规则修复。

### 6. 项目管理上如何控制范围？

通过 `PROJECT_PLAN.md` 把项目分成多个阶段。第一阶段先做好 Advanced RAG，考试模式作为面试训练方向逐步接入。知识图谱、多 Agent 和独立应用放在后续阶段，避免早期范围过大。

### 7. 如何处理 README 和实际代码不一致？

这是一类典型发布风险。比如旧 README 曾写“考试模式后台尚未实现”，但源码已经实现。发布前需要把 README、README_CN、技术文档、manifest 描述和实际功能对齐，否则用户和审核者都会困惑。

### 8. 为什么要写考试模式技术文档？

考试模式涉及 LLM JSON 稳定性、评分标准、保存策略、历史链接和多个用户体验坑。把实现和坑记录下来，可以降低后续维护成本，也能在面试中展示工程复盘能力。

### 9. 如果让你改进 CI/CD，你会做什么？

可以增加 release 前校验：检查 `manifest.json`、`versions.json`、`package.json` 版本一致；检查 README 中版本徽章；运行 Obsidian 插件审核规则；打包后验证 `main.js` 存在；自动生成 release notes。

### 10. 项目的技术债有哪些？

常量中 `VIEW_TYPE_VAULT_COACH` 和 `VIEW_NAME_VAULT_COACH` 存在命名 typo；README_CN 部分内容可能滞后；考试上下文抽样还比较简单；向量索引是内存线性扫描；长期记忆检索仍是关键词匹配；移动端 embedding 还未正式接入。

