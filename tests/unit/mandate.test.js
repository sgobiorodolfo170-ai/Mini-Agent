import { describe, expect, it } from 'vitest'

import {
  authorizeToolCall,
  defaultSubMandate,
  intersectMandate,
  normalizeMandate,
  pathAllowed
} from '../../electron/main/agent/mandate'

const baseMandate = (over = {}) => ({
  schemaVersion: 1,
  allowedTools: ['read_file', 'list_dir', 'write_file'],
  deniedTools: [],
  permissionMode: 'autonomous',
  authorizedDirs: { read: ['C:\\proj'], write: ['C:\\proj'] },
  limits: { maxSteps: 10, maxTokens: null },
  workspace: { mode: 'shared' },
  canDelegate: false,
  ...over
})

describe('mandate 规范化（§4.2）', () => {
  it('空 mandate 返回 null（根 Run 由应用策略处理）', () => {
    expect(normalizeMandate(null)).toBeNull()
    expect(normalizeMandate(undefined)).toBeNull()
  })

  it('allowedTools 必须是数组：空数组表示不允许任何工具', () => {
    const m = normalizeMandate({ allowedTools: [] })
    expect(m.allowedTools).toEqual([])
    const r = authorizeToolCall({ toolName: 'read_file', args: {}, mandate: m })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('tool_not_allowed')
  })

  it('未知 permissionMode 收敛到 autonomous，不放大权限', () => {
    expect(normalizeMandate({ permissionMode: 'godmode' }).permissionMode).toBe('autonomous')
  })

  it('readonly 权限模式归一化时保留', () => {
    expect(normalizeMandate({ permissionMode: 'readonly' }).permissionMode).toBe('readonly')
  })
})

describe('父子权限求交（§4.1）', () => {
  it('子 Run 不能扩大父 Run 的工具集', () => {
    const parent = baseMandate({ allowedTools: ['read_file'] })
    const child = intersectMandate(parent, { allowedTools: ['read_file', 'run_command'] })
    expect(child.allowedTools).toEqual(['read_file'])
  })

  it('deniedTools 取并集，优先级高于允许列表', () => {
    const merged = intersectMandate(
      baseMandate({ deniedTools: ['write_file'] }),
      baseMandate({ deniedTools: ['run_command'] })
    )
    expect(merged.deniedTools.sort()).toEqual(['run_command', 'write_file'])
    const r = authorizeToolCall({ toolName: 'write_file', args: {}, mandate: merged })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('tool_denied')
  })

  it('权限模式取更严格的一方', () => {
    const merged = intersectMandate(
      baseMandate({ permissionMode: 'full' }),
      baseMandate({ permissionMode: 'default' })
    )
    expect(merged.permissionMode).toBe('default')
  })

  it('readonly 父 ∩ full 子 = readonly：子任务无法借求交提权获得写能力', () => {
    const merged = intersectMandate(
      baseMandate({ permissionMode: 'readonly' }),
      baseMandate({ permissionMode: 'full' })
    )
    expect(merged.permissionMode).toBe('readonly')
  })

  it('full 父 ∩ readonly 子 = readonly：子主动收敛到只读', () => {
    const merged = intersectMandate(
      baseMandate({ permissionMode: 'full' }),
      baseMandate({ permissionMode: 'readonly' })
    )
    expect(merged.permissionMode).toBe('readonly')
  })

  it('目录：子必须是父的子集', () => {
    const merged = intersectMandate(
      baseMandate({ authorizedDirs: { read: ['C:\\proj'], write: [] } }),
      baseMandate({ authorizedDirs: { read: ['C:\\proj', 'C:\\other'], write: [] } })
    )
    expect(merged.authorizedDirs.read).toEqual(['C:\\proj'])
  })

  it('预算取更小值', () => {
    const merged = intersectMandate(
      baseMandate({ limits: { maxSteps: 10, maxTokens: null } }),
      baseMandate({ limits: { maxSteps: 5, maxTokens: null } })
    )
    expect(merged.limits.maxSteps).toBe(5)
  })

  it('无 mandate 的子任务得到受限默认，不含高风险工具', () => {
    const m = defaultSubMandate(baseMandate({ permissionMode: 'full' }))
    expect(m.allowedTools).not.toContain('run_command')
    expect(m.allowedTools).not.toContain('write_file')
    expect(m.deniedTools).toContain('run_command')
    expect(m.canDelegate).toBe(false)
  })
})

describe('工具授权校验（§4.4）', () => {
  it('允许列表外的工具被拒绝', () => {
    const r = authorizeToolCall({
      toolName: 'run_command',
      args: {},
      mandate: baseMandate()
    })
    expect(r.allowed).toBe(false)
  })

  it('允许列表内的只读工具放行', () => {
    const r = authorizeToolCall({
      toolName: 'read_file',
      args: { path: 'C:\\proj\\a.txt' },
      mandate: baseMandate()
    })
    expect(r.allowed).toBe(true)
  })

  it('高风险工具未显式授权时拒绝', () => {
    const m = baseMandate({ allowedTools: null })
    const r = authorizeToolCall({ toolName: 'run_command', args: { command: 'dir' }, mandate: m })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('high_risk_requires_explicit')
  })

  it('readonly 模式下写类工具被拒绝，只读工具放行', () => {
    const m = baseMandate({ permissionMode: 'readonly' })
    // write_file 在 tools.js 中标注为 side_effect 风险
    const deny = authorizeToolCall({
      toolName: 'write_file',
      args: { path: 'C:\\proj\\a.txt', content: 'x' },
      mandate: m,
      riskLevel: 'side_effect'
    })
    expect(deny.allowed).toBe(false)
    expect(deny.reason).toBe('risk_exceeds_mode')

    const allow = authorizeToolCall({
      toolName: 'read_file',
      args: { path: 'C:\\proj\\a.txt' },
      mandate: m,
      riskLevel: 'readonly'
    })
    expect(allow.allowed).toBe(true)
  })
})

describe('路径校验（§4.4 第 3 点）', () => {
  it('允许目录内路径通过', () => {
    expect(pathAllowed(['C:\\proj'], 'C:\\proj\\a.txt')).toBe(true)
  })

  it('路径穿越被拒绝', () => {
    expect(pathAllowed(['C:\\proj'], 'C:\\proj\\..\\secret.txt')).toBe(false)
  })

  it('相似前缀目录不被误判为内部', () => {
    expect(pathAllowed(['C:\\proj'], 'C:\\proj-evil\\a.txt')).toBe(false)
  })

  it('大小写差异不影响判定（Windows）', () => {
    expect(pathAllowed(['C:\\PROJ'], 'c:\\proj\\a.txt')).toBe(true)
  })

  it('UNC 路径不落入普通盘符目录', () => {
    expect(pathAllowed(['C:\\proj'], '\\\\server\\share\\a.txt')).toBe(false)
  })

  it('写操作使用 write 目录，读目录不可写', () => {
    const m = baseMandate({ authorizedDirs: { read: ['C:\\proj'], write: [] } })
    const r = authorizeToolCall({
      toolName: 'write_file',
      args: { path: 'C:\\proj\\a.txt', content: 'x' },
      mandate: m
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('write_path_not_allowed')
  })
})
