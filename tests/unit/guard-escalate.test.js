import { describe, expect, it } from 'vitest'
import { escalateRisk } from '../../electron/main/agent/guard'

describe('escalateRisk', () => {
  it('upgrades run_command to destructive on dangerous commands', () => {
    expect(escalateRisk('run_command', { command: 'format C:' }, 'side_effect')).toBe('destructive')
    expect(
      escalateRisk('run_command', { command: 'Remove-Item x -Recurse -Force' }, 'side_effect')
    ).toBe('destructive')
  })

  it('keeps side_effect for harmless commands', () => {
    expect(escalateRisk('run_command', { command: 'Get-ChildItem C:\\x' }, 'side_effect')).toBe(
      'side_effect'
    )
  })

  it('passes through other tools untouched', () => {
    expect(escalateRisk('write_file', { path: 'C:\\a' }, 'side_effect')).toBe('side_effect')
    expect(escalateRisk('list_dir', { path: 'C:\\a' }, 'readonly')).toBe('readonly')
  })
})
