<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AgentComposer from '../components/composer/AgentComposer.vue'
import MarkdownBody from '../components/MarkdownBody.vue'
import UiIcon from '../components/UiIcon.vue'
import { useChatStore } from '../stores/chat'
import { useSideTaskStore } from '../stores/sideTask'

// 临时会话：临时子会话。消息只保留在本次运行的内存中，
// 主进程按需附加主会话上下文，但不会把这里的消息写回主会话历史。
const chat = useChatStore()
const sideTask = useSideTaskStore()
const messages = ref([])
const input = ref('')
const useMainContext = ref(true)
const streamingId = ref('')
const scrollEl = ref(null)
const composerRef = ref(null)
let off = null

const streaming = computed(() => !!streamingId.value)
const pendingAttachments = computed(() => sideTask.attachments)
const mainTitle = computed(() => (chat.activeConv ? chat.activeConv.title : '未选择会话'))
const suggestions = [
  '总结主会话的关键结论与分歧',
  '解释主会话中最后一条回答',
  '基于主会话探索另一种方案'
]

function scrollToBottom() {
  nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function handleEvent(ev) {
  if (!ev || !ev.id) return
  const m = messages.value.find((x) => x.id === ev.id)
  if (!m) return
  if (ev.type === 'delta') {
    m.content += ev.delta || ''
    scrollToBottom()
  } else if (ev.type === 'done') {
    m.content = ev.content || m.content
    m.status = 'done'
    streamingId.value = ''
  } else if (ev.type === 'stopped') {
    m.content = ev.content || m.content
    m.status = 'stopped'
    streamingId.value = ''
  } else if (ev.type === 'error') {
    m.status = 'error'
    m.error = ev.message || '请求失败'
    streamingId.value = ''
  }
}

async function send() {
  if (streaming.value) return
  const text = input.value.trim()
  const attachments = sideTask.takeAttachments()
  // 只发送选中文字、不写问题时给一个默认提问
  const content = text || (attachments.length ? '请解读选中的内容' : '')
  if (!content) return
  const attachmentText = attachments.map((a) => `[选中文字]\n${a.content}`).join('\n\n')
  const requestContent = attachmentText ? `${content}\n\n${attachmentText}` : content
  const id = 'side-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  const history = messages.value
    .filter((m) => m.status === 'done' && m.content)
    .map((m) => ({ role: m.role, content: m.content }))
  messages.value.push({
    id: 'u-' + id,
    role: 'user',
    content,
    attachments,
    status: 'done',
    error: ''
  })
  messages.value.push({ id, role: 'assistant', content: '', status: 'streaming', error: '' })
  streamingId.value = id
  input.value = ''
  scrollToBottom()
  try {
    await window.api.side.send({
      id,
      conversationId: chat.activeId,
      content: requestContent,
      history,
      useContext: useMainContext.value
    })
  } catch (e) {
    if (attachments.length) sideTask.attachments = [...attachments, ...sideTask.attachments]
    const m = messages.value.find((x) => x.id === id)
    if (m) {
      m.status = 'error'
      m.error = String((e && e.message) || e)
    }
    streamingId.value = ''
  }
}

function stop() {
  if (streamingId.value) window.api.side.stop(streamingId.value)
}

function clearAll() {
  if (streaming.value) stop()
  messages.value = []
  streamingId.value = ''
}

onMounted(() => {
  off = window.api.on('side:event', handleEvent)
})
watch(
  () => sideTask.focusRevision,
  async () => {
    await nextTick()
    if (composerRef.value) composerRef.value.focus()
  }
)
onBeforeUnmount(() => {
  if (off) off()
  if (streamingId.value) window.api.side.stop(streamingId.value)
})
</script>

<template>
  <section
    class="flex-1 min-w-0 flex flex-col m-3 chat-surface overflow-hidden"
    data-testid="side-task-view"
  >
    <header
      class="shrink-0 h-14 flex items-center gap-2 px-4 bg-surface border-b border-line-subtle"
    >
      <UiIcon name="panelRight" :size="18" class="text-brand-ink shrink-0" />
      <div class="min-w-0 flex-1">
        <h1 class="text-sm font-semibold truncate">临时会话</h1>
        <div class="text-xs text-ink-muted truncate">
          临时子会话 · 不计入主会话上下文 · 参考：{{ mainTitle }}
        </div>
      </div>
      <label class="flex items-center gap-1.5 text-xs text-ink-secondary shrink-0">
        <input
          v-model="useMainContext"
          type="checkbox"
          class="accent-brand-ink"
          data-testid="side-context-toggle"
        />
        引用主会话上下文
      </label>
      <button
        class="btn-compact !h-7 !px-3 text-xs shrink-0"
        :disabled="!messages.length"
        data-testid="side-clear"
        @click="clearAll"
      >
        清空
      </button>
    </header>

    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 bg-surface">
      <div class="max-w-[840px] mx-auto w-full space-y-4">
        <div v-if="!messages.length" class="rounded-2xl border border-line-subtle bg-subtle/40 p-4">
          <h2 class="text-sm font-semibold text-ink-primary">临时子会话</h2>
          <p class="mt-1 text-xs text-ink-muted leading-relaxed">
            可以围绕主会话做解读、释疑、探索或分支推演；这里的对话不会写入主会话，也不会占用主会话上下文。
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="s in suggestions"
              :key="s"
              class="btn-secondary !h-7 text-xs"
              @click="input = s"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <div
          v-for="m in messages"
          :key="m.id"
          class="flex flex-col w-full"
          :class="m.role === 'user' ? 'items-end' : 'items-start'"
          :data-side-msg-id="m.id"
        >
          <div
            v-if="m.role === 'user'"
            class="max-w-[85%] min-w-0 message-text bg-brand-soft text-ink-primary rounded-xl rounded-br-sm px-4 py-2.5"
          >
            <div v-if="m.attachments && m.attachments.length" class="mb-1.5 space-y-1">
              <div
                v-for="a in m.attachments"
                :key="a.id"
                class="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-line-control bg-surface px-2 py-1 text-xs text-ink-secondary"
                data-testid="side-message-attachment"
              >
                <span class="mb-0.5 block text-[11px] font-medium text-ink-muted">选中文字</span>
                {{ a.content }}
              </div>
            </div>
            <span class="whitespace-pre-wrap">{{ m.content }}</span>
          </div>
          <div v-else class="w-full min-w-0 flex gap-2">
            <span
              class="mt-1 w-6 h-6 shrink-0 rounded-full bg-brand-soft text-brand-ink flex items-center justify-center"
              aria-hidden="true"
            >
              <UiIcon name="chat" :size="13" />
            </span>
            <div class="min-w-0 message-text flex-1 min-w-0 py-1">
              <MarkdownBody
                v-if="m.content"
                :content="m.content"
                :streaming="m.status === 'streaming'"
              />
              <div
                v-if="m.error"
                class="mt-1 text-xs text-bad-ink flex items-start gap-1"
                role="alert"
              >
                <UiIcon name="warn" :size="14" class="mt-0.5 shrink-0" />
                <span>{{ m.error }}</span>
              </div>
              <!-- 生成中：与主会话一致，在回复文本下方显示状态环 -->
              <span
                v-if="m.status === 'streaming'"
                class="mt-2 inline-block w-3.5 h-3.5 rounded-full border-2 border-line-subtle border-t-brand animate-spin"
                role="img"
                aria-label="生成中"
              />
              <span v-else-if="m.status === 'stopped'" class="mt-1 block text-xs text-ink-muted">
                已停止
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="shrink-0 px-6 pb-5 pt-3 bg-surface">
      <div class="mx-auto w-full max-w-[840px]">
        <AgentComposer
          ref="composerRef"
          variant="standard"
          placeholder="对主会话进行解读、释疑、探索或分支推演"
          hint="Enter 发送，Shift+Enter 换行"
          :value="input"
          :streaming="streaming"
          send-label="发送"
          stop-label="停止"
          @update:value="input = $event"
          @submit="send"
          @stop="stop"
        >
          <template #attachment>
            <div
              v-if="pendingAttachments.length"
              class="mb-2 flex flex-col gap-1"
              data-testid="side-text-attachments"
            >
              <div
                v-for="a in pendingAttachments"
                :key="a.id"
                class="flex items-start gap-2 rounded-lg border border-line-subtle bg-subtle/40 px-2.5 py-1.5 text-xs"
              >
                <span class="shrink-0 font-medium text-ink-secondary">选中文字</span>
                <span class="min-w-0 flex-1 truncate text-ink-muted">{{ a.preview }}</span>
                <button
                  class="shrink-0 text-link hover:underline"
                  @click="sideTask.removeAttachment(a.id)"
                >
                  移除
                </button>
              </div>
            </div>
          </template>
        </AgentComposer>
        <p v-if="!useMainContext" class="mt-2 px-1 text-xs text-ink-muted">
          未引用主会话上下文：仅按本次临时会话的对话作答。
        </p>
      </div>
    </div>
  </section>
</template>
