<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '../common/md'

const props = defineProps({ content: { type: String, default: '' }, streaming: Boolean })

const html = computed(() => renderMarkdown(props.content))

function onClick(e) {
  const t = e.target
  if (t && t.classList && t.classList.contains('code-copy')) {
    navigator.clipboard.writeText(decodeURIComponent(t.dataset.code || ''))
    t.textContent = '已复制'
    setTimeout(() => (t.textContent = '复制'), 1200)
    return
  }
  if (t && t.tagName === 'A') {
    e.preventDefault()
    const href = t.getAttribute('href')
    if (href) window.api.app.openExternal(href)
  }
}
</script>

<template>
  <div class="md-body min-w-0" @click="onClick" v-html="html" />
  <span v-if="streaming" class="cursor-blink">▍</span>
</template>
