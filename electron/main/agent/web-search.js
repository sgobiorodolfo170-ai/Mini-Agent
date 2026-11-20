// Web search providers for the web_search tool. No Electron dependencies.
// Tavily 优先（配置 Key 时），DuckDuckGo HTML 端点免 Key 兜底。
const UA = 'Mozilla/5.0 (Mini-Agent)'

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

async function fetchText(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// Tavily REST API：POST https://api.tavily.com/search
async function searchTavily(query, apiKey, maxResults = 8) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults })
  })
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)
  const data = await res.json()
  return (data.results || [])
    .map(
      (r, i) =>
        `${i + 1}. ${stripTags(r.title)}\n   ${r.url}\n   ${stripTags(r.content).slice(0, 300)}`
    )
    .join('\n')
}

// DuckDuckGo HTML 端点解析（免 API Key）。页面结构变化时抛错而不是返回空。
async function searchDuckDuckGo(query, maxResults = 8) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query))
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
  if (!links.length) throw new Error('未解析到搜索结果（DuckDuckGo 页面结构可能已变化）')

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

// provider: 'auto'（默认，有 Tavily Key 则优先）/ 'tavily' / 'ddg'
async function webSearch({ query, provider = 'auto', tavilyKey }) {
  const q = String(query || '').trim()
  if (!q) throw new Error('搜索词不能为空')
  if ((provider === 'tavily' || provider === 'auto') && tavilyKey) {
    if (provider === 'tavily') return searchTavily(q, tavilyKey)
    try {
      return await searchTavily(q, tavilyKey)
    } catch {
      // auto 模式下 Tavily 失败回落到免 Key 端点
    }
  }
  return searchDuckDuckGo(q)
}

module.exports = { webSearch, searchTavily, searchDuckDuckGo, stripTags, decodeEntities }
