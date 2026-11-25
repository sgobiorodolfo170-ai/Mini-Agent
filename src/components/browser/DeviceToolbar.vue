<script setup>
import UiIcon from '../UiIcon.vue'

const props = defineProps({
  device: { type: Object, required: true },
  fitScale: { type: Number, default: 1 }
})
const emit = defineEmits(['change', 'swap', 'close'])

function change(property, value) {
  emit('change', { [property]: Number(value) })
}
</script>

<template>
  <div
    class="min-h-10 shrink-0 flex items-center gap-2 px-3 border-b border-line-subtle bg-panel text-xs"
    data-testid="browser-device-toolbar"
  >
    <UiIcon name="device" :size="15" class="text-ink-secondary" />
    <span class="font-medium text-ink-primary">设备</span>
    <label class="flex items-center gap-1 text-ink-secondary">
      宽
      <input
        class="field-input !h-7 !w-20 !py-1 text-xs"
        data-testid="browser-device-width"
        type="number"
        min="240"
        max="3840"
        :value="props.device.width"
        @change="change('width', $event.target.value)"
      />
    </label>
    <span class="text-ink-muted">×</span>
    <label class="flex items-center gap-1 text-ink-secondary">
      高
      <input
        class="field-input !h-7 !w-20 !py-1 text-xs"
        data-testid="browser-device-height"
        type="number"
        min="240"
        max="2160"
        :value="props.device.height"
        @change="change('height', $event.target.value)"
      />
    </label>
    <button
      class="icon-btn-sm"
      data-testid="browser-device-swap"
      title="交换宽高"
      aria-label="交换宽高"
      @click="emit('swap')"
    >
      <UiIcon name="swap" :size="14" />
    </button>
    <label class="ml-2 flex items-center gap-2 text-ink-secondary">
      缩放
      <input
        class="w-24"
        data-testid="browser-device-scale"
        type="range"
        min="25"
        max="100"
        step="5"
        :value="props.device.scale"
        @change="change('scale', $event.target.value)"
      />
      <input
        class="field-input !h-7 !w-16 !py-1 text-xs"
        data-testid="browser-device-scale-value"
        type="number"
        min="25"
        max="100"
        :value="props.device.scale"
        @change="change('scale', $event.target.value)"
      />
      <span>%</span>
    </label>
    <span v-if="props.fitScale < 1" class="text-ink-muted" data-testid="browser-device-fit">
      自适应 {{ Math.round(props.fitScale * 100) }}%
    </span>
    <button
      class="icon-btn-sm ml-auto"
      data-testid="browser-device-close"
      title="退出设备模式"
      aria-label="退出设备模式"
      @click="emit('close')"
    >
      <UiIcon name="close" :size="14" />
    </button>
  </div>
</template>
