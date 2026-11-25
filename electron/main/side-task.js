const repos = require('../store/repos')
const dbm = require('../store/db')
const { chatStream } = require('./gateway/client')
const scheduler = require('./gateway/scheduler')
const gateway = require('./gateway/index')
const { decryptSecret } = require('../store/keys')
const { broadcast } = require('./notify')

// 侧边任务：临时子会话。消息只在渲染层保存，本模块只负责组装上下文并流式回传，
// 不写数据库、不进入主会话历史，因此不会计入主会话上下文。
const active = new Map() // id -> AbortController

function safeJson(s, d) {
  try {
    return s ? JSON.parse(s) : d
  } catch {
    return d
  }
}

// 主会话转写：保留最近 maxChars 字符，避免超出模型上下文上限
function transcriptOf(db, conversationId, maxChars) {
  const rows = repos
    .listMessages(db, conversationId)
    .filter((m) => m && m.content && m.status !== 'error')
  const lines = rows.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content)}`)
  let text = lines.join('\n\n')
  if (maxChars > 0 && text.length > maxChars) text = '（较早内容已省略）\n\n' + text.slice(-maxChars)
  return text
}

async function send({ id, conversationId, content, history, useContext } = {}) {
  const runId = String(id || '')
  const text = String(content == null ? '' : content).trim()
  if (!runId) throw new Error('缺少任务 id')
  if (!text) throw new Error('请输入内容')
  if (active.has(runId)) throw new Error('该侧边任务正在生成中')
  const db = dbm.get()
  const { conv, provider, model } = gateway.resolveModel(db, conversationId)
  if (!provider) throw new Error('未配置可用的模型服务')
  if (!model) throw new Error('当前供应商没有可用模型')
  const params = gateway.effectiveParams(
    safeJson(repos.getSetting(db, 'chatSampling'), {}),
    provider,
    model,
    {}
  )
  const keyRows = repos.listAllKeysWithSecret(db).filter((k) => k.providerId === provider.id)
  if (!keyRows.length) throw new Error(`供应商「${provider.name}」没有可用的 Key`)

  const maxChars = Number(params.maxChars) || 12000
  const transcript =
    useContext !== false && conversationId
      ? transcriptOf(db, conversationId, maxChars)
      : ''
  const system = [
    '你是主会话旁的临时助手，用来解读、释疑、探索或推演分支方案。',
    '临时会话的消息不会计入主会话上下文，也不会改动主会话。',
    conv && conv.systemPrompt ? `主会话系统提示词：\n${conv.systemPrompt}` : '',
    transcript ? `以下是主会话的既有对话（仅作背景参考，不要机械复述）：\n\n${transcript}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const historyRows = Array.isArray(history) ? history : []
  const messages = [
    { role: 'system', content: system },
    ...historyRows
      .filter((m) => m && m.content)
      .slice(-40)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content)
      })),
    { role: 'user', content: text }
  ]
  const payload = { model, messages, stream: true }
  if (params.temperature != null) payload.temperature = Number(params.temperature)
  if (params.topP != null) payload.top_p = Number(params.topP)
  if (Number(params.maxTokens)) payload.max_tokens = Number(params.maxTokens)

  const ac = new AbortController()
  active.set(runId, ac)
  broadcast('side:event', { type: 'start', id: runId })
  void (async () => {
    let acc = ''
    let lastErr = null
    const exclude = []
    const maxAttempts = Math.max(1, Math.min(3, keyRows.length))
    for (let i = 0; i < maxAttempts; i++) {
      if (ac.signal.aborted) break
      const key = scheduler.pickKey(keyRows, provider.rotation_strategy, exclude, Date.now())
      if (!key) break
      exclude.push(key.id)
      try {
        const r = await chatStream(
          { baseUrl: provider.base_url, apiKey: await decryptSecret(key.secretEnc), payload },
          {
            signal: ac.signal,
            onDelta: (d) => {
              acc += d
              broadcast('side:event', { type: 'delta', id: runId, delta: d })
            }
          }
        )
        broadcast('side:event', { type: 'done', id: runId, content: r.content || acc })
        return
      } catch (e) {
        if (e && e.name === 'AbortError') break
        lastErr = String((e && e.message) || e)
      }
    }
    if (ac.signal.aborted) {
      broadcast('side:event', { type: 'stopped', id: runId, content: acc })
    } else {
      broadcast('side:event', { type: 'error', id: runId, message: lastErr || '无可用 Key' })
    }
  })()
    .catch((e) =>
      broadcast('side:event', { type: 'error', id: runId, message: String((e && e.message) || e) })
    )
    .finally(() => {
      if (active.get(runId) === ac) active.delete(runId)
    })
  return { ok: true }
}

function stop({ id } = {}) {
  const ac = active.get(String(id || ''))
  if (!ac) return { stopped: false }
  ac.abort()
  return { stopped: true }
}

function stopAll() {
  for (const ac of active.values()) {
    try {
      ac.abort()
    } catch {
      // 已结束的控制器 abort 是空操作
    }
  }
  active.clear()
}

module.exports = { send, stop, stopAll }
