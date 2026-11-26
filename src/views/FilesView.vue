<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from '../components/UiIcon.vue'
import { useUiStore } from '../stores/ui'

// 工作区文件：左侧目录浏览，右侧纯文本编辑与保存。
// 可访问范围由主进程限制在项目工作目录与 Agent 授权目录内。
const ui = useUiStore()
const roots = ref([])
const rootId = ref('')
const dir = ref('')
const entries = ref([])
const loading = ref(false)
const error = ref('')
const filePath = ref('')
const content = ref('')
const original = ref('')
const saving = ref(false)
let offProjects = null

const root = computed(() => roots.value.find((r) => r.id === rootId.value) || null)
const dirty = computed(() => !!filePath.value && content.value !== original.value)
const relPath = computed(() => {
  if (!filePath.value || !root.value) return ''
  return filePath.value.slice(root.value.path.length).replace(/^[\\/]/, '')
})
const canGoUp = computed(() => {
  if (!root.value || !dir.value) return false
  return dir.value.length > root.value.path.length
})

async function loadRoots() {
  try {
    const list = await window.api.workspace.roots()
    roots.value = list
    if (!rootId.value && list.length) {
      rootId.value = list[0].id
      await openDir(list[0].path)
    }
  } catch (e) {
    error.value = String((e && e.message) || e)
  }
}

async function openDir(p) {
  if (!p) return
  loading.value = true
  error.value = ''
  try {
    entries.value = await window.api.workspace.list(p)
    dir.value = p
  } catch (e) {
    error.value = String((e && e.message) || e)
    entries.value = []
  } finally {
    loading.value = false
  }
}

function switchRoot() {
  filePath.value = ''
  content.value = ''
  original.value = ''
  if (root.value) openDir(root.value.path)
}

function upDir() {
  if (!canGoUp.value) return
  const parent = dir.value.replace(/[\\/][^\\/]+$/, '')
  if (parent.length < root.value.path.length) return
  openDir(parent)
}

async function openEntry(entry) {
  if (entry.dir) return openDir(entry.path)
  try {
    const r = await window.api.workspace.read(entry.path)
    filePath.value = entry.path
    content.value = r.content
    original.value = r.content
  } catch (e) {
    ui.toast('打开文件失败：' + String((e && e.message) || e), 'error')
  }
}

async function save() {
  if (!filePath.value || saving.value) return
  saving.value = true
  try {
    await window.api.workspace.write(filePath.value, content.value)
    original.value = content.value
    ui.toast('已保存', 'success')
  } catch (e) {
    ui.toast('保存失败：' + String((e && e.message) || e), 'error')
  } finally {
    saving.value = false
  }
}

function onEditorKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
    e.preventDefault()
    save()
  }
}

onMounted(() => {
  loadRoots()
  offProjects = window.api.on('projects:changed', () => {
    rootId.value = ''
    loadRoots()
  })
})
onBeforeUnmount(() => {
  if (offProjects) offProjects()
})
</script>

<template>
  <section class="flex-1 min-w-0 flex m-3 chat-surface overflow-hidden" data-testid="files-view">
    <aside class="w-64 shrink-0 flex flex-col border-r border-line-subtle bg-panel">
      <div class="shrink-0 p-3 border-b border-line-subtle space-y-1.5">
        <select
          v-model="rootId"
          class="field-input !h-8 text-xs"
          aria-label="选择工作区"
          data-testid="files-root"
          @change="switchRoot"
        >
          <option v-for="r in roots" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <div class="text-[11px] text-ink-muted break-all">{{ dir || '未选择工作区' }}</div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-2">
        <div v-if="!roots.length" class="p-3 text-xs text-ink-muted">
          还没有项目工作目录，请先在「会话」页添加项目。
        </div>
        <button v-if="canGoUp" class="list-row !min-h-[32px] text-xs" @click="upDir">
          <UiIcon name="chevronLeft" :size="14" class="shrink-0 text-ink-muted" />
          返回上级
        </button>
        <button
          v-for="e in entries"
          :key="e.path"
          class="list-row !min-h-[32px] text-xs"
          :title="e.path"
          @click="openEntry(e)"
        >
          <UiIcon
            :name="e.dir ? 'folder' : 'file'"
            :size="14"
            class="shrink-0"
            :class="e.dir ? 'text-brand-ink/80' : 'text-ink-muted'"
          />
          <span class="truncate">{{ e.name }}</span>
        </button>
        <div v-if="loading" class="p-3 text-xs text-ink-muted">加载中…</div>
        <div v-else-if="error" class="p-3 text-xs text-bad-ink break-all">{{ error }}</div>
        <div v-else-if="roots.length && !entries.length" class="p-3 text-xs text-ink-muted">
          空目录
        </div>
      </div>
    </aside>

    <div class="flex-1 min-w-0 flex flex-col bg-surface">
      <header class="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-line-subtle">
        <UiIcon name="file" :size="15" class="text-ink-muted" />
        <span class="text-xs truncate flex-1" :title="filePath">{{ relPath || '未打开文件' }}</span>
        <span v-if="dirty" class="badge bg-warn text-warn-ink">未保存</span>
        <button
          class="btn-compact !h-7 !px-3 text-xs"
          :disabled="!dirty || saving"
          data-testid="files-save"
          @click="save"
        >
          {{ saving ? '保存中' : '保存' }}
        </button>
      </header>
      <textarea
        v-if="filePath"
        v-model="content"
        class="flex-1 min-h-0 w-full resize-none bg-surface p-4 font-mono text-xs leading-relaxed outline-none"
        spellcheck="false"
        aria-label="文件内容"
        data-testid="files-editor"
        @keydown="onEditorKeydown"
      />
      <div v-else class="flex-1 grid place-items-center text-sm text-ink-muted">
        从左侧选择一个文件开始编辑
      </div>
    </div>
  </section>
</template>
