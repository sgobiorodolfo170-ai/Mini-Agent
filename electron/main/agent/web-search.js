// Web search providers for the web_search tool. No Electron dependencies.
// Tavily 优先（配置 Key 时），DuckDuckGo HTML 端点免 Key 兜底。
const UA = 'Mozilla/5.0 (Mini-Agent)'
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const PROVIDERS = new Set(['auto', 'tavily', 'ddg'])
const DDG_CHALLENGE_MARKUP_RE =
  /<(?:form|div|section)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*\b(?:challenge-form|anomaly-modal)\b[^"']*["'][^>]*>/i

class WebSearchError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'WebSearchError'
    Object.assign(this, details)
  }
}

function redact(text, apiKey) {
  const value = String(text)
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  return key ? value.split(key).join('[REDACTED]') : value
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isTimeout(error) {
  const cause = error && error.cause
  return (
    (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
    (cause && cause.name === 'TimeoutError') ||
    /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(errorMessage(error)) ||
    (cause != null && /timeout|timed out|ETIMEDOUT/i.test(errorMessage(cause)))
  )
}

function safeCause(error, apiKey) {
  const cause = (error && error.cause) || error
  if (!cause) return undefined
  const copy = new Error(redact(errorMessage(cause), apiKey))
  copy.name = redact(cause instanceof Error ? cause.name : 'Error', apiKey)
  if (cause && cause.code) copy.code = redact(cause.code, apiKey)
  return copy
}

function transportError(provider, error, timeoutMs, apiKey) {
  if (error instanceof WebSearchError) return error
  const timeout = isTimeout(error)
  const cause = safeCause(error, apiKey)
  const endpoint = provider === 'tavily' ? 'tavily_api' : 'ddg_html'
  const label = provider === 'tavily' ? 'Tavily' : 'DuckDuckGo'
  return new WebSearchError(
    `${label} ${timeout ? `请求超时（${timeoutMs}ms）` : '网络请求失败'}：${redact(errorMessage(error), apiKey)}`,
    {
      code: `${provider.toUpperCase()}_${timeout ? 'TIMEOUT' : 'NETWORK_ERROR'}`,
      kind: timeout ? 'timeout' : 'network',
      provider,
      endpoint,
      timeoutMs,
      cause
    }
  )
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' '))
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function validateQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new WebSearchError('搜索词 query 必须是非空字符串', {
      code: 'INVALID_QUERY',
      kind: 'validation'
    })
  }
  return query.trim()
}

function validateProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new WebSearchError('provider 仅支持 auto、tavily 或 ddg', {
      code: 'INVALID_PROVIDER',
      kind: 'validation',
      provider: typeof provider === 'string' ? provider : typeof provider
    })
  }
}

function resolveFetch(options) {
  const transport = options.transport
  const fetchImpl =
    options.fetchImpl ||
    (typeof transport === 'function' ? transport : transport && transport.fetch)
  const resolved = fetchImpl || globalThis.fetch
  if (typeof resolved !== 'function') {
    throw new WebSearchError('未配置可用的网络传输', {
      code: 'INVALID_TRANSPORT',
      kind: 'configuration'
    })
  }
  return resolved
}

async function request(url, init, provider, timeoutMs, apiKey, options) {
  const fetchImpl = resolveFetch(options)
  let res
  try {
    res = await fetchImpl.call(globalThis, url, init)
  } catch (error) {
    throw transportError(provider, error, timeoutMs, apiKey)
  }
  return { res, fetchImpl }
}

// Tavily REST API：POST https://api.tavily.com/search
// 原有 (query, apiKey, maxResults) 调用保持兼容；第四参数可注入 fetch/transport。
async function searchTavily(query, apiKey, maxResults = 8, options = {}) {
  const q = validateQuery(query)
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new WebSearchError('Tavily 搜索需要配置 API Key', {
      code: 'TAVILY_KEY_REQUIRED',
      kind: 'configuration',
      provider: 'tavily',
      endpoint: 'tavily_api'
    })
  }
  const timeoutMs = options.timeoutMs || 20000
  const { res } = await request(
    TAVILY_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ api_key: apiKey, query: q, max_results: maxResults })
    },
    'tavily',
    timeoutMs,
    apiKey,
    options
  )
  if (!res.ok) {
    throw new WebSearchError(`Tavily HTTP ${res.status}`, {
      code: `TAVILY_HTTP_${res.status}`,
      kind: 'http',
      provider: 'tavily',
      endpoint: 'tavily_api',
      status: res.status,
      timeoutMs
    })
  }
  let data
  try {
    data = await res.json()
  } catch (error) {
    throw transportError('tavily', error, timeoutMs, apiKey)
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new WebSearchError('Tavily 返回了无效的响应数据', {
      code: 'TAVILY_INVALID_RESPONSE',
      kind: 'invalid_response',
      provider: 'tavily',
      endpoint: 'tavily_api',
      timeoutMs
    })
  }
  if (!data.results.length) {
    throw new WebSearchError('Tavily 未返回搜索结果', {
      code: 'TAVILY_NO_RESULTS',
      kind: 'empty',
      provider: 'tavily',
      endpoint: 'tavily_api',
      timeoutMs
    })
  }
  return data.results
    .map(
      (r, i) =>
        `${i + 1}. ${stripTags(r.title)}\n   ${r.url}\n   ${stripTags(r.content).slice(0, 300)}`
    )
    .join('\n')
}

