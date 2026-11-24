<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBrowserStore } from '../stores/browser'
import { useUiStore } from '../stores/ui'
import UiIcon from '../components/UiIcon.vue'

const browser = useBrowserStore()
const ui = useUiStore()
const viewport = ref(null)
const address = ref('')
const busy = ref(false)
const localError = ref('')
let observer = null
let attachFrame = 0

const activeTab = computed(() => browser.activeTab)
const pageError = computed(() => {
  const value = (activeTab.value && activeTab.value.error) || localError.value || ''
  return String(value).replace(
    /^(?:Error invoking remote method '[^']+':\s*|(?:BrowserPolicyError|BrowserError|Error):\s*)/,
    ''
  )
})

watch(
  () => activeTab.value && activeTab.value.url,
  (url) => {
    address.value = url && url !== 'about:blank' ? url : ''
  }
)

watch(
  () => browser.activeTabId,
  async () => {
    await nextTick()
    scheduleAttach()
  }
)

function scheduleAttach() {
  if (attachFrame) cancelAnimationFrame(attachFrame)
  attachFrame = requestAnimationFrame(() => {
    attachFrame = 0
    void attachActive()
  })
}

async function attachActive() {
  if (!browser.enabled || !browser.activeTabId || !viewport.value) return
  const rect = viewport.value.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return
  try {
    await browser.attach(browser.activeTabId, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    })
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function initialize() {
  try {
    await browser.load()
    if (browser.enabled && !browser.tabs.length) await browser.open('about:blank')
    await nextTick()
    scheduleAttach()
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function submitAddress() {
  const value = address.value.trim()
  if (!value || busy.value) return
  busy.value = true
  localError.value = ''
  try {
    await browser.navigate(value)
  } catch (error) {
    localError.value = String(error.message || error)
  } finally {
    busy.value = false
  }
}

async function newTab() {
  localError.value = ''
  try {
    const tab = await browser.open('about:blank')
    await browser.activate(tab.id)
    await nextTick()
    scheduleAttach()
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function closeTab(event, tabId) {
  event.stopPropagation()
  try {
    await browser.close(tabId)
    await nextTick()
    scheduleAttach()
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function runCommand(command) {
  localError.value = ''
  try {
    await browser.command(command)
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function toggleDevTools() {
  if (!browser.activeTabId) return
  localError.value = ''
  try {
    await browser.toggleDevTools(browser.activeTabId)
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

function handleF12(event) {
  if (event.key !== 'F12' || event.repeat || !browser.activeTabId) return
  event.preventDefault()
  void toggleDevTools()
}

async function takeover() {
  if (!activeTab.value) return
  await browser.takeover(activeTab.value.id)
}

async function release() {
  if (!activeTab.value) return
  await browser.release(activeTab.value.id)
}

async function takeScreenshot() {
  if (!activeTab.value) return
  try {
    const shot = await browser.screenshot()
    ui.toast(`页面截图已保存：${shot.path}`, 'success')
  } catch (error) {
    ui.toast('截图失败：' + String(error.message || error), 'error')
  }
}

async function enableBrowser() {
  await browser.setEnabled(true)
  await initialize()
}

onMounted(async () => {
  window.addEventListener('keydown', handleF12)
  await initialize()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleAttach)
    if (viewport.value) observer.observe(viewport.value)
  }
})

onBeforeUnmount(async () => {
  window.removeEventListener('keydown', handleF12)
  if (attachFrame) cancelAnimationFrame(attachFrame)
  if (observer) observer.disconnect()
  try {
    await browser.detach()
  } catch {
    // 主窗口关闭时视图可能已经销毁
  }
})
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-surface" data-testid="browser-view">
    <div v-if="!browser.enabled" class="flex-1 grid place-items-center p-8">
      <div class="max-w-md text-center space-y-3">
        <UiIcon name="monitor" :size="36" class="mx-auto text-ink-muted" />
        <h2 class="text-base font-semibold text-ink-primary">内置浏览器已停用</h2>
        <p class="text-sm text-ink-secondary">
          停用后会关闭所有浏览器标签。启用后，用户标签与 Agent 临时标签仍保持登录态隔离。
        </p>
        <button class="btn-primary" data-testid="browser-enable" @click="enableBrowser">
          启用浏览器
        </button>
      </div>
    </div>

    <template v-else>
      <div class="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-line-subtle bg-panel">
        <div
          v-for="tab in browser.tabs"
          :key="tab.id"
          class="h-7 max-w-[220px] px-2.5 rounded-md flex items-center gap-2 text-xs border cursor-pointer"
          :class="
            tab.id === browser.activeTabId
              ? 'bg-surface text-ink-primary border-line-control'
              : 'text-ink-secondary border-transparent hover:bg-subtle'
          "
          :data-testid="'browser-tab-' + tab.id"
          role="button"
          tabindex="0"
          @click="browser.activate(tab.id)"
          @keydown.enter="browser.activate(tab.id)"
        >
          <span
            v-if="tab.kind === 'agent'"
            class="w-1.5 h-1.5 rounded-full bg-brand shrink-0"
            title="Agent 临时标签"
          />
          <span class="truncate">{{ tab.title || tab.url || '新标签' }}</span>
          <button
            class="w-4 h-4 grid place-items-center rounded hover:bg-line-subtle shrink-0"
            :aria-label="'关闭标签 ' + (tab.title || tab.url)"
            @click="closeTab($event, tab.id)"
          >
            <UiIcon name="close" :size="10" />
          </button>
        </div>
        <button
          class="w-7 h-7 grid place-items-center rounded-md text-ink-secondary hover:bg-subtle"
          data-testid="browser-new-tab"
          title="新标签"
          aria-label="新标签"
          @click="newTab"
        >
          <UiIcon name="plus" :size="15" />
        </button>
      </div>

      <div
        class="min-h-9 shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-line-subtle bg-panel"
      >
        <button
          class="icon-btn-sm"
          data-testid="browser-back"
          title="后退"
          aria-label="后退"
          @click="runCommand('back')"
        >
          <UiIcon name="chevronLeft" :size="16" />
        </button>
        <button
          class="icon-btn-sm"
          data-testid="browser-forward"
          title="前进"
          aria-label="前进"
          @click="runCommand('forward')"
        >
          <UiIcon name="chevronRight" :size="16" />
        </button>
        <button
          class="icon-btn-sm"
          data-testid="browser-reload"
          title="刷新"
          aria-label="刷新"
          @click="runCommand('reload')"
        >
          <UiIcon name="refresh" :size="15" />
        </button>
        <form class="flex-1 min-w-0 flex items-center gap-1.5" @submit.prevent="submitAddress">
          <input
            v-model="address"
            class="field-input !h-8 !py-1 flex-1 min-w-0 text-xs"
            data-testid="browser-address"
            placeholder="输入 http(s) 地址"
            aria-label="浏览器地址"
            spellcheck="false"
          />
          <button
            class="btn-compact !h-8 !px-3 text-xs"
            data-testid="browser-go"
            type="submit"
            :disabled="busy"
          >
            {{ busy ? '打开中' : '打开' }}
          </button>
        </form>
        <button
          class="icon-btn-sm"
          :class="{ 'bg-subtle': activeTab && activeTab.devToolsOpened }"
          data-testid="browser-devtools"
          :title="
            activeTab && activeTab.devToolsOpened ? '关闭开发者工具 (F12)' : '开发者工具 (F12)'
          "
          :aria-label="activeTab && activeTab.devToolsOpened ? '关闭开发者工具' : '打开开发者工具'"
          :aria-pressed="!!(activeTab && activeTab.devToolsOpened)"
          :disabled="!activeTab"
          @click="toggleDevTools"
        >
          <UiIcon name="terminal" :size="15" />
        </button>
        <button
          class="icon-btn-sm"
          data-testid="browser-screenshot"
          title="截图"
          aria-label="截图"
          @click="takeScreenshot"
        >
          <UiIcon name="eye" :size="15" />
        </button>
      </div>

      <div
        v-if="activeTab && activeTab.kind === 'agent'"
        class="min-h-8 shrink-0 px-3 flex items-center gap-2 text-xs border-b border-line-subtle"
        :class="
          activeTab.owner === 'agent' ? 'bg-brand-soft text-brand-ink' : 'bg-warn text-warn-ink'
        "
        data-testid="browser-agent-banner"
      >
        <UiIcon :name="activeTab.owner === 'agent' ? 'shield' : 'warn'" :size="13" />
        <span class="flex-1 truncate">
          {{
            activeTab.owner === 'agent'
              ? 'Agent 正在操作此临时标签，页面鼠标与键盘已锁定。'
              : '当前由你人工接管，Agent 调用会被拒绝。'
          }}
        </span>
        <button
          v-if="activeTab.owner === 'agent'"
          class="btn-compact !h-6 !px-2 text-xs"
          data-testid="browser-takeover"
          @click="takeover"
        >
          人工接管
        </button>
        <button
          v-else
          class="btn-compact !h-6 !px-2 text-xs"
          data-testid="browser-release"
          @click="release"
        >
          交还 Agent
        </button>
      </div>

      <div
        v-if="pageError"
        class="min-h-8 shrink-0 px-3 flex items-center gap-2 text-xs bg-warn text-warn-ink border-b border-line-subtle"
        role="alert"
        data-testid="browser-error"
      >
        <UiIcon name="warn" :size="13" />
        <span class="flex-1 truncate" :title="pageError">{{ pageError }}</span>
        <button
          class="btn-compact !h-6 !px-2 text-xs"
          data-testid="browser-retry"
          :disabled="busy || !address.trim()"
          @click="submitAddress"
        >
          重试
        </button>
      </div>

      <div ref="viewport" class="flex-1 min-h-0 relative bg-white" data-testid="browser-viewport">
        <div
          v-if="!activeTab"
          class="absolute inset-0 grid place-items-center text-sm text-ink-muted"
        >
          新建标签开始浏览
        </div>
      </div>
    </template>
  </div>
</template>
