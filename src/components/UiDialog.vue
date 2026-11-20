<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'

// 模态对话框（方案 §4.3/§7）：遮罩 + 焦点限制 + Esc 关闭 + 关闭后恢复焦点（F18/F20）
const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: String, default: '480px' },
  hideClose: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const panel = ref(null)
let lastFocus = null

watch(
  () => props.open,
  async (v) => {
    if (v) {
      lastFocus = document.activeElement
      await nextTick()
      if (panel.value) {
        const target = panel.value.querySelector('[data-autofocus]') || panel.value
        target.focus && target.focus()
      }
    } else if (lastFocus && lastFocus.focus) {
      lastFocus.focus()
      lastFocus = null
    }
  }
)

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
    return
  }
  if (e.key !== 'Tab' || !panel.value) return
  // 简易焦点圈：Tab 在对话框内循环
  const items = panel.value.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

onBeforeUnmount(() => {
  if (lastFocus && lastFocus.focus) lastFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background: var(--overlay)"
      @keydown="onKeydown"
    >
      <div class="absolute inset-0" aria-hidden="true" @click="!hideClose && emit('close')" />
      <div
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        class="relative flex max-h-full flex-col rounded-2xl border border-line-subtle bg-elevated shadow-modal"
        :style="{ width }"
      >
        <div
          class="flex shrink-0 items-center justify-between px-5 py-3.5 border-b border-line-subtle"
        >
          <h2 class="text-base font-semibold">{{ title }}</h2>
          <button v-if="!hideClose" class="icon-btn-sm" aria-label="关闭" @click="emit('close')">
            <UiIcon name="close" :size="18" />
          </button>
        </div>
        <div class="scroll-region flex-1 px-5 py-4">
          <slot />
        </div>
        <div
          v-if="$slots.footer"
          class="flex shrink-0 justify-end gap-2 px-5 py-3.5 border-t border-line-subtle"
        >
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
