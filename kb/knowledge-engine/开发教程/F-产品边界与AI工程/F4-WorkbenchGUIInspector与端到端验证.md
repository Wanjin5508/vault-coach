---
tags: [KnowledgeEngine, 教程, Workbench, GUI, E2E]
parent: README.md
milestone: KE-1
---

# F4 Workbench GUI、Inspector 与端到端验证

## 学习目标

将 GUI 设计为独立产品界面和验证工具，而不是绕过服务层的管理后台。

## 先理解

- Workbench 是 API 的第一个客户端：它暴露契约缺口、错误模型和异步状态问题；
- Inspector 不是普通 UI：它把 request、scope、revision、预算、命中、job 阶段和降级原因变成可观察证据；
- 页面状态不是真相，job/revision/store 才是真相；刷新/关闭页面不应改变任务语义；
- E2E 测试验证 GUI → API → database/worker 的真实闭环，单元测试无法替代。

## Engine 落点

最小 Workbench 使用 **React + TypeScript**，包含 Workspace/Sources、Index & Jobs、Retrieval Inspector、Graph Explorer、Training/Exam、Agent Console、Settings/Privacy。所有数据通过 contracts SDK 获取，页面只请求有界列表和分页详情。它先以浏览器访问 loopback Engine；到 KE-9，再由 Electron Desktop Host 启动同一 Engine、探测 health，并承载同一构建产物。桌面壳不得新增数据库直连、第二套业务 API 或与浏览器不同的数据语义。

## 动手练习

1. 从匿名资料导入开始，做一条 E2E：导入 → job → retrieval hit → locator；
2. 给 Job Inspector 加 refresh 后状态恢复与 cancel；
3. 给 Graph Explorer 加 node/edge budget 与 `truncated` 提示；
4. 为 API 503、过期 revision 和无权限 scope 写 GUI 错误态；
5. 断开 Obsidian，验证 Workbench 考试闭环仍可用。
6. 在 Electron 引入后，验证首次启动、服务未就绪、端口冲突、退出、升级和数据目录保留；浏览器与桌面端必须通过同一 E2E fixture。

## 通过检查

- 开发者可只用 Workbench 定位大多数数据/检索/任务问题；
- GUI 没有数据库直连或隐藏写入；
- 独立模式有自动化 E2E 作为发布门禁。
- Electron 只是本地服务与同一 Web UI 的生命周期宿主；Mac App Store/Tauri 只有在发布或性能指标达到触发条件后才评估。

## 下一步

阅读 [F2 同意、数据最小化、隐私与删除](./F2-同意数据最小化隐私与删除.md)。
