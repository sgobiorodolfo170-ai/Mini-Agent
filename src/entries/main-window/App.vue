<script setup>
import { onMounted, ref } from 'vue'
import { useUiStore } from '../../stores/ui'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { useKbStore } from '../../stores/kb'
import { useAgentStore } from '../../stores/agent'
import { useProjectsStore } from '../../stores/projects'
import { useSessionsStore } from '../../stores/sessions'
import { useUpdaterStore } from '../../stores/updater'
import ChatView from '../../views/ChatView.vue'
import KbView from '../../views/KbView.vue'
import AgentView from '../../views/AgentView.vue'
import SettingsView from '../../views/SettingsView.vue'
import ConfirmCard from '../../components/ConfirmCard.vue'
import ConfirmDialog from '../../components/ConfirmDialog.vue'
import UpdateDialog from '../../components/UpdateDialog.vue'
import UiIcon from '../../components/UiIcon.vue'
import RemotePanel from '../../components/remote/RemotePanel.vue'
import { useRemoteStore } from '../../stores/remote'

const ui = useUiStore()
const chat = useChatStore()
const settings = useSettingsStore()
const kb = useKbStore()
const agent = useAgentStore()
const projects = useProjectsStore()
const sessions = useSessionsStore()
const updater = useUpdaterStore()
const remote = useRemoteStore()
const updateOpen = ref(false)

const navs = [
  { key: 'chat', icon: 'chat', label: '会话' },
  { key: 'kb', icon: 'kb', label: '知识库' },
  { key: 'agent', icon: 'terminal', label: '执行' },
  { key: 'remote', icon: 'monitor', label: '远程' },
  { key: 'settings', icon: 'settings', label: '设置' }
]

const themeLabel = { dark: '深色', light: '浅色', system: '跟随系统' }
const toastIcon = { error: 'warn', warn: 'warn', success: 'check' }
const toastCls = {
  error: 'bg-bad text-bad-ink border-red-500/30',
  warn: 'bg-warn text-warn-ink border-amber-500/30',
  success: 'bg-ok text-ok-ink border-emerald-500/30',
  info: 'bg-elevated text-ink-primary border-line-subtle'
}

onMounted(async () => {
  window.api.on('chat:event', (ev) => {
    chat.handleEvent(ev)
    if (ev.type === 'notice') ui.toast(ev.message)
    if (ev.type === 'error') ui.toast('请求失败：' + (ev.message || ''), 'error')
  })
  window.api.on('keys:event', () => settings.reloadProviders())
  window.api.on('projects:changed', async () => {
    // 项目增删改会改变会话归属（删除项目时会话回归「最近」），两边列表都要刷新
    await Promise.all([chat.loadConversations(), projects.load()])
  })
  window.api.on('kb:progress', (p) => kb.handleProgress(p))
  if (window.api.models) window.api.on('models:progress', (p) => settings.handleModelsProgress(p))
  window.api.on('agent:event', (ev) => agent.handleEvent(ev))
  window.api.on('updater:changed', (s) => updater.apply(s))
  if (window.api.remote) window.api.on('remote:changed', (s) => remote.apply(s))
  window.api.on('agent:confirm', (c) => agent.pushConfirm(c))
  window.api.on('agent:confirmCancel', (c) => agent.clearConfirms(c || {}))
  window.api.on('agent:confirmTimeout', (c) => {
    agent.clearConfirms({ requestId: c && c.requestId })
    ui.toast('确认请求超时已自动拒绝', 'warn')
  })
  window.api.on('app:notice', (n) => ui.toast(n.message, n.level || 'info'))
  window.api.on('app:route', (r) => ui.goChat(r.conversationId))
  window.api.on('chat:attachment', (a) => {
    ui.pendingAttachment = a.dataUrl
    ui.view = 'chat'
  })
  window.api.on('data:changed', async () => {
    await Promise.all([
      chat.loadConversations(),
      kb.load(),
      settings.reloadProviders(),
      agent.loadRuns(),
      projects.load(),
      sessions.load()
    ])
  })
  // 子会话看板：运行开始/结束与会话创建都刷新，保证「Agent 派生的会话」即时可见
  window.api.on('agent:event', (ev) => {
    if (ev && (ev.type === 'started' || ev.type === 'done')) sessions.load()
  })
  window.api.on('hotkeys:report', (rep) => {
    const bad = Object.entries(rep || {}).filter(([_k, v]) => !v.ok)
    if (bad.length) ui.toast('快捷键注册失败：' + bad.map(([k]) => k).join('、'), 'warn')
  })

  // 自绘标题栏：同步最大化状态（拖拽任务栏预览/系统手势触发时按钮图标也要跟着变）
  if (window.api.window) {
    await refreshMaximized()
    window.api.on('window:maximized', (v) => {
      isMaximized.value = !!v
    })
  }

  await ui.init()
  await settings.init()
  await updater.init()
  await chat.loadConversations()
  await kb.load()
  await agent.loadRuns()
  await projects.load()
  await sessions.load()
  // 主窗启动后按 3s 轮询子会话状态：事件在窗口隐藏/重载期间不可见，
  // 轮询保证恢复后状态仍与主进程一致（仅内存查询，不触网）
  sessions.startPolling(3000)
  await settings.loadModels()
  if (chat.conversations.length) chat.select(chat.conversations[0].id)
})

