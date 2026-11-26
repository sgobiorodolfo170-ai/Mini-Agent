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
  parseMcpServersDetailed,
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

  it('keeps the legacy truthy-command filtering behavior', () => {
    const cfg = { command: 42, args: 'not-an-array' }
    expect(parseMcpServers({ legacy: cfg })).toEqual({ legacy: cfg })
  })
})

describe('parseMcpServersDetailed', () => {
  it('treats null and blank input as unconfigured without diagnostics', () => {
    for (const raw of [null, undefined, '', '  \n ']) {
      expect(parseMcpServersDetailed(raw)).toEqual({
        configured: false,
        servers: {},
        diagnostics: []
      })
    }
  })

  it('reports invalid JSON and invalid roots without echoing configuration content', () => {
    const invalidJson = parseMcpServersDetailed('{"token":"sk-abcdefghijklmnop"')
    expect(invalidJson).toEqual({
      configured: true,
      servers: {},
      diagnostics: [{ code: 'invalid_json', reason: 'MCP 配置不是合法 JSON' }]
    })
    expect(JSON.stringify(invalidJson)).not.toContain('sk-')

    for (const raw of ['[]', '42', 'false']) {
      expect(parseMcpServersDetailed(raw).diagnostics).toEqual([
        { code: 'invalid_root', reason: 'MCP 配置必须是服务器对象映射' }
      ])
    }
  })

  it('returns valid servers and itemized diagnostics for invalid entries', () => {
    const result = parseMcpServersDetailed({
      docs: { command: 'node', args: ['server.js'], env: { MODE: 'test' } },
      noArgs: { command: 'node' },
      missing: {},
      scalar: 'node',
      nullEntry: null,
      arrayEntry: [],
      emptyCommand: { command: '' },
      blankCommand: { command: '   ' },
      paddedCommand: { command: ' node' },
      numericCommand: { command: 42 },
      nulCommand: { command: 'node\0bad' },
      stringArgs: { command: 'node', args: 'server.js' },
      nullArgs: { command: 'node', args: null },
      mixedArgs: { command: 'node', args: ['server.js', 1] },
      nulArg: { command: 'node', args: ['server\0.js'] },
      '': { command: 'node' }
    })

    expect(Object.keys(result.servers)).toEqual(['docs', 'noArgs'])
    expect(result.servers.docs).toEqual({
      command: 'node',
      args: ['server.js'],
      env: { MODE: 'test' }
    })
    expect(result.servers.noArgs.args).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { name: 'missing', code: 'invalid_command', reason: '缺少 command 启动命令' },
        { name: 'scalar', code: 'invalid_entry', reason: '服务器配置必须是对象' },
        { name: 'nullEntry', code: 'invalid_entry', reason: '服务器配置必须是对象' },
        { name: 'arrayEntry', code: 'invalid_entry', reason: '服务器配置必须是对象' },
        expect.objectContaining({ name: 'emptyCommand', code: 'invalid_command' }),
        expect.objectContaining({ name: 'blankCommand', code: 'invalid_command' }),
        expect.objectContaining({ name: 'paddedCommand', code: 'invalid_command' }),
        expect.objectContaining({ name: 'numericCommand', code: 'invalid_command' }),
        expect.objectContaining({ name: 'nulCommand', code: 'invalid_command' }),
        { name: 'stringArgs', code: 'invalid_args', reason: 'args 必须是字符串数组' },
        { name: 'nullArgs', code: 'invalid_args', reason: 'args 必须是字符串数组' },
        {
          name: 'mixedArgs',
          code: 'invalid_args',
          reason: 'args 的每一项必须是不含 NUL 字符的字符串',
          index: 1
        },
        expect.objectContaining({ name: 'nulArg', code: 'invalid_args', index: 0 }),
        { code: 'invalid_name', reason: '服务器名称不能为空或包含 NUL 字符' }
      ])
    )
    expect(result.diagnostics).toHaveLength(14)
  })

  it('copies args and safely preserves special server names', () => {
    const args = ['server.js']
    const result = parseMcpServersDetailed({ docs: { command: 'node', args } })
    args.push('changed.js')
    expect(result.servers.docs.args).toEqual(['server.js'])

    const special = parseMcpServersDetailed('{"__proto__":{"command":"node"}}')
    expect(Object.keys(special.servers)).toEqual(['__proto__'])
    expect(special.servers.__proto__.command).toBe('node')
    expect({}.command).toBeUndefined()
  })

  it('rejects invalid launch configuration before calling spawnFn', async () => {
    let spawned = false
    const spawnFn = () => {
      spawned = true
      throw new Error('must not spawn')
    }
    const blank = createMcpClient({ command: '   ', spawnFn })
    await expect(blank.initialize()).rejects.toThrow('command 必须是非空字符串')

    const badArgs = createMcpClient({ command: 'node', args: 'server.js', spawnFn })
    await expect(badArgs.initialize()).rejects.toThrow('args 必须是字符串数组')
    expect(spawned).toBe(false)
  })
})
