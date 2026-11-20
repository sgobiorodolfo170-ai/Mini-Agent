import { describe, expect, it, vi } from 'vitest'
import { webSearch, searchDuckDuckGo, searchTavily } from '../../electron/main/agent/web-search'

const ddgHtml = `
<div class="result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F1&amp;rut=abc">结果一</a>
<a class="result__snippet" href="x">这是<b>摘要</b>一</a>
<a rel="nofollow" class="result__a" href="https://direct.com/2">结果二</a>
<a class="result__snippet" href="x">摘要二 &amp; 更多</a>
</div>`

describe('searchDuckDuckGo parses the HTML endpoint', () => {
  it('extracts title/url/snippet and unwraps uddg redirects', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => ddgHtml }))
    const out = await searchDuckDuckGo('测试')
    vi.unstubAllGlobals()
    expect(out).toContain('结果一')
    expect(out).toContain('https://example.com/1')
    expect(out).toContain('这是 摘要 一')
    expect(out).toContain('结果二')
    expect(out).toContain('https://direct.com/2')
    expect(out).toContain('摘要二 & 更多')
  })

  it('throws when the layout yields no links', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '<html></html>' }))
    await expect(searchDuckDuckGo('x')).rejects.toThrow(/页面结构/)
    vi.unstubAllGlobals()
  })

  it('propagates HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => '' }))
    await expect(searchDuckDuckGo('x')).rejects.toThrow('HTTP 403')
    vi.unstubAllGlobals()
  })
})

describe('searchTavily posts to the REST API', () => {
  it('formats results with url and content', async () => {
    let captured = null
    vi.stubGlobal('fetch', async (url, init) => {
      captured = { url, body: init.body }
      return {
        ok: true,
        json: async () => ({
          results: [{ title: 'Tavily 结果', url: 'https://t.com/a', content: '内容<b>片段</b>' }]
        })
      }
    })
    const out = await searchTavily('q', 'tvly-key')
    vi.unstubAllGlobals()
    expect(captured.url).toBe('https://api.tavily.com/search')
    expect(JSON.parse(captured.body)).toMatchObject({ api_key: 'tvly-key', query: 'q' })
    expect(out).toContain('1. Tavily 结果')
    expect(out).toContain('https://t.com/a')
    expect(out).toContain('内容 片段')
  })

  it('surfaces HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }))
    await expect(searchTavily('q', 'bad')).rejects.toThrow('HTTP 401')
    vi.unstubAllGlobals()
  })
})

describe('webSearch provider routing', () => {
  it('rejects empty query', async () => {
    await expect(webSearch({ query: '  ' })).rejects.toThrow(/搜索词/)
  })

  it('auto + key prefers Tavily', async () => {
    vi.stubGlobal('fetch', async (url) => ({
      ok: true,
      json: async () => ({ results: [{ title: url, url, content: '' }] })
    }))
    const out = await webSearch({ query: 'q', tavilyKey: 'k' })
    vi.unstubAllGlobals()
    expect(out).toContain('api.tavily.com')
  })

  it('auto without key falls back to DuckDuckGo', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => ddgHtml }))
    const out = await webSearch({ query: 'q' })
    vi.unstubAllGlobals()
    expect(out).toContain('结果一')
  })

  it('explicit provider ddg ignores the key', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => ddgHtml }))
    const out = await webSearch({ query: 'q', provider: 'ddg', tavilyKey: 'k' })
    vi.unstubAllGlobals()
    expect(out).toContain('结果二')
  })

  it('explicit provider tavily throws when it fails (no fallback)', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    await expect(webSearch({ query: 'q', provider: 'tavily', tavilyKey: 'k' })).rejects.toThrow(
      'HTTP 500'
    )
    vi.unstubAllGlobals()
  })

  it('auto falls back to DDG when Tavily fails', async () => {
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('tavily')) return { ok: false, status: 500 }
      return { ok: true, text: async () => ddgHtml }
    })
    const out = await webSearch({ query: 'q', tavilyKey: 'k' })
    vi.unstubAllGlobals()
    expect(out).toContain('结果一')
  })
})
