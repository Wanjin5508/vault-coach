---
tags: [VaultCoach, v1.5, 里程碑9, CI-CD, Release]
status: planned
updated: 2026-10-09
depends-on:
  - 里程碑1-产品定位与发现入口.md
  - 里程碑8-迁移兼容与跨平台加固.md
---

# 里程碑 9：CI/CD、1.5 发布与持续更新

## 1. 目标

把前八个里程碑的证据转化为可重复发布门禁：PR 验证、版本一致性、bundle/release asset 检查、干净 Vault 安装、升级验证、GitHub Release、社区文案和回滚演练。

学习重点：GitHub Actions、SemVer、artifact provenance、发布故障定位、最小权限与可回滚发布。

## 2. 当前基线与已知风险

- `.github/workflows/lint.yml` 当前在 Node 20/22 运行 install/build/lint/test；
- `.github/workflows/release.yml` 仍需与当前 Node LTS、验证门禁和最新 action 版本对齐；
- release tag 必须与 `manifest.json` version 完全一致，格式为 `1.5.0`，没有前导 `v`；
- Community 安装依赖同一 tag 下的 `main.js`、`manifest.json` 和可选 `styles.css`；
- `version-bump.mjs` 必须按版本 key 检查 `versions.json`，不能因为相同 `minAppVersion` 已存在就漏掉新版本 key；
- Worker/WASM 方案可能产生隐藏的额外 asset 依赖，必须在构建产物中检查；
- `kb/` 当前被忽略，开发记录不会自动进入仓库发布历史。

## 3. 发布门禁层级

```text
Local fast checks
  └─ type/build + lint + focused tests
PR CI (Node 20/22)
  └─ clean npm ci + full test + build + release static checks
Release candidate
  └─ package exact assets + clean Vault + upgrade + desktop/mobile smoke
Tag workflow
  └─ rerun gates + verify tag/version + create GitHub Release
Post-release
  └─ install from Release + community metadata + monitor/rollback
```

Release job 要自己重新验证，不能只假设某个早期 PR workflow 已通过，因为 tag 指向和依赖状态可能改变。

## 4. 建议脚本

在 `package.json` 中组合已有脚本，名称以实际仓库风格为准：

```json
{
  "scripts": {
    "check": "npm run lint && npm test && npm run build",
    "verify:version": "node scripts/verify-version.mjs",
    "verify:release": "node scripts/verify-release-artifacts.mjs",
    "benchmark:retrieval": "node scripts/run-retrieval-benchmark.mjs"
  }
}
```

`verify-version.mjs` 检查：

- `package.json.version === manifest.json.version`；
- `versions.json` 含目标 version key；
- value 与 `manifest.minAppVersion` 一致；
- release 环境中 tag 与 version 一致；
- SemVer 与 tag 格式合法；
- 不把 tag `v1.5.0` 自动容错成成功。

`verify-release-artifacts.mjs` 检查：

- `main.js`、`manifest.json` 非空；
- 存在 `styles.css` 时非空并随 release；
- JSON 可解析；
- main.js 不引用绝对本机路径、source `.ts`、缺失 worker asset 或远程可执行 JS；
- bundle 体积与预算比较，超限需要明确审查；
- 产出 SHA-256 清单，便于下载后比对；
- release staging 目录不混入 `node_modules`、测试 fixture、模型权重或 API key。

## 5. 涉及文件与模块

| 文件/位置 | 修改 |
| --- | --- |
| `package.json` | scripts、version、description、固定依赖 |
| `package-lock.json` | 可重复依赖图 |
| `manifest.json` | version `1.5.0`、description、准确 minAppVersion |
| `versions.json` | 增加 `1.5.0: minAppVersion` |
| `version-bump.mjs` | 修复按 key 添加版本并增加测试 |
| `scripts/verify-version.mjs` | 新建版本一致性门禁 |
| `scripts/verify-release-artifacts.mjs` | 新建 release 文件/引用/体积检查 |
| `.github/workflows/lint.yml` | PR matrix 与缓存、最小权限 |
| `.github/workflows/release.yml` | tag gate、build、verify、release assets |
| `.github/workflows/benchmark.yml` | 可选，手工触发真实模型 benchmark |
| `README.md`、`README_CN.md` | M1 最终文案、安装、隐私、模型下载 |
| `CHANGELOG.md` / Release notes | 用户结果、迁移、限制、回滚 |
| `kb/.../VaultCoach-当前详细架构总览.md` | 更新实际 1.5 架构与接口 |

## 6. CI 工作流设计

### PR workflow

1. `checkout`；
2. `setup-node` 20/22 与 npm cache；
3. `npm ci`；
4. version/static config checks；
5. lint；
6. unit/integration tests；
7. production build；
8. release artifact static checks；
9. 上传失败时必要的小型日志，不上传私人 fixture/cache。

真实模型下载、WebGPU benchmark 和移动端测试不进入普通 PR CI。metric parser、fake Worker、migration fixture 和 bundle reference 检查必须进入。

### Release workflow

- 只允许匹配数字 SemVer 的 tag；
- `permissions: contents: write` 只授予 release job；其他 job read-only；
- 使用当前受支持的 action major 与 Node LTS；
- checkout tag commit，不 checkout 默认分支；
- `npm ci` 后完整复跑门禁；
- staging 目录只复制 release assets；
- 上传独立 `main.js`、`manifest.json`、`styles.css`；
- release 失败不自动移动/重写 tag；
- job summary 输出 version、commit、hash、测试结果。

## 7. 修复版本脚本

目标逻辑：

```js
versions[nextVersion] = minAppVersion;
```

