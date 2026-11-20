import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/common/md'

describe('renderMarkdown', () => {
  it('renders headings and paragraphs', () => {
    const html = renderMarkdown('# 标题\n\n正文')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<p>正文</p>')
  })

  it('wraps code fences with copy button and encoded code', () => {
    const code = 'const a = 1\nconsole.log(a)'
    const html = renderMarkdown('```js\n' + code + '\n```')
    expect(html).toContain('code-block')
    expect(html).toContain('code-copy')
    const encoded = html.match(/data-code="([^"]+)"/)[1]
    expect(decodeURIComponent(encoded).replace(/\n$/, '')).toBe(code)
  })

  it('escapes raw html (html: false)', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps inline code and bold', () => {
    const html = renderMarkdown('**加粗** 和 `code`')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
  })
})
