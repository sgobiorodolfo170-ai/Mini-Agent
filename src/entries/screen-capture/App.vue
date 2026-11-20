<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const dragging = ref(false)
const start = ref({ x: 0, y: 0 })
const rect = ref({ x: 0, y: 0, width: 0, height: 0 })

function pd(e) {
  // 右键取消截图（与 Esc 等价的退出方式）
  if (e.button === 2) {
    e.preventDefault()
    cancel()
    return
  }
  if (e.button !== 0) return
  dragging.value = true
  start.value = { x: e.clientX, y: e.clientY }
  rect.value = { x: e.clientX, y: e.clientY, width: 0, height: 0 }
}

function pm(e) {
  if (!dragging.value) return
  const x = Math.min(start.value.x, e.clientX)
  const y = Math.min(start.value.y, e.clientY)
  rect.value = {
    x,
    y,
    width: Math.abs(e.clientX - start.value.x),
    height: Math.abs(e.clientY - start.value.y)
  }
}

async function pu() {
  if (!dragging.value) return
  dragging.value = false
  if (rect.value.width > 5 && rect.value.height > 5) await window.api.finish({ ...rect.value })
  else await window.api.cancel()
}

// 取消只触发一次，避免右键与 mouseup 重复调用
let cancelled = false
function cancel() {
  if (cancelled) return
  cancelled = true
  dragging.value = false
  window.api.cancel()
}

function key(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}

// 截图遮罩用右键菜单会打断操作，统一屏蔽
function menu(e) {
  e.preventDefault()
}

onMounted(() => {
  window.addEventListener('mousedown', pd)
  window.addEventListener('mousemove', pm)
  window.addEventListener('mouseup', pu)
  window.addEventListener('keydown', key)
  window.addEventListener('contextmenu', menu)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', pd)
  window.removeEventListener('mousemove', pm)
  window.removeEventListener('mouseup', pu)
  window.removeEventListener('keydown', key)
  window.removeEventListener('contextmenu', menu)
})
</script>

<template>
  <div class="fixed inset-0 cursor-crosshair">
    <div
      v-if="dragging || rect.width"
      class="absolute border-2 border-indigo-400 bg-indigo-500/10"
      :style="{
        left: rect.x + 'px',
        top: rect.y + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
        boxShadow: '0 0 0 100000px rgba(0, 0, 0, 0.35)'
      }"
    >
      <div class="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-indigo-500 text-white text-xs">
        {{ rect.width }} × {{ rect.height }}
      </div>
    </div>
    <div
      v-else
      class="absolute top-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-black/60 text-white text-xs"
    >
      拖拽框选截图区域，Esc 或右键取消
    </div>
  </div>
</template>

<style>
html,
body {
  background: transparent !important;
}
</style>
