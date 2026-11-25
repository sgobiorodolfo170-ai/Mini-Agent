<script setup>
import { computed, ref } from 'vue'
import MarkdownBody from './MarkdownBody.vue'
import UiIcon from './UiIcon.vue'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'

const props = defineProps({
  msg: { type: Object, required: true },
  highlighted: { type: Boolean, default: false },
  // 后端 regenerate 只处理末条回答：按钮只在末条 assistant 上展示，保证目标一致（F07）
  isLast: { type: Boolean, default: false }
})
const chat = useChatStore()
const ui = useUiStore()
const editing = ref(false)
const draft = ref('')
const copied = ref('')

const isUser = computed(() => props.msg.role === 'user')
const streaming = computed(() => props.msg.status === 'streaming')
const statusLabel = computed(
  () =>
    ({
      pending: '排队中',
      transferred: '已移交',
      interrupted: '执行中断',
      max_steps: '已达步骤上限',
      stopped: '已停止',
      error: '出错'
    })[props.msg.status] || ''
)
const kbRefs = computed(() => (props.msg.meta && props.msg.meta.kbRefs) || [])
const warnings = computed(() => (props.msg.meta && props.msg.meta.warnings) || [])
const atts = computed(() => props.msg.attachments || [])
const imageAtts = computed(() => atts.value.filter((a) => a && a.type === 'image' && a.dataUrl))
const textAtts = computed(() => atts.value.filter((a) => a && a.type === 'text' && a.content))

async function copy() {
  try {
    await navigator.clipboard.writeText(props.msg.content || '')
    copied.value = '已复制'
  } catch {
    copied.value = '复制失败'
  }
  setTimeout(() => (copied.value = ''), 1200)
}
function regenerate() {
  chat.regenerate()
}
async function removeMsg() {
  // 删除走统一确认弹窗（F04）：取消不落库
  const ok = await ui.confirm({
    title: '删除消息',
    message: '确定删除这条消息吗？删除后不可恢复。',
    danger: true
  })
  if (ok) chat.deleteMessage(props.msg.id)
}
function startEdit() {
  editing.value = true
  draft.value = props.msg.content
}
function submitEdit() {
  if (!draft.value.trim()) return
  editing.value = false
  chat.editResend(props.msg.id, draft.value)
}
function onEditKeydown(e) {
  // IME 组合期间不提交（F05）
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    submitEdit()
  }
}
</script>

