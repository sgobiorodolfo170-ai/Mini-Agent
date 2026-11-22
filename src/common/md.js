import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const lang = (token.info || '').trim().split(/\s+/)[0]
  let html
  try {
    html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(token.content, { language: lang }).value
        : hljs.highlightAuto(token.content).value
  } catch {
    html = md.utils.escapeHtml(token.content)
  }
  const encoded = encodeURIComponent(token.content)
  const icon = (cls, d) =>
    `<svg class="${cls}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
  const copyIcon = icon('code-copy__copy', 'M9 9h10v12H9V9Z M5 15V3h10')
  const doneIcon = icon('code-copy__done', 'M5 13l4 4L19 7')
  return `<div class="code-block"><div class="code-head"><span>${md.utils.escapeHtml(lang || 'text')}</span><button class="code-copy" data-code="${encoded}" title="复制代码" aria-label="复制代码">${copyIcon}${doneIcon}</button></div><pre><code class="hljs">${html}</code></pre></div>`
}

export function renderMarkdown(text) {
  return md.render(String(text || ''))
}
