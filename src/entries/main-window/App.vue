<script setup>
import { onMounted } from 'vue'
import { useUiStore } from '../../stores/ui'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { useKbStore } from '../../stores/kb'
import { useAgentStore } from '../../stores/agent'
import { useProjectsStore } from '../../stores/projects'
import { useSessionsStore } from '../../stores/sessions'
import ChatView from '../../views/ChatView.vue'
import KbView from '../../views/KbView.vue'
import AgentView from '../../views/AgentView.vue'
import SettingsView from '../../views/SettingsView.vue'
import ConfirmCard from '../../components/ConfirmCard.vue'
import ConfirmDialog from '../../components/ConfirmDialog.vue'
import UiIcon from '../../components/UiIcon.vue'

const ui = useUiStore()
const chat = useChatStore()
const settings = useSettingsStore()
const kb = useKbStore()
const agent = useAgentStore()
const projects = useProjectsStore()
const sessions = useSessionsStore()

const navs = [
  { key: 'chat', icon: 'chat', label: '会话' },
  { key: 'kb', icon: 'kb', label: '知识库' },
  { key: 'agent', icon: 'agent', label: '智能任务' },
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

  await ui.init()
  await settings.init()
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
</script>

<template>
  <div class="h-full flex">
    <!-- 全局导航：64px，图标 + 12px 文字（F21），当前项有语义标记（F20） -->
    <nav
      class="w-16 shrink-0 flex flex-col items-center pt-4 pb-3 border-r border-line-subtle bg-subtle"
      aria-label="主导航"
    >
      <button
        v-for="n in navs"
        :key="n.key"
        :data-testid="'nav-' + n.key"
        class="w-12 h-[52px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium leading-none"
        :class="
          ui.view === n.key
            ? 'bg-brand-soft text-brand-ink shadow-none'
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
    </nav>

    <main class="flex-1 min-w-0 relative">
      <ChatView v-show="ui.view === 'chat'" />
      <KbView v-show="ui.view === 'kb'" />
      <AgentView v-show="ui.view === 'agent'" />
      <SettingsView v-show="ui.view === 'settings'" />
    </main>

    <ConfirmCard />
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
</template>
