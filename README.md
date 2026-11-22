# Mini Agent

Windows 桌面个人 AI 助理（自用）：主窗口多会话对话 · 多 Key 管理 · 托盘/快捷唤起 · 划词 · 截屏问 AI · 本地知识库（RAG，支持本地离线嵌入） · Agent 工具调用。

- **技术栈**：Electron + Vue 3 + Vite + Pinia + Tailwind；主进程 Node.js，存储 SQLite（node:sqlite 内置模块），知识库向量检索 faiss-node（本地嵌入走 onnxruntime-node + BGE 中文模型，可一键下载；远程嵌入走 OpenAI 兼容 /embeddings），Key 用 safeStorage（DPAPI）加密。
- **当前阶段**：v1.4 功能已落地（最近提交：面板类对话输入区重做为 AgentComposer + 采样设置改为全局配置），质量基线全绿（302 单测 / 40 文件 + 27 个非调试 mock e2e / eslint / prettier / 覆盖率门槛）。
- **注意**：`dist-app/` 内的 NSIS 安装包 `Mini Agent Setup 1.2.0.exe` 为 2026-11-21 重新打包（含 v1.2–v1.4 全部改动，构建冒烟 `SMOKE_OK`）；更早的 `miniagent Setup 1.0.0/1.1.0.exe` 为历史产物，仅供留档。

## 文档索引

| 文档 | 内容 | 版本 |
|---|---|---|
| [需求文档](docs/需求文档.md) | 功能范围、非功能需求、里程碑、开放问题、风险 | v0.2 |
| [技术设计](docs/技术设计.md) | 架构、关键流程、数据模型、IPC 接口、安全设计、M0 技术验证清单 | v1.1 |
| [开发计划](docs/开发计划.md) | M0–M5 任务拆解、验收标准、开放问题跟进 | v0.2 |
| [完成报告](docs/完成报告.md) | 交付总览、里程碑实现、缺陷修复、修订历史 | v1.4 |

## 快速约定

- 平台：Windows 10+ / Win11；
- 模型接入：OpenAI 兼容协议，多 Key 故障转移/轮询；
- 质量基线：`npm run format`、`npm run lint`（`src` / `electron` / `tests`）、`npm test`；
- 数据：全本地 SQLite，预留同步字段；无遥测、无账号。
