const path = require('path')

// Path guards for Agent file tools.
function isPathInside(dir, target) {
  const rel = path.relative(path.resolve(String(dir)), path.resolve(String(target)))
  // 授权目录本身也允许访问（list_dir 根目录等）；写入时目录路径会因系统报错自然失败
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isPathAllowed(dirs, target) {
  return (dirs || []).some((d) => isPathInside(d, target))
}

function assertAllowed(dirs, target) {
  if (!isPathAllowed(dirs, target)) {
    const err = new Error(`路径不在授权目录内: ${target}`)
    err.code = 'NOT_AUTHORIZED'
    throw err
  }
}

// Command risk classification for PowerShell tool calls.
function classifyCommand(cmd) {
  const c = String(cmd).toLowerCase()
  const destructive = [
    /format\s+[a-z]:/,
    /diskpart/,
    /reg\s+delete/,
    /remove-item[^;\n]*-recurse[^;\n]*-force/,
    /remove-item[^;\n]*-force[^;\n]*-recurse/,
    /\brd\s+\/s\b/,
    /\bdel\s+\/[fqs]/,
    /\bshutdown\b/,
    /cipher\s+\/w/,
    /\bcleanmgr\b/
  ].some((r) => r.test(c))
  const interactive = /read-host|pause\b|-wait|out-gridview/i.test(c)
  return { destructive, interactive }
}

// Dynamic risk escalation: a destructive PowerShell command upgrades the tool risk tier.
function escalateRisk(toolName, args, riskLevel) {
  if (toolName === 'run_command') {
    const c = classifyCommand((args && args.command) || '')
    if (c.destructive) return 'destructive'
  }
  return riskLevel
}

function redactToolArgs(toolName, args) {
  const redact = (value, key = '') => {
    if (/password|passwd|secret|token|apiKey|authorization/i.test(key)) return '[redacted]'
    if (Array.isArray(value)) return value.map((entry) => redact(entry))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, redact(entry, name)])
      )
    }
    return value
  }
  const source = args && typeof args === 'object' ? redact(args) : {}
  if (toolName === 'browser_type') source.text = '[redacted]'
  if (toolName === 'browser_navigate' && typeof source.url === 'string') {
    try {
      const url = new URL(source.url)
      const hadQuery = !!url.search
      const hadHash = !!url.hash
      url.search = ''
      url.hash = ''
      source.url =
        url.toString() + (hadQuery ? (hadHash ? '?[redacted]#[redacted]' : '?[redacted]') : '')
    } catch {
      source.url = '[invalid-url]'
    }
  }
  return source
}

module.exports = {
  isPathInside,
  isPathAllowed,
  assertAllowed,
  classifyCommand,
  escalateRisk,
  redactToolArgs
}
