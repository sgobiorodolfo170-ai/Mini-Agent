import { describe, expect, it } from 'vitest'
import { escalateRisk, redactToolArgs } from '../../electron/main/agent/guard'

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

describe('redactToolArgs', () => {
  it('removes browser input text and URL query secrets before audit', () => {
    expect(redactToolArgs('browser_type', { selector: '#password', text: 'super-secret' })).toEqual(
      { selector: '#password', text: '[redacted]' }
    )
    const redacted = redactToolArgs('browser_navigate', {
      url: 'https://example.com/login?token=secret#frag'
    })
    expect(redacted.url).not.toContain('secret')
    expect(redacted.url).not.toContain('frag')
  })

  it('redacts computer input values and keys before approval and audit', () => {
    expect(redactToolArgs('computer_type', { ref: 'e1', value: 'private' })).toEqual({
      ref: 'e1',
      value: '[redacted]'
    })
    expect(redactToolArgs('computer_key', { keys: 'private', processId: 42 })).toEqual({
      keys: '[redacted]',
      processId: 42
    })
    expect(
      redactToolArgs('computer_input', { type: 'insertText', text: 'private', key: 'private' })
    ).toEqual({ type: 'insertText', text: '[redacted]', key: '[redacted]' })
  })

  it('redacts common secret fields without mutating the original args', () => {
    const args = { apiKey: 'key', nested: { password: 'pass' }, safe: 'ok' }
    const redacted = redactToolArgs('custom', args)
    expect(redacted.apiKey).toBe('[redacted]')
    expect(redacted.nested).toEqual({ password: '[redacted]' })
    expect(args.apiKey).toBe('key')
  })
})
