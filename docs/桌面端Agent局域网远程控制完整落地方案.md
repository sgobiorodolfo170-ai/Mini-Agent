# Mini Agent 桌面端局域网远程控制完整落地方案

> 文档状态：已落地，随实现更新  
> 版本：V2.1  
> 日期：2026-11-23  
> 依据：用户提供的《桌面端 Agent 局域网远程控制技术实施方案》V1.0，以及 Mini Agent 当前源码核对结果  
> 交付范围：架构、认证、权限、协议、状态机、事件一致性、数据库、H5、Windows、测试、发布与回滚

---

## 0. 实施结论与不可变决策

本方案直接以 **Electron 主进程 + Fastify + ws + Vue 3 H5 + 同一 SQLite 数据库**落地，不另起 Agent 引擎，不增加云端服务，不使用 Tauri。

**必须先行决策：**

1. 默认使用 **HTTPS + WSS**。TLS 配置或手机证书信任未完成时，只提供显式开启的受限 HTTP/WS 兼容模式。
2. 受限模式仅开放配对、只读状态和普通对话；禁止 Agent 模式启动、审批、任务暂停/继续/取消、设备管理。
3. 手机是交互终端，桌面 Agent Core 是唯一执行主体；禁止远程任意命令接口。
4. 设备长期凭证与浏览器短期会话分离。长期凭证只用于换取会话，不进入 WebSocket URL，不写入 IndexedDB、localStorage 或日志。
5. 每个远程操作均需校验：设备状态、会话状态、角色权限、目标会话存在性、协议参数、业务状态。已配对设备自动获得全部会话访问范围。
6. 远程创建任务只允许 `readonly` 或 `autonomous`，禁止 `full`；禁止“记住后免确认”跨任务扩大权限。
7. 远程事件使用 SQLite 持久化全局递增 `seq`，不能直接把当前内存 Hub 的序号当作可恢复事件游标。
8. 审批使用持久化记录和事务抢占；当前内存 `state.confirms` 不是完整审批系统。
9. 当前停止是协作式中止，不承诺强杀任意工具或子进程；暂停/继续属于新增能力。
10. 手机锁屏和后台持续在线不属于第一版承诺；前台恢复后以快照和事件补发收敛。

### 0.1 当前项目事实与差距

| 项目 | 已核对事实 | 本方案处理 |
|---|---|---|
| 桌面技术栈 | Electron 45、Node.js 主进程、Vue 3/Vite/Pinia，CommonJS 主进程 | 沿用，远程模块使用 `.js` CommonJS |
| 数据库 | `node:sqlite`、`DatabaseSync`、WAL、`user_version=7` | 迁移至 v8；远程表并入同库，独立 repository |
| Agent 启动 | `startAgentRun()` 支持会话、权限、幂等键、父子 Run | Remote Agent Adapter 薄封装 |
| 任务状态 | `queued/running/waiting_child` 及终态，已有版本 CAS | 保留；新增控制意图，不伪造已暂停状态 |
| 任务停止 | `stopRun()` 中止模型请求、拒绝后续工具、处理待确认 | 复用并补来源审计；不宣称强杀进程 |
| 确认机制 | `respondConfirm()`，内存 Map，5 分钟超时 | 重构为持久化 ApprovalService，桌面与手机共用 |
| 普通对话 | `sendChat()` / `stopChat()`；同会话新发送会中止旧流 | 远程显式调用，UI 明示替代行为 |
| 事件中枢 | 进程内 Hub，默认 500 条，全局 seq，重启归零 | 仅作实时 fan-out；新增 SQLite Remote Event Store |
| 桌面 IPC | chat、conversation、agent、sessions、events 已存在 | 新增 `remote:*` 桌面管理 IPC；手机不直连 IPC |
| 远程服务 | 源码未发现 RemoteServer/配对服务 | 全新模块，默认关闭 |

对应源码位置：`electron/main/agent/index.js`、`electron/main/agent/loop.js`、`electron/main/events/hub.js`、`electron/store/db.js`、`electron/store/repos.js`、`electron/main/gateway/index.js`、`electron/main/ipc.js`。

---

## 1. 范围、角色与验收边界

### 1.1 本期功能

- 桌面端启停远程控制、网卡/端口选择、二维码、连接诊断。
- 一次性扫码配对（桌面展示二维码即代表用户确认）、设备撤销、角色权限管理；全部会话自动授权，不显示核对码或会话勾选。
- 手机查看会话、消息、Run、工具调用摘要和待审批。
- 手机创建会话、发送普通对话、创建受限 Agent Run。
- 手机处理审批、请求暂停/继续/停止，查看处理结果。
- 多手机连接、独立权限、断线重连、状态快照、事件补偿。
- 审计、资源限额、数据保留、关闭清理和数据库备份迁移。

### 1.2 不做

- 公网访问、内网穿透、云端账号和中继。
- 远程桌面、视频流、手机直接文件浏览或任意 PowerShell。
- 远程修改模型供应商、API Key、授权目录、MCP、Hook、Agent 全局设置。
- 远程审批“永久免确认”或 `full` 权限。
- 第一版远程上传附件、导出文件、删除本地会话/消息/项目。
- 原生 App、WebRTC、UDP 自动发现和 IP 改变后的无感寻址。

### 1.3 环境边界

- Windows 10/11，Windows 网络配置文件必须为“专用网络”。
- 手机与电脑可互相访问；访客网络/AP 隔离不属于可绕过条件。
- 局域网可完全断开互联网，但模型调用本身若使用在线供应商仍需互联网。
- 生产 H5 全部静态资源随安装包提供，不依赖 CDN。

---

## 2. 总体架构与模块边界

```text
手机浏览器（Vue 3 + TypeScript + Pinia）
        │ HTTPS / WSS
        ▼
Fastify（静态资源 / API / 安全中间件）
        │
        ▼
Remote Auth Guard → Remote Message Router → Remote Agent Adapter
        │                                      │
Pairing / Device / Session              Agent Core / Gateway / Repos
        │                                      │
Approval Service / Remote Event Store ─────────┤
        │                                      ▼
        └──────────────────────────────► SQLite（同一 miniagent.db）

Electron Renderer → preload window.api.remote → remote:* IPC → RemoteControlManager
```

### 2.1 目录落点

```text
electron/main/remote/
├── index.js                  # 生命周期与依赖组装
├── config.js                 # 配置、默认值与校验
├── server.js                 # Fastify/HTTPS/WS/优雅关闭
├── security.js               # Host/Origin/IP/CSRF/headers/limits
├── network.js                # 网卡枚举、地址变化、诊断
├── pairing-service.js        # 一次性配对与桌面确认
├── device-service.js         # 设备、凭证轮换、撤销
├── auth-service.js           # 短期会话、Cookie、WS 认证
├── permission-service.js     # RBAC + 会话范围
├── protocol.js               # 信封与 payload 运行时校验
├── router.js                 # 命令白名单、统一授权和错误映射
├── agent-adapter.js          # 唯一 Agent/Gateway 调用出口
├── approval-service.js       # 持久化审批和事务抢占
├── run-control-service.js    # 暂停/继续/停止控制意图
├── event-store.js            # 持久事件、游标、清理
├── event-bridge.js           # Core/notify → 远程事件
├── snapshot-service.js       # 原子授权快照
├── repos.js                  # 远程表事务与查询
├── certificate-service.js    # CA/服务证书/信任材料
├── audit-service.js          # 脱敏审计
└── retention.js              # 过期数据与容量清理

src/entries/remote-mobile/
├── index.html
├── main.ts
├── App.vue
├── pages/{Pair,Chat,Tasks,Approvals,Devices}.vue
├── services/{api,ws,reconnect}.ts
├── stores/{device,conversation,run,approval}.ts
└── components/

src/entries/shared/remote-protocol/ # 网络 DTO + zod schema
src/components/remote/             # 桌面远程设置组件
src/stores/remote.js
```

