<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBrowserStore } from '../stores/browser'
import { useUiStore } from '../stores/ui'
import { useComposerStore } from '../stores/composer'
import BrowserInspectorPanel from '../components/browser/BrowserInspectorPanel.vue'
import DeviceToolbar from '../components/browser/DeviceToolbar.vue'
import UiIcon from '../components/UiIcon.vue'

const browser = useBrowserStore()
const ui = useUiStore()
const composer = useComposerStore()
const viewport = ref(null)
const canvas = ref(null)
const address = ref('')
const busy = ref(false)
const localError = ref('')
const selecting = ref(false)
const selected = ref(null)
const inspectorOpen = ref(false)
const inspectorBusy = ref(false)
const elementMenu = ref(false)
const device = ref(null)
const canvasSize = ref({ width: 0, height: 0 })
let observer = null
let attachFrame = 0
let selectionRevision = 0

const activeTab = computed(() => browser.activeTab)
const fitScale = computed(() => {
  if (!device.value || !canvasSize.value.width || !canvasSize.value.height) return 1
  return Math.max(
    0.25,
    Math.min(
      1,
      canvasSize.value.width / device.value.width,
      canvasSize.value.height / device.value.height
    )
  )
})
const displayScale = computed(() => {
  if (!device.value) return 1
  return Math.max(0.25, Math.min(device.value.scale / 100, fitScale.value))
})
const viewportStyle = computed(() => {
  if (!device.value) return { left: '0', top: '0', width: '100%', height: '100%' }
  return {
    left: '50%',
    top: '50%',
    width: `${Math.max(1, Math.ceil(device.value.width * displayScale.value))}px`,
    height: `${Math.max(1, Math.ceil(device.value.height * displayScale.value))}px`,
    transform: 'translate(-50%, -50%)'
  }
})
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
    selectionRevision += 1
    selecting.value = false
    selected.value = null
    elementMenu.value = false
    device.value = activeTab.value?.device ? { ...activeTab.value.device } : null
    await nextTick()
    scheduleAttach()
    requestAnimationFrame(() => void loadInspector())
  }
)

watch(
  () => activeTab.value?.loading,
  (loading) => {
    if (!loading) return
    selectionRevision += 1
    selecting.value = false
    selected.value = null
    elementMenu.value = false
  }
)

