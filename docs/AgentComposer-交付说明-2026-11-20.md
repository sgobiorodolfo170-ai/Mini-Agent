# AgentComposer 对话输入区交付说明

日期：2026-11-20
依据：《Agent 工具｜对话输入框前端施工规范》（下称“规范”）第 10 / 11 / 12 节
范围：仅会话页底部输入区，未重做页面、未改侧栏/页头/消息列表/执行引擎

---

## 1. 项目现状与实施映射（规范 §9.1 / §13 第二步）

| 勘察项 | 结论 |
|---|---|
| 前端框架 | Vue 3.5 + `<script setup>`，electron-vite 构建，Pinia 状态 |
| 输入区挂载位置 | `src/views/ChatView.vue` 会话主区底部（flex 布局内的固定行，非 `position: fixed`） |
| 样式方案 | Tailwind CSS 3 + `src/common/tokens.css` 语义变量；组件局部样式用普通 CSS 文件 |
| 图标库 | 项目自有 `src/components/UiIcon.vue`（24×24 线性 SVG，线宽 1.75） |
| 已有基础组件 | `UiDialog`、`UiIcon`、`StatusBadge`；下拉/浮层此前无通用组件，按项目既有浮层语言（`shadow-menu` + `border-line-subtle` + 圆角）新建了局部的 `ComposerMenu` |
| 模型来源 | `ChatView` 的 `activeProvider` / `models` / `activeModelId` → 落库到会话 `providerId` / `model`（`chat.updateConv`） |
| 权限 / 模式来源 | `chat.agentMode`：决定 `chat.send()` 走普通对话还是 `window.api.agent.run()` |
| 任务状态来源 | `agent.runs`（`agent:event` 的 `started`/`done` 触发刷新） |
| 运行状态来源 | `chat.hasStreaming`（消息 `status === 'streaming'`） |
| 已有真实能力回调 | `chat.send` / `chat.stop` / `agent.stop` / `chat.export` / `app.captureStart` / 知识库检索 |

### 控件到现有实现的对应

| 规范控件 | 复用 / 接入点 | 能力真实性 |
|---|---|---|
| 文本输入 | 新建 `ComposerInput`（textarea + 自动增高） | 真实，接 `chat.send` |
| 发送按钮 | `onSubmit` → `ChatView.send()` | 真实 |
| 停止 | 普通对话 `chat.stop(msgId)`；智能任务 `agent.stop(runId)` | 真实（按消息 `meta.agentRunId` 分流） |
| 权限 / 模式下拉 | `chat.permission`，选项“默认权限 / 自主模式 / 完整权限” | 真实，改变确认策略 |
| 模型选择 | 二级目录：供应商 → 该供应商模型，选中同时写入 `providerId`/`model` | 真实 |
| 添加入口 | `window.api.app.captureStart()` → `chat:attachment` → `ui.pendingAttachment` | 真实（项目现有附件能力就是截图，未虚构文件/网页菜单） |
| 知识库入口 | 既有 `toggleKb` + 检索 | 真实 |
| 顶部状态徽标 | `agent.runs` 计数，点击跳转“智能任务”页 | 真实 |
| 运行状态环 | `chat.hasStreaming` | 真实 |
| `Agent 集群` | `chat.agentCluster` → `agent.run({ cluster })` → `spawn_agent({ goals })` 并发派发 | 真实（见 §9） |
| `电脑操作` | 项目无远程桌面 / 系统操作能力 | **未实现，入口不渲染** |
| 麦克风 | 项目无语音识别服务与权限链路 | **未实现，入口不渲染** |

---

## 2. 修改文件清单

新增：

- `src/components/composer/AgentComposer.vue` — 外层容器、状态配置、模板（两种状态共用）
- `src/components/composer/ComposerInput.vue` — textarea、自动增高、Enter/Shift+Enter、IME 守卫
- `src/components/composer/ComposerMenu.vue` — 输入区弹出菜单（开合、方向键、Esc、点击外部关闭）
- `src/components/composer/ComposerStatusBar.vue` — 顶部状态栏
- `src/components/composer/ComposerStatusPill.vue` — 单个状态胶囊
- `src/components/composer/agent-composer.css` — 局部样式（`.agent-composer` / `.ac-*` 命名空间）
- `e2e/composer.spec.js` — 两状态几何/交互/窄窗验收与截图
- `docs/composer-2026-11-20/*.png` — 实际运行截图

