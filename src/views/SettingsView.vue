<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StatusBadge from '../components/StatusBadge.vue'
import UiDialog from '../components/UiDialog.vue'
import UiIcon from '../components/UiIcon.vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useChatStore } from '../stores/chat'
import { useProjectsStore } from '../stores/projects'

const settings = useSettingsStore()
const ui = useUiStore()
const chat = useChatStore()
const projects = useProjectsStore()

const sections = [
  { key: 'model', label: '模型服务' },
  { key: 'chat', label: '会话' },
  { key: 'models', label: '本地向量模型' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'agent', label: '智能任务' },
  { key: 'browser', label: '浏览器' },
  { key: 'appearance', label: '外观' },
  { key: 'data', label: '数据' },
  { key: 'logs', label: '运行日志' }
]
// 当前分组持久在 ui.settingsSection
const section = computed({
  get: () => ui.settingsSection || 'model',
  set: (v) => (ui.settingsSection = v)
})

// ---------- 初始化同步（F09）：表单跟随 store 初始化完成再取值，避免默认值覆盖已存配置 ----------
const hotkeys = ref({ quick: 'Alt+Space', selection: 'Alt+Q', capture: 'Alt+S' })
const agentDirs = ref([])
const maxSteps = ref(15)
const webSearchProvider = ref('auto')
const tavilyApiKey = ref('')
const mcpServersJson = ref('')
const mcpDiagnostics = ref([])
const mcpValidationError = ref('')
let mcpSaveSequence = 0
const hooksJson = ref('[]')
const hookStages = ref(['session.send', 'run.start', 'run.end', 'tool.before', 'tool.after'])
const hookActions = ref(['notify', 'log', 'block'])
const hooksError = ref('')
const includeKeys = ref(false)
const browserEnabled = ref(true)
const browserAllowPrivateNetwork = ref(false)
const computerEnabled = ref(false)

async function validateMcpConfiguration(raw) {
  if (!window.api.settings || !window.api.settings.validateMcp) {
    throw new Error('MCP 配置校验接口不可用')
  }
  const result = await window.api.settings.validateMcp(raw)
  if (!result || !Array.isArray(result.diagnostics) || typeof result.valid !== 'boolean') {
    throw new Error('MCP 配置校验结果无效')
  }
  return result
}

function showMcpDiagnostics(result) {
  mcpDiagnostics.value = result.diagnostics
  mcpValidationError.value = ''
}

async function syncFromStore() {
  hotkeys.value = { ...settings.hotkeys }
  agentDirs.value = uniqueAgentDirs(settings.settings.agentAuthorizedDirs)
  maxSteps.value = Number(settings.settings.agentMaxSteps) || 15
  webSearchProvider.value = settings.settings.webSearchProvider || 'auto'
  tavilyApiKey.value = settings.settings.tavilyApiKey || ''
  const raw = settings.settings.agentMcpServers
  const text = raw == null ? '' : String(raw)
  mcpServersJson.value = text
  browserEnabled.value = settings.settings.browserEnabled !== false
  browserAllowPrivateNetwork.value = settings.settings.browserAllowPrivateNetwork === true
  computerEnabled.value = settings.settings.computerUseEnabled === true
  syncHooks()
  try {
    const result = await validateMcpConfiguration(raw)
    if (mcpServersJson.value === text) showMcpDiagnostics(result)
  } catch (e) {
    if (mcpServersJson.value === text) {
      mcpValidationError.value = '已保存的 MCP 配置无法校验：' + String((e && e.message) || e)
    }
  }
}

// 钩子配置以 JSON 数组存于 settings.agentHooks；界面只做格式化展示与校验
async function syncHooks() {
  try {
    const list = window.api.hooks ? await window.api.hooks.list() : []
    hooksJson.value = JSON.stringify(list, null, 2)
    hooksError.value = ''
    if (window.api.hooks && window.api.hooks.meta) {
      const meta = await window.api.hooks.meta()
      if (meta && meta.stages) hookStages.value = meta.stages
      if (meta && meta.actions) hookActions.value = meta.actions
    }
  } catch {
    hooksJson.value = '[]'
  }
}

async function saveHooks() {
  try {
    const parsed = JSON.parse(hooksJson.value || '[]')
    if (!Array.isArray(parsed)) throw new Error('钩子配置必须是 JSON 数组')
    const saved = window.api.hooks ? await window.api.hooks.save(parsed) : parsed
    hooksJson.value = JSON.stringify(saved, null, 2)
    hooksError.value = ''
  } catch (e) {
    hooksError.value = String((e && e.message) || e)
    ui.toast('钩子保存失败：' + hooksError.value, 'error')
  }
}
onMounted(() => {
  if (settings.initialized) syncFromStore()
})
watch(
  () => settings.initialized,
  (v) => {
    if (v) syncFromStore()
  }
)

// ---------- 供应商编辑（F11）：草稿与保存边界清晰，脏数据离开需确认 ----------
const editingId = ref(null)
const draft = ref(null)
const draftOrigin = ref('')
const urlError = computed(() => {
  if (!draft.value) return ''
  const v = (draft.value.baseUrl || '').trim()
  if (!v) return '请填写服务地址'
  if (!/^https?:\/\/\S+/i.test(v)) return '地址需以 http(s):// 开头'
  return ''
})
const draftDirty = computed(
  () => !!draft.value && JSON.stringify(draft.value) !== draftOrigin.value
)
const showAdvanced = ref(false)
const keyForm = ref({ label: '', secret: '' })
const keyTarget = ref(null)
const newModel = ref('')
const pulled = ref([]) // 拉取到的候选模型 [{id, vision, checked}]，勾选后手动添加
const pickModel = ref('')
// API Keys 显示/隐藏：按供应商记忆，默认展示
const keysHidden = ref({})
function keysVisible(pid) {
  return !keysHidden.value[pid]
}
function toggleKeys(pid) {
  keysHidden.value = { ...keysHidden.value, [pid]: !keysHidden.value[pid] }
}

// 新建供应商：先进入未保存编辑态，取消不落库（F11，不再生成 https:// 占位记录）
const creating = ref(false)
const createForm = ref({ name: '', baseUrl: '' })
const createUrlError = computed(() => {
  const v = (createForm.value.baseUrl || '').trim()
  if (!v) return '请填写服务地址'
  if (!/^https?:\/\/\S+/i.test(v))
    return '地址需以 http(s):// 开头，例如 https://api.example.com/v1'
  return ''
})

async function startEdit(p) {
  if (editingId.value && editingId.value !== p.id && draftDirty.value) {
    const ok = await ui.confirm({
      title: '放弃未保存的更改',
      message: '当前供应商的修改尚未保存。',
      impact: '离开将丢失这些更改；可先「保存供应商」再切换。',
      confirmText: '放弃更改'
    })
    if (!ok) return
  }
  editingId.value = p.id
  // 深拷贝：模型参数（maxTokens/maxChars）与视觉标记都在草稿内编辑
  draft.value = JSON.parse(JSON.stringify({ ...p, models: p.models || [] }))
  draftOrigin.value = JSON.stringify(draft.value)
  pulled.value = []
  pickModel.value = ''
  newModel.value = ''
  keyForm.value = { label: '', secret: '' }
  paramTarget.value = ''
}
async function closeEdit() {
  if (draftDirty.value) {
    const ok = await ui.confirm({
      title: '放弃未保存的更改',
      message: '当前供应商的修改尚未保存。',
      impact: '收起将丢失这些更改；可先「保存供应商」再收起。',
      confirmText: '放弃更改'
    })
    if (!ok) return
  }
  editingId.value = null
  draft.value = null
  keyTarget.value = null
}
async function saveEdit() {
  if (!draft.value) return
  if (urlError.value) {
    ui.toast(urlError.value, 'warn')
    return
  }
  const d = draft.value
  try {
    await settings.saveProvider({
      id: d.id,
      name: d.name,
      baseUrl: d.baseUrl,
      rotationStrategy: d.rotationStrategy,
      probeIntervalMin: Number(d.probeIntervalMin) || 30,
      probeModel: d.probeModel || null,
      enabled: d.enabled,
      models: d.models
    })
    editingId.value = null
    draft.value = null
    keyTarget.value = null
    ui.toast('供应商已保存', 'success')
  } catch (e) {
    ui.toast('保存失败：' + String((e && e.message) || e), 'error')
  }
}
async function openCreate() {
  createForm.value = { name: '新供应商', baseUrl: '' }
  creating.value = true
}
async function submitCreate() {
  if (!createForm.value.name.trim()) {
    ui.toast('请填写供应商名称', 'warn')
    return
  }
  if (createUrlError.value) {
    ui.toast(createUrlError.value, 'warn')
    return
  }
  try {
    await settings.saveProvider({
      name: createForm.value.name.trim(),
      baseUrl: createForm.value.baseUrl.trim(),
      models: []
    })
    creating.value = false
    ui.toast('供应商已创建，可继续添加 Key 和模型', 'success')
  } catch (e) {
    ui.toast('创建失败：' + String((e && e.message) || e), 'error')
  }
}

