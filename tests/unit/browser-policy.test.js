import { describe, expect, it } from 'vitest'
import {
  assertBrowserUrlAllowed,
  assertHostnameAllowed,
  isPrivateIp,
  isPrivateBrowserUrl,
  normalizeBrowserUrl,
  safeFilename
} from '../../electron/main/browser/policy'

describe('browser URL policy', () => {
  it('normalizes http(s) URLs and only allows internal about:blank', () => {
    expect(normalizeBrowserUrl(' https://example.com/a ')).toBe('https://example.com/a')
    expect(normalizeBrowserUrl('example.com/docs?q=1')).toBe('https://example.com/docs?q=1')
    expect(normalizeBrowserUrl('localhost:5173/app')).toBe('https://localhost:5173/app')
    expect(normalizeBrowserUrl('//example.com/path')).toBe('https://example.com/path')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow(/http/)
    expect(() => normalizeBrowserUrl('file:///C:/secret.txt')).toThrow(/http/)
    expect(() => normalizeBrowserUrl('https://user:pass@example.com')).toThrow(/用户名或密码/)
  })

  it('blocks local, private, link-local and reserved IP ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1'
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false)
  })

  it('fails closed when any DNS answer is private', async () => {
    await expect(
      assertHostnameAllowed('example.com', {
        lookup: async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]
      })
    ).rejects.toThrow(/内网/)
    await expect(
      assertHostnameAllowed('example.com', {
        lookup: async () => {
          throw new Error('dns failed')
        }
      })
    ).rejects.toThrow(/解析/)
  })

  it('can explicitly allow private networks for trusted intranet use', async () => {
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:3000/', { allowPrivateNetwork: true })
    ).resolves.toBe('http://127.0.0.1:3000/')
  })

  it('可以使用 Chromium 解析器校验 DNS，避免 Electron Node 解析差异', async () => {
    await expect(
      assertHostnameAllowed('example.com', {
        resolveHost: async () => ({
          endpoints: [
            { address: '93.184.216.34', family: 'ipv4' },
            { address: '2606:4700:4700::1111', family: 'ipv6' }
          ]
        })
      })
    ).resolves.toBe('example.com')
    await expect(
      assertHostnameAllowed('example.com', {
        resolveHost: async () => ({ endpoints: [{ address: '127.0.0.1', family: 'ipv4' }] })
      })
    ).rejects.toThrow(/内网/)
  })

  it('sanitizes download filenames', () => {
    expect(safeFilename('../a<b>c?.txt')).toBe('a_b_c_.txt')
    expect(safeFilename('...')).toBe('download')
  })

  it('detects literal private network URLs for Agent subresource blocking', () => {
    expect(isPrivateBrowserUrl('http://127.0.0.1/admin')).toBe(true)
    expect(isPrivateBrowserUrl('https://service.local/api')).toBe(true)
    expect(isPrivateBrowserUrl('https://example.com/image.png')).toBe(false)
    expect(isPrivateBrowserUrl('data:image/png;base64,AA==')).toBe(false)
  })
})