修改：

- `src/views/ChatView.vue` — 输入区替换为 `AgentComposer`；新增模式/模型/状态/上下文映射；停止按链路分流；Esc 优先关闭输入区面板
- `src/components/UiIcon.vue` — 补充 `arrowUp`、`shield`、`monitor`、`mic`、`listCheck`、`checkCircle`、`provider`、`cluster` 八个线性图标（沿用原有路径风格，未引入新依赖）
- `e2e/agent.spec.js`、`e2e/real-provider.spec.js` — 模式入口由按钮改为下拉，改为点击菜单项选中“自主模式”
- `e2e/app.spec.js`、`e2e/kb.spec.js`、`e2e/chat.spec.js` — placeholder 文案随规范更新

## 3. 状态与配置模型（规范 §4）

`AgentComposer` 用一套模板 + 配置驱动，未复制两套 JSX：

- `variant`：`standard` / `task-followup`（仅标记，视觉差异全部来自传入配置）
- `capabilities` 通过可选 prop 体现：`addAction` / `modeAction` / `contextAction` / `voiceAction` 不传即不渲染
- `statusItems`、`model` + `modelOptions`、`runtimeState`、`submitting` / `streaming` / `disabled`
- 组件内部只维护 UI 短生命周期状态：`modeOpen`、`modelOpen`、输入框高度测量

`ChatView` 侧的映射：`composerVariant`、`composerPlaceholder`、`modeAction`、`composerModel`、`composerStatusItems` 均由 store 计算，没有把 `GLM-5.3-Flash`、`5/6`、`1` 之类示例值写进组件或业务代码。

## 4. 两种状态的实际差异

| 项 | standard | task-followup |
|---|---|---|
| placeholder | `输入“/”使用技能` | `提出后续修改要求` |
| 模式入口 | `默认权限`（中性灰） | `自主模式`（品牌蓝 `--brand-ink`） |
| 左侧能力入口 | 加号 / 模式 / 知识库 | 同左（`Agent 集群`、`电脑操作` 因无真实能力不渲染） |
| 模型 | 名称（可下拉切换） | 名称 + 可选等级（业务未提供等级时不显示） |
| 运行状态环 | 仅真实流式时出现 | 同左 |
| 顶部状态栏 | 有后台任务时显示 `后台 N 项` | 显示 `处理中 N` / `已完成 N`（均为真实计数） |
| 发送按钮 | 32px 圆形，空内容禁用 | 同左；流式中替换为“停止” |

## 5. 实测几何（`e2e/composer.spec.js` 读取真实 DOM）

| 项 | 规范目标 | 实测 |
|---|---:|---:|
| 卡片高度（单行） | ≈106px | 108px |
| 卡片圆角 | 20–24px | 22px |
| 卡片边框 | 1px 浅灰 | 1px（`--border-subtle`） |
| 卡片背景 | 白色 | `rgb(255,255,255)` |
| 发送按钮 | 32×32 圆形 | 32×32，`border-radius: 9999px` |
| 发送按钮距右/下内边距 | 贴近内边距 | 13px / 13px |
| 操作栏控件行高 | 34–40px 区域内 | 行区 63→95（32px 控件 + 上下留白） |
| 多行增高 | 允许增高、超过上限内部滚动 | 2 行 108→130px；30 行封顶 160px，`overflow-y: auto` |
| 状态徽标 | 高 32–34px，距卡片 14–18px | 32px，间距 15px |

## 6. 验收清单结果（规范 §10）

### 6.1 视觉验收

- [x] 单张白色大圆角卡片（无拼接面板）
- [x] 高度 108px、留白与上下两层结构符合参考
- [x] 圆角 22px、边框 1px 浅灰
- [x] 阴影仅为 `0 6px 22px rgba(15,23,42,.055)`
- [x] placeholder 位于卡片上层左侧，与操作栏左对齐（同为 18px 内边距）
- [x] 左右操作栏同一水平线、垂直居中
- [x] 发送按钮 32px 圆形、始终位于右侧末端
- [x] 状态徽标在卡片上方居中，不嵌入卡片
- [x] 两种状态仅按配置改变文案/颜色/可见控件
- [x] 无渐变、装饰插画、粗分割线、多余工具栏（截图核对）

### 6.2 功能验收

