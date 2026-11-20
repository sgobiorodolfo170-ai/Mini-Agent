import { describe, expect, it } from 'vitest'
import {
  assertAllowed,
  classifyCommand,
  isPathAllowed,
  isPathInside
} from '../../electron/main/agent/guard'

describe('isPathInside / isPathAllowed', () => {
  it('allows strict descendants', () => {
    expect(isPathInside('C:\\data', 'C:\\data\\sub\\file.txt')).toBe(true)
    expect(isPathAllowed(['C:\\data'], 'C:\\data\\file.txt')).toBe(true)
  })
  it('rejects siblings, parents and lookalike names', () => {
    expect(isPathInside('C:\\data', 'C:\\data2\\file.txt')).toBe(false)
    expect(isPathInside('C:\\data', 'C:\\other\\file.txt')).toBe(false)
    expect(isPathInside('C:\\data', 'C:\\data')).toBe(true) // 授权目录本身可访问
    expect(isPathAllowed(['C:\\data'], 'D:\\data\\x')).toBe(false)
  })
  it('assertAllowed throws NOT_AUTHORIZED', () => {
    expect(() => assertAllowed(['C:\\data'], 'C:\\windows\\system32\\x')).toThrowError(/授权目录/)
    try {
      assertAllowed(['C:\\data'], 'C:\\windows\\x')
    } catch (e) {
      expect(e.code).toBe('NOT_AUTHORIZED')
    }
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
