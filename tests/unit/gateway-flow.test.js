import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import notify from '../../electron/main/notify'
import gateway from '../../electron/main/gateway/index'

const events = []

async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

function sseRes(lines) {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const l of lines) yield Buffer.from(l)
    })()
  }
}

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  events.length = 0
  notify.setBroadcaster((ch, p) => events.push({ ch, p }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function seed() {
  const pid = repos.saveProvider(dbm.get(), {
    name: '中转',
    baseUrl: 'https://mock/v1',
    models: [{ id: 'm1', vision: false }]
  })
  const b64 = (s) => 'plain:' + Buffer.from(s, 'utf8').toString('base64')
  repos.addKey(dbm.get(), { providerId: pid, label: '一号', secretEnc: b64('sk-1') })
  repos.addKey(dbm.get(), { providerId: pid, label: '二号', secretEnc: b64('sk-2') })
  const conv = repos.createConversation(dbm.get(), { title: '集成', providerId: pid, model: 'm1' })
  return { pid, convId: conv.id }
}

function doneOf(msgId) {
  return events.some((e) => e.ch === 'chat:event' && e.p.type === 'done' && e.p.msgId === msgId)
}

describe('sendChat 全链路', () => {
  it('流式完成：广播 delta/done，消息落库，Key 置 ok', async () => {
    const { convId, pid } = seed()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      expect(String(url)).toBe('https://mock/v1/chat/completions')
      expect(opts.headers.Authorization).toBe('Bearer sk-1')
      expect(JSON.parse(opts.body).model).toBe('m1')
      expect(JSON.parse(opts.body).messages.at(-1).content).toBe('问题')
      return sseRes([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    })
    const r = await gateway.sendChat({ conversationId: convId, content: '问题' })
    expect(await waitFor(() => doneOf(r.assistantMsgId))).toBe(true)

    const msgs = repos.listMessages(dbm.get(), convId)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('user')
    const assistant = msgs[1]
    expect(assistant.content).toBe('你好')
    expect(assistant.status).toBe('done')
    expect(repos.listKeys(dbm.get(), pid)[0].status).toBe('ok')
    expect(repos.listKeyEvents(dbm.get(), 10).some((e) => e.result === 'ok')).toBe(true)
    expect(
      events.some((e) => e.ch === 'chat:event' && e.p.type === 'delta' && e.p.delta === '好')
    ).toBe(true)
  })

  it('429 自动切换下一把 Key 并完成回答', async () => {
    const { convId, pid } = seed()
    const auths = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      auths.push(opts.headers.Authorization)
      if (opts.headers.Authorization === 'Bearer sk-1') {
        return { ok: false, status: 429, text: async () => 'rate limited' }
      }
      return sseRes([
        'data: {"choices":[{"delta":{"content":"切换后回答"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    })
    const r = await gateway.sendChat({ conversationId: convId, content: '问题' })
    expect(await waitFor(() => doneOf(r.assistantMsgId))).toBe(true)
    expect(auths).toEqual(['Bearer sk-1', 'Bearer sk-2'])

    const keys = repos.listKeys(dbm.get(), pid)
    expect(keys[0].status).toBe('cooldown')
    expect(keys[0].rateCount).toBe(1)
    expect(keys[1].status).toBe('ok')
    const assistant = repos.listMessages(dbm.get(), convId).find((m) => m.role === 'assistant')
    expect(assistant.content).toBe('切换后回答')
    expect(assistant.status).toBe('done')
    expect(events.some((e) => e.ch === 'chat:event' && e.p.type === 'notice')).toBe(true)
  })

  it('stopChat 中止流式并落库 stopped', async () => {
    const { convId } = seed()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n')
        await new Promise((_, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (opts.signal.aborted) onAbort()
          else opts.signal.addEventListener('abort', onAbort)
        })
      })()
    }))
    const r = await gateway.sendChat({ conversationId: convId, content: '问题' })
    await waitFor(() => events.some((e) => e.ch === 'chat:event' && e.p.type === 'delta'))
    expect(gateway.stopChat(r.assistantMsgId)).toBe(true)
    expect(
      await waitFor(() =>
        events.some(
          (e) => e.ch === 'chat:event' && e.p.type === 'stopped' && e.p.msgId === r.assistantMsgId
        )
      )
    ).toBe(true)
    const assistant = repos.listMessages(dbm.get(), convId).find((m) => m.role === 'assistant')
    expect(assistant.status).toBe('stopped')
    expect(assistant.content).toBe('开头')
  })

  it('regenerate 删除旧回复并重新请求', async () => {
    const { convId } = seed()
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      return sseRes([
        `data: {"choices":[{"delta":{"content":"回答${calls}"}}]}\n\n`,
        'data: [DONE]\n\n'
      ])
    })
    const r1 = await gateway.sendChat({ conversationId: convId, content: '问题' })
    expect(await waitFor(() => doneOf(r1.assistantMsgId))).toBe(true)
    const r2 = await gateway.regenerate(convId)
    expect(await waitFor(() => doneOf(r2.assistantMsgId))).toBe(true)

    const msgs = repos.listMessages(dbm.get(), convId)
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(msgs.find((m) => m.role === 'assistant').content).toBe('回答2')
    expect(calls).toBe(2)
  })

  it('editResend 保留编辑后的用户消息并重答', async () => {
    const { convId } = seed()
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      calls++
      if (calls === 2) {
        const body = JSON.parse(opts.body)
        expect(body.messages.at(-1).content).toBe('改后的问题')
      }
      return sseRes([
        `data: {"choices":[{"delta":{"content":"回答${calls}"}}]}\n\n`,
        'data: [DONE]\n\n'
      ])
    })
    const r1 = await gateway.sendChat({ conversationId: convId, content: '原问题' })
    expect(await waitFor(() => doneOf(r1.assistantMsgId))).toBe(true)
    const userMsg = repos.listMessages(dbm.get(), convId).find((m) => m.role === 'user')
    const r2 = await gateway.editResend({ msgId: userMsg.id, content: '改后的问题' })
    expect(await waitFor(() => doneOf(r2.assistantMsgId))).toBe(true)

    const msgs = repos.listMessages(dbm.get(), convId)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('改后的问题')
    expect(msgs[1].content).toBe('回答2')
  })

  it('无可用 Key 时消息标记 error', async () => {
    const { convId, pid } = seed()
    for (const k of repos.listKeys(dbm.get(), pid)) repos.softDeleteKey(dbm.get(), k.id)
    await gateway.sendChat({ conversationId: convId, content: '问题' })
    expect(
      await waitFor(() => events.some((e) => e.ch === 'chat:event' && e.p.type === 'error'))
    ).toBe(true)
    const assistant = repos.listMessages(dbm.get(), convId).find((m) => m.role === 'assistant')
    expect(assistant.status).toBe('error')
    expect(JSON.parse(assistant.meta).error).toContain('Key')
  })

  it('contextPolicy 的 top_p / temperature 进入请求 payload', async () => {
    const { convId } = seed()
    const bodies = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return sseRes(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: [DONE]\n\n'])
    })
    // 未配置时不应发送 top_p / temperature
    const r1 = await gateway.sendChat({ conversationId: convId, content: '默认参数' })
    expect(await waitFor(() => doneOf(r1.assistantMsgId))).toBe(true)
    expect(bodies[0].top_p).toBeUndefined()
    expect(bodies[0].temperature).toBeUndefined()

    repos.updateConversation(dbm.get(), convId, {
      contextPolicy: { temperature: 0.7, topP: 0.9 }
    })
    const r2 = await gateway.sendChat({ conversationId: convId, content: '自定义参数' })
    expect(await waitFor(() => doneOf(r2.assistantMsgId))).toBe(true)
    expect(bodies[1].temperature).toBe(0.7)
    expect(bodies[1].top_p).toBe(0.9)
  })

  // 最大输出长度改为提供商模型参数：会话 policy 中的 maxTokens 不再透传
  it('max_tokens 取自模型参数而非会话 policy', async () => {
    const { convId, pid } = seed()
    const bodies = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return sseRes(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: [DONE]\n\n'])
    })

    repos.updateConversation(dbm.get(), convId, { contextPolicy: { maxTokens: 512 } })
    const r1 = await gateway.sendChat({ conversationId: convId, content: '会话级无效' })
    expect(await waitFor(() => doneOf(r1.assistantMsgId))).toBe(true)
    expect(bodies[0].max_tokens).toBeUndefined()

    const p = repos.getProvider(dbm.get(), pid)
    repos.saveProvider(dbm.get(), {
      id: pid,
      name: p.name,
      baseUrl: p.base_url,
      models: [{ id: 'm1', vision: false, maxTokens: 256, maxChars: 4000 }]
    })
    const r2 = await gateway.sendChat({ conversationId: convId, content: '模型级生效' })
    expect(await waitFor(() => doneOf(r2.assistantMsgId))).toBe(true)
    expect(bodies[1].max_tokens).toBe(256)
  })
})
