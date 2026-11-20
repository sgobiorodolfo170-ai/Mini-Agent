const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { execFile } = require('child_process')
const { assertAllowed } = require('./guard')
const { webSearch } = require('./web-search')
const { createBrowserSession } = require('./browser-session')
const { withMcpServer } = require('./mcp-client')
const { upsertMemoryFile } = require('./memory')

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function runPowerShell(command, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String(command)],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        cwd: cwd || undefined,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        if (err && err.killed) return resolve({ ok: false, output: '命令超时被终止(60s)' })
        const out = [stdout, stderr].filter(Boolean).join('\n[stderr]\n').trim()
        if (err && !out)
          return resolve({
            ok: false,
            output: '命令失败: ' + String(err.message || '').slice(0, 300)
          })
        resolve({ ok: !err, output: out || '(无输出)' })
      }
    )
  })
}

// Built-in tool set.
// ctx: { authorizedDirs, workingDir, clipboard, shell, todo, spawnAgent, memoryPath,
//        browserFactory, mcpServers, tavilyKey, webSearchProvider }
function defineTools(ctx) {
  return [
    {
      name: 'list_dir',
      risk: 'readonly',
      description: '列出目录内容（限授权目录）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录绝对路径' } },
        required: ['path']
      },
      handler: async ({ path: p }) => {
        assertAllowed(ctx.authorizedDirs, p)
        const es = await fsp.readdir(p, { withFileTypes: true })
        return (
          es
            .slice(0, 200)
            .map((e) => (e.isDirectory() ? '[目录] ' : '[文件] ') + e.name)
            .join('\n') || '(空目录)'
        )
      }
    },
    {
      name: 'read_file',
      risk: 'readonly',
      description: '读取文本文件内容（最多 20000 字符，限授权目录）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件绝对路径' } },
        required: ['path']
      },
      handler: async ({ path: p }) => {
        assertAllowed(ctx.authorizedDirs, p)
        const buf = await fsp.readFile(p)
        if (buf.length > 2 * 1024 * 1024) return '文件过大(>2MB)，拒绝读取'
        return buf.toString('utf8').slice(0, 20000)
      }
    },
    {
      name: 'search_files',
      risk: 'readonly',
      description: '在目录内按文件名子串递归搜索（最多 100 条，限授权目录）',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '搜索根目录' },
          pattern: { type: 'string', description: '文件名包含的子串' }
        },
        required: ['dir', 'pattern']
      },
      handler: async ({ dir, pattern }) => {
        assertAllowed(ctx.authorizedDirs, dir)
        const out = []
        async function walk(d, depth) {
          if (out.length >= 100 || depth > 6) return
          let es
          try {
            es = await fsp.readdir(d, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of es) {
            const fp = path.join(d, e.name)
            if (e.isDirectory()) await walk(fp, depth + 1)
            else if (e.name.toLowerCase().includes(String(pattern).toLowerCase())) out.push(fp)
          }
        }
        await walk(dir, 0)
        return out.join('\n') || '(无匹配)'
      }
    },
    {
      name: 'write_file',
      risk: 'side_effect',
      description: '写入/覆盖文本文件（限授权目录）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件绝对路径' },
          content: { type: 'string', description: '要写入的完整内容' }
        },
        required: ['path', 'content']
      },
      handler: async ({ path: p, content }) => {
        assertAllowed(ctx.authorizedDirs, p)
        await fsp.mkdir(path.dirname(p), { recursive: true })
        await fsp.writeFile(p, String(content == null ? '' : content), 'utf8')
        return `已写入 ${String(content == null ? '' : content).length} 字符到 ${p}`
      }
    },
    {
      name: 'run_command',
      risk: 'side_effect',
      description: '执行 PowerShell 命令（60 秒超时，输出截断到 20k 字符）',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'PowerShell 命令' } },
        required: ['command']
      },
      handler: async ({ command }) => {
        const r = await runPowerShell(command, ctx.workingDir, 60000)
        return String(r.output).slice(0, 20000)
      }
    },
    {
      name: 'web_fetch',
      risk: 'readonly',
      description: '抓取 http(s) 网页并提取正文文本',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 URL' } },
        required: ['url']
      },
      handler: async ({ url }) => {
        const u = new URL(url)
        if (!/^https?:$/.test(u.protocol)) throw new Error('仅支持 http(s) URL')
        const res = await fetch(u.toString(), {
          signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'Mozilla/5.0 (miniagent)' }
        })
        const html = await res.text()
        return htmlToText(html).slice(0, 20000) || '(空页面)'
      }
    },
    {
      name: 'edit_file',
      risk: 'side_effect',
      description: '在文件中做精确字符串替换编辑（oldText 必须与文件内容完全一致）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          oldText: { type: 'string', description: '要被替换的原文（需包含足够上下文以唯一定位）' },
          newText: { type: 'string', description: '替换后的新文本' },
          replaceAll: { type: 'boolean', description: '替换全部出现（默认只允许唯一匹配）' }
        },
        required: ['path', 'oldText', 'newText']
      },
      handler: async ({ path: p, oldText, newText, replaceAll }) => {
        assertAllowed(ctx.authorizedDirs, p)
        if (!oldText) throw new Error('oldText 不能为空')
        const s = await fsp.readFile(p, 'utf8')
        const count = s.split(oldText).length - 1
        if (!count) throw new Error('未找到要替换的文本（oldText 与文件内容不一致）')
        if (!replaceAll && count > 1)
          throw new Error(
            `oldText 在文件中出现 ${count} 次：请扩大上下文唯一定位，或设置 replaceAll=true`
          )
        const out = replaceAll
          ? s.split(oldText).join(String(newText))
          : s.replace(oldText, String(newText))
        await fsp.writeFile(p, out, 'utf8')
        return `已替换 ${replaceAll ? count : 1} 处: ${p}`
      }
    },
    {
      name: 'grep_files',
      risk: 'readonly',
      description:
        '在目录内按内容子串或正则搜索文本文件（返回 路径:行号:内容，最多 50 处，限授权目录）',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '搜索根目录' },
          pattern: { type: 'string', description: '内容匹配的子串或正则' },
          isRegex: { type: 'boolean', description: '把 pattern 当作正则表达式（默认 false）' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 true）' }
        },
        required: ['dir', 'pattern']
      },
      handler: async ({ dir, pattern, isRegex, ignoreCase = true }) => {
        assertAllowed(ctx.authorizedDirs, dir)
        if (!pattern) throw new Error('pattern 不能为空')
        let re = null
        if (isRegex) {
          try {
            re = new RegExp(pattern, ignoreCase ? 'i' : '')
          } catch {
            throw new Error('无效的正则表达式: ' + pattern)
          }
        }
        const needle = String(pattern).toLowerCase()
        const hits = []
        async function walk(d, depth) {
          if (hits.length >= 50 || depth > 6) return
          let es
          try {
            es = await fsp.readdir(d, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of es) {
            if (hits.length >= 50) return
            const fp = path.join(d, e.name)
            if (e.isDirectory()) {
              await walk(fp, depth + 1)
              continue
            }
            try {
              const st = await fsp.stat(fp)
              if (st.size > 1024 * 1024) continue
              const buf = await fsp.readFile(fp)
              if (buf.includes(0)) continue // 二进制文件跳过
              const lines = buf.toString('utf8').split('\n')
              for (let i = 0; i < lines.length && hits.length < 50; i++) {
                const line = lines[i]
                const matched = isRegex ? re.test(line) : line.toLowerCase().includes(needle)
                if (matched) hits.push(`${fp}:${i + 1}: ${line.trim().slice(0, 200)}`)
              }
            } catch {
              // 无权限/已消失的文件直接跳过
            }
          }
        }
        await walk(dir, 0)
        return hits.join('\n') || '(无匹配)'
      }
    },
    {
      name: 'web_search',
      risk: 'readonly',
      description:
        '联网搜索并返回「标题+URL+摘要」列表（配置 Tavily Key 时优先 Tavily，否则用 DuckDuckGo 免 Key 端点）',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          provider: { type: 'string', description: '搜索通道: auto(默认)/tavily/ddg' }
        },
        required: ['query']
      },
      handler: async ({ query, provider }) =>
        webSearch({
          query,
          provider: provider || ctx.webSearchProvider || 'auto',
          tavilyKey: ctx.tavilyKey
        })
    },
    {
      name: 'update_todo',
      risk: 'readonly',
      description:
        '维护当前运行的任务清单。action: add(需content)/update(需id,content)/complete(需id)/remove(需id)/clear/list',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'add | update | complete | remove | clear | list'
          },
          id: { type: 'number', description: '任务编号（update/complete/remove 时必填）' },
          content: { type: 'string', description: '任务内容（add/update 时使用）' }
        },
        required: ['action']
      },
      handler: async ({ action, id, content }) => {
        const todo = ctx.todo || (ctx.todo = { seq: 0, items: [] })
        const items = todo.items
        const fmt = () =>
          items.length
            ? items
                .map((t) => `${t.status === 'done' ? '[x]' : '[ ]'} #${t.id} ${t.content}`)
                .join('\n')
            : '(任务清单为空)'
        switch (action) {
          case 'add': {
            const text = String(content || '').trim()
            if (!text) throw new Error('content 不能为空')
            todo.seq = (todo.seq || 0) + 1
            items.push({ id: todo.seq, content: text, status: 'pending' })
            break
          }
          case 'update': {
            const t = items.find((x) => x.id === Number(id))
            if (!t) throw new Error(`任务不存在: #${id}`)
            const text = String(content || '').trim()
            if (!text) throw new Error('content 不能为空')
            t.content = text
            break
          }
          case 'complete': {
            const t = items.find((x) => x.id === Number(id))
            if (!t) throw new Error(`任务不存在: #${id}`)
            t.status = 'done'
            break
          }
          case 'remove': {
            const idx = items.findIndex((x) => x.id === Number(id))
            if (idx < 0) throw new Error(`任务不存在: #${id}`)
            items.splice(idx, 1)
            break
          }
          case 'clear':
            items.length = 0
            break
          case 'list':
            break
          default:
            throw new Error(`未知 action: ${action}（可用: add/update/complete/remove/clear/list）`)
        }
        return fmt()
      }
    },
    {
      name: 'save_memory',
      risk: 'readonly',
      description:
        '把值得长期记住的信息写入记忆文件（按 name 小节保存，每次运行开始自动注入上下文）',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '记忆条目名称（短）' },
          content: { type: 'string', description: '记忆内容' }
        },
        required: ['name', 'content']
      },
      handler: async ({ name, content }) => {
        if (!ctx.memoryPath) throw new Error('记忆功能未启用')
        return upsertMemoryFile(ctx.memoryPath, name, content)
      }
    },
    {
      name: 'spawn_agent',
      risk: 'side_effect',
      description:
        '派生一个子 Agent 独立完成子任务并只返回最终结论（子 Agent 不可再派生；其工具调用走同样的确认流程）',
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: '子任务目标的完整自包含描述' } },
        required: ['goal']
      },
      handler: async ({ goal }) => {
        const g = String(goal || '').trim()
        if (!g) throw new Error('goal 不能为空')
        if (typeof ctx.spawnAgent !== 'function') throw new Error('子 Agent 未启用')
        return ctx.spawnAgent({ goal: g })
      }
    },
    {
      name: 'clipboard_read',
      risk: 'side_effect',
      description: '读取剪贴板文本（最多 5000 字符）',
      parameters: { type: 'object', properties: {} },
      handler: async () => (ctx.clipboard.readText() || '').slice(0, 5000) || '(剪贴板为空)'
    },
    {
      name: 'clipboard_write',
      risk: 'side_effect',
      description: '把文本写入剪贴板',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      handler: async ({ text }) => {
        ctx.clipboard.writeText(String(text == null ? '' : text))
        return '已写入剪贴板'
      }
    },
    {
      name: 'open_url',
      risk: 'side_effect',
      description: '用系统默认浏览器打开 http(s) URL',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      },
      handler: async ({ url }) => {
        const u = new URL(url)
        if (!/^https?:$/.test(u.protocol)) throw new Error('仅支持 http(s) URL')
        await ctx.shell.openExternal(u.toString())
        return '已打开 ' + u.toString()
      }
    },
    {
      name: 'browser_navigate',
      risk: 'readonly',
      description:
        '在内置离屏浏览器中打开网页并返回标题+正文文本（后续可用 browser_click/browser_type 交互）',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 http(s) URL' } },
        required: ['url']
      },
      handler: async ({ url }) => browserSession(ctx).navigate(url)
    },
    {
      name: 'browser_click',
      risk: 'side_effect',
      description: '在当前页面点击元素（CSS 选择器）',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS 选择器' } },
        required: ['selector']
      },
      handler: async ({ selector }) => browserSession(ctx).click(selector)
    },
    {
      name: 'browser_type',
      risk: 'side_effect',
      description: '向页面输入框填写文本（CSS 选择器定位，可选 submit 提交所在表单）',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '要输入的文本' },
          submit: { type: 'boolean', description: '输入后提交所在表单（默认 false）' }
        },
        required: ['selector', 'text']
      },
      handler: async ({ selector, text, submit }) =>
        browserSession(ctx).type({ selector, text, submit })
    },
    {
      name: 'browser_close',
      risk: 'readonly',
      description: '关闭内置浏览器会话',
      parameters: { type: 'object', properties: {} },
      handler: async () => browserSession(ctx).close()
    },
    {
      name: 'mcp_list_tools',
      risk: 'readonly',
      description:
        '列出某个已配置 MCP 服务器的工具清单（服务器在设置的 agentMcpServers JSON 中配置）',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'MCP 服务器名称' } },
        required: ['server']
      },
      handler: async ({ server }) => {
        const cfg = requireMcp(ctx, server)
        return withMcpServer(cfg, async (client) => {
          const tools = await client.listTools()
          if (!tools.length) return '(该服务器未提供工具)'
          return tools
            .map((t) => `- ${t.name}: ${String(t.description || '').slice(0, 120)}`)
            .join('\n')
        })
      }
    },
    {
      name: 'mcp_call_tool',
      risk: 'side_effect',
      description: '调用某个已配置 MCP 服务器上的工具（远程效果不可撤销，需确认）',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP 服务器名称' },
          tool: { type: 'string', description: '工具名' },
          args: { type: 'object', description: '工具参数对象' }
        },
        required: ['server', 'tool']
      },
      handler: async ({ server, tool, args }) => {
        const cfg = requireMcp(ctx, server)
        return withMcpServer(cfg, (client) => client.callTool(String(tool), args))
      }
    }
  ]
}

// browser_* 工具共享同一个离屏会话（按 ctx 惰性创建，close 后重建）。
function browserSession(ctx) {
  if (!ctx._browser) {
    ctx._browser = createBrowserSession({ windowFactory: ctx.browserFactory })
  }
  return ctx._browser
}

function requireMcp(ctx, server) {
  const cfg = (ctx.mcpServers || {})[String(server || '')]
  if (!cfg) {
    const names = Object.keys(ctx.mcpServers || {})
    throw new Error(
      `未配置 MCP 服务器「${server}」${names.length ? `（可用: ${names.join(', ')}）` : '（需在设置 agentMcpServers 中配置）'}`
    )
  }
  return cfg
}

module.exports = { defineTools, htmlToText, runPowerShell }
