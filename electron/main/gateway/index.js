const repos = require('../../store/repos')
const dbm = require('../../store/db')
const { chatStream, GatewayError } = require('./client')
const scheduler = require('./scheduler')
const { buildContext } = require('./context')
const { decryptSecret } = require('../../store/keys')
const { broadcast } = require('../notify')
const { searchKb } = require('../rag/index')

const active = new Map() // assistantMsgId -> AbortController

const DEFAULT_CONTEXT_CHARS = 12000
const DEFAULT_KEEP_TURNS = 20

function safeJson(s, d) {
  try {
    return s ? JSON.parse(s) : d == null ? d : JSON.parse(JSON.stringify(d))
  } catch {
    return d
  }
}

function msgOut(m) {
  if (!m) return null
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    toolCalls: safeJson(m.toolCalls, null),
    attachments: safeJson(m.attachments, null),
    meta: safeJson(m.meta, null),
    status: m.status,
    seq: m.seq,
    createdAt: m.createdAt || m.created_at
  }
}

// 服务与模型完全由用户手动选择（默认供应商/默认模型设置已删除）：
// ① 会话指定了供应商 → 用它；② 未指定但指定了模型 → 找拥有该模型的供应商；
// ③ 都没指定 → 第一个启用供应商 + 它的第一个模型。
function resolveModel(db, conversationId) {
  const conv = conversationId ? repos.getConversation(db, conversationId) : null
  const providers = repos.listProviders(db).filter((p) => p.enabled !== 0)
  const modelsOf = (p) => safeJson(p && p.models, []) || []
  const convModel = (conv && conv.model) || null
  const provider =
    providers.find((p) => p.id === (conv && conv.providerId)) ||
    (convModel && providers.find((p) => modelsOf(p).some((m) => m.id === convModel))) ||
    providers[0] ||
    null
  const models = modelsOf(provider)
  const model = convModel || (models[0] && models[0].id) || null
  return { conv, provider, model }
}

// 提供商模型参数：最大输出长度与上下文上限属于模型级配置（会话设置不再提供）。
function modelParams(provider, modelId) {
  const models = safeJson(provider && provider.models, []) || []
  return models.find((m) => m.id === modelId) || {}
}

// 生效的采样/上下文参数（优先级从高到低）：
// 全局采样设置（设置 → 会话）→ 该模型参数 → 不发送（用服务端默认）；
// 最大输出长度与上下文上限仍属于模型参数（设置 → 模型服务 → 模型参数）。
// 注：会话级 contextPolicy 是历史遗留的兼容层，仅供旧数据回放，不再由界面写入。
function effectiveParams(globalPolicy, provider, modelId, legacyPolicy) {
  const g = globalPolicy || {}
  const l = legacyPolicy || {}
  const m = modelParams(provider, modelId)
  const pick = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null || v === '') continue
      return v
    }
    return undefined
  }
  return {
    temperature: pick(g.temperature, l.temperature, m.temperature),
    topP: pick(g.topP, l.topP, m.topP),
    maxTokens: pick(m.maxTokens),
    maxChars: pick(m.maxChars),
    keepTurns: pick(g.keepTurns, l.keepTurns)
  }
}

function isVisionModel(provider, model) {
  const models = safeJson(provider && provider.models, []) || []
  const m = models.find((x) => x.id === model)
  return !!(m && m.vision)
}

function toApiMessages(rows) {
  return rows.map((m) => {
    const atts = safeJson(m.attachments, []) || []
    const images = atts.filter((a) => a && a.type === 'image' && a.dataUrl)
    if (m.role === 'user' && images.length) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content || '' },
          ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))
        ]
      }
    }
    return { role: m.role === 'tool' ? 'assistant' : m.role, content: m.content || '' }
  })
}

async function retrieveKbBlocks(db, kbIds, query) {
  const blocks = []
  const refs = []
  const warnings = []
  let n = 0
  const k = Number(repos.getSetting(db, 'kbTopK')) || 5
  for (const kbId of kbIds || []) {
    const kb = repos.getKb(db, kbId)
    if (!kb) continue
    try {
      const res = await searchKb(db, kb, query, { k })
      for (const hit of res.blocks) {
        n++
        blocks.push({ n, title: hit.title, headingPath: hit.headingPath, text: hit.text })
        refs.push({
          n,
          chunkId: hit.chunkId,
          docId: hit.docId,
          title: hit.title,
          headingPath: hit.headingPath,
          score: hit.score
        })
      }
    } catch (e) {
      warnings.push(`${kb.name}: ${String((e && e.message) || e).slice(0, 120)}`)
    }
  }
  return { blocks, refs, warnings }
}

