import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { defineTools, htmlToText } from '../../electron/main/agent/tools'

let dir
let ctx
let map

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-tools-'))
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.txt'), '文件内容ABC')
  fs.writeFileSync(path.join(dir, 'sub', 'deep-target-xyz.log'), 'log')
  ctx = {
    authorizedDirs: [dir],
    workingDir: dir,
    clipboard: {
      _t: '',
      readText() {
        return this._t
      },
      writeText(t) {
        this._t = t
      }
    },
    shell: {
      opened: [],
      async openExternal(u) {
        this.opened.push(u)
      }
    },
    todo: { seq: 0, items: [] },
    memoryPath: path.join(dir, 'agent-memory.md'),
    spawnAgent: async ({ goal }) => '子Agent结论:' + goal,
    browserFactory: null, // 浏览器用例单独构造 ctx
    mcpServers: {
      good: { command: 'node', args: ['-e', 'process.exit(0)'] },
      dead: { command: 'definitely-not-exist-cmd-xyz', args: [] }
    },
    tavilyKey: '',
    webSearchProvider: 'auto',
    // 会话管理：这里用最小替身，验证工具层的参数归一与委派，真实行为由 agent-sessions 覆盖
    createSession: async ({ title, goal }) => ({
      id: 'c-new',
      title: title || goal,
      parentId: 'c-parent',
      origin: 'agent'
    }),
    sendToSession: async ({ conversationId, content, mode }) => ({
      conversationId,
      mode,
      msg: content
    }),
    getSessionStatus: ({ conversationId }) => ({ conversationId, status: 'done' }),
    waitForSession: async ({ conversationId }) => ({
      conversationId,
      status: 'done',
      timedOut: false
    }),
    getSessionResult: ({ conversationId }) => ({ conversationId, content: '结果正文' }),
    listSessions: () => [{ conversationId: 'c1', status: 'running' }]
  }
  map = Object.fromEntries(defineTools(ctx).map((t) => [t.name, t]))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('file tools honor the authorized-directory guard', () => {
  it('list_dir / read_file / write_file happy path', async () => {
    const listed = await map.list_dir.handler({ path: dir })
    expect(listed).toContain('[文件] a.txt')
    expect(listed).toContain('[目录] sub')
    expect(await map.read_file.handler({ path: path.join(dir, 'a.txt') })).toBe('文件内容ABC')
    const nested = path.join(dir, 'sub2', 'out.md')
    const r = await map.write_file.handler({ path: nested, content: '写入内容' })
    expect(r).toContain('已写入 4 字符')
    expect(fs.readFileSync(nested, 'utf8')).toBe('写入内容')
  })

  it('rejects paths outside authorized dirs', async () => {
    await expect(map.read_file.handler({ path: 'C:\\Windows\\win.ini' })).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED'
    })
    await expect(
      map.write_file.handler({ path: path.join(os.tmpdir(), 'outside-x.txt'), content: 'x' })
    ).rejects.toThrow(/授权目录/)
  })

  it('search_files finds matches under the root', async () => {
    const r = await map.search_files.handler({ dir, pattern: 'xyz' })
    expect(r).toContain('deep-target-xyz.log')
  })

  it('read_file refuses oversized files', async () => {
    const big = path.join(dir, 'big.bin')
    fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 1))
    expect(await map.read_file.handler({ path: big })).toContain('过大')
    fs.rmSync(big, { force: true })
  })
})

describe('clipboard / shell tools', () => {
  it('writes and reads through the injected clipboard', async () => {
    await map.clipboard_write.handler({ text: '剪贴板文本' })
    expect(ctx.clipboard.readText()).toBe('剪贴板文本')
    expect(await map.clipboard_read.handler({})).toBe('剪贴板文本')
  })

  it('open_url allows only http(s)', async () => {
    await map.open_url.handler({ url: 'https://example.com/x' })
    expect(ctx.shell.opened).toEqual(['https://example.com/x'])
    await expect(map.open_url.handler({ url: 'javascript:alert(1)' })).rejects.toThrow(/http/)
  })
})

