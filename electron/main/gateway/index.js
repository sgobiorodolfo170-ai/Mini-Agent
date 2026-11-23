const repos = require('../../store/repos')
const dbm = require('../../store/db')
const { chatStream, chatOnce, GatewayError } = require('./client')
const scheduler = require('./scheduler')
const { buildContext } = require('./context')
const { decryptSecret } = require('../../store/keys')
const { broadcast } = require('../notify')
const { searchKb } = require('../rag/index')
const title = require('./title')
const { isShuttingDown } = require('../lifecycle')

// assistantMsgId -> { ac: AbortController, conversationId }
// 值里带上 conversationId，让「按会话中止」与前端事件归属判断有据可依。
const active = new Map()

// 已被取代（regenerate / editResend / 新发送）的消息 id：
// 仅存在 Map 里不够，重试循环会在下一轮重新 set 让旧流复活，故单独记录。
const superseded = new Set()

// 流式检查点：受时间与增量长度双重节流，避免每个 token 都写库。
const CHECKPOINT_MS = 500
const CHECKPOINT_CHARS = 2048

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
  // 退出流程已开始：不再登记新流，并把占位消息落为 stopped，避免界面停在「生成中」。
  if (isShuttingDown()) {
    try {
      repos.updateMessage(db, assistantMsgId, { status: 'stopped' })
      broadcast('chat:event', { type: 'stopped', conversationId, msgId: assistantMsgId })
    } catch {
      // 数据库可能已关闭，退出阶段忽略
    }
    return
  }
  // 在首个 await 前登记，退出时能中止仍处于准备/重试间隙的流。
  const streamController = new AbortController()
  let resolveDone
  const done = new Promise((resolve) => (resolveDone = resolve))
  const streamEntry = { ac: streamController, conversationId, done }
  active.set(assistantMsgId, streamEntry)
  let acc = ''
  // 检查点节流状态（每次 startStream 独立）：首跳从当下起算，避免第一个 token 就写库
  let lastCheckpointAt = Date.now()
  let pendingCheckpoint = ''
  const checkpoint = (force = false) => {
    if (!pendingCheckpoint && !force) return
    const nowMs = Date.now()
    const big = pendingCheckpoint.length >= CHECKPOINT_CHARS
    if (!force && !big && nowMs - lastCheckpointAt < CHECKPOINT_MS) return
    lastCheckpointAt = nowMs
    pendingCheckpoint = ''
    // 只更新内容，状态仍为 streaming：进程崩溃时启动钩子会将其标记为 stopped
    repos.updateMessage(db, assistantMsgId, { content: acc })
  }
  try {
    // 放在 try 内：resolveModel 抛错时也必须走 finally 释放 active 与 done。
    const { provider, model, conv } = resolveModel(db, conversationId)
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
      // 本轮已被 regenerate / editResend / 新发送取代：立即收尾，不重试、不写库
      if (superseded.has(assistantMsgId)) {
        superseded.delete(assistantMsgId)
        return
      }
      const key = scheduler.pickKey(keyRows, provider.rotation_strategy, exclude, Date.now())
      if (!key) break
      exclude.push(key.id)
      // 准备期间可能被 stopAllStreams 中止或 abortStreamsOf 取代：不得在此处复活旧流。
      if (superseded.delete(assistantMsgId)) return
      if (streamController.signal.aborted) {
        repos.updateMessage(db, assistantMsgId, { content: acc, status: 'stopped' })
        return
      }
      const ac = streamEntry.ac
      const entry = streamEntry
      active.set(assistantMsgId, entry)
      try {
        const r = await chatStream(
          { baseUrl: provider.base_url, apiKey: await decryptSecret(key.secretEnc), payload },
          {
            signal: ac.signal,
            onDelta: (d) => {
              acc += d
              pendingCheckpoint += d
              checkpoint()
              broadcast('chat:event', {
                type: 'delta',
                conversationId,
                msgId: assistantMsgId,
                delta: d
              })
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
        // 成功路径同样要释放控制器，否则 active 会随消息数无限增长。
        // 若本条已被 regenerate/editResend/新发送取代，则不再写入与广播（避免脏写过期消息）。
        const replaced = superseded.delete(assistantMsgId)
        const stillCurrent = active.has(assistantMsgId)
        active.delete(assistantMsgId)
        if (replaced || !stillCurrent) return
        repos.updateMessage(db, assistantMsgId, {
          content: r.content || acc,
          status: 'done',
          meta: Object.keys(meta).length ? meta : null
        })
        repos.touchConversation(db, conversationId)
        broadcast('chat:event', {
          type: 'done',
          conversationId,
          msgId: assistantMsgId,
          content: r.content || acc,
          meta: Object.keys(meta).length ? meta : null
        })
        return
      } catch (e) {
        active.delete(assistantMsgId)
        if (e && e.name === 'AbortError') {
          // 被 regenerate / editResend / 新发送取代：静默退出，不写库也不广播
          if (superseded.delete(assistantMsgId)) return
          // 中止时强制落一次检查点，保证已生成内容与停止状态一致
          checkpoint(true)
          repos.updateMessage(db, assistantMsgId, { content: acc, status: 'stopped' })
          broadcast('chat:event', {
            type: 'stopped',
            conversationId,
            msgId: assistantMsgId,
            content: acc
          })
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
          conversationId,
          msgId: assistantMsgId,
          message: `Key「${key.label || key.id.slice(0, 6)}」失败(${kind})，尝试切换…`
        })
      }
    }
    // 重试用尽仍需清理取代标记，避免 Set 长期残留
    superseded.delete(assistantMsgId)
    repos.updateMessage(db, assistantMsgId, {
      status: 'error',
      content: acc,
      meta: { error: lastErr || '无可用 Key' }
    })
    active.delete(assistantMsgId)
    broadcast('chat:event', {
      type: 'error',
      conversationId,
      msgId: assistantMsgId,
      message: lastErr || '无可用 Key'
    })
  } catch (e) {
    const msg = String((e && e.message) || e)
    superseded.delete(assistantMsgId)
    repos.updateMessage(db, assistantMsgId, { status: 'error', content: acc, meta: { error: msg } })
    active.delete(assistantMsgId)
    broadcast('chat:event', { type: 'error', conversationId, msgId: assistantMsgId, message: msg })
  } finally {
    if (active.get(assistantMsgId) === streamEntry) active.delete(assistantMsgId)
    resolveDone()
  }
  return streamEntry.done
}