<template>
  <div
    class="flex flex-col w-full rounded-lg transition-colors"
    :class="[
      isUser ? 'items-end' : 'items-start',
      highlighted ? 'bg-brand-soft ring-2 ring-brand' : ''
    ]"
    :data-msg-id="msg.id"
  >
    <div class="max-w-[85%] min-w-0 group" :class="isUser ? '' : 'max-w-full w-full'">
      <!-- attachments -->
      <div
        v-if="textAtts.length"
        class="flex w-full flex-col gap-1 mb-1"
        :class="isUser ? 'items-end' : ''"
      >
        <div
          v-for="(a, i) in textAtts"
          :key="'text-' + i"
          class="max-h-28 max-w-[85%] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line-subtle bg-subtle/40 px-3 py-2 text-xs text-ink-secondary"
          data-testid="message-text-attachment"
        >
          <span class="mb-0.5 block text-[11px] font-medium text-ink-muted">选中文字</span>
          {{ a.content }}
        </div>
      </div>
      <div
        v-if="imageAtts.length"
        class="flex flex-wrap gap-2 mb-1"
        :class="isUser ? 'justify-end' : ''"
      >
        <img
          v-for="(a, i) in imageAtts"
          :key="i"
          :src="a.dataUrl"
          class="max-h-40 rounded-lg border border-line-control"
          alt="消息附件"
        />
      </div>

      <!-- body：助手回复平铺主文本，用户消息浅品牌底右对齐（方案 6.1） -->
      <div class="flex" :class="isUser ? 'justify-end' : 'gap-2'">
        <span
          v-if="!isUser"
          class="mt-1 w-6 h-6 shrink-0 rounded-full bg-brand-soft text-brand-ink flex items-center justify-center"
          aria-hidden="true"
        >
          <UiIcon name="chat" :size="13" />
        </span>
        <div
          class="min-w-0 message-text"
          :class="
            isUser
              ? 'bg-brand-soft text-ink-primary rounded-xl rounded-br-sm px-4 py-2.5'
              : 'flex-1 min-w-0 py-1'
          "
        >
          <textarea
            v-if="editing"
            v-model="draft"
            rows="6"
            class="field-area message-editor h-32"
            aria-label="编辑消息"
            @keydown="onEditKeydown"
          />
          <template v-else>
            <MarkdownBody v-if="!isUser" :content="msg.content" :streaming="streaming" />
            <span v-else class="whitespace-pre-wrap">{{ msg.content }}</span>
          </template>
        </div>
      </div>

      <!-- status / citations / warnings：常驻显示，不依赖悬停（F13） -->
      <div v-if="!isUser" class="mt-1 pl-8 text-xs text-ink-muted space-y-1">
        <div v-if="warnings.length" class="text-warn-ink flex items-start gap-1">
          <UiIcon name="warn" :size="14" class="mt-0.5 shrink-0" />
          <span>{{ warnings.join('；') }}</span>
        </div>
        <details v-if="kbRefs.length">
          <summary class="cursor-pointer select-none">引用 ({{ kbRefs.length }})</summary>
          <ul class="list-disc pl-4 space-y-0.5 mt-1">
            <li v-for="r in kbRefs" :key="r.n">
              [{{ r.n }}] {{ r.title
              }}<template v-if="r.headingPath"> › {{ r.headingPath }}</template>
              <span class="text-ink-muted">（相关度 {{ r.score }}）</span>
            </li>
          </ul>
        </details>
      </div>

      <!-- 操作行：常驻可见（F13），复制有反馈（F22），重生成仅末条（F07） -->
      <div
        class="mt-1 pl-8 flex gap-3 text-xs text-ink-muted"
        :class="isUser ? '!pl-0 justify-end' : ''"
      >
        <template v-if="editing">
          <button class="hover:text-brand-ink" @click="submitEdit">发送</button>
          <button class="hover:text-ink-primary" @click="editing = false">取消</button>
        </template>
        <template v-else>
          <!-- 回复生成中：状态环跟随消息展示在回复文本下方（替代「生成中…」文案） -->
          <span
            v-if="streaming"
            class="shrink-0 self-center w-3.5 h-3.5 rounded-full border-2 border-line-subtle border-t-brand animate-spin"
            role="img"
            aria-label="生成中"
            data-testid="message-generating"
          />
          <span
            v-else-if="statusLabel"
            :class="msg.status === 'error' ? 'text-bad-ink' : 'text-hint-ink'"
          >
            {{ statusLabel }}
          </span>
          <button
            v-if="!streaming"
            class="hover:text-bad-ink"
            aria-label="删除消息"
            title="删除"
            @click="removeMsg"
          >
            <UiIcon name="trash" :size="14" />
          </button>
          <button
            v-if="isUser"
            class="hover:text-brand-ink"
            aria-label="编辑消息"
            title="编辑"
            @click="startEdit"
          >
            <UiIcon name="edit" :size="14" />
          </button>
          <button
            v-if="!isUser && isLast && !streaming"
            class="hover:text-brand-ink"
            aria-label="重新生成回答"
            title="重新生成"
            @click="regenerate"
          >
            <UiIcon name="refresh" :size="14" />
          </button>
          <button v-if="copied" class="text-ok-ink" aria-live="polite">{{ copied }}</button>
          <button
            v-else
            class="hover:text-brand-ink"
            aria-label="复制消息"
            title="复制"
            @click="copy"
          >
            <UiIcon name="copy" :size="14" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
