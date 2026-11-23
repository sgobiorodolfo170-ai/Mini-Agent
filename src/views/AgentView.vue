<script setup>
import { computed, ref } from 'vue'
import StatusBadge from '../components/StatusBadge.vue'
import UiIcon from '../components/UiIcon.vue'
import { useAgentStore } from '../stores/agent'
import { useUiStore } from '../stores/ui'

const agent = useAgentStore()
const ui = useUiStore()
const expandedResult = ref({})

// 仅运行中提供停止入口（F17：done/error/stopped 记录不再显示可用停止按钮）
const isRunning = computed(
  () => agent.activeRun && ['queued', 'running', 'waiting_child'].includes(agent.activeRun.status)
)

const riskText = { side_effect: '副作用', destructive: '破坏性', read_only: '只读' }
// 控制模式说明这条 Run 如何从父 Run 派生；验收状态与执行状态分开，避免把
// 「执行完成」误当成「人工验收通过」。
const controlModeText = { delegated: '父任务派发', transferred: '移交接手' }
const acceptanceStatusText = {
  pending: '待人工验收',
  accepted: '验收通过',
  rejected: '验收未通过',
  escalated: '验收需升级'
}
const acceptanceStatusClass = {
  pending: 'bg-warn text-warn-ink',
  accepted: 'bg-ok text-ok-ink',
  rejected: 'bg-bad text-bad-ink',
  escalated: 'bg-warn text-warn-ink'
}
function controlModeLabel(run) {
  return (run && controlModeText[run.control_mode]) || ''
}
function acceptanceStatus(run) {
  const status = run && run.acceptance_status
  return acceptanceStatusText[status] ? status : ''
}

function duration(r) {
  if (!r || !r.started_at) return ''
  const end = r.ended_at ? r.ended_at : Date.now()
  const ms = Math.max(0, end - r.started_at)
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
function prettyArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2)
  } catch {
    return raw || ''
  }
}
async function copyResult(c) {
  try {
    await navigator.clipboard.writeText(c.result || '')
    ui.toast('已复制结果', 'success')
  } catch {
    ui.toast('复制失败', 'error')
  }
}
</script>