async function sendChat({ conversationId, content, kbIds, attachments, originMessageId }) {
  const db = dbm.get()
  if (isShuttingDown()) throw new Error('应用正在退出，无法发送新消息')
  if (originMessageId) {
    const existing = repos.getMessage(db, originMessageId)
    if (existing) {
      const messages = repos.listMessages(db, conversationId)
      const userIndex = messages.findIndex((m) => m.id === originMessageId)
      const assistant = messages.slice(userIndex + 1).find((m) => m.role === 'assistant')
      return { assistantMsgId: assistant && assistant.id, reused: true }
    }
  }
  const conv = repos.getConversation(db, conversationId)
  if (!conv) throw new Error('会话不存在')
  // 后端闸门：同一会话同时只允许一条在途流（前端 hasStreaming 只是第一道拦截）
  repos.assertNoActiveRun(db, conversationId)
  abortStreamsOf(conversationId, 'new-send')
  // 「第一轮」在插入本条消息前判定：会话此前的消息为空即第一轮
  const isFirstRound =
    repos.listMessages(db, conversationId).filter((m) => !m.deleted_at).length === 0
  const userMsg = repos.insertMessage(db, {
    id: originMessageId || undefined,
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
  // 会话标题 = 第一轮提示词优化后的结果（异步、不阻塞发送链路；
  // 只在会话仍是默认标题时生效，模型服务不可用时回退原文截断）
  if (isFirstRound) {
    title
      .titleConversation(
        { dbm, repos, scheduler, chatOnce, resolveModel, decryptSecret, broadcast },
        { conversationId, content }
      )
      .catch(() => {})
  }
  startStream({
    conversationId,
    assistantMsgId: assistant.id,
    kbIds: kbIds || [],
    attachments: attachments || []
  }).catch(() => {})
  return { userMsgId: userMsg.id, assistantMsgId: assistant.id }
}

// 中止某会话所有在途流（regenerate / editResend / 重复发送前调用），
// 避免旧流跑完后写入已软删的消息并广播过期的 done。
function abortStreamsOf(conversationId, by = 'unknown') {
  const recalled = []
  for (const [msgId, entry] of active) {
    if (entry && entry.conversationId === conversationId) {
      // 标记为「被取代」：中止后不再写库、不再广播，且重试循环不得复活它
      superseded.add(msgId)
      try {
        entry.ac.abort()
      } catch {
        // 已结束的控制器 abort 是空操作
      }
      active.delete(msgId)
      // 旧消息已不可能再收到本流的终态事件（superseded 分支会静默退出），
      // 这里立即落 stopped，避免新发送后旧消息永久停在「生成中」。
      try {
        repos.updateMessage(dbm.get(), msgId, { status: 'stopped' })
        broadcast('chat:event', { type: 'stopped', conversationId, msgId })
      } catch {
        // 数据库未就绪时忽略，不影响中止
      }
      recalled.push(msgId)
    }
  }
  // 内部召回不得静默（方案四 §5.4）：记录发起方与被召回的消息
  if (recalled.length) {
    broadcast('stream.recalled', { conversationId, by, msgIds: recalled })
  }
  return recalled
}

async function regenerate(conversationId) {
  const db = dbm.get()
  if (isShuttingDown()) throw new Error('应用正在退出，无法重新生成')
  const rows = repos.listMessages(db, conversationId)
  const lastAssistant = [...rows].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) throw new Error('没有可重新生成的回复')
  repos.assertNoActiveRun(db, conversationId)
  abortStreamsOf(conversationId, 'regenerate')
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
  if (isShuttingDown()) throw new Error('应用正在退出，无法编辑重发')
  const msg = repos.getMessage(db, msgId)
  if (!msg) throw new Error('消息不存在')
  repos.assertNoActiveRun(db, msg.conversationId)
  abortStreamsOf(msg.conversationId, 'edit-resend')
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
  const entry = active.get(msgId)
  if (entry && entry.ac) {
    entry.ac.abort()
    return true
  }
  return false
}

async function stopAllStreams() {
  const current = [...active.entries()]
  for (const [, entry] of current) {
    try {
      entry.ac.abort()
    } catch {
      // 已结束的 AbortController 无需处理
    }
  }
  await Promise.allSettled(current.map(([, entry]) => entry.done))
  // 只清理本次快照：等待期间新登记的流不归这里管（入口已由 isShuttingDown 拦截）。
  for (const [msgId, entry] of current) {
    if (active.get(msgId) === entry) active.delete(msgId)
  }
}

// 提示词优化：结合当前会话最近几轮上下文，把输入框草稿改写为更明确的提示词。
// 与主对话共用供应商/模型/密钥调度，但不写入消息记录。
async function optimizePrompt({ conversationId, content } = {}) {
  const draft = String(content || '').trim()
  if (!draft) throw new Error('请先输入提示词')
  const db = dbm.get()
  const { provider, model } = resolveModel(db, conversationId)
  if (!provider) throw new Error('未配置模型服务，请先在设置中添加供应商')
  if (!model) throw new Error('未配置模型，请先在「设置 → 会话」中选择')
  const keyRows = repos.listAllKeysWithSecret(db).filter((x) => x.providerId === provider.id)
  if (!keyRows.length) throw new Error(`供应商「${provider.name}」没有可用的 Key`)

  const rows = conversationId ? repos.listMessages(db, conversationId) : []
  const history = rows
    .filter(
      (m) =>
        m.status !== 'error' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
    )
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 400)}`)
    .join('\n')

  const system = [
    '你是提示词优化助手。',
    '请结合对话上下文，把用户当前的草稿改写成更清晰、具体、可执行的提示词。',
    '保留原意，不编造事实；只输出优化后的提示词，不要解释或添加前后缀。'
  ].join('\n')
  const user = [history ? `对话上下文：\n${history}` : '', `当前草稿：\n${draft}`]
    .filter(Boolean)
    .join('\n\n')

  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    stream: false
  }

  const exclude = []
  let lastErr = null
  const maxAttempts = Math.max(1, Math.min(3, keyRows.length))
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = scheduler.pickKey(keyRows, provider.rotation_strategy, exclude, Date.now())
    if (!key) break
    exclude.push(key.id)
    try {
      const r = await chatOnce({
        baseUrl: provider.base_url,
        apiKey: await decryptSecret(key.secretEnc),
        payload
      })
      repos.updateKeyStatus(db, key.id, {
        ...scheduler.applyKeyResult(key, 'ok', Date.now()),
        lastUsedAt: Date.now()
      })
      const prompt = String((r && r.content) || '').trim()
      if (!prompt) throw new Error('模型未返回优化结果')
      return { prompt }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('提示词优化失败')
}

module.exports = {
  sendChat,
  regenerate,
  editResend,
  stopChat,
  stopAllStreams,
  optimizePrompt,
  resolveModel,
  modelParams,
  effectiveParams,
  msgOut,
  safeJson
}
