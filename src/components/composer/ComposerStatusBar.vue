<script setup>
import ComposerStatusPill from './ComposerStatusPill.vue'

// 顶部状态栏：只渲染上层给出的真实状态项；无状态时整体不出现，不留空白占位
defineProps({
  items: { type: Array, default: () => [] }
})
const emit = defineEmits(['select'])
</script>

<template>
  <div
    v-if="items.length"
    class="ac-status"
    role="status"
    aria-live="polite"
    data-testid="composer-runtime"
  >
    <ComposerStatusPill
      v-for="item in items"
      :key="item.id"
      :label="item.label"
      :value="item.value"
      :icon="item.icon"
      :tone="item.tone || 'default'"
      :interactive="typeof item.onClick === 'function'"
      @click="item.onClick ? emit('select', item) : undefined"
    />
  </div>
</template>
