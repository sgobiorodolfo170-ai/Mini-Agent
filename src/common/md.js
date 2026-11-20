import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

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
  return `<div class="code-block"><div class="code-head"><span>${md.utils.escapeHtml(lang || 'text')}</span><button class="code-copy" data-code="${encoded}">复制</button></div><pre><code class="hljs">${html}</code></pre></div>`
}

export function renderMarkdown(text) {
  return md.render(String(text || ''))
}
