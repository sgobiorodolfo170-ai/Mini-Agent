# Mini Agent

Windows 桌面个人 AI 助理（自用）：主窗口多会话对话 · 多 Key 管理 · 托盘/快捷唤起 · 划词 · 截屏问 AI · 本地知识库（RAG，支持本地离线嵌入） · Agent 工具调用。

- **技术栈**：Electron + Vue 3 + Vite + Pinia + Tailwind；主进程 Node.js，存储 SQLite（node:sqlite 内置模块），知识库向量检索 faiss-node（本地嵌入走 onnxruntime-node + BGE 中文模型，可一键下载；远程嵌入走 OpenAI 兼容 /embeddings），Key 用 safeStorage（DPAPI）加密。
- **当前阶段**：v1.1 完成，质量基线全绿（283 单测 + 16 mock e2e / eslint / prettier / 覆盖率门槛），NSIS 安装包已产出（dist-app/）并完成安装冒烟。

## 文档索引

| 文档 | 内容 | 版本 |
|---|---|---|
| [需求文档](docs/需求文档.md) | 功能范围、非功能需求、里程碑、开放问题、风险 | v0.2 |
| [技术设计](docs/技术设计.md) | 架构、关键流程、数据模型、IPC 接口、安全设计、M0 技术验证清单 | v0.1 |
| [开发计划](docs/开发计划.md) | M0–M5 任务拆解、验收标准、开放问题跟进 | v0.1 |

## 快速约定

- 平台：Windows 10+ / Win11；
- 模型接入：OpenAI 兼容协议，多 Key 故障转移/轮询；
- 质量基线：`npx prettier --check`、`npx eslint "src/**" "electron/**"`、`npx vitest run`；
- 数据：全本地 SQLite，预留同步字段；无遥测、无账号。
