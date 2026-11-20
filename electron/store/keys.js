// API key encryption at rest. Prefers Electron's async safeStorage APIs
// (DPAPI on Windows); falls back to the deprecated sync APIs, then to a marked
// plaintext base64 (dev/tests only) so formats stay distinguishable.
// Electron is loaded lazily so this module also works outside the app
// (vitest, tooling) — there it transparently uses the plain: fallback.

function getSafeStorage() {
  try {
    const electron = require('electron')
    return electron && electron.safeStorage ? electron.safeStorage : null
  } catch {
    return null
  }
}

async function encryptSecret(plain) {
  const s = String(plain == null ? '' : plain)
  const ss = getSafeStorage()
  if (!ss) return 'plain:' + Buffer.from(s, 'utf8').toString('base64')
  try {
    if (
      typeof ss.isAsyncEncryptionAvailable === 'function' &&
      (await ss.isAsyncEncryptionAvailable())
    ) {
      return 'enc:' + Buffer.from(await ss.encryptStringAsync(s)).toString('base64')
    }
    if (ss.isEncryptionAvailable && ss.isEncryptionAvailable()) {
      return 'enc:' + ss.encryptString(s).toString('base64')
    }
  } catch {
    /* fall through to plain */
  }
  return 'plain:' + Buffer.from(s, 'utf8').toString('base64')
}

async function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored) return ''
  if (stored.startsWith('enc:')) {
    try {
      const buf = Buffer.from(stored.slice(4), 'base64')
      const ss = getSafeStorage()
      if (!ss) return ''
      if (
        typeof ss.isAsyncEncryptionAvailable === 'function' &&
        (await ss.isAsyncEncryptionAvailable())
      ) {
        const out = await ss.decryptStringAsync(buf)
        // Electron 45 返回包装对象 { shouldReEncrypt, result }；旧版本返回字符串。
        return typeof out === 'string' ? out : String(out && out.result != null ? out.result : out)
      }
      const out2 = ss.decryptString(buf)
      return typeof out2 === 'string'
        ? out2
        : String(out2 && out2.result != null ? out2.result : out2)
    } catch {
      return ''
    }
  }
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return key.slice(0, 2) + '****'
  return key.slice(0, 6) + '****' + key.slice(-4)
}

module.exports = { encryptSecret, decryptSecret, maskKey }
