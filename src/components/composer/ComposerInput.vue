<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from '../UiIcon.vue'

// 输入区：只负责文本输入本身（自动增高、Enter 发送、Shift+Enter 换行、IME 守卫）。
// 不读取模型 / 权限 / 任务状态，全部由上层 AgentComposer 决定。
const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '消息输入框' },
  describedBy: { type: String, default: undefined },
  maxHeight: { type: Number, default: 160 }
})
const emit = defineEmits(['update:modelValue', 'submit'])

const el = ref(null)
const menu = ref(null)
const menuEl = ref(null)

function resize() {
  const node = el.value
  if (!node) return
  node.style.height = 'auto'
  node.style.height = Math.min(props.maxHeight, node.scrollHeight) + 'px'
  // 超过最大高度后由输入区内部滚动，不再撑高卡片
  node.style.overflowY = node.scrollHeight > props.maxHeight ? 'auto' : 'hidden'
}

function focus() {
  if (el.value) el.value.focus()
}

function onInput(e) {
  emit('update:modelValue', e.target.value)
  resize()
}

function onKeydown(e) {
  // 输入法组合期间 Enter 只确认候选，不发送（keyCode 229 覆盖旧版 IME）
  if (e.isComposing || e.keyCode === 229) return
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  emit('submit')
}

// ---------- 右击菜单：复制 / 粘贴 ----------
function openMenu(e) {
  e.preventDefault()
  if (props.disabled) return
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    style: { top: '0px', left: '0px', visibility: 'hidden' }
  }
  nextTick(() => {
    const node = menuEl.value
    if (!node || !menu.value) return
    const mw = node.offsetWidth
    const mh = node.offsetHeight
    const left = Math.max(8, Math.min(menu.value.x, window.innerWidth - mw - 8))
    const top = Math.max(8, Math.min(menu.value.y, window.innerHeight - mh - 8))
    menu.value = { ...menu.value, style: { top: `${top}px`, left: `${left}px` } }
  })
}

function closeMenu() {
  menu.value = null
}

async function writeClipboard(text) {
  try {
    if (window.api && window.api.sys && window.api.sys.clipboardWrite) {
      await window.api.sys.clipboardWrite(text)
      return
    }
  } catch {
    /* 回退到浏览器剪贴板 */
  }
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    try {
      el.value && el.value.select()
      document.execCommand('copy')
    } catch {
      /* 忽略复制失败 */
    }
  }
}

async function readClipboard() {
  try {
    if (window.api && window.api.sys && window.api.sys.clipboardRead) {
      const text = await window.api.sys.clipboardRead()
      if (typeof text === 'string') return text
    }
  } catch {
    /* 回退到浏览器剪贴板 */
  }
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

async function copySelection() {
  const node = el.value
  if (node) {
    const text = node.value.slice(node.selectionStart, node.selectionEnd) || node.value
    await writeClipboard(text)
  }
  closeMenu()
  focus()
}

async function pasteClipboard() {
  const node = el.value
  const text = await readClipboard()
  if (node && text) {
    node.focus()
    node.setRangeText(text, node.selectionStart, node.selectionEnd, 'end')
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }
  closeMenu()
}

function onPointerDown(e) {
  if (!menu.value) return
  if (menuEl.value && menuEl.value.contains(e.target)) return
  closeMenu()
}
function onKeydownGlobal(e) {
  if (e.key === 'Escape') closeMenu()
}
function onViewportChange() {
  if (menu.value) closeMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKeydownGlobal)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('keydown', onKeydownGlobal)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})

// 程序化改值（发送成功后清空、失败回填）同样需要重算高度
watch(
  () => props.modelValue,
  () => nextTick(resize)
)
onMounted(resize)

defineExpose({ focus, resize })
</script>

<template>
  <textarea
    ref="el"
    class="ac-textarea"
    rows="1"
    :value="modelValue"
    :placeholder="placeholder"
    :aria-label="label"
    :aria-describedby="describedBy"
    :disabled="disabled"
    spellcheck="false"
    data-testid="chat-input"
    @input="onInput"
    @keydown="onKeydown"
    @contextmenu="openMenu"
  />
  <Teleport to="body">
    <div
      v-if="menu"
      ref="menuEl"
      class="fixed z-[80] w-32 rounded-xl border border-line-subtle bg-elevated py-1 shadow-menu"
      role="menu"
      aria-label="输入框操作"
      :style="menu.style"
      @contextmenu.prevent
    >
      <button
        type="button"
        role="menuitem"
        class="flex h-9 w-full items-center gap-2 px-3 text-sm text-ink-primary hover:bg-subtle"
        @click="copySelection"
      >
        <UiIcon name="copy" :size="14" class="shrink-0" />
        <span>复制</span>
      </button>
      <button
        type="button"
        role="menuitem"
        class="flex h-9 w-full items-center gap-2 px-3 text-sm text-ink-primary hover:bg-subtle"
        @click="pasteClipboard"
      >
        <UiIcon name="clipboard" :size="14" class="shrink-0" />
        <span>粘贴</span>
      </button>
    </div>
  </Teleport>
</template>