describe('run_command executes real PowerShell', () => {
  it('returns stdout', async () => {
    const out = await map.run_command.handler({ command: 'Write-Output hello-miniagent' })
    expect(out).toContain('hello-miniagent')
  }, 30000)
})

describe('web_fetch strips html to text', () => {
  it('extracts text and drops script/style tags', async () => {
    vi.stubGlobal('fetch', async () => ({
      text: async () =>
        '<html><head><script>evil()</script></head><body><p>页面正文</p><style>x{}</style></body></html>'
    }))
    const r = await map.web_fetch.handler({ url: 'https://example.com/page' })
    vi.unstubAllGlobals()
    expect(r).toContain('页面正文')
    expect(r).not.toContain('evil')
  })

  it('rejects non-http protocols', async () => {
    await expect(map.web_fetch.handler({ url: 'ftp://x' })).rejects.toThrow(/http/)
  })
})

describe('htmlToText', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(htmlToText('<p>A&amp;B</p>  <p>C</p>')).toBe('A&B C')
  })
})

describe('edit_file does exact string replacement', () => {
  it('replaces a unique match and rejects ambiguous matches', async () => {
    const p = path.join(dir, 'edit-target.txt')
    fs.writeFileSync(p, '第一行 alpha\n第二行 beta\n第三行 alpha\n结尾')
    const r = await map.edit_file.handler({
      path: p,
      oldText: '第二行 beta',
      newText: '第二行 BETA'
    })
    expect(r).toContain('已替换 1 处')
    expect(fs.readFileSync(p, 'utf8')).toContain('BETA')

    await expect(
      map.edit_file.handler({ path: p, oldText: 'alpha', newText: 'X' })
    ).rejects.toThrow(/出现 2 次/)

    const r2 = await map.edit_file.handler({
      path: p,
      oldText: 'alpha',
      newText: 'X',
      replaceAll: true
    })
    expect(r2).toContain('已替换 2 处')
    const after = fs.readFileSync(p, 'utf8')
    expect(after).not.toContain('alpha')
    expect(after.match(/X/g)).toHaveLength(2)
  })

  it('errors on missing match / empty oldText / unauthorized path', async () => {
    const p = path.join(dir, 'edit-target.txt')
    await expect(
      map.edit_file.handler({ path: p, oldText: '不存在的内容', newText: 'y' })
    ).rejects.toThrow(/未找到/)
    await expect(map.edit_file.handler({ path: p, oldText: '', newText: 'y' })).rejects.toThrow(
      /oldText/
    )
    await expect(
      map.edit_file.handler({ path: 'C:\\Windows\\win.ini', oldText: 'a', newText: 'b' })
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
  })
})

describe('grep_files searches file contents', () => {
  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'code.js'), 'const answer = 42;\nfunction hello() {}\n')
    fs.writeFileSync(path.join(dir, 'sub', 'nested.md'), 'Nested 内容 here\n')
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3])) // 含 \0 视为二进制
    fs.writeFileSync(path.join(dir, 'huge.txt'), 'match-but-huge'.repeat(120 * 1024))
  })

  it('matches substring case-insensitively with path:line:content output', async () => {
    const r = await map.grep_files.handler({ dir, pattern: 'HELLO' })
    expect(r).toContain('code.js:2')
    expect(r).toContain('function hello() {}')
  })

  it('supports regex mode and ignores binary/oversized files', async () => {
    const r = await map.grep_files.handler({ dir, pattern: '\\d+', isRegex: true })
    expect(r).toContain('code.js:1')
    expect(r).toContain('answer = 42')
    expect(r).not.toContain('bin.dat')
    expect(r).not.toContain('huge.txt')
  })

  it('finds matches in nested subdirectories and respects no-match', async () => {
    const r = await map.grep_files.handler({ dir, pattern: 'nested 内容' })
    expect(r).toContain(path.join('sub', 'nested.md') + ':1')
    expect(await map.grep_files.handler({ dir, pattern: '绝对不存在' })).toBe('(无匹配)')
  })

  it('rejects empty pattern, invalid regex and unauthorized dirs', async () => {
    await expect(map.grep_files.handler({ dir, pattern: '' })).rejects.toThrow(/pattern/)
    await expect(map.grep_files.handler({ dir, pattern: '([', isRegex: true })).rejects.toThrow(
      /正则/
    )
    await expect(
      map.grep_files.handler({ dir: 'C:\\Windows', pattern: 'x' })
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
  })
})

