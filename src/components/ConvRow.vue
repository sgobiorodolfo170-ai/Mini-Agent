<script setup>
import { ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'

// 会话列表行（置顶 / 项目分组 / 最近三处复用）；重命名草稿由行内部管理
const props = defineProps({
  conv: { type: Object, required: true },
  active: { type: Boolean, default: false },
  editing: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'rename', 'rename-submit', 'pin', 'remove'])

const draft = ref('')
watch(
  () => props.editing,
  (v) => {
    if (v) draft.value = props.conv.title
  }
)
function submit() {
  emit('rename-submit', draft.value.trim())
}
function onKeydown(e) {
  // 中文输入法组合期间 Enter 只确认候选（F05）
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter') submit()
}
</script>

<template>
  <div
    tabindex="0"
    data-testid="conv-item"
    class="list-row group !min-h-[44px]"
    :class="active ? 'bg-brand-soft text-brand-ink' : 'hover:bg-surface'"
    role="button"
    :aria-current="active ? 'true' : undefined"
    @click="emit('select')"
    @keydown.enter.prevent="emit('select')"
    @dblclick="emit('rename')"
  >
    <template v-if="editing">
      <input
        v-model="draft"
        class="flex-1 min-w-0 bg-transparent outline-none border-b border-brand text-sm"
        aria-label="会话名称"
        @keydown="onKeydown"
        @blur="submit"
      />
    </template>
    <template v-else>
      <span class="flex-1 truncate" :title="conv.title">{{ conv.title }}</span>
      <span v-if="conv.pinned" title="已置顶" class="text-brand-ink shrink-0">
        <UiIcon name="pin" :size="14" />
      </span>
      <span
        class="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
      >
        <button
          class="icon-btn-sm !w-6 !h-6"
          title="重命名"
          aria-label="重命名会话"
          @click.stop="emit('rename')"
        >
          <UiIcon name="edit" :size="14" />
        </button>
        <button
          class="icon-btn-sm !w-6 !h-6"
          title="置顶/取消置顶"
          aria-label="置顶或取消置顶"
          @click.stop="emit('pin')"
        >
          <UiIcon name="pin" :size="14" />
        </button>
        <button
          class="icon-btn-sm !w-6 !h-6 hover:!text-red-500"
          title="删除"
          aria-label="删除会话"
          @click.stop="emit('remove')"
        >
          <UiIcon name="trash" :size="14" />
        </button>
      </span>
    </template>
  </div>
</template>