`electron.vite.config.mjs` 新增 `remote-mobile` 入口；生产构建产物通过 Fastify 安全静态目录提供，禁止将任意 `userData` 或项目目录映射为静态目录。

### 2.2 依赖建议

新增最小生产依赖：`fastify`、`@fastify/static`、`@fastify/cookie`、`ws`、`qrcode`、`zod`。优先使用 Node/Electron 自带 `crypto`、`node:sqlite`、`os.networkInterfaces()`，不增加原生网络或数据库依赖。证书生成方式需在 R0 spike 中确认，见 §8。

---

## 3. 服务生命周期与网络

### 3.1 默认配置

| 配置 | 默认值 | 说明 |
|---|---|---|
| enabled | false | 应用启动不自动对外开放，除非用户上次明确选择自动开启 |
| host | 用户选择的 LAN IPv4 | 不默认 `0.0.0.0` |
| port | 37651 | 冲突时显示候选端口，不静默更换已展示的二维码 |
| transport | tls | `tls` / `restricted_plain` |
| maxDevices | 5 | 已绑定有效设备上限 |
| maxConnections | 12 | 全局 WS 上限，单设备最多 3 条 |
| sessionIdleMinutes | 30 | 短期会话空闲过期 |
| sessionAbsoluteHours | 12 | 无论活跃与否均过期 |
| eventRetention | 7 天且最多 5000 条 | 达到任一清理条件即裁剪 |
| auditRetention | 90 天且最多 20000 条 | 导出/清理策略后续可配置 |

### 3.2 启动与关闭

启动顺序：读取配置 → 校验网卡和 Private Profile → 初始化 TLS/受限模式 → 建 Fastify 但不接受业务 → 注册安全插件 → 加载静态资源 → 监听端口 → 标记 ready → 生成二维码 → 开启事件桥。

停止顺序：标记 draining → 拒绝新请求/配对 → 发送 `remote.service.stopping` → 关闭 WS → 撤销全部短期会话 → 取消未消费配对票 → 注销事件监听和定时器 → 关闭 Fastify → 释放防休眠状态。

**长期设备绑定默认不因临时关闭而删除**；提供“关闭并撤销所有设备”的独立危险操作。应用退出必须执行同一关闭流程，窗口隐藏到托盘不影响服务状态。

### 3.3 监听和防火墙

- 优先绑定选定 IPv4；只有明确多网卡需求才监听 `0.0.0.0`。
- 入站规则：程序路径优先、TCP、实际端口、Private、RemoteAddress=LocalSubnet；禁止 Public 放行、禁止关闭防火墙。
- 不信任 `X-Forwarded-For`，以 socket 地址做来源限制。
- IP 仅允许 RFC1918；若确需 CGNAT 局域网另行白名单，不默认放行任意地址。
- 多网卡默认展示名称、IPv4、类型和推荐项；VPN/虚拟/回环/169.254 默认排除，可高级展开。
- DHCP/IP 变化：服务进入 degraded，旧二维码失效；生成新二维码，已打开页面显示“电脑地址已变化，请重新扫码”。设备绑定是否保留由证书主机/IP 变化策略决定，不自动猜新地址。
- 每 15 秒及 `visibilitychange` 相关诊断时检查地址/监听状态，不做高频网络扫描。

### 3.4 Host、Origin 和浏览器防护

- HTTP/WS 均校验 `Host` 为当前二维码 IP + 实际端口；不信任用户提交的 Host 构造链接。
- WS `Origin` 必须与当前服务 origin 精确匹配；无 Origin 的 WS 默认拒绝。
- 状态变更 REST 要求同源 Origin/Fetch Metadata；WS 命令沿用已认证的 socket，不使用 Cookie 以外的环境信息作为唯一依据。
- Cookie：`HttpOnly; SameSite=Strict; Path=/;`，TLS 下加 `Secure`；不设置 `Expires/Max-Age`，使用浏览器会话 Cookie，刷新可保留，浏览器退出后的恢复由浏览器策略决定，不作持久登录承诺。
- 响应头：`Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`（API/配对页）；静态带 hash 资源才可长缓存。
- CSP 禁止任意第三方脚本、frame 嵌入和未授权连接；路由返回 404 不暴露本地文件路径。
- 服务不注册协议处理器、不开放 CORS、不响应跨域预检为允许。

---

## 4. 配对、认证、撤销完整闭环

### 4.1 三类凭证严格分离

| 凭证 | 内容/存储 | 生命周期 | 用途 |
|---|---|---|---|
| pairing ticket | 32 字节 CSPRNG，服务端存 SHA-256 哈希 | 180 秒、一次性 | 只申请配对，不可访问业务 |
| device secret | 32 字节 CSPRNG，服务端仅存带设备域分隔的 SHA-256 哈希 | 至轮换/撤销 | 换取短期会话，不用于 WS URL |
| browser session | 32 字节随机 ID，服务端存哈希、设备、CSRF secret 哈希和过期信息 | 30 分钟空闲、12 小时绝对上限 | HttpOnly Cookie，鉴权 HTTP/WS |

SHA-256 适用于上述高熵随机凭证；不是用于低熵密码。当前不生成辅助核对码，也不要求桌面端二次批准。

### 4.2 配对状态机

```text
issued ──有效扫码──→ consumed
   ├─→ expired（180 秒）
   └─→ cancelled（服务停止或刷新二维码）
```

1. 桌面生成 ticket，二维码仅含 `https://IP:port/pair#ticket=...`。使用 fragment，避免进入 HTTP 请求和访问日志。
2. 手机打开 `/pair`，JS 读取 fragment 后调用 `history.replaceState` 清理地址栏；POST `/api/v1/pair/requests`，body 仅含 ticket 和设备名。
3. 服务端在事务中校验 ticket 有效，创建 operator 设备及凭证哈希、登记会话能力，原子将 ticket 置为 consumed，并在同一响应返回一次 `deviceId + deviceSecret`。重复或并发消费不得新增设备。
4. 展示二维码即代表桌面用户已确认连接，不再生成核对码、等待批准或二次交换凭证。二维码只应向可信用户展示。
5. 手机立即用 device secret 换取短期 Cookie 并建立 WSS；设备凭证仅存于 sessionStorage，不写 localStorage/IndexedDB。
6. 当前和后续创建的会话自动对设备可见；viewer/operator/approver 的操作权限仍由服务端逐命令校验，Agent 工具高风险审批不受此变更影响。

### 4.3 短期会话与 WebSocket

