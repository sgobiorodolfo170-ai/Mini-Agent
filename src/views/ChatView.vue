<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MessageItem from '../components/MessageItem.vue'
import UiIcon from '../components/UiIcon.vue'
import UiDialog from '../components/UiDialog.vue'
import ConvRow from '../components/ConvRow.vue'
import RowMenu from '../components/RowMenu.vue'
import AgentComposer from '../components/composer/AgentComposer.vue'
import BrowserView from './BrowserView.vue'
import { useAgentStore } from '../stores/agent'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useKbStore } from '../stores/kb'
import { useUiStore } from '../stores/ui'
import { useProjectsStore } from '../stores/projects'
import { useComposerStore } from '../stores/composer'
import { useBrowserStore } from '../stores/browser'
import { useSideTaskStore } from '../stores/sideTask'

const chat = useChatStore()
const settings = useSettingsStore()
const kb = useKbStore()
const ui = useUiStore()
const projects = useProjectsStore()
const agent = useAgentStore()
const composer = useComposerStore()
const browser = useBrowserStore()
const sideTask = useSideTaskStore()

const input = computed({
  get: () => composer.text,
  set: (value) => {
    composer.text = value
  }
})
const composerRef = ref(null)
const search = ref('')
const searchMode = ref('conversations')
const highlightedMessageId = ref('')
let highlightTimer = null
const sending = ref(false)
const showKbPopover = ref(false)
const kbPopoverEl = ref(null)
const showMoreMenu = ref(false)
const editingTitleId = ref(null)
const scrollEl = ref(null)
const stickBottom = ref(true)
// 消息内选中文字后弹出的横向菜单（添加到对话 / 在临时会话提问）
const selectionMenu = ref({ visible: false, x: 0, y: 0, text: '' })
const selectionMenuEl = ref(null)
let selectionTimer = 0
// 以附件形式待发送的选中文字
const textAttachments = ref([])
let textAttachmentSeq = 0
let searchTimer = null
// 提示词优化 / 分组折叠 / 提示词定位
const optimizing = ref(false)
const pinnedCollapsed = ref(false)
const projectsCollapsed = ref(false)
const recentCollapsed = ref(false)
const workspaceWidth = ref(window.innerWidth)
const browserPanelMaxWidth = computed(() =>
  Math.max(
    360,
    Math.min(720, workspaceWidth.value - (ui.chatListVisible ? ui.chatListWidth : 0) - 72)
  )
)
const visibleBrowserPanelWidth = computed(() =>
  Math.min(ui.browserPanelWidth, browserPanelMaxWidth.value)
)

const conv = computed(() => chat.activeConv)
const streamingMsg = computed(() =>
  chat.messages.find((m) => ['streaming', 'pending'].includes(m.status))
)
const hasService = computed(() => settings.enabledProviders.length > 0)
const pinnedConvs = computed(() => chat.visibleConversations.filter((c) => c.pinned))
const unprojectedConvs = computed(() =>
  chat.visibleConversations.filter((c) => !c.pinned && !c.projectId)
)
// 项目分组：置顶会话只出现在「置顶」组，不重复显示在项目内
const projectGroups = computed(() =>
  projects.projects
    .map((p) => ({
      project: p,
      sessions: chat.visibleConversations.filter((c) => c.projectId === p.id && !c.pinned)
    }))
    .filter((g) => (chat.filtering ? g.sessions.length > 0 : true))
)

// 页头显示最终生效的服务与模型（F21：不能只显示“跟随默认”）
// 与 gateway.resolveModel 同口径：会话手动选定的供应商/模型 → 第一个启用供应商及其首个模型。
const activeProvider = computed(() => {
  const pid = conv.value && conv.value.providerId
  return (
    settings.enabledProviders.find((p) => p.id === pid) ||
    settings.enabledProviders[0] ||
    settings.providers.find((p) => p.id === pid) ||
    null
  )
})
const models = computed(() => (activeProvider.value && activeProvider.value.models) || [])
const activeModelId = computed(
  () => (conv.value && conv.value.model) || (models.value[0] && models.value[0].id) || ''
)
// ---------- 滚动策略（F14）：贴底才自动跟随，历史阅读不被抢滚动 ----------
function scrollToBottom() {
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}
function onScroll() {
  const el = scrollEl.value
  stickBottom.value = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 60 : true
  hideSelectionMenu()
}
function backToBottom() {
  stickBottom.value = true
  scrollToBottom()
}
watch(
  () => chat.messages.map((m) => (m.content || '').length).join(',') + '|' + chat.messages.length,
  async () => {
    if (!stickBottom.value) return
    await nextTick()
    scrollToBottom()
  }
)
watch(
  () => chat.activeId,
  async () => {
    stickBottom.value = true
    await nextTick()
    scrollToBottom()
  }
)
watch(
  () => composer.focusRevision,
  async (revision) => {
    if (!revision) return
    await nextTick()
    if (composerRef.value) composerRef.value.focus()
  }
)

// ---------- 搜索（F03 / P13）：会话筛选与全文消息检索 ----------
let searchRevision = 0
watch(search, (v) => {
  clearTimeout(searchTimer)
  const revision = ++searchRevision
  searchTimer = setTimeout(() => {
    if (revision !== searchRevision) return
    if (searchMode.value === 'messages') void runMessageSearch(v)
    else chat.setFilter(v)
  }, 250)
})
watch(searchMode, () => {
  clearTimeout(searchTimer)
  searchRevision += 1
  chat.clearMessageSearch()
  if (searchMode.value === 'conversations') chat.setFilter(search.value)
  else if (search.value.trim()) void runMessageSearch(search.value)
})
function clearSearch() {
  search.value = ''
  searchRevision += 1
  clearTimeout(searchTimer)
  chat.setFilter('')
  chat.clearMessageSearch()
}
async function runMessageSearch(value = search.value) {
  const query = String(value || '').trim()
  if (!query) {
    chat.clearMessageSearch()
    return
  }
  try {
    await chat.searchMessages(query)
  } catch {
    // 错误由 store 保留并在结果区展示
  }
}
function searchNow() {
  clearTimeout(searchTimer)
  if (searchMode.value === 'messages') void runMessageSearch()
  else chat.setFilter(search.value)
}
async function openMessageSearchResult(result) {
  await chat.select(result.conversationId)
  await nextTick()
  if (!result.messageId) return
  highlightedMessageId.value = result.messageId
  const element = scrollEl.value?.querySelector(`[data-msg-id="${result.messageId}"]`)
  element?.scrollIntoView({ block: 'center' })
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedMessageId.value = ''
  }, 3000)
}
async function loadMoreMessageResults() {
  if (!chat.messageSearch.nextCursor || chat.messageSearch.loading) return
  try {
    await chat.searchMessages(chat.messageSearch.query, chat.messageSearch.nextCursor, true)
  } catch {
    // 错误由 store 保留并在结果区展示
  }
}

