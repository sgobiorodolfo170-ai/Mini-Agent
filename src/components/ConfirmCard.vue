<script setup>
import { computed, ref, watch } from 'vue'
import UiDialog from './UiDialog.vue'
import UiIcon from './UiIcon.vue'
import { useAgentStore } from '../stores/agent'

const agent = useAgentStore()
const card = computed(() => agent.confirms[0] || null)
const remember = ref(false)

const riskText = { side_effect: '副作用', destructive: '破坏性' }
const riskCls = {
  side_effect: 'bg-warn text-warn-ink',
  destructive: 'bg-bad text-bad-ink'
}

// 主操作文案具体到动作（方案 6.4），破坏性工具不给一键免确认的暗示
const allowLabel = computed(() => {
  if (!card.value) return '允许执行'
  const t = card.value.tool
  if (t === 'write_file') return '允许写入'
  if (t === 'clipboard_write') return '允许写入剪贴板'
  if (t === 'run_command') return '允许执行'
  return '允许执行'
})

watch(card, () => (remember.value = false))

function allow() {
  agent.respond(card.value.requestId, true, remember.value)
  remember.value = false
}
function deny() {
  agent.respond(card.value.requestId, false, false)
  remember.value = false
}
</script>

<template>
  <!-- 执行确认（F18）：模态对话框，遮罩 + 焦点默认在拒绝 + 待处理队列计数 -->
  <UiDialog
    :open="!!card"
    :title="card ? `Agent 请求确认（待处理 ${agent.confirms.length}）` : 'Agent 请求确认'"
    width="480px"
    hide-close
    @close="deny"
  >
    <div v-if="card" class="space-y-3">
      <div class="flex items-center gap-2">
        <span class="badge" :class="riskCls[card.riskLevel] || 'bg-subtle text-ink-secondary'">
          <UiIcon name="warn" :size="12" />
          {{ riskText[card.riskLevel] || card.riskLevel }}
        </span>
        <span class="text-sm text-ink-secondary">
          工具：<code class="font-code text-brand-ink">{{ card.tool }}</code>
        </span>
      </div>
      <div class="text-sm text-ink-primary">{{ card.summary }}</div>
      <details class="text-xs">
        <summary class="cursor-pointer text-ink-muted select-none">参数详情</summary>
        <pre class="mt-1.5 p-2 rounded-lg bg-subtle overflow-x-auto max-h-40 font-code text-xs">{{
          JSON.stringify(card.args, null, 2)
        }}</pre>
      </details>
      <label class="flex items-start gap-2 text-xs text-ink-secondary cursor-pointer">
        <input v-model="remember" type="checkbox" class="mt-0.5" />
        <span>本会话内同类操作不再确认（范围仅当前任务；破坏性操作始终逐次确认）</span>
      </label>
    </div>
    <template #footer>
      <button class="btn-secondary" data-autofocus @click="deny">拒绝</button>
      <button class="btn-primary" :disabled="!card" @click="allow">{{ allowLabel }}</button>
    </template>
  </UiDialog>
</template>
