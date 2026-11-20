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

module.exports = { isPathInside, isPathAllowed, assertAllowed, classifyCommand, escalateRisk }
