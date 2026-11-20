<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MessageItem from '../components/MessageItem.vue'
import ChatDetails from '../components/ChatDetails.vue'
import UiIcon from '../components/UiIcon.vue'
import UiDialog from '../components/UiDialog.vue'
import ConvRow from '../components/ConvRow.vue'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useKbStore } from '../stores/kb'
import { useUiStore } from '../stores/ui'
import { useProjectsStore } from '../stores/projects'

const chat = useChatStore()
const settings = useSettingsStore()
const kb = useKbStore()
const ui = useUiStore()
const projects = useProjectsStore()

const input = ref('')
const search = ref('')
const sending = ref(false)
const showKbPopover = ref(false)
const showMoreMenu = ref(false)
const editingTitleId = ref(null)
const scrollEl = ref(null)
const stickBottom = ref(true)
const vw = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)
let searchTimer = null

const conv = computed(() => chat.activeConv)
const streamingMsg = computed(() => chat.messages.find((m) => m.status === 'streaming'))
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
const activeProvider = computed(() => {
  const pid = conv.value && conv.value.providerId
  return (
    settings.providers.find((p) => p.id === pid) ||
    settings.providers.find((p) => p.id === settings.defaultProviderId) ||
    settings.enabledProviders[0] ||
    null
  )
})
const models = computed(() => (activeProvider.value && activeProvider.value.models) || [])
const activeModelId = computed(
  () =>
    (conv.value && conv.value.model) ||
    settings.settings.defaultModel ||
    (models.value[0] && models.value[0].id) ||
    ''
)
const convPolicy = computed(() => {
  if (!conv.value) return {}
  const p = conv.value.contextPolicy
  if (typeof p === 'string') {
    try {
      return JSON.parse(p || '{}')
    } catch {
      return {}
    }
  }
  return p || {}
})

// ---------- 滚动策略（F14）：贴底才自动跟随，历史阅读不被抢滚动 ----------
function scrollToBottom() {
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}
function onScroll() {
  const el = scrollEl.value
  stickBottom.value = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 60 : true
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

// ---------- 搜索（F03）：防抖 + 清空恢复，筛选不破坏当前会话 ----------
watch(search, (v) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => chat.setFilter(v), 300)
})
function clearSearch() {
  search.value = ''
  clearTimeout(searchTimer)
  chat.setFilter('')
}
function searchNow() {
  clearTimeout(searchTimer)
  chat.setFilter(search.value)
}

