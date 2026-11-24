const dns = require('node:dns')
const net = require('node:net')

class BrowserPolicyError extends Error {
  constructor(message, code = 'BROWSER_URL_BLOCKED') {
    super(message)
    this.name = 'BrowserPolicyError'
    this.code = code
  }
}

function normalizeBrowserUrl(raw, { allowBlank = true } = {}) {
  const value = String(raw || '').trim()
  if (!value) throw new BrowserPolicyError('URL 不能为空')
  if (allowBlank && value === 'about:blank') return value

  let url
  try {
    url = new URL(value)
  } catch {
    throw new BrowserPolicyError('URL 格式无效')
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new BrowserPolicyError('内置浏览器仅允许 http(s) URL')
  }
  if (url.username || url.password) {
    throw new BrowserPolicyError('URL 不允许包含用户名或密码')
  }
  if (!url.hostname) throw new BrowserPolicyError('URL 缺少主机名')
  return url.toString()
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function inCidr(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) >>> 0 === (base & mask) >>> 0
}

function isPrivateIpv4(ip) {
  const value = ipv4ToInt(ip)
  if (value === null) return true
  const cidrs = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ]
  return cidrs.some(([base, prefix]) => inCidr(value, ipv4ToInt(base), prefix))
}

function isPrivateIp(ip) {
  const value = String(ip || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  const family = net.isIP(value)
  if (family === 4) return isPrivateIpv4(value)
  if (family !== 6) return true

  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length)
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped)
  }
  if (value === '::' || value === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true
  if (/^ff[0-9a-f]{2}:/.test(value)) return true
  return false
}

async function assertHostnameAllowed(
  hostname,
  { allowPrivateNetwork = false, lookup = dns.lookup } = {}
) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!host) throw new BrowserPolicyError('URL 缺少主机名')
  if (allowPrivateNetwork) return host
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new BrowserPolicyError('默认禁止访问本地或内网地址')
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new BrowserPolicyError('默认禁止访问本地或内网地址')
    return host
  }

  let addresses
  try {
    const result = await lookup(host, { all: true, verbatim: true })
    addresses = Array.isArray(result) ? result : [result]
  } catch {
    throw new BrowserPolicyError('无法解析域名，已阻止导航')
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry && entry.address))) {
    throw new BrowserPolicyError('域名解析到本地或内网地址，已阻止导航')
  }
  return host
}

async function assertBrowserUrlAllowed(raw, options = {}) {
  const url = normalizeBrowserUrl(raw, options)
  if (url === 'about:blank') return url
  const parsed = new URL(url)
  await assertHostnameAllowed(parsed.hostname, options)
  return url
}

function isPrivateBrowserUrl(raw) {
  try {
    const url = new URL(String(raw || ''))
    if (!/^(https?|wss?):$/.test(url.protocol)) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      (net.isIP(host) ? isPrivateIp(host) : false)
    )
  } catch {
    return false
  }
}

function safeFilename(name) {
  const base = Array.from(String(name || 'download'))
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[._]+/, '')
    .trim()
  return base.slice(0, 120) || 'download'
}

module.exports = {
  BrowserPolicyError,
  normalizeBrowserUrl,
  isPrivateIp,
  isPrivateBrowserUrl,
  assertHostnameAllowed,
  assertBrowserUrlAllowed,
  safeFilename
}
