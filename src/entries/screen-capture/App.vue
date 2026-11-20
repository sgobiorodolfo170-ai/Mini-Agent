<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const dragging = ref(false)
const start = ref({ x: 0, y: 0 })
const rect = ref({ x: 0, y: 0, width: 0, height: 0 })

function pd(e) {
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

function key(e) {
  if (e.key === 'Escape') window.api.cancel()
}

onMounted(() => {
  window.addEventListener('mousedown', pd)
  window.addEventListener('mousemove', pm)
  window.addEventListener('mouseup', pu)
  window.addEventListener('keydown', key)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', pd)
  window.removeEventListener('mousemove', pm)
  window.removeEventListener('mouseup', pu)
  window.removeEventListener('keydown', key)
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
      拖拽框选截图区域，Esc 取消
    </div>
  </div>
</template>

<style>
html,
body {
  background: transparent !important;
}
</style>
