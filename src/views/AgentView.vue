<script setup>
import { computed, ref } from 'vue'
import StatusBadge from '../components/StatusBadge.vue'
import UiIcon from '../components/UiIcon.vue'
import UiDialog from '../components/UiDialog.vue'
import { useAgentStore } from '../stores/agent'
import { useUiStore } from '../stores/ui'

const agent = useAgentStore()
const ui = useUiStore()
const expandedResult = ref({})

// 仅运行中提供停止入口（F17：done/error/stopped 记录不再显示可用停止按钮）
const isRunning = computed(
  () => agent.activeRun && ['queued', 'running', 'waiting_child'].includes(agent.activeRun.status)
)
const runRecovery = computed(() =>
  agent.recovery && agent.recovery.runId === agent.activeRunId ? agent.recovery : null
)
const checkpointPhaseText = {
  before_model: '模型调用前',
  tool_done: '工具完成后',
  model_done: '模型输出后（核对工具台账）'
}

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
function acceptanceResult(run) {
  try {
    return JSON.parse((run && run.acceptance_result) || '{}') || {}
  } catch {
    return {}
  }
}
function canDecideAcceptance(run) {
  return ['pending', 'escalated', 'rejected'].includes(run && run.acceptance_status)
}
async function decideAcceptance(decision) {
  if (!agent.activeRun) return
  try {
    await agent.decideAcceptance(agent.activeRun.id, decision)
    ui.toast(decision === 'accepted' ? '已标记验收通过' : '已标记验收未通过', 'success')
  } catch (e) {
    ui.toast(String((e && e.message) || e), 'error')
  }
}
async function continueInterrupted() {
  if (!agent.activeRun || !runRecovery.value?.canResume) return
  const ok = await ui.confirm({
    title: '继续中断任务',
    message: '将从最后的安全检查点继续，已完成的工具不会重放。',
    impact: '继续后任务会重新进入队列；如果外部状态已变化，请停止并选择关联新任务重试。',
    confirmText: '继续执行'
  })
  if (!ok) return
  try {
    await agent.continueInterrupted(agent.activeRun.id)
    ui.toast('任务已从安全检查点继续', 'success')
  } catch (e) {
    ui.toast(String((e && e.message) || e), 'error')
  }
}
async function retryInterrupted() {
  if (!agent.activeRun) return
  const ok = await ui.confirm({
    title: '关联新任务重试',
    message: '原中断记录会保留，并创建一个关联的新任务。',
    impact: '新任务会先检查执行台账；未知副作用不会自动重放。请确认已完成外部操作后再继续。',
    confirmText: '创建重试任务'
  })
  if (!ok) return
  try {
    await agent.retryInterrupted(agent.activeRun.id)
    ui.toast('已创建关联重试任务', 'success')
  } catch (e) {
    ui.toast(String((e && e.message) || e), 'error')
  }
}
function graphDepKeys(runId) {
  if (!agent.graph) return []
  const keyById = new Map((agent.graph.nodes || []).map((n) => [n.runId, n.nodeKey]))
  return (agent.graph.dependencies || [])
    .filter((d) => d.runId === runId)
    .map((d) => keyById.get(d.dependsOnRunId))
    .filter(Boolean)
}
const showGraphEditor = ref(false)
const editingNodeId = ref(null)
const editingGoal = ref('')
const editingDeps = ref([])
const graphBusy = ref(false)
function openGraphEditor(node) {
  if (!node.editable || !agent.graph || agent.graph.status !== 'running') return
  editingNodeId.value = node.runId
  editingGoal.value = node.goal
  editingDeps.value = (agent.graph.dependencies || [])
    .filter((edge) => edge.runId === node.runId)
    .map((edge) => edge.dependsOnRunId)
  showGraphEditor.value = true
}
async function saveGraphNode() {
  if (!agent.graph || !editingNodeId.value || graphBusy.value) return
  graphBusy.value = true
  try {
    await agent.loadGraph(agent.activeRunId)
    await agent.mutateGraph({
      graphId: agent.graph.graphId,
      etag: agent.graph.etag,
      ops: [
        {
          action: 'update',
          runId: editingNodeId.value,
          goal: editingGoal.value,
          deps: editingDeps.value
        }
      ]
    })
    showGraphEditor.value = false
    ui.toast('排队节点已更新', 'success')
  } catch (e) {
    ui.toast(String((e && e.message) || e), 'error')
    await agent.loadGraph(agent.activeRunId)
  } finally {
    graphBusy.value = false
  }
}
async function deleteGraphNode(node) {
  if (!node.editable || !agent.graph || graphBusy.value) return
  const ok = await ui.confirm({
    title: '删除排队节点',
    message: `删除节点「${node.nodeKey}」？`,
    impact: '节点会停止并从任务图移除，其他节点对它的依赖会同时清除。',
    confirmText: '删除节点'
  })
  if (!ok) return
  graphBusy.value = true
  try {
    await agent.loadGraph(agent.activeRunId)
    await agent.mutateGraph({
      graphId: agent.graph.graphId,
      etag: agent.graph.etag,
      ops: [{ action: 'delete', runId: node.runId }]
    })
    ui.toast('排队节点已删除', 'success')
  } catch (e) {
    ui.toast(String((e && e.message) || e), 'error')
    await agent.loadGraph(agent.activeRunId)
  } finally {
    graphBusy.value = false
  }
}
function workspaceInfo(run) {
  try {
    return JSON.parse((run && run.workspace_json) || '{}') || {}
  } catch {
    return {}
  }
}
const mergeStatusText = {
  merged: '已自动合并',
  conflict: '合并冲突，已保留分支',
  skipped: '未自动合并',
  failed: '合并失败'
}
function mergeStatus(run) {
  const merge = workspaceInfo(run).merge
  return (merge && mergeStatusText[merge.status]) || ''
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
            <span v-if="r.node_key" class="text-[11px] text-ink-muted"> · {{ r.node_key }} </span>
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
                v-if="agent.activeRun.graph_id"
                class="badge bg-subtle text-ink-secondary"
                data-testid="run-graph"
              >
                任务图
              </span>
              <span
                v-if="agent.activeRun.resume_count"
                class="badge bg-hint text-hint-ink"
                data-testid="run-resumed"
              >
                已恢复 ×{{ agent.activeRun.resume_count }}
              </span>
              <span
                v-if="workspaceInfo(agent.activeRun).mode === 'worktree'"
                class="badge bg-subtle text-ink-secondary"
                data-testid="run-workspace"
              >
                独立工作区
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

        <div
          v-if="agent.activeRun.status === 'interrupted'"
          class="shrink-0 px-5 pb-3 bg-surface"
          data-testid="run-recovery-panel"
        >
          <div class="rounded-lg border border-warn bg-panel px-3 py-2 text-xs space-y-2">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-medium text-warn-ink">任务因应用中断而停止</span>
              <span v-if="runRecovery?.checkpoint" class="text-ink-muted">
                检查点：{{
                  checkpointPhaseText[runRecovery.checkpoint.phase] || runRecovery.checkpoint.phase
                }}
              </span>
              <span v-if="runRecovery?.unfinishedTools?.length" class="text-bad-ink">
                待核对工具 {{ runRecovery.unfinishedTools.length }} 项
              </span>
            </div>
            <p class="text-ink-muted">
              请先核对下方执行台账和工作区。只有安全边界允许原任务继续，其余情况请创建关联新任务。
            </p>
            <div v-if="runRecovery?.workspace?.path" class="text-ink-muted break-all">
              工作区：{{ runRecovery.workspace.path }}
            </div>
            <div class="flex gap-2">
              <button
                class="btn-secondary !h-7 !px-2.5 text-xs"
                data-testid="run-recovery-continue"
                :disabled="!runRecovery?.canResume"
                @click="continueInterrupted"
              >
                核对后续跑
              </button>
              <button
                class="btn-secondary !h-7 !px-2.5 text-xs"
                data-testid="run-recovery-retry"
                @click="retryInterrupted"
              >
                关联新任务重试
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="acceptanceStatus(agent.activeRun)"
          class="shrink-0 px-5 pb-3 bg-surface"
          data-testid="run-acceptance-panel"
        >
          <div class="rounded-lg border border-line-subtle bg-panel px-3 py-2 text-xs space-y-1.5">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-ink-secondary">验收</span>
              <span class="badge" :class="acceptanceStatusClass[acceptanceStatus(agent.activeRun)]">
                {{ acceptanceStatusText[acceptanceStatus(agent.activeRun)] }}
              </span>
              <span
                v-if="acceptanceResult(agent.activeRun).reason"
                class="text-ink-muted"
                data-testid="run-acceptance-reason"
              >
                {{ acceptanceResult(agent.activeRun).reason }}
              </span>
            </div>
            <ul
              v-if="acceptanceResult(agent.activeRun).unmet?.length"
              class="list-disc pl-4 text-ink-muted space-y-0.5"
            >
              <li v-for="(item, i) in acceptanceResult(agent.activeRun).unmet" :key="i">
                {{ item }}
              </li>
            </ul>
            <div v-if="canDecideAcceptance(agent.activeRun)" class="flex gap-2 pt-0.5">
              <button
                class="btn-secondary !h-7 !px-2.5 text-xs"
                data-testid="run-accept-yes"
                @click="decideAcceptance('accepted')"
              >
                接受
              </button>
              <button
                class="btn-secondary !h-7 !px-2.5 text-xs text-bad-ink"
                data-testid="run-accept-no"
                @click="decideAcceptance('rejected')"
              >
                拒绝
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="agent.graph && agent.graph.nodes?.length"
          class="shrink-0 px-5 pb-3 bg-surface"
          data-testid="run-graph-panel"
        >
          <div class="rounded-lg border border-line-subtle bg-panel px-3 py-2 text-xs space-y-2">
            <div class="flex items-center gap-2">
              <span class="text-ink-secondary">任务图</span>
              <span class="text-ink-muted">{{ agent.graph.status }}</span>
              <span class="text-ink-muted">仅排队节点可编辑目标和依赖</span>
            </div>
            <div class="max-h-64 overflow-auto space-y-2">
              <template v-for="(layer, layerIndex) in agent.graph.layers" :key="layerIndex">
                <div class="flex flex-wrap items-start justify-center gap-2">
                  <div
                    v-for="node in layer"
                    :key="node.runId"
                    class="min-w-44 max-w-64 rounded-lg border border-line-subtle bg-surface p-2 space-y-1"
                    :data-testid="`graph-node-${node.nodeKey}`"
                  >
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-medium text-ink-primary">{{ node.nodeKey }}</span>
                      <StatusBadge :status="node.status" />
                    </div>
                    <div class="text-ink-muted line-clamp-2">{{ node.goal }}</div>
                    <div v-if="graphDepKeys(node.runId).length" class="text-ink-muted">
                      依赖 {{ graphDepKeys(node.runId).join(', ') }}
                    </div>
                    <div
                      v-if="node.editable && agent.graph.status === 'running'"
                      class="flex gap-2 pt-1"
                    >
                      <button
                        class="text-xs text-link hover:underline"
                        data-testid="graph-node-edit"
                        @click="openGraphEditor(node)"
                      >
                        编辑
                      </button>
                      <button
                        class="text-xs text-bad-ink hover:underline"
                        data-testid="graph-node-delete"
                        @click="deleteGraphNode(node)"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
                <div
                  v-if="layerIndex < agent.graph.layers.length - 1"
                  class="text-center text-ink-muted"
                >
                  ↓
                </div>
              </template>
            </div>
          </div>
        </div>

        <div
          v-if="workspaceInfo(agent.activeRun).mode === 'worktree'"
          class="shrink-0 px-5 pb-3 bg-surface"
          data-testid="run-workspace-panel"
        >
          <div class="rounded-lg border border-line-subtle bg-panel px-3 py-2 text-xs space-y-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-ink-secondary">工作区</span>
              <span class="badge bg-subtle text-ink-secondary">
                {{ workspaceInfo(agent.activeRun).branch }}
              </span>
              <span v-if="mergeStatus(agent.activeRun)" class="text-ink-muted">
                {{ mergeStatus(agent.activeRun) }}
              </span>
              <span v-if="workspaceInfo(agent.activeRun).merge?.reason" class="text-ink-muted">
                {{ workspaceInfo(agent.activeRun).merge.reason }}
              </span>
            </div>
            <div class="text-ink-muted break-all">{{ workspaceInfo(agent.activeRun).path }}</div>
          </div>
        </div>

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

    <UiDialog :open="showGraphEditor" title="编辑排队节点" @close="showGraphEditor = false">
      <div class="space-y-3">
        <label class="block">
          <span class="field-label">任务目标</span>
          <textarea
            v-model="editingGoal"
            data-testid="graph-node-goal"
            class="field-input min-h-24"
            :maxlength="16000"
          />
        </label>
        <fieldset class="space-y-2">
          <legend class="field-label">前置依赖</legend>
          <label
            v-for="node in agent.graph?.nodes || []"
            :key="node.runId"
            class="flex items-center gap-2 text-sm"
          >
            <input
              v-model="editingDeps"
              type="checkbox"
              :data-testid="`graph-dep-${node.nodeKey}`"
              :value="node.runId"
              :disabled="node.runId === editingNodeId"
              class="accent-brand-ink"
            />
            <span>{{ node.nodeKey }}</span>
            <StatusBadge :status="node.status" />
          </label>
        </fieldset>
      </div>
      <template #footer>
        <button class="btn-secondary text-sm" @click="showGraphEditor = false">取消</button>
        <button
          class="btn-primary text-sm"
          data-testid="graph-node-save"
          :disabled="!editingGoal.trim() || graphBusy"
          @click="saveGraphNode"
        >
          {{ graphBusy ? '保存中…' : '保存' }}
        </button>
      </template>
    </UiDialog>
  </div>
</template>
