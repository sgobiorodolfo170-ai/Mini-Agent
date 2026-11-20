<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from '../UiIcon.vue'

// 输入区弹出菜单：复用项目既有浮层语言（白底、细边框、shadow-menu、圆角 14px）。
// 只负责开合与键盘可达性；菜单项与选中值均由上层业务提供。
// header 非空时显示返回行，用于模型菜单的「提供商 → 模型」二级下钻。
const props = defineProps({
  open: { type: Boolean, default: false },
  align: { type: String, default: 'left' },
  label: { type: String, required: true },
  items: { type: Array, default: () => [] },
  emptyText: { type: String, default: '' },
  header: { type: String, default: '' },
  maxWidth: { type: String, default: '300px' }
})
const emit = defineEmits(['close', 'select', 'back'])

const panelEl = ref(null)
// 菜单项统一用 menuitemradio（可表达选中态），选择器需与此保持一致；
// 返回行是普通按钮，不参与该项遍历。
const ITEM_SELECTOR = '[role="menuitemradio"]:not([disabled])'

function onKeydown(e) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
    return
  }
  if (e.key === 'ArrowLeft' && props.header) {
    e.preventDefault()
    e.stopPropagation()
    emit('back')
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = Array.from(panelEl.value ? panelEl.value.querySelectorAll(ITEM_SELECTOR) : [])
  if (!items.length) return
  e.preventDefault()
  const idx = items.indexOf(document.activeElement)
  const next =
    e.key === 'ArrowDown'
      ? items[(idx + 1 + items.length) % items.length]
      : items[(idx - 1 + items.length) % items.length]
  next.focus()
}

function onDocPointerDown(e) {
  if (!props.open) return
  if (panelEl.value && panelEl.value.contains(e.target)) return
  // 触发按钮自身由调用方处理，避免“按下即关闭、抬起又打开”
  if (e.target && e.target.closest && e.target.closest('[data-composer-trigger]')) return
  emit('close')
}

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    await nextTick()
    const focusFirst = () => {
      const first = panelEl.value && panelEl.value.querySelector(ITEM_SELECTOR)
      if (first) first.focus()
    }
    focusFirst()
    // 触发按钮的 mousedown 焦点可能在本次 tick 之后才落定，再对齐一次
    setTimeout(focusFirst, 0)
  },
  { flush: 'post' }
)

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div
    v-if="open"
    ref="panelEl"
    class="ac-menu"
    :class="align === 'right' ? 'ac-menu--right' : 'ac-menu--left'"
    :style="{ maxWidth }"
    role="menu"
    :aria-label="label"
  >
    <button
      v-if="header"
      class="ac-menu__back"
      type="button"
      data-testid="composer-menu-back"
      @click="emit('back')"
    >
      <UiIcon name="chevronLeft" :size="14" />
      <span>{{ header }}</span>
    </button>
    <div v-if="header" class="ac-menu__title">{{ label }}</div>

    <button
      v-for="item in items"
      :key="item.id"
      class="ac-menu__item"
      role="menuitemradio"
      type="button"
      :aria-checked="item.selected ? 'true' : 'false'"
      :disabled="item.enabled === false"
      :title="item.disabledReason || undefined"
      @click="emit('select', item)"
    >
      <UiIcon v-if="item.icon" :name="item.icon" :size="15" class="ac-menu__icon" />
      <span class="ac-menu__text">
        <span class="ac-menu__label">{{ item.label }}</span>
        <span v-if="item.hint" class="ac-menu__hint">{{ item.hint }}</span>
      </span>
      <UiIcon v-if="item.selected" name="check" :size="15" class="ac-menu__check" />
      <UiIcon v-if="item.hasChildren" name="chevronRight" :size="14" class="ac-menu__chev" />
    </button>
    <div v-if="!items.length" class="ac-menu__empty">{{ emptyText || '暂无可选项' }}</div>
  </div>
</template>