// 统一入口：勾选的候选 → 下拉选中 → 手动输入，按此顺序取值批量添加（去重）
function addSelected() {
  if (!draft.value) return
  const chosen = pulled.value.filter((m) => m.checked).map((m) => m.id)
  if (!chosen.length && pickModel.value) chosen.push(pickModel.value)
  const manual = newModel.value.trim()
  if (!chosen.length && manual) chosen.push(manual)
  for (const id of chosen) {
    if (!draft.value.models.find((m) => m.id === id)) draft.value.models.push({ id, vision: false })
  }
  pulled.value.forEach((m) => (m.checked = false))
  pickModel.value = ''
  newModel.value = ''
}
async function pullModels() {
  if (!draft.value) return
  try {
    const ms = await settings.fetchModels(draft.value.id, draft.value.baseUrl)
    const known = new Map(draft.value.models.map((m) => [m.id, m.vision]))
    pulled.value = ms.map((m) => ({ id: m.id, vision: known.get(m.id) || false, checked: false }))
    pickModel.value = ''
    ui.toast(`拉取到 ${ms.length} 个模型，勾选后点「添加」`, 'success')
  } catch (e) {
    ui.toast(String((e && e.message) || e), 'error')
  }
}

// ---------- Key 管理（F04：删除确认；F11：保存成功后状态可见） ----------
async function addKeyTo(pid) {
  if (!keyForm.value.secret.trim()) {
    ui.toast('请填写 Key', 'warn')
    return
  }
  try {
    await settings.addKey({
      providerId: pid,
      label: keyForm.value.label.trim(),
      secret: keyForm.value.secret.trim()
    })
    keyForm.value = { label: '', secret: '' }
    ui.toast('Key 已加密保存', 'success')
  } catch (e) {
    ui.toast('Key 保存失败：' + String((e && e.message) || e), 'error')
  }
}
async function removeKey(k, p) {
  const ok = await ui.confirm({
    title: '删除 API Key',
    message: `删除供应商「${p.name}」的 Key「${k.label || k.id.slice(0, 8)}」？`,
    impact: '删除后调度将跳过这把 Key，不影响其他 Key。',
    confirmText: '删除'
  })
  if (!ok) return
  try {
    await settings.removeKey(k.id)
    ui.toast('Key 已删除', 'success')
  } catch (e) {
    ui.toast('删除失败：' + String((e && e.message) || e), 'error')
  }
}
async function removeProvider(p) {
  const ok = await ui.confirm({
    title: '删除供应商',
    message: `删除供应商「${p.name}」？`,
    impact: `将同时移除其 ${p.keys.length} 把 Key 与模型配置；正在使用它的会话将回退到默认服务。`,
    confirmText: '删除'
  })
  if (!ok) return
  try {
    await settings.removeProvider(p.id)
    if (editingId.value === p.id) {
      editingId.value = null
      draft.value = null
    }
    ui.toast('供应商已删除', 'success')
  } catch (e) {
    ui.toast('删除失败：' + String((e && e.message) || e), 'error')
  }
}
async function probeAll(p) {
  ui.toast('正在探测全部 Key…')
  try {
    const r = await settings.probeAll(p.id)
    const okN = r.filter((x) => x.ok).length
    ui.toast(`探测完成：${okN}/${r.length} 可用`, okN ? 'success' : 'warn')
  } catch (e) {
    ui.toast('探测失败：' + String((e && e.message) || e), 'error')
  }
}

// ---------- 本地嵌入模型（知识库 RAG 本地向量） ----------
async function downloadPkg(p) {
  try {
    const r = await settings.downloadModel(p.id)
    if (!r.started) ui.toast('该模型已在下载中')
    else ui.toast(`开始下载「${p.model}（${p.quant === 'int8' ? '量化' : '非量化'}）」`)
  } catch (e) {
    ui.toast('下载失败：' + String((e && e.message) || e), 'error')
  }
}
async function removePkg(p) {
  const ok = await ui.confirm({
    title: '删除模型包',
    message: `删除本地模型「${p.model}（${p.quant === 'int8' ? '量化' : '非量化'}）」？`,
    impact: '使用该模型的知识库在重建索引或检索前需要重新下载。',
    confirmText: '删除'
  })
  if (!ok) return
  try {
    await settings.removeModel(p.id)
    ui.toast('模型包已删除', 'success')
  } catch (e) {
    ui.toast('删除失败：' + String((e && e.message) || e), 'error')
  }
}
function pkgProgress(p) {
  const pr = settings.modelProgress
  if (pr && pr.id === p.id && !pr.done && pr.status === 'downloading') {
    const pct = pr.totalBytes ? Math.round((pr.received / pr.totalBytes) * 100) : null
    return pct === null ? '下载中…' : `下载中 ${pct}%`
  }
  return null
}
function fmtSize(n) {
  if (!n) return ''
  return n >= 1024 * 1024 * 1024
    ? (n / 1024 ** 3).toFixed(1) + ' GB'
    : Math.max(1, Math.round(n / 1024 / 1024)) + ' MB'
}

// ---------- 快捷键 ----------
async function saveHotkeys() {
  try {
    const rep = await settings.saveHotkeys({ ...hotkeys.value })
    const bad = Object.entries(rep || {}).filter(([_k, v]) => !v.ok)
    if (bad.length)
      ui.toast('部分快捷键注册失败：' + bad.map(([k, v]) => `${k}(${v.reason})`).join('、'), 'warn')
  } catch (e) {
    ui.toast('保存失败：' + String((e && e.message) || e), 'error')
  }
}

// ---------- 智能任务安全 ----------
const savingAgentDirs = ref(false)

