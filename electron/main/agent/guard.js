const fs = require('fs')
const path = require('path')

function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  return path.resolve(value)
}

function isRelativeInside(root, target) {
  const rel = path.relative(root, target)
  // path.relative 在 Windows 上保留大小写不敏感语义；根目录本身也允许访问。
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

// 解析真实路径；对尚不存在的写入目标，保留缺失尾部并解析最近存在祖先。
// 悬空链接、权限错误等无法确定位置的情况一律拒绝。
function resolveRealPath(value) {
  let current = normalizePath(value)
  if (!current) return null
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

function authorizedPath(dirs, target) {
  const candidate = normalizePath(target)
  if (!candidate || !Array.isArray(dirs)) return null
  for (const dir of dirs) {
    const root = normalizePath(dir)
    if (!root || !isRelativeInside(root, candidate)) continue
    const realRoot = resolveRealPath(root)
    const realTarget = resolveRealPath(candidate)
    if (realRoot && realTarget && isRelativeInside(realRoot, realTarget)) {
      return { dirs, candidate, realRoot, realTarget }
    }
  }
  return null
}

function isPathInside(dir, target) {
  return !!authorizedPath([dir], target)
}

function isPathAllowed(dirs, target) {
  return !!authorizedPath(dirs, target)
}

// 返回已解析的真实路径，调用方应使用它进行同步 I/O，避免再次跟随原始链接。
function assertAllowed(dirs, target) {
  const allowed = authorizedPath(dirs, target)
  if (!allowed) {
    const err = new Error(`路径不在授权目录内: ${target}`)
    err.code = 'NOT_AUTHORIZED'
    throw err
  }
  return allowed.realTarget
}

function samePath(a, b) {
  return path.relative(a, b) === ''
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.isFile() && b.isFile()
}

function pathChanged(target) {
  const err = new Error(`路径在授权校验后发生变化: ${target}`)
  err.code = 'PATH_CHANGED'
  return err
}

// Windows 的 libuv 不提供 O_NOFOLLOW；不要用虚构标志位假装能阻止跟随链接。
// 在支持的平台上拒绝最终分量是链接；Windows 则依靠打开后的文件身份复核。
const noFollowFlag = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0

// 以下校验与 I/O 均同步，关闭同一 Node 事件循环内的换链窗口。
// 但 Node/Windows 没有 openat/O_NOFOLLOW，无法消除其他原生进程在系统调用间换链的竞态。
function verifyOpenFile(dirs, target, fd, allowed) {
  const opened = fs.fstatSync(fd, { bigint: true })
  if (!opened.isFile()) throw pathChanged(target)

  // 同时复核路径当前仍指向这个句柄，且父目录没有被换成 junction/symlink。
  let currentPath
  try {
    currentPath = fs.statSync(allowed.realTarget, { bigint: true })
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw pathChanged(target)
    throw error
  }
  const currentAllowed = authorizedPath(dirs, target)
  if (
    !sameFile(opened, currentPath) ||
    !currentAllowed ||
    !samePath(currentAllowed.realRoot, allowed.realRoot) ||
    !samePath(currentAllowed.realTarget, allowed.realTarget)
  ) {
    throw pathChanged(target)
  }
}

function openAllowed(dirs, target, access, create = false) {
  const allowed = authorizedPath(dirs, target)
  if (!allowed) return assertAllowed(dirs, target)

  let expected = null
  try {
    expected = fs.lstatSync(allowed.realTarget, { bigint: true })
    if (expected.isSymbolicLink() || !expected.isFile()) throw pathChanged(target)
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw error
  }

  const flags =
    access | noFollowFlag | (create && !expected ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0)
  let fd
  try {
    // 写操作故意不带 O_TRUNC：必须先确认句柄仍是校验时的文件，再截断。
    fd = fs.openSync(allowed.realTarget, flags, 0o666)
  } catch (error) {
    if (error.code === 'ELOOP') throw pathChanged(target)
    if (expected && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
      // 目标在校验后消失（例如父目录被移走）应按路径变化拒绝，而不是继续创建。
      throw pathChanged(target)
    }
    throw error
  }

  try {
    if (expected && !sameFile(expected, fs.fstatSync(fd, { bigint: true }))) {
      throw pathChanged(target)
    }
    verifyOpenFile(dirs, target, fd, allowed)
    return { fd, allowed }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function readFileAllowed(dirs, target, maxBytes = Infinity) {
  const { fd } = openAllowed(dirs, target, fs.constants.O_RDONLY)
  try {
    if (!Number.isFinite(maxBytes)) return fs.readFileSync(fd)
    if (fs.fstatSync(fd, { bigint: true }).size > BigInt(maxBytes)) return null
    const data = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset)
      if (!read) break
      offset += read
    }
    return offset > maxBytes ? null : data.subarray(0, offset)
  } finally {
    fs.closeSync(fd)
  }
}

function writeAll(fd, data) {
  let offset = 0
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset, offset)
    if (!written) throw new Error('文件写入未取得进展')
    offset += written
  }
}

function writeFileAllowed(dirs, target, content) {
  const allowed = authorizedPath(dirs, target)
  if (!allowed) return assertAllowed(dirs, target)
  fs.mkdirSync(path.dirname(allowed.realTarget), { recursive: true })
  const current = authorizedPath(dirs, target)
  if (
    !current ||
    !samePath(current.realRoot, allowed.realRoot) ||
    !samePath(current.realTarget, allowed.realTarget)
  ) {
    throw pathChanged(target)
  }

  const { fd } = openAllowed(dirs, target, fs.constants.O_WRONLY, true)
  try {
    fs.ftruncateSync(fd, 0)
    writeAll(fd, Buffer.from(content))
  } finally {
    fs.closeSync(fd)
  }
}

// 编辑必须在同一个已校验句柄上读、替换、截断和写回，不能分成两次路径 I/O。
function updateFileAllowed(dirs, target, update) {
  const { fd, allowed } = openAllowed(dirs, target, fs.constants.O_RDWR)
  try {
    const result = update(fs.readFileSync(fd, 'utf8'))
    const data = Buffer.from(result, 'utf8')
    verifyOpenFile(dirs, target, fd, allowed)
    fs.ftruncateSync(fd, 0)
    writeAll(fd, data)
    return result
  } finally {
    fs.closeSync(fd)
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
  if (toolName === 'computer_type') source.value = '[redacted]'
  if (toolName === 'computer_key') source.keys = '[redacted]'
  if (toolName === 'computer_input') {
    source.text = '[redacted]'
    source.key = '[redacted]'
  }
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
  readFileAllowed,
  writeFileAllowed,
  updateFileAllowed,
  classifyCommand,
  escalateRisk,
  redactToolArgs
}