// ---------- 发送（F05/F06）：IME 守卫 + 发送锁 + 失败恢复草稿 ----------
async function send() {
  if (sending.value || chat.hasStreaming) return
  const content = input.value.trim()
  if (!content) return
  const atts = ui.pendingAttachment ? [{ type: 'image', dataUrl: ui.pendingAttachment }] : []
  sending.value = true
  ui.pendingAttachment = null
  input.value = ''
  try {
    await chat.send(content, atts)
    stickBottom.value = true
    await nextTick()
    scrollToBottom()
  } catch (e) {
    // 失败恢复：草稿和附件回到输入框（F06）
    input.value = content
    if (atts.length && !ui.pendingAttachment) ui.pendingAttachment = atts[0].dataUrl
    ui.toast('发送失败，内容已恢复到输入框', 'error')
  } finally {
    sending.value = false
  }
}
function onKeydown(e) {
  // 中文输入法组合期间 Enter 只确认候选，不发送（F05）
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
function stopStream() {
  if (streamingMsg.value) chat.stop(streamingMsg.value.id)
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
const savingProject = ref(false)
function openProjectDialog() {
  projectName.value = ''
  projectPath.value = ''
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
    const p = await projects.create({ name, path: dir })
    showProjectDialog.value = false
    collapsedProjects.value[p.id] = false
    ui.toast('项目已添加，新建会话将归入该项目', 'success')
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
async function removeProject(p) {
  const ok = await ui.confirm({
    title: '删除项目',
    message: `删除项目「${p.name}」？`,
    impact: '项目下的会话将移到「最近」，会话内容不受影响。',
    confirmText: '删除'
  })
  if (ok) await projects.remove(p.id)
}

// ---------- 会话设置 ----------
function setProvider(pid) {
  if (conv.value) chat.updateConv(conv.value.id, { providerId: pid || null, model: null })
}
function setModel(m) {
  if (conv.value) chat.updateConv(conv.value.id, { model: m || null })
}
function setField(field, value) {
  if (!conv.value) return
  const p = { ...convPolicy.value }
  if (value === '' || value == null) delete p[field]
  else p[field] = value
  chat.updateConv(conv.value.id, { contextPolicy: p })
}
function setPrompt(v) {
  if (conv.value) chat.updateConv(conv.value.id, { systemPrompt: v || null })
}
function setProject(v) {
  if (conv.value) chat.updateConv(conv.value.id, { projectId: v || null })
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

// ---------- 输入框自动增高（方案 6.1：最高 160px 后内部滚动） ----------
const inputEl = ref(null)
function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(160, el.scrollHeight) + 'px'
}

// ---------- 窗口宽度与详情停靠（F01：≥1360 且用户固定时停靠，否则抽屉） ----------
const detailsDocked = computed(() => ui.showDetails && ui.detailsPinned && vw.value >= 1360)
const detailsOverlay = computed(() => ui.showDetails && !detailsDocked.value)
function onResize() {
  vw.value = window.innerWidth
}
function onWindowKeydown(e) {
  if (e.key === 'Escape' && ui.showDetails && !ui.confirmState) ui.setShowDetails(false)
}
onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onWindowKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onWindowKeydown)
  clearTimeout(searchTimer)
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
</script>

<template>
  <div class="h-full flex min-w-0">
    <!-- 会话列表：可收起、可拖宽（F01） -->
    <aside
      v-show="ui.chatListVisible"
      class="shrink-0 flex flex-col border-r border-line-subtle bg-subtle"
      :style="{ width: ui.chatListWidth + 'px' }"
      aria-label="会话列表"
    >
      <div class="px-2.5 pt-3 pb-2">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm font-semibold flex-1">会话</span>
          <button
            class="btn-primary !h-8 !px-2.5 text-xs"
            data-testid="new-conv"
            @click="chat.create()"
          >
            <UiIcon name="plus" :size="14" />
            新建
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
            class="field-input !h-8 pl-8 pr-7 text-xs"
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
        <div v-if="chat.filtering" class="mt-1.5 text-xs text-ink-muted" aria-live="polite">
          {{ chat.visibleConversations.length }} 条匹配
          <template v-if="!chat.visibleConversations.length">· 无匹配会话</template>
        </div>
      </div>
      <div class="scroll-region flex-1 px-2 pb-2">
        <template v-if="pinnedConvs.length || !chat.filtering">
          <div class="px-1.5 pt-1 pb-1 text-xs text-ink-muted">置顶</div>
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
        <template v-if="projectGroups.length || !chat.filtering">
          <div class="px-1.5 pt-2 pb-1 text-xs text-ink-muted flex items-center justify-between">
            <span>项目</span>
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
              @dblclick.stop="startProjectRename(g.project)"
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
                  <button
                    class="icon-btn-sm !w-6 !h-6 hover:!text-red-500"
                    title="删除项目"
                    aria-label="删除项目"
                    @click.stop="removeProject(g.project)"
                  >
                    <UiIcon name="trash" :size="14" />
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
        <template v-if="unprojectedConvs.length">
          <div class="px-1.5 pt-2 pb-1 text-xs text-ink-muted">最近</div>
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

    <!-- 聊天主区 -->
    <section class="flex-1 min-w-0 flex flex-col">
      <!-- 页头：列表开关 / 标题 / 生效模型 / 会话设置 / 更多（方案 5.3） -->
      <header
        class="shrink-0 h-14 flex items-center gap-2 px-4 border-b border-line-subtle bg-canvas"
      >
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
        <button v-if="!hasService" class="btn-secondary !h-8 text-xs" @click="ui.view = 'settings'">
          配置服务
        </button>
        <button
          class="btn-secondary !h-8 text-xs"
          :disabled="!conv"
          :aria-expanded="ui.showDetails"
          @click="ui.setShowDetails(!ui.showDetails)"
        >
          <UiIcon name="panelRight" :size="16" />
          会话设置
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
      </header>

      <!-- 消息区：单滚动容器 + 回到底部（F14） -->
      <div class="relative flex-1 min-h-0">
        <div
          ref="scrollEl"
          class="absolute inset-0 overflow-y-auto px-4 md:px-6 py-4"
          @scroll.passive="onScroll"
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

      <!-- 输入区（方案 6.1） -->
      <div class="shrink-0 border-t border-line-subtle bg-subtle px-4 py-3 space-y-2">
        <div v-if="ui.pendingAttachment" class="flex items-center gap-2 text-xs">
          <img
            :src="ui.pendingAttachment"
            class="h-10 rounded-lg border border-line-control"
            alt="截图附件"
          />
          <span class="text-ink-secondary">截图附件</span>
          <button class="text-red-600 hover:underline" @click="ui.pendingAttachment = null">
            移除
          </button>
        </div>
        <div class="flex items-center gap-2 text-xs flex-wrap">
          <button
            class="btn-compact border"
            :class="
              showKbPopover
                ? 'border-brand text-brand-ink bg-brand-soft'
                : 'border-line-control text-ink-secondary bg-surface hover:bg-subtle'
            "
            data-testid="kb-chip"
            :aria-expanded="showKbPopover"
            @click="showKbPopover = !showKbPopover"
          >
            <UiIcon name="kb" :size="14" />
            知识库<span v-if="chat.selectedKbIds.length">({{ chat.selectedKbIds.length }})</span>
          </button>
          <button
            class="btn-compact border"
            :class="
              chat.agentMode
                ? 'border-brand text-brand-ink bg-brand-soft'
                : 'border-line-control text-ink-secondary bg-surface hover:bg-subtle'
            "
            title="开启后发送内容将作为智能任务执行；涉及写入的操作会先请求确认"
            data-testid="agent-toggle"
            :aria-pressed="chat.agentMode"
            @click="chat.agentMode = !chat.agentMode"
          >
            <UiIcon name="agent" :size="14" />
            任务模式
          </button>
          <span v-if="chat.selectedKbIds.length" class="text-ink-muted">
            将检索
            {{
              kb.kbs
                .filter((k) => chat.selectedKbIds.includes(k.id))
                .map((k) => k.name)
                .join('、')
            }}
          </span>
          <span v-if="chat.agentMode" class="text-ink-muted"
            >可调用工具，涉及写入的操作将请求确认</span
          >
        </div>
        <div
          v-if="showKbPopover"
          class="rounded-lg border border-line-subtle bg-surface p-2.5 text-xs space-y-1.5 max-h-40 overflow-y-auto"
        >
          <div v-if="!kb.kbs.length" class="text-ink-muted">还没有知识库，到「知识库」页创建</div>
          <label
            v-for="k in kb.kbs"
            :key="k.id"
            class="flex items-center gap-2 cursor-pointer min-h-[28px]"
          >
            <input
              type="checkbox"
              :checked="chat.selectedKbIds.includes(k.id)"
              @change="toggleKb(k.id)"
            />
            <span>{{ k.name }}</span>
            <span class="text-ink-muted">{{
              k.stats ? k.stats.docs + ' 文档 · ' + k.stats.chunks + ' 分块' : ''
            }}</span>
          </label>
        </div>
        <div class="flex items-end gap-2">
          <textarea
            ref="inputEl"
            v-model="input"
            rows="2"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            aria-label="消息输入框"
            data-testid="chat-input"
            class="field-area flex-1 max-h-40"
            @keydown="onKeydown"
            @input="autoGrow"
          />
          <button
            v-if="chat.hasStreaming"
            class="btn h-10 px-4 rounded-lg text-sm bg-red-700 hover:bg-red-800 text-white"
            data-testid="chat-stop"
            @click="stopStream"
          >
            <UiIcon name="stop" :size="16" />
            停止
          </button>
          <button
            v-else
            class="btn-primary"
            :disabled="!input.trim() || sending"
            data-testid="chat-send"
            @click="send"
          >
            {{ sending ? '发送中…' : chat.agentMode ? '开始任务' : '发送' }}
          </button>
        </div>
      </div>
    </section>

    <!-- 会话设置：默认收起；宽窗可停靠，窄窗覆盖抽屉（F01） -->
    <aside
      v-if="detailsDocked"
      class="w-80 shrink-0 border-l border-line-subtle bg-subtle overflow-y-auto p-4 text-sm"
      aria-label="会话设置"
    >
      <ChatDetails
        :conv="conv"
        :providers="settings.providers"
        :models="models"
        :policy="convPolicy"
        :projects="projects.projects"
        :docked="true"
        :details-pinned="ui.detailsPinned"
        @set-provider="setProvider"
        @set-model="setModel"
        @set-prompt="setPrompt"
        @set-project="setProject"
        @set-field="setField"
        @export="exportConv"
        @unpin="ui.setDetailsPinned(false)"
      />
    </aside>
    <!-- 覆盖式抽屉：容器不拦截点击，仅面板可交互（非模态，方案 §4.3） -->
    <div
      v-if="detailsOverlay"
      class="fixed inset-0 z-40 flex justify-end pointer-events-none"
      aria-label="会话设置抽屉"
    >
      <div
        class="pointer-events-auto w-80 max-w-[85vw] h-full border-l border-line-subtle bg-subtle overflow-y-auto p-4 text-sm shadow-modal"
      >
        <ChatDetails
          :conv="conv"
          :providers="settings.providers"
          :models="models"
          :policy="convPolicy"
          :projects="projects.projects"
          :docked="false"
          :details-pinned="ui.detailsPinned"
          :can-pin="vw >= 1360"
          @close="ui.setShowDetails(false)"
          @set-provider="setProvider"
          @set-model="setModel"
          @set-prompt="setPrompt"
          @set-project="setProject"
          @set-field="setField"
          @export="exportConv"
          @pin="ui.setDetailsPinned(true)"
        />
      </div>
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
  </div>
</template>
