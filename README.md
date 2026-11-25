# Mini Agent

Windows 桌面个人 AI 助理（自用）：主窗口多会话对话 · 多 Key 管理 · 托盘/快捷唤起 · 划词 · 截屏问 AI · 本地知识库（RAG，支持本地离线嵌入） · 内置多标签浏览器与 Agent 接管 · Agent 工具调用、任务依赖图、Worktree 隔离与断点恢复。

- **技术栈**：Electron + Vue 3 + Vite + Pinia + Tailwind；主进程 Node.js，存储 SQLite（node:sqlite 内置模块），知识库向量检索 faiss-node（本地嵌入走 onnxruntime-node + BGE 中文模型，可一键下载；远程嵌入走 OpenAI 兼容 /embeddings），Key 用 safeStorage（DPAPI）加密。
- **当前阶段**：P11–P15 自主推进已完成（包版本 1.5.0）：拖拽 DAG 编辑、运行中动态节点、FTS5 全文检索、局域网单写同步与离线补发、Windows UIA/CDP 电脑操作。质量基线：695 单测 / 78 文件、59 个非调试 mock E2E、覆盖率 74.90% / 70.65% / 76.53%；手机 UI 与双设备身份同步验收已补收。
- **安装包**：`dist-app/Mini Agent Setup 1.5.0.exe`（229,350,659 字节，约 219 MB，未签名）；静默安装、`SMOKE_OK` 和安装版 13 项专项 E2E 通过。SHA-256 `62198435bf78d4363628f7f4c0317dfbd49115bf7a156ecaf7d48f8f52f0b74a`。电脑操作需要 .NET 10 Windows Desktop Runtime（本机已具备）。

## 文档索引

| 文档 | 内容 | 版本 |
|---|---|---|
| [需求文档](docs/需求文档.md) | 功能范围、非功能需求、里程碑、开放问题、风险 | v0.2 |
| [技术设计](docs/技术设计.md) | 架构、关键流程、数据模型、IPC 接口、安全设计、M0 技术验证清单 | v1.1 |
| [开发计划](docs/开发计划.md) | M0–M5 任务拆解、验收标准、开放问题跟进 | v0.2 |
| [完成报告](docs/完成报告.md) | 交付总览、里程碑实现、缺陷修复、修订历史 | v1.5.0 |
| [内置浏览器研发契约](docs/内置浏览器研发契约.md) | 浏览器状态、IPC、Agent 工具、安全边界、回滚与限制 | v1.0 |

## 快速约定

- 平台：Windows 10+ / Win11；
- 模型接入：OpenAI 兼容协议，多 Key 故障转移/轮询；
- 质量基线：`npm run format`、`npm run lint`（`src` / `electron` / `tests`）、`npm test`、`npm run test:e2e:mobile`；
- 数据：全本地 SQLite，局域网设备同步；无遥测、无账号。