// 发送（F05/F06）：发送锁 + 失败恢复草稿。键盘行为（Enter / Shift+Enter / IME）由 ComposerInput 负责
async function send() {
  if (sending.value || chat.hasStreaming) return
  const content = input.value.trim()
  if (!content) return
  const imageData = ui.pendingAttachment
  const sentTextAttachments = textAttachments.value
  const atts = [
    ...(imageData ? [{ type: 'image', dataUrl: imageData }] : []),
    ...sentTextAttachments.map((a) => ({ type: 'text', content: a.text }))
  ]
  sending.value = true
  ui.pendingAttachment = null
  textAttachments.value = []
  input.value = ''
  try {
    await chat.send(content, atts)
    stickBottom.value = true
    await nextTick()
    scrollToBottom()
  } catch (e) {
    // 发送期间用户可能继续输入或从浏览器追加上下文，失败时不能覆盖新草稿。
    composer.restoreSent(content)
    if (imageData && !ui.pendingAttachment) ui.pendingAttachment = imageData
    if (sentTextAttachments.length) {
      textAttachments.value = [...sentTextAttachments, ...textAttachments.value]
    }
    ui.toast('发送失败，内容已恢复到输入框', 'error')
  } finally {
    sending.value = false
  }
}
// 提示词优化：结合当前会话上下文改写输入框草稿
async function optimizePrompt() {
  if (optimizing.value) return
  const content = input.value.trim()
  if (!content) return
  optimizing.value = true
  try {
    const r = await window.api.chat.optimizePrompt({
      conversationId: chat.activeId,
      content
    })
    if (r && r.prompt) input.value = r.prompt
  } catch (e) {
    ui.toast('提示词优化失败：' + String((e && e.message) || e), 'error')
  } finally {
    optimizing.value = false
  }
}