// DuckDuckGo HTML 端点解析（免 API Key）。页面结构变化或验证页均明确抛错。
// 原有 (query, maxResults) 调用保持兼容；第三参数可注入 fetch/transport。
function ddgChallengeError(status, timeoutMs) {
  return new WebSearchError('DuckDuckGo 返回人机验证（验证码），无法完成搜索', {
    code: 'DDG_CHALLENGE',
    kind: 'challenge',
    provider: 'ddg',
    endpoint: 'ddg_html',
    status,
    timeoutMs
  })
}

async function searchDuckDuckGo(query, maxResults = 8, options = {}) {
  const q = validateQuery(query)
  const timeoutMs = options.timeoutMs || 15000
  const url = DDG_ENDPOINT + '?q=' + encodeURIComponent(q)
  const { res } = await request(
    url,
    { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': UA } },
    'ddg',
    timeoutMs,
    undefined,
    options
  )
  let html
  try {
    html = await res.text()
  } catch (error) {
    throw transportError('ddg', error, timeoutMs)
  }
  if (res.status === 202) throw ddgChallengeError(res.status, timeoutMs)
  if (!res.ok) {
    throw new WebSearchError(`HTTP ${res.status}`, {
      code: `DDG_HTTP_${res.status}`,
      kind: 'http',
      provider: 'ddg',
      endpoint: 'ddg_html',
      status: res.status,
      timeoutMs
    })
  }
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

  const links = []
  let m
  while ((m = linkRe.exec(html)) && links.length < maxResults) {
    let href = m[1]
    // DDG 跳转链接形如 //duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddg = /[?&]uddg=([^&]+)/.exec(href)
    if (uddg) href = decodeURIComponent(uddg[1])
    if (href.startsWith('//')) href = 'https:' + href
    links.push({ url: href, title: stripTags(m[2]) })
  }
  if (!links.length) {
    // 仅凭验证码等文本关键词不能判定挑战页；先解析结果，无结果时再识别明确结构。
    if (DDG_CHALLENGE_MARKUP_RE.test(html)) {
      throw ddgChallengeError(res.status, timeoutMs)
    }
    throw new WebSearchError('未解析到搜索结果（DuckDuckGo 返回空结果或页面结构已变化）', {
      code: 'DDG_NO_RESULTS',
      kind: 'empty',
      provider: 'ddg',
      endpoint: 'ddg_html',
      status: res.status,
      timeoutMs
    })
  }

  const snippets = []
  while ((m = snippetRe.exec(html)) && snippets.length < links.length)
    snippets.push(stripTags(m[1]))

  return links
    .map(
      (l, i) =>
        `${i + 1}. ${l.title || '(无标题)'}\n   ${l.url}\n   ${(snippets[i] || '').slice(0, 300)}`
    )
    .join('\n')
}

function failureReason(error) {
  if (error.kind === 'timeout') return `请求超时（${error.timeoutMs}ms）`
  if (error.kind === 'http') return `HTTP ${error.status}`
  return error.code
}

// provider: 'auto'（默认，有 Tavily Key 则优先）/ 'tavily' / 'ddg'
// fetchImpl/transport 与各 provider 的超时均可注入，返回类型始终为字符串。
async function webSearch({
  query,
  provider = 'auto',
  tavilyKey,
  fetchImpl,
  transport,
  timeoutMs,
  tavilyTimeoutMs,
  ddgTimeoutMs
}) {
  const q = validateQuery(query)
  validateProvider(provider)
  const hasTavilyKey = typeof tavilyKey === 'string' && Boolean(tavilyKey.trim())
  if (provider === 'tavily' && !hasTavilyKey) {
    throw new WebSearchError('显式 provider=tavily 需要配置 Tavily API Key', {
      code: 'TAVILY_KEY_REQUIRED',
      kind: 'configuration',
      provider,
      endpoint: 'tavily_api'
    })
  }

  const options = { fetchImpl, transport }
  if (provider === 'ddg' || (provider === 'auto' && !hasTavilyKey)) {
    return searchDuckDuckGo(q, 8, { ...options, timeoutMs: ddgTimeoutMs || timeoutMs })
  }
  if (provider === 'tavily') {
    return searchTavily(q, tavilyKey, 8, {
      ...options,
      timeoutMs: tavilyTimeoutMs || timeoutMs
    })
  }

  try {
    return await searchTavily(q, tavilyKey, 8, {
      ...options,
      timeoutMs: tavilyTimeoutMs || timeoutMs
    })
  } catch (tavilyError) {
    try {
      const results = await searchDuckDuckGo(q, 8, {
        ...options,
        timeoutMs: ddgTimeoutMs || timeoutMs
      })
      return `[web_search 回退] Tavily 失败（${failureReason(tavilyError)}），已使用 DuckDuckGo。\n\n${results}`
    } catch (ddgError) {
      const message = `Tavily 失败（${failureReason(tavilyError)}）；DuckDuckGo 失败（${failureReason(ddgError)}）`
      throw new WebSearchError(message, {
        code: 'SEARCH_FALLBACK_FAILED',
        kind: 'fallback_failed',
        provider: 'ddg',
        endpoint: 'ddg_html',
        timeoutMs: ddgError.timeoutMs,
        cause: ddgError.cause,
        attempts: [tavilyError, ddgError]
      })
    }
  }
}

module.exports = { webSearch, searchTavily, searchDuckDuckGo, stripTags, decodeEntities }
