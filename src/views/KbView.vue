<script setup>
import { computed, ref } from 'vue'
import StatusBadge from '../components/StatusBadge.vue'
import UiDialog from '../components/UiDialog.vue'
import UiIcon from '../components/UiIcon.vue'
import RowMenu from '../components/RowMenu.vue'
import { useKbStore } from '../stores/kb'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

const kb = useKbStore()
const settings = useSettingsStore()
const ui = useUiStore()

const showCreate = ref(false)
const form = ref({ name: '', embedSource: 'local', embedProviderId: '', embedModel: '' })
const localPick = ref('') // `${model}|${quant}`：本地模型包选择
const activeTab = ref('docs')
const searchText = ref('')
const searching = ref(false)
const expanded = ref({}) // chunkId -> 全文展开

const downloadedPackages = computed(() => settings.downloadedModels)
const canCreate = computed(() => {
  if (!form.value.name.trim()) return false
  if (form.value.embedSource === 'local') return !!localPick.value
  return true
})

async function openCreate() {
  form.value = { name: '', embedSource: 'local', embedProviderId: '', embedModel: '' }
  await settings.loadModels()
  // 默认选第一个已下载的包（目录顺序 small int8 在前）
  if (settings.downloadedModels.length) {
    const p = settings.downloadedModels[0]
    localPick.value = `${p.model}|${p.quant}`
    form.value.embedModel = p.model
    form.value.embedQuant = p.quant
  } else {
    localPick.value = ''
    // 没有本地包时默认走远程，避免建完不能用的库
    form.value.embedSource = 'remote'
  }
  showCreate.value = true
}
function onLocalPick() {
  const [model, quant] = localPick.value.split('|')
  form.value.embedModel = model || ''
  form.value.embedQuant = quant || 'fp32'
}
async function createKb() {
  if (!form.value.name.trim()) return
  try {
    const f = form.value
    const payload =
      f.embedSource === 'local'
        ? {
            name: f.name.trim(),
            embedSource: 'local',
            embedModel: f.embedModel,
            embedQuant: f.embedQuant || 'fp32'
          }
        : {
            name: f.name.trim(),
            embedSource: 'remote',
            embedProviderId: f.embedProviderId || null,
            embedModel: f.embedModel.trim() || null
          }
    await kb.create(payload)
    showCreate.value = false
    ui.toast('知识库已创建，可导入文档', 'success')
  } catch (e) {
    ui.toast('创建失败：' + String((e && e.message) || e), 'error')
  }
}

async function importDocs() {
  if (!kb.activeKbId) return
  const paths = await window.api.dialog.pickFiles({
    filters: [{ name: '文档', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] }]
  })
  if (paths && paths.length) kb.importDocs(paths)
}

async function runSearch() {
  if (!searchText.value.trim() || !kb.activeKbId) return
  searching.value = true
  expanded.value = {}
  try {
    await kb.search(searchText.value.trim())
  } catch (e) {
    ui.toast('检索失败：' + String((e && e.message) || e), 'error')
  } finally {
    searching.value = false
  }
}

async function removeKb(k) {
  const ok = await ui.confirm({
    title: '删除知识库',
    message: `删除知识库「${k.name}」？`,
    impact: '库内的文档索引与分块数据将一并移除，当前版本暂不支持从界面恢复。',
    confirmText: '删除'
  })
  if (ok) await kb.remove(k.id)
}
// 知识库行「…」菜单
function kbMenuItems(k) {
  return [{ id: 'remove', label: '删除', icon: 'trash', danger: true, onSelect: () => removeKb(k) }]
}

async function removeDoc(d) {
  const ok = await ui.confirm({
    title: '删除文档',
    message: `从当前知识库删除「${d.title}」？`,
    impact: '该文档的分块与向量数据将一并清理。',
    confirmText: '删除'
  })
  if (!ok) return
  try {
    await kb.removeDoc(d.id)
    ui.toast('文档已删除', 'success')
  } catch (e) {
    ui.toast('删除失败：' + String((e && e.message) || e), 'error')
  }
}

