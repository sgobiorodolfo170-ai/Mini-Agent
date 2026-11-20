<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import StatusBadge from '../components/StatusBadge.vue'
import UiDialog from '../components/UiDialog.vue'
import UiIcon from '../components/UiIcon.vue'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

const settings = useSettingsStore()
const ui = useUiStore()

const sections = [
  { key: 'model', label: '模型服务' },
  { key: 'models', label: '本地嵌入模型' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'agent', label: '智能任务' },
  { key: 'appearance', label: '外观' },
  { key: 'data', label: '数据' }
]
const section = ref('model')

// ---------- 初始化同步（F09）：表单跟随 store 初始化完成再取值，避免默认值覆盖已存配置 ----------
const hotkeys = ref({ quick: 'Alt+Space', selection: 'Alt+Q', capture: 'Alt+S' })
const agentDirs = ref([])
const maxSteps = ref(15)
const webSearchProvider = ref('auto')
const tavilyApiKey = ref('')
const mcpServersJson = ref('')
const includeKeys = ref(false)

function syncFromStore() {
  hotkeys.value = { ...settings.hotkeys }
  agentDirs.value = [...(settings.settings.agentAuthorizedDirs || [])]
  maxSteps.value = Number(settings.settings.agentMaxSteps) || 15
  webSearchProvider.value = settings.settings.webSearchProvider || 'auto'
  tavilyApiKey.value = settings.settings.tavilyApiKey || ''
  mcpServersJson.value = settings.settings.agentMcpServers || ''
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
  draft.value = JSON.parse(JSON.stringify({ ...p, models: [...(p.models || [])] }))
  draftOrigin.value = JSON.stringify(draft.value)
  pulled.value = []
  pickModel.value = ''
  newModel.value = ''
  keyForm.value = { label: '', secret: '' }
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
    else ui.toast('快捷键已更新', 'success')
  } catch (e) {
    ui.toast('保存失败：' + String((e && e.message) || e), 'error')
  }
}