- `POST /api/v1/auth/session` 使用 device secret 和设备 ID，成功后轮换 session，旧 session 立即失效。
- 每个 session 绑定 device_id、角色快照版本、created_at、last_seen_at、absolute_expires_at、revoked_at。
- WSS 握手只接受同源 HttpOnly session Cookie；握手后再次查询设备/会话，不是只看 Cookie 是否存在。
- 每条命令仍检查设备 revoked、session 过期和权限版本；不能只靠建连时检查。
- 权限收紧/设备撤销时 `auth_version` 递增，关闭该设备全部 WS 和 session。
- 页面刷新先调用 `/api/v1/auth/status`；无 Cookie 且无内存 device secret 时进入重新配对。
- 退出登录仅撤销当前 session；“移除设备”撤销所有 session 和设备 secret。

### 4.4 桌面审批与设备管理

设备列表仅显示 ID 短码、名称、权限、会话范围、最近活动和在线状态，永不显示 secret/token。撤销事务：

```text
BEGIN IMMEDIATE
  devices.status = revoked
  devices.auth_version += 1
  revoked_at = now
  撤销该设备全部 sessions
  取消该设备未完成 pairing
  写审计
COMMIT
→ 关闭对应 WS（代码 4403）
→ 拒绝后续请求
```

已配对设备默认可读取当前及后续创建的全部会话，无需勾选；角色变化递增 `auth_version` 并关闭旧连接。设备只能查看自身状态，管理其他设备仅桌面本地管理员可执行。

---

## 5. 权限模型与高风险边界

### 5.1 角色权限矩阵

| 能力 | viewer | operator | approver | desktop admin |
|---|---:|---:|---:|---:|
| 查看授权会话/消息/Run | ✓ | ✓ | ✓ | ✓ |
| 创建会话/发送普通消息 | — | ✓ | ✓ | ✓ |
| 创建 readonly/autonomous Run | — | ✓ | ✓ | ✓ |
| 请求暂停/继续/停止 | — | ✓ | ✓ | ✓ |
| 处理工具审批 | — | — | ✓ | ✓ |
| 查看审批 | 按授权 | 按授权 | ✓ | ✓ |
| 修改设备权限/撤销其他设备 | — | — | — | ✓ |
| 修改本机名称/退出当前会话 | ✓ | ✓ | ✓ | ✓ |

三种手机角色互斥，`approver` 只增加审批能力，不隐式获得 operator 的发送/控制能力，也不是设备管理员；需要同时具备两类能力时由桌面创建两个逻辑设备身份，或将矩阵显式调整为组合 capabilities 后重新评审。第一版按本表的单角色 allowlist 实现。

### 5.2 会话范围

已配对设备默认获得全部会话的读取范围，操作和审批仍由设备角色控制。`remote_device_grants` 仅保留作能力映射与兼容旧数据，不再是静态会话白名单；新建和后续创建的会话自动可见，不需要逐项授权或桌面勾选。

### 5.3 与 Agent 现有权限的关系

设备 RBAC 决定“能不能发起”；Conversation 的 `default/readonly/autonomous/full` 和 Run mandate 决定“Agent 能做什么”。两者取交集，不互相替代：

- 远程启动只接受 `readonly`、`autonomous`。
- 即使桌面会话此前为 `full`，远程发起也必须显式降为 `autonomous` 或 `readonly`。
- 远程设备不能修改会话权限、授权目录、工具白名单或 Hook。
- 桌面端本地权限收紧立即可影响后续工具调用；任何远程批准都不能覆盖 mandate、目录和 Hook 拒绝。
- 审批页面必须显示工具名、风险、完整必要参数摘要、目标对象、Run、申请时间、过期时间；秘密字段脱敏。

---

## 6. 统一网络协议

### 6.1 信封

所有 WS 消息 UTF-8 JSON，服务端接收单帧最大 64 KiB；普通消息正文最大 16,000 字符，超出返回错误。流式下行事件单独限长/分片。

```json
{
  "v": 1,
  "id": "01J...",
  "kind": "command",
  "type": "agent.run.start",
  "conversation_id": "uuid-or-null",
  "request_id": "uuid-for-command",
  "expected_version": 3,
  "payload": {},
  "sent_at": 1795329600000
}
```

服务端事件：

```json
{
  "v": 1,
  "id": "event-uuid",
  "kind": "event",
  "type": "run.status.changed",
  "seq": 1832,
  "stream_epoch": "service-start-uuid",
  "conversation_id": "uuid",
  "payload": {},
  "sent_at": 1795329601000
}
```

- `v` 为协议版本，不兼容升级新增 v2，不在同一类型中暗改语义。
- `request_id` 为命令幂等键，同设备范围内唯一；`id` 可用于追踪，不能替代幂等键。
- `stream_epoch` 标识事件存储世代；重置/换库后不得沿用旧游标。
- 客户端时间仅展示，不参与过期和权限判断，全部安全时间以服务端为准。
- 使用 zod 对 kind/type/id/payload 逐类严格校验，拒绝未知字段、非法枚举、错误类型和超限数组。

### 6.2 命令与响应

| type | 方向 | 权限/说明 |
|---|---|---|
| `session.subscribe` | C→S | 订阅已授权会话，携带 `after_seq`、`epoch` |
| `conversation.create` | C→S | operator；标题、模型沿用现有会话解析规则 |
| `chat.message.send` | C→S | operator；`mode=chat`，附件首版拒绝 |
| `chat.message.stop` | C→S | operator；指定 msgId，属于普通对话停止 |
| `agent.run.start` | C→S | operator；goal、permission(readonly/autonomous) |
| `agent.run.pause` | C→S | operator；控制意图，非即时保证 |
| `agent.run.resume` | C→S | operator；从安全等待点恢复 |
| `agent.run.stop` | C→S | operator；协作式停止 |
| `approval.respond` | C→S | approver；approval_id、decision、expected_version |
| `events.ack` | C→S | 记录设备已处理游标 |
| `device.heartbeat` | 双向 | 心跳不包含业务数据 |
| `command.ack` | S→C | accepted/rejected/completed/failed，附业务结果或错误 |
| `protocol.error` | S→C | 版本、格式、权限或状态错误 |

`command.ack` 必须区分：

- `accepted`：已持久化控制意图，不代表执行完成。
- `completed`：同步操作或状态已达到目标。
- `rejected`：未执行，含稳定错误码。
- `failed`：接收后失败，需结合 Run/审计判断副作用。

### 6.3 错误码

统一 `{code, message, retryable, request_id}`。至少包括：`UNAUTHENTICATED`、`DEVICE_REVOKED`、`SESSION_EXPIRED`、`FORBIDDEN`、`CONVERSATION_FORBIDDEN`、`RATE_LIMITED`、`INVALID_MESSAGE`、`PAYLOAD_TOO_LARGE`、`UNSUPPORTED_VERSION`、`NOT_FOUND`、`STATE_CONFLICT`、`VERSION_CONFLICT`、`APPROVAL_EXPIRED`、`APPROVAL_ALREADY_DECIDED`、`IDEMPOTENCY_CONFLICT`、`BACKPRESSURE`、`SERVICE_STOPPING`、`INTERNAL_ERROR`。

对外错误不包含 SQL、堆栈、API Key、绝对用户目录和完整敏感工具输出；详细内容只写本地脱敏日志。

---

## 7. 任务控制与审批状态机

### 7.1 Run 状态不另起事实源

