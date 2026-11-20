// Parse an SSE byte stream into OpenAI-style JSON events.
async function* sseEvents(body) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (!line || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') return
        continue
      }
      try {
        yield JSON.parse(data)
      } catch {
        // ignore malformed lines
      }
    }
  }
}

module.exports = { sseEvents }
