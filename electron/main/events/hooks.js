// 生命周期钩子：在固定阶段对固定事件做「通知 / 记录 / 拦截」。
//
// 安全边界（重要）：
// - 钩子只能来自用户写入的设置项，**不允许**模型自行注册，也不能执行任意代码；
// - 动作只有三类声明式语义：notify（推一条通知）、log（记一条事件）、block（拒绝该操作）；
// - block 只能「更严格」——它可以把一次调用从允许改为拒绝，但无法把需要用户确认的
//   写操作放行，因此不会成为绕过确认/权限的通道。
//
// 阶段：session.send / run.start / run.end / tool.before / tool.after

const STAGES = ['session.send', 'run.start', 'run.end', 'tool.before', 'tool.after']
const ACTIONS = ['notify', 'log', 'block']

function matches(pattern, value) {
  const p = String(pattern || '').trim()
  if (!p || p === '*') return true
  if (p.endsWith('*')) return String(value || '').startsWith(p.slice(0, -1))
  return p === String(value || '')
}

// 校验并归一化一条钩子配置；非法项直接丢弃（配置坏了不应阻断任务）
function normalizeRule(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const stage = String(raw.stage || '').trim()
  if (!STAGES.includes(stage)) return null
  const action = String(raw.action || '').trim()
  if (!ACTIONS.includes(action)) return null
  const rule = {
    id: String(raw.id || `h${index + 1}`),
    stage,
    action,
    // 粗匹配：run / tool / session 维度，缺省为全部
    match: raw.match && typeof raw.match === 'object' ? { ...raw.match } : {},
    message: raw.message ? String(raw.message).slice(0, 500) : '',
    enabled: raw.enabled !== false
  }
  if (action === 'block') rule.reason = String(raw.reason || '已被钩子策略拦截').slice(0, 300)
  return rule
}

function parseHooks(raw) {
  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list.map(normalizeRule).filter(Boolean)
}

// 取钩子的匹配字段值：不同阶段看不同维度
function contextValueFor(rule, ctx, field) {
  if (field === 'tool') return ctx.tool
  if (field === 'run') return ctx.runId
  if (field === 'session' || field === 'conversation') return ctx.conversationId
  if (field === 'stage') return ctx.stage
  return undefined
}

function ruleMatches(rule, ctx) {
  if (!rule.enabled) return false
  if (rule.stage !== ctx.stage) return false
  return Object.keys(rule.match).every((field) =>
    matches(rule.match[field], contextValueFor(rule, ctx, field))
  )
}

// 运行一次阶段的钩子。返回 { blocked, reason, notifications, logs }
// 任一 block 命中即拦截；通知与记录照常收集（便于审计「为什么被拦」）。
function runHooks(rules, stage, ctx = {}) {
  const result = { blocked: false, reason: '', notifications: [], logs: [] }
  const full = { stage, ...ctx }
  for (const rule of rules || []) {
    if (!ruleMatches(rule, full)) continue
    if (rule.action === 'notify') {
      result.notifications.push({
        ruleId: rule.id,
        level: 'info',
        message: rule.message || `钩子 ${rule.id} 触发（${stage}）`
      })
    } else if (rule.action === 'log') {
      result.logs.push({
        ruleId: rule.id,
        stage,
        message: rule.message || '',
        ctx: { tool: ctx.tool, runId: ctx.runId, conversationId: ctx.conversationId }
      })
    } else if (rule.action === 'block') {
      if (!result.blocked) {
        result.blocked = true
        result.reason = rule.reason || '已被钩子策略拦截'
        result.blockedBy = rule.id
      }
    }
  }
  return result
}

// 带副作用执行：把 runHooks 的结果翻译成广播与日志回调。
// sink: { broadcast(channel, payload), log(entry) }
function applyHooks(rules, stage, ctx, sink = {}) {
  const r = runHooks(rules, stage, ctx)
  for (const n of r.notifications) {
    if (sink.broadcast) sink.broadcast('app:notice', { level: n.level, message: n.message })
  }
  for (const l of r.logs) {
    if (sink.log) sink.log(l)
  }
  return r
}

module.exports = { STAGES, ACTIONS, normalizeRule, parseHooks, ruleMatches, runHooks, applyHooks }
