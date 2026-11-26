<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from '../components/UiIcon.vue'

// 终端控制台：逐条执行命令并流式展示输出。每条命令是独立进程，
// 不保存 cd 等会话状态，执行目录由顶部的工作区选择决定。
const roots = ref([])
const cwd = ref('')
const lines = ref([])
const input = ref('')
const running = ref(false)
const outputEl = ref(null)
const history = ref([])
const historyIndex = ref(-1)
let off = null
let seq = 0
let runId = ''
const MAX_LINES = 2000

function push(kind, text) {
  if (!text) return
  lines.value.push({ id: ++seq, kind, text })
  if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES)
  nextTick(() => {
    const el = outputEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function handleEvent(ev) {
  if (!ev || ev.id !== runId) return
  if (ev.type === 'data') {
    push(ev.stream === 'stderr' ? 'stderr' : 'stdout', ev.text)
  } else if (ev.type === 'exit') {
    if (ev.code !== 0 && ev.code !== null) push('meta', `[退出码 ${ev.code}]`)
    running.value = false
  } else if (ev.type === 'error') {
    push('stderr', ev.message || '命令执行失败')
    running.value = false
  }
}

function makeId() {
  return 'term-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
}

async function run() {
  const command = input.value.trim()
  if (!command || running.value) return
  history.value.push(command)
  historyIndex.value = -1
  input.value = ''
  runId = makeId()
  running.value = true
  push('cmd', command)
  try {
    await window.api.terminal.run({ id: runId, command, cwd: cwd.value || undefined })
  } catch (e) {
    push('stderr', String((e && e.message) || e))
    running.value = false
  }
}

async function stop() {
  if (!runId) return
  try {
    await window.api.terminal.stop(runId)
  } catch {
    // 进程可能已经结束
  }
}

function clear() {
  lines.value = []
}

function historyPrev() {
  if (!history.value.length) return
  historyIndex.value =
    historyIndex.value < 0 ? history.value.length - 1 : Math.max(0, historyIndex.value - 1)
  input.value = history.value[historyIndex.value] || ''
}

function historyNext() {
  if (historyIndex.value < 0) return
  historyIndex.value += 1
  if (historyIndex.value >= history.value.length) {
    historyIndex.value = -1
    input.value = ''
  } else {
    input.value = history.value[historyIndex.value] || ''
  }
}

onMounted(async () => {
  off = window.api.on('terminal:event', handleEvent)
  try {
    roots.value = await window.api.workspace.roots()
    if (roots.value.length) cwd.value = roots.value[0].path
  } catch {
    roots.value = []
  }
  push('meta', '终端已就绪：命令在所选工作区目录中执行，Ctrl+C 可使用「停止」按钮代替。')
})
onBeforeUnmount(() => {
  if (off) off()
  if (running.value) stop()
})
</script>

<template>
  <section
    class="flex-1 min-w-0 flex flex-col m-3 chat-surface overflow-hidden"
    data-testid="terminal-view"
  >
    <header
      class="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-line-subtle bg-surface"
    >
      <UiIcon name="terminal" :size="17" class="text-brand-ink" />
      <span class="text-sm font-semibold shrink-0">终端</span>
      <select
        v-model="cwd"
        class="field-input !h-7 !py-0 text-xs w-64 ml-2"
        aria-label="命令执行目录"
        data-testid="terminal-cwd"
        :disabled="running"
      >
        <option v-if="!roots.length" value="">默认目录</option>
        <option v-for="r in roots" :key="r.id" :value="r.path">{{ r.name }}</option>
      </select>
      <div class="flex-1" />
      <button
        v-if="running"
        class="btn-compact !h-7 !px-3 text-xs"
        data-testid="terminal-stop"
        @click="stop"
      >
        停止
      </button>
      <button class="btn-compact !h-7 !px-3 text-xs" data-testid="terminal-clear" @click="clear">
        清空
      </button>
    </header>

    <div
      ref="outputEl"
      class="flex-1 min-h-0 overflow-y-auto bg-subtle/50 px-4 py-3 font-mono text-xs leading-relaxed"
      data-testid="terminal-output"
      aria-live="polite"
    >
      <div v-if="!lines.length" class="text-ink-muted">输入命令后按 Enter 执行。</div>
      <div
        v-for="line in lines"
        :key="line.id"
        :class="{
          'text-ink-secondary': line.kind === 'stdout',
          'text-bad-ink': line.kind === 'stderr',
          'text-ink-muted': line.kind === 'meta',
          'text-brand-ink': line.kind === 'cmd'
        }"
        class="whitespace-pre-wrap break-words"
      >
        <span v-if="line.kind === 'cmd'" class="select-none">PS&gt; </span>{{ line.text }}
      </div>
    </div>

    <div class="h-12 shrink-0 flex items-center gap-2 px-4 border-t border-line-subtle bg-surface">
      <span class="font-mono text-xs text-brand-ink select-none">PS&gt;</span>
      <input
        v-model="input"
        class="flex-1 min-w-0 bg-transparent font-mono text-xs outline-none"
        placeholder="输入命令，Enter 执行；↑/↓ 调用历史"
        aria-label="终端命令输入"
        data-testid="terminal-input"
        spellcheck="false"
        autocomplete="off"
        @keydown.enter.prevent="run"
        @keydown.up.prevent="historyPrev"
        @keydown.down.prevent="historyNext"
      />
      <button
        class="btn-compact !h-7 !px-3 text-xs"
        :disabled="!input.trim() || running"
        data-testid="terminal-run"
        @click="run"
      >
        {{ running ? '执行中' : '执行' }}
      </button>
    </div>
  </section>
</template>
