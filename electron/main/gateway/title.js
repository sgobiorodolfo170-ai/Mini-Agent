// 会话自动命名：会话第一轮提示词经「提示词优化」后作为会话标题。
// 复用对话网关的供应商/模型/Key 调度（与 chat:optimizePrompt 同链路），
// 失败时回退为原文截断，保证标题始终可用；只更新标题仍是默认值的会话。

const FALLBACK_MAX = 24

// 测试环境跳过自动命名（沿用主进程 isTestMode 约定）：
// e2e 用 MINIAGENT_USER_DATA 标记、单测由 vitest 注入 NODE_ENV=test；
// 两类测试的 mock/fetch 断言均未覆盖标题请求，跳过以保持确定性
function canAutoTitle() {
  return !(process.env.MINIAGENT_USER_DATA || process.env.NODE_ENV === 'test')
}

function fallbackTitle(content) {
  const s = String(content || '').replace(/\s+/g, ' ').trim()
  return (s.slice(0, FALLBACK_MAX) || '新会话').trim() || '新会话'
}

// 模型输出的标题清理：去思考包装、取首行、截断、空值兜底
function sanitizeTitle(raw, fb) {
  const s = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「『"“']+/, '')
    .replace(/[」』"”'.。]+$/, '')
    .replace(/^\*+/, '')
    .trim()
  if (!s) return fb
  return s.slice(0, FALLBACK_MAX)
}

function buildMessages(content) {
  const system = [
    '你是会话命名助手。根据用户的第一轮提示词生成一个简洁的会话标题。',
    '要求：不超过 12 个字；概括任务目标，不要逐字复述；不要解释、不要引号、不要句号，只输出标题本身。'
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: `用户第一轮提示词：\n${String(content || '').slice(0, 500)}` }
  ]
}

/**
 * 为会话生成标题并落库。
 * @param {object} deps { dbm, repos, scheduler, chatOnce, resolveModel, decryptSecret, broadcast }
 * @returns {Promise<{title:string, source:'model'|'fallback'|'kept'}>}
 */
async function titleConversation(deps, { conversationId, content }) {
  const { dbm, repos, scheduler, chatOnce, resolveModel, decryptSecret, broadcast } = deps
  const db = dbm.get()
  const conv = repos.getConversation(db, conversationId)
  if (!conv) return null
  // 只命名「默认标题」的会话；用户重命名过或已命名的不再覆盖
  if (conv.title && conv.title !== '新会话') return { title: conv.title, source: 'kept' }
  // 测试环境：直接用原文截断（回退路径），不触发网络调用
  if (!canAutoTitle()) {
    const fbTest = fallbackTitle(content)
    const updatedTest = repos.updateConversation(db, conversationId, { title: fbTest })
    return { title: updatedTest.title, source: 'fallback' }
  }
  const fb = fallbackTitle(content)

  // 无可用服务时直接回退，不抛错（标题生成不应影响消息发送主链路）
  try {
    const { provider, model } = resolveModel(db, conversationId)
    if (!provider || !model) throw new Error('no provider/model')
    const keyRows = repos.listAllKeysWithSecret(db).filter((x) => x.providerId === provider.id)
    if (!keyRows.length) throw new Error('no keys')

    const payload = { model, messages: buildMessages(content), stream: false }
    const exclude = []
    const maxAttempts = Math.max(1, Math.min(2, keyRows.length))
    let lastErr = null
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
        const title = sanitizeTitle(r && r.content, fb)
        const updated = repos.updateConversation(db, conversationId, { title })
        broadcast('chat:event', {
          type: 'conversationRenamed',
          conversationId,
          title: updated.title
        })
        return { title: updated.title, source: 'model' }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('title model call failed')
  } catch {
    const updated = repos.updateConversation(db, conversationId, { title: fb })
    broadcast('chat:event', {
      type: 'conversationRenamed',
      conversationId,
      title: updated.title
    })
    return { title: updated.title, source: 'fallback' }
  }
}

module.exports = { titleConversation, fallbackTitle, sanitizeTitle }