<template>
  <div class="h-full flex min-w-0 bg-panel">
    <!-- 左栏：记录列表（两行：目标摘要 + 状态/时间） -->
    <aside
      class="shrink-0 flex flex-col bg-panel"
      :style="{ width: ui.chatListWidth + 'px' }"
      aria-label="执行记录"
    >
      <div
        class="px-3 py-3 text-base font-semibold text-ink-primary border-b border-line-subtle bg-panel"
      >
        执行记录
      </div>
      <div class="scroll-region flex-1 p-2 space-y-1 bg-panel">
        <div
          v-for="r in agent.runs"
          :key="r.id"
          tabindex="0"
          role="button"
          class="px-2.5 py-2 rounded-lg cursor-pointer text-xs"
          data-testid="agent-run"
          :class="r.id === agent.activeRunId ? 'bg-brand-soft text-brand-ink' : 'hover:bg-surface'"
          :aria-current="r.id === agent.activeRunId ? 'true' : undefined"
          @click="agent.select(r.id)"
          @keydown.enter.prevent="agent.select(r.id)"
        >
          <div class="truncate text-sm mb-1" :title="r.goal">{{ r.goal }}</div>
          <div class="flex items-center gap-2">
            <StatusBadge :status="r.status" />
            <span v-if="r.control_mode" class="text-[11px] text-ink-muted">
              · {{ r.control_mode === 'transferred' ? '接手' : '派发' }}
            </span>
            <span class="text-ink-muted ml-auto">{{
              new Date(r.started_at).toLocaleString('zh-CN')
            }}</span>
          </div>
        </div>
        <div v-if="!agent.runs.length" class="p-4 text-center text-xs text-ink-muted">
          暂无执行记录
        </div>
      </div>
    </aside>

    <section class="flex-1 min-w-0 flex flex-col m-3 chat-surface overflow-hidden">
      <template v-if="agent.activeRunId && agent.activeRun">
        <!-- 顶部：目标全文 / 状态 / 耗时（F17） -->
        <header class="shrink-0 px-5 py-3.5 bg-surface flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-medium break-words" :title="agent.activeRun.goal">
              {{ agent.activeRun.goal }}
            </h2>
            <div class="text-xs text-ink-muted mt-1 flex items-center gap-2 flex-wrap">
              <StatusBadge :status="agent.activeRun.status" />
              <span
                v-if="controlModeLabel(agent.activeRun)"
                class="badge bg-subtle text-ink-secondary"
                data-testid="run-control-mode"
              >
                {{ controlModeLabel(agent.activeRun) }}
              </span>
              <span
                v-if="acceptanceStatus(agent.activeRun)"
                class="badge"
                :class="acceptanceStatusClass[acceptanceStatus(agent.activeRun)]"
                data-testid="run-acceptance"
              >
                {{ acceptanceStatusText[acceptanceStatus(agent.activeRun)] }}
              </span>
              <button
                v-if="agent.activeRun.transfer_to_run_id"
                class="link"
                @click="agent.select(agent.activeRun.transfer_to_run_id)"
              >
                查看接手任务
              </button>
              <span class="inline-flex items-center gap-1">
                <UiIcon name="clock" :size="13" />
                耗时 {{ duration(agent.activeRun) }}
              </span>
              <span v-if="agent.activeRun.conversationTitle" class="inline-flex items-center gap-1">
                <UiIcon name="chat" :size="13" />
                {{ agent.activeRun.conversationTitle }}
              </span>
            </div>
          </div>
          <button
            v-if="isRunning"
            class="btn h-9 px-3.5 rounded-lg text-sm bg-red-700 hover:bg-red-800 text-white shrink-0"
            @click="agent.stopRun(agent.activeRunId)"
          >
            <UiIcon name="stop" :size="16" />
            停止执行
          </button>
        </header>

        <div class="scroll-region flex-1 px-5 py-4 space-y-3 bg-surface">
          <div
            v-if="agent.activeRun.error"
            class="rounded-lg bg-bad text-bad-ink px-3 py-2 text-sm"
          >
            {{ agent.activeRun.error }}
          </div>
          <div v-if="!agent.calls.length" class="text-ink-muted text-sm py-4">
            该任务没有工具调用
          </div>

          <!-- 步骤卡：可折叠，参数与结果在展开区（F17） -->
          <div v-for="c in agent.calls" :key="c.id" class="card p-3 space-y-2 text-sm">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-medium text-brand-ink">#{{ c.step }} {{ c.tool }}</span>
              <span class="text-xs text-ink-muted">{{
                riskText[c.risk_level] || c.risk_level
              }}</span>
              <span v-if="c.confirmed_by" class="text-xs text-ink-muted"
                >确认方式：{{ c.confirmed_by }}</span
              >
              <span class="text-xs text-ink-muted ml-auto">{{ c.duration_ms }} ms</span>
            </div>
            <details :open="!!c.error">
              <summary class="cursor-pointer select-none text-xs text-ink-secondary">参数</summary>
              <pre
                class="mt-1.5 p-2 rounded-lg bg-subtle overflow-x-auto max-h-40 font-code text-xs"
                >{{ prettyArgs(c.args) }}</pre>
            </details>
            <div v-if="c.result" class="space-y-1">
              <div
                class="text-ink-secondary whitespace-pre-wrap text-xs"
                :class="expandedResult[c.id] ? '' : 'line-clamp-6'"
              >
                {{ c.result }}
              </div>
              <div class="flex gap-3">
                <button
                  class="text-xs text-link hover:underline"
                  @click="expandedResult[c.id] = !expandedResult[c.id]"
                >
                  {{ expandedResult[c.id] ? '收起' : '展开全部' }}
                </button>
                <button class="text-xs text-link hover:underline" @click="copyResult(c)">
                  复制
                </button>
              </div>
            </div>
            <div v-if="c.error" class="text-bad-ink text-xs flex items-start gap-1">
              <UiIcon name="warn" :size="14" class="mt-0.5 shrink-0" />
              <span class="whitespace-pre-wrap">{{ c.error }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- 空态 -->
      <div
        v-else
        class="h-full flex items-center justify-center text-ink-muted text-center bg-surface"
      >
        <div>
          <div class="text-base text-ink-secondary mb-2">在会话中开启「任务模式」发起智能任务</div>
          <div class="text-xs">只读工具自动执行；写文件 / 执行命令需逐次确认</div>
        </div>
      </div>
    </section>
  </div>
</template>