function lastUserText(db, conversationId) {
  const rows = repos.listMessages(db, conversationId)
  const u = [...rows].reverse().find((m) => m.role === 'user' && m.content)
  return (u && u.content) || ''
}

async function startStream({ conversationId, assistantMsgId, kbIds, attachments }) {
  const db = dbm.get()
  const { provider, model, conv } = resolveModel(db, conversationId)
  let acc = ''
  try {
    if (!provider) throw new Error('未配置模型服务，请先在设置中添加供应商')
    if (!model) throw new Error('未配置模型，请在「设置 → 会话」中选择')

    const warnings = []
    let kbBlocks = []
    let kbRefs = []
    if (kbIds && kbIds.length) {
      const r = await retrieveKbBlocks(db, kbIds, lastUserText(db, conversationId))
      kbBlocks = r.blocks
      kbRefs = r.refs
      warnings.push(...r.warnings)
    }

    const rows = repos.listMessages(db, conversationId)
    const legacyPolicy = safeJson(conv && conv.contextPolicy, {}) || {}
    const globalPolicy = safeJson(repos.getSetting(db, 'chatSampling'), {}) || {}
    const params = effectiveParams(globalPolicy, provider, model, legacyPolicy)
    const historyRows = rows.filter(
      (m) =>
        m.id !== assistantMsgId &&
        m.status !== 'error' &&
        !(m.role === 'assistant' && !m.content && !(safeJson(m.attachments, []) || []).length)
    )
    const history = historyRows.map((m) => ({
      role: m.role === 'tool' ? 'assistant' : m.role,
      content: m.content,
      attachments: safeJson(m.attachments, [])
    }))
    const messages = buildContext({
      systemPrompt: conv && conv.systemPrompt,
      history,
      maxChars: Number(params.maxChars) || DEFAULT_CONTEXT_CHARS,
      keepTurns: Number(params.keepTurns) || DEFAULT_KEEP_TURNS,
      kbBlocks
    })
    const apiMsgs = toApiMessages(messages)
    if ((attachments || []).length && !isVisionModel(provider, model)) {
      warnings.push('当前模型未标记为「支持视觉」，图片可能无法识别')
    }

    const payload = { model, messages: apiMsgs, stream: true }
    if (params.temperature != null) payload.temperature = Number(params.temperature)
    if (params.topP != null) payload.top_p = Number(params.topP)
    // 最大输出长度来自提供商模型参数（会话设置不再单独配置）
    if (Number(params.maxTokens)) payload.max_tokens = Number(params.maxTokens)

    const keyRows = repos.listAllKeysWithSecret(db).filter((x) => x.providerId === provider.id)
    if (!keyRows.length) throw new Error(`供应商「${provider.name}」没有可用的 Key`)
    const exclude = []
    let lastErr = null
    const maxAttempts = Math.max(1, Math.min(3, keyRows.length))

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = scheduler.pickKey(keyRows, provider.rotation_strategy, exclude, Date.now())
      if (!key) break
      exclude.push(key.id)
      const ac = new AbortController()
      active.set(assistantMsgId, ac)
      try {
        const r = await chatStream(
          { baseUrl: provider.base_url, apiKey: await decryptSecret(key.secretEnc), payload },
          {
            signal: ac.signal,
            onDelta: (d) => {
              acc += d
              broadcast('chat:event', { type: 'delta', msgId: assistantMsgId, delta: d })
            }
          }
        )
        repos.updateKeyStatus(db, key.id, {
          ...scheduler.applyKeyResult(key, 'ok', Date.now()),
          lastUsedAt: Date.now()
        })
        repos.logKeyEvent(db, { apiKeyId: key.id, kind: 'request', result: 'ok', detail: '' })
        const meta = {}
        if (kbRefs.length) meta.kbRefs = kbRefs
        if (warnings.length) meta.warnings = warnings
        repos.updateMessage(db, assistantMsgId, {
          content: r.content || acc,
          status: 'done',
          meta: Object.keys(meta).length ? meta : null
        })
        repos.touchConversation(db, conversationId)
        broadcast('chat:event', {
          type: 'done',
          msgId: assistantMsgId,
          content: r.content || acc,
          meta: Object.keys(meta).length ? meta : null
        })
        return
      } catch (e) {
        active.delete(assistantMsgId)
        if (e && e.name === 'AbortError') {
          repos.updateMessage(db, assistantMsgId, { content: acc, status: 'stopped' })
          broadcast('chat:event', { type: 'stopped', msgId: assistantMsgId, content: acc })
          return
        }
        const kind = e instanceof GatewayError ? e.kind : 'network_error'
        lastErr = String((e && e.message) || e).slice(0, 300)
        repos.updateKeyStatus(
          db,
          key.id,
          scheduler.applyKeyResult(key, kind, Date.now(), { lastError: lastErr })
        )
        repos.logKeyEvent(db, { apiKeyId: key.id, kind: 'request', result: kind, detail: lastErr })
        broadcast('chat:event', {
          type: 'notice',
          msgId: assistantMsgId,
          message: `Key「${key.label || key.id.slice(0, 6)}」失败(${kind})，尝试切换…`
        })
      }
    }
    repos.updateMessage(db, assistantMsgId, {
      status: 'error',
      content: acc,
      meta: { error: lastErr || '无可用 Key' }
    })
    broadcast('chat:event', {
      type: 'error',
      msgId: assistantMsgId,
      message: lastErr || '无可用 Key'
    })
  } catch (e) {
    const msg = String((e && e.message) || e)
    repos.updateMessage(db, assistantMsgId, { status: 'error', content: acc, meta: { error: msg } })
    broadcast('chat:event', { type: 'error', msgId: assistantMsgId, message: msg })
  }
}

