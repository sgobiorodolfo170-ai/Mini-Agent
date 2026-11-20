const { joinUrl } = require('../gateway/client')

// OpenAI-compatible /embeddings client with batching.
async function embedTexts(
  { baseUrl, apiKey, model, texts, batchSize = 16, timeoutMs = 60000 },
  fetchImpl = globalThis.fetch
) {
  const vectors = []
  let dim = 0
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const res = await fetchImpl(joinUrl(baseUrl, '/embeddings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(`embeddings ${res.status}: ${detail.slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    const json = await res.json()
    const data = (json.data || []).sort((a, b) => a.index - b.index)
    if (data.length !== batch.length) throw new Error('embeddings count mismatch')
    for (const d of data) {
      const v = Float32Array.from(d.embedding)
      if (!dim) dim = v.length
      if (v.length !== dim) throw new Error('embedding dim mismatch')
      vectors.push(v)
    }
  }
  return { vectors, dim }
}

module.exports = { embedTexts }