- [x] 中英文、数字、标点正常输入
- [x] `Enter` 发送，`Shift+Enter` 换行（e2e 断言换行保留）
- [x] IME 组合期间 Enter 不发送（e2e 派发 `isComposing` 事件后文本与消息均未变化）
- [x] 空内容与纯空白不可发送（按钮 `disabled` 断言）
- [x] 发送中不重复提交（`sending` / `hasStreaming` 双重守卫，流式中按钮变“停止”）
- [x] 发送失败保留文本（原有 `catch` 回填草稿逻辑保留）
- [x] 加号 / 模式 / 知识库 / 模型 / 停止均有真实回调；无能力入口（集群、电脑操作、麦克风）不渲染
- [x] 状态徽标使用 `agent.runs` 真实计数，无任务时整块不渲染（断言 `ac-pill` 数为 0）；有点击动作时跳转「智能任务」并选中对应运行（e2e 断言跳转后存在运行记录）
- [x] 运行环只在真实流式时出现，停止后消失
- [x] 菜单可键盘访问，`Escape` 关闭且不清空文本（e2e 断言输入值不变）

菜单键盘可达性由 e2e 实测覆盖：打开后焦点落到首项（`menuitemradio`）、`ArrowDown` 移动到下一项、焦点环 `outline-style: solid` 可见、`Escape` 后原输入文本仍在。开发过程中这里发现并修复了一个真实缺陷——菜单项是 `menuitemradio`，而首项聚焦与方向键遍历用的是 `[role="menuitem"]` 选择器，导致纯键盘用户无法进入菜单；已统一为同一选择器常量。

### 6.3 兼容与质量验收

- [x] 默认桌面窗口（1280×840）布局正常
- [x] 980px 窄窗口无横向溢出（`scrollWidth - clientWidth = 0`），发送按钮仍可见
- [x] 多行自动增高，160px 后内部滚动
- [x] 输入区在 flex 布局内，未遮挡消息区与底部内容
- [x] 控制台无新增错误/警告（`unexpectedErrors` 断言）
- [x] 无新增依赖（`package.json` 未变）
- [x] 输入区以外的页面无回归（13 个 e2e 文件、302 个单测全部通过）

### 6.4 截图对照

- `docs/composer-2026-11-20/01-standard.png` — 常规状态
- `docs/composer-2026-11-20/02-standard-menu.png` — 模式菜单展开
- `docs/composer-2026-11-20/03-task-followup.png` — 任务后续状态
- `docs/composer-2026-11-20/04-model-menu-provider.png` — 模型菜单·供应商一级
- `docs/composer-2026-11-20/04-model-menu-model.png` — 模型菜单·模型二级
- `docs/composer-2026-11-20/05-task-running.png` — 真实运行中（状态徽标 + 运行环 + 停止）
- `docs/composer-2026-11-20/06-narrow.png` — 980px 窄窗
- `docs/composer-2026-11-20/07-usage-ring.png` — 上下文状态环特写

对照顺序（宽度位置 → 高度 → 圆角边框 → 留白 → 操作栏间距 → 图标 → 字号颜色）已逐项核对；截图使用浅色主题以对齐参考图。

## 7. 未完成项与偏差说明（如实记录）

1. **`电脑操作`、麦克风未实现**。项目没有桌面自动化与语音识别能力，按规范 §1.1 / §3.1-C / §3.2-C 隐藏，未做假交互。（`Agent 集群` 已实现，见 §9）
2. **添加菜单未做文件/网页项**。项目现有附件能力只有截图链路，故加号直接进入截图；未虚构菜单项。
3. **模型等级（`最高`）未显示**。项目数据模型没有“等级”字段，`tierLabel` 通道已预留，业务提供后才展示。
4. **顶栏“N/M 进度”未显示**。`agent_runs` 无“总步数”字段，只有 `max_steps` 与 `steps_used`；为避免伪造分母，任务态徽标显示真实计数 `处理中 N` / `已完成 N`，泛型文案与数字结构保留。
5. **`/` 技能菜单未实现**。项目无技能命令系统，按规范 §5.4 仅显示提示文案。
6. **发送按钮用品牌色而非参考图的灰色**。规范 §3.2-D 允许“项目强调色或深浅灰”，这里取项目强调色以与主按钮体系一致；禁用态为浅灰底 + 浅色箭头。
7. **停止按钮为胶囊文字按钮**，不是圆形。流式中需表达“可中止”语义，纯图标易被误读为发送；仍占据发送按钮原位置，不改变操作栏高度。
8. 输入区背景沿用 `bg-canvas`（与聊天区一致），未额外铺参考图的 `#F8F8F8` 独立底色，避免与项目主题变量分叉。

