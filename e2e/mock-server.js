import http from 'http'
import crypto from 'crypto'

// Deterministic 4-dim embedding: documents containing the marker keyword align
// with queries containing it (first dimension dominates).
function vectorFor(text) {
  const t = String(text)
  const h = crypto.createHash('sha1').update(t).digest()
  const base = [h[0] / 255, h[1] / 255, h[2] / 255, h[3] / 255]
  base[0] = t.includes('E2EKB') ? 1 : base[0] * 0.2
  return base
}

// Local OpenAI-compatible mock: /v1/models, /v1/embeddings, /v1/chat/completions.
// state controls: failKeys(Set) → 429, mode('normal'|'hang'), agentFile,
// requests log (path/auth/body).
export function createMockServer() {
  const state = {
    requests: [],
    failKeys: new Set(),
    mode: 'normal',
    agentFile: '',
    // 集群验证：主 Agent 第一次调用 spawn_agent 时派发多个子任务
    clusterSpawn: false,
    // 记录同时在途的子 Agent 数量峰值，用来证明「并发」而非串行
    subInFlight: 0,
    subPeak: 0
  }

  const sse = (res, chunks) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let i = 0
    const tick = () => {
      if (res.writableEnded) return
      if (i < chunks.length) {
        res.write(`data: ${chunks[i++]}\n\n`)
        setTimeout(tick, 15)
      } else {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
    tick()
  }

  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      let body = {}
      try {
        body = data ? JSON.parse(data) : {}
      } catch {
        body = {}
      }
      const auth = req.headers.authorization || ''
      state.requests.push({ path: req.url, auth, body })

      // Regression guard: a Promise/reactive Proxy templated into the header
      // produces "Bearer [object ...]" — real relays would 401. Never pass.
      if (auth.includes('[object')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid authorization header' } }))
        return
      }

      if (state.failKeys.has(auth.replace('Bearer ', ''))) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'rate limited' } }))
        return
      }
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
        return
      }
      if (req.url.endsWith('/embeddings')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: (body.input || []).map((t, i) => ({ index: i, embedding: vectorFor(t) }))
          })
        )
        return
      }
      if (req.url.endsWith('/chat/completions')) {
        if (body.stream === false) {
          // liveness probe: any 200 is enough
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] })
          )
          return
        }
        if (state.mode === 'hang') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n')
          // 保持连接打开（不要监听 req 'close'——那是请求体读完的信号，不是客户端断开）；
          // 客户端 abort 时 socket 关闭，响应自动销毁
          return
        }
        const msgs = body.messages || []
        const hasToolResult = msgs.some((m) => m.role === 'tool')
        // 子 Agent 标识：system prompt 以「被主 Agent 派出的子 Agent」开头。
        // 子 Agent 与主 Agent 共用同一套 tools，不能用 tools 有无来区分。
        const sysText = String((msgs.find((m) => m.role === 'system') || {}).content || '')
        const isSubAgent = sysText.includes('被主 Agent 派出的子 Agent')
        if (isSubAgent) {
          state.subInFlight++
          state.subPeak = Math.max(state.subPeak, state.subInFlight)
          setTimeout(() => {
            state.subInFlight--
            sse(res, [
              JSON.stringify({
                choices: [
                  { index: 0, delta: { content: '子结论:' + (msgs[1] && msgs[1].content) } }
                ]
              }),
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            ])
          }, 120)
          return
        }
        if (body.tools && state.clusterSpawn) {
          // 已经收回子 Agent 结论 → 汇总收尾；否则派发一次批量 spawn
          const sawSubResult = msgs.some(
            (m) => m.role === 'tool' && String(m.content || '').includes('子结论')
          )
          if (sawSubResult) {
            sse(res, [
              JSON.stringify({ choices: [{ index: 0, delta: { content: '集群任务完成。' } }] }),
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            ])
            return
          }
          if (hasToolResult) {
            // 已有其他工具结果但还没拿到子结论：直接收尾，避免无限循环
            sse(res, [
              JSON.stringify({ choices: [{ index: 0, delta: { content: '集群任务完成。' } }] }),
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            ])
            return
          }
          sse(res, [
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-spawn',
                        type: 'function',
                        function: {
                          name: 'spawn_agent',
                          arguments: JSON.stringify({ goals: ['子任务一', '子任务二', '子任务三'] })
                        }
                      }
                    ]
                  }
                }
              ]
            }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          ])
          return
        }
        if (body.tools && body.tools.length && !hasToolResult) {
          sse(res, [
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({
                            path: state.agentFile,
                            content: 'E2E写入内容'
                          })
                        }
                      }
                    ]
                  }
                }
              ]
            }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          ])
          return
        }
        if (hasToolResult) {
          sse(res, [
            JSON.stringify({
              choices: [{ index: 0, delta: { content: '文件已写入，任务完成。' } }]
            }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          ])
          return
        }
        const kbUsed = msgs.some(
          (m) => m.role === 'system' && m.content && m.content.includes('知识库检索结果')
        )
        const answer = kbUsed ? '根据知识库，答案是确定的 [1]。' : '你好！这是E2E模拟回复。'
        sse(res, [
          JSON.stringify({ choices: [{ index: 0, delta: { content: answer } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        ])
        return
      }
      res.writeHead(404)
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        state,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}
