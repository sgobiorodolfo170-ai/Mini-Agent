<script setup>
import UiIcon from '../UiIcon.vue'

// 状态胶囊：纯展示；只有上层传入 onClick 时才可点击（不自行轮询任务状态）
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: undefined },
  icon: { type: String, default: '' },
  tone: { type: String, default: 'default' },
  interactive: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['click'])
</script>

<template>
  <component
    :is="interactive ? 'button' : 'span'"
    class="ac-pill"
    :class="[`ac-pill--${tone}`, interactive ? 'ac-pill--interactive' : '']"
    :type="interactive ? 'button' : undefined"
    :disabled="interactive ? disabled : undefined"
    @click="interactive && !disabled ? emit('click') : undefined"
  >
    <UiIcon v-if="icon" :name="icon" :size="14" class="ac-pill__icon" />
    <span class="ac-pill__label">{{ label }}</span>
    <span v-if="value !== undefined && value !== ''" class="ac-pill__value">{{ value }}</span>
  </component>
</template>