// 左侧提示词定位柱：点击滚动到对应消息
const promptMarkers = computed(() => chat.messages.filter((m) => m.role === 'user'))
function scrollToPrompt(id) {
  const root = scrollEl.value
  if (!root) return
  const el = root.querySelector(`[data-msg-id="${id}"]`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 停止：普通对话走 gateway 的流式中止；智能任务走 agent 运行中止（两条链路各有权柄）
function stopStream() {
  const m = streamingMsg.value
  if (!m) return
  const runId = m.meta && m.meta.agentRunId
  if (runId) agent.stopRun(runId)
  else chat.stop(m.id)
}

// ---------- 列表行：重命名 / 置顶 / 删除确认（F04/F13） ----------
function startRename(c) {
  editingTitleId.value = c.id
}
async function submitRename(title) {
  const id = editingTitleId.value
  editingTitleId.value = null
  if (id && title) await chat.updateConv(id, { title })
}
async function removeConv(c) {
  const ok = await ui.confirm({
    title: '删除会话',
    message: `删除会话「${c.title}」？`,
    impact: '该会话及其消息将从列表移除，当前版本暂不支持从界面恢复。',
    confirmText: '删除'
  })
  if (ok) await chat.removeConv(c.id)
}

// ---------- 项目分组：添加 / 展开 / 重命名 / 删除 / 组内新建 ----------
const collapsedProjects = ref({})
function isExpanded(id) {
  return !collapsedProjects.value[id]
}
function toggleProject(id) {
  collapsedProjects.value[id] = !collapsedProjects.value[id]
}
const showProjectDialog = ref(false)
const projectName = ref('')
const projectPath = ref('')
const projectWorktree = ref(true)
const projectCreateIndex = ref(true)
const projectAutoMerge = ref(true)
const projectVerifyCommand = ref('')
const projectConflictStrategy = ref('manual')
const savingProject = ref(false)
function openProjectDialog() {
  projectName.value = ''
  projectPath.value = ''
  projectWorktree.value = true
  projectCreateIndex.value = true
  projectAutoMerge.value = true
  projectVerifyCommand.value = ''
  projectConflictStrategy.value = 'manual'
  showProjectDialog.value = true
}
async function pickProjectDir() {
  const d = await window.api.dialog.pickDir()
  if (d) projectPath.value = d
}
async function submitProject() {
  if (savingProject.value) return
  const name = projectName.value.trim()
  const dir = projectPath.value.trim()
  if (!name || !dir) return
  savingProject.value = true
  try {
    const p = await projects.create({
      name,
      path: dir,
      workspaceMode: projectWorktree.value ? 'worktree' : 'shared',
      workspaceAutoMerge: projectAutoMerge.value,
      workspaceVerifyCommand: projectVerifyCommand.value.trim(),
      workspaceConflictStrategy: projectConflictStrategy.value,
      createWorkspaceIndex: projectCreateIndex.value
    })
    showProjectDialog.value = false
    collapsedProjects.value[p.id] = false
    ui.toast(
      p.workspaceIndex?.error
        ? '项目已添加，但工作区索引不可用：' + p.workspaceIndex.error
        : p.workspaceIndex?.started
          ? '项目已添加，正在后台创建工作区索引'
          : '项目已添加，新建会话将归入该项目',
      p.workspaceIndex?.error ? 'warn' : 'success'
    )
  } catch (e) {
    ui.toast('添加项目失败：' + String((e && e.message) || e), 'error')
  } finally {
    savingProject.value = false
  }
}
const editingProjectId = ref(null)
const projectDraft = ref('')
function startProjectRename(p) {
  editingProjectId.value = p.id
  projectDraft.value = p.name
}
async function submitProjectRename() {
  const id = editingProjectId.value
  editingProjectId.value = null
  if (id && projectDraft.value.trim())
    await projects.update(id, { name: projectDraft.value.trim() })
}
function onProjectRenameKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter') submitProjectRename()
}
async function createInProject(p) {
  await chat.create({ projectId: p.id })
}
async function rebuildProjectIndex(p) {
  try {
    const result = await projects.createIndex(p.id, true)
    ui.toast(
      result.error ? '工作区索引不可用：' + result.error : '正在重建工作区索引',
      result.error ? 'warn' : 'success'
    )
  } catch (e) {
    ui.toast('重建工作区索引失败：' + String((e && e.message) || e), 'error')
  }
}
async function removeProject(p) {
  const ok = await ui.confirm({
    title: '删除项目',
    message: `删除项目「${p.name}」？`,
    impact: '项目下的会话将移到「最近」，会话内容不受影响。',
    confirmText: '删除'
  })
  if (ok) await projects.remove(p.id)
}
const showVerifyDialog = ref(false)
const verifyProjectId = ref(null)
const verifyCommand = ref('')
const savingVerify = ref(false)
function openVerifyDialog(p) {
  verifyProjectId.value = p.id
  verifyCommand.value = p.workspaceVerifyCommand || ''
  showVerifyDialog.value = true
}
async function submitVerifyCommand() {
  if (!verifyProjectId.value || savingVerify.value) return
  savingVerify.value = true
  try {
    await projects.update(verifyProjectId.value, {
      workspaceVerifyCommand: verifyCommand.value.trim()
    })
    showVerifyDialog.value = false
    ui.toast('合并验收命令已更新', 'success')
  } catch (e) {
    ui.toast('保存验收命令失败：' + String((e && e.message) || e), 'error')
  } finally {
    savingVerify.value = false
  }
}

const showConflictDialog = ref(false)
const conflictProjectId = ref(null)
const conflictStrategy = ref('manual')
const savingConflict = ref(false)
function openConflictDialog(p) {
  conflictProjectId.value = p.id
  conflictStrategy.value = p.workspaceConflictStrategy || 'manual'
  showConflictDialog.value = true
}
async function submitConflictStrategy() {
  if (!conflictProjectId.value || savingConflict.value) return
  if (conflictStrategy.value !== 'manual') {
    const ok = await ui.confirm({
      title: '启用自动冲突解决',
      message: `冲突时将选择「${conflictStrategy.value === 'ours' ? '当前目标侧' : '合并来源侧'}」。`,
      impact: '这可能丢弃另一侧在同一文件上的改动；不影响项目是否开启自动合并。',
      confirmText: '确认启用'
    })
    if (!ok) return
  }
  savingConflict.value = true
  try {
    await projects.update(conflictProjectId.value, {
      workspaceConflictStrategy: conflictStrategy.value
    })
    showConflictDialog.value = false
    ui.toast('工作区冲突策略已更新', 'success')
  } catch (e) {
    ui.toast('保存冲突策略失败：' + String((e && e.message) || e), 'error')
  } finally {
    savingConflict.value = false
  }
}

// 项目标题行「…」菜单：置顶 / 删除
function projectMenuItems(p) {
  return [
    { id: 'rename', label: '重命名项目', icon: 'edit', onSelect: () => startProjectRename(p) },
    {
      id: 'workspace',
      label: p.workspaceMode === 'shared' ? '使用独立工作区' : '使用共享目录',
      icon: 'folder',
      onSelect: () =>
        projects.update(p.id, {
          workspaceMode: p.workspaceMode === 'shared' ? 'worktree' : 'shared'
        })
    },
    {
      id: 'autoMerge',
      label: p.workspaceAutoMerge ? '关闭自动合并' : '开启自动合并',
      icon: 'check',
      onSelect: () => projects.update(p.id, { workspaceAutoMerge: p.workspaceAutoMerge ? 0 : 1 })
    },
    {
      id: 'verify',
      label: p.workspaceVerifyCommand ? '修改合并验收命令' : '设置合并验收命令',
      icon: 'edit',
      onSelect: () => openVerifyDialog(p)
    },
    {
      id: 'conflict',
      label:
        p.workspaceConflictStrategy === 'manual'
          ? '设置工作区冲突策略'
          : `冲突策略：${p.workspaceConflictStrategy}`,
      icon: 'edit',
      onSelect: () => openConflictDialog(p)
    },
    {
      id: 'pin',
      label: p.pinned ? '取消置顶' : '置顶',
      icon: 'pin',
      onSelect: () => projects.update(p.id, { pinned: p.pinned ? 0 : 1 })
    },
    {
      id: 'workspaceIndex',
      label: p.workspaceIndexKbId ? '重建工作区索引' : '创建工作区索引',
      icon: 'refresh',
      onSelect: () => rebuildProjectIndex(p)
    },
    {
      id: 'remove',
      label: '删除项目',
      icon: 'trash',
      danger: true,
      onSelect: () => removeProject(p)
    }
  ]
}

function toggleKb(id) {
  const i = chat.selectedKbIds.indexOf(id)
  if (i >= 0) chat.selectedKbIds.splice(i, 1)
  else chat.selectedKbIds.push(id)
}

async function exportConv(mode) {
  if (!conv.value) return
  showMoreMenu.value = false
  await window.api.chat.export({ cid: conv.value.id, mode })
}
// ---------- 输入区（AgentComposer）：一切展示值来自真实业务状态 ----------
// 呈现变体：任务模式下进入「任务后续输入」；模式值本身来自 chat.agentMode（真实影响发送路径）
const composerVariant = computed(() => (chat.agentMode ? 'task-followup' : 'standard'))
const composerPlaceholder = computed(() =>
  chat.agentMode ? '提出后续修改要求' : '输入“/”使用技能'
)
// 输入区可访问说明（placeholder 不作为唯一标签，规范 §8.3）
const composerHint = computed(() =>
  chat.permission === 'readonly'
    ? 'Enter 发送，Shift+Enter 换行；只读工具自动执行，写入操作将被拒绝'
    : chat.agentMode
      ? 'Enter 发送，Shift+Enter 换行；可调用工具，涉及写入的操作将请求确认'
      : 'Enter 发送，Shift+Enter 换行'
)
// 权限四级：默认权限（纯对话）/ 只读任务（仅只读工具）/ 自主模式（写操作逐次确认）/ 完整权限（命令仍逐次确认）
// 选中值写回 chat.permission（按会话持久化），真实决定 agent.run 的确认策略
const PERMISSION_META = {
  default: { label: '默认权限', hint: '普通对话，不调用工具', icon: 'chat' },
  readonly: {
    label: '只读任务',
    hint: '只读工具自动执行，写入类操作直接拒绝',
    icon: 'eye'
  },
  autonomous: {
    label: '自主模式',
    hint: '可调用工具，涉及写入的操作将请求确认',
    icon: 'shield'
  },
  full: {
    label: '完整权限',
    hint: '可调用工具，普通写操作直接执行；命令与破坏性操作仍逐次确认',
    icon: 'shield'
  }
}
const modeAction = computed(() => {
  const cur = PERMISSION_META[chat.permission] || PERMISSION_META.default
  return {
    id: chat.permission,
    label: cur.label,
    icon: cur.icon,
    selected: chat.permission !== 'default',
    enabled: true,
    hint: cur.hint,
    options: ['default', 'readonly', 'autonomous', 'full'].map((id) => ({
      id,
      label: PERMISSION_META[id].label,
      hint: PERMISSION_META[id].hint,
      icon: PERMISSION_META[id].icon,
      selected: chat.permission === id
    }))
  }
})
function selectMode(id) {
  if (!PERMISSION_META[id]) return
  chat.setPermission(id)
  // 权限降到默认/只读时集群无意义（spawn_agent 是写入类必被拒），一并关闭
  if (id === 'default' || id === 'readonly') chat.agentCluster = false
}

// 添加能力：项目现有的附件入口是截图（Alt+S 同一链路），不虚构文件/网页菜单
const addAction = { label: '添加截图', icon: 'plus', enabled: true }
async function addAttachment() {
  try {
    await window.api.app.captureStart()
  } catch (e) {
    ui.toast('启动截图失败：' + String((e && e.message) || e), 'error')
  }
}

// 上下文入口：项目现有的知识库选择（真实检索能力），保留在输入区左侧
const kbNames = computed(() =>
  kb.kbs.filter((k) => chat.selectedKbIds.includes(k.id)).map((k) => k.name)
)
const contextAction = computed(() => ({
  label: chat.selectedKbIds.length ? `知识库(${chat.selectedKbIds.length})` : '知识库',
  icon: 'kb',
  active: showKbPopover.value,
  enabled: true
}))

// Agent 集群：仅在任务模式下有意义。开启后 agent.run 允许一次派发多个并行子 Agent
const clusterAction = computed(() => ({
  label: 'Agent 集群',
  icon: 'cluster',
  active: chat.agentCluster,
  // 集群依赖 spawn_agent（写入类），只读/默认模式下必被拒，不开放
  enabled: ['autonomous', 'full'].includes(chat.permission),
  hint:
    chat.permission === 'default' || chat.permission === 'readonly'
      ? '切到自主模式或完整权限后可开启集群'
      : chat.agentCluster
        ? '已开启：可将独立子任务并行派发给多个子 Agent'
        : '开启后可将独立子任务并行派发给多个子 Agent'
}))
function toggleCluster() {
  if (!['autonomous', 'full'].includes(chat.permission)) return
  chat.agentCluster = !chat.agentCluster
}

// 模型：当前会话生效的服务与模型（真实选择结果）
const composerModel = computed(() => {
  if (!activeModelId.value) return null
  return {
    id: activeModelId.value,
    name: activeModelId.value,
    tierLabel: ''
  }
})
// 二级目录：一级按供应商分组，二级是该供应商已配置的模型
const modelGroups = computed(() =>
  settings.enabledProviders
    .filter((p) => (p.models || []).length)
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: (p.models || []).map((m) => ({
        id: m.id,
        label: m.id,
        hint: m.vision ? '支持图片输入' : '',
        selected:
          p.id === (activeProvider.value && activeProvider.value.id) && m.id === activeModelId.value
      }))
    }))
)
// 选中模型：同时把会话切到该供应商，避免模型与供应商不匹配
function selectModel({ providerId, modelId }) {
  if (!conv.value) return
  const patch = { providerId: providerId || null, model: modelId || null }
  chat.updateConv(conv.value.id, patch)
}

