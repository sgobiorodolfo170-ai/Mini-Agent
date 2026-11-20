// Pure context builder: system prompt + KB blocks + truncated history.
function renderKbSystem(blocks) {
  const lines = [
    '以下是与当前问题相关的知识库检索结果。引用这些内容时，请在对应句子末尾标注 [n] 编号：'
  ]
  for (const b of blocks) {
    const head = `[${b.n}] 来源：${b.title}${b.headingPath ? ' > ' + b.headingPath : ''}`
    lines.push(head)
    lines.push(b.text)
    lines.push('')
  }
  return lines.join('\n')
}

function buildContext({ systemPrompt, history, maxChars = 12000, keepTurns = 20, kbBlocks }) {
  const msgs = []
  if (systemPrompt && systemPrompt.trim())
    msgs.push({ role: 'system', content: systemPrompt.trim() })
  if (kbBlocks && kbBlocks.length) msgs.push({ role: 'system', content: renderKbSystem(kbBlocks) })

  const budget = Math.max(2000, maxChars)
  const recent = (history || []).slice(-(keepTurns || 20) * 2)
  const picked = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]
    const len = (m.content || '').length
    if (used + len > budget && picked.length > 0) break
    picked.unshift(m)
    used += len
  }
  msgs.push(...picked)
  return msgs
}

module.exports = { buildContext, renderKbSystem }