describe('web_search routes through the provider layer', () => {
  it('delegates to DuckDuckGo when no key (auto)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      text: async () =>
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&amp;rut=1">搜索结果</a>'
    }))
    const r = await map.web_search.handler({ query: 'miniagent 工具' })
    vi.unstubAllGlobals()
    expect(r).toContain('搜索结果')
    expect(r).toContain('https://a.example/x')
  })

  it('uses Tavily when key present (auto)', async () => {
    vi.stubGlobal('fetch', async (url) => ({
      ok: true,
      json: async () => ({ results: [{ title: 'T', url: String(url), content: 'C' }] }),
      text: async () => ''
    }))
    ctx.tavilyKey = 'tvly-test'
    const r = await map.web_search.handler({ query: 'q' })
    vi.unstubAllGlobals()
    ctx.tavilyKey = ''
    expect(r).toContain('api.tavily.com')
  })

  it('rejects empty query', async () => {
    await expect(map.web_search.handler({ query: ' ' })).rejects.toThrow(/搜索词/)
  })
})

describe('update_todo manages the run task list', () => {
  it('add / list / complete / update / remove / clear', async () => {
    expect(await map.update_todo.handler({ action: 'add', content: '调研' })).toContain(
      '[ ] #1 调研'
    )
    expect(await map.update_todo.handler({ action: 'add', content: '实现' })).toContain('#2')
    expect(await map.update_todo.handler({ action: 'complete', id: 1 })).toContain('[x] #1')
    expect(
      await map.update_todo.handler({ action: 'update', id: 2, content: '实现+测试' })
    ).toContain('#2 实现+测试')
    expect(await map.update_todo.handler({ action: 'remove', id: 1 })).not.toContain('#1')
    expect(await map.update_todo.handler({ action: 'list' })).toBe('[ ] #2 实现+测试')
    expect(await map.update_todo.handler({ action: 'clear' })).toBe('(任务清单为空)')
  })

  it('validates action, content and ids', async () => {
    await expect(map.update_todo.handler({ action: 'add', content: '' })).rejects.toThrow(/content/)
    await expect(map.update_todo.handler({ action: 'complete', id: 99 })).rejects.toThrow(/不存在/)
    await expect(map.update_todo.handler({ action: 'bogus' })).rejects.toThrow(/action/)
  })
})

describe('save_memory writes the run memory file', () => {
  it('saves and updates via the injected memoryPath', async () => {
    const r1 = await map.save_memory.handler({ name: '用户偏好', content: '中文回复' })
    expect(r1).toContain('已保存')
    const r2 = await map.save_memory.handler({ name: '用户偏好', content: '简洁中文' })
    expect(r2).toContain('已更新')
    expect(fs.readFileSync(ctx.memoryPath, 'utf8')).toContain('简洁中文')
    await expect(map.save_memory.handler({ name: '', content: 'x' })).rejects.toThrow(/名称/)
    ctx.memoryPath = null
    await expect(map.save_memory.handler({ name: 'a', content: 'b' })).rejects.toThrow(/未启用/)
    ctx.memoryPath = path.join(dir, 'agent-memory.md')
  })
})

describe('spawn_agent delegates to the injected runner', () => {
  it('returns the sub-agent conclusion and validates input', async () => {
    expect(await map.spawn_agent.handler({ goal: '统计行数' })).toBe('子Agent结论:统计行数')
    await expect(map.spawn_agent.handler({ goal: ' ' })).rejects.toThrow(/goal/)
    ctx.spawnAgent = undefined
    await expect(map.spawn_agent.handler({ goal: 'x' })).rejects.toThrow(/未启用/)
    ctx.spawnAgent = async ({ goal }) => '子Agent结论:' + goal
  })
})