// ---------- 智能任务安全 ----------
async function addDir() {
  const dir = await window.api.dialog.pickDir()
  if (!dir) return
  if (!agentDirs.value.includes(dir)) agentDirs.value.push(dir)
  settings.set('agentAuthorizedDirs', [...agentDirs.value])
}
function removeDir(d) {
  agentDirs.value = agentDirs.value.filter((x) => x !== d)
  settings.set('agentAuthorizedDirs', [...agentDirs.value])
}
function saveAgent() {
  try {
    if (mcpServersJson.value.trim()) JSON.parse(mcpServersJson.value) // 格式校验
    settings.set('agentMaxSteps', Number(maxSteps.value) || 15)
    settings.set('webSearchProvider', webSearchProvider.value || 'auto')
    settings.set('tavilyApiKey', tavilyApiKey.value.trim() || null)
    settings.set('agentMcpServers', mcpServersJson.value.trim() || null)
    ui.toast('智能任务设置已保存', 'success')
  } catch (e) {
    ui.toast(
      '保存失败：' +
        (String(e.message || e).includes('JSON') ? 'MCP 配置不是合法 JSON' : e.message || e),
      'error'
    )
  }
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

const defaultProvider = computed(
  () => settings.providers.find((p) => p.id === settings.settings.defaultProviderId) || null
)
</script>

<template>
  <div class="h-full flex min-w-0">
    <!-- 分组导航（F10）：任一分组一次点击可达 -->
    <nav
      class="w-[200px] shrink-0 border-r border-line-subtle bg-subtle p-3 space-y-1"
      aria-label="设置分组"
    >
      <div class="px-2 pb-2 text-sm font-semibold">设置</div>
      <button
        v-for="s in sections"
        :key="s.key"
        :data-testid="'settings-section-' + s.key"
        class="w-full h-10 rounded-lg px-3 text-left text-sm flex items-center"
        :class="
          section === s.key
            ? 'bg-brand-soft text-brand-ink font-medium'
            : 'text-ink-secondary hover:bg-surface'
        "
        :aria-current="section === s.key ? 'true' : undefined"
        @click="section = s.key"
      >
        {{ s.label }}
      </button>
    </nav>

    <div class="scroll-region flex-1 min-w-0">
      <div class="max-w-[960px] px-6 py-5 space-y-5">
        <div v-if="!settings.initialized" class="text-xs text-ink-muted" role="status">
          正在加载配置…
        </div>

        <!-- 模型服务 -->
        <section v-show="section === 'model'" class="space-y-4">
          <h2 class="text-base font-semibold">模型服务</h2>
          <p class="text-xs text-ink-muted">
            先添加供应商并保存，再添加 Key、拉取模型；会话默认使用这里的供应商与模型。
          </p>
          <div class="flex gap-3">
            <label class="flex-1">
              <span class="field-label">默认供应商</span>
              <select
                :value="settings.settings.defaultProviderId || ''"
                data-testid="default-provider"
                class="field-input"
                @change="settings.set('defaultProviderId', $event.target.value || null)"
              >
                <option value="">未设置</option>
                <option v-for="p in settings.providers" :key="p.id" :value="p.id">
                  {{ p.name }}
                </option>
              </select>
            </label>
            <label class="flex-1">
              <span class="field-label">默认模型</span>
              <select
                :value="settings.settings.defaultModel || ''"
                data-testid="default-model"
                class="field-input"
                @change="settings.set('defaultModel', $event.target.value || null)"
              >
                <option value="">未设置</option>
                <option
                  v-for="m in (defaultProvider || { models: [] }).models"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.id }}{{ m.vision ? '（视觉）' : '' }}
                </option>
              </select>
            </label>
          </div>

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
              </div>

              <div class="flex justify-end gap-2 pt-1">
                <button class="btn-secondary" data-testid="p-cancel" @click="closeEdit">
                  取消
                </button>
                <button
                  class="btn-primary !h-9"
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
              />
            </div>
            <div class="flex items-center gap-3">
              <span class="text-sm flex-1">划词问 AI</span>
              <input
                v-model="hotkeys.selection"
                aria-label="划词问 AI 快捷键"
                class="field-input !w-40"
              />
            </div>
            <div class="flex items-center gap-3">
              <span class="text-sm flex-1">截屏问 AI</span>
              <input
                v-model="hotkeys.capture"
                aria-label="截屏问 AI 快捷键"
                class="field-input !w-40"
              />
            </div>
          </div>
          <button
            class="btn-primary !h-9"
            data-testid="hotkey-save"
            :disabled="!settings.initialized"
            @click="saveHotkeys"
          >
            保存快捷键
          </button>
        </section>

        <!-- 智能任务 -->
        <section v-show="section === 'agent'" class="space-y-4">
          <h2 class="text-base font-semibold">智能任务安全</h2>
          <div class="space-y-3 max-w-2xl">
            <div>
              <span class="field-label">授权目录（智能任务文件工具的读写范围）</span>
              <div class="flex flex-wrap gap-1.5 mt-1.5">
                <span
                  v-for="d in agentDirs"
                  :key="d"
                  class="inline-flex items-center gap-1 px-2 h-8 rounded-lg bg-subtle text-xs"
                >
                  <span class="truncate max-w-[300px]" :title="d">{{ d }}</span>
                  <button
                    class="icon-btn-sm !w-5 !h-5"
                    :aria-label="'移除目录 ' + d"
                    @click="removeDir(d)"
                  >
                    <UiIcon name="close" :size="12" />
                  </button>
                </span>
                <button
                  class="btn-compact border border-dashed border-line-control"
                  @click="addDir"
                >
                  + 添加目录
                </button>
              </div>
            </div>
            <div class="max-w-md">
              <label class="block">
                <span class="field-label">最大步数</span>
                <input v-model="maxSteps" type="number" min="1" max="50" class="field-input" />
              </label>
              <p class="field-help mt-1">
                命令工作目录已移至会话页「项目」分组：每个项目可绑定独立目录，任务模式按会话所属项目执行命令。
              </p>
            </div>
            <div class="grid grid-cols-2 gap-3 max-w-md">
              <label>
                <span class="field-label">联网搜索通道</span>
                <select v-model="webSearchProvider" class="field-input">
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
                />
              </label>
            </div>
            <label class="block max-w-2xl">
              <span class="field-label">MCP 服务器配置（JSON，可选）</span>
              <textarea
                v-model="mcpServersJson"
                rows="3"
                placeholder='例如: {"docs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/docs"]}}'
                class="field-input font-mono text-xs"
              ></textarea>
            </label>
            <button
              class="btn-primary !h-9"
              data-testid="agent-save"
              :disabled="!settings.initialized"
              @click="saveAgent"
            >
              保存
            </button>
          </div>
        </section>

        <!-- 本地嵌入模型 -->
        <section v-show="section === 'models'" class="space-y-4">
          <h2 class="text-base font-semibold">本地嵌入模型</h2>
          <p class="text-xs text-ink-muted">
            知识库可用本地 ONNX 模型（onnxruntime + faiss）生成向量，全程离线、文档不出本机。
            量化版（int8）体积小速度快，非量化版（fp32）精度略高；下载后在「知识库 → 新建」中选择。
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
            Mini Agent v{{ settings.info.version }} · {{ settings.info.driver }} · 数据目录
            {{ settings.info.dataDir }}
          </div>
        </section>
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