## 8. 验证命令

```bash
npm run build          # electron-vite 构建通过
npm run lint           # eslint src electron tests 通过
npm run test           # 40 文件 / 302 单测通过
npx vitest run --config vitest.e2e.config.mjs --exclude "e2e/real-provider.spec.js"
                       # 13 文件 / 27 e2e 通过
```

## 9. 后续增量需求（第二轮）

在原基础上追加四项改动，均已接入真实能力，无假交互。

### 9.1 模型选择前增加上下文状态环

- 位置：操作栏右侧、模型选择左侧；数据来自会话真实历史字符数与当前生效模型的 `maxChars`。
- 分母口径与 gateway 的 `effectiveParams` 一致（`maxChars` 只取该模型参数，未配置时 12000）。
- 环宽 3px、有可见轨道；有占用时至少画出 12° 弧，避免 1% 在 16px 环上完全不可见；≥70% 转警告色，≥90% 转错误色。
- `aria-label` / `title` 给出精确百分比与「已用 / 上限 字符」。

### 9.2 知识库按钮后增加「Agent 集群」按钮

- 位置：左侧操作组，知识库之后。
- 开关写入 `chat.agentCluster`，随 `agent.run` 传给主进程；默认权限下禁用（不执行任务时无意义），切回默认权限时自动关闭。
- 后端：开启后系统提示告知可并行派发；`spawn_agent` 支持 `goals` 数组，多个子任务用 `Promise.all` **真并发**执行，结果按【子任务 N】分段返回。
- 实测证据：`e2e/agent-cluster.spec.js` 断言同一时刻在途子 Agent 峰值 `subPeak = 3`（串行执行时峰值只会是 1）。

### 9.3 权限选择增加「完整权限」

- 三级：`default`（纯对话）/ `autonomous`（写操作逐次确认）/ `full`（非只读直接执行）。
- 后端 `decide()` 在 `full` 下直接放行非只读工具，并把确认来源记为 `permission:full` 写入执行日志，保留可审计性。
- 修复了一个既有缺陷：`lastDecision` 只在「等待用户确认」路径赋值，其他提前返回会沿用上一步的旧值，导致日志里的「确认方式」错位；现改为所有返回路径统一经 `settle()` 写回。
- 实测证据：`e2e/agent.spec.js` 断言完整权限下**不出现**「Agent 请求确认」、文件真实落盘、日志显示「确认方式：permission:full」。

### 9.4 模型选择二级目录

- 一级：提供商（显示该供应商模型数量，当前模型所属供应商带勾选）。
- 二级：该供应商已配置的模型；顶部有「返回供应商列表」，支持 `ArrowLeft` 返回、`Escape` 关闭、方向键遍历。
- 选中时同时写入 `providerId` 与 `model`，避免模型与供应商不匹配。
- 修复：二级项原先同时渲染了 `check` 图标与选中勾，出现两个勾；现选中态只由 `selected` 统一渲染。

### 9.5 截图取消：Esc 与鼠标右键

- `Esc`：原有行为，保留并补 `preventDefault`。
- 鼠标右键：在遮罩上按下右键即取消；同时屏蔽遮罩上的原生右键菜单。
- 取消做了幂等保护，避免右键与 `mouseup` 重复触发。
- 实测证据：`e2e/capture-cancel.spec.js` 两条用例分别断言遮罩窗口关闭且不产生附件。

### 9.6 本轮回归与护栏

- 页头「会话设置」入口不再存在：采样参数已改为「设置 → 会话」的全局配置，e2e 用 `settings-section-chat` 断言该分组可用、并断言 `open-conv-settings` 数量为 0，防止入口被误加回或分组被静默删除。
- 新增测试：`e2e/agent-cluster.spec.js`、`e2e/capture-cancel.spec.js`、`tests/unit/agent-spawn-cluster.test.js`、`tests/unit/gateway-params.test.js`、`tests/unit/agent-params.test.js`；`e2e/composer.spec.js` 扩充三级权限、集群开关、上下文环、模型二级目录断言。
- 全量：`lint` 通过、40 文件 / 302 单测通过、13 文件 / 27 e2e 通过、`build` 通过。