保留现有 `agent_runs.status` 及 CAS。**固定新增 `remote_run_controls` 表，不修改 Run status 枚举**；控制意图关联 Run、请求者和版本。UI 展示组合状态：

| Run 状态 | 控制状态 | 手机展示 |
|---|---|---|
| queued | none | 等待执行 |
| running | none | 执行中 |
| running | pause_requested | 正在等待安全暂停点 |
| running | paused | 已暂停 |
| running | resume_requested | 正在恢复（paused 仅存于控制态） |
| running/waiting_child | stop_requested | 正在停止 |
| done/stopped/error/max_steps/transferred | 任意 | 最终状态，不可逆 |

不得把 `pause_requested` 直接展示成“已暂停”。取消与完成竞争时由现有 Run CAS 决定最终状态，迟到事件不得覆盖终态。

### 7.2 暂停/继续执行语义

- 在模型调用前、每个工具调用前、工具完成后设协作检查点。
- `pause` 到达时设置 `pause_requested`；不中断已经在执行的模型响应或工具。
- 到达安全点后持久化 `paused`，停止发起新模型/工具；广播实际暂停点。
- `resume` 仅接受 `paused`，清除控制态并继续同一 Run；不是新 Run，不重置 steps。
- `stop` 可随时请求，优先于 pause/resume；中止模型请求并禁止后续工具。对于不可中止的工具，最终状态等其返回后收敛。
- 工具本身不提供强制 kill 语义。若未来增加可终止子进程，必须单独实现 PID/进程树回收和超时升级，不在本期伪实现。
- 等待审批时暂停：审批可保留但不可执行；恢复后重新校验审批有效期、Run 状态和参数摘要。
- 应用崩溃恢复：现有启动回收把活动 Run 标 stopped，待处理审批统一置 `cancelled`（decision_reason=app_restarted），不自动继续。

### 7.3 持久化审批模型

```text
pending → approved / rejected
   ├─→ expired
   └─→ cancelled / superseded
```

单 Electron 主进程不引入长生命周期 `claimed` 状态；事务内条件更新就是抢占。

数据库记录：`approval_id`、Run、conversation、step/tool_call_id、tool、canonical_args、args_hash、risk、status、version、created_at、expires_at、decided_by、decided_at、decision_reason。

canonical_args 使用确定性 JSON 序列化（键排序、统一空值/Unicode 处理），`args_hash=SHA256(tool_version + run_id + canonical_args)`。批准后执行前重新计算，不一致则 `superseded`，绝不复用。

### 7.4 多设备审批原子性

1. 服务端校验 approver、会话范围、设备/会话有效、expected_version。
2. `BEGIN IMMEDIATE` 读取 pending 审批；校验未过期、Run 可执行。
3. 条件更新 `WHERE approval_id=? AND status='pending' AND version=?`，changes=1 才算获胜。
4. 同事务写决定、审计和远程事件；提交后 resolve 内存等待者。
5. 其他设备收到 `approval.decided`；重复响应返回已处理结果或 `APPROVAL_ALREADY_DECIDED`，绝不再次执行。
6. 工具 handler 调用前再做一次 `execute_guard`：审批仍 approved、hash 一致、Run 非 stopped/paused、mandate 仍允许。
7. 拒绝、过期和取消均返回给 Agent 循环作为工具拒绝结果，不静默跳过。

内存等待者与数据库关系：创建审批先落库，再注册 waiter；超时事务置 expired 后 resolve；桌面与手机都调用同一 `ApprovalService.respond()`，不允许桌面走旧的独立 Map 逻辑。

---

## 8. TLS 与受限明文模式

### 8.1 默认 TLS 方案

个人局域网无公网域名场景采用“本地私有 CA + 每安装实例服务证书”：

1. 首次启用时生成独立本地 CA，私钥用 Electron `safeStorage`（Windows DPAPI）加密保存，私钥不进入数据库明文、二维码或手机页面。
2. 服务证书 SAN 仅包含当前选择的 LAN IP；证书有效期建议 30 天，到期前自动续签。CA 私钥与服务私钥分离。
3. 二维码包含服务地址和 CA 指纹（仅用于核对，不替代信任）；桌面显示 CA 指纹和安装指引。
4. 手机需安装/信任本地 CA，或在提供“导出 CA 证书”后按 Android/iOS 官方流程确认。浏览器证书警告不能作为正常验收通过。
5. IP 变化时重签服务证书；CA 可保留，新二维码带新地址。私钥解密失败则停止服务，不自动降级 HTTP。
6. 提供“重置远程安全材料”危险操作：撤销所有设备、删除旧 CA/服务证书并重新配对。

**R0 技术验证必须完成**：在受管 Node/Electron 运行时生成 X.509 CA 与服务证书、证书链校验、SAN IP 校验、Windows 打包可用性、Android Chrome 与 iOS Safari 信任流程。若纯 JS 库不满足维护/安全要求，选用成熟证书库；不得手写 ASN.1 或自造加密协议。

### 8.2 为什么不能把自签名证书当零配置

仅启动自签名 HTTPS 不等于手机信任。没有明确 CA 安装/证书信任步骤时，用户会看到警告，WSS 也可能无法建立。证书信任未完成时不得声称“安全配对已完成”，也不能用忽略证书错误的客户端设置作为生产方案。

### 8.3 受限 HTTP/WS 模式

仅桌面本机用户显式开启，每次启动显示风险，并满足：

- 仅 Private + LocalSubnet；默认不持久化自动开启。
- 允许配对、查看授权会话、普通 chat 消息和设备自退出。
- 禁止 Agent Run 创建、审批、任务控制、设备权限修改。
- 页面顶部持续显示“局域网非加密连接，消息和设备凭证可能被同网络攻击者窃取”。
- 设备 secret 默认仅存内存，不持久化到浏览器数据库。
- 一旦检测 Public Profile 或非白名单来源，停止监听。

---

## 9. 事件持久化、快照与断线恢复

### 9.1 序号和存储世代

