import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  assertAllowed,
  classifyCommand,
  isPathAllowed,
  isPathInside,
  readFileAllowed,
  writeFileAllowed,
  updateFileAllowed
} from '../../electron/main/agent/guard'

let tempDir
let root
let outside

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-guard-'))
  root = path.join(tempDir, 'allowed')
  outside = path.join(tempDir, 'outside')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'ok')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('isPathInside / isPathAllowed', () => {
  it('allows descendants, normalized in-root traversal and the root itself', () => {
    expect(isPathInside(root, path.join(root, 'sub', 'file.txt'))).toBe(true)
    expect(isPathInside(root, path.join(root, 'sub', '..', 'sub', 'file.txt'))).toBe(true)
    expect(isPathInside(root, root + path.sep)).toBe(true)
    expect(isPathInside(root, path.join(root, '..cache', 'file.txt'))).toBe(true)
    expect(isPathAllowed([root], path.join(root, 'file.txt'))).toBe(true)
  })

  it('rejects siblings, parents, traversal escapes and lookalike names', () => {
    expect(isPathInside(root, path.join(tempDir, 'allowed2', 'file.txt'))).toBe(false)
    expect(isPathInside(root, outside)).toBe(false)
    expect(isPathInside(root, path.join(root, '..', 'outside', 'secret.txt'))).toBe(false)
    expect(isPathInside(root, path.dirname(root))).toBe(false)
  })

  it('preserves Windows case-insensitive comparisons', () => {
    expect(isPathInside(root, path.join(root.toUpperCase(), 'SUB', 'FILE.TXT'))).toBe(
      process.platform === 'win32'
    )
  })

  it('safely resolves nonexistent write targets through their existing parent', () => {
    expect(isPathInside(root, path.join(root, 'new', 'deep', 'file.txt'))).toBe(true)
    expect(isPathInside(root, path.join(outside, 'new', 'file.txt'))).toBe(false)
    expect(isPathInside(root, path.join(root, '..', 'outside', 'new', 'file.txt'))).toBe(false)
  })

  it('rejects junction escapes but allows junctions that stay inside', () => {
    const escape = path.join(root, 'escape')
    const inside = path.join(root, 'inside-link')
    fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(
      path.join(root, 'sub'),
      inside,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(isPathInside(root, path.join(escape, 'secret.txt'))).toBe(false)
    expect(isPathInside(root, path.join(escape, 'new', 'file.txt'))).toBe(false)
    expect(isPathInside(root, inside)).toBe(true)
    expect(isPathInside(root, path.join(inside, 'file.txt'))).toBe(true)
  })

  it('allows access through an authorized root that is itself a junction', () => {
    const rootLink = path.join(tempDir, 'allowed-link')
    fs.symlinkSync(root, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    expect(isPathInside(rootLink, rootLink)).toBe(true)
    expect(isPathInside(rootLink, path.join(rootLink, 'sub', 'file.txt'))).toBe(true)
    expect(isPathInside(rootLink, path.join(rootLink, '..', 'outside', 'secret.txt'))).toBe(false)
  })

  it('fails closed for dangling links, invalid input and empty authorization', () => {
    const dangling = path.join(root, 'dangling')
    fs.symlinkSync(
      path.join(tempDir, 'missing'),
      dangling,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(isPathInside(root, path.join(dangling, 'file.txt'))).toBe(false)
    expect(isPathAllowed([], root)).toBe(false)
    expect(isPathAllowed(null, root)).toBe(false)
    expect(isPathAllowed([null, ''], root)).toBe(false)
    expect(isPathInside(root, null)).toBe(false)
    expect(isPathInside(root, '')).toBe(false)
  })

  it('assertAllowed throws NOT_AUTHORIZED', () => {
    expect(() => assertAllowed([root], path.join(outside, 'secret.txt'))).toThrowError(/授权目录/)
    try {
      assertAllowed([root], path.join(outside, 'secret.txt'))
    } catch (e) {
      expect(e.code).toBe('NOT_AUTHORIZED')
    }
  })
})

describe('handle-based file I/O', () => {
  function swapBeforeOpen(target, replacement) {
    const originalOpen = fs.openSync
    let swapped = false
    vi.spyOn(fs, 'openSync').mockImplementation((p, ...args) => {
      if (!swapped && path.resolve(p) === path.resolve(target)) {
        swapped = true
        fs.rmSync(target, { recursive: true, force: true })
        fs.symlinkSync(
          replacement,
          target,
          fs.statSync(replacement).isDirectory()
            ? process.platform === 'win32'
              ? 'junction'
              : 'dir'
            : 'file'
        )
      }
      return originalOpen(p, ...args)
    })
    return () => swapped
  }

  it('keeps normal writes and edits on one verified handle', () => {
    const p = path.join(root, 'safe.txt')
    writeFileAllowed([root], p, 'alpha beta alpha')
    expect(readFileAllowed([root], p).toString()).toBe('alpha beta alpha')
    expect(updateFileAllowed([root], p, (s) => s.replace('beta', 'BETA'))).toBe('alpha BETA alpha')
    expect(fs.readFileSync(p, 'utf8')).toBe('alpha BETA alpha')
  })

  it('allows an authorized root that is itself a symlink', () => {
    const rootLink = path.join(tempDir, 'allowed-link')
    fs.symlinkSync(root, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    const p = path.join(rootLink, 'sub', 'file.txt')
    expect(readFileAllowed([rootLink], p).toString()).toBe('ok')
    writeFileAllowed([rootLink], path.join(rootLink, 'new.txt'), 'new')
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('new')
  })

  it('rejects a file swapped to an outside symlink between validation and open', () => {
    const p = path.join(root, 'sub', 'file.txt')
    const didSwap = swapBeforeOpen(p, path.join(outside, 'secret.txt'))
    expect(() => readFileAllowed([root], p)).toThrowError(
      expect.objectContaining({ code: 'PATH_CHANGED' })
    )
    expect(didSwap()).toBe(true)
  })

  it('does not truncate an outside file swapped in before a write', () => {
    const p = path.join(root, 'sub', 'file.txt')
    const secret = path.join(outside, 'secret.txt')
    const didSwap = swapBeforeOpen(p, secret)
    expect(() => writeFileAllowed([root], p, 'attacker')).toThrowError(
      expect.objectContaining({ code: 'PATH_CHANGED' })
    )
    expect(didSwap()).toBe(true)
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret')
  })

  it('rejects a parent directory swapped to an outside junction before open', () => {
    const parent = path.join(root, 'sub')
    const p = path.join(parent, 'file.txt')
    fs.writeFileSync(path.join(outside, 'file.txt'), 'outside')
    const originalOpen = fs.openSync
    let swapped = false
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, ...args) => {
      if (!swapped && path.resolve(candidate) === path.resolve(p)) {
        swapped = true
        fs.renameSync(parent, path.join(root, 'sub-original'))
        fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return originalOpen(candidate, ...args)
    })
    expect(() => readFileAllowed([root], p)).toThrowError(
      expect.objectContaining({ code: 'PATH_CHANGED' })
    )
    expect(swapped).toBe(true)
  })

  it('uses exclusive creation so a swapped-in symlink cannot be followed', () => {
    const p = path.join(root, 'new.txt')
    const secret = path.join(outside, 'secret.txt')
    const originalOpen = fs.openSync
    let swapped = false
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, ...args) => {
      if (!swapped && path.resolve(candidate) === path.resolve(p)) {
        swapped = true
        fs.symlinkSync(secret, p)
      }
      return originalOpen(candidate, ...args)
    })
    expect(() => writeFileAllowed([root], p, 'attacker')).toThrowError(
      expect.objectContaining({ code: 'EEXIST' })
    )
    expect(swapped).toBe(true)
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret')
  })

  it('rechecks the handle before edit write-back if the path is swapped', () => {
    const p = path.join(root, 'sub', 'file.txt')
    const secret = path.join(outside, 'secret.txt')
    const originalRead = fs.readFileSync
    let swapped = false
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const data = originalRead(...args)
      if (!swapped && typeof args[0] === 'number') {
        swapped = true
        fs.rmSync(p)
        fs.symlinkSync(secret, p)
      }
      return data
    })
    expect(() => updateFileAllowed([root], p, (s) => s.replace('ok', 'attacker'))).toThrowError(
      expect.objectContaining({ code: 'PATH_CHANGED' })
    )
    expect(swapped).toBe(true)
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret')
  })

  it('does not yield to queued link swaps during a guarded read', async () => {
    const p = path.join(root, 'sub', 'file.txt')
    const attack = Promise.resolve().then(() => {
      fs.rmSync(p)
      fs.symlinkSync(path.join(outside, 'secret.txt'), p)
    })
    const result = readFileAllowed([root], p)
    await attack
    expect(result.toString()).toBe('ok')
    expect(() => readFileAllowed([root], p)).toThrowError(
      expect.objectContaining({ code: 'NOT_AUTHORIZED' })
    )
  })
})

describe('classifyCommand', () => {
  it('flags destructive commands', () => {
    expect(classifyCommand('format C:').destructive).toBe(true)
    expect(classifyCommand('Remove-Item C:\\x -Recurse -Force').destructive).toBe(true)
    expect(classifyCommand('del /f /s /q C:\\x').destructive).toBe(true)
    expect(classifyCommand('diskpart').destructive).toBe(true)
    expect(classifyCommand('shutdown /s').destructive).toBe(true)
  })
  it('passes normal commands', () => {
    expect(classifyCommand('Get-ChildItem C:\\data').destructive).toBe(false)
    expect(classifyCommand('Get-Content notes.txt').destructive).toBe(false)
    expect(classifyCommand('node script.js').destructive).toBe(false)
  })
})
