import { afterEach, describe, expect, it, vi } from 'vitest'
import { webSearch, searchDuckDuckGo, searchTavily } from '../../electron/main/agent/web-search'

const ddgHtml = `
<div class="result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F1&amp;rut=abc">结果一</a>
<a class="result__snippet" href="x">这是<b>摘要</b>一</a>
<a rel="nofollow" class="result__a" href="https://direct.com/2">结果二</a>
<a class="result__snippet" href="x">摘要二 &amp; 更多</a>
</div>`

const tavilyResponse = {
  ok: true,
  json: async () => ({
    results: [{ title: 'Tavily 结果', url: 'https://t.com/a', content: '内容<b>片段</b>' }]
  })
}

const timeoutError = (message = 'The operation was aborted due to timeout') => {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchDuckDuckGo parses the HTML endpoint', () => {
  it('extracts title/url/snippet and unwraps uddg redirects', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => ddgHtml }))
    const out = await searchDuckDuckGo('测试')
    expect(out).toContain('结果一')
    expect(out).toContain('https://example.com/1')
    expect(out).toContain('这是 摘要 一')
    expect(out).toContain('结果二')
    expect(out).toContain('https://direct.com/2')
    expect(out).toContain('摘要二 & 更多')
  })

  it('accepts valid results whose query, title and snippet mention CAPTCHA', async () => {
    const html = ddgHtml
      .replace('结果一', 'CAPTCHA 人机验证教程')
      .replace('这是<b>摘要</b>一', '验证码 captcha 摘要')
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => html }))
    const out = await searchDuckDuckGo('captcha')
    expect(out).toContain('CAPTCHA 人机验证教程')
    expect(out).toContain('验证码 captcha 摘要')
    expect(out).toContain('https://example.com/1')
  })

  it('does not classify keyword-only HTML without results as a challenge', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body>captcha anomaly-modal challenge-form 验证码</body></html>'
    }))
    await expect(searchDuckDuckGo('captcha')).rejects.toMatchObject({
      code: 'DDG_NO_RESULTS',
      kind: 'empty'
    })
  })

  it('throws an explicit empty-result error when the layout yields no links', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => '<html></html>'
    }))
    await expect(searchDuckDuckGo('x')).rejects.toMatchObject({
      code: 'DDG_NO_RESULTS',
      kind: 'empty',
      provider: 'ddg',
      endpoint: 'ddg_html'
    })
  })

  it('propagates HTTP errors with provider diagnostics', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => '' }))
    await expect(searchDuckDuckGo('x')).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 403'),
      code: 'DDG_HTTP_403',
      provider: 'ddg',
      endpoint: 'ddg_html',
      status: 403
    })
  })

  it('rejects HTTP 202 even if the body contains result-like links', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 202, text: async () => ddgHtml }))
    await expect(searchDuckDuckGo('x')).rejects.toMatchObject({
      code: 'DDG_CHALLENGE',
      kind: 'challenge',
      status: 202,
      provider: 'ddg'
    })
  })

  it('rejects a CAPTCHA page', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => '<form id="challenge-form">请完成人机验证</form>'
    }))
    await expect(searchDuckDuckGo('x')).rejects.toMatchObject({
      code: 'DDG_CHALLENGE',
      kind: 'challenge'
    })
  })

  it('preserves the underlying timeout cause and timeout budget', async () => {
    const cause = new Error('connect ETIMEDOUT 127.0.0.1')
    const error = new TypeError('fetch failed', { cause })
    const fetchImpl = vi.fn(async () => {
      throw error
    })
    await expect(searchDuckDuckGo('q', 8, { fetchImpl, timeoutMs: 1234 })).rejects.toMatchObject({
      code: 'DDG_TIMEOUT',
      kind: 'timeout',
      provider: 'ddg',
      endpoint: 'ddg_html',
      timeoutMs: 1234,
      cause: { message: 'connect ETIMEDOUT 127.0.0.1' }
    })
  })
})

