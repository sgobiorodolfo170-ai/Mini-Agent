// Pure agent loop: model-call driven tool execution with risk gates.
// Dependencies are injected so this stays unit-testable.
function safeParseJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

async function runAgentLoop({
  messages,
  modelCall,
  toolMap,
  maxSteps = 15,
  decide,
  execute,
  onEvent,
  isStopped,
  isTransferred
}) {
  const msgs = [...messages]
  let steps = 0
  let status = 'done'
  let endedWithToolCalls = false

  loop: while (steps < maxSteps) {
    if (isStopped && isStopped()) {
      status = 'stopped'
      break
    }
    steps++
    const resp = await modelCall(msgs)
    if (resp?.stopped || isStopped?.()) {
      status = 'stopped'
      break
    }
    const toolCalls = (resp && resp.toolCalls) || []
    if (resp && resp.content) {
      msgs.push({
        role: 'assistant',
        content: resp.content,
        tool_calls: toolCalls.length ? toolCalls : undefined
      })
    } else if (toolCalls.length) {
      msgs.push({ role: 'assistant', content: '', tool_calls: toolCalls })
    }
    if (onEvent) onEvent('assistant', { content: resp && resp.content, toolCalls })

    if (!toolCalls.length) {
      endedWithToolCalls = false
      break
    }
    endedWithToolCalls = true

    for (const tc of toolCalls) {
      if (isStopped?.()) {
        status = 'stopped'
        break loop
      }
      const name = tc.function && tc.function.name
      const args = safeParseJson((tc.function && tc.function.arguments) || '{}') || {}
      const tool = toolMap[name]
      const riskLevel = tool ? tool.risk : 'readonly'
      let allowed = true
      let decision = null
      if (decide) {
        decision = await decide({ name, args, riskLevel, exists: !!tool })
        allowed = !!decision.allowed
      }
      if (onEvent) onEvent('tool-start', { name, args, riskLevel, allowed })

      let resultText
      let ok = true
      if (!tool) {
        ok = false
        resultText = `未知工具: ${name}`
      } else if (!allowed) {
        ok = false
        resultText = (decision && decision.denyMessage) || '用户拒绝执行该操作'
      } else {
        try {
          const r = await execute(tool, args, tc.id)
          resultText = typeof r === 'string' ? r : JSON.stringify(r)
        } catch (e) {
          ok = false
          resultText = `工具执行失败: ${String((e && e.message) || e)}`
        }
      }
      if (resultText && resultText.length > 20000)
        resultText = resultText.slice(0, 20000) + '…(截断)'
      if (onEvent) onEvent('tool-done', { name, ok, result: resultText })
      msgs.push({ role: 'tool', tool_call_id: tc.id || name, content: resultText })
      if (isTransferred?.()) {
        status = 'transferred'
        break loop
      }
      if (isStopped?.()) {
        status = 'stopped'
        break loop
      }
    }
  }
  if (status === 'done' && endedWithToolCalls) status = 'max_steps'
  return { status, messages: msgs, steps }
}

module.exports = { runAgentLoop, safeParseJson }