// 仅用于界面去重与状态提示；真实边界由主进程 guard 校验。
function dirKey(value) {
  const text = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  const prefix = text.startsWith('//')
    ? '//'
    : text.startsWith('/')
      ? '/'
      : /^[a-z]:/i.test(text)
        ? text.slice(0, 2)
        : ''
  const parts = []
  for (const part of text.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!prefix) parts.push(part)
    } else parts.push(part)
  }
  return (prefix + parts.join('/')).toLowerCase()
}
function uniqueAgentDirs(dirs) {
  const seen = new Set()
  return (Array.isArray(dirs) ? dirs : []).filter((d) => {
    const key = dirKey(d)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// 与主进程 resolveWorkingDir 的项目优先级保持一致；都不配置时使用系统用户主目录。
const currentWorkingDir = computed(() => {
  const projectId = chat.activeConv && chat.activeConv.projectId
  const project = projectId ? projects.byId(projectId) : null
  return (project && project.path) || settings.settings.agentWorkingDir || ''
})
const workingDirLabel = computed(
  () => currentWorkingDir.value || '系统用户主目录（未绑定项目，未配置 legacy 工作目录）'
)
const workingDirAuthorized = computed(() => {
  const target = dirKey(currentWorkingDir.value)
  return (
    !!target &&
    agentDirs.value.some((d) => {
      const root = dirKey(d)
      return target === root || target.startsWith(root + '/')
    })
  )
})

async function persistAgentDirs(next) {
  if (savingAgentDirs.value) return false
  const previous = [...agentDirs.value]
  const previousSetting = settings.settings.agentAuthorizedDirs
  const deduped = uniqueAgentDirs(next)
  savingAgentDirs.value = true
  agentDirs.value = deduped
  try {
    await settings.set('agentAuthorizedDirs', deduped)
    return true
  } catch (e) {
    agentDirs.value = previous
    settings.settings.agentAuthorizedDirs = previousSetting
    ui.toast('授权目录保存失败：' + String((e && e.message) || e), 'error')
    return false
  } finally {
    savingAgentDirs.value = false
  }
}
async function addDir() {
  if (savingAgentDirs.value) return
  try {
    const dir = await window.api.dialog.pickDir()
    if (!dir) return
    if (uniqueAgentDirs([...agentDirs.value, dir]).length === agentDirs.value.length) {
      ui.toast('该目录已在有效授权列表中', 'info')
      return
    }
    await persistAgentDirs([...agentDirs.value, dir])
  } catch (e) {
    ui.toast('选择目录失败：' + String((e && e.message) || e), 'error')
  }
}
async function authorizeWorkingDir() {
  if (!currentWorkingDir.value) {
    ui.toast('请先为当前会话绑定项目并配置工作目录', 'warn')
    return
  }
  if (workingDirAuthorized.value) {
    ui.toast('当前工作目录已在有效授权范围内', 'info')
    return
  }
  await persistAgentDirs([...agentDirs.value, currentWorkingDir.value])
}
async function removeDir(d) {
  const removed = await persistAgentDirs(agentDirs.value.filter((x) => dirKey(x) !== dirKey(d)))
  if (removed) ui.toast('已移除授权目录', 'success')
}
// 编辑即保存：普通字段直接落库
function saveAgent() {
  settings.set('agentMaxSteps', Number(maxSteps.value) || 15)
  settings.set('webSearchProvider', webSearchProvider.value || 'auto')
  settings.set('tavilyApiKey', tavilyApiKey.value.trim() || null)
}
function mcpDiagnosticText(d) {
  const codes = {
    invalid_json: '非法 JSON',
    invalid_root: '根配置无效',
    invalid_name: '服务器名称无效',
    invalid_entry: '服务器配置无效',
    invalid_command: 'command 无效',
    invalid_args: 'args 无效'
  }
  const target = d.name ? `服务器「${d.name}」：` : ''
  const arg = Number.isInteger(d.index) ? `args[${d.index}] ` : ''
  return `${codes[d.code] || d.code || '配置无效'}${target}${arg}${d.reason || ''}`
}

// 保存前统一走主进程详细校验；无效草稿保留在输入框中，但绝不落库。
async function saveMcpServers() {
  const sequence = ++mcpSaveSequence
  const draft = mcpServersJson.value
  const raw = draft.trim() || null
  try {
    const result = await validateMcpConfiguration(raw)
    if (sequence !== mcpSaveSequence || mcpServersJson.value !== draft) return
    showMcpDiagnostics(result)
    if (!result.valid) {
      ui.toast('MCP 配置未保存，请修正下列诊断', 'error')
      return
    }
    await settings.set('agentMcpServers', raw)
    if (sequence === mcpSaveSequence) {
      ui.toast(raw ? 'MCP 配置已保存' : 'MCP 配置已清空', 'success')
    }
  } catch (e) {
    if (sequence === mcpSaveSequence && mcpServersJson.value === draft) {
      mcpValidationError.value = 'MCP 配置校验或保存失败：' + String((e && e.message) || e)
    }
    ui.toast('MCP 配置未保存：' + String((e && e.message) || e), 'error')
  }
}

// ---------- 内置浏览器 ----------
async function toggleBrowserEnabled(value) {
  try {
    await window.api.browser.setEnabled(value)
    settings.settings.browserEnabled = value
    browserEnabled.value = value
    ui.toast(value ? '内置浏览器已启用' : '内置浏览器已停用，所有标签已关闭', 'success')
  } catch (error) {
    browserEnabled.value = !value
    ui.toast('浏览器开关保存失败：' + String(error.message || error), 'error')
  }
}
async function toggleBrowserPrivateNetwork(value) {
  browserAllowPrivateNetwork.value = value
  await settings.set('browserAllowPrivateNetwork', value)
  ui.toast(value ? '已允许访问内网地址，请仅用于可信网络' : '已恢复仅访问公网地址', 'warn')
}
async function clearBrowserData() {
  const ok = await ui.confirm({
    title: '清除浏览器数据',
    message: '将关闭所有标签并清除 Cookie、本地存储和缓存。',
    impact: '用户浏览器登录态会丢失，此操作不可撤销。',
    confirmText: '清除数据'
  })
  if (!ok) return
  try {
    await window.api.browser.clearData()
    ui.toast('浏览器数据已清除', 'success')
  } catch (error) {
    ui.toast('清除失败：' + String(error.message || error), 'error')
  }
}

async function toggleComputerEnabled() {
  const value = !computerEnabled.value
  computerEnabled.value = value
  try {
    await settings.set('computerUseEnabled', value)
    if (!value && window.api.computer) await window.api.computer.stop()
    ui.toast(value ? '电脑操作已启用（默认仍需逐次确认）' : '电脑操作已停用', 'success')
  } catch (error) {
    computerEnabled.value = !value
    ui.toast('电脑操作开关保存失败：' + String(error.message || error), 'error')
  }
}

// ---------- 会话（全局采样参数） ----------
// 这里的「会话」是全局默认：对所有会话生效，不再按单个会话单独设置。
// 落库键 chatSampling；优先级见 gateway.effectiveParams（全局 → 模型参数 → 服务端默认）。
const SAMPLING_FIELDS = [
  { key: 'temperature', label: '随机性', api: 'temperature', help: '越低越稳定、越高越发散' },
  { key: 'topP', label: '核采样', api: 'top_p', help: '控制候选词范围' },
  { key: 'keepTurns', label: '保留轮数', api: 'keepTurns', help: '最近 N 轮对话进入上下文' }
]
const PRESETS = {
  temperature: [
    { label: '严谨', value: 0.2, hint: '事实问答、代码生成' },
    { label: '均衡', value: 0.7, hint: '日常对话' },
    { label: '发散', value: 1.1, hint: '创意写作' }
  ],
  topP: [
    { label: '收敛', value: 0.5, hint: '收窄候选词范围' },
    { label: '均衡', value: 0.9, hint: '推荐默认' },
    { label: '开放', value: 1, hint: '不截断候选词' }
  ],
  keepTurns: [
    { label: '精简', value: 6, hint: '短会话，省 token' },
    { label: '标准', value: 20, hint: '推荐默认' },
    { label: '长程', value: 50, hint: '多轮长对话' }
  ]
}
// 本地草稿跟随 store 初始化后再取值，避免用默认值覆盖已存配置（F09）
const sampling = ref({})
function syncSampling() {
  const v = settings.settings.chatSampling
  sampling.value = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : {}
}
onMounted(() => {
  if (settings.initialized) syncSampling()
})
watch(
  () => [settings.initialized, settings.settings.chatSampling],
  () => {
    if (settings.initialized) syncSampling()
  }
)
function samplingValue(key) {
  const v = sampling.value[key]
  return v === undefined || v === null ? '' : v
}
function isPreset(key, value) {
  const v = sampling.value[key]
  return v !== undefined && v !== null && Number(v) === value
}
// 数值与档位写同一字段；空值表示「不设置」，回退到该模型参数或服务端默认
async function setSampling(key, value) {
  const next = { ...sampling.value }
  if (value === '' || value === null || value === undefined) delete next[key]
  else next[key] = Number(value)
  sampling.value = next
  await settings.set('chatSampling', next)
}
function onSamplingInput(key, e) {
  const raw = e.target.value
  setSampling(key, raw === '' ? null : raw)
}
async function resetSampling() {
  sampling.value = {}
  await settings.set('chatSampling', {})
  ui.toast('已恢复为默认采样参数', 'success')
}

// ---------- 外观 ----------
const themeOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' }
]
async function toggleBall(v) {
  settings.showBall = v
  await settings.set('showBall', v)
  ui.toast(v ? '已开启悬浮球（重启后生效）' : '已关闭悬浮球（重启后生效）')
}
async function toggleCloseToTray(v) {
  const prev = settings.closeToTray
  // 乐观更新：checkbox 的视觉状态跟随后端保存结果，失败时回滚。
  settings.closeToTray = v
  try {
    await settings.set('closeToTray', v)
    ui.toast(v ? '关闭窗口时将隐藏到托盘' : '关闭窗口时将退出软件')
  } catch (e) {
    settings.closeToTray = prev
    ui.toast('关闭行为保存失败：' + String((e && e.message) || e), 'error')
  }
}

// ---------- 数据 ----------
async function exportData() {
  try {
    const r = await window.api.data.export({ includeKeys: includeKeys.value })
    if (r) ui.toast(`已导出 ${r.conversations} 会话 / ${r.messages} 消息`, 'success')
  } catch (e) {
    ui.toast('导出失败：' + String((e && e.message) || e), 'error')
  }
}
async function importData() {
  try {
    const r = await window.api.data.import()
    if (r) ui.toast('导入完成', 'success')
  } catch (e) {
    ui.toast('导入失败：' + String((e && e.message) || e), 'error')
  }
}

// 模型参数编辑（模型级：最大输出长度与上下文上限）
// 参数属于供应商草稿的一部分，跟随「保存供应商」一并落库，保持单一保存边界。
const paramTarget = ref('') // 当前展开的模型条目标识：providerId + '/' + modelId
function paramKey(p, id) {
  return `${p.id}/${id}`
}
function openParamEditor(p, id) {
  const key = paramKey(p, id)
  paramTarget.value = paramTarget.value === key ? '' : key
}
function modelParam(m, field) {
  const v = m && m[field]
  return v === undefined || v === null ? '' : v
}
function setModelParam(m, field, value) {
  if (!m) return
  const n = value === '' || value === null ? null : Number(value)
  m[field] = Number.isFinite(n) && n > 0 ? n : null
}

// ---------- 运行日志 ----------
// 日志由主进程写入 userData/logs/runtime.log，这里只读最近 500 条；
// 打开分组时拉取一次，自动刷新开启时每 2 秒轮询（只在当前分组运行）。
const LOG_LIMIT = 500
const logRows = ref([])
const logLevel = ref('all')
const logQuery = ref('')
const logAutoRefresh = ref(true)
const logLoading = ref(false)
const logError = ref('')
const logStats = ref({ size: 0, bytes: 0, path: '', dir: '' })
const logExpanded = ref({})
let logTimer = null

// persistence 由主进程提供脱敏健康元数据；healthy/disabled 不展示打扰性横幅。
const logRecoveryNotice = ref(null)
watch(
  () => logStats.value && logStats.value.persistence,
  (p, previous) => {
    const recoveredAt = p && p.status === 'healthy' ? p.recoveredAt : null
    if (recoveredAt && recoveredAt !== (previous && previous.recoveredAt)) {
      logRecoveryNotice.value = recoveredAt
    } else if (!p || p.status !== 'healthy' || recoveredAt === (previous && previous.recoveredAt)) {
      logRecoveryNotice.value = null
    }
  }
)
const logPersistence = computed(() => {
  const p = logStats.value && logStats.value.persistence
  if (!p) return null
  const recovered = p.status === 'recovered' || !!logRecoveryNotice.value
  if (!recovered && !['degraded', 'error'].includes(p.status)) return null
  const error = p.lastError
    ? [
        p.lastError.reason,
        p.lastError.code ? `（${p.lastError.code}）` : '',
        p.lastError.operation ? `操作：${p.lastError.operation}` : '',
        p.lastError.at ? formatLogTime(p.lastError.at) : ''
      ]
        .filter(Boolean)
        .join(' ')
    : ''
  return {
    status: recovered ? 'recovered' : p.status,
    title: recovered
      ? '日志持久化已恢复'
      : p.status === 'error'
        ? '日志持久化错误'
        : '日志持久化降级',
    message: recovered
      ? '历史日志文件已恢复写入，内存日志仍可正常查看。'
      : '日志仍保留在内存中，但历史文件写入异常，请检查日志目录权限或磁盘空间。',
    recentError: error ? `最近错误：${error}` : ''
  }
})

const logLevelOptions = [
  { value: 'all', label: '全部' },
  { value: 'debug', label: '调试' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' }
]
const logLevelText = { debug: '调试', info: '信息', warn: '警告', error: '错误' }
const logLevelClass = {
  debug: 'bg-subtle text-ink-muted',
  info: 'bg-hint text-hint-ink',
  warn: 'bg-warn text-warn-ink',
  error: 'bg-bad text-bad-ink'
}
// 事件中枢的内部事件名保留英文便于排查，同时给出中文语义。
const eventLabels = {
  'run.start': '任务开始',
  'run.end': '任务结束',
  'run.empty_result': '任务无输出',
  'run.abort_requested': '请求中止任务',
  'tool.before': '工具调用前',
  'tool.after': '工具调用后',
  'session.created': '子会话创建',
  'session.send': '发送到会话',
  'session.sent': '会话已发送',
  'hook.fired': '钩子触发',
  'mandate.denied': '授权拒绝',
  stale_event_ignored: '忽略过期事件',
  'chat:event': '对话事件',
  'agent:event': '任务事件',
  'keys:event': 'Key 事件',
  'models:progress': '模型下载',
  'kb:progress': '知识库进度',
  'app:notice': '应用通知',
  'updater:changed': '更新状态',
  'remote:changed': '远程控制'
}
function logDisplayMessage(e) {
  if (e.scope !== 'event') return e.message
  const label = eventLabels[e.message]
  return label ? `${label}（${e.message}）` : e.message
}

const filteredLogs = computed(() => {
  const q = logQuery.value.trim().toLowerCase()
  return logRows.value.filter((e) => {
    if (logLevel.value !== 'all' && e.level !== logLevel.value) return false
    if (!q) return true
    return `${e.level} ${e.scope || ''} ${e.message || ''} ${e.data || ''}`
      .toLowerCase()
      .includes(q)
  })
})

async function loadLogs() {
  if (!window.api.logs || logLoading.value) return
  logLoading.value = true
  try {
    const [rows, stats] = await Promise.all([
      window.api.logs.list({ limit: LOG_LIMIT }),
      window.api.logs.stats()
    ])
    logRows.value = Array.isArray(rows) ? rows : []
    logStats.value = stats || {}
    logError.value = ''
  } catch (e) {
    logError.value = String((e && e.message) || e)
  } finally {
    logLoading.value = false
  }
}

function syncLogTimer() {
  if (section.value === 'logs' && logAutoRefresh.value) {
    if (!logTimer) logTimer = setInterval(loadLogs, 2000)
  } else if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}

watch(section, (v) => {
  if (v === 'logs') loadLogs()
  syncLogTimer()
})
watch(logAutoRefresh, syncLogTimer)
onMounted(() => {
  if (section.value === 'logs') {
    loadLogs()
    syncLogTimer()
  }
})
onBeforeUnmount(() => {
  if (logTimer) clearInterval(logTimer)
  logTimer = null
})

function formatLogTime(at) {
  const d = new Date(Number(at) || 0)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n, len = 2) => String(n).padStart(len, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function formatLogBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

function prettyLogData(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return String(raw || '')
  }
}

async function copyLogs() {
  if (!filteredLogs.value.length) return
  const text = filteredLogs.value
    .map((e) =>
      [formatLogTime(e.at), e.level, e.scope || '', e.message || '', e.data || '']
        .filter(Boolean)
        .join('  ')
    )
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ui.toast('已复制当前日志', 'success')
  } catch {
    ui.toast('复制失败', 'error')
  }
}

async function clearLogs() {
  if (!window.api.logs) return
  const ok = await ui.confirm({
    title: '清空运行日志',
    message: '将删除当前运行日志的全部记录。',
    impact: '清空后不可恢复；不影响会话、知识库和任务数据。',
    confirmText: '清空'
  })
  if (!ok) return
  try {
    const cleared = await window.api.logs.clear()
    if (cleared !== true) {
      // 失败时重新读取主进程，保留磁盘旧日志与真实健康状态，不能伪装成已清空。
      await loadLogs()
      ui.toast('清空失败：磁盘日志仍保留，请检查权限或磁盘空间', 'error')
      return
    }
    logExpanded.value = {}
    await loadLogs()
    ui.toast('运行日志已清空', 'success')
  } catch (e) {
    ui.toast('清空失败：' + String((e && e.message) || e), 'error')
  }
}

async function openLogFolder() {
  if (!window.api.logs) return
  try {
    const ok = await window.api.logs.openFolder()
    if (!ok) ui.toast('无法打开日志目录', 'warn')
  } catch (e) {
    ui.toast('打开失败：' + String((e && e.message) || e), 'error')
  }
}
</script>

<template>
  <div class="h-full flex min-w-0 bg-panel">
    <!-- 分组导航（F10）：任一分组一次点击可达 -->
    <nav
      class="shrink-0 bg-panel p-3 space-y-1"
      :style="{ width: ui.chatListWidth + 'px' }"
      aria-label="设置分组"
    >
      <div class="px-2 pb-2 text-base font-semibold text-ink-primary">设置</div>
      <button
        v-for="s in sections"
        :key="s.key"
        :data-testid="'settings-section-' + s.key"
        class="w-full h-10 rounded-lg px-3 text-left text-sm flex items-center"
        :class="
          section === s.key
            ? 'bg-panel text-brand-ink font-medium'
            : 'text-ink-secondary hover:bg-surface'
        "
        :aria-current="section === s.key ? 'true' : undefined"
        @click="section = s.key"
      >
        {{ s.label }}
      </button>
    </nav>

    <div class="flex-1 min-w-0 m-3 chat-surface overflow-hidden flex flex-col">
      <div class="scroll-region flex-1 min-w-0 bg-surface">
        <div class="max-w-[960px] px-6 py-5 space-y-5">
          <div v-if="!settings.initialized" class="text-xs text-ink-muted" role="status">
            正在加载配置…
          </div>

          <!-- 会话：全局采样参数，对所有会话生效（不再按单个会话设置） -->
          <section v-show="section === 'chat'" class="space-y-4">
            <div>
              <h2 class="text-base font-semibold">会话</h2>
              <p class="text-xs text-ink-muted mt-1">
                以下参数对所有会话生效。留空表示不设置，回退到该模型自身的参数或服务端默认。
              </p>
            </div>

            <div class="card p-4 max-w-[760px] space-y-4">
              <div
                v-for="f in SAMPLING_FIELDS"
                :key="f.key"
                :data-testid="'chat-field-' + f.key"
                class="space-y-1"
              >
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="field-label !mb-0 shrink-0 w-[68px]">{{ f.label }}</span>
                  <span class="text-xs text-ink-muted w-[72px] shrink-0">{{ f.api }}</span>
                  <input
                    type="number"
                    class="field-input !h-8 !w-20 shrink-0"
                    :data-testid="'chat-input-' + f.key"
                    :value="samplingValue(f.key)"
                    :placeholder="f.key === 'keepTurns' ? '20' : '默认'"
                    :step="f.key === 'keepTurns' ? 1 : 0.1"
                    :min="f.key === 'keepTurns' ? 1 : 0"
                    :max="f.key === 'temperature' ? 2 : f.key === 'topP' ? 1 : 100"
                    :aria-label="f.label"
                    @change="onSamplingInput(f.key, $event)"
                  />
                  <button
                    v-for="p in PRESETS[f.key]"
                    :key="p.label"
                    type="button"
                    class="btn-compact !h-8 !px-2 !text-[11px] border shrink-0"
                    :class="
                      isPreset(f.key, p.value)
                        ? 'bg-brand-soft text-brand-ink border-brand/40'
                        : 'border-line-control text-ink-secondary hover:bg-subtle'
                    "
                    :title="p.hint"
                    :data-testid="'chat-preset-' + f.key + '-' + p.value"
                    @click="setSampling(f.key, p.value)"
                  >
                    {{ p.label }}
                    <span class="text-ink-muted">{{ p.value }}</span>
                  </button>
                </div>
                <span class="field-help">{{ f.help }}</span>
              </div>

              <div class="flex items-center justify-between gap-3 border-t border-line-subtle pt-3">
                <p class="text-xs text-ink-muted">
                  最大输出长度与上下文上限属于模型自身参数，请到「模型服务 → 编辑供应商 →
                  模型参数」中按模型配置。
                </p>
                <button
                  class="btn-secondary !h-8 shrink-0 text-xs"
                  data-testid="chat-sampling-reset"
                  @click="resetSampling"
                >
                  恢复默认
                </button>
              </div>
            </div>
          </section>

          <!-- 模型服务 -->
          <section v-show="section === 'model'" class="space-y-4">
            <h2 class="text-base font-semibold">模型服务</h2>
            <p class="text-xs text-ink-muted">
              先添加供应商并保存，再添加
              Key、拉取模型；每个模型的输出长度与上下文上限在该卡片的「模型参数」中配置。会话使用哪个服务与模型，在「会话」选项卡中按会话选择。
            </p>

            <div
              v-for="p in settings.providers"
              :key="p.id"
              class="card overflow-hidden"
              data-testid="provider-card"
            >
              <div class="px-4 py-3 flex items-center gap-3">
                <span class="font-medium text-sm shrink-0" data-testid="provider-name">{{
                  p.name
                }}</span>
                <StatusBadge :status="p.enabled ? 'ok' : 'unknown'" />
                <span class="text-xs text-ink-muted truncate flex-1" :title="p.baseUrl">{{
                  p.baseUrl
                }}</span>
                <span class="text-xs text-ink-muted shrink-0"
                  >{{ p.keys.length }} 把 Key · {{ (p.models || []).length }} 个模型</span
                >
                <button
                  class="text-sm text-link hover:underline shrink-0 px-2 py-1"
                  title="配置供应商"
                  @click="editingId === p.id ? closeEdit() : startEdit(p)"
                >
                  编辑
                </button>
                <button
                  class="text-sm text-red-600 hover:underline shrink-0 px-2 py-1"
                  @click="removeProvider(p)"
                >
                  删除
                </button>
              </div>

              <div
                v-if="editingId === p.id && draft"
                class="px-4 pb-4 space-y-3 border-t border-line-subtle pt-3"
              >
                <div class="grid grid-cols-2 gap-3">
                  <label>
                    <span class="field-label">名称</span>
                    <input v-model="draft.name" data-testid="p-name" class="field-input" />
                  </label>
                  <label>
                    <span class="field-label">服务地址</span>
                    <input
                      v-model="draft.baseUrl"
                      data-testid="p-url"
                      placeholder="https://api.example.com/v1"
                      class="field-input"
                      :aria-invalid="!!urlError"
                    />
                    <span v-if="urlError" class="field-error">
                      <UiIcon name="warn" :size="12" />
                      {{ urlError }}
                    </span>
                  </label>
                </div>

                <details
                  :open="showAdvanced"
                  class="text-sm"
                  @toggle="showAdvanced = $event.target.open"
                >
                  <summary class="cursor-pointer select-none text-ink-secondary">
                    高级参数（调度策略、探测）
                  </summary>
                  <div class="grid grid-cols-3 gap-3 mt-2">
                    <label>
                      <span class="field-label">调度策略</span>
                      <select v-model="draft.rotationStrategy" class="field-input">
                        <option value="failover">故障转移</option>
                        <option value="round_robin">轮询</option>
                      </select>
                    </label>
                    <label>
                      <span class="field-label">探测间隔（分钟）</span>
                      <input v-model="draft.probeIntervalMin" type="number" class="field-input" />
                    </label>
                    <label>
                      <span class="field-label">探测用模型</span>
                      <input
                        v-model="draft.probeModel"
                        placeholder="默认用第一个模型"
                        class="field-input"
                      />
                    </label>
                  </div>
                </details>

                <label class="flex items-center gap-2 text-sm">
                  <input v-model="draft.enabled" type="checkbox" />
                  <span>启用该供应商（停用后调度不再使用它）</span>
                </label>

                <div>
                  <span class="field-label">模型列表（勾选＝支持视觉）</span>
                  <div class="flex flex-wrap gap-1.5 mt-1.5">
                    <span
                      v-for="(m, i) in draft.models"
                      :key="m.id"
                      data-testid="model-chip"
                      class="inline-flex items-center gap-1 px-2 h-8 rounded-lg bg-subtle text-xs"
                    >
                      <input v-model="m.vision" type="checkbox" title="支持视觉" />
                      <span>{{ m.id }}</span>
                      <button
                        class="icon-btn-sm !w-5 !h-5"
                        :title="'模型参数：' + m.id"
                        :aria-label="'配置模型参数 ' + m.id"
                        :aria-expanded="paramTarget === paramKey(p, m.id) ? 'true' : 'false'"
                        @click="openParamEditor(p, m.id)"
                      >
                        <UiIcon name="settings" :size="12" />
                      </button>
                      <button
                        class="icon-btn-sm !w-5 !h-5"
                        :aria-label="'移除模型 ' + m.id"
                        @click="draft.models.splice(i, 1)"
                      >
                        <UiIcon name="close" :size="12" />
                      </button>
                    </span>
                    <span v-if="!draft.models.length" class="text-xs text-ink-muted"
                      >还没有模型，拉取或手动添加</span
                    >
                  </div>

                  <!-- 模型参数：最大输出长度与上下文上限（按模型保存） -->
                  <div
                    v-for="m in draft.models.filter((x) => paramTarget === paramKey(p, x.id))"
                    :key="'param-' + m.id"
                    class="mt-2 rounded-lg border border-line-subtle bg-subtle p-3 space-y-2"
                    data-testid="model-params"
                  >
                    <div class="text-xs text-ink-secondary">模型参数 · {{ m.id }}</div>
                    <div class="grid grid-cols-2 gap-3">
                      <label>
                        <span class="field-label !text-xs">最大输出长度</span>
                        <input
                          :value="modelParam(m, 'maxTokens')"
                          type="number"
                          min="1"
                          placeholder="默认"
                          data-testid="model-max-tokens"
                          class="field-input !h-8 text-xs"
                          @input="setModelParam(m, 'maxTokens', $event.target.value)"
                        />
                        <span class="field-help !mt-0.5">max_tokens，留空用服务端默认</span>
                      </label>
                      <label>
                        <span class="field-label !text-xs">上下文上限（字符）</span>
                        <input
                          :value="modelParam(m, 'maxChars')"
                          type="number"
                          min="1"
                          placeholder="默认 12000"
                          data-testid="model-max-chars"
                          class="field-input !h-8 text-xs"
                          @input="setModelParam(m, 'maxChars', $event.target.value)"
                        />
                        <span class="field-help !mt-0.5">历史消息进入请求的字符预算</span>
                      </label>
                    </div>
                    <div class="flex justify-end">
                      <button class="btn-secondary !h-7 !px-2 text-xs" @click="paramTarget = ''">
                        收起
                      </button>
                    </div>
                  </div>

                  <div class="flex gap-2 mt-2">
                    <select
                      v-if="pulled.length"
                      v-model="pickModel"
                      data-testid="model-pick"
                      class="field-input flex-1"
                    >
                      <option value="">从拉取的模型中选择…</option>
                      <option v-for="m in pulled" :key="m.id" :value="m.id">{{ m.id }}</option>
                    </select>
                    <input
                      v-else
                      v-model="newModel"
                      placeholder="模型 ID"
                      data-testid="model-input"
                      class="field-input flex-1"
                      @keydown.enter="addSelected"
                    />
                    <button class="btn-secondary" data-testid="model-add" @click="addSelected">
                      添加
                    </button>
                    <button class="btn-secondary" data-testid="model-pull" @click="pullModels">
                      拉取模型
                    </button>
                  </div>
                  <div
                    v-if="pulled.length"
                    class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-line-subtle divide-y divide-line-subtle"
                  >
                    <label
                      v-for="m in pulled"
                      :key="m.id"
                      data-testid="pulled-item"
                      class="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-subtle text-xs"
                    >
                      <input v-model="m.checked" type="checkbox" />
                      <span class="truncate" :title="m.id">{{ m.id }}</span>
                      <span v-if="m.vision" class="text-ink-muted">已在列表</span>
                    </label>
                  </div>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center gap-2">
                    <span class="field-label !mb-0 flex-1"
                      >API Keys（DPAPI 加密存储，添加后立即生效）</span
                    >
                    <button
                      class="btn-compact btn-secondary"
                      data-testid="k-toggle-visible"
                      :title="keysVisible(p.id) ? '隐藏 API Keys' : '显示 API Keys'"
                      :aria-label="keysVisible(p.id) ? '隐藏 API Keys' : '显示 API Keys'"
                      :aria-pressed="keysVisible(p.id) ? 'false' : 'true'"
                      @click="toggleKeys(p.id)"
                    >
                      <UiIcon :name="keysVisible(p.id) ? 'eye' : 'eyeOff'" :size="14" />
                    </button>
                    <button
                      class="btn-compact btn-secondary"
                      data-testid="k-probe-all"
                      @click="probeAll(p)"
                    >
                      一键探测
                    </button>
                    <button
                      class="btn-compact btn-secondary"
                      data-testid="k-add-toggle"
                      @click="keyTarget = keyTarget === p.id ? null : p.id"
                    >
                      {{ keyTarget === p.id ? '收起' : '添加 Key' }}
                    </button>
                  </div>
                  <div v-if="keyTarget === p.id" class="flex gap-2">
                    <input
                      v-model="keyForm.label"
                      data-testid="k-label"
                      placeholder="备注（可选）"
                      aria-label="Key 备注"
                      class="field-input !w-36"
                    />
                    <input
                      v-model="keyForm.secret"
                      data-testid="k-secret"
                      placeholder="sk-..."
                      type="password"
                      aria-label="Key 密钥"
                      class="field-input flex-1"
                      @keydown.enter="addKeyTo(p.id)"
                    />
                    <button class="btn-primary !h-9" data-testid="k-save" @click="addKeyTo(p.id)">
                      保存
                    </button>
                  </div>
                  <template v-if="keysVisible(p.id)">
                    <div
                      v-for="k in p.keys"
                      :key="k.id"
                      class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-subtle text-sm"
                    >
                      <StatusBadge :status="k.status" data-testid="key-status" />
                      <span class="flex-1 truncate">{{ k.label || k.id.slice(0, 8) }}</span>
                      <span
                        v-if="k.lastError"
                        class="text-ink-muted truncate max-w-[180px]"
                        :title="k.lastError"
                      >
                        {{ k.lastError }}
                      </span>
                      <button
                        class="text-sm text-link hover:underline"
                        @click="settings.probeKey(k.id)"
                      >
                        探测
                      </button>
                      <button class="text-sm text-red-600 hover:underline" @click="removeKey(k, p)">
                        删除
                      </button>
                    </div>
                  </template>
                  <div v-else class="px-2.5 py-1.5 text-xs text-ink-muted">
                    API Keys 已隐藏（{{ p.keys.length }} 把）
                  </div>
                </div>

                <div class="flex justify-end gap-2 pt-1">
                  <button class="btn-secondary" data-testid="p-cancel" @click="closeEdit">
                    取消
                  </button>
                  <button
                    class="btn-secondary !h-9"
                    :disabled="!!urlError"
                    data-testid="p-save"
                    @click="saveEdit"
                  >
                    保存供应商
                  </button>
                </div>
              </div>
            </div>

            <button
              class="w-full py-2.5 rounded-xl text-sm border border-dashed border-line-control text-ink-secondary hover:border-brand hover:text-brand-ink"
              data-testid="provider-add"
              @click="openCreate"
            >
              + 添加供应商
            </button>
          </section>

          <!-- 快捷键 -->
          <section v-show="section === 'hotkeys'" class="space-y-4">
            <h2 class="text-base font-semibold">全局快捷键</h2>
            <div class="space-y-3 max-w-md">
              <div class="flex items-center gap-3">
                <span class="text-sm flex-1">快速输入窗</span>
                <input
                  v-model="hotkeys.quick"
                  aria-label="快速输入窗快捷键"
                  class="field-input !w-40"
                  @change="saveHotkeys"
                />
              </div>
              <div class="flex items-center gap-3">
                <span class="text-sm flex-1">划词问 AI</span>
                <input
                  v-model="hotkeys.selection"
                  aria-label="划词问 AI 快捷键"
                  class="field-input !w-40"
                  @change="saveHotkeys"
                />
              </div>
              <div class="flex items-center gap-3">
                <span class="text-sm flex-1">截屏问 AI</span>
                <input
                  v-model="hotkeys.capture"
                  aria-label="截屏问 AI 快捷键"
                  class="field-input !w-40"
                  @change="saveHotkeys"
                />
              </div>
            </div>
          </section>

          <!-- 智能任务 -->
          <section v-show="section === 'agent'" class="space-y-4">
            <h2 class="text-base font-semibold">智能任务安全</h2>
            <div class="space-y-3 max-w-2xl">
              <div class="card p-4 space-y-3" data-testid="agent-directory-security">
                <div>
                  <span class="field-label">当前工作目录（仅用于 run_command，不自动授权）</span>
                  <p class="mt-1 text-sm font-mono break-all" data-testid="agent-working-dir">
                    {{ workingDirLabel }}
                  </p>
                  <p class="field-help mt-1">
                    默认没有任何文件授权。工作目录不会因为绑定项目或打开设置而自动加入授权范围。
                  </p>
                </div>
                <div class="flex items-center gap-3 flex-wrap">
                  <button
                    class="btn-secondary"
                    :disabled="savingAgentDirs || workingDirAuthorized"
                    data-testid="agent-authorize-working-dir"
                    @click="authorizeWorkingDir"
                  >
                    授权当前工作目录
                  </button>
                  <span
                    class="text-xs"
                    :class="workingDirAuthorized ? 'text-ok-ink' : 'text-warn-ink'"
                    data-testid="agent-working-dir-status"
                  >
                    {{ workingDirAuthorized ? '已在有效授权范围内' : '未授权文件读写' }}
                  </span>
                </div>
                <div class="border-t border-line-subtle pt-3">
                  <span class="field-label">有效授权目录（文件工具读写范围）</span>
                  <div class="flex flex-wrap gap-1.5 mt-1.5" data-testid="agent-authorized-dirs">
                    <span
                      v-for="d in agentDirs"
                      :key="d"
                      class="inline-flex items-center gap-1 px-2 h-8 rounded-lg bg-subtle text-xs"
                      data-testid="agent-authorized-dir"
                    >
                      <span class="truncate max-w-[300px]" :title="d">{{ d }}</span>
                      <button
                        class="icon-btn-sm !w-5 !h-5"
                        :disabled="savingAgentDirs"
                        :aria-label="'移除目录 ' + d"
                        @click="removeDir(d)"
                      >
                        <UiIcon name="close" :size="12" />
                      </button>
                    </span>
                    <button
                      class="btn-compact border border-dashed border-line-control"
                      :disabled="savingAgentDirs"
                      data-testid="agent-add-dir"
                      @click="addDir"
                    >
                      + 添加目录
                    </button>
                    <span v-if="!agentDirs.length" class="text-xs text-warn-ink py-1">
                      未授权任何目录
                    </span>
                  </div>
                  <p class="field-help mt-1">
                    授权包含子目录；保存失败会回滚。独立 Git
                    工作区由任务系统单独加入，不属于当前工作目录的自动授权。
                  </p>
                </div>
              </div>
              <div
                class="max-w-2xl rounded-lg border border-warn/40 bg-warn-soft p-3 text-xs text-warn-ink"
              >
                <strong>命令特权提示：</strong>run_command 不受上述目录 guard 限制，不属于文件沙箱；
                它以当前 Windows 用户权限在工作目录执行，仍需逐次确认，可访问授权目录之外的文件。
              </div>
              <div class="max-w-md">
                <label class="block">
                  <span class="field-label">最大步数</span>
                  <input
                    v-model="maxSteps"
                    type="number"
                    min="1"
                    max="50"
                    class="field-input"
                    @change="saveAgent"
                  />
                </label>
                <p class="field-help mt-1">
                  命令工作目录已移至会话页「项目」分组：每个项目可绑定独立目录，任务模式按会话所属项目执行命令。
                </p>
              </div>
              <div class="max-w-2xl rounded-lg border border-line-subtle bg-panel p-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <span class="field-label">电脑操作（Windows UIA + 浏览器 CDP）</span>
                    <p class="field-help mt-1">
                      默认关闭。启用后仍按工具风险审批；密码控件禁止写入，所有动作要求目标窗口在前台。需要
                      .NET 10 Windows Desktop Runtime。
                    </p>
                  </div>
                  <button
                    class="btn-compact shrink-0"
                    data-testid="computer-enabled-toggle"
                    :aria-pressed="computerEnabled"
                    @click="toggleComputerEnabled"
                  >
                    {{ computerEnabled ? '已启用' : '已停用' }}
                  </button>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3 max-w-md">
                <label>
                  <span class="field-label">联网搜索通道</span>
                  <select v-model="webSearchProvider" class="field-input" @change="saveAgent">
                    <option value="auto">自动（有 Tavily Key 则优先）</option>
                    <option value="tavily">Tavily（需 Key）</option>
                    <option value="ddg">DuckDuckGo（免 Key）</option>
                  </select>
                </label>
                <label>
                  <span class="field-label">Tavily API Key（可选）</span>
                  <input
                    v-model="tavilyApiKey"
                    type="password"
                    placeholder="留空则用 DuckDuckGo"
                    class="field-input"
                    @change="saveAgent"
                  />
                </label>
              </div>
              <label class="block max-w-2xl">
                <span class="field-label">MCP 服务器配置（JSON，可选）</span>
                <textarea
                  v-model="mcpServersJson"
                  rows="3"
                  data-testid="mcp-servers-json"
                  :aria-invalid="!!mcpDiagnostics.length || !!mcpValidationError"
                  placeholder='例如: {"docs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/docs"]}}'
                  class="field-input font-mono text-xs"
                  @change="saveMcpServers"
                ></textarea>
                <span class="field-help mt-1 block">
                  留空保存为 null（不配置 MCP）；非法 JSON、command 或 args 会阻止保存。
                </span>
                <div
                  v-if="mcpDiagnostics.length"
                  data-testid="mcp-diagnostics"
                  class="mt-2 rounded-lg border border-bad/40 bg-bad-soft p-2 text-xs text-bad-ink"
                  role="alert"
                >
                  <p v-for="(d, i) in mcpDiagnostics" :key="i" :data-code="d.code">
                    {{ mcpDiagnosticText(d) }}
                  </p>
                </div>
                <span
                  v-if="mcpValidationError"
                  data-testid="mcp-validation-error"
                  class="field-help mt-1 block text-bad-ink"
                  role="alert"
                  >{{ mcpValidationError }}</span
                >
              </label>
              <label class="block max-w-2xl">
                <span class="field-label">生命周期钩子（JSON 数组，可选）</span>
                <textarea
                  v-model="hooksJson"
                  rows="6"
                  data-testid="hooks-json"
                  :placeholder="`例如: [{&quot;stage&quot;:&quot;run.end&quot;,&quot;action&quot;:&quot;notify&quot;,&quot;message&quot;:&quot;任务完成&quot;},{&quot;stage&quot;:&quot;tool.before&quot;,&quot;action&quot;:&quot;block&quot;,&quot;match&quot;:{&quot;tool&quot;:&quot;run_command&quot;},&quot;reason&quot;:&quot;本机禁止执行命令&quot;}]`"
                  class="field-input font-mono text-xs"
                  @change="saveHooks"
                ></textarea>
                <span class="field-help mt-1 block">
                  可用阶段：{{ hookStages.join(' / ') }}；可用动作：{{ hookActions.join(' / ') }}。
                  block 仅能让操作更严格（无法放行需要确认的调用），notify 会在界面弹一条提示。
                </span>
                <span v-if="hooksError" class="field-help mt-1 block text-bad-ink">{{
                  hooksError
                }}</span>
              </label>
            </div>
          </section>

          <!-- 内置浏览器 -->
          <section v-show="section === 'browser'" class="space-y-4">
            <h2 class="text-base font-semibold">内置浏览器</h2>
            <div class="space-y-3 max-w-2xl">
              <label class="flex items-center gap-2 cursor-pointer min-h-[36px]">
                <input
                  type="checkbox"
                  data-testid="browser-enabled"
                  :checked="browserEnabled"
                  @change="toggleBrowserEnabled($event.target.checked)"
                />
                <span>启用内置浏览器</span>
              </label>
              <p class="field-help -mt-2">
                用户标签保存登录态；Agent 标签按任务隔离，任务结束自动关闭，不读取用户 Cookie。
              </p>
              <label class="flex items-center gap-2 cursor-pointer min-h-[36px]">
                <input
                  type="checkbox"
                  data-testid="browser-private-network"
                  :checked="browserAllowPrivateNetwork"
                  @change="toggleBrowserPrivateNetwork($event.target.checked)"
                />
                <span>允许访问内网和本地地址</span>
              </label>
              <p class="field-help -mt-2">
                默认阻止回环、私网和链路本地地址。仅在需要访问可信内网服务时开启。
              </p>
              <div>
                <button
                  class="btn-secondary"
                  data-testid="browser-clear-data"
                  @click="clearBrowserData"
                >
                  清除浏览器数据
                </button>
              </div>
            </div>
          </section>

          <!-- 本地嵌入模型 -->
          <section v-show="section === 'models'" class="space-y-4">
            <h2 class="text-base font-semibold">本地向量模型</h2>
            <p class="text-xs text-ink-muted">
              知识库可用本地 ONNX 模型（onnxruntime + faiss）生成向量，全程离线、文档不出本机。
              量化版（int8）体积小速度快，非量化版（fp32）精度略高；下载后在「知识库 →
              新建」中选择。
            </p>
            <div class="card overflow-hidden">
              <table class="w-full text-sm">
                <thead class="bg-subtle text-ink-secondary">
                  <tr>
                    <th class="text-left px-3 py-2 font-medium">模型</th>
                    <th class="text-left px-3 py-2 font-medium w-28">精度</th>
                    <th class="text-left px-3 py-2 font-medium w-16">维度</th>
                    <th class="text-left px-3 py-2 font-medium w-24">大小</th>
                    <th class="text-left px-3 py-2 font-medium w-28">状态</th>
                    <th class="w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="p in settings.modelPackages"
                    :key="p.id"
                    class="border-t border-line-subtle"
                    :data-testid="'model-' + p.model + '-' + p.quant"
                  >
                    <td class="px-3 py-2.5 font-medium">{{ p.model }}</td>
                    <td class="px-3 py-2.5">
                      {{ p.quant === 'int8' ? '量化 int8' : '非量化 fp32' }}
                    </td>
                    <td class="px-3 py-2.5">{{ p.dim }}</td>
                    <td class="px-3 py-2.5 text-ink-muted">
                      {{ p.downloaded ? fmtSize(p.sizeBytes) : p.sizeHint }}
                    </td>
                    <td class="px-3 py-2.5">
                      <span v-if="p.downloaded" class="text-ok-ink text-xs">已下载</span>
                      <span
                        v-else-if="pkgProgress(p)"
                        class="text-ink-secondary text-xs"
                        role="status"
                        >{{ pkgProgress(p) }}</span
                      >
                      <span v-else class="text-ink-muted text-xs">未下载</span>
                    </td>
                    <td class="px-3 py-2.5 text-right whitespace-nowrap">
                      <button
                        v-if="!p.downloaded"
                        class="btn-compact btn-secondary !h-7 !px-2 text-xs"
                        data-testid="model-download"
                        :disabled="!!pkgProgress(p)"
                        @click="downloadPkg(p)"
                      >
                        下载
                      </button>
                      <button
                        v-else
                        class="btn-compact !h-7 !px-2 text-xs hover:!text-red-500"
                        :aria-label="'删除模型 ' + p.model"
                        @click="removePkg(p)"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="text-xs text-ink-muted">
              模型来源：HuggingFace 镜像（hf-mirror.com），存放于数据目录 models/ 下。
            </div>
          </section>

          <!-- 外观 -->
          <section v-show="section === 'appearance'" class="space-y-4">
            <h2 class="text-base font-semibold">外观</h2>
            <div class="flex items-center gap-2 text-sm">
              <label class="flex items-center gap-2 cursor-pointer min-h-[36px]">
                <input
                  type="checkbox"
                  data-testid="close-to-tray"
                  :checked="settings.closeToTray"
                  @change="toggleCloseToTray($event.target.checked)"
                />
                <span>关闭窗口时隐藏到托盘</span>
              </label>
            </div>
            <p class="text-xs text-ink-muted -mt-2">
              关闭此选项后，点击关闭按钮会退出软件；托盘菜单的「退出」始终真正退出。
            </p>
            <div class="flex items-center gap-6 text-sm flex-wrap">
              <div class="flex items-center gap-4">
                <span class="text-ink-secondary">主题</span>
                <label
                  v-for="t in themeOptions"
                  :key="t.value"
                  class="flex items-center gap-1.5 cursor-pointer min-h-[36px]"
                >
                  <input
                    type="radio"
                    name="theme"
                    :value="t.value"
                    :checked="ui.theme === t.value"
                    @change="ui.setTheme(t.value)"
                  />
                  <span>{{ t.label }}</span>
                </label>
              </div>
              <label class="flex items-center gap-2 cursor-pointer min-h-[36px]">
                <input
                  type="checkbox"
                  :checked="settings.autostart"
                  @change="settings.setAutostart($event.target.checked)"
                />
                <span>开机自启</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer min-h-[36px]">
                <input
                  type="checkbox"
                  :checked="settings.showBall"
                  @change="toggleBall($event.target.checked)"
                />
                <span>悬浮球</span>
              </label>
            </div>
          </section>

          <!-- 数据 -->
          <section v-show="section === 'data'" class="space-y-4">
            <h2 class="text-base font-semibold">数据</h2>
            <div class="flex items-center gap-3 text-sm flex-wrap">
              <button class="btn-secondary" @click="exportData">导出备份</button>
              <label class="flex items-center gap-1.5 cursor-pointer">
                <input v-model="includeKeys" type="checkbox" />
                <span class="text-ink-secondary"
                  >包含 API Key（<span class="text-warn-ink">导出文件含明文 Key，请谨慎保管</span
                  >）</span
                >
              </label>
              <button class="btn-secondary" @click="importData">导入备份</button>
            </div>
            <div v-if="settings.info" class="text-xs text-ink-muted">
              Mini Agent v{{ settings.info.version
              }}<span v-if="settings.info.commit">
                · 构建 {{ settings.info.commit.slice(0, 7) }}</span
              >
              · {{ settings.info.driver }} · 数据目录 {{ settings.info.dataDir }}
            </div>
          </section>

          <!-- 运行日志：主进程控制台 + 事件中枢 + 显式业务日志 -->
          <section v-show="section === 'logs'" class="space-y-4">
            <div class="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h2 class="text-base font-semibold">运行日志</h2>
                <p class="text-xs text-ink-muted mt-1">
                  记录应用启动、任务与工具调用、后台事件和主进程告警。界面展示最近
                  {{ LOG_LIMIT }} 条，完整日志按 JSONL 写入本地文件，敏感字段会脱敏。
                </p>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  class="btn-secondary !h-8 text-xs"
                  data-testid="log-refresh"
                  :disabled="logLoading"
                  @click="loadLogs"
                >
                  刷新
                </button>
                <button
                  class="btn-secondary !h-8 text-xs"
                  data-testid="log-open-folder"
                  @click="openLogFolder"
                >
                  打开日志目录
                </button>
                <button
                  class="btn-secondary !h-8 text-xs"
                  data-testid="log-copy"
                  :disabled="!filteredLogs.length"
                  @click="copyLogs"
                >
                  复制当前列表
                </button>
                <button
                  class="btn-secondary !h-8 text-xs hover:!text-red-500"
                  data-testid="log-clear"
                  @click="clearLogs"
                >
                  清空
                </button>
              </div>
            </div>

            <div
              v-if="logPersistence"
              data-testid="log-persistence-health"
              :data-status="logPersistence.status"
              class="rounded-lg border p-3 text-xs"
              :class="
                logPersistence.status === 'recovered'
                  ? 'border-hint/40 bg-hint text-hint-ink'
                  : 'border-warn/40 bg-warn-soft text-warn-ink'
              "
              role="status"
            >
              <p class="font-medium">{{ logPersistence.title }}</p>
              <p class="mt-1">{{ logPersistence.message }}</p>
              <p v-if="logPersistence.recentError" class="mt-1" data-testid="log-persistence-error">
                {{ logPersistence.recentError }}
              </p>
            </div>

            <div class="card overflow-hidden">
              <div
                class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line-subtle bg-subtle"
              >
                <label class="flex items-center gap-1.5 text-xs text-ink-secondary">
                  <input v-model="logAutoRefresh" type="checkbox" data-testid="log-auto-refresh" />
                  自动刷新
                </label>
                <select
                  v-model="logLevel"
                  class="field-input !h-8 !w-24 text-xs"
                  data-testid="log-level"
                  aria-label="日志级别"
                >
                  <option v-for="o in logLevelOptions" :key="o.value" :value="o.value">
                    {{ o.label }}
                  </option>
                </select>
                <input
                  v-model="logQuery"
                  class="field-input !h-8 !w-64 text-xs"
                  data-testid="log-search"
                  placeholder="搜索级别 / 范围 / 内容"
                  aria-label="搜索日志"
                />
                <span class="text-xs text-ink-muted ml-auto whitespace-nowrap">
                  显示 {{ filteredLogs.length }} / {{ logRows.length }} 条 · 文件
                  {{ formatLogBytes(logStats.bytes) }}
                </span>
              </div>

              <div class="max-h-[560px] overflow-y-auto">
                <div
                  v-if="logLoading && !logRows.length"
                  class="px-4 py-10 text-center text-xs text-ink-muted"
                  role="status"
                >
                  正在加载运行日志…
                </div>
                <div
                  v-else-if="!filteredLogs.length"
                  class="px-4 py-10 text-center text-xs text-ink-muted"
                >
                  {{ logRows.length ? '没有匹配的日志' : '暂无运行日志' }}
                </div>
                <template v-else>
                  <div
                    v-for="e in filteredLogs"
                    :key="e.id"
                    class="px-3 py-2 border-b border-line-subtle last:border-b-0 font-code text-xs"
                    data-testid="log-row"
                  >
                    <div class="flex items-start gap-2">
                      <span
                        class="shrink-0 text-ink-muted w-[148px]"
                        :title="new Date(e.at).toLocaleString('zh-CN')"
                        >{{ formatLogTime(e.at) }}</span
                      >
                      <span
                        class="badge shrink-0"
                        :class="logLevelClass[e.level] || logLevelClass.info"
                        >{{ logLevelText[e.level] || e.level }}</span
                      >
                      <span class="shrink-0 text-ink-muted">{{ e.scope }}</span>
                      <span
                        class="min-w-0 flex-1 whitespace-pre-wrap break-words"
                        :class="
                          e.level === 'error'
                            ? 'text-bad-ink'
                            : e.level === 'warn'
                              ? 'text-warn-ink'
                              : 'text-ink-primary'
                        "
                        >{{ logDisplayMessage(e) }}</span
                      >
                      <button
                        v-if="e.data"
                        type="button"
                        class="shrink-0 text-link hover:underline"
                        @click="logExpanded[e.id] = !logExpanded[e.id]"
                      >
                        {{ logExpanded[e.id] ? '收起' : '详情' }}
                      </button>
                    </div>
                    <pre
                      v-if="e.data && logExpanded[e.id]"
                      class="mt-1.5 p-2 rounded-lg bg-subtle overflow-x-auto max-h-64 whitespace-pre-wrap break-words"
                      >{{ prettyLogData(e.data) }}</pre>
                  </div>
                </template>
              </div>
            </div>

            <div class="flex items-center gap-2 text-xs text-ink-muted flex-wrap">
              <span class="break-all">日志文件：{{ logStats.path || '（未初始化）' }}</span>
              <span v-if="logError" class="text-bad-ink">{{ logError }}</span>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- 新建供应商对话框（F11）：取消不落库 -->
    <UiDialog :open="creating" title="添加供应商" width="480px" @close="creating = false">
      <div class="space-y-4">
        <label class="block">
          <span class="field-label">名称</span>
          <input v-model="createForm.name" data-testid="p-name" class="field-input" />
        </label>
        <label class="block">
          <span class="field-label">服务地址</span>
          <input
            v-model="createForm.baseUrl"
            data-testid="p-url"
            placeholder="https://api.example.com/v1"
            class="field-input"
            :aria-invalid="!!createUrlError"
            @keydown.enter="submitCreate"
          />
          <span v-if="createUrlError" class="field-error">
            <UiIcon name="warn" :size="12" />
            {{ createUrlError }}
          </span>
          <span class="field-help">OpenAI 兼容接口地址，例如 https://api.example.com/v1</span>
        </label>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="creating = false">取消</button>
        <button class="btn-primary" data-testid="p-create" @click="submitCreate">创建</button>
      </template>
    </UiDialog>
  </div>
</template>
