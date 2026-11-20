<script setup>
import UiDialog from './UiDialog.vue'

// 通用确认弹窗（F04）：显示对象与影响范围，取消不写库，默认焦点在取消
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  impact: { type: String, default: '' },
  confirmText: { type: String, default: '删除' },
  danger: { type: Boolean, default: true }
})
const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <UiDialog :open="open" :title="title" width="420px" @close="emit('cancel')">
    <div class="space-y-2 text-sm">
      <p class="text-ink-primary">{{ message }}</p>
      <p v-if="impact" class="text-xs text-ink-muted">{{ impact }}</p>
    </div>
    <template #footer>
      <button class="btn-secondary" data-autofocus @click="emit('cancel')">取消</button>
      <button :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">
        {{ confirmText }}
      </button>
    </template>
  </UiDialog>
</template>