describe('browser_* tools share one offscreen session', () => {
  it('navigate / click / type / close through a fake window', async () => {
    const fake = {
      destroyed: false,
      isDestroyed() {
        return this.destroyed
      },
      destroy() {
        this.destroyed = true
      },
      async loadURL() {},
      webContents: {
        async executeJavaScript(code) {
          if (code.includes('document.title'))
            return { title: '标题X', url: 'https://b.example/', text: '页面正文' }
          if (code.includes('el.click()')) return '已点击'
          if (code.includes('el.value=')) return '已输入'
          return 'ok'
        }
      }
    }
    const localCtx = { browserFactory: () => fake, todo: { seq: 0, items: [] } }
    const local = Object.fromEntries(defineTools(localCtx).map((t) => [t.name, t]))

    const snap = await local.browser_navigate.handler({ url: 'https://b.example/' })
    expect(snap).toContain('标题X')
    expect(snap).toContain('页面正文')
    expect(await local.browser_click.handler({ selector: '#a' })).toBe('已点击')
    expect(await local.browser_type.handler({ selector: '#i', text: 'hi' })).toBe('已输入')
    await expect(local.browser_navigate.handler({ url: 'javascript:1' })).rejects.toThrow(/http/)
    expect(await local.browser_close.handler({})).toContain('已关闭')
    expect(fake.destroyed).toBe(true)
  })

  it('errors when browserFactory is unavailable', async () => {
    const local = Object.fromEntries(
      defineTools({ todo: { seq: 0, items: [] } }).map((t) => [t.name, t])
    )
    await expect(local.browser_navigate.handler({ url: 'https://b.example/' })).rejects.toThrow(
      /不支持/
    )
  })
})

describe('browser_* tools delegate to the Run-scoped BrowserService', () => {
  it('forwards tabId and returns an untrusted snapshot after navigation', async () => {
    const calls = []
    const localCtx = {
      todo: { seq: 0, items: [] },
      browser: {
        navigate: async (args) => calls.push(['navigate', args]),
        snapshot: async (args) => {
          calls.push(['snapshot', args])
          return JSON.stringify({ untrusted: true, text: 'ok' })
        },
        click: async (args) => calls.push(['click', args]),
        tabs: () => [{ id: 'tab-1', kind: 'agent' }],
        close: async (args) => calls.push(['close', args])
      }
    }
    const local = Object.fromEntries(defineTools(localCtx).map((tool) => [tool.name, tool]))

    const out = await local.browser_navigate.handler({ url: 'https://example.com', tabId: 'tab-1' })
    expect(JSON.parse(out).untrusted).toBe(true)
    expect(calls).toEqual([
      ['navigate', { url: 'https://example.com', tabId: 'tab-1' }],
      ['snapshot', { tabId: 'tab-1' }]
    ])

    await local.browser_click.handler({ tabId: 'tab-1', ref: 2 })
    expect(calls.at(-1)).toEqual(['click', { tabId: 'tab-1', ref: 2 }])
    expect(JSON.parse(await local.browser_tabs.handler({}))).toHaveLength(1)
  })
})

describe('mcp_* tools resolve configured servers', () => {
  it('lists tools and calls a tool against a real spawned server', async () => {
    const server = path.join(os.tmpdir(), 'miniagent-tools-mcp-' + process.pid + '.js')
    fs.writeFileSync(
      server,
      `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',(l)=>{const m=JSON.parse(l);const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
if(m.method==='initialize')send(m.id,{protocolVersion:'2024-11-05'});
else if(m.method==='tools/list')send(m.id,{tools:[{name:'ping'}]});
else if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:'pong'}]})});`
    )
    ctx.mcpServers.live = { command: process.execPath, args: [server] }
    const list = await map.mcp_list_tools.handler({ server: 'live' })
    expect(list).toContain('- ping:')
    const r = await map.mcp_call_tool.handler({ server: 'live', tool: 'ping' })
    expect(r).toBe('pong')
    fs.rmSync(server, { force: true })
    delete ctx.mcpServers.live
  })

  it('rejects unknown servers', async () => {
    await expect(map.mcp_list_tools.handler({ server: 'nope' })).rejects.toThrow(/未配置/)
    await expect(map.mcp_call_tool.handler({ server: 'nope', tool: 'x' })).rejects.toThrow(/未配置/)
  })

  it('surfaces spawn failures as tool errors', async () => {
    await expect(map.mcp_list_tools.handler({ server: 'dead' })).rejects.toThrow(/MCP/)
  }, 20000)
})

