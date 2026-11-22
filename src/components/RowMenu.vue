<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from './UiIcon.vue'

// 行内「…」菜单：重命名 / 置顶 / 删除等操作收纳于此。
// 菜单通过 Teleport 固定定位，避免被滚动容器裁剪。
defineProps({
  items: { type: Array, required: true },
  label: { type: String, default: '更多操作' }
})

const open = ref(false)
const pos = ref(null)
const btnEl = ref(null)
const menuEl = ref(null)

async function toggle(e) {
  e.stopPropagation()
  if (open.value) {
    close()
    return
  }
  pos.value = null
  open.value = true
  await nextTick()
  layout()
}

function layout() {
  const btn = btnEl.value
  const menu = menuEl.value
  if (!btn || !menu) return
  const r = btn.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = r.right - mw
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8))
  let top = r.bottom + 4
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4)
  pos.value = { top: `${top}px`, left: `${left}px` }
}

function close() {
  open.value = false
  pos.value = null
}

function run(item) {
  close()
  if (item && typeof item.onSelect === 'function') item.onSelect()
}

function onPointerDown(e) {
  if (!open.value) return
  if (btnEl.value && btnEl.value.contains(e.target)) return
  if (menuEl.value && menuEl.value.contains(e.target)) return
  close()
}

function onKeydown(e) {
  if (e.key === 'Escape') close()
}

function onViewportChange() {
  if (open.value) close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <div class="shrink-0">
    <button
      ref="btnEl"
      type="button"
      class="icon-btn-sm !w-6 !h-6"
      :class="
        open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      "
      :title="label"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click.stop="toggle"
      @keydown.stop
    >
      <UiIcon name="more" :size="14" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuEl"
        class="fixed z-[75] w-36 rounded-xl border border-line-subtle bg-elevated py-1 shadow-menu"
        role="menu"
        :style="pos || { visibility: 'hidden', top: '0px', left: '0px' }"
        @keydown.esc.stop="close"
      >
        <button
          v-for="it in items"
          :key="it.id"
          type="button"
          role="menuitem"
          class="flex h-9 w-full items-center gap-2 px-3 text-sm hover:bg-subtle"
          :class="it.danger ? 'text-red-600 dark:text-red-400' : 'text-ink-primary'"
          @click="run(it)"
        >
          <UiIcon :name="it.icon" :size="15" class="shrink-0" />
          <span>{{ it.label }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