describe('searchTavily posts to the REST API', () => {
  it('formats results with url and content', async () => {
    let captured = null
    vi.stubGlobal('fetch', async (url, init) => {
      captured = { url, body: init.body }
      return tavilyResponse
    })
    const out = await searchTavily('q', 'tvly-key')
    expect(captured.url).toBe('https://api.tavily.com/search')
    expect(JSON.parse(captured.body)).toMatchObject({ api_key: 'tvly-key', query: 'q' })
    expect(out).toContain('1. Tavily 结果')
    expect(out).toContain('https://t.com/a')
    expect(out).toContain('内容 片段')
  })

  it('surfaces HTTP errors with endpoint and timeout metadata', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }))
    await expect(searchTavily('q', 'bad', 8, { timeoutMs: 4321 })).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 401'),
      code: 'TAVILY_HTTP_401',
      provider: 'tavily',
      endpoint: 'tavily_api',
      timeoutMs: 4321,
      status: 401
    })
  })

  it('reports empty Tavily results explicitly', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ results: [] }) })
    await expect(searchTavily('q', 'k', 8, { fetchImpl })).rejects.toMatchObject({
      code: 'TAVILY_NO_RESULTS',
      kind: 'empty'
    })
  })

  it('redacts keys while retaining provider, endpoint, timeout and cause', async () => {
    const key = 'tvly-super-secret'
    const cause = new Error(`connect ECONNREFUSED; api_key=${key}`)
    const fetchImpl = async () => {
      throw new TypeError(`fetch failed; api_key=${key}`, { cause })
    }
    const error = await webSearch({
      query: 'q',
      provider: 'tavily',
      tavilyKey: key,
      fetchImpl
    }).catch((caught) => caught)
    expect(error).toMatchObject({
      code: 'TAVILY_NETWORK_ERROR',
      kind: 'network',
      provider: 'tavily',
      endpoint: 'tavily_api',
      timeoutMs: 20000,
      cause: { name: 'Error', message: expect.stringContaining('ECONNREFUSED') }
    })
    expect(error.message).not.toContain(key)
    expect(error.cause.message).not.toContain(key)
  })
})

