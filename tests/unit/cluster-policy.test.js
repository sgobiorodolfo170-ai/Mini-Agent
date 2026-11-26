import { describe, expect, it } from 'vitest'
import { LIMITS, assertClusterEnabled, filterTools } from '../../electron/main/agent/cluster-policy'
import { deriveSubMandate } from '../../electron/main/agent/mandate'

const tools = [
  { name: 'read_file' },
  { name: 'run_dispatch' },
  { name: 'run_plan' },
  { name: 'spawn_agent' },
  { name: 'session_send' }
]

describe('cluster policy', () => {
  it('hides every orchestration tool when cluster is disabled', () => {
    expect(filterTools(tools, { cluster: false }).map((tool) => tool.name)).toEqual(['read_file'])
    expect(() => assertClusterEnabled(false, 'run_plan')).toThrow(/未开启/)
  })

  it('exposes orchestration tools only inside the configured limits', () => {
    expect(filterTools(tools, { cluster: true })).toHaveLength(5)
    expect(LIMITS).toMatchObject({
      globalSlots: 4,
      directChildren: 2,
      graphNodes: 12,
      graphConcurrency: 4,
      delegationDepth: 3
    })
  })

  it('filters denied and disallowed tools even when cluster is enabled', () => {
    const result = filterTools(tools, {
      cluster: true,
      mandate: { allowedTools: ['read_file', 'run_plan'], deniedTools: ['run_plan'] }
    })
    expect(result.map((tool) => tool.name)).toEqual(['read_file'])
  })
})

describe('child permission inheritance', () => {
  const parentState = {
    permission: 'full',
    cluster: true,
    authorizedDirs: ['C:\\project'],
    maxSteps: 15
  }

  it('inherits full permission and directories without granting nested delegation', () => {
    const mandate = deriveSubMandate(null, parentState, {})
    expect(mandate).toMatchObject({
      permissionMode: 'full',
      authorizedDirs: { read: ['C:\\project'], write: ['C:\\project'] },
      limits: { maxSteps: 15 },
      canDelegate: false
    })
  })

  it('cannot broaden a restricted parent mandate', () => {
    const parent = deriveSubMandate(null, { ...parentState, permission: 'readonly' }, {})
    const child = deriveSubMandate(parent, parentState, { permission: 'full' })
    expect(child.permissionMode).toBe('readonly')
    expect(child.canDelegate).toBe(false)
  })
})