async function sendChat({ conversationId, content, kbIds, attachments }) {
  const db = dbm.get()
  const conv = repos.getConversation(db, conversationId)
  if (!conv) throw new Error('会话不存在')
  const userMsg = repos.insertMessage(db, {
    conversationId,
    role: 'user',
    content,
    attachments: attachments && attachments.length ? attachments : null,
    meta: kbIds && kbIds.length ? { kbIds } : null
  })
  repos.touchConversation(db, conversationId)
  const assistant = repos.insertMessage(db, {
    conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })
  broadcast('chat:event', {
    type: 'snapshot',
    conversationId,
    messages: [msgOut(repos.getMessage(db, userMsg.id)), msgOut(repos.getMessage(db, assistant.id))]
  })
  startStream({
    conversationId,
    assistantMsgId: assistant.id,
    kbIds: kbIds || [],
    attachments: attachments || []
  }).catch(() => {})
  return { userMsgId: userMsg.id, assistantMsgId: assistant.id }
}

async function regenerate(conversationId) {
  const db = dbm.get()
  const rows = repos.listMessages(db, conversationId)
  const lastAssistant = [...rows].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) throw new Error('没有可重新生成的回复')
  repos.softDeleteMessagesFrom(db, conversationId, lastAssistant.seq)
  const remaining = repos.listMessages(db, conversationId)
  const lastUser = [...remaining].reverse().find((m) => m.role === 'user')
  const meta = safeJson(lastUser && lastUser.meta, {}) || {}
  const attachments = safeJson(lastUser && lastUser.attachments, []) || []
  const assistant = repos.insertMessage(db, {
    conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })
  broadcast('chat:event', {
    type: 'snapshot',
    conversationId,
    messages: [msgOut(repos.getMessage(db, assistant.id))]
  })
  startStream({
    conversationId,
    assistantMsgId: assistant.id,
    kbIds: meta.kbIds || [],
    attachments
  }).catch(() => {})
  return { assistantMsgId: assistant.id }
}

async function editResend({ msgId, content }) {
  const db = dbm.get()
  const msg = repos.getMessage(db, msgId)
  if (!msg) throw new Error('消息不存在')
  repos.updateMessage(db, msgId, { content })
  repos.softDeleteMessagesFrom(db, msg.conversationId, msg.seq + 1)
  const meta = safeJson(msg.meta, {}) || {}
  const attachments = safeJson(msg.attachments, []) || []
  const assistant = repos.insertMessage(db, {
    conversationId: msg.conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })
  broadcast('chat:event', {
    type: 'snapshot',
    conversationId: msg.conversationId,
    messages: [msgOut(repos.getMessage(db, assistant.id))]
  })
  startStream({
    conversationId: msg.conversationId,
    assistantMsgId: assistant.id,
    kbIds: meta.kbIds || [],
    attachments
  }).catch(() => {})
  return { assistantMsgId: assistant.id }
}

function stopChat(msgId) {
  const ac = active.get(msgId)
  if (ac) {
    ac.abort()
    return true
  }
  return false
}

module.exports = {
  sendChat,
  regenerate,
  editResend,
  stopChat,
  resolveModel,
  modelParams,
  effectiveParams,
  msgOut,
  safeJson
}
