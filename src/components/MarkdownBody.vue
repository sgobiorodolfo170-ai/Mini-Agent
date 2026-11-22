<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '../common/md'

const props = defineProps({ content: { type: String, default: '' }, streaming: Boolean })

const html = computed(() => renderMarkdown(props.content))

function onClick(e) {
  const t = e.target
  const copyBtn = t && typeof t.closest === 'function' ? t.closest('.code-copy') : null
  if (copyBtn) {
    navigator.clipboard.writeText(decodeURIComponent(copyBtn.dataset.code || ''))
    copyBtn.classList.add('is-copied')
    copyBtn.setAttribute('title', '已复制')
    copyBtn.setAttribute('aria-label', '已复制')
    clearTimeout(copyBtn._copyTimer)
    copyBtn._copyTimer = setTimeout(() => {
      copyBtn.classList.remove('is-copied')
      copyBtn.setAttribute('title', '复制代码')
      copyBtn.setAttribute('aria-label', '复制代码')
    }, 1200)
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