// 上下文占用：分母与 gateway 一致（当前生效模型的 maxChars 参数，未配置时 12000）
const activeModelParams = computed(() => {
  const list = (activeProvider.value && activeProvider.value.models) || []
  return list.find((m) => m.id === activeModelId.value) || {}
})
const contextUsage = computed(() => {
  const limit = Number(activeModelParams.value.maxChars) || 12000
  if (!limit) return null
  const userChars = chat.messages.reduce(
    (n, m) => n + (m.role === 'user' && m.content ? m.content.length : 0),
    0
  )
  const assistantChars = chat.messages.reduce(
    (n, m) => n + (m.role === 'assistant' && m.content ? m.content.length : 0),
    0
  )
  const used = userChars + assistantChars
  return {
    value: Math.min(1, used / limit),
    label: `${used} / ${limit} 字符`,
    used,
    limit,
    // 明细供输入区「上下文窗口」弹层展示，均为真实字符统计
    rows: [
      { id: 'user', label: '用户消息', chars: userChars },
      { id: 'assistant', label: '助手回复', chars: assistantChars }
    ]
  }
})

// 顶部状态徽标：来自 agent.runs 的真实计数，无数据时整体不渲染
const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const runningRuns = computed(() => agent.runs.filter((r) => r.status === 'running'))
const doneRunsToday = computed(() =>
  agent.runs.filter((r) => r.status === 'done' && (r.ended_at || 0) >= startOfToday())
)
// 徽标点击跳转「智能任务」并选中对应运行记录（业务层已有能力，非占位）
function openRun(item) {
  ui.view = 'agent'
  const target =
    item.id === 'running'
      ? runningRuns.value[0]
      : item.id === 'done'
        ? doneRunsToday.value[0]
        : runningRuns.value[0]
  if (target) agent.select(target.id)
}
const composerStatusItems = computed(() => {
  const items = []
  const goRuns = () => {
    ui.view = 'agent'
  }
  if (chat.agentMode) {
    if (runningRuns.value.length) {
      items.push({
        id: 'running',
        label: '处理中',
        value: runningRuns.value.length,
        icon: 'listCheck',
        tone: 'info',
        onClick: goRuns
      })
    }
    if (doneRunsToday.value.length) {
      items.push({
        id: 'done',
        label: '已完成',
        value: doneRunsToday.value.length,
        icon: 'checkCircle',
        tone: 'success',
        onClick: goRuns
      })
    }
    return items
  }
  if (runningRuns.value.length) {
    items.push({
      id: 'background',
      label: '后台',
      value: `${runningRuns.value.length} 项`,
      icon: 'listCheck',
      tone: 'default',
      onClick: goRuns
    })
  }
  return items
})

function stopComposer() {
  stopStream()
}

// 消息内选中文字：自动弹出横向菜单
function hideSelectionMenu() {
  if (selectionMenu.value.visible) selectionMenu.value.visible = false
}
function updateSelectionMenu() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    hideSelectionMenu()
    return
  }
  const text = selection.toString().trim()
  const anchor = selection.anchorNode
  const anchorEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  if (!text || !anchorEl || !scrollEl.value || !scrollEl.value.contains(anchorEl)) {
    hideSelectionMenu()
    return
  }
  // 只在消息正文内响应，避免误选时间、按钮等界面元素
  if (!anchorEl.closest('.message-text')) {
    hideSelectionMenu()
    return
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  const width = 232
  selectionMenu.value = {
    visible: true,
    text: text.slice(0, 8000),
    x: Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)),
    y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 52))
  }
}
function onMessageMouseUp() {
  clearTimeout(selectionTimer)
  selectionTimer = setTimeout(updateSelectionMenu, 0)
}
function addSelectionToChat() {
  const text = selectionMenu.value.text
  hideSelectionMenu()
  if (!text) return
  textAttachments.value.push({
    id: `chat-selection-${(textAttachmentSeq += 1)}`,
    text,
    preview: text.length > 80 ? `${text.slice(0, 80)}…` : text
  })
  const selection = window.getSelection()
  if (selection) selection.removeAllRanges()
  composerRef.value?.focus?.()
}
async function askSelectionInSideTask() {
  const text = selectionMenu.value.text
  hideSelectionMenu()
  if (!text) return
  sideTask.addSelection(text)
  const selection = window.getSelection()
  if (selection) selection.removeAllRanges()
  try {
    // 先创建/复用内部标签，再展开面板：避免面板初始化时额外打开空白标签
    const existing = browser.tabs.find((tab) => tab.internal === 'side')
    const tab = existing || (await browser.open('miniagent://side'))
    if (!ui.browserPanelOpen) await toggleBrowserPanel()
    await browser.activate(tab.id)
  } catch (e) {
    ui.toast('打开临时会话失败：' + String((e && e.message) || e), 'error')
  }
}
function removeTextAttachment(id) {
  textAttachments.value = textAttachments.value.filter((a) => a.id !== id)
}

// 点击面板外部关闭知识库面板（Esc 由 onWindowKeydown 处理）
function onDocPointerDown(e) {
  if (selectionMenu.value.visible) {
    if (!selectionMenuEl.value || !selectionMenuEl.value.contains(e.target)) hideSelectionMenu()
  }
  if (!showKbPopover.value) return
  if (kbPopoverEl.value && kbPopoverEl.value.contains(e.target)) return
  const trigger = e.target && e.target.closest ? e.target.closest('[data-testid="kb-chip"]') : null
  if (trigger) return
  showKbPopover.value = false
}
function onWindowKeydown(e) {
  if (e.key !== 'Escape' || ui.confirmState) return
  // 输入区弹出的面板优先关闭，且不清空输入文本（规范 §5.2）
  if (selectionMenu.value.visible) hideSelectionMenu()
  if (showKbPopover.value) showKbPopover.value = false
}
function onWindowResize() {
  workspaceWidth.value = window.innerWidth
}
onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('resize', onWindowResize)
  document.addEventListener('pointerdown', onDocPointerDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('resize', onWindowResize)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  if (stopBrowserResize) stopBrowserResize()
  clearTimeout(searchTimer)
  clearTimeout(highlightTimer)
  clearTimeout(selectionTimer)
})

