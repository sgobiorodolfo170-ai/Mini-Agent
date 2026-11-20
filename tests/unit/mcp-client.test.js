import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createMcpClient,
  withMcpServer,
  parseMcpServers,
  PROTOCOL_VERSION
} from '../../electron/main/agent/mcp-client'

// 假 MCP 子进程：按 method 回应，可注入延迟/错误模式。
function makeFakeChild({ mode = 'normal', deferMs = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdin.setEncoding = () => {}
  child.kill = () => {}
  child.stdin.write = (s) => {
    if (mode === 'silent') return true // 永不回应，用于测试进程级失败
    const req = JSON.parse(s)
    const send = (result) => {
      const go = () =>
        child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
      if (deferMs) setTimeout(go, deferMs)
      else go()
    }
    if (mode === 'isError' && req.method === 'tools/call') {
      setTimeout(
        () =>
          child.stdout.emit(
            'data',
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { isError: true, content: [{ type: 'text', text: '工具内部错误' }] }
            }) + '\n'
          ),
        0
      )
    } else if (req.method === 'initialize') send({ protocolVersion: PROTOCOL_VERSION })
    else if (req.method === 'tools/list') send({ tools: [{ name: 'echo', description: '回显' }] })
    else if (req.method === 'tools/call')
      send({ content: [{ type: 'text', text: 'echo:' + JSON.stringify(req.params.arguments) }] })
    else send({})
    return true
  }
  return child
}

describe('mcp client over a fake stdio transport', () => {
  it('initialize / listTools / callTool round-trip', async () => {
    const child = makeFakeChild()
    const c = createMcpClient({
      command: 'fake',
      spawnFn: () => child,
      timeoutMs: 1000
    })
    const init = await c.initialize()
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    const tools = await c.listTools()
    expect(tools).toEqual([{ name: 'echo', description: '回显' }])
    const r = await c.callTool('echo', { x: 1 })
    expect(r).toBe('echo:{"x":1}')
    c.stop()
    expect(c._getChild()).toBe(null)
  })

  it('surfaces isError tool results as exceptions', async () => {
    const c = createMcpClient({
      command: 'fake',
      spawnFn: () => makeFakeChild({ mode: 'isError' }),
      timeoutMs: 1000
    })
    await c.initialize()
    await expect(c.callTool('bad', {})).rejects.toThrow('工具内部错误')
    c.stop()
  })

  it('times out when the server never replies', async () => {
    const c = createMcpClient({
      command: 'fake',
      spawnFn: () => makeFakeChild({ deferMs: 5000 }),
      timeoutMs: 50
    })
    await expect(c.initialize()).rejects.toThrow(/超时/)
    c.stop()
  })

  it('rejects pending requests when the process exits', async () => {
    const child = makeFakeChild({ mode: 'silent' })
    const c = createMcpClient({ command: 'fake', spawnFn: () => child, timeoutMs: 5000 })
    const p = c.initialize()
    setImmediate(() => child.emit('exit', 1))
    await expect(p).rejects.toThrow(/退出\(code=1\)/)
    c.stop()
  })

  it('rejects when the process errors (e.g. ENOENT)', async () => {
    const child = makeFakeChild({ mode: 'silent' })
    const c = createMcpClient({ command: 'fake', spawnFn: () => child, timeoutMs: 5000 })
    const p = c.initialize()
    setImmediate(() => child.emit('error', new Error('ENOENT')))
    await expect(p).rejects.toThrow(/MCP 进程错误/)
    c.stop()
  })
})

describe('mcp client against a real spawned node server', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-mcp-'))
    fs.writeFileSync(
      path.join(dir, 'fake-server.js'),
      `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',(l)=>{const m=JSON.parse(l);const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
if(m.method==='initialize')send(m.id,{protocolVersion:'${PROTOCOL_VERSION}'});
else if(m.method==='tools/list')send(m.id,{tools:[{name:'ping'}]});
else if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:'pong'}]})});
`
    )
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('full handshake + tool call with a real process', async () => {
    const out = await withMcpServer(
      { command: process.execPath, args: [path.join(dir, 'fake-server.js')] },
      async (c) => {
        const tools = await c.listTools()
        expect(tools.map((t) => t.name)).toEqual(['ping'])
        return c.callTool('ping', {})
      },
      { timeoutMs: 10000 }
    )
    expect(out).toBe('pong')
  })

  it('withMcpServer stops the process even when fn throws', async () => {
    let childRef = null
    await expect(
      withMcpServer(
        { command: process.execPath, args: [path.join(dir, 'fake-server.js')] },
        async (c) => {
          childRef = c._getChild()
          throw new Error('boom')
        },
        { timeoutMs: 10000 }
      )
    ).rejects.toThrow('boom')
    await new Promise((r) => setTimeout(r, 100))
    expect(childRef.killed || childRef.exitCode !== null || !childRef.connected).toBe(true)
  })
})

describe('parseMcpServers', () => {
  it('accepts valid maps and drops invalid entries', () => {
    const cfg = parseMcpServers(
      JSON.stringify({
        docs: { command: 'node', args: ['server.js'] },
        broken: {},
        alsoBroken: 'x'
      })
    )
    expect(Object.keys(cfg)).toEqual(['docs'])
    expect(cfg.docs.command).toBe('node')
  })

  it('returns {} for null / invalid JSON / arrays', () => {
    expect(parseMcpServers(null)).toEqual({})
    expect(parseMcpServers('not json')).toEqual({})
    expect(parseMcpServers('[1,2]')).toEqual({})
    expect(parseMcpServers(42)).toEqual({})
  })

  it('accepts already-parsed objects', () => {
    expect(parseMcpServers({ a: { command: 'x' } })).toEqual({ a: { command: 'x' } })
  })
})