function cycleTheme() {
  const order = ['dark', 'light', 'system']
  ui.setTheme(order[(order.indexOf(ui.theme) + 1) % 3])
}

// 点开更新入口时才做一次强制检查（拿到最新落后提交数），并打开详情。
async function openUpdate() {
  updateOpen.value = true
  await updater.check(true)
}

// ---- 自绘标题栏（frame:false 后由渲染层接管系统标题栏） ----
const isMaximized = ref(false)
const winControlsReady = ref(!!(window.api && window.api.window))

async function refreshMaximized() {
  try {
    isMaximized.value = !!(await window.api.window.isMaximized())
  } catch {
    isMaximized.value = false
  }
}

function onWindowControl(err) {
  // 控制按钮操作失败不应影响主界面；记录 toast 便于发现（如桥未就绪）
  if (err) ui.toast('窗口操作失败', 'error')
}

async function minimizeWindow() {
  try {
    await window.api.window.minimize()
  } catch (e) {
    onWindowControl(e)
  }
}

async function toggleMaximize() {
  try {
    await window.api.window.toggleMaximize()
    await refreshMaximized()
  } catch (e) {
    onWindowControl(e)
  }
}

// 关闭按钮即「隐藏到托盘」：主进程 close 拦截会 hide，与系统行为一致
async function closeWindowToTray() {
  try {
    await window.api.window.hide()
  } catch (e) {
    onWindowControl(e)
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- 自绘标题栏：背景同左侧栏（bg-panel 浅灰白），可拖拽移动窗口；
         右侧最小化/最大化/关闭均为 no-drag，关闭=隐藏到托盘（与系统关闭行为一致） -->
    <div
      data-testid="title-bar"
      class="h-10 shrink-0 flex items-center bg-panel select-none"
      style="-webkit-app-region: drag"
      @dblclick="toggleMaximize"
    >
      <div class="flex items-center gap-2 pl-3 min-w-0">
        <UiIcon name="agent" :size="15" class="text-brand-ink shrink-0" />
        <span class="text-xs font-medium text-ink-secondary truncate">Mini Agent</span>
      </div>
      <div class="flex-1" />
      <div class="flex items-stretch h-full" style="-webkit-app-region: no-drag">
        <button
          class="w-11 flex items-center justify-center text-ink-secondary hover:bg-subtle hover:text-ink-primary"
          title="最小化"
          aria-label="最小化窗口"
          @click="minimizeWindow"
        >
          <UiIcon name="winMinimize" :size="14" />
        </button>
        <button
          v-if="winControlsReady"
          class="w-11 flex items-center justify-center text-ink-secondary hover:bg-subtle hover:text-ink-primary"
          :title="isMaximized ? '还原' : '最大化'"
          :aria-label="isMaximized ? '还原窗口' : '最大化窗口'"
          @click="toggleMaximize"
        >
          <UiIcon :name="isMaximized ? 'winRestore' : 'winMaximize'" :size="13" />
        </button>
        <button
          class="w-11 flex items-center justify-center text-ink-secondary hover:bg-red-500 hover:text-white"
          title="关闭"
          aria-label="关闭窗口（隐藏到托盘）"
          @click="closeWindowToTray"
        >
          <UiIcon name="close" :size="14" />
        </button>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex">
    <!-- 全局导航：64px，图标 + 12px 文字（F21），当前项有语义标记（F20） -->
    <nav
      class="w-16 shrink-0 flex flex-col items-center pt-4 pb-3 border-r border-line-subtle bg-panel"
      aria-label="主导航"
    >
      <button
        v-for="n in navs"
        :key="n.key"
        :data-testid="'nav-' + n.key"
        class="w-12 h-[52px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium leading-none"
        :class="
          ui.view === n.key
            ? 'bg-panel text-brand-ink shadow-none'
            : 'text-ink-muted hover:bg-surface hover:text-ink-primary'
        "
        :aria-current="ui.view === n.key ? 'page' : undefined"
        @click="ui.view = n.key"
      >
        <UiIcon :name="n.icon" :size="20" />
        {{ n.label }}
      </button>
      <div class="flex-1" />
      <button
        class="icon-btn"
        :title="'主题: ' + themeLabel[ui.theme]"
        aria-label="切换主题"
        @click="cycleTheme"
      >
        <UiIcon name="theme" :size="20" />
      </button>
      <!-- 更新入口：主题按钮下方，仅当 GitHub 上有本地没有的提交时出现。
           用描边而非填充底色，避免与导航选中态（brand-soft 填充）混淆 -->
      <button
        v-if="updater.shouldShow"
        class="relative mt-1.5 w-12 h-[52px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium leading-none text-brand-ink border border-brand/45 hover:bg-brand-soft"
        data-testid="nav-update"
        :title="'GitHub 有新提交（' + updater.behindText + '），点击查看'"
        aria-label="有可用更新"
        @click="openUpdate"
      >
        <span class="relative">
          <UiIcon name="download" :size="20" />
          <span
            class="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-chrome"
            aria-hidden="true"
          />
        </span>
        更新
      </button>
    </nav>

    <main class="flex-1 min-w-0 relative">
      <ChatView v-show="ui.view === 'chat'" />
      <KbView v-show="ui.view === 'kb'" />
      <AgentView v-show="ui.view === 'agent'" />
      <SettingsView v-show="ui.view === 'settings'" />
      <RemotePanel v-if="ui.view === 'remote'" />
    </main>

    <ConfirmCard />
    <UpdateDialog :open="updateOpen" @close="updateOpen = false" />
    <ConfirmDialog
      :open="!!ui.confirmState"
      :title="ui.confirmState ? ui.confirmState.title : ''"
      :message="ui.confirmState ? ui.confirmState.message : ''"
      :impact="ui.confirmState ? ui.confirmState.impact : ''"
      :confirm-text="ui.confirmState ? ui.confirmState.confirmText : '删除'"
      :danger="ui.confirmState ? ui.confirmState.danger : true"
      @confirm="ui.resolveConfirm(true)"
      @cancel="ui.resolveConfirm(false)"
    />

    <!-- 通知区：不抢焦点，错误可手动关闭（F22），有播报语义（F20） -->
    <div
      class="fixed top-3 left-1/2 -translate-x-1/2 z-[80] space-y-2 pointer-events-none w-[min(420px,90vw)]"
    >
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="pointer-events-auto flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs shadow-menu"
        :class="toastCls[t.level] || toastCls.info"
        :role="t.level === 'error' ? 'alert' : 'status'"
      >
        <UiIcon
          v-if="toastIcon[t.level]"
          :name="toastIcon[t.level]"
          :size="16"
          class="mt-0.5 shrink-0"
        />
        <span class="flex-1 whitespace-pre-wrap">{{ t.message }}</span>
        <button
          class="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
          aria-label="关闭提示"
          @click="ui.dismissToast(t.id)"
        >
          <UiIcon name="close" :size="14" />
        </button>
      </div>
    </div>
    </div>
  </div>
</template>