describe('会话管理工具（session_*）', () => {
  it('session_create 创建子会话并回传 id', async () => {
    const r = JSON.parse(await map.session_create.handler({ title: '子任务' }))
    expect(r).toEqual({
      conversationId: 'c-new',
      title: '子任务',
      parentId: 'c-parent',
      origin: 'agent'
    })
  })

  it('session_send 默认按 chat，显式 agent 时透传 mode', async () => {
    const a = JSON.parse(await map.session_send.handler({ conversationId: 'c1', content: '你好' }))
    expect(a.mode).toBe('chat')
    const b = JSON.parse(
      await map.session_send.handler({ conversationId: 'c1', content: '干活', mode: 'agent' })
    )
    expect(b.mode).toBe('agent')
  })

  it('session_status / session_wait / session_result / session_list 走只读路径', async () => {
    expect(JSON.parse(await map.session_status.handler({ conversationId: 'c1' })).status).toBe(
      'done'
    )
    expect(JSON.parse(await map.session_wait.handler({ conversationId: 'c1' })).timedOut).toBe(
      false
    )
    expect(JSON.parse(await map.session_result.handler({ conversationId: 'c1' })).content).toBe(
      '结果正文'
    )
    const list = JSON.parse(await map.session_list.handler({}))
    expect(Array.isArray(list)).toBe(true)
    expect(list[0].conversationId).toBe('c1')
  })

  it('session_wait 必须等待异步 waitForSession 完成后再返回', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const local = Object.fromEntries(
      defineTools({
        todo: { seq: 0, items: [] },
        waitForSession: async ({ conversationId }) => {
          await gate
          return { conversationId, status: 'done', timedOut: false }
        }
      }).map((t) => [t.name, t])
    )

    let settled = false
    const pending = local.session_wait.handler({ conversationId: 'c1' }).then((r) => {
      settled = true
      return r
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    const r = JSON.parse(await pending)
    expect(r).toMatchObject({ conversationId: 'c1', status: 'done', timedOut: false })
  })

  it('session_send 透传 controlMode 与 acceptanceCriteria 给桥接层', async () => {
    const calls = []
    const local = Object.fromEntries(
      defineTools({
        todo: { seq: 0, items: [] },
        sendToSession: async (opts) => {
          calls.push(opts)
          return { mode: opts.mode }
        }
      }).map((t) => [t.name, t])
    )

    await local.session_send.handler({
      conversationId: 'c1',
      content: '把任务交出去',
      mode: 'agent',
      controlMode: 'transferred',
      acceptanceCriteria: '回答中包含三项结论'
    })

    expect(calls[0]).toMatchObject({
      conversationId: 'c1',
      content: '把任务交出去',
      mode: 'agent',
      controlMode: 'transferred',
      acceptancePolicy: {
        schemaVersion: 1,
        criteria: '回答中包含三项结论',
        judge: 'parent',
        onTimeout: 'escalate'
      }
    })
  })

  it('会话管理未注入时给出明确错误，而不是静默失败', async () => {
    const bare = Object.fromEntries(
      defineTools({ todo: { seq: 0, items: [] } }).map((t) => [t.name, t])
    )
    await expect(bare.session_create.handler({ title: 'x' })).rejects.toThrow('会话管理未启用')
    await expect(bare.session_send.handler({ conversationId: 'c', content: 'x' })).rejects.toThrow(
      '会话管理未启用'
    )
    await expect(bare.session_status.handler({ conversationId: 'c' })).rejects.toThrow(
      '会话管理未启用'
    )
  })

  it('会话类工具不低于只读风险等级（写操作需确认）', () => {
    const w = defineTools(ctx)
    const byName = Object.fromEntries(w.map((t) => [t.name, t]))
    expect(byName.session_create.risk).toBe('side_effect')
    expect(byName.session_send.risk).toBe('side_effect')
    expect(byName.session_status.risk).toBe('readonly')
    expect(byName.session_result.risk).toBe('readonly')
    expect(byName.session_list.risk).toBe('readonly')
    expect(byName.session_wait.risk).toBe('readonly')
  })
})
