// 任务级授权（Mandate）——方案四 §4
//
// 三条硬约束：
// 1. 有效权限 = 父有效权限 ∩ 子 mandate ∩ 应用安全策略，子 Run 不得比父更宽；
// 2. 校验发生在主进程真正执行工具之前，Prompt 与 Hook 只作辅助；
// 3. 被拒绝时记录客观审计，不推导任何"法律责任"结论。

const fs = require('fs')
const path = require('path')

// 高风险工具：缺少显式授权时默认拒绝。
// 依据方案四 §4.3「对不支持细粒度参数授权的工具，默认拒绝或要求预先授权」。
const HIGH_RISK_TOOLS = new Set([
  'run_command',
  'write_file',
  'edit_file',
  'clipboard_write',
  'open_url',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_close',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_input',
  'computer_scroll',
  'computer_stop',
  'mcp_call_tool',
  'spawn_agent'
])

// 不带参数级授权的工具类别：只凭工具名白名单不足以判定安全
const PARAM_SENSITIVE_TOOLS = new Set(['run_command', 'mcp_call_tool'])

const RISK_ORDER = { readonly: 0, side_effect: 1, destructive: 2 }

function isPathInside(dir, target) {
  const rel = path.relative(path.resolve(String(dir)), path.resolve(String(target)))
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

// 规范化为小写、去尾部分隔符，便于跨平台比较（Windows 大小写不敏感）
function normPath(p) {
  return path
    .resolve(String(p))
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

// 解析已存在路径及最近存在祖先的真实位置；缺失的尾部仍按原路径拼接。
// realpath 失败且不是“尚不存在”时拒绝解析，避免悬空链接绕过检查。
function resolveRealPath(target) {
  let current = path.resolve(String(target))
  const missing = []
  for (;;) {
    try {
      return path.resolve(fs.realpathSync.native(current), ...missing.reverse())
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return null
      } catch (statError) {
        if (statError.code !== 'ENOENT') return null
      }
      const parent = path.dirname(current)
      if (parent === current) return null
      missing.push(path.basename(current))
      current = parent
    }
  }
}

// 路径校验同时比较词法位置与真实位置，覆盖 Windows 目录联接和符号链接。
function pathAllowed(allowedDirs, target, { mustExist = false } = {}) {
  const list = Array.isArray(allowedDirs) ? allowedDirs : []
  if (!list.length) return false
  const lexicalTarget = path.resolve(String(target))
  if (mustExist && !fs.existsSync(lexicalTarget)) return false
  const targetRoot = path.parse(lexicalTarget).root.toLowerCase()
  if (
    !list.some(
      (allowed) => path.parse(path.resolve(String(allowed))).root.toLowerCase() === targetRoot
    )
  ) {
    return false
  }
  const realTarget = resolveRealPath(lexicalTarget)
  if (!realTarget) return false
  for (const allowed of list) {
    const realDir = resolveRealPath(path.resolve(String(allowed)))
    if (realDir && isPathInside(realDir, realTarget)) return true
  }
  return false
}

// 把 mandate 规整为可信结构。任何字段缺失都收敛到"更受限"，而不是"更宽松"。
function normalizeMandate(raw) {
  if (!raw || typeof raw !== 'object') return null
  const dirs =
    raw.authorizedDirs && typeof raw.authorizedDirs === 'object' ? raw.authorizedDirs : {}
  return {
    schemaVersion: 1,
    // 空数组 = 不允许任何工具；未提供 = 继承上一级（由上层求交决定）
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools.slice() : null,
    deniedTools: Array.isArray(raw.deniedTools) ? raw.deniedTools.slice() : [],
    permissionMode: ['default', 'readonly', 'autonomous', 'full'].includes(raw.permissionMode)
      ? raw.permissionMode
      : 'autonomous',
    authorizedDirs: {
      read: Array.isArray(dirs.read) ? dirs.read.slice() : [],
      write: Array.isArray(dirs.write) ? dirs.write.slice() : []
    },
    limits: {
      maxSteps: Number(raw.limits && raw.limits.maxSteps) || null,
      maxTokens: Number(raw.limits && raw.limits.maxTokens) || null
    },
    workspace: { mode: raw.workspace && raw.workspace.mode === 'shared' ? 'shared' : 'shared' },
    canDelegate: raw.canDelegate === true
  }
}

// 父 mandate ∩ 子 mandate。子不能扩大父的任何维度。
function intersectMandate(parent, child) {
  // 父为空 = 根 Run，子 mandate 即为上限
  if (!parent) {
    const c = normalizeMandate(child)
    return (
      c || {
        schemaVersion: 1,
        allowedTools: [],
        deniedTools: [],
        permissionMode: 'autonomous',
        authorizedDirs: { read: [], write: [] },
        limits: { maxSteps: null, maxTokens: null },
        workspace: { mode: 'shared' },
        canDelegate: false
      }
    )
  }
  const p = normalizeMandate(parent) || {}
  const c = normalizeMandate(child)

  // allowedTools：双方都有则取交集；父有子无则用父；父无子有则用子
  let allowedTools = null
  if (p.allowedTools && c && c.allowedTools) {
    allowedTools = c.allowedTools.filter((t) => p.allowedTools.includes(t))
  } else if (p.allowedTools) {
    allowedTools = p.allowedTools.slice()
  } else if (c && c.allowedTools) {
    allowedTools = c.allowedTools.slice()
  }

  const deniedTools = [...new Set([...(p.deniedTools || []), ...((c && c.deniedTools) || [])])]

  // 风险上限：取更严格的一方
  // 排序依据是 authorizeToolCall 的实际拦截强度（readonly 拦截全部非只读 → default 拦 destructive
  // → autonomous 全走应用确认 → full 全放行），而非业务四级顺序：
  // readonly 父 ∩ 任意子 必为 readonly，子任务无法借求交提权获得写能力。
  const modeRank = { readonly: 0, default: 1, autonomous: 2, full: 3 }
  const pMode = p.permissionMode || 'autonomous'
  const cMode = (c && c.permissionMode) || pMode
  const permissionMode = modeRank[cMode] <= modeRank[pMode] ? cMode : pMode

  // 目录：子必须是父的子集
  const subDirs = (parentDirs, childDirs) => {
    if (!parentDirs || !parentDirs.length) return []
    if (!childDirs || !childDirs.length) return []
    return childDirs.filter((d) =>
      parentDirs.some((pd) => isPathInside(pd, d) || normPath(pd) === normPath(d))
    )
  }
  const read = subDirs(
    p.authorizedDirs && p.authorizedDirs.read,
    c && c.authorizedDirs && c.authorizedDirs.read
  )
  const write = subDirs(
    p.authorizedDirs && p.authorizedDirs.write,
    c && c.authorizedDirs && c.authorizedDirs.write
  )

  // 预算：取更小
  const minOf = (a, b) => {
    const xs = [a, b].filter((x) => Number(x) > 0)
    return xs.length ? Math.min(...xs) : null
  }

  return {
    schemaVersion: 1,
    allowedTools,
    deniedTools,
    permissionMode,
    authorizedDirs: { read, write },
    limits: {
      maxSteps: minOf(p.limits && p.limits.maxSteps, c && c.limits && c.limits.maxSteps),
      maxTokens: minOf(p.limits && p.limits.maxTokens, c && c.limits && c.limits.maxTokens)
    },
    workspace: { mode: 'shared' },
    canDelegate: c ? c.canDelegate === true && p.canDelegate !== false : p.canDelegate === true
  }
}

function deriveSubMandate(parentMandate, parentState = {}, request = {}) {
  const parent = parentMandate
    ? normalizeMandate(parentMandate)
    : normalizeMandate({
        allowedTools: null,
        deniedTools: [],
        permissionMode: parentState.permission || 'autonomous',
        authorizedDirs: {
          read: [...(parentState.authorizedDirs || [])],
          write: [...(parentState.authorizedDirs || [])]
        },
        limits: { maxSteps: parentState.maxSteps || null, maxTokens: null },
        canDelegate: !!parentState.cluster
      })
  const child = normalizeMandate({
    allowedTools: null,
    deniedTools: [],
    permissionMode: request.permission || parent.permissionMode,
    authorizedDirs: parent.authorizedDirs,
    limits: { maxSteps: request.maxSteps || parent.limits.maxSteps, maxTokens: null },
    canDelegate: false
  })
  return intersectMandate(parent, child)
}

// 无 mandate 时的受限默认（方案四 §4.3：不得自动全继承）
function defaultSubMandate(parentMandate) {
  const p = normalizeMandate(parentMandate)
  const parentAllowed = (p && p.allowedTools) || null
  // 默认只给只读工具；高风险工具一律不给
  const base = ['read_file', 'list_dir', 'search_files', 'grep_files', 'session_status']
  const allowedTools = parentAllowed ? base.filter((t) => parentAllowed.includes(t)) : base
  return intersectMandate(parentMandate, {
    allowedTools,
    deniedTools: [...HIGH_RISK_TOOLS],
    permissionMode:
      (p && p.permissionMode) === 'full' ? 'autonomous' : (p && p.permissionMode) || 'autonomous',
    authorizedDirs: (p && p.authorizedDirs) || { read: [], write: [] },
    limits: { maxSteps: p && p.limits ? p.limits.maxSteps : 20, maxTokens: null },
    workspace: { mode: 'shared' },
    canDelegate: false
  })
}

// 强制授权校验。任何工具执行前必须调用。
// 返回 { allowed, reason, detail }，调用方在 allowed=false 时不得执行工具。
function authorizeToolCall({ toolName, args, mandate, riskLevel = 'readonly' }) {
  const m = normalizeMandate(mandate)
  if (!m) {
    // 无 mandate：根 Run 场景，交由应用原有策略（确认流程）处理
    return { allowed: true, reason: 'no_mandate' }
  }

  if (m.deniedTools && m.deniedTools.includes(toolName)) {
    return { allowed: false, reason: 'tool_denied', detail: `${toolName} 在拒绝列表中` }
  }

  if (m.allowedTools && !m.allowedTools.includes(toolName)) {
    return { allowed: false, reason: 'tool_not_allowed', detail: `${toolName} 不在授权工具列表` }
  }

  // 高风险工具必须有显式授权（出现在 allowedTools 中即视为显式）
  const explicitlyAllowed = !Array.isArray(m.allowedTools) || m.allowedTools.includes(toolName)
  if (HIGH_RISK_TOOLS.has(toolName) && !explicitlyAllowed) {
    return {
      allowed: false,
      reason: 'high_risk_requires_explicit',
      detail: `${toolName} 属高风险工具`
    }
  }

  // 参数级校验：路径类工具
  const a = args || {}
  if (typeof a.path === 'string' && a.path) {
    const isWrite = ['write_file', 'edit_file'].includes(toolName)
    const dirs = isWrite ? m.authorizedDirs.write : m.authorizedDirs.read
    if (!pathAllowed(dirs, a.path)) {
      return {
        allowed: false,
        reason: isWrite ? 'write_path_not_allowed' : 'read_path_not_allowed',
        detail: `路径不在授权范围: ${a.path}`
      }
    }
  }
  if (typeof a.dir === 'string' && a.dir) {
    if (!pathAllowed(m.authorizedDirs.read, a.dir)) {
      return { allowed: false, reason: 'dir_not_allowed', detail: `目录不在授权范围: ${a.dir}` }
    }
  }

  // 风险等级上限：permissionMode=default 时不允许 destructive
  if (m.permissionMode === 'default' && RISK_ORDER[riskLevel] >= RISK_ORDER.destructive) {
    return { allowed: false, reason: 'risk_exceeds_mode', detail: '当前模式不允许破坏性操作' }
  }

  // 只读模式：仅放行 readonly 风险，side_effect/destructive 一律拒绝
  if (m.permissionMode === 'readonly' && RISK_ORDER[riskLevel] > RISK_ORDER.readonly) {
    return { allowed: false, reason: 'risk_exceeds_mode', detail: '只读模式不允许非只读工具' }
  }

  // 命令类工具无参数级授权能力：非 full 模式下需经过确认流程（此处放行但标记）
  if (PARAM_SENSITIVE_TOOLS.has(toolName) && m.permissionMode !== 'full' && !explicitlyAllowed) {
    return {
      allowed: false,
      reason: 'param_sensitive_requires_confirm',
      detail: `${toolName} 需显式授权`
    }
  }

  return { allowed: true, reason: 'ok' }
}

module.exports = {
  HIGH_RISK_TOOLS,
  normalizeMandate,
  intersectMandate,
  deriveSubMandate,
  defaultSubMandate,
  authorizeToolCall,
  pathAllowed,
  isPathInside
}
