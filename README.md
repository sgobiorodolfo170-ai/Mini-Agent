# Mini Agent

Windows 桌面个人 AI 助理（自用）：主窗口多会话对话 · 多 Key 管理 · 托盘/快捷唤起 · 划词 · 截屏问 AI · 本地知识库（RAG，支持本地离线嵌入） · 内置多标签浏览器与 Agent 接管 · Agent 工具调用、自动编排计划确认、任务依赖图、Worktree 隔离与断点恢复。

- **技术栈**：Electron + Vue 3 + Vite + Pinia + Tailwind；主进程 Node.js，存储 SQLite（node:sqlite 内置模块），知识库向量检索 faiss-node（本地嵌入走 onnxruntime-node + BGE 中文模型，可一键下载；远程嵌入走 OpenAI 兼容 /embeddings），Key 用 safeStorage（DPAPI）加密。
- **当前阶段**：Dev 预发布 v0.1.1：Agent 集群自动编排、计划确认、权限继承、共享目录写租约和完整关系面板已落地。质量基线：811 单测 / 80 文件、77 个非调试 mock E2E、覆盖率 74.26% / 71.72% / 77.70%。
- **版号规则**：`v0.1.0` 是首个 Dev 发布基线；后续 Dev 小版本从 `0.1.1`、`0.1.2` 继续递增。此前的 `1.x` 仅作为内部迭代历史，不再作为当前发布版号。
- **安装包**：GitHub Releases [`v0.1.1`](https://github.com/sgobiorodolfo170-ai/Mini-Agent/releases/tag/v0.1.1)（Dev 预发布，未签名）。电脑操作需要 .NET 10 Windows Desktop Runtime（本机已具备）。

## 文档索引

| 文档 | 内容 | 版本 |
|---|---|---|
| [需求文档](docs/需求文档.md) | 功能范围、非功能需求、里程碑、开放问题、风险 | v0.4 |
| [技术设计](docs/技术设计.md) | 架构、关键流程、数据模型、IPC 接口、安全设计、M0 技术验证清单 | v0.3 |
| [开发计划](docs/开发计划.md) | M0–M5 任务拆解、验收标准、开放问题跟进 | v0.4 |
| [完成报告](docs/完成报告.md) | 交付总览、里程碑实现、缺陷修复、修订历史 | v0.1.0 |
| [内置浏览器研发契约](docs/内置浏览器研发契约.md) | 浏览器状态、IPC、Agent 工具、安全边界、回滚与限制 | v1.0 |

## 快速约定

- 平台：Windows 10+ / Win11；
- 模型接入：OpenAI 兼容协议，多 Key 故障转移/轮询；
- 质量基线：`npm run format`、`npm run lint`（`src` / `electron` / `tests`）、`npm test`、`npm run test:e2e:mobile`；
- 数据：全本地 SQLite，局域网设备同步；无遥测、无账号。