const kbStats = computed(() => {
  const k = kb.activeKb
  if (!k || !k.stats) return ''
  return `${k.stats.docs} 文档 · ${k.stats.chunks} 分块`
})

// 嵌入来源标识：本地 onnx 模型显示量化档位，远程显示模型名
const embedLabel = computed(() => {
  const k = kb.activeKb
  if (!k) return ''
  if (k.embedSource === 'local') {
    return `${k.embedModel || '未配置'}·${k.embedQuant === 'int8' ? '量化' : '非量化'}（本地）`
  }
  return `${k.embedModel || '未配置'}（远程）`
})

const results = computed(() => kb.activeSearchResults)
const hasSearched = computed(() => !!kb.lastSearch && kb.lastSearch.kbId === kb.activeKbId)
</script>

<template>
  <div class="h-full flex min-w-0 bg-panel">
    <!-- 侧栏只保留列表与入口，创建放入对话框（F15） -->
    <aside
      class="shrink-0 flex flex-col bg-panel"
      :style="{ width: ui.chatListWidth + 'px' }"
      aria-label="知识库列表"
    >
      <div class="px-3 pt-3 pb-2 flex items-center gap-2 bg-panel">
        <span class="text-base font-semibold text-ink-primary flex-1">知识库</span>
        <button
          class="icon-btn !h-8 !w-8 border border-line-subtle bg-panel"
          data-testid="kb-create-open"
          title="新建知识库"
          aria-label="新建知识库"
          @click="openCreate"
        >
          <UiIcon name="plus" :size="16" />
        </button>
      </div>
      <div class="px-2.5 pb-2 bg-panel">
        <div class="relative">
          <UiIcon
            name="search"
            :size="16"
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
          />
          <input
            v-model="kb.filterText"
            placeholder="筛选知识库…"
            aria-label="筛选知识库"
            class="field-input !bg-panel !h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <div class="scroll-region flex-1 px-2 pb-2 space-y-1 bg-panel">
        <div
          v-for="k in kb.visibleKbs"
          :key="k.id"
          tabindex="0"
          role="button"
          class="list-row group !min-h-[44px]"
          :class="k.id === kb.activeKbId ? 'bg-brand-soft text-brand-ink' : 'hover:bg-surface'"
          :aria-current="k.id === kb.activeKbId ? 'true' : undefined"
          @click="kb.select(k.id)"
          @keydown.enter.prevent="kb.select(k.id)"
        >
          <span class="flex-1 truncate" :title="k.name">{{ k.name }}</span>
          <span class="text-xs text-ink-muted shrink-0">
            {{ k.stats ? `${k.stats.docs} 文档` : '' }}
          </span>
          <RowMenu :items="kbMenuItems(k)" label="知识库操作" />
        </div>
        <div v-if="!kb.visibleKbs.length" class="px-3 py-6 text-center text-xs text-ink-muted">
          还没有知识库，点击「新建」创建
        </div>
      </div>
    </aside>

    <section class="flex-1 min-w-0 flex flex-col m-3 chat-surface overflow-hidden">
      <template v-if="kb.activeKb">
        <!-- 页头 -->
        <header class="shrink-0 px-5 py-3.5 bg-surface flex items-center gap-3 flex-wrap">
          <div class="min-w-0">
            <h2 class="text-lg font-semibold truncate">{{ kb.activeKb.name }}</h2>
            <div class="text-xs text-ink-muted">
              {{ kbStats }} · 向量 {{ embedLabel }} · 维度 {{ kb.activeKb.dim || '-' }}
            </div>
          </div>
          <div class="flex-1" />
          <button class="btn-primary !h-9" data-testid="kb-import" @click="importDocs">
            <UiIcon name="file" :size="16" />
            导入文档
          </button>
          <button class="btn-secondary" @click="kb.rebuild()">
            <UiIcon name="refresh" :size="16" />
            重建索引
          </button>
        </header>

        <div class="scroll-region flex-1 px-5 py-4 space-y-4 bg-surface">
          <!-- 导入进度 -->
          <div v-if="kb.progress && !kb.progress.done" class="text-xs">
            <div class="flex justify-between mb-1 text-ink-secondary">
              <span class="truncate">{{ kb.progress.path }}</span>
              <span
                >{{ kb.progress.current }}/{{ kb.progress.total }} {{ kb.progress.status }}</span
              >
            </div>
            <div class="h-1.5 rounded bg-subtle overflow-hidden">
              <div
                class="h-full bg-brand transition-all"
                :style="{
                  width:
                    Math.round(
                      ((kb.progress.current || 0) / Math.max(1, kb.progress.total)) * 100
                    ) + '%'
                }"
              />
            </div>
            <div v-if="kb.progress.detail" class="mt-1 text-ink-muted">
              {{ kb.progress.detail }}
            </div>
          </div>

          <!-- 标签页：文档 / 检索测试（F16） -->
          <div
            class="flex gap-1 border-b border-line-subtle"
            role="tablist"
            aria-label="知识库内容"
          >
            <button
              v-for="t in [
                { key: 'docs', label: '文档' },
                { key: 'search', label: '检索测试' }
              ]"
              :key="t.key"
              role="tab"
              class="h-10 px-4 text-sm border-b-2 -mb-px"
              :class="
                activeTab === t.key
                  ? 'border-brand text-brand-ink font-medium'
                  : 'border-transparent text-ink-secondary hover:text-ink-primary'
              "
              :aria-selected="activeTab === t.key"
              @click="activeTab = t.key"
            >
              {{ t.label }}
            </button>
          </div>

          <!-- 文档表 -->
          <div v-show="activeTab === 'docs'" class="card overflow-hidden">
            <table class="w-full text-sm">
              <thead class="bg-subtle text-ink-secondary">
                <tr>
                  <th class="text-left px-3 py-2 font-medium">文档</th>
                  <th class="text-left px-3 py-2 font-medium w-24">状态</th>
                  <th class="text-left px-3 py-2 font-medium w-20">分块</th>
                  <th class="text-left px-3 py-2 font-medium">说明</th>
                  <th class="w-12"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!kb.docs.length">
                  <td colspan="5" class="px-3 py-8 text-center text-ink-muted">
                    还没有文档，点击「导入文档」添加 pdf / docx / md / txt
                  </td>
                </tr>
                <tr v-for="d in kb.docs" :key="d.id" class="border-t border-line-subtle">
                  <td class="px-3 py-2.5 max-w-[280px]">
                    <span class="truncate block" :title="d.path">{{ d.title }}</span>
                  </td>
                  <td class="px-3 py-2.5"><StatusBadge :status="d.status" /></td>
                  <td class="px-3 py-2.5">{{ d.chunkCount }}</td>
                  <td class="px-3 py-2.5 text-ink-muted max-w-[220px]">
                    <span class="truncate block" :title="d.error">{{ d.error || '' }}</span>
                  </td>
                  <td class="px-3 py-2.5 text-right">
                    <button
                      class="icon-btn-sm !w-7 !h-7 hover:!text-red-500"
                      title="删除文档"
                      :aria-label="'删除文档 ' + d.title"
                      @click="removeDoc(d)"
                    >
                      <UiIcon name="trash" :size="14" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 检索测试 -->
          <div v-show="activeTab === 'search'" class="space-y-3">
            <div class="flex gap-2">
              <input
                v-model="searchText"
                placeholder="输入问题测试检索效果…"
                aria-label="检索测试问题"
                class="field-input flex-1"
                @keydown.enter="runSearch"
              />
              <button class="btn-secondary" :disabled="searching" @click="runSearch">
                {{ searching ? '检索中…' : '检索' }}
              </button>
            </div>

            <div v-if="!hasSearched" class="text-xs text-ink-muted py-4">
              输入问题后点「检索」，查看该知识库的命中片段。
            </div>
            <div v-else class="text-xs text-ink-muted" aria-live="polite">
              「{{ kb.lastSearch.query }}」命中 {{ results.length }} 条
              <template v-if="!results.length"
                >· 没有匹配的内容，试试换一种问法或减少关键词</template
              >
            </div>

            <div
              v-for="r in results"
              :key="r.chunkId"
              class="p-3 rounded-xl bg-subtle text-sm space-y-1"
            >
              <div class="text-xs text-ink-secondary flex items-center gap-2">
                <UiIcon name="file" :size="13" class="shrink-0" />
                <span class="truncate">{{ r.title }}</span>
                <template v-if="r.headingPath"
                  ><span class="truncate">› {{ r.headingPath }}</span></template
                >
                <span class="ml-auto shrink-0 text-brand-ink">相关度 {{ r.score }}</span>
              </div>
              <div
                class="text-ink-primary whitespace-pre-wrap"
                :class="expanded[r.chunkId] ? '' : 'line-clamp-4'"
              >
                {{ r.text }}
              </div>
              <button
                class="text-xs text-link hover:underline"
                @click="expanded[r.chunkId] = !expanded[r.chunkId]"
              >
                {{ expanded[r.chunkId] ? '收起' : '展开全文' }}
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 空态 -->
      <div v-else class="h-full flex items-center justify-center text-ink-muted">
        <div class="text-center">
          <div class="text-base text-ink-secondary mb-3">选择左侧知识库，或创建一个新的</div>
          <button class="btn-secondary !bg-panel" @click="openCreate">新建知识库</button>
        </div>
      </div>
    </section>

    <!-- 创建对话框（F15）：持久标签 + 字段说明 -->
    <UiDialog :open="showCreate" title="新建知识库" width="480px" @close="showCreate = false">
      <div class="space-y-4">
        <label class="block">
          <span class="field-label">名称</span>
          <input
            v-model="form.name"
            data-testid="kb-name"
            placeholder="例如：产品手册"
            class="field-input"
            @keydown.enter="createKb"
          />
        </label>
        <div class="block">
          <span class="field-label">嵌入方式</span>
          <div class="flex gap-4 text-sm min-h-[36px] items-center">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                value="local"
                v-model="form.embedSource"
                data-testid="kb-embed-local"
              />
              <span>本地模型（离线）</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                value="remote"
                v-model="form.embedSource"
                data-testid="kb-embed-remote"
              />
              <span>远程 Embedding 服务</span>
            </label>
          </div>
          <span class="field-help">本地模型文档不出本机；远程走 OpenAI 兼容 /embeddings</span>
        </div>
        <template v-if="form.embedSource === 'local'">
          <label class="block">
            <span class="field-label">本地模型包</span>
            <select
              v-model="localPick"
              data-testid="kb-local-model"
              class="field-input"
              @change="onLocalPick"
            >
              <option value="" disabled>请选择已下载的模型</option>
              <option v-for="p in downloadedPackages" :key="p.id" :value="`${p.model}|${p.quant}`">
                {{ p.model }}（{{ p.quant === 'int8' ? '量化' : '非量化' }} · {{ p.dim }} 维）
              </option>
            </select>
            <span v-if="!downloadedPackages.length" class="field-help text-warn-ink">
              还没有已下载的本地模型，请到「设置 → 本地嵌入模型」一键下载。
            </span>
            <span v-else class="field-help">查询侧会自动加 BGE 检索指令前缀</span>
          </label>
        </template>
        <template v-else>
          <label class="block">
            <span class="field-label">向量服务</span>
            <select v-model="form.embedProviderId" data-testid="kb-provider" class="field-input">
              <option value="">未配置（可稍后在模型服务中设置）</option>
              <option v-for="p in settings.providers" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
            <span class="field-help">提供 Embedding 接口的供应商</span>
          </label>
          <label class="block">
            <span class="field-label">Embedding 模型</span>
            <input
              v-model="form.embedModel"
              placeholder="Embedding 模型名（如 text-embedding-3-small）"
              class="field-input"
            />
            <span class="field-help">需与所选服务支持的模型一致</span>
          </label>
          <div
            v-if="!settings.providers.length"
            class="text-xs text-warn-ink flex items-start gap-1"
          >
            <UiIcon name="warn" :size="14" class="mt-0.5 shrink-0" />
            <span>还没有任何供应商，请先到「设置 → 模型服务」添加。</span>
          </div>
        </template>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showCreate = false">取消</button>
        <button class="btn-primary" :disabled="!canCreate" @click="createKb">创建知识库</button>
      </template>
    </UiDialog>
  </div>
</template>