远程事件表使用 SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` 作为**全局 seq**，不按设备、不按会话分别编号。`stream_epoch` 为远程事件存储初始化 UUID；只有清空重建事件流时才更换，不因普通应用重启变化。

每个事件包含：`event_id`、seq、epoch、conversation_id、run_id、type、payload_json、created_at。会话事件按 conversation/run 授权过滤；设备专属事件按 type 和已认证设备单独生成，不依赖前端隐藏。事件入库是远程事实记录，当前内存 Hub 仅负责即时通知。

### 9.2 写入顺序

- Run/消息/审批业务事实先提交，再写远程事件；需强一致的状态转换在同一事务写业务与事件。
- token delta 是易失展示事件，采用 100–200ms 或 2KiB 节流批量入库；最终 `message.completed` 必须携带权威内容和 message_id。
- 工具事件默认仅保存摘要和截断结果，不把秘密或完整大文件内容复制到远程事件。
- WebSocket 推送失败不回滚已经完成的业务事实；客户端通过游标补齐。
- 多手机按会话授权过滤后各自发送，不能先广播敏感事件再依赖前端隐藏。

### 9.3 重连算法

1. WSS 建连认证完成，客户端提交 `{epoch, after_seq, subscriptions}`。
2. epoch 不一致、after_seq 小于最早保留 seq-1，或游标非法：进入 snapshot，不补发历史流。
3. 正常情况按 seq 升序分页补发，每页最多 200 条；逐条按当前权限过滤。
4. 补发期间新事件进入该连接的有界队列；补发完成后按 seq 排序/去重再刷新队列。
5. 快照由 SnapshotService 在一个 SQLite 读事务中生成，记录 `snapshot_seq`；然后补发 `seq > snapshot_seq` 的事件。
6. 客户端按 `(message_id, seq)` 处理 delta；completed 覆盖本地增量，重复 seq 不重复渲染。
7. `events.ack` 只用于诊断和保留策略，不授权、不修改业务状态；服务端不依赖 ack 判定命令已经执行。

### 9.4 快照内容

快照只包含设备有权访问的：会话列表、每会话最近 50 条消息、活动/最近 50 个 Run、工具调用摘要、pending approvals、当前连接状态、当前 snapshot_seq/epoch。历史通过显式分页 REST 获取，不把全库塞入一个 WS 消息。

快照和单页事件均受尺寸限制；超限采用分页/摘要，不截断 JSON 字符串。在线状态是“最近心跳+socket 状态”的估值，UI 必须区分已连接、重连中、离线未知。

### 9.5 背压与重连

- 客户端退避：1、2、4、8、16、30 秒封顶，加 ±20% 随机抖动。
- 心跳建议每 20 秒，45 秒无 pong/有效消息判为失联，关闭半开连接。
- 单连接待发队列最多 256 条或 2MiB，达到阈值发送 `BACKPRESSURE` 后断开；客户端重连走快照。
- 不对过期 delta 无限排队；会话状态、审批决定和撤销优先于流式增量。
- `visibilitychange` 回前台立即检查 auth/status 和 socket，不假设后台连接仍活跃。

---

## 10. 数据库 v8 设计

所有表使用服务端 UUID/整数主键、Unix 毫秒时间戳，状态字段 CHECK 约束，密钥只存哈希。迁移前自动备份 `miniagent.db` 及 WAL 一致性副本；迁移在事务中执行，成功后 `PRAGMA user_version=8`，失败回滚并阻止远程服务启动，不影响原桌面只读恢复。

### 10.1 新表

```sql
CREATE TABLE remote_devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','operator','approver')),
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  auth_version INTEGER NOT NULL DEFAULT 1,
  ua_summary TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE remote_pairing_tickets (
  ticket_id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  request_id TEXT UNIQUE,
  device_name TEXT,
  status TEXT NOT NULL CHECK(status IN
    ('issued','awaiting_desktop','approved','consumed','rejected','expired','cancelled')),
  verification_code_hash TEXT,
  requested_ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  consumed_at INTEGER
);

CREATE TABLE remote_sessions (
  session_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES remote_devices(device_id),
  auth_version INTEGER NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE remote_device_grants (
  device_id TEXT NOT NULL REFERENCES remote_devices(device_id),
  conversation_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, conversation_id)
);

CREATE TABLE remote_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  epoch TEXT NOT NULL,
  conversation_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE remote_commands (
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','completed','rejected','failed','interrupted_unknown')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, request_id)
);

CREATE TABLE agent_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool_call_id TEXT,
  tool TEXT NOT NULL,
  canonical_args TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('pending','approved','rejected','expired','cancelled','superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_reason TEXT
);