// 列表拖宽（220–320px）
function startResize(e) {
  e.preventDefault()
  const startX = e.clientX
  const startW = ui.chatListWidth
  const move = (ev) => {
    ui.setChatListWidth(startW + ev.clientX - startX)
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// 展开/折叠内置浏览器：Electron 下同步拓宽/回收主窗口相同宽度，
// 会话区宽度不因面板开合而跳变；窗口无法调整时（最大化/屏幕放不下）按原行为收缩
async function toggleBrowserPanel() {
  showMoreMenu.value = false
  const opening = !ui.browserPanelOpen
  const panelWidth = visibleBrowserPanelWidth.value
  // 面板占用的横向空间 = 面板宽度 + 右侧外边距（mr-3）
  const delta = panelWidth + 12
  const winApi = window.api && window.api.window
  if (winApi && typeof winApi.resizeForPanel === 'function') {
    try {
      const res = await winApi.resizeForPanel(opening ? delta : -delta)
      // 屏幕空间不足以完整拓宽时，按缺口收窄面板宽度，继续保证会话区宽度不变
      if (opening && res && typeof res.applied === 'number' && res.applied < delta) {
        const shortfall = delta - res.applied
        if (panelWidth - shortfall >= 360) {
          ui.setBrowserPanelWidth(panelWidth - shortfall, false)
        }
      }
    } catch {
      // 窗口调整失败不阻断面板开合
    }
  }
  ui.toggleBrowserPanel()
}

let stopBrowserResize = null

function setBrowserPanelWidth(width) {
  ui.setBrowserPanelWidth(Math.max(360, Math.min(browserPanelMaxWidth.value, width)))
}

function resizeBrowserPanelBy(delta) {
  setBrowserPanelWidth(visibleBrowserPanelWidth.value + delta)
}

function startBrowserResize(e) {
  if (e.button !== undefined && e.button !== 0) return
  e.preventDefault()
  if (stopBrowserResize) stopBrowserResize()
  const startX = e.clientX
  const startW = visibleBrowserPanelWidth.value
  const move = (ev) => {
    ui.setBrowserPanelWidth(
      Math.max(360, Math.min(browserPanelMaxWidth.value, startW + startX - ev.clientX)),
      false
    )
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    window.removeEventListener('blur', up)
    ui.setBrowserPanelWidth(ui.browserPanelWidth)
    if (stopBrowserResize === up) stopBrowserResize = null
  }
  stopBrowserResize = up
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  window.addEventListener('blur', up)
}
</script>

<template>
  <div class="h-full flex min-w-0 bg-panel">
    <!-- 会话列表：可收起、可拖宽（F01） -->
    <aside
      v-show="ui.chatListVisible"
      class="shrink-0 flex flex-col bg-panel"
      :style="{ width: ui.chatListWidth + 'px' }"
      aria-label="会话列表"
    >
      <div class="px-3 pt-3 pb-2 bg-panel">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-base font-semibold flex-1">会话</span>
          <button
            class="icon-btn !h-8 !w-8 border border-line-subtle bg-panel"
            data-testid="new-conv"
            title="新建会话"
            aria-label="新建会话"
            @click="chat.create()"
          >
            <UiIcon name="plus" :size="16" />
          </button>
        </div>
        <div class="relative">
          <UiIcon
            name="search"
            :size="16"
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
          />
          <input
            v-model="search"
            placeholder="搜索标题或内容…"
            aria-label="搜索会话"
            class="field-input !bg-panel !h-8 pl-8 pr-7 text-xs"
            data-testid="conv-search"
            @keydown.enter="searchNow"
          />
          <button
            v-if="search"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 icon-btn-sm !w-5 !h-5"
            aria-label="清空搜索"
            @click="clearSearch"
          >
            <UiIcon name="close" :size="12" />
          </button>
        </div>
        <button
          class="mt-1.5 text-[11px] text-link hover:underline"
          data-testid="conv-search-mode"
          @click="searchMode = searchMode === 'conversations' ? 'messages' : 'conversations'"
        >
          {{ searchMode === 'conversations' ? '切换到全文消息检索' : '切换到会话筛选' }}
        </button>
        <div
          v-if="searchMode === 'messages' && search.trim()"
          class="mt-1.5 rounded-lg border border-line-subtle bg-panel p-1.5 space-y-1"
          data-testid="message-search-results"
        >
          <div v-if="chat.messageSearch.loading" class="px-1 py-2 text-xs text-ink-muted">
            检索中…
          </div>
          <div v-else-if="chat.messageSearch.error" class="px-1 py-2 text-xs text-bad-ink">
            {{ chat.messageSearch.error }}
          </div>
          <div
            v-else-if="!chat.messageSearch.results.length"
            class="px-1 py-2 text-xs text-ink-muted"
          >
            无匹配消息
          </div>
          <button
            v-for="result in chat.messageSearch.results"
            :key="`${result.conversationId}:${result.messageId || 'title'}`"
            class="block w-full rounded-md px-2 py-1.5 text-left hover:bg-subtle"
            :data-testid="`message-search-result-${result.messageId || result.conversationId}`"
            @click="openMessageSearchResult(result)"
          >
            <span class="block truncate text-xs font-medium text-ink-primary">
              {{ result.conversationTitle }}
            </span>
            <span class="block line-clamp-2 text-[11px] text-ink-muted">{{ result.snippet }}</span>
          </button>
          <button
            v-if="chat.messageSearch.nextCursor"
            class="w-full px-2 py-1 text-left text-[11px] text-link hover:underline"
            data-testid="message-search-more"
            @click="loadMoreMessageResults"
          >
            加载更多
          </button>
        </div>
        <div v-if="chat.filtering" class="mt-1.5 text-xs text-ink-muted" aria-live="polite">
          {{ chat.visibleConversations.length }} 条匹配
          <template v-if="!chat.visibleConversations.length">· 无匹配会话</template>
        </div>
      </div>
      <div class="scroll-region flex-1 px-2 pb-2 bg-panel">
        <template v-if="pinnedConvs.length || !chat.filtering">
          <div class="px-1.5 pt-1 pb-1 flex items-center gap-1">
            <span class="text-xs font-semibold text-ink-primary">置顶</span>
            <button
              class="icon-btn-sm !w-5 !h-5"
              :title="pinnedCollapsed ? '展开置顶会话' : '折叠置顶会话'"
              :aria-label="pinnedCollapsed ? '展开置顶会话' : '折叠置顶会话'"
              :aria-expanded="!pinnedCollapsed"
              @click="pinnedCollapsed = !pinnedCollapsed"
            >
              <UiIcon :name="pinnedCollapsed ? 'chevronRight' : 'chevronDown'" :size="14" />
            </button>
          </div>
          <template v-if="!pinnedCollapsed">
            <ConvRow
              v-for="c in pinnedConvs"
              :key="c.id"
              :conv="c"
              :active="c.id === chat.activeId"
              :editing="editingTitleId === c.id"
              @select="chat.select(c.id)"
              @rename="startRename(c)"
              @rename-submit="submitRename"
              @pin="chat.updateConv(c.id, { pinned: c.pinned ? 0 : 1 })"
              @remove="removeConv(c)"
            />
            <div v-if="!pinnedConvs.length" class="px-2 pb-1.5 text-xs text-ink-muted/70">
              暂无置顶会话，悬停会话行可置顶
            </div>
          </template>
        </template>
        <template v-if="projectGroups.length || !chat.filtering">
          <div class="px-1.5 pt-2 pb-1 flex items-center justify-between">
            <span class="flex items-center gap-1">
              <span class="text-xs font-semibold text-ink-primary">项目</span>
              <button
                class="icon-btn-sm !w-5 !h-5"
                :title="projectsCollapsed ? '展开项目' : '折叠项目'"
                :aria-label="projectsCollapsed ? '展开项目' : '折叠项目'"
                :aria-expanded="!projectsCollapsed"
                @click="projectsCollapsed = !projectsCollapsed"
              >
                <UiIcon :name="projectsCollapsed ? 'chevronRight' : 'chevronDown'" :size="14" />
              </button>
            </span>
            <button
              class="icon-btn-sm !w-5 !h-5"
              data-testid="project-add"
              title="添加项目工作目录"
              aria-label="添加项目工作目录"
              @click="openProjectDialog"
            >
              <UiIcon name="plus" :size="14" />
            </button>
          </div>
          <template v-if="!projectsCollapsed">
            <div v-if="!projects.projects.length" class="px-2 pb-1.5 text-xs text-ink-muted/70">
              添加项目工作目录后，会话可按项目归类
            </div>
            <div v-for="g in projectGroups" :key="g.project.id" data-testid="project-item">
              <div
                tabindex="0"
                class="list-row group !min-h-[40px] cursor-pointer select-none"
                role="button"
                :aria-expanded="isExpanded(g.project.id) ? 'true' : 'false'"
                :title="g.project.path"
                @click="toggleProject(g.project.id)"
                @keydown.enter.prevent="toggleProject(g.project.id)"
              >
                <template v-if="editingProjectId === g.project.id">
                  <input
                    v-model="projectDraft"
                    class="flex-1 min-w-0 bg-transparent outline-none border-b border-brand text-sm"
                    aria-label="项目名称"
                    @keydown="onProjectRenameKeydown"
                    @blur="submitProjectRename"
                  />
                </template>
                <template v-else>
                  <span class="shrink-0 text-ink-muted">
                    <UiIcon
                      :name="isExpanded(g.project.id) ? 'chevronDown' : 'chevronRight'"
                      :size="14"
                    />
                  </span>
                  <UiIcon name="folder" :size="14" class="shrink-0 text-brand-ink/80" />
                  <span class="flex-1 truncate">{{ g.project.name }}</span>
                  <RowMenu :items="projectMenuItems(g.project)" label="项目操作" />
                  <span
                    class="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                  >
                    <button
                      class="icon-btn-sm !w-6 !h-6"
                      data-testid="project-new-conv"
                      title="在此项目新建会话"
                      aria-label="在此项目新建会话"
                      @click.stop="createInProject(g.project)"
                    >
                      <UiIcon name="plus" :size="14" />
                    </button>
                  </span>
                </template>
              </div>
              <div v-if="isExpanded(g.project.id)" class="ml-4 border-l border-line-subtle pl-1">
                <ConvRow
                  v-for="c in g.sessions"
                  :key="c.id"
                  :conv="c"
                  :active="c.id === chat.activeId"
                  :editing="editingTitleId === c.id"
                  @select="chat.select(c.id)"
                  @rename="startRename(c)"
                  @rename-submit="submitRename"
                  @pin="chat.updateConv(c.id, { pinned: c.pinned ? 0 : 1 })"
                  @remove="removeConv(c)"
                />
                <button
                  v-if="!g.sessions.length && !chat.filtering"
                  class="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-ink-muted hover:text-ink-secondary"
                  @click="createInProject(g.project)"
                >
                  <UiIcon name="plus" :size="12" />
                  新建会话
                </button>
              </div>
            </div>
          </template>
        </template>
        <template v-if="unprojectedConvs.length">
          <div class="px-1.5 pt-2 pb-1 flex items-center gap-1">
            <span class="text-xs font-semibold text-ink-primary">最近</span>
            <button
              class="icon-btn-sm !w-5 !h-5"
              :title="recentCollapsed ? '展开最近会话' : '折叠最近会话'"
              :aria-label="recentCollapsed ? '展开最近会话' : '折叠最近会话'"
              :aria-expanded="!recentCollapsed"
              @click="recentCollapsed = !recentCollapsed"
            >
              <UiIcon :name="recentCollapsed ? 'chevronRight' : 'chevronDown'" :size="14" />
            </button>
          </div>
          <template v-if="!recentCollapsed">
            <ConvRow
              v-for="c in unprojectedConvs"
              :key="c.id"
              :conv="c"
              :active="c.id === chat.activeId"
              :editing="editingTitleId === c.id"
              @select="chat.select(c.id)"
              @rename="startRename(c)"
              @rename-submit="submitRename"
              @pin="chat.updateConv(c.id, { pinned: c.pinned ? 0 : 1 })"
              @remove="removeConv(c)"
            />
          </template>
        </template>
        <div
          v-if="!chat.visibleConversations.length"
          class="px-3 py-6 text-center text-xs text-ink-muted"
        >
          {{
            chat.filtering
              ? '没有匹配的会话，清空搜索可恢复完整列表'
              : '还没有会话，点击「新建」开始'
          }}
        </div>
      </div>
      <!-- 拖宽手柄（F01：220–320px 可调并记忆） -->
      <div
        v-if="ui.chatListVisible"
        class="w-1 cursor-col-resize shrink-0 hover:bg-brand/20 active:bg-brand/30"
        style="margin-left: -1px"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话列表宽度"
        @mousedown="startResize"
      />
    </aside>

    <div class="relative flex-1 min-w-0 min-h-0 flex">
      <!-- 聊天主区：整个右区为白底悬浮卡片（含页头、消息与输入区） -->
      <!-- 内边距用于露出卡片自身的白边，便于在元素选择器中直接选中整张卡片 -->
      <section
        class="flex-1 min-w-0 flex flex-col m-3 p-2 chat-surface overflow-hidden"
        data-testid="chat-main"
      >
        <!-- 页头：列表开关 / 标题 / 生效模型 / 更多（设置入口统一在侧栏「设置」） -->
        <header class="shrink-0 h-14 flex items-center gap-2 px-4 bg-surface">
          <button
            class="icon-btn"
            :title="ui.chatListVisible ? '收起列表' : '展开列表'"
            :aria-label="ui.chatListVisible ? '收起会话列表' : '展开会话列表'"
            @click="ui.toggleChatList()"
          >
            <UiIcon :name="ui.chatListVisible ? 'panelLeft' : 'panelLeft'" :size="18" />
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <h1 class="text-sm font-semibold truncate" :title="conv ? conv.title : '未选择会话'">
                {{ conv ? conv.title : '未选择会话' }}
              </h1>
            </div>
            <div class="text-xs text-ink-muted truncate">
              <template v-if="!hasService">尚未配置服务</template>
              <template v-else-if="!conv">—</template>
              <template v-else>
                {{ activeProvider ? activeProvider.name : '默认服务' }}
                <template v-if="activeModelId"> / {{ activeModelId }}</template>
              </template>
            </div>
          </div>
          <button
            v-if="!hasService"
            class="btn-secondary !h-8 text-xs"
            @click="ui.view = 'settings'"
          >
            配置服务
          </button>
          <div class="relative">
            <button
              class="icon-btn"
              title="更多操作"
              aria-label="更多操作"
              :aria-expanded="showMoreMenu"
              :disabled="!conv"
              @click="showMoreMenu = !showMoreMenu"
            >
              <UiIcon name="more" :size="18" />
            </button>
            <div
              v-if="showMoreMenu"
              class="absolute right-0 top-10 z-30 w-36 rounded-xl border border-line-subtle bg-elevated shadow-menu py-1"
              role="menu"
            >
              <button
                class="w-full flex items-center gap-2 px-3 h-9 text-sm hover:bg-subtle"
                role="menuitem"
                @click="exportConv('md')"
              >
                <UiIcon name="export" :size="16" /> 导出 MD
              </button>
              <button
                class="w-full flex items-center gap-2 px-3 h-9 text-sm hover:bg-subtle"
                role="menuitem"
                @click="exportConv('json')"
              >
                <UiIcon name="export" :size="16" /> 导出 JSON
              </button>
            </div>
          </div>
          <button
            class="icon-btn"
            :class="ui.browserPanelOpen ? 'text-brand-ink bg-brand-soft' : ''"
            :title="ui.browserPanelOpen ? '折叠内置浏览器' : '展开内置浏览器'"
            :aria-label="ui.browserPanelOpen ? '折叠内置浏览器' : '展开内置浏览器'"
            :aria-pressed="ui.browserPanelOpen"
            data-testid="chat-browser-panel-toggle"
            @click="toggleBrowserPanel"
          >
            <UiIcon name="panelRight" :size="18" />
          </button>
        </header>

        <!-- 消息区：单滚动容器 + 回到底部（F14） -->
        <div class="relative flex-1 min-h-0 bg-surface">
          <!-- 提示词定位柱：横向柱形列表，垂直居中 -->
          <div
            v-if="promptMarkers.length"
            class="absolute left-1 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5"
            aria-label="提示词定位"
          >
            <button
              v-for="m in promptMarkers"
              :key="m.id"
              type="button"
              class="h-[3px] w-3 rounded-full bg-violet-300 transition-all hover:w-5 hover:bg-violet-400 dark:bg-violet-500/60 dark:hover:bg-violet-400"
              :title="'定位提示词：' + (m.content || '').slice(0, 30)"
              aria-label="定位到提示词"
              @click="scrollToPrompt(m.id)"
            />
          </div>
          <div
            ref="scrollEl"
            class="absolute inset-0 overflow-y-auto px-4 md:px-6 py-4 bg-surface"
            @scroll.passive="onScroll"
            @mouseup="onMessageMouseUp"
          >
            <div class="max-w-[840px] mx-auto w-full space-y-4">
              <!-- 空态（F12）：无服务给配置清单，有服务给开始入口 -->
              <div
                v-if="!chat.activeId"
                class="h-full min-h-[280px] flex items-center justify-center"
              >
                <div v-if="!hasService" class="card max-w-sm w-full p-5">
                  <h2 class="text-base font-semibold mb-1">先连接模型服务</h2>
                  <p class="text-xs text-ink-muted mb-4">完成三步即可开始提问，配置只需一次。</p>
                  <ol class="space-y-2.5 text-sm text-ink-secondary mb-4">
                    <li class="flex items-center gap-2">
                      <span
                        class="w-5 h-5 rounded-full bg-brand-soft text-brand-ink text-xs flex items-center justify-center shrink-0"
                        >1</span
                      >
                      添加供应商并填写服务地址
                    </li>
                    <li class="flex items-center gap-2">
                      <span
                        class="w-5 h-5 rounded-full bg-brand-soft text-brand-ink text-xs flex items-center justify-center shrink-0"
                        >2</span
                      >
                      添加 API Key
                    </li>
                    <li class="flex items-center gap-2">
                      <span
                        class="w-5 h-5 rounded-full bg-brand-soft text-brand-ink text-xs flex items-center justify-center shrink-0"
                        >3</span
                      >
                      选择默认模型，返回开始对话
                    </li>
                  </ol>
                  <button
                    class="btn-primary w-full"
                    data-testid="empty-goto-settings"
                    @click="ui.view = 'settings'"
                  >
                    配置服务
                  </button>
                </div>
                <div v-else class="text-center">
                  <div class="text-base text-ink-secondary mb-3">开始一段新会话</div>
                  <button class="btn-primary" @click="chat.create()">新建会话</button>
                  <div class="mt-3 text-xs text-ink-muted">也可以按 Alt+Space 快速提问</div>
                </div>
              </div>
              <MessageItem
                v-for="(m, i) in chat.messages"
                :key="m.id"
                :msg="m"
                :is-last="i === chat.messages.length - 1"
                :highlighted="highlightedMessageId === m.id"
              />
            </div>
          </div>
          <button
            v-if="!stickBottom"
            class="absolute bottom-4 left-1/2 -translate-x-1/2 btn-secondary !h-8 shadow-menu text-xs"
            @click="backToBottom"
          >
            <UiIcon name="arrowDown" :size="14" />
            回到底部
          </button>
        </div>

        <!-- 输入区（AgentComposer）：状态徽标 + 单张白卡（上层输入 / 下层操作栏） -->
        <div class="shrink-0 px-6 pb-5 pt-3 bg-surface">
          <!-- 与消息列等宽：输入卡与上方 840px 对话内容对齐 -->
          <div class="mx-auto w-full max-w-[840px]">
            <AgentComposer
              ref="composerRef"
              :variant="composerVariant"
              :placeholder="composerPlaceholder"
              :hint="composerHint"
              :value="input"
              :submitting="sending"
              :streaming="chat.hasStreaming"
              :model="composerModel"
              :model-groups="modelGroups"
              :status-items="composerStatusItems"
              :mode-action="modeAction"
              :context-action="contextAction"
              :add-action="addAction"
              :cluster-action="clusterAction"
              :context-usage="contextUsage"
              :optimizing="optimizing"
              :send-label="chat.agentMode ? '开始任务' : '发送'"
              @update:value="input = $event"
              @submit="send"
              @optimize="optimizePrompt"
              @stop="stopComposer"
              @add="addAttachment"
              @context="showKbPopover = !showKbPopover"
              @toggle-cluster="toggleCluster"
              @select-mode="selectMode"
              @select-model="selectModel"
              @status-select="openRun"
            >
              <template #attachment>
                <div
                  v-if="ui.pendingAttachment"
                  class="mb-2 flex items-center gap-2 text-xs"
                  data-testid="composer-attachment"
                >
                  <img
                    :src="ui.pendingAttachment"
                    class="h-10 rounded-lg border border-line-subtle"
                    alt="截图附件"
                  />
                  <span class="text-ink-secondary">截图附件</span>
                  <button class="text-link hover:underline" @click="ui.pendingAttachment = null">
                    移除
                  </button>
                </div>
                <div
                  v-if="textAttachments.length"
                  class="mb-2 flex flex-col gap-1"
                  data-testid="composer-text-attachments"
                >
                  <div
                    v-for="a in textAttachments"
                    :key="a.id"
                    class="flex items-start gap-2 rounded-lg border border-line-subtle bg-subtle/40 px-2.5 py-1.5 text-xs"
                  >
                    <span class="shrink-0 font-medium text-ink-secondary">选中文字</span>
                    <span class="min-w-0 flex-1 truncate text-ink-muted">{{ a.preview }}</span>
                    <button class="shrink-0 text-link hover:underline" @click="removeTextAttachment(a.id)">
                      移除
                    </button>
                  </div>
                </div>
              </template>
              <template #context-panel>
                <div
                  v-if="showKbPopover"
                  ref="kbPopoverEl"
                  class="ac-menu ac-menu--left w-72 !max-w-[calc(100vw-48px)]"
                  role="group"
                  aria-label="选择知识库"
                >
                  <div v-if="!kb.kbs.length" class="ac-menu__empty">
                    还没有知识库，到「知识库」页创建
                  </div>
                  <label
                    v-for="k in kb.kbs"
                    :key="k.id"
                    class="ac-menu__item cursor-pointer items-center"
                  >
                    <input
                      type="checkbox"
                      :checked="chat.selectedKbIds.includes(k.id)"
                      @change="toggleKb(k.id)"
                    />
                    <span class="ac-menu__text">
                      <span class="ac-menu__label">{{ k.name }}</span>
                      <span v-if="k.stats" class="ac-menu__hint">
                        {{ k.stats.docs }} 文档 · {{ k.stats.chunks }} 分块
                      </span>
                    </span>
                  </label>
                </div>
              </template>
            </AgentComposer>
            <p v-if="kbNames.length" class="mt-2 px-1 text-xs text-ink-muted">
              将检索：{{ kbNames.join('、') }}
            </p>
          </div>
        </div>
      </section>

      <!-- 分区宽度调节：热区覆盖两区交界（含两侧卡片边缘），不额外占用布局宽度、无可见分隔条 -->
      <div
        v-if="ui.browserPanelOpen"
        class="absolute top-3 bottom-3 z-10 w-4 cursor-col-resize"
        :style="{ right: visibleBrowserPanelWidth + 10 + 'px' }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="调整会话与内置浏览器宽度"
        aria-valuemin="360"
        :aria-valuemax="browserPanelMaxWidth"
        :aria-valuenow="visibleBrowserPanelWidth"
        data-testid="chat-browser-divider"
        title="左右拖动调整分区宽度"
        @mousedown="startBrowserResize"
        @keydown.left.prevent="resizeBrowserPanelBy(-16)"
        @keydown.right.prevent="resizeBrowserPanelBy(16)"
        @keydown.home.prevent="setBrowserPanelWidth(360)"
        @keydown.end.prevent="setBrowserPanelWidth(browserPanelMaxWidth)"
      />

      <aside
        v-if="ui.browserPanelOpen"
        class="shrink-0 min-h-0 flex flex-col my-3 mr-3 pb-[22px] chat-surface overflow-hidden"
        :style="{ width: visibleBrowserPanelWidth + 'px' }"
        aria-label="内置浏览器侧栏"
        data-testid="chat-browser-panel"
      >
        <BrowserView v-if="ui.view === 'chat'" class="flex-1 min-h-0" />
      </aside>

      <!-- 消息内选中文字后的横向操作菜单 -->
      <Teleport to="body">
        <div
          v-if="selectionMenu.visible"
          ref="selectionMenuEl"
          class="fixed z-50 flex h-9 items-center gap-1 rounded-lg border border-line-subtle bg-surface px-1 text-xs shadow-menu"
          :style="{ left: selectionMenu.x + 'px', top: selectionMenu.y + 'px' }"
          data-testid="message-selection-menu"
        >
          <button
            class="h-7 rounded-md px-2.5 text-ink-secondary hover:bg-subtle hover:text-ink-primary"
            data-testid="selection-add-to-chat"
            @click="addSelectionToChat"
          >
            添加到对话
          </button>
          <span class="h-4 w-px bg-line-subtle" aria-hidden="true"></span>
          <button
            class="h-7 rounded-md px-2.5 text-ink-secondary hover:bg-subtle hover:text-ink-primary"
            data-testid="selection-ask-side"
            @click="askSelectionInSideTask"
          >
            在临时会话提问
          </button>
        </div>
      </Teleport>
    </div>

    <!-- 添加项目工作目录（替代设置页的命令工作目录） -->
    <UiDialog :open="showProjectDialog" title="添加项目" @close="showProjectDialog = false">
      <div class="space-y-3">
        <label class="block">
          <span class="field-label">项目名称</span>
          <input
            v-model="projectName"
            data-testid="project-name"
            data-autofocus
            placeholder="如：Mini Agent 开发"
            class="field-input"
            @keydown.enter="submitProject"
          />
        </label>
        <label class="block">
          <span class="field-label">工作目录</span>
          <div class="flex gap-2">
            <input
              v-model="projectPath"
              data-testid="project-path"
              placeholder="选择或粘贴本机文件夹路径"
              class="field-input flex-1"
            />
            <button
              class="btn-secondary shrink-0 text-xs"
              data-testid="project-pick"
              @click="pickProjectDir"
            >
              选择目录
            </button>
          </div>
          <p class="field-help mt-1">任务模式下，该项目内会话的命令将在此目录中执行</p>
          <div class="mt-2 space-y-1.5 text-xs text-ink-secondary">
            <label class="flex items-center gap-2">
              <input
                v-model="projectWorktree"
                type="checkbox"
                data-testid="project-worktree"
                class="accent-brand-ink"
              />
              使用独立 Git 工作区（仅 Git 仓库可用，隔离失败会中止任务）
            </label>
            <label class="flex items-center gap-2">
              <input
                v-model="projectAutoMerge"
                type="checkbox"
                data-testid="project-auto-merge"
                class="accent-brand-ink"
              />
              任务成功后自动合并回当前分支（主目录有未提交改动时跳过）
            </label>
          </div>
        </label>
        <div class="rounded-xl border border-line-subtle bg-subtle/40 p-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              v-model="projectCreateIndex"
              type="checkbox"
              data-testid="project-workspace-index"
              class="accent-brand-ink"
            />
            <span class="text-sm font-medium">创建工作区索引</span>
          </label>
          <p class="field-help mt-1.5">
            建立工作区索引可增强上下文理解能力，从而提升智能体回复准确性。
          </p>
        </div>
        <label v-if="projectWorktree && projectAutoMerge" class="block">
          <span class="field-label">合并验收命令（可选）</span>
          <input
            v-model="projectVerifyCommand"
            data-testid="project-verify-command"
            :maxlength="500"
            placeholder="如：npm test"
            class="field-input"
          />
          <p class="field-help mt-1">
            自动合并前在独立工作区执行；命令失败或 diff 检查不通过时不合并
          </p>
        </label>
        <label v-if="projectWorktree" class="block">
          <span class="field-label">工作区冲突策略</span>
          <select
            v-model="projectConflictStrategy"
            data-testid="project-conflict-strategy"
            class="field-input"
          >
            <option value="manual">人工处理（保留冲突分支）</option>
            <option value="ours">自动选择当前目标侧</option>
            <option value="theirs">自动选择合并来源侧</option>
          </select>
          <p class="field-help mt-1">自动策略可能丢弃另一侧的同文件改动，默认保持人工处理</p>
        </label>
      </div>
      <template #footer>
        <button class="btn-secondary text-sm" @click="showProjectDialog = false">取消</button>
        <button
          class="btn-primary text-sm"
          data-testid="project-confirm"
          :disabled="!projectName.trim() || !projectPath.trim() || savingProject"
          @click="submitProject"
        >
          {{ savingProject ? '添加中…' : '添加' }}
        </button>
      </template>
    </UiDialog>

    <UiDialog :open="showVerifyDialog" title="合并验收命令" @close="showVerifyDialog = false">
      <div class="space-y-3">
        <label class="block">
          <span class="field-label">PowerShell 命令（可选）</span>
          <input
            v-model="verifyCommand"
            data-testid="project-verify-command-edit"
            :maxlength="500"
            placeholder="如：npm test"
            class="field-input"
            @keydown.enter="submitVerifyCommand"
          />
          <p class="field-help mt-1">
            命令以当前 Windows 用户权限在独立工作区执行，最长 120 秒；留空则只做 diff
            与冲突标记检查。
          </p>
        </label>
      </div>
      <template #footer>
        <button class="btn-secondary text-sm" @click="showVerifyDialog = false">取消</button>
        <button
          class="btn-primary text-sm"
          data-testid="project-verify-command-save"
          :disabled="savingVerify"
          @click="submitVerifyCommand"
        >
          {{ savingVerify ? '保存中…' : '保存' }}
        </button>
      </template>
    </UiDialog>

    <UiDialog :open="showConflictDialog" title="工作区冲突策略" @close="showConflictDialog = false">
      <div class="space-y-3">
        <label class="block">
          <span class="field-label">冲突解决方式</span>
          <select
            v-model="conflictStrategy"
            data-testid="project-conflict-strategy-edit"
            class="field-input"
          >
            <option value="manual">人工处理（保留冲突分支）</option>
            <option value="ours">自动选择当前目标侧</option>
            <option value="theirs">自动选择合并来源侧</option>
          </select>
          <p class="field-help mt-1">
            下游继承时当前目标侧是下游工作区；回并时是主分支。来源侧分别是前置成果或 Run 分支。
          </p>
        </label>
      </div>
      <template #footer>
        <button class="btn-secondary text-sm" @click="showConflictDialog = false">取消</button>
        <button
          class="btn-primary text-sm"
          data-testid="project-conflict-strategy-save"
          :disabled="savingConflict"
          @click="submitConflictStrategy"
        >
          {{ savingConflict ? '保存中…' : '保存' }}
        </button>
      </template>
    </UiDialog>
  </div>
</template>