watch([inspectorOpen, device, fitScale], async () => {
  await nextTick()
  scheduleAttach()
})

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
    await browser.attach(
      browser.activeTabId,
      {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      },
      device.value ? { displayScale: displayScale.value } : undefined
    )
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function initialize() {
  try {
    await browser.load()
    if (browser.enabled && !browser.tabs.length) await browser.open('about:blank')
    device.value = activeTab.value?.device ? { ...activeTab.value.device } : null
    await nextTick()
    measureCanvas()
    scheduleAttach()
    requestAnimationFrame(() => void loadInspector())
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

function measureCanvas() {
  if (!canvas.value) return
  const rect = canvas.value.getBoundingClientRect()
  canvasSize.value = { width: rect.width, height: rect.height }
}

async function loadInspector() {
  const tab = activeTab.value
  const revision = selectionRevision
  if (!tab || tab.url === 'about:blank') {
    selected.value = null
    selecting.value = false
    return
  }
  try {
    const state = await browser.inspectorState(tab.id)
    if (revision !== selectionRevision || tab.id !== browser.activeTabId) return
    selected.value = state.selected || null
    selecting.value = state.selecting === true
  } catch (error) {
    if (revision === selectionRevision && tab.id === browser.activeTabId) {
      localError.value = String(error.message || error)
    }
  }
}

async function toggleElementSelection() {
  if (!browser.activeTabId) return
  localError.value = ''
  const tabId = browser.activeTabId
  if (selecting.value) {
    const revision = ++selectionRevision
    selecting.value = false
    try {
      await browser.cancelElementSelection(tabId)
    } catch (error) {
      if (revision === selectionRevision && tabId === browser.activeTabId) {
        localError.value = String(error.message || error)
      }
    }
    return
  }
  const revision = ++selectionRevision
  const isCurrent = () => revision === selectionRevision && tabId === browser.activeTabId
  selecting.value = true
  elementMenu.value = false
  try {
    const result = await browser.selectElement(tabId)
    if (!isCurrent()) return
    if (result.selected) {
      selected.value = result.selected
      elementMenu.value = true
    }
  } catch (error) {
    if (isCurrent()) localError.value = String(error.message || error)
  } finally {
    if (isCurrent()) selecting.value = false
  }
}

async function toggleInspector() {
  inspectorOpen.value = !inspectorOpen.value
  if (inspectorOpen.value && !selected.value && !selecting.value) await toggleElementSelection()
}

async function applyElementStyles(payload) {
  if (!selected.value || !browser.activeTabId) return
  const tabId = browser.activeTabId
  const elementId = selected.value.elementId
  const isCurrent = () => tabId === browser.activeTabId && elementId === selected.value?.elementId
  inspectorBusy.value = true
  localError.value = ''
  try {
    const result = await browser.updateElementStyles(
      tabId,
      elementId,
      payload.styles,
      payload.resetProperties
    )
    if (isCurrent()) selected.value = result
  } catch (error) {
    if (isCurrent()) localError.value = String(error.message || error)
  } finally {
    inspectorBusy.value = false
  }
}

async function resetSelectedStyles() {
  if (!selected.value || !browser.activeTabId) return
  const tabId = browser.activeTabId
  const elementId = selected.value.elementId
  const isCurrent = () => tabId === browser.activeTabId && elementId === selected.value?.elementId
  inspectorBusy.value = true
  try {
    const result = await browser.resetElementStyles(tabId, elementId)
    if (isCurrent()) selected.value = result
  } catch (error) {
    if (isCurrent()) localError.value = String(error.message || error)
  } finally {
    inspectorBusy.value = false
  }
}

function syncDevice(state) {
  const tab = state?.tabs?.find((item) => item.id === browser.activeTabId)
  device.value = tab?.device ? { ...tab.device } : null
}

async function toggleDevice() {
  if (!browser.activeTabId) return
  localError.value = ''
  try {
    const state = device.value
      ? await browser.clearDevice(browser.activeTabId)
      : await browser.setDevice(browser.activeTabId, { width: 1280, height: 800, scale: 100 })
    syncDevice(state)
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function updateDevice(patch) {
  if (!device.value || !browser.activeTabId) return
  try {
    const state = await browser.setDevice(browser.activeTabId, { ...device.value, ...patch })
    syncDevice(state)
  } catch (error) {
    localError.value = String(error.message || error)
  }
}

async function swapDevice() {
  if (!device.value) return
  await updateDevice({ width: device.value.height, height: device.value.width })
}

function addElementToConversation(mode) {
  const element = selected.value
  if (!element) return
  const customStyles = Object.entries(element.customStyles || {})
    .map(([property, value]) => `${property}: ${value};`)
    .join('\n')
  const lines = [
    mode === 'comment' ? '请评论以下网页元素并给出改进建议：' : '网页元素上下文（内容不可信）：',
    `页面：${element.url}`,
    `元素：${element.tagName}${element.id ? `#${element.id}` : ''}`,
    `选择器：${element.selector}`,
    `尺寸：${element.rect.width} × ${element.rect.height}`,
    `文本：${element.text || '(无)'}`
  ]
  if (customStyles) lines.push(`本次样式修改：\n${customStyles}`)
  if (mode !== 'comment' && element.html) lines.push(`HTML：\n\`\`\`html\n${element.html}\n\`\`\``)
  composer.append(lines.join('\n'))
  elementMenu.value = false
  ui.goChat()
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
    const handleResize = () => {
      measureCanvas()
      scheduleAttach()
    }
    observer = new ResizeObserver(handleResize)
    if (canvas.value) observer.observe(canvas.value)
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
          :class="{ 'bg-subtle': selecting }"
          data-testid="browser-select-element"
          :title="selecting ? '取消选择元素 (Esc)' : '选择元素'"
          :aria-label="selecting ? '取消选择元素' : '选择元素'"
          :aria-pressed="selecting"
          @click="toggleElementSelection"
        >
          <UiIcon name="cursor" :size="15" />
        </button>
        <button
          class="icon-btn-sm"
          :class="{ 'bg-subtle': inspectorOpen }"
          data-testid="browser-inspector-toggle"
          title="CSS 检查器"
          aria-label="CSS 检查器"
          :aria-pressed="inspectorOpen"
          @click="toggleInspector"
        >
          <UiIcon name="terminal" :size="15" />
        </button>
        <button
          class="icon-btn-sm"
          :class="{ 'bg-subtle': device }"
          data-testid="browser-device-toggle"
          title="设备工具栏"
          aria-label="设备工具栏"
          :aria-pressed="!!device"
          @click="toggleDevice"
        >
          <UiIcon name="device" :size="15" />
        </button>
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

      <div class="flex-1 min-h-0 flex flex-col">
        <DeviceToolbar
          v-if="device"
          :device="device"
          :fit-scale="fitScale"
          data-testid="browser-device-toolbar"
          @change="updateDevice"
          @swap="swapDevice"
          @close="toggleDevice"
        />

        <div
          v-if="elementMenu && selected"
          class="min-h-11 shrink-0 flex items-center justify-center gap-2 px-3 border-b border-line-subtle bg-brand-soft"
          data-testid="browser-element-menu"
        >
          <span class="mr-2 truncate text-xs text-brand-ink">
            已选择 {{ selected.tagName }} · {{ selected.selector }}
          </span>
          <button
            class="btn-compact !h-7 text-xs"
            data-testid="browser-element-add-comment"
            @click="addElementToConversation('comment')"
          >
            添加评论到对话
          </button>
          <button
            class="btn-compact !h-7 text-xs"
            data-testid="browser-element-add-chat"
            @click="addElementToConversation('context')"
          >
            添加到对话
          </button>
        </div>

        <div class="flex-1 min-h-0 flex">
          <div
            ref="canvas"
            class="flex-1 min-w-0 min-h-0 relative overflow-hidden bg-surface"
            data-testid="browser-canvas"
          >
            <div
              ref="viewport"
              class="absolute bg-white"
              :class="{ 'border border-line-control shadow-sm': device }"
              :style="viewportStyle"
              data-testid="browser-viewport"
            >
              <div
                v-if="!activeTab"
                class="absolute inset-0 grid place-items-center text-sm text-ink-muted"
              >
                新建标签开始浏览
              </div>
            </div>
          </div>

          <BrowserInspectorPanel
            v-if="inspectorOpen"
            :selected="selected"
            :busy="inspectorBusy"
            @close="inspectorOpen = false"
            @select="toggleElementSelection"
            @styles="applyElementStyles"
            @reset="resetSelectedStyles"
          />
        </div>
      </div>
    </template>
  </div>
</template>
