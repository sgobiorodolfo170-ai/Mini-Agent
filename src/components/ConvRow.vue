<script setup>
import { computed, ref, watch } from 'vue'
import RowMenu from './RowMenu.vue'

// 会话列表行（置顶 / 项目分组 / 最近三处复用）；重命名草稿由行内部管理
const props = defineProps({
  conv: { type: Object, required: true },
  active: { type: Boolean, default: false },
  editing: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'rename', 'rename-submit', 'pin', 'remove'])

const menuItems = computed(() => [
  { id: 'rename', label: '重命名', icon: 'edit', onSelect: () => emit('rename') },
  {
    id: 'pin',
    label: props.conv.pinned ? '取消置顶' : '置顶',
    icon: 'pin',
    onSelect: () => emit('pin')
  },
  { id: 'remove', label: '删除', icon: 'trash', danger: true, onSelect: () => emit('remove') }
])

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
    :class="active ? 'bg-panel text-brand-ink' : 'hover:bg-surface'"
    role="button"
    :aria-current="active ? 'true' : undefined"
    @click="emit('select')"
    @keydown.enter.prevent="emit('select')"
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
      <!-- Agent 创建的子会话：来源常驻可见，点击即可查看其消息与运行记录 -->
      <span
        v-if="conv.origin === 'agent'"
        class="badge shrink-0 !px-1.5 !py-0 text-[10px]"
        title="由 Agent 创建的子会话"
        data-testid="conv-agent-badge"
      >
        子会话
      </span>
      <RowMenu :items="menuItems" label="会话操作" />
    </template>
  </div>
</template>