CREATE TABLE remote_run_controls (
  run_id TEXT PRIMARY KEY,
  control_state TEXT NOT NULL CHECK(control_state IN
    ('none','pause_requested','paused','resume_requested','stop_requested')),
  requested_by TEXT,
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE remote_event_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  epoch TEXT NOT NULL,
  oldest_available_seq INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE remote_audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  session_hash TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  result TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
```

索引至少覆盖：`remote_events(seq)`、`remote_events(conversation_id,seq)`、`remote_sessions(device_id)`、`agent_approvals(status,expires_at)`、`remote_audit_logs(created_at)`。

### 10.2 命令幂等

- `(device_id, request_id)` 唯一；request_hash 覆盖 type、conversation、payload 和关键目标版本。
- 首次在单事务中插入 accepted，再执行业务适配；完成后更新 result_json。核心业务和命令占位必须使用可恢复协议：见下方“崩溃恢复窗口”。
- 同 request_id + 同 hash：completed 返回原结果，accepted 返回处理中，failed/rejected 按类型返回稳定结果。
- 同 request_id + 不同 hash：`IDEMPOTENCY_CONFLICT`，绝不执行。
- 保留至少 7 天/每设备最近 1000 条；过期后客户端不得复用旧 request_id。
- 普通 chat 必须先改造 Core：发送参数增加服务端生成的 `origin_message_id`，插入用户消息前以该 ID 查询/唯一约束去重，同一事务登记业务结果；命中旧消息时不得再次插入、终止当前流或启动新流。
- `agent.run.start` 传 `idempotencyKey = device_id + ':' + request_id`，但**不能止于当前 `createRun()`**：命中既有 Run 时必须立即返回其 IDs/当前状态，禁止继续插入 user/assistant 消息、覆盖 active Map 或启动第二次 `doAgentRun`。启动前增加“同会话活动 Run”约束及唯一索引/事务闸门。
- **崩溃恢复窗口**：accepted 记录存在但无业务结果时，不自动重放可能已有副作用的命令。chat 按 origin_message_id 查找，Run 按 idempotencyKey 查找；找到则回填结果并返回，找不到则标记 `interrupted_unknown`，要求用户核对后使用新 request_id。为让 unknown 可表达，`remote_commands.status` 增加 `interrupted_unknown`。
- 外部工具副作用不具备天然可回滚性；本机制保证命令去重，不宣称所有工具可事务化 exactly-once。

### 10.3 保留与隐私清理

每小时及启动时清理：过期 ticket/session、超窗事件、超期命令、超期审计。事件清理后保留 epoch 和最小可补游标元信息，旧客户端收到 snapshot 而不是静默缺事件。

工具参数和正文可能含个人数据，审计默认记录摘要/哈希/结果，不记录完整 secret、消息正文、文件正文。日志不可包含 Cookie、ticket、device secret、Authorization 或连接 URL 查询串。

---

## 11. REST 与桌面 IPC 清单

### 11.1 手机 REST（全部 `/api/v1`，默认拒绝未认证）

| 方法与路径 | 鉴权 | 功能 |
|---|---|---|
| `POST /pair/requests` | 一次性 ticket + 限流 | 扫码即绑定设备并返回一次设备凭证 |
| `POST /auth/session` | device_id + device secret | 创建短期 Cookie 和 CSRF secret |
| `POST /auth/logout` | session + CSRF | 撤销当前 session |
| `GET /auth/status` | 可选 session | 返回 auth、权限版本、epoch |
| `GET /bootstrap` | session | 授权摘要和快照地址 |
| `GET /conversations` | viewer+ | 分页授权会话 |
| `POST /conversations` | operator+ | 创建并仅授权当前设备 |
| `GET /conversations/:id/messages` | grant | 按 seq/时间分页 |
| `GET /runs` | grant | Run 列表 |
| `GET /runs/:id/calls` | grant | 工具摘要分页 |
| `GET /approvals?status=pending` | approver | 待审批列表 |
| `GET /devices/me` | session | 当前设备和权限 |
| `GET /events?after=&epoch=` | session | WS 不可用时的有界补发降级 |

任何 list 均默认 limit 上限 100，禁止无界 `limit=-1`；目标 ID 先查 grant 再查业务，未授权统一返回 404 或 `CONVERSATION_FORBIDDEN`，不泄露对象详情。

### 11.2 桌面 IPC（仅主窗口 preload 暴露）

| IPC | 功能 |
|---|---|
| `remote:state` / `remote:diagnose` | 服务、TLS、地址、连接和错误诊断 |
| `remote:start` / `remote:stop` | 启停服务，参数包含网卡/端口/模式 |
| `remote:qrcode` | 当前二维码数据，不返回长期凭证 |
| `remote:pairing:list` / `remote:pairing:respond` | 桌面人工批准/拒绝 |
| `remote:devices:list` / `remote:devices:update` | 设备名、角色、授权范围 |
| `remote:devices:revoke` / `remote:devices:revokeAll` | 撤销 |
| `remote:audit:list` | 本地脱敏审计分页 |
| `remote:certificate:export` / `remote:certificate:reset` | CA 导出与安全材料重置 |
| `remote:changed` | 服务/配对/设备事件 |

IPC handler 校验发送窗口为主窗口，不将远程管理 API 暴露给 quick/ball/capture 窗口。

---

## 12. Agent Adapter 详细映射

| 远程动作 | 当前能力 | 必须改造/约束 |
|---|---|---|
| 普通发消息 | `gateway.sendChat({conversationId,content,...})` | 校验 grant；记录 remote actor；首版禁附件；提示同会话新流替代旧流 |
| 普通停止 | `gateway.stopChat(msgId)` | 先通过 message→conversation 查 grant；返回 accepted，不等于已落 stopped |
| Agent 启动 | `agent.startAgentRun()` | permission 白名单；server 生成 mandate/trace；idempotencyKey 由服务端生成 |
| Agent 停止 | `agent.stopRun(runId,'user')` | 扩展 actor/reason 审计参数；不承诺强杀工具 |
| 工具审批 | `agent.respondConfirm()` | 替换为 ApprovalService，桌面和手机同一事务入口 |
| Run 查询 | `repos.listRuns/getRun/getRunCalls` | 按 grant 过滤，输出 DTO，不直接返回原始数据库行 |
| 会话/消息 | `repos.*Conversation/listMessages/msgOut` | 按 grant 过滤、分页、去除敏感 meta |
| 子会话 | `agent/sessions.js` | 首版只读授权派生会话；禁止手机任意跨会话 send/wait |
| 事件 | `notify.broadcast/getHub()` | EventBridge 白名单转换，禁止原始全量转发 |

### 12.1 消息 DTO

只输出 id、conversationId、role、content、status、seq、createdAt、agentRunId、必要附件元信息。`meta` 中密钥、内部路径、Hook 上下文、完整工具参数默认不透传。工具 DTO 只输出 step、name、风险、参数摘要、状态、起止时间、截断结果；敏感字段在生成摘要时脱敏。

### 12.2 并发规则

- 同一会话普通 chat 沿用“新发送取代旧流”，远程提交前返回提示并写审计；第一版 UI 在已有流时禁用新发送更稳妥。
- Agent Run 是否允许同会话并行由 Agent Core 决定；远程第一版建议同会话仅一个活动根 Run，返回 `STATE_CONFLICT`。
- 多设备可同时查看；停止/暂停/恢复通过 expected_version 和控制 CAS 决定，重复成功请求返回当前状态。
- 桌面和手机具有相同业务状态优先级，桌面管理员可停止任何本地 Run；手机只能操作其 grant 内 Run。

---

## 13. 手机 H5 与桌面界面

### 13.1 手机页面

- **配对**：证书信任引导、设备名、等待桌面确认、拒绝/过期重试；页面不展示完整 ticket。
- **会话**：授权会话列表、消息流、连接状态、只读/可写权限、活动 Run 提示。
- **任务**：状态、步骤、工具摘要、暂停/继续/停止，按钮根据服务端状态而不是本地乐观猜测。
- **审批**：风险、目标、参数摘要、过期倒计时、批准/拒绝；已被他人处理立即锁定。
- **设备**：仅当前设备信息、角色、授权范围、退出；不提供越权管理其他设备。

交互要求：离线/重连中禁止重复提交；命令显示已接收/执行中/已完成；危险按钮二次确认；错误信息可理解且可复制错误码。Markdown 使用经过 sanitize 的渲染，不直接 `v-html` 原始 Agent/工具内容。

### 13.2 浏览器状态

- device secret 默认内存保存；session Cookie 由浏览器管理，前端 JS 不读取。
- IndexedDB 只缓存非授权 UI 偏好和非敏感最近展示数据，且不能作为授权依据；敏感缓存提供退出即清除。
- `pageshow`、`visibilitychange`、`online` 事件触发状态检查；`offline` 仅作提示，不代表服务器不可达。
- iOS Safari 和 Android Chrome 分别验证返回前台、锁屏、刷新、Wi-Fi 切换和 Cookie 生命周期。

### 13.3 桌面远程控制页

展示：服务开关、TLS/受限模式、网卡/IP/端口、二维码、CA 信任引导、待配对卡片、设备与授权、活动连接、审计、事件存储状态、防火墙诊断。

高危动作独立确认：重置安全材料、撤销全部设备、切换受限明文。远程功能默认关闭；任何启动失败都显示具体阶段和可操作修复，不出现二维码已展示但服务未 ready 的状态。

---

## 14. 安全、资源与故障处理

### 14.1 限流与限额

- 配对申请：单 IP 5 次/分钟，全局 20 次/分钟；失败指数惩罚，最多 5 个待桌面确认。
- session 创建：单 IP 5 次/分钟；认证失败统一模糊错误。
- 命令：每设备 30 次/分钟；Agent 启动 5 次/分钟；审批 20 次/分钟。
- 请求头≤16KiB、JSON body≤64KiB、WS 单帧≤64KiB；普通消息 16,000 字符。
- 连接建立 10 秒内完成有效认证；每设备 3 条 WS，全局 12 条。
- 工具输出下行单条摘要≤20KiB；快照分页；请求处理超时默认 15 秒，长任务走 accepted + 事件。
- 超限返回 429/413 或关闭 WS，不通过无限排队保护表面可用性。

### 14.2 威胁与对策

| 威胁 | 对策 |
|---|---|
| 同 Wi-Fi 窃听/篡改 | 默认 TLS；受限模式禁高危能力并持续警示 |
| 二维码被他人扫描 | 180 秒一次性短票、原子消费、二维码仅向可信用户展示；撤销设备立即断开 |
| 并发消费同一票据 | UNIQUE + BEGIN IMMEDIATE 条件更新 |
| DNS Rebinding/恶意网页 | Host/Origin/Fetch Metadata、SameSite、禁 CORS |
| XSS/Markdown 注入 | sanitize、CSP、禁原样 v-html、参数 schema |
| 凭证泄露 | 短期会话、哈希落库、日志脱敏、撤销和轮换 |
| 重放命令 | request_id + hash + 持久化结果 + Run 幂等键 |
| 重复/越权审批 | 角色 + grant + version CAS + args_hash + execute_guard |
| 设备撤销后旧 socket 操作 | 每命令重新校验、auth_version、主动断开 |
| 慢客户端/大包耗尽内存 | 帧/队列/连接/分页/背压限额 |
| 敏感数据扩散到手机 | DTO 白名单、工具摘要、meta 清理、会话 grant |
| 公网意外暴露 | LAN IP 绑定、Private 防火墙、LocalSubnet、无端口映射 |

### 14.3 故障语义

- 模型/Key 失败沿用现有错误和 Run 终态，不由远程层自动重复执行。
- DB 锁/磁盘满：命令失败并写可理解的本地诊断；不假装 accepted。
- 远程事件写失败：状态事件优先告警并暂停远程写操作，避免手机看到错误事实；delta 可丢弃但必须最终 snapshot 收敛。
- TLS 私钥/证书错误：服务不启动，不自动回退明文。
- 端口占用：展示冲突和候选端口，用户确认后重启并重新生成二维码。
- 远程服务崩溃不影响桌面 Agent 本地使用；未完成任务按现有崩溃回收规则处理。

---

## 15. 分阶段施工计划

工作量以熟悉仓库的 1 名开发者估算，包含测试，不含真实手机证书安装等待；不是承诺工期。每个阶段必须完成测试和文档回写，不能在基础安全未完成时提前开放高危能力。

### R0：技术验证与冻结协议（0.5–1 周）

- [ ] Fastify + ws 在 Electron 主进程启动/停止，打包后路径正确。
- [ ] node:sqlite v8 新表迁移、回滚和 WAL 备份验证。
- [ ] 私有 CA、服务证书、IP SAN、DPAPI 私钥保存全链路。
- [ ] Android Chrome/iOS Safari 真实信任 CA、HTTPS 和 WSS。
- [ ] Cookie + WSS 同源握手、SameSite、刷新恢复验证。
- [ ] 冻结 zod 协议、错误码、事件 DTO 和权限矩阵。

出口：两台真实手机均无证书警告地完成配对前置连接；否则只能进入受限模式开发，不能开放 Agent/审批。

### R1：网络、只读服务和桌面控制（0.5–1 周）

- [ ] `RemoteControlManager` 生命周期、配置、网卡、端口、防火墙诊断。
- [ ] Fastify 静态 H5、Host/Origin、安全头、请求限额。
- [ ] 桌面远程页、二维码、状态/错误展示。
- [ ] v8 基础表、备份迁移、远程 repository。
- [ ] 未认证只能访问静态资源、pair 和 auth/status。

出口：断外网、保留 Wi-Fi 时可打开 H5；非法 Host/Origin、未认证、Public Profile 均被拒绝。

### R2：配对、会话、设备与权限（1–1.5 周）

- [ ] 一次性扫码绑定、短期会话、设备撤销。
- [ ] device secret → 短期 session Cookie → WSS 认证。
- [ ] RBAC、device grants、auth_version、撤销和权限收紧。
- [ ] 设备列表、退出、会话刷新/过期/撤销恢复。
- [ ] 限流、审计和凭证脱敏。

出口：未授权不能读取任何 Agent 数据；有效二维码直接完成连接，重复扫码无效；撤销后旧 WS 的下一条命令也失败；角色权限修改强制重连；全部现有和后续会话自动可见。

### R3：只读同步与普通消息（1–1.5 周）

- [ ] EventStore/EventBridge/SnapshotService。
- [ ] 会话、消息、Run、工具摘要 DTO 和分页。
- [ ] chat.send/chat.stop 适配、命令幂等和审计。
- [ ] WSS 心跳、重连、补发、快照、背压。
- [ ] H5 会话/任务页面、浏览器生命周期处理。

出口：断线、事件溢出、快照竞态、重启后不错误串线；普通消息重试不生成重复用户消息；未授权会话不可见。

### R4：持久化审批与 Agent 控制（1.5–2 周）

- [ ] 将现有内存确认统一迁移到 ApprovalService，保持桌面 UI 兼容。
- [ ] args canonical/hash、过期、取消、事务抢占和执行前 guard。
- [ ] 远程 readonly/autonomous 启动、Run 幂等。
- [ ] pause/resume 协作检查点、stop 来源审计和状态组合。
- [ ] H5 审批和控制界面、多设备冲突处理。
- [ ] TLS 是高危能力启用的硬门禁。

出口：两个 approver 同时批准只执行一次；批准后参数变化失效；停止与完成竞争只有一个终态；暂停不冒充已停止正在运行的工具。

### R5：加固、体验和发布（1 周）

- [ ] 多设备/多会话授权和隔离、IP 变化重新扫码。
- [ ] 数据清理、审计查询、备份恢复、资源压力测试。
- [ ] 防休眠可选项（仅 `ES_SYSTEM_REQUIRED`，退出恢复）。
- [ ] NSIS 打包、离线资源检查、安装/升级/回退验证。
- [ ] 完整真机验收、文档和版本变更记录。

出口：§16 全部 P0/P1 验收完成，质量基线通过，发布包可在干净 Windows 环境运行。

---

## 16. 测试与验收矩阵

### 16.1 单元/集成测试

新增 `tests/unit/remote-*.test.js`、`tests/integration/remote-*.test.js`（若沿用当前 tests 目录结构则按实际测试配置落位），重点不是只测函数存在，而是测竞争与失败：

| 类别 | 必测用例 |
|---|---|
| schema | 未知 type/字段、错误枚举、超长 body、非法 ID、v2 不兼容均被拒 |
| pairing | 过期、重复消费、取消、刷新二维码、直接绑定、并发扫码不重复创建设备 |
| auth | secret 错误、Cookie 过期、绝对过期、撤销、轮换、WS Origin/Host |
| RBAC | viewer 写入、operator 审批、未登录读取、删除会话访问均失败；全部会话对有效设备可见 |
| idempotency | 同 ID 同 body 返回原结果；同 ID 不同 body 冲突；重启后仍去重 |
| Run CAS | stop/done、pause/resume/stop、expected_version 冲突、迟到事件不覆盖终态 |
| approval | 双设备同事务批准一次、过期、取消、args hash 变化、拒绝后不得执行 |
| events | 全局 seq、epoch、分页、过滤、快照期间新事件、溢出回 snapshot |
| backpressure | 慢客户端达到上限断开，不无限占内存，重连可恢复 |
| migration | v7→v8、重复迁移、失败回滚、旧桌面数据不变 |
| DTO | API Key、Cookie、secret、SQL、堆栈和敏感 meta 不出现在网络输出 |

### 16.2 安全对抗用例

1. 恶意网页尝试跨域 POST、WS 和非预期 Host，全部拒绝。
2. 篡改 ticket、device secret、Cookie、approval_id，未登录会话访问与角色越权均被拒绝。
3. 同一审批两个设备同时 approve，数据库只有一条获胜决定，工具只调用一次。
4. 批准后篡改工具目标，args_hash 不一致，状态 superseded。
5. 设备撤销后不重建 WS，直接在原 socket 发命令，仍被拒绝。
6. 重放已 completed 命令不重复写消息/Run；改变 payload 返回幂等冲突。
7. 发送 64KiB 以上帧、嵌套 JSON、非法 UTF-8/高频消息，服务稳定且有限流。
8. Agent 返回 HTML/脚本/Markdown 链接，手机不执行任意脚本、不自动打开外部页面。
9. 日志和错误响应扫描不到凭证明文和模型 Key。
10. Public Profile、非 LAN 来源或证书失败时不静默降级。

### 16.3 真机与网络验收

至少一台 Android Chrome、一台 iPhone Safari、一台 Windows 目标机：

- 首次 CA 信任、扫码即连接、刷新、退出、使用新二维码绑定其他设备。
- 两台手机同一会话同时查看和不同角色操作。
- Wi-Fi 断开 10 秒/2 分钟恢复，补发或 snapshot 正确。
- 锁屏 1 分钟、后台 5 分钟后回前台，不显示虚假在线。
- 电脑 DHCP 改 IP、切换网卡、端口被占、AP 隔离时提示准确。
- 断互联网仅保留 LAN：静态页面、配对、查看、WSS 正常；在线模型失败可理解。
- 桌面隐藏托盘、退出、远程开关、应用异常重启后的状态和凭证清理。
- 弱网/高延迟下连续流式输出不阻塞控制命令和撤销。
- 资源离线：开发者工具无 CDN 请求，无未打包资源 404。

### 16.4 性能验收（个人桌面规模）

- 空闲远程服务不持续高 CPU；心跳和诊断无可观察卡顿。
- 5 台设备、12 条 WS 限额内，普通消息和状态更新可用。
- 1000 条远程事件补发按页处理，单个快照不无限增大。
- 事件达到 5000 条后按保留策略清理，snapshot 能补救溢出客户端。
- 慢客户端断开后队列和定时器被释放；重复重连无监听器泄漏。

### 16.5 发布 P0 门禁

- [ ] TLS 默认路径在两台真实手机可用，或明确只发布受限模式且高危功能全部关闭。
- [ ] 扫码即连接、短期会话、角色权限测试全通过。
- [ ] 设备撤销、审批抢占、参数一致性、命令幂等和 Run 终态竞争全通过。
- [ ] 会话与角色权限隔离、快照/补发、资源限额和日志脱敏全通过。
- [ ] 数据迁移备份/回滚和安装包冒烟通过。
- [ ] `npm run format`、`npm run lint`、`npm test`、相关 e2e 通过；结果随版本记录。

---

## 17. 配置、可观测性与运维

### 17.1 本地配置键

`remoteControl` 保存 enabled、host/interfaceId、port、transport、session/retention/limits、wakeLockEnabled。不得保存 ticket、device secret、session secret、私钥明文。私钥单独用 safeStorage 加密文件保存并限制文件 ACL。

### 17.2 诊断信息

桌面显示：ready/degraded/draining/stopped、绑定地址、实际端口、TLS 版本/证书到期、事件 epoch/最新 seq/最早 seq、连接数、待配对数、最近错误类别。不能向未认证手机暴露这些信息。

审计操作至少包括：服务启停、配对申请/批准/拒绝/过期、session 创建/撤销、角色/grant 修改、消息发送、Run 创建/控制、审批决定、设备撤销、证书重置和受限模式开启。

### 17.3 数据备份和回滚

- 升级前使用 SQLite 在线备份或一致快照，不仅复制正在写入的单个 db 文件。
- 保留最近 3 次远程迁移备份，文件名包含时间/schema，不含凭证导出。
- v8 新增表失败可回滚事务；应用已写 v8 后回退旧程序前必须停止远程服务，使用匹配版本的备份恢复或运行显式降级迁移。
- 禁止简单把 `user_version` 改回 7 后继续使用旧程序；撤销设备和清理证书属于安全操作，不因应用回退自动恢复旧 secret。

---

## 18. 开发实施顺序与责任清单

| 顺序 | 模块 | 前置条件 | 完成证据 |
|---:|---|---|---|
| 1 | protocol/DT0/schema | R0 协议冻结 | 全类型正反向 schema 测试 |
| 2 | migration/remote repos | 数据库备份 | v7→v8 与回滚测试 |
| 3 | server/security/network | R0 Fastify/TLS | Host/Origin/Private/启停测试 |
| 4 | pairing/device/auth | server 可用 | 并发配对、刷新、撤销测试 |
| 5 | permission/grants | device 可用 | RBAC/会话越权矩阵 |
| 6 | event-store/snapshot | repos + Agent 事件 | 游标/溢出/快照竞态测试 |
| 7 | agent adapter chat | grants 可用 | 消息幂等和权限集成测试 |
| 8 | approval service | 改造 Core 确认链路 | 原子审批与执行 guard 测试 |
| 9 | run control | Core 检查点 | pause/resume/stop 状态测试 |
| 10 | H5/桌面 UI | API 契约稳定 | 真机交互和离线资源验收 |
| 11 | retention/audit/ops | 全链路 | 清理、诊断、备份恢复 |
| 12 | release | 全部门禁 | 质量基线、安装包、真机报告 |

**合并策略建议：** R0–R3 可独立合并且保持远程默认关闭；R4 未完成前不得在发布配置中开放 Agent/审批。所有新 IPC 和 REST 先鉴权后业务，不采用“先跑通、后补权限”的顺序。

---

## 19. 已完成设计闭环对照

| 原方案缺口 | 本方案闭环 |
|---|---|
| HTTP/WS 与高权限冲突 | 默认 TLS；明文严格降级，高危硬禁用 |
| 长期凭证与 WS 认证不清 | device secret → 短期 HttpOnly session → 同源 WSS |
| 手机刷新和凭证存储不清 | 默认内存 secret + Cookie 状态检测；持久化风险明示 |
| 角色和会话授权不清 | RBAC 逐命令校验 + 全部会话动态可见 + auth_version |
| 暂停/继续/取消状态不清 | Core Run 为事实源，控制意图与安全点分离 |
| 多设备审批竞争 | SQLite 事务条件更新、版本、args_hash、执行前 guard |
| 事件序号和快照竞态 | SQLite 全局 seq + epoch + 读事务 snapshot_seq + 补发 |
| 请求去重重启失效 | 持久 remote_commands + 请求 hash + Run 幂等键 |
| 连接/消息/慢客户端无限资源 | 帧、body、连接、队列、速率、分页和背压上限 |
| IP 改变后恢复不完整 | degraded + 新证书/二维码 + 明示重新扫码 |
| 手机数据泄露和 XSS | DTO 白名单、脱敏、CSP、sanitize、grant 过滤 |
| 实施和验收不具体 | R0–R5、文件落点、测试矩阵、P0 发布门禁、回滚 |

---

## 20. 最终交付定义

功能完成不等于“页面能打开”。只有同时满足以下条件才可标记完成：

1. 默认 TLS 下完成真实手机配对、消息、状态同步；受限模式能力边界与 UI 一致。
2. 每条业务链路执行统一认证、授权、参数、状态检查和审计。
3. 任务控制与审批通过状态竞争测试，未把请求接收冒充执行完成。
4. 断线、重启、事件溢出、快照并发和多设备场景均能收敛到正确状态。
5. 原始 Agent 本地功能不回退，数据库迁移可恢复，远程服务默认不暴露公网。
6. 代码、单元/集成/e2e/真机测试、构建冒烟、使用说明和已知限制全部交付。

**建议正式开发从 R0 开始，首先验证证书信任这一最大落地风险；不要在 TLS、持久审批和权限模型尚未完成时，以“先实现再补安全”的方式开放远程高权限控制。**