describe('webSearch provider routing', () => {
  it.each([undefined, null, '', '  ', 42, {}, []])('rejects invalid query %j', async (query) => {
    const fetchImpl = vi.fn()
    await expect(webSearch({ query, fetchImpl })).rejects.toMatchObject({ code: 'INVALID_QUERY' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['bing', '', 'TAVILY', null, 42, {}])('rejects unknown provider %j', async (provider) => {
    const fetchImpl = vi.fn()
    await expect(webSearch({ query: 'q', provider, fetchImpl })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', '  '])(
    'explicit tavily rejects missing key %j',
    async (tavilyKey) => {
      const fetchImpl = vi.fn()
      await expect(
        webSearch({ query: 'q', provider: 'tavily', tavilyKey, fetchImpl })
      ).rejects.toMatchObject({
        code: 'TAVILY_KEY_REQUIRED',
        kind: 'configuration',
        provider: 'tavily',
        message: expect.stringContaining('配置')
      })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('auto + key prefers Tavily', async () => {
    const fetchImpl = vi.fn(async () => tavilyResponse)
    const out = await webSearch({ query: 'q', tavilyKey: 'k', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.tavily.com/search')
    expect(out).toContain('https://t.com/a')
    expect(out).not.toContain('回退')
  })

  it('auto without key only falls back to DuckDuckGo', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => ddgHtml }))
    const out = await webSearch({ query: 'q', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toContain('html.duckduckgo.com')
    expect(out).toContain('结果一')
    expect(out).not.toContain('回退')
  })

  it('explicit provider ddg ignores the key', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => ddgHtml }))
    const out = await webSearch({ query: 'q', provider: 'ddg', tavilyKey: 'k', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toContain('html.duckduckgo.com')
    expect(out).toContain('结果二')
  })

  it('explicit provider tavily throws when it fails (no fallback)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }))
    await expect(
      webSearch({ query: 'q', provider: 'tavily', tavilyKey: 'k', fetchImpl })
    ).rejects.toMatchObject({ code: 'TAVILY_HTTP_500', provider: 'tavily' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('auto falls back to DDG and explains the Tavily HTTP failure in the string result', async () => {
    const urls = []
    const out = await webSearch({
      query: 'q',
      tavilyKey: 'k',
      fetchImpl: async (url) => {
        urls.push(String(url))
        if (String(url).includes('tavily')) return { ok: false, status: 500 }
        return { ok: true, status: 200, text: async () => ddgHtml }
      }
    })
    expect(urls).toHaveLength(2)
    expect(out).toContain('结果一')
    expect(out).toContain('Tavily 失败（HTTP 500）')
    expect(out).toContain('已使用 DuckDuckGo')
  })

  it('auto falls back with an observable timeout reason and separate budgets', async () => {
    let signal
    const out = await webSearch({
      query: 'q',
      tavilyKey: 'k',
      tavilyTimeoutMs: 111,
      ddgTimeoutMs: 222,
      fetchImpl: async (url, init) => {
        if (String(url).includes('tavily')) {
          signal = init.signal
          throw timeoutError()
        }
        return { ok: true, status: 200, text: async () => ddgHtml }
      }
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(out).toContain('Tavily 失败（请求超时（111ms））')
    expect(out).toContain('结果一')
  })

  it('accepts an injected transport function', async () => {
    const transport = vi.fn(async () => ({ ok: true, status: 200, text: async () => ddgHtml }))
    const out = await webSearch({ query: 'q', provider: 'ddg', transport })
    expect(out).toContain('结果一')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not hide a DDG 202 challenge', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 202, text: async () => 'verify' }))
    await expect(webSearch({ query: 'q', provider: 'ddg', fetchImpl })).rejects.toMatchObject({
      code: 'DDG_CHALLENGE',
      kind: 'challenge',
      status: 202
    })
  })

  it('does not hide a DDG timeout', async () => {
    const fetchImpl = async () => {
      throw timeoutError()
    }
    await expect(
      webSearch({ query: 'q', provider: 'ddg', fetchImpl, ddgTimeoutMs: 333 })
    ).rejects.toMatchObject({ code: 'DDG_TIMEOUT', timeoutMs: 333, kind: 'timeout' })
  })

  it('reports both failures with each provider diagnostic when auto fallback also fails', async () => {
    const key = 'tvly-never-leak'
    const tavilyCause = new Error(`Tavily connect timeout; ${key}`)
    const ddgCause = new Error('DDG connect ECONNREFUSED')
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('tavily')) {
        throw new TypeError('fetch failed', { cause: tavilyCause })
      }
      throw new TypeError('fetch failed', { cause: ddgCause })
    })
    const error = await webSearch({
      query: 'q',
      tavilyKey: key,
      fetchImpl,
      tavilyTimeoutMs: 444,
      ddgTimeoutMs: 555
    }).catch((caught) => caught)
    expect(error).toMatchObject({
      code: 'SEARCH_FALLBACK_FAILED',
      provider: 'ddg',
      endpoint: 'ddg_html',
      timeoutMs: 555,
      cause: { message: 'DDG connect ECONNREFUSED' },
      attempts: [
        {
          provider: 'tavily',
          endpoint: 'tavily_api',
          kind: 'timeout',
          timeoutMs: 444,
          cause: { message: expect.stringContaining('Tavily connect timeout') }
        },
        {
          provider: 'ddg',
          endpoint: 'ddg_html',
          kind: 'network',
          timeoutMs: 555,
          cause: { message: 'DDG connect ECONNREFUSED' }
        }
      ]
    })
    expect(error.message).toContain('Tavily 失败')
    expect(error.message).toContain('DuckDuckGo 失败')
    expect(error.message).not.toContain(key)
    expect(error.attempts[0].cause.message).not.toContain(key)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('includes a DDG challenge in the dual-failure diagnostics', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('tavily')) return { ok: false, status: 401 }
      return { ok: true, status: 202, text: async () => 'captcha' }
    }
    await expect(webSearch({ query: 'q', tavilyKey: 'k', fetchImpl })).rejects.toMatchObject({
      code: 'SEARCH_FALLBACK_FAILED',
      message: expect.stringContaining('DuckDuckGo 失败（DDG_CHALLENGE）'),
      attempts: [{ code: 'TAVILY_HTTP_401' }, { code: 'DDG_CHALLENGE' }]
    })
  })
})
