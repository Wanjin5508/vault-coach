---
title: UI、可靠性、隐私、移动端与 CI/CD 质量门禁
status: current
updated: 2026-10-24
---

# UI、可靠性、隐私、移动端与 CI/CD 质量门禁

## 1. UI 与可访问性

测量视图打开 P50/P95、设置页渲染、搜索或筛选响应、首个流式 token 展示、图交互帧时间和重复打开后的监听器数量。功能验收覆盖键盘操作、焦点顺序、Esc 关闭、屏幕阅读标签、窄屏布局、长文本、中文/英文/德文和主题切换。

建议把 100 ms 以内视为直接操作反馈的观察目标，把超过一帧的重计算移出关键 UI 路径；最终门槛必须以真实 Obsidian 设备基线确定。

## 2. 可靠性

- 命令成功率、未处理异常数、超时率和取消成功率。
- 连续 enable/disable 后残留 listener、interval、Worker 数，应为 0。
- Vault 文件在操作中被删除/重命名时的恢复率。
- Ollama/云服务不可用时的错误提示正确率和 Lite fallback 可用率。
- 崩溃注入后数据完整率与最后有效快照恢复率。

## 3. 隐私与安全

默认离线路径的外网请求数应为 0。云端和模型下载分别验证显式触发、目标域名、发送字段、日志脱敏和取消。测试日志、结果 JSON、错误栈、设置文件和提交内容中不得出现 API key、Vault 正文或不必要的文件名。

依赖测试包括 lockfile 固定、已知漏洞审查、许可证确认和发布包中无远程可执行代码。模型权重是数据资产；Worker/WASM 必须作为本地发布资产交付。

## 4. 移动端

桌面结果不能代表移动端。iOS 和 Android 分别记录启动时间、索引峰值内存、后台切换恢复、低内存终止、触屏操作、文件 API 兼容、WASM/WebGPU 可用性、耗电和发热观察。无法运行的功能要显示明确降级状态。

## 5. CI/CD 门禁

每个 PR 至少运行：

```bash
npm ci
npm run lint
npm test
npm run build
git diff --check
```

涉及 M4 资产时增加：

```bash
npm run m4:validate
npm run m4:build:obsidian-smoke
```

发布验收还需检查 `manifest.json`、`versions.json`、SemVer、tag、`main.js`/`manifest.json`/`styles.css` 三类资产、干净 Vault 安装、升级迁移和回滚。记录 bundle bytes 和相对上一版本的增长；阈值应在获得数个版本基线后冻结。

测试覆盖率可以发现未执行代码，但不能证明断言正确。覆盖率适合作为趋势和风险提示，不应替代领域不变量、集成测试与人工设备验证。

