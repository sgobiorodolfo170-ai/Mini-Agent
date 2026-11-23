import { beforeEach, describe, expect, it, vi } from 'vitest'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import scheduler from '../../electron/main/gateway/scheduler'
import { chatOnce } from '../../electron/main/gateway/client'
import { resolveModel } from '../../electron/main/gateway/index'
import { decryptSecret } from '../../electron/store/keys'
import { titleConversation, fallbackTitle, sanitizeTitle } from '../../electron/main/gateway/title'

const events = []

function deps() {
  return {
    dbm,
    repos,
    scheduler,
    chatOnce,
    resolveModel,
    decryptSecret,
    broadcast: (ch, p) => events.push({ ch, p })
  }
}

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  events.length = 0
  vi.restoreAllMocks()
})

function seed() {
  const pid = repos.saveProvider(dbm.get(), {
    name: '中转',
    baseUrl: 'https://mock/v1',
    models: [{ id: 'm1', vision: false }]
  })
  repos.addKey(dbm.get(), {
    providerId: pid,
    label: '一号',
    secretEnc: 'plain:' + Buffer.from('sk-1', 'utf8').toString('base64')
  })
  const conv = repos.createConversation(dbm.get(), {
    title: '新会话',
    providerId: pid,
    model: 'm1'
  })
  return conv.id
}

describe('title sanitize/fallback', () => {
  it('sanitizeTitle 清理思考包装/引号/首行截断', () => {
    expect(sanitizeTitle('<think>x</think>写周报', 'fb')).toBe('写周报')
    expect(sanitizeTitle('「项目排期」', 'fb')).toBe('项目排期')
    expect(sanitizeTitle('第一行\n第二行', 'fb')).toBe('第一行')
    expect(sanitizeTitle('   ', 'fb')).toBe('fb')
    expect(sanitizeTitle('*重点项分析', 'fb')).toBe('重点项分析')
  })

  it('fallbackTitle 压缩空白并截断 24 字', () => {
    expect(fallbackTitle('  a \n b  ')).toBe('a b')
    const long = '字'.repeat(40)
    expect(fallbackTitle(long)).toHaveLength(24)
    expect(fallbackTitle('')).toBe('新会话')
  })
})

describe('titleConversation', () => {
  it('测试环境走原文截断回退，不触发网络调用', async () => {
    const cid = seed()
    const spy = vi.spyOn(globalThis, 'fetch')
    const r = await titleConversation(deps(), { conversationId: cid, content: '帮我 写 周报' })
    expect(r.source).toBe('fallback')
    expect(r.title).toBe('帮我 写 周报')
    expect(repos.getConversation(dbm.get(), cid).title).toBe('帮我 写 周报')
    expect(spy).not.toHaveBeenCalled()
  })

  it('已命名/已重命名的会话不被覆盖', async () => {
    const cid = seed()
    repos.updateConversation(dbm.get(), cid, { title: '手起的名字' })
    const r = await titleConversation(deps(), { conversationId: cid, content: '任意' })
    expect(r.source).toBe('kept')
    expect(repos.getConversation(dbm.get(), cid).title).toBe('手起的名字')
  })

  it('会话不存在返回 null', async () => {
    expect(await titleConversation(deps(), { conversationId: 'nope', content: 'x' })).toBeNull()
  })
})
