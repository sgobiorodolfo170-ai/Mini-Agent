import { describe, expect, it } from 'vitest'
import {
  parseVersion,
  compareVersions,
  resolveUpdateState,
  createUpdateChecker,
  readRemote
} from '../../electron/main/updater'

describe('parseVersion / compareVersions', () => {
  it('识别带 v 前缀与多位版本', () => {
    expect(parseVersion('v1.2.0')).toEqual([1, 2, 0])
    expect(parseVersion('1.10.3-beta.1')).toEqual([1, 10, 3])
    expect(parseVersion('')).toBeNull()
  })

  it('按数值而非字典序比较', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0', '1.3.0')).toBe(-1)
    expect(compareVersions('bad', '1.0.0')).toBe(0)
  })
})

describe('resolveUpdateState', () => {
  const current = { version: '1.2.0', commit: 'aaa1111' }

  it('同一提交判定为已是最新（即便版本号写法不同）', () => {
    const s = resolveUpdateState({
      current,
      latest: { version: '1.2.0', commit: 'aaa1111' },
      compare: { ahead_by: 0 }
    })
    expect(s.available).toBe(false)
    expect(s.reason).toBe('up-to-date')
    expect(s.latest.shortCommit).toBe('aaa1111')
  })

  it('compare 显示远端领先时给出落后提交数', () => {
    const s = resolveUpdateState({
      current,
      latest: { version: '1.2.0', commit: 'bbb2222' },
      compare: { ahead_by: 3, behind_by: 0 }
    })
    expect(s.available).toBe(true)
    expect(s.behind).toBe(3)
    expect(s.reason).toBe('commit-ahead')
  })

  it('本地提交尚未发布（compare 404）时按版本号兜底', () => {
    const newer = resolveUpdateState({
      current,
      latest: { version: '1.3.0', commit: 'ccc3333' },
      compare: null
    })
    expect(newer.available).toBe(true)
    expect(newer.reason).toBe('version-newer')
    expect(newer.behind).toBeNull()
  })

  it('本地版本更高时不提示更新', () => {
    const s = resolveUpdateState({
      current,
      latest: { version: '1.1.0', commit: 'ddd4444' },
      compare: null
    })
    expect(s.available).toBe(false)
    expect(s.reason).toBe('local-newer')
  })

  it('没有远端数据时不提示更新', () => {
    expect(resolveUpdateState({ current, latest: null }).available).toBe(false)
  })
})

describe('createUpdateChecker', () => {
  it('检查成功后缓存状态并广播，TTL 内不重复请求', async () => {
    let calls = 0
    const states = []
    const checker = createUpdateChecker({
      currentVersion: '1.2.0',
      currentCommit: 'aaa1111',
      ttlMs: 60000,
      now: () => 1000,
      feed: async () => {
        calls += 1
        return { latest: { version: '1.2.0', commit: 'bbb2222' }, compare: { ahead_by: 2 } }
      },
      onState: (s) => states.push(s)
    })

    const first = await checker.check({ force: true })
    expect(first.available).toBe(true)
    expect(first.behind).toBe(2)
    expect(states).toHaveLength(1)

    await checker.check()
    expect(calls).toBe(1)
    await checker.check({ force: true })
    expect(calls).toBe(2)
  })

  it('并发检查复用同一个进行中的请求', async () => {
    let calls = 0
    const checker = createUpdateChecker({
      currentVersion: '1.2.0',
      currentCommit: 'aaa1111',
      feed: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 10))
        return { latest: { version: '1.2.0', commit: 'bbb2222' }, compare: { ahead_by: 1 } }
      }
    })
    await Promise.all([checker.check({ force: true }), checker.check({ force: true })])
    expect(calls).toBe(1)
  })

  it('数据源失败时保留上次判定并记录错误', async () => {
    let fail = true
    const checker = createUpdateChecker({
      currentVersion: '1.2.0',
      currentCommit: 'aaa1111',
      feed: async () => {
        if (fail) throw new Error('network down')
        return { latest: { version: '1.2.0', commit: 'bbb2222' }, compare: { ahead_by: 4 } }
      }
    })
    const bad = await checker.check({ force: true })
    expect(bad.error).toContain('network down')
    expect(bad.available).toBe(false)

    fail = false
    const good = await checker.check({ force: true })
    expect(good.error).toBeNull()
    expect(good.behind).toBe(4)
  })
})

describe('readRemote', () => {
  function fakeFetch(responses) {
    const calls = []
    const impl = async (url) => {
      calls.push(url)
      const key = Object.keys(responses).find((k) => url.includes(k))
      const body = key ? responses[key] : undefined
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }
    impl.calls = calls
    return impl
  }

  it('用 commits + contents 组合出远端最新信息', async () => {
    const fetchImpl = fakeFetch({
      '/commits?per_page=1&sha=main': [
        {
          sha: 'eee5555aaaa',
          html_url: 'https://github.com/x/y/commit/eee5555',
          commit: {
            message: '标题行\n\n正文不应进摘要',
            author: { date: '2026-11-22T01:00:00Z' }
          }
        }
      ],
      '/contents/package.json': {
        content: Buffer.from(JSON.stringify({ version: '1.3.0' })).toString('base64')
      },
      '/compare/': { ahead_by: 5, behind_by: 0 }
    })
    const { latest, compare } = await readRemote(fetchImpl, 'x/y', 'aaa1111')
    expect(latest.shortCommit).toBe('eee5555')
    expect(latest.message).toBe('标题行')
    expect(latest.version).toBe('1.3.0')
    expect(compare).toEqual({ ahead_by: 5, behind_by: 0 })
    expect(latest.compareUrl).toContain('aaa1111...eee5555aaaa')
  })

  it('compare 404 时返回 compare=null，交给版本号兜底', async () => {
    const fetchImpl = fakeFetch({
      '/commits?per_page=1&sha=main': [{ sha: 'bbb2222', commit: { message: 'm' } }]
    })
    const { latest, compare } = await readRemote(fetchImpl, 'x/y', 'local999')
    expect(latest.commit).toBe('bbb2222')
    expect(latest.version).toBe('')
    expect(compare).toBeNull()
  })

  it('远端提交列表为空时抛错（由调用方降级）', async () => {
    const fetchImpl = fakeFetch({ '/commits?per_page=1&sha=main': [] })
    await expect(readRemote(fetchImpl, 'x/y', 'aaa')).rejects.toThrow('未取到远端提交')
  })

  it('请求超时转成可读提示，不暴露 AbortError 原文', async () => {
    const impl = async () => {
      const e = new Error('This operation was aborted')
      e.name = 'AbortError'
      throw e
    }
    await expect(readRemote(impl, 'x/y', 'aaa', { timeoutMs: 15000 })).rejects.toThrow(
      '请求 GitHub 超时（15s）'
    )
  })
})