更新前验证输入版本；更新后排序/格式遵循当前文件；已有同 key 且值不同则失败，不能静默覆盖。增加临时 fixture 测试：

1. 新版本与旧版本使用相同 minAppVersion，仍必须添加新 key；
2. key 已存在且值相同，幂等；
3. key 已存在但值不同，失败；
4. 非法 SemVer/minAppVersion，失败；
5. package/manifest/versions 最终一致。

## 8. Release Candidate 手工清单

### 从干净 checkout 构建

```bash
npm ci
npm run lint
npm test
npm run build
npm run verify:version
npm run verify:release
git diff --check
git status --short
```

确认构建没有依赖工作区未提交文件。`main.js` 是生成资产，遵循仓库规则不提交，但发布时必须由 tag commit 重建。

### 干净 Vault 安装

只复制 `main.js`、`manifest.json`、`styles.css` 到新的插件目录：

1. 启用插件；
2. 走全新 Setup Wizard；
3. 首次模型下载/取消/重试；
4. 断网暖启动；
5. Ask 引用、Test、Learning Map；
6. 清模型后 keyword fallback；
7. reload/unload 无泄漏或重复命令。

### 升级 Vault

从真实 1.4.1 副本升级：

1. 先备份；
2. 验证设置/provider 保留；
3. 验证无静默模型下载；
4. 旧向量正确 stale/rebuild；
5. chat/exam/assessment/graph governance 数据完整；
6. 回到 keyword 的路径可用；
7. 记录迁移前后摘要和日志。

### 平台证据

记录 Obsidian、OS、Node（仅构建）、设备、WebGPU/WASM、Vault 规模、模型 fingerprint、commit/tag。没有执行的平台写“未验证”，不写“支持已确认”。

## 9. 版本与发布顺序

1. 冻结 RC commit；
2. 在分支中更新 package/manifest/versions/CHANGELOG；
3. 跑完整门禁与 RC 手工清单；
4. 合并后确认 CI 使用同一 commit；
5. 创建 tag `1.5.0`；
6. release workflow 从该 tag 重建；
7. 核对 Release assets 的 manifest version 与 SHA-256；
8. 用 Release 下载文件做第二个干净 Vault smoke；
9. 更新 GitHub description/README/社区线程；
10. 观察 issue/日志，按严重度决定 patch 或撤下说明。

不要先发布 tag 再修改版本文件；也不要手工上传来自另一个 commit 的 `main.js`。

## 10. Release notes 结构

1. 用户结果：只需选择知识范围和聊天 LLM；
2. 新功能：本地语义搜索、真实索引进度、Setup Wizard；
3. 升级行为：旧 provider 保留，何时会下载模型/重建向量；
4. 隐私：哪些本地、哪些可能发给聊天 provider；
5. 平台与已验证范围；
6. 已知限制；
7. 清缓存、重建、切 keyword 的恢复步骤；
8. 完整 changelog/issue 链接。

不得把 fallback 成功表述为内置模型成功，也不得引用 M4 未达到或未复测的数字。

## 11. 持续更新渠道

准备一份同源摘要，再适配渠道：

- GitHub Release：完整技术和迁移内容；
- Obsidian Forum 原主题：用户结果、截图、升级注意；
- Discord：短摘要与 Release 链接；
- 中文社区：中文结果、隐私与排错；
- Marketplace metadata：最终 description。

发送外部消息是发布者手工动作。每个渠道记录发布时间、链接和纠正项，避免内容漂移。

## 12. 回滚与 hotfix 演练

发布前模拟：

1. Release workflow 构建失败：不创建半成品 release；
2. asset 缺失：修 workflow/commit，发布 `1.5.1`，不复用错误二进制；
3. 严重迁移 bug：建议用户保留备份和切 keyword，停止推广；
4. builtin 运行时大面积失败：通过已有设置切回旧 provider/keyword；
5. tag 指错 commit：记录事件并按 GitHub/社区约束选择撤下或新 patch，避免静默替换已下载资产；
6. 使用 release asset hash 确认用户实际版本。

Rollback 不能假设 1.4 能读 1.5 写出的所有 schema；在 release notes 明确数据备份和 downgrade 限制。

## 13. 工程实践与原因

- tag/version 严格一致让 Community 客户端找到正确资产；
- release 从 tag 重建，避免本地脏工作区二进制；
- PR 与 release 都验证，减少“合并后环境漂移”；
- 大模型 benchmark 与普通 CI 分离，兼顾稳定性与证据；
- 最小 workflow 权限减少供应链风险；
- staging allowlist 防止把缓存、源码或秘密打包；
- 发布后从下载资产重测，验证用户拿到的内容而非本地 build。

## 14. 完成标准

- [ ] Node 20/22 PR CI 的 lint/test/build/release check 全绿；
- [ ] version-bump 相同 minAppVersion 场景有回归测试；
- [ ] package/manifest/versions/tag 均为 `1.5.0` 且一致；
- [ ] main.js 无缺失 Worker/WASM 引用和本机绝对路径；
- [ ] 干净安装和 1.4.1 升级 smoke 有证据；
- [ ] Desktop/Mobile 验证范围和限制写入 Release notes；
- [ ] release assets 来自 tag commit 且 hash 已保存；
- [ ] 从下载的 release assets 再安装成功；
- [ ] README、架构总览、隐私和社区文案同步；
- [ ] 回滚/hotfix 演练完成；
- [ ] 未验证能力未出现在发布承诺中。

## 15. 实施记录

```text
RC commit：
Tag：
CI runs：
版本一致性：
Release asset SHA-256：
干净 Vault：
升级 Vault：
Desktop/Mobile：
下载资产复测：
外部渠道链接：
回滚演练：
发布后问题：
```
