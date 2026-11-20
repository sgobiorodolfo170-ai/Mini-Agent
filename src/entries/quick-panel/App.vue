<script setup>
import { computed, onMounted, ref } from 'vue'
import MarkdownBody from '../../components/MarkdownBody.vue'
import UiIcon from '../../components/UiIcon.vue'

const mode = ref('ask')
const selectionText = ref('')
const customPrompt = ref('')
const convId = ref(null)
const msgs = ref([])
const input = ref('')
const streamingId = ref(null)
const sending = ref(false)
const bodyEl = ref(null)
const inputEl = ref(null)
const expandedSelection = ref(false)
const theme = ref('dark')

const lastAssistant = computed(() => [...msgs.value].reverse().find((m) => m.role === 'assistant'))
// 只展示最近 12 条，给出提示与完整历史入口（F19）
const visibleMsgs = computed(() => msgs.value.slice(-12))
const hiddenCount = computed(() => Math.max(0, msgs.value.length - 12))

onMounted(async () => {
  const t = await window.api.settings.get('theme')
  theme.value = t || 'dark'
  document.documentElement.classList.toggle(
    'dark',
    theme.value === 'dark' ||
      (theme.value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  )

  const list = await window.api.conversations.list()
  let conv = list.find((c) => c.title === '快速问答')
  if (!conv) conv = await window.api.conversations.create({ title: '快速问答' })
  convId.value = conv.id
  await loadMessages()

  window.api.on('quick:activated', async () => {
    await loadMessages()
    mode.value = 'ask'
    setTimeout(() => inputEl.value && inputEl.value.focus(), 50)
  })
  window.api.on('quick:selection', ({ text }) => {
    mode.value = 'selection'
    selectionText.value = text
    setTimeout(() => inputEl.value && inputEl.value.focus(), 50)
  })
  window.api.on('chat:event', (ev) => {
    if (ev.type === 'snapshot') {
      if (ev.conversationId === convId.value) for (const m of ev.messages || []) upsert(m)
      return
    }
    const m = msgs.value.find((x) => x.id === ev.msgId)
    if (!m) return
    if (ev.type === 'delta') {
      m.content += ev.delta
      m.status = 'streaming'
    } else if (ev.type === 'done') {
      m.content = ev.content
      m.status = 'done'
      streamingId.value = null
    } else if (ev.type === 'stopped') {
      m.status = 'stopped'
      streamingId.value = null
    } else if (ev.type === 'error') {
      m.status = 'error'
      streamingId.value = null
    }
    scrollBottom()
  })
  setTimeout(() => inputEl.value && inputEl.value.focus(), 100)
})

async function loadMessages() {
  if (!convId.value) return
  const rows = await window.api.conversations.messages(convId.value)
  msgs.value = rows
}

function upsert(m) {
  const i = msgs.value.findIndex((x) => x.id === m.id)
  if (i >= 0) msgs.value[i] = m
  else msgs.value.push(m)
  scrollBottom()
}

function scrollBottom() {
  requestAnimationFrame(() => {
    const el = bodyEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function sendText(text) {
  const content = (text || '').trim()
  if (!content || streamingId.value || sending.value) return
  sending.value = true
  // 先保留快照，请求确认后才清空输入（F06：失败可恢复）
  const snapshot = content
  input.value = ''
  mode.value = 'ask'
  selectionText.value = ''
  try {
    const r = await window.api.chat.send({ conversationId: convId.value, content })
    streamingId.value = r.assistantMsgId
  } catch {
    input.value = snapshot
    streamingId.value = null
  } finally {
    sending.value = false
  }
}

function send() {
  sendText(input.value)
}

// 输入随内容增高，约三行后内部滚动（方案 6.5）
function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(72, el.scrollHeight) + 'px'
}

function onKeydown(e) {
  // 中文输入法组合期间 Enter 只确认候选（F05）
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

// Esc 提升到窗口级：焦点在任何控件上都能收起窗口（F19）
function onWindowKeydown(e) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  window.api.app.hideQuick()
}

function useTemplate(t) {
  if (t === '翻译')
    sendText(
      '请翻译以下内容（中文译成英文，其他语言译成中文），只输出译文：\n\n' + selectionText.value
    )
  else if (t === '总结') sendText('请用简洁的中文总结以下内容：\n\n' + selectionText.value)
  else if (t === '解释') sendText('请解释以下内容的含义：\n\n' + selectionText.value)
  else if (t === '自定义' && customPrompt.value.trim())
    sendText(customPrompt.value.trim() + '\n\n' + selectionText.value)
}

async function copyResult() {
  if (lastAssistant.value) window.api.clipboard.write(lastAssistant.value.content)
}

function stopStream() {
  if (streamingId.value) window.api.chat.stop(streamingId.value)
}

function gotoMain() {
  window.api.app.showMain(convId.value)
}

function close() {
  window.api.app.hideQuick()
}
</script>

<template>
  <div
    class="h-full flex flex-col overflow-hidden border border-line-subtle bg-canvas text-ink rounded-xl"
    tabindex="-1"
    @keydown="onWindowKeydown"
  >
    <div
      class="h-10 shrink-0 flex items-center px-3 gap-2 bg-subtle select-none border-b border-line-subtle"
      style="-webkit-app-region: drag"
    >
      <UiIcon name="chat" :size="14" class="text-brand-ink" />
      <span class="text-xs text-ink-secondary">Mini Agent 快速问答</span>
      <div class="flex-1" />
      <button
        class="w-7 h-7 rounded-md hover:bg-surface text-ink-secondary hover:text-ink-primary flex items-center justify-center"
        style="-webkit-app-region: no-drag"
        title="收起 (Esc)"
        aria-label="收起窗口"
        @click="close"
      >
        <UiIcon name="close" :size="14" />
      </button>
    </div>

    <div
      v-if="mode === 'selection'"
      class="px-3 py-2 border-b border-line-subtle space-y-2 bg-subtle"
    >
      <details :open="!expandedSelection">
        <summary
          class="cursor-pointer select-none text-xs text-ink-secondary"
          @click="expandedSelection = !expandedSelection"
        >
          已捕获选中文本（{{ selectionText.length }} 字，点击展开/收起）
        </summary>
        <div
          class="text-xs text-ink-primary whitespace-pre-wrap max-h-32 overflow-y-auto mt-1.5 p-2 rounded-lg bg-surface border border-line-subtle"
        >
          {{ selectionText }}
        </div>
      </details>
      <div class="flex gap-1.5 flex-wrap items-center">
        <button
          v-for="t in ['翻译', '总结', '解释', '自定义']"
          :key="t"
          class="btn-compact border border-line-control bg-surface text-ink-secondary hover:text-brand-ink hover:border-brand"
          @click="useTemplate(t)"
        >
          {{ t }}
        </button>
        <input
          v-model="customPrompt"
          placeholder="自定义指令，如：改成敬语"
          aria-label="自定义指令"
          class="field-input !h-8 flex-1 min-w-[140px] text-xs"
          @keydown.enter="useTemplate('自定义')"
        />
      </div>
    </div>

    <div ref="bodyEl" class="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-sm scroll-region">
      <div v-if="hiddenCount > 0" class="text-center text-xs text-ink-muted">
        仅显示最近 12 条（省略了 {{ hiddenCount }} 条），点「主窗口」查看完整历史
      </div>
      <div
        v-for="m in visibleMsgs"
        :key="m.id"
        class="flex"
        :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[88%] min-w-0 message-text rounded-xl px-3 py-2"
          :class="
            m.role === 'user'
              ? 'bg-brand-soft text-ink-primary'
              : 'bg-surface border border-line-subtle'
          "
        >
          <span v-if="m.role === 'user'" class="whitespace-pre-wrap">{{ m.content }}</span>
          <MarkdownBody v-else :content="m.content" :streaming="m.status === 'streaming'" />
        </div>
      </div>
      <div
        v-if="!msgs.length"
        class="h-full flex items-center justify-center text-ink-muted text-xs"
      >
        输入问题开始提问；回答可复制或转到主窗口继续
      </div>
    </div>

    <div class="p-2.5 border-t border-line-subtle bg-subtle flex items-end gap-2">
      <textarea
        ref="inputEl"
        v-model="input"
        rows="1"
        placeholder="快速提问… (Enter 发送 / Esc 收起)"
        aria-label="快速提问输入框"
        class="field-area flex-1 max-h-24"
        @keydown="onKeydown"
        @input="autoGrow"
      />
      <button
        v-if="streamingId"
        class="btn h-9 px-3 rounded-lg text-xs bg-red-700 hover:bg-red-800 text-white shrink-0"
        @click="stopStream"
      >
        停止
      </button>
      <div v-else class="flex gap-1.5 shrink-0">
        <button
          v-if="lastAssistant && lastAssistant.content"
          class="btn-secondary !h-9 !px-3 text-xs"
          title="复制回答"
          @click="copyResult"
        >
          复制
        </button>
        <button class="btn-secondary !h-9 !px-3 text-xs" title="转到主窗口继续" @click="gotoMain">
          主窗口
        </button>
        <button
          class="btn-primary !h-9 !px-3.5 text-xs"
          :disabled="!input.trim() || sending"
          @click="send"
        >
          发送
        </button>
      </div>
    </div>
  </div>
</template>
