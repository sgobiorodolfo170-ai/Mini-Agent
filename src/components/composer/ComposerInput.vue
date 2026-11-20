<script setup>
import { nextTick, onMounted, ref, watch } from 'vue'

// 输入区：只负责文本输入本身（自动增高、Enter 发送、Shift+Enter 换行、IME 守卫）。
// 不读取模型 / 权限 / 任务状态，全部由上层 AgentComposer 决定。
const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '消息输入框' },
  describedBy: { type: String, default: undefined },
  maxHeight: { type: Number, default: 160 }
})
const emit = defineEmits(['update:modelValue', 'submit'])

const el = ref(null)

function resize() {
  const node = el.value
  if (!node) return
  node.style.height = 'auto'
  node.style.height = Math.min(props.maxHeight, node.scrollHeight) + 'px'
  // 超过最大高度后由输入区内部滚动，不再撑高卡片
  node.style.overflowY = node.scrollHeight > props.maxHeight ? 'auto' : 'hidden'
}

function focus() {
  if (el.value) el.value.focus()
}

function onInput(e) {
  emit('update:modelValue', e.target.value)
  resize()
}

function onKeydown(e) {
  // 输入法组合期间 Enter 只确认候选，不发送（keyCode 229 覆盖旧版 IME）
  if (e.isComposing || e.keyCode === 229) return
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  emit('submit')
}

// 程序化改值（发送成功后清空、失败回填）同样需要重算高度
watch(
  () => props.modelValue,
  () => nextTick(resize)
)
onMounted(resize)

defineExpose({ focus, resize })
</script>

<template>
  <textarea
    ref="el"
    class="ac-textarea"
    rows="1"
    :value="modelValue"
    :placeholder="placeholder"
    :aria-label="label"
    :aria-describedby="describedBy"
    :disabled="disabled"
    spellcheck="false"
    data-testid="chat-input"
    @input="onInput"
    @keydown="onKeydown"
  />
</template>
