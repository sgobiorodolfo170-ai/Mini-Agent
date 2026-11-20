import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// keys.js is CommonJS: its internal require('electron') goes through the native
// require cache and bypasses vi.mock — so we seed Module._cache with a mock
// safeStorage before importing the module under test.
const { ss, electronMock } = vi.hoisted(() => {
  const ss = {
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptStringAsync: vi.fn(),
    decryptString: vi.fn()
  }
  const electronMock = { safeStorage: ss }
  return { ss, electronMock }
})

const electronId = require.resolve('electron')
Module._cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: electronMock
}

const { decryptSecret, encryptSecret, maskKey } = await import('../../electron/store/keys')

function reset() {
  electronMock.safeStorage = ss
  for (const fn of Object.values(ss)) fn.mockReset()
  // Sane defaults: async encryption available, identity "encryption".
  ss.isAsyncEncryptionAvailable.mockResolvedValue(true)
  ss.encryptStringAsync.mockImplementation(async (s) => Buffer.from(s, 'utf8'))
  ss.decryptStringAsync.mockImplementation(async (buf) => buf.toString('utf8'))
}

afterEach(reset)
reset()

afterAll(() => {
  delete Module._cache[electronId]
})

describe('encryptSecret', () => {
  it('uses safeStorage async encryption and marks the value enc:', async () => {
    const out = await encryptSecret('s3cret')
    expect(out).toBe('enc:' + Buffer.from('s3cret', 'utf8').toString('base64'))
    expect(ss.encryptStringAsync).toHaveBeenCalledWith('s3cret')
  })

  it('falls back to sync encryption when async is unavailable', async () => {
    ss.isAsyncEncryptionAvailable.mockResolvedValue(false)
    ss.isEncryptionAvailable.mockReturnValue(true)
    ss.encryptString.mockImplementation((s) => Buffer.from('sync:' + s))
    const out = await encryptSecret('abc')
    expect(out.startsWith('enc:')).toBe(true)
    expect(ss.encryptString).toHaveBeenCalledWith('abc')
    expect(ss.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('degrades to marked plaintext when encryption throws', async () => {
    ss.encryptStringAsync.mockRejectedValue(new Error('dpapi broken'))
    const out = await encryptSecret('s3cret')
    expect(out).toBe('plain:' + Buffer.from('s3cret', 'utf8').toString('base64'))
  })

  it('degrades to marked plaintext when safeStorage is missing', async () => {
    electronMock.safeStorage = null
    const out = await encryptSecret('s3cret')
    expect(out).toBe('plain:' + Buffer.from('s3cret', 'utf8').toString('base64'))
  })

  it('coerces null/undefined input to an empty encrypted string', async () => {
    expect(await encryptSecret(null)).toBe('enc:')
  })
})

describe('decryptSecret', () => {
  it('round-trips an enc: value through safeStorage', async () => {
    const stored = await encryptSecret('机密信息')
    expect(await decryptSecret(stored)).toBe('机密信息')
  })

  it('unwraps the Electron 45 async wrapper object { result }', async () => {
    ss.decryptStringAsync.mockResolvedValue({ shouldReEncrypt: true, result: 'unwrapped' })
    expect(await decryptSecret('enc:' + Buffer.from('x').toString('base64'))).toBe('unwrapped')
  })

  it('unwraps the sync decryptString wrapper object', async () => {
    ss.isAsyncEncryptionAvailable.mockResolvedValue(false)
    ss.isEncryptionAvailable.mockReturnValue(true)
    ss.decryptString.mockReturnValue({ result: 'sync-unwrapped' })
    expect(await decryptSecret('enc:' + Buffer.from('x').toString('base64'))).toBe('sync-unwrapped')
  })

  it('returns empty string for enc: values when safeStorage is missing', async () => {
    electronMock.safeStorage = null
    expect(await decryptSecret('enc:' + Buffer.from('x').toString('base64'))).toBe('')
  })

  it('returns empty string when decryption rejects', async () => {
    ss.decryptStringAsync.mockRejectedValue(new Error('bad dpapi'))
    expect(await decryptSecret('enc:' + Buffer.from('x').toString('base64'))).toBe('')
  })

  it('decodes marked plaintext values', async () => {
    const stored = 'plain:' + Buffer.from('dev-mode', 'utf8').toString('base64')
    expect(await decryptSecret(stored)).toBe('dev-mode')
  })

  it('passes through legacy raw values untouched', async () => {
    expect(await decryptSecret('sk-raw-value')).toBe('sk-raw-value')
  })

  it('returns empty string for empty or non-string input', async () => {
    expect(await decryptSecret('')).toBe('')
    expect(await decryptSecret(null)).toBe('')
    expect(await decryptSecret(42)).toBe('')
  })
})

describe('maskKey', () => {
  it('masks long keys keeping head and tail', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-123****cdef')
  })

  it('masks short keys with only a head fragment', () => {
    expect(maskKey('abc12345')).toBe('ab****')
    expect(maskKey('ab')).toBe('ab****')
  })

  it('returns empty string for falsy input', () => {
    expect(maskKey('')).toBe('')
    expect(maskKey(null)).toBe('')
  })
})
