// 浏览器预览专用 mock bridge：Electron 下 window.api 由 preload 注入，这里直接跳过。
// 仅在开发环境、且没有 preload 时生效，数据全部在内存中（主题等设置存 localStorage）。

const LS_KEY = 'miniagent.mock.settings'

const now = () => Date.now()
let counter = 0
const uid = (p = 'mock') => `${p}-${now().toString(36)}-${(counter += 1).toString(36)}`
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function buildReply(content, kbIds) {
  const q = (content || '').trim().slice(0, 40)
  const lines = [
    `收到：**${q}**`,
    '',
    '这是浏览器预览环境下的模拟回复（mock bridge），用于验证界面交互：',
    '',
    '- 流式输出与「停止」按钮',
    '- 会话列表、搜索与项目分组',
    '- 知识库、智能任务、设置页面的数据展示',
    '',
    '```js',
    "console.log('hello from mock bridge')",
    '```'
  ]
  if (kbIds && kbIds.length) lines.push('', `> 已模拟检索 ${kbIds.length} 个知识库`)
  return lines.join('\n')
}

function install() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const t0 = today.getTime()

  const settings = Object.assign(
    {
      theme: 'dark',
      chatListVisible: true,
      chatListWidth: 240,
      showBall: true,
      closeToTray: true,
      agentAuthorizedDirs: [],
      agentMaxSteps: 15,
      webSearchProvider: 'auto',
      tavilyApiKey: null,
      agentMcpServers: null,
      agentHooks: '[]',
      chatSampling: {}
    },
    loadSettings()
  )
  const persistSettings = () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings))
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  }

  const providers = [
    {
      id: 'prov-mock',
      name: 'Mock 服务',
      baseUrl: 'https://api.mock.local/v1',
      rotationStrategy: 'failover',
      probeIntervalMin: 30,
      probeModel: 'mock-chat',
      enabled: true,
      models: [
        { id: 'mock-chat', vision: false, maxChars: 12000, maxTokens: 2048 },
        { id: 'mock-vision', vision: true, maxChars: 20000, maxTokens: 4096 }
      ],
      keys: [{ id: 'key-mock', label: '预览 Key', status: 'ok', lastError: null }]
    }
  ]

  const projects = [
    {
      id: 'proj-mock',
      name: 'Mini Agent 开发',
      path: 'D:\\github\\Mini-Agent',
      pinned: 0,
      createdAt: t0 + 3600e3,
      updatedAt: t0 + 3600e3
    }
  ]

  const conversations = [
    {
      id: 'conv-welcome',
      title: '欢迎使用 Mini Agent',
      pinned: 1,
      providerId: 'prov-mock',
      model: 'mock-chat',
      systemPrompt: null,
      contextPolicy: null,
      projectId: null,
      permission: 'default',
      origin: 'user',
      parentId: null,
      createdByRun: null,
      createdAt: t0 + 7200e3,
      updatedAt: t0 + 7300e3
    },
    {
      id: 'conv-plan',
      title: '产品需求讨论',
      pinned: 0,
      providerId: 'prov-mock',
      model: 'mock-chat',
      systemPrompt: null,
      contextPolicy: null,
      projectId: 'proj-mock',
      permission: 'default',
      origin: 'user',
      parentId: null,
      createdByRun: null,
      createdAt: t0 + 5400e3,
      updatedAt: t0 + 5600e3
    },
    {
      id: 'conv-weekly',
      title: '周报整理',
      pinned: 0,
      providerId: 'prov-mock',
      model: 'mock-chat',
      systemPrompt: null,
      contextPolicy: null,
      projectId: null,
      // 演示会话级权限记忆：切走再切回，权限下拉恢复为「只读任务」
      permission: 'readonly',
      origin: 'user',
      parentId: null,
      createdByRun: null,
      createdAt: t0 + 3600e3,
      updatedAt: t0 + 3700e3
    }
  ]

  const messages = new Map()
  const pushMessage = (conversationId, role, content, extra = {}) => {
    const list = messages.get(conversationId) || []
    const seq = list.length ? Math.max(...list.map((m) => m.seq)) + 1 : 1
    const msg = {
      id: uid('msg'),
      conversationId,
      role,
      content,
      toolCalls: null,
      attachments: extra.attachments || null,
      meta: extra.meta || null,
      status: extra.status || 'done',
      seq,
      createdAt: now()
    }
    list.push(msg)
    messages.set(conversationId, list)
    return msg
  }

  pushMessage('conv-welcome', 'user', '你好，介绍一下你能做什么？')
  pushMessage(
    'conv-welcome',
    'assistant',
    [
      '你好，我是 **Mini Agent**，一个本地优先的桌面 AI 助理。',
      '',
      '当前示例数据来自浏览器 mock bridge，主要能力包括：',
      '',
      '1. 多供应商 / 多模型会话',
      '2. 知识库检索（本地 ONNX 向量）',
      '3. 智能任务：工具调用与逐次确认',
      '4. 项目分组、会话搜索与导出',
      '',
      '> 在 Electron 中运行时，这些能力由主进程真实实现。'
    ].join('\n')
  )
  pushMessage('conv-plan', 'user', '帮我梳理一下登录模块的改造点')
  pushMessage(
    'conv-plan',
    'assistant',
    '建议按「入口 → 校验 → 会话 → 风控」四层拆分，先补失败路径的测试，再动代码。'
  )

  const kbs = [
    {
      id: 'kb-mock',
      name: '产品手册',
      embedSource: 'local',
      embedProviderId: null,
      embedModel: 'bge-small-zh-v1.5',
      embedQuant: 'int8',
      dim: 512,
      createdAt: t0 + 4000e3,
      updatedAt: t0 + 4100e3
    }
  ]
  const docs = new Map([
    [
      'kb-mock',
      [
        {
          id: 'doc-1',
          kbId: 'kb-mock',
          path: 'D:\\docs\\产品手册.md',
          title: '产品手册.md',
          mime: 'text/markdown',
          size: 20480,
          chunkCount: 8,
          status: 'done',
          error: null,
          createdAt: t0 + 4200e3
        },
        {
          id: 'doc-2',
          kbId: 'kb-mock',
          path: 'D:\\docs\\常见问题.md',
          title: '常见问题.md',
          mime: 'text/markdown',
          size: 12800,
          chunkCount: 6,
          status: 'done',
          error: null,
          createdAt: t0 + 4300e3
        }
      ]
    ]
  ])

  const createMockWorkspaceIndex = (project, rebuild = false) => {
    let kb = kbs.find((item) => item.projectId === project.id && item.kind === 'workspace')
    if (!kb) {
      kb = {
        id: uid('kb'),
        name: `${project.name} · 工作区索引`,
        embedSource: 'local',
        embedProviderId: null,
        embedModel: 'bge-small-zh-v1.5',
        embedQuant: 'int8',
        dim: 512,
        projectId: project.id,
        kind: 'workspace',
        rootPath: project.path,
        createdAt: now(),
        updatedAt: now()
      }
      kbs.push(kb)
      docs.set(kb.id, [])
    }
    emit('kb:changed', { kbId: kb.id, projectId: project.id })
    emit('kb:progress', {
      kbId: kb.id,
      projectId: project.id,
      workspace: true,
      done: true,
      total: 0
    })
    return { started: true, kbId: kb.id, rebuilt: rebuild }
  }

  const modelPackages = [
    {
      id: 'bge-small-zh-int8',
      model: 'bge-small-zh-v1.5',
      quant: 'int8',
      dim: 512,
      sizeBytes: 24 * 1024 * 1024,
      sizeHint: '约 24 MB',
      downloaded: true
    },
    {
      id: 'bge-small-zh-fp32',
      model: 'bge-small-zh-v1.5',
      quant: 'fp32',
      dim: 512,
      sizeBytes: 95 * 1024 * 1024,
      sizeHint: '约 95 MB',
      downloaded: false
    },
    {
      id: 'bge-base-zh-int8',
      model: 'bge-base-zh-v1.5',
      quant: 'int8',
      dim: 768,
      sizeBytes: 48 * 1024 * 1024,
      sizeHint: '约 48 MB',
      downloaded: false
    }
  ]

  const runs = [
    {
      id: 'run-mock-1',
      conversation_id: 'conv-plan',
      conversationId: 'conv-plan',
      conversationTitle: '产品需求讨论',
      goal: '梳理登录模块的改造点并给出改动清单',
      status: 'done',
      max_steps: 15,
      steps_used: 2,
      started_at: t0 + 6000e3,
      ended_at: t0 + 6018e3
    }
  ]
  const calls = new Map([
    [
      'run-mock-1',
      [
        {
          id: 1,
          run_id: 'run-mock-1',
          step: 1,
          tool: 'read_file',
          args: JSON.stringify({ path: 'electron/main/gateway/index.js' }),
          risk_level: 'read_only',
          confirmed_by: 'auto',
          result: '已读取 482 行，定位到鉴权与流式响应入口。',
          error: null,
          duration_ms: 12,
          created_at: t0 + 6005e3
        },
        {
          id: 2,
          run_id: 'run-mock-1',
          step: 2,
          tool: 'web_search',
          args: JSON.stringify({ query: 'OAuth PKCE 最佳实践' }),
          risk_level: 'read_only',
          confirmed_by: 'auto',
          result: '已返回 3 条参考结果（mock）。',
          error: null,
          duration_ms: 640,
          created_at: t0 + 6012e3
        }
      ]
    ]
  ])

  const hooks = []
  const logs = [
    {
      id: 'log-mock-1',
      at: now() - 42000,
      level: 'info',
      scope: 'app',
      message: '应用启动（浏览器预览）',
      data: JSON.stringify({ version: '1.2.0-mock', platform: 'browser' })
    },
    {
      id: 'log-mock-2',
      at: now() - 30000,
      level: 'info',
      scope: 'event',
      message: 'run.start',
      data: JSON.stringify({ runId: 'run-mock-1', goal: '整理下载文件夹' })
    },
    {
      id: 'log-mock-3',
      at: now() - 18000,
      level: 'warn',
      scope: 'event',
      message: 'tool.after',
      data: JSON.stringify({ tool: 'web_search', error: '示例警告：搜索超时后已回退' })
    },
    {
      id: 'log-mock-4',
      at: now() - 6000,
      level: 'error',
      scope: 'console',
      message: '示例错误：连接服务失败（浏览器预览数据）',
      data: 'Error: mock network error\n    at preview (mockApi.js:1:1)'
    }
  ]
  const listeners = new Map()
  const timers = new Map()

  function emit(channel, payload) {
    const set = listeners.get(channel)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(clone(payload))
      } catch {
        /* 单个监听器异常不影响其他监听器 */
      }
    }
  }

  const on = (channel, cb) => {
    const set = listeners.get(channel) || new Set()
    set.add(cb)
    listeners.set(channel, set)
    return () => set.delete(cb)
  }

  const findConv = (id) => conversations.find((c) => c.id === id) || null
  const findProvider = (id) => providers.find((p) => p.id === id) || null
  const findMsg = (id) => {
    for (const list of messages.values()) {
      const m = list.find((x) => x.id === id)
      if (m) return m
    }
    return null
  }
  const touchConv = (id) => {
    const c = findConv(id)
    if (c) c.updatedAt = now()
  }
  const stopTimer = (msgId) => {
    const timer = timers.get(msgId)
    if (timer) clearInterval(timer)
    timers.delete(msgId)
  }
  const stopStreamsOf = (conversationId) => {
    for (const m of messages.get(conversationId) || []) {
      if (m.status === 'streaming') {
        stopTimer(m.id)
        m.status = 'stopped'
      }
    }
  }

  function streamReply(conversationId, msgId, text) {
    stopTimer(msgId)
    let i = 0
    const timer = setInterval(() => {
      const msg = findMsg(msgId)
      if (!msg || msg.status !== 'streaming') {
        stopTimer(msgId)
        return
      }
      const step = 2 + Math.floor(Math.random() * 4)
      const delta = text.slice(i, i + step)
      i += step
      msg.content += delta
      emit('chat:event', { type: 'delta', conversationId, msgId, delta })
      if (i >= text.length) {
        stopTimer(msgId)
        msg.content = text
        msg.status = 'done'
        touchConv(conversationId)
        emit('chat:event', {
          type: 'done',
          conversationId,
          msgId,
          content: text,
          meta: { mock: true }
        })
      }
    }, 28)
    timers.set(msgId, timer)
  }

  function kbStats(kbId) {
    return {
      docs: (docs.get(kbId) || []).length,
      chunks: (docs.get(kbId) || []).reduce((n, d) => n + d.chunkCount, 0)
    }
  }

  // 工作区文件 / 终端 / 侧边任务：浏览器预览用的内存实现
  const mockFiles = new Map()
  const termTimers = new Map()
  const sideTimers = new Map()
  const MOCK_ROOT = 'D:\\github\\Mini-Agent'
  const mockTree = {
    [MOCK_ROOT]: [
      { name: 'src', dir: true },
      { name: 'electron', dir: true },
      { name: 'README.md', dir: false },
      { name: 'package.json', dir: false }
    ],
    [MOCK_ROOT + '\\src']: [
      { name: 'views', dir: true },
      { name: 'main.js', dir: false },
      { name: 'App.vue', dir: false }
    ],
    [MOCK_ROOT + '\\electron']: [{ name: 'main', dir: true }],
    [MOCK_ROOT + '\\electron\\main']: [{ name: 'ipc.js', dir: false }]
  }

  const api = {
    settings: {
      get: (k) => clone(settings[k]),
      set: (k, v) => {
        settings[k] = clone(v)
        persistSettings()
        return true
      },
      all: () => clone(settings)
    },
    providers: {
      list: () => clone(providers),
      save: (p) => {
        const cur = p.id ? findProvider(p.id) : null
        if (cur) {
          Object.assign(cur, clone(p))
          return cur.id
        }
        const created = Object.assign(
          {
            id: uid('prov'),
            rotationStrategy: 'failover',
            probeIntervalMin: 30,
            probeModel: null,
            enabled: true,
            models: [],
            keys: []
          },
          clone(p)
        )
        providers.push(created)
        return created.id
      },
      remove: (id) => {
        const i = providers.findIndex((p) => p.id === id)
        if (i >= 0) providers.splice(i, 1)
        return true
      },
      fetchModels: (id) => {
        const p = findProvider(id)
        if (!p || !p.keys.length) throw new Error('该供应商没有可用 Key')
        return [
          { id: 'mock-chat', vision: false },
          { id: 'mock-reasoner', vision: false },
          { id: 'mock-vision', vision: true }
        ]
      },
      addKey: ({ providerId, label }) => {
        const p = findProvider(providerId)
        if (!p) throw new Error('供应商不存在')
        const key = { id: uid('key'), label: label || '', status: 'ok', lastError: null }
        p.keys.push(key)
        return key.id
      },
      removeKey: (id) => {
        for (const p of providers) p.keys = p.keys.filter((k) => k.id !== id)
        return true
      },
      probeKey: (id) => ({
        keyId: id,
        ok: true,
        kind: 'ok',
        status: 200,
        latencyMs: 12,
        detail: 'mock'
      }),
      probeAll: (pid) => {
        const p = findProvider(pid)
        return (p ? p.keys : []).map((k) => ({ keyId: k.id, ok: true, kind: 'ok', detail: 'mock' }))
      },
      events: () => []
    },
    conversations: {
      list: () =>
        clone(
          [...conversations].sort(
            (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt
          )
        ),
      create: (o = {}) => {
        const conv = {
          id: uid('conv'),
          title: o.title || '新会话',
          pinned: o.pinned ? 1 : 0,
          providerId: o.providerId || null,
          model: o.model || null,
          systemPrompt: null,
          contextPolicy: null,
          projectId: o.projectId || null,
          permission: ['default', 'readonly', 'autonomous', 'full'].includes(o.permission)
            ? o.permission
            : 'default',
          origin: 'user',
          parentId: null,
          createdByRun: null,
          createdAt: now(),
          updatedAt: now()
        }
        conversations.push(conv)
        messages.set(conv.id, [])
        return clone(conv)
      },
      update: ({ id, patch } = {}) => {
        const c = findConv(id)
        if (!c) return null
        Object.assign(c, clone(patch))
        c.updatedAt = now()
        return clone(c)
      },
      remove: (id) => {
        const i = conversations.findIndex((c) => c.id === id)
        if (i >= 0) conversations.splice(i, 1)
        messages.delete(id)
        return true
      },
      search: (q) => {
        const needle = String(q || '').toLowerCase()
        if (!needle) return clone(conversations)
        return clone(
          conversations.filter(
            (c) =>
              c.title.toLowerCase().includes(needle) ||
              (messages.get(c.id) || []).some((m) => m.content.toLowerCase().includes(needle))
          )
        )
      },
      messages: (id) => clone(messages.get(id) || [])
    },
    projects: {
      list: () =>
        clone(
          [...projects]
            .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.createdAt - b.createdAt)
            .map((p) => ({
              ...p,
              workspaceIndexKbId: kbs.find((kb) => kb.projectId === p.id)?.id || null
            }))
        ),
      create: (o = {}) => {
        const p = {
          id: uid('proj'),
          name: o.name || '未命名项目',
          path: o.path || '',
          pinned: 0,
          workspaceMode: o.workspaceMode === 'shared' ? 'shared' : 'worktree',
          workspaceAutoMerge: o.workspaceAutoMerge === 0 ? 0 : 1,
          workspaceVerifyCommand: String(o.workspaceVerifyCommand || '').trim(),
          workspaceConflictStrategy: ['manual', 'ours', 'theirs'].includes(
            o.workspaceConflictStrategy
          )
            ? o.workspaceConflictStrategy
            : 'manual',
          createdAt: now(),
          updatedAt: now()
        }
        projects.push(p)
        const workspaceIndex = o.createWorkspaceIndex ? createMockWorkspaceIndex(p) : null
        emit('projects:changed', {})
        return clone(workspaceIndex ? { ...p, workspaceIndex } : p)
      },
      update: ({ id, patch } = {}) => {
        const p = projects.find((x) => x.id === id)
        if (!p) return null
        Object.assign(p, clone(patch))
        p.updatedAt = now()
        emit('projects:changed', {})
        return clone(p)
      },
      remove: (id) => {
        const i = projects.findIndex((p) => p.id === id)
        if (i >= 0) projects.splice(i, 1)
        for (const c of conversations) if (c.projectId === id) c.projectId = null
        emit('projects:changed', {})
        return true
      },
      createIndex: ({ projectId, rebuild = true } = {}) => {
        const p = projects.find((item) => item.id === projectId)
        if (!p) throw new Error('项目不存在')
        const result = createMockWorkspaceIndex(p, rebuild)
        emit('projects:changed', {})
        return clone(result)
      }
    },
    chat: {
      send: ({ conversationId, content, kbIds, attachments } = {}) => {
        const conv = findConv(conversationId)
        if (!conv) throw new Error('会话不存在')
        stopStreamsOf(conversationId)
        const userMsg = pushMessage(conversationId, 'user', content, { attachments })
        const assistant = pushMessage(conversationId, 'assistant', '', { status: 'streaming' })
        // 与主进程一致：第一轮提示词优化后作为会话标题（mock 用轻量改写模拟优化结果）
        if (conv.title === '新会话' || !conv.title) {
          const draft = String(content || '')
            .trim()
            .replace(/\s+/g, ' ')
          const optimized = draft ? `请处理任务：${draft.slice(0, 16)}` : ''
          conv.title = (optimized || '新会话').slice(0, 24)
          emit('chat:event', {
            type: 'conversationRenamed',
            conversationId,
            title: conv.title
          })
        }
        touchConv(conversationId)
        emit('chat:event', {
          type: 'snapshot',
          conversationId,
          messages: [clone(userMsg), clone(assistant)]
        })
        streamReply(conversationId, assistant.id, buildReply(content, kbIds))
        return { userMsgId: userMsg.id, assistantMsgId: assistant.id }
      },
      stop: (msgId) => {
        const m = findMsg(msgId)
        stopTimer(msgId)
        if (m) {
          m.status = 'stopped'
          emit('chat:event', {
            type: 'stopped',
            conversationId: m.conversationId,
            msgId,
            content: m.content
          })
        }
        return true
      },
      optimizePrompt: async ({ content } = {}) => {
        await new Promise((r) => setTimeout(r, 350))
        const draft = String(content || '')
          .trim()
          .replace(/[。.!！?？]$/, '')
        return {
          prompt: [
            `请结合当前会话上下文，${draft}。`,
            '',
            '要求：',
            '1. 先说明目标与范围',
            '2. 给出可执行的步骤',
            '3. 标注需要确认的风险点'
          ].join('\n')
        }
      },
      regenerate: (cid) => {
        const conv = findConv(cid)
        if (!conv) throw new Error('会话不存在')
        const list = messages.get(cid) || []
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role === 'assistant') {
            list.splice(i, 1)
            break
          }
        }
        const assistant = pushMessage(cid, 'assistant', '', { status: 'streaming' })
        emit('chat:event', { type: 'snapshot', conversationId: cid, messages: [clone(assistant)] })
        streamReply(cid, assistant.id, buildReply('重新生成', []))
        return { assistantMsgId: assistant.id }
      },
      editResend: ({ msgId, content } = {}) => {
        const msg = findMsg(msgId)
        if (!msg) throw new Error('消息不存在')
        const list = messages.get(msg.conversationId) || []
        const idx = list.findIndex((m) => m.id === msgId)
        if (idx >= 0) list.splice(idx + 1)
        msg.content = content
        msg.status = 'done'
        const assistant = pushMessage(msg.conversationId, 'assistant', '', { status: 'streaming' })
        emit('chat:event', {
          type: 'snapshot',
          conversationId: msg.conversationId,
          messages: [clone(msg), clone(assistant)]
        })
        streamReply(msg.conversationId, assistant.id, buildReply(content, []))
        return { assistantMsgId: assistant.id }
      },
      export: ({ cid, mode } = {}) => {
        const conv = findConv(cid)
        if (!conv) throw new Error('会话不存在')
        const list = messages.get(cid) || []
        const body =
          mode === 'json'
            ? JSON.stringify({ conversation: conv, messages: list }, null, 2)
            : `# ${conv.title}\n\n` +
              list
                .map((m) => `### ${m.role === 'user' ? '用户' : '助手'}\n\n${m.content}`)
                .join('\n\n---\n\n')
        try {
          const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
          const a = document.createElement('a')
          a.href = url
          a.download = `${conv.title}.${mode === 'json' ? 'json' : 'md'}`
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch {
          /* 浏览器限制下载时忽略 */
        }
        emit('app:notice', { level: 'success', message: '已导出（浏览器模拟下载）' })
        return `${conv.title}.${mode === 'json' ? 'json' : 'md'}`
      },
      deleteMessage: (msgId) => {
        const msg = findMsg(msgId)
        if (msg) {
          const list = messages.get(msg.conversationId) || []
          const i = list.findIndex((m) => m.id === msgId)
          if (i >= 0) list.splice(i, 1)
        }
        emit('chat:event', {
          type: 'messageDeleted',
          conversationId: msg && msg.conversationId,
          msgId
        })
        return true
      }
    },
    kb: {
      list: () => clone(kbs.map((k) => ({ ...k, stats: kbStats(k.id) }))),
      create: (o = {}) => {
        const kb = {
          id: uid('kb'),
          name: o.name || '未命名知识库',
          embedSource: o.embedSource || 'local',
          embedProviderId: o.embedProviderId || null,
          embedModel: o.embedModel || null,
          embedQuant: o.embedQuant || 'fp32',
          projectId: o.projectId || null,
          kind: o.kind || 'document',
          rootPath: o.rootPath || null,
          dim: 512,
          createdAt: now(),
          updatedAt: now()
        }
        kbs.push(kb)
        docs.set(kb.id, [])
        return clone(kb)
      },
      update: ({ id, patch } = {}) => {
        const k = kbs.find((x) => x.id === id)
        if (!k) return null
        Object.assign(k, clone(patch))
        k.updatedAt = now()
        return clone(k)
      },
      remove: (id) => {
        const i = kbs.findIndex((k) => k.id === id)
        if (i >= 0) kbs.splice(i, 1)
        docs.delete(id)
        return true
      },
      docs: (kbId) => clone(docs.get(kbId) || []),
      removeDoc: (id) => {
        for (const [kbId, list] of docs)
          docs.set(
            kbId,
            list.filter((d) => d.id !== id)
          )
        return true
      },
      import: ({ kbId, paths } = {}) => {
        const list = docs.get(kbId) || []
        const total = (paths || []).length
        ;(paths || []).forEach((p, i) => {
          const title = String(p).split(/[\\/]/).pop()
          list.push({
            id: uid('doc'),
            kbId,
            path: p,
            title,
            mime: 'text/plain',
            size: 1024,
            chunkCount: 3,
            status: 'done',
            error: null,
            createdAt: now()
          })
          emit('kb:progress', { kbId, current: i + 1, total, path: p, status: 'indexed' })
        })
        docs.set(kbId, list)
        setTimeout(() => emit('kb:progress', { kbId, done: true, total }), 400)
        return { started: true }
      },
      rebuild: ({ kbId } = {}) => {
        const list = docs.get(kbId) || []
        list.forEach((d, i) => {
          setTimeout(
            () => {
              emit('kb:progress', {
                kbId,
                current: i + 1,
                total: list.length,
                path: d.path,
                status: 'rebuilt'
              })
              if (i === list.length - 1) {
                setTimeout(() => emit('kb:progress', { kbId, done: true, total: list.length }), 300)
              }
            },
            300 * (i + 1)
          )
        })
        return { started: true }
      },
      search: ({ kbId, query } = {}) => {
        const list = docs.get(kbId) || []
        const q = String(query || '')
        return {
          blocks: list.map((d, i) => ({
            chunkId: `${d.id}-chunk-${i}`,
            title: d.title,
            headingPath: i === 0 ? '概述 › 快速开始' : '常见问题',
            score: Math.max(0.52, 0.93 - i * 0.11).toFixed(2),
            text: `与「${q}」相关的模拟片段：${d.title} 中介绍了配置步骤、权限说明与故障排查方式。`
          }))
        }
      }
    },
    models: {
      list: () => clone(modelPackages),
      download: (id) => {
        const pkg = modelPackages.find((p) => p.id === id)
        if (!pkg) throw new Error('未知模型包')
        let received = 0
        const total = pkg.sizeBytes
        const timer = setInterval(() => {
          received = Math.min(total, received + Math.round(total / 8))
          emit('models:progress', { id, received, totalBytes: total, status: 'downloading' })
          if (received >= total) {
            clearInterval(timer)
            pkg.downloaded = true
            pkg.sizeBytes = total
            emit('models:progress', { id, done: true, status: 'done' })
          }
        }, 300)
        return { started: true }
      },
      remove: (id) => {
        const pkg = modelPackages.find((p) => p.id === id)
        if (pkg) pkg.downloaded = false
        return true
      }
    },
    agent: {
      run: ({ conversationId, goal, permission } = {}) => {
        const conv = findConv(conversationId)
        if (!conv) throw new Error('会话不存在')
        const runId = uid('run')
        const userMsg = pushMessage(conversationId, 'user', goal)
        const assistant = pushMessage(conversationId, 'assistant', '', {
          status: 'streaming',
          meta: { agentRunId: runId }
        })
        if (!conv.title || conv.title === '新会话') {
          const draft = String(goal || '')
            .trim()
            .replace(/\s+/g, ' ')
          conv.title = (draft ? `请处理任务：${draft.slice(0, 16)}` : '新会话').slice(0, 24)
          emit('chat:event', { type: 'conversationRenamed', conversationId, title: conv.title })
        }
        // 会话级权限记忆：与真实后端一致，运行权限同步回会话
        const mode = ['readonly', 'full'].includes(permission)
          ? permission
          : permission === 'default'
            ? 'default'
            : 'autonomous'
        conv.permission = mode
        const run = {
          id: runId,
          conversation_id: conversationId,
          conversationId,
          conversationTitle: conv.title,
          goal,
          status: 'running',
          max_steps: settings.agentMaxSteps || 15,
          steps_used: 0,
          started_at: now(),
          ended_at: null,
          control_mode: null,
          acceptance_status: 'not_required',
          acceptance_result: null
        }
        runs.unshift(run)
        calls.set(runId, [])
        touchConv(conversationId)
        emit('agent:event', {
          type: 'started',
          runId,
          assistantMsgId: assistant.id,
          conversationId
        })
        emit('chat:event', {
          type: 'snapshot',
          conversationId,
          messages: [clone(userMsg), clone(assistant)]
        })
        // 只读模式：mock 步骤全部为只读工具；其余模式保留含写入的演示步骤
        const steps =
          mode === 'readonly'
            ? [
                {
                  step: 1,
                  tool: 'read_file',
                  args: JSON.stringify({ path: 'README.md' }),
                  risk_level: 'read_only',
                  confirmed_by: 'auto',
                  result: '已读取项目说明（mock，只读）。'
                },
                {
                  step: 2,
                  tool: 'web_search',
                  args: JSON.stringify({ query: String(goal || '').slice(0, 20) }),
                  risk_level: 'read_only',
                  confirmed_by: 'auto',
                  result: '返回 3 条参考结果（mock，只读）。'
                }
              ]
            : [
                {
                  step: 1,
                  tool: 'read_file',
                  args: JSON.stringify({ path: 'README.md' }),
                  risk_level: 'read_only',
                  confirmed_by: 'auto',
                  result: '已读取项目说明（mock）。'
                },
                {
                  step: 2,
                  tool: 'run_command',
                  args: JSON.stringify({ command: 'npm run lint' }),
                  risk_level: 'side_effect',
                  confirmed_by: 'auto',
                  result: 'lint 通过（mock）。'
                }
              ]
        steps.forEach((s, i) => {
          setTimeout(
            () => {
              calls.get(runId).push({
                id: i + 1,
                run_id: runId,
                step: s.step,
                tool: s.tool,
                args: s.args,
                risk_level: s.risk_level,
                confirmed_by: s.confirmed_by,
                result: s.result,
                error: null,
                duration_ms: 20 + i * 15,
                created_at: now()
              })
              run.steps_used = s.step
              emit('agent:event', { type: 'step', runId, step: s.step, tool: s.tool })
            },
            500 * (i + 1)
          )
        })
        setTimeout(() => {
          const text =
            mode === 'readonly'
              ? `只读任务已完成（mock）：${goal}\n\n1. 读取了项目说明\n2. 执行了网页搜索\n\n只读模式：未执行任何写入操作。`
              : `任务已完成（mock）：${goal}\n\n1. 读取了项目说明\n2. 执行了 lint 检查\n\n以上步骤均为浏览器预览模拟，不会真正修改文件。`
          assistant.content = text
          assistant.status = 'done'
          run.status = 'done'
          run.ended_at = now()
          touchConv(conversationId)
          emit('chat:event', {
            type: 'done',
            conversationId,
            msgId: assistant.id,
            content: text,
            meta: { mock: true, agentRunId: runId }
          })
          emit('agent:event', { type: 'done', runId })
        }, 1800)
        return { runId, assistantMsgId: assistant.id }
      },
      stop: (runId) => {
        const run = runs.find((r) => r.id === runId)
        if (run && run.status === 'running') {
          run.status = 'stopped'
          run.ended_at = now()
          emit('agent:event', { type: 'done', runId })
        }
        return true
      },
      respond: () => true,
      recovery: (runId) => {
        const run = runs.find((r) => r.id === runId)
        if (!run) throw new Error('任务不存在')
        return {
          runId,
          status: run.status,
          canResume: false,
          reason: run.status === 'interrupted' ? 'unsafe_checkpoint' : 'not_interrupted',
          checkpoint: null,
          unfinishedTools: [],
          workspace: null
        }
      },
      resumeInterrupted: ({ runId } = {}) => {
        const run = runs.find((r) => r.id === runId)
        if (!run) throw new Error('任务不存在')
        run.status = 'queued'
        emit('agent:event', { type: 'queued', runId })
        return clone(run)
      },
      retryInterrupted: ({ runId } = {}) => {
        const original = runs.find((r) => r.id === runId)
        if (!original) throw new Error('任务不存在')
        const retry = api.agent.run({
          conversationId: original.conversationId,
          goal: original.goal,
          permission: 'autonomous'
        })
        return { ...retry, retryOfRunId: runId }
      },
      acceptanceDecide: ({ runId, decision, reason } = {}) => {
        const run = runs.find((r) => r.id === runId)
        if (!run) throw new Error('任务不存在')
        run.acceptance_status = decision
        run.acceptance_result = JSON.stringify({
          verdict: decision,
          reason: reason || '人工验收（mock）',
          unmet: [],
          manual: { decision, actor: 'desktop', at: now() }
        })
        emit('agent:event', { type: 'acceptance', runId, status: decision })
        return clone(run)
      },
      runs: () => clone(runs),
      calls: (runId) => clone(calls.get(runId) || []),
      graph: () => null,
      mutateGraph: () => null
    },
    sessions: {
      status: ({ conversationId } = {}) => ({ conversationId, status: 'idle' }),
      list: () => [],
      result: () => null,
      send: () => ({}),
      wait: () => ({ waited: 0, timedOut: false })
    },
    events: {
      since: () => ({ events: [], seq: 0, truncated: false }),
      recent: () => [],
      stats: () => ({ seq: 0, size: 0, listeners: 0 })
    },
    logs: {
      list: ({ level = 'all', search = '', limit = 500 } = {}) => {
        const q = String(search || '')
          .trim()
          .toLowerCase()
        return clone(
          logs
            .filter(
              (e) =>
                (level === 'all' || e.level === level) &&
                (!q ||
                  `${e.level} ${e.scope} ${e.message} ${e.data || ''}`.toLowerCase().includes(q))
            )
            .slice(0, Math.min(Number(limit) || 500, logs.length))
        )
      },
      stats: () => ({
        size: logs.length,
        bytes: JSON.stringify(logs).length,
        path: '（浏览器内存）',
        dir: '',
        maxEntries: 800
      }),
      clear: () => {
        logs.length = 0
        return true
      },
      openFolder: () => {
        emit('app:notice', { level: 'info', message: '浏览器预览不支持打开日志目录' })
        return false
      }
    },
    hooks: {
      meta: () => ({
        stages: ['session.send', 'run.start', 'run.end', 'tool.before', 'tool.after'],
        actions: ['notify', 'log', 'block']
      }),
      list: () => clone(hooks),
      save: (list) => {
        hooks.splice(0, hooks.length, ...(Array.isArray(list) ? clone(list) : []))
        return clone(hooks)
      },
      dryRun: () => ({ ok: true })
    },
    sys: {
      clipboardRead: () => navigator.clipboard.readText().catch(() => ''),
      clipboardWrite: (text) => navigator.clipboard.writeText(text).catch(() => undefined),
      selectionCapture: () => ''
    },
    dialog: { pickFiles: () => null, pickDir: () => 'D:\\mock\\workspace' },
    data: {
      export: () => ({
        conversations: conversations.length,
        messages: [...messages.values()].reduce((n, list) => n + list.length, 0)
      }),
      import: () => null
    },
    app: {
      showMain: () => true,
      toggleMain: () => true,
      quit: () => true,
      openExternal: (url) => {
        try {
          window.open(url, '_blank', 'noopener')
        } catch {
          /* 弹窗被拦截时忽略 */
        }
        return true
      },
      info: () => ({
        version: '1.2.0-mock',
        dataDir: '（浏览器内存）',
        dbPath: '（浏览器内存）',
        driver: 'mock',
        platform: 'browser',
        node: '-'
      }),
      autostart: () => false,
      setAutostart: (v) => !!v,
      hotkeys: () =>
        clone(settings.hotkeys || { quick: 'Alt+Space', selection: 'Alt+Q', capture: 'Alt+S' }),
      setHotkeys: (map) => {
        settings.hotkeys = clone(map)
        persistSettings()
        return Object.fromEntries(Object.keys(map || {}).map((k) => [k, { ok: true }]))
      },
      captureStart: () => {
        emit('app:notice', { level: 'info', message: '浏览器预览不支持截图' })
        return true
      }
    },
    // 浏览器预览：不联网，返回「有更新」的假态以便核对侧栏入口与弹窗样式。
    // 真机由主进程 updater 推送真实结果。
    updater: {
      state: () => ({
        available: true,
        behind: 2,
        reason: 'commit-ahead',
        checkedAt: Date.now(),
        error: null,
        current: { version: '1.2.0-mock', commit: 'mock0000', shortCommit: 'mock000' },
        latest: {
          version: '1.2.0',
          commit: 'mocked111',
          shortCommit: 'mocked1',
          message: '预览环境模拟提交：侧栏更新入口样式校验',
          date: new Date().toISOString(),
          compareUrl: 'https://github.com/'
        }
      }),
      check: () => api.updater.state()
    },
    workspace: {
      roots: () => [{ id: 'mock-ws', name: 'Mini Agent 开发', path: MOCK_ROOT }],
      // 渲染层传入字符串路径，preload 会包成 { path }；这里两种入参都兼容
      list: async (arg) => {
        const p = typeof arg === 'string' ? arg : (arg && arg.path) || ''
        return (mockTree[String(p)] || []).map((e) => ({ ...e, path: String(p) + '\\' + e.name }))
      },
      read: async (arg) => {
        const key = String(typeof arg === 'string' ? arg : (arg && arg.path) || '')
        if (mockFiles.has(key)) {
          const content = mockFiles.get(key)
          return { content, size: content.length, mtime: Date.now() }
        }
        const content = key.endsWith('package.json')
          ? JSON.stringify({ name: 'miniagent', version: '1.5.0', private: true }, null, 2)
          : `// 浏览器预览环境的模拟文件\n// ${key}\n\nexport const preview = true\n`
        return { content, size: content.length, mtime: Date.now() }
      },
      write: async (arg, contentArg) => {
        const p = typeof arg === 'string' ? arg : (arg && arg.path) || ''
        const content = typeof arg === 'string' ? contentArg : arg && arg.content
        const text = String(content == null ? '' : content)
        mockFiles.set(String(p), text)
        return { size: text.length }
      }
    },
    terminal: {
      run: ({ id, command, cwd } = {}) => {
        const runId = String(id || '')
        const chunks = [
          `预览环境执行：${String(command || '')}\n`,
          `工作目录：${cwd || '默认目录'}\n`,
          'hello from mock terminal\n'
        ]
        let i = 0
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer)
            termTimers.delete(runId)
            emit('terminal:event', { id: runId, type: 'exit', code: 0 })
            return
          }
          emit('terminal:event', { id: runId, type: 'data', stream: 'stdout', text: chunks[i++] })
        }, 220)
        termTimers.set(runId, timer)
        return { ok: true }
      },
      stop: ({ id } = {}) => {
        const runId = String(id || '')
        const timer = termTimers.get(runId)
        if (!timer) return { stopped: false }
        clearInterval(timer)
        termTimers.delete(runId)
        emit('terminal:event', { id: runId, type: 'exit', code: 130 })
        return { stopped: true }
      }
    },
    side: {
      send: ({ id, content, useContext } = {}) => {
        const runId = String(id || '')
        const reply = [
          `（预览环境）收到侧边任务：${String(content || '')}`,
          useContext === false ? '当前未引用主会话上下文。' : '已引用主会话上下文进行解读。',
          '- 关键结论：此处为 mock bridge 的模拟输出\n- 建议：在 Electron 窗口中验证真实模型结果'
        ].join('\n\n')
        let i = 0
        emit('side:event', { type: 'start', id: runId })
        const timer = setInterval(() => {
          if (i >= reply.length) {
            clearInterval(timer)
            sideTimers.delete(runId)
            emit('side:event', { type: 'done', id: runId, content: reply })
            return
          }
          const delta = reply.slice(i, i + 4)
          i += 4
          emit('side:event', { type: 'delta', id: runId, delta })
        }, 24)
        sideTimers.set(runId, timer)
        return { ok: true }
      },
      stop: ({ id } = {}) => {
        const runId = String(id || '')
        const timer = sideTimers.get(runId)
        if (!timer) return { stopped: false }
        clearInterval(timer)
        sideTimers.delete(runId)
        emit('side:event', { type: 'stopped', id: runId, content: '' })
        return { stopped: true }
      }
    },
    browser: (() => {
      // 极简浏览器 mock：只为预览环境提供标签页状态，内部页面（miniagent://）可正常打开
      let bEnabled = true
      let bTabs = []
      let bActive = null
      let bAttached = null
      const INTERNAL_TITLES = { files: '工作区文件', terminal: '终端', side: '临时会话' }
      const bState = () => ({
        enabled: bEnabled,
        tabs: bTabs.map((t) => ({ ...t, bounds: null, devToolsOpened: false })),
        activeTabId: bActive,
        attachedTabId: bAttached,
        policy: { allowPrivateNetwork: false, maxTabs: 6 }
      })
      const bEmit = () => emit('browser:event', { type: 'state', state: bState() })
      const browserTab = (url) => {
        const raw = String(url || 'about:blank')
        const internal = raw.startsWith('miniagent://')
          ? raw.slice('miniagent://'.length).replace(/\/+$/, '')
          : null
        return {
          id: uid('tab'),
          kind: 'user',
          owner: 'user',
          title: internal
            ? INTERNAL_TITLES[internal] || '内部页面'
            : raw === 'about:blank'
              ? '新标签页'
              : raw,
          url: raw,
          internal: internal || null,
          loading: false,
          error: null,
          crashed: false,
          device: null,
          createdAt: now()
        }
      }
      const bFind = (id) => bTabs.find((t) => t.id === id) || null
      return {
        state: () => bState(),
        setEnabled: (v) => {
          bEnabled = v !== false
          bEmit()
          return bState()
        },
        open: ({ url } = {}) => {
          const tab = browserTab(url)
          bTabs.push(tab)
          bActive = tab.id
          bEmit()
          return clone(tab)
        },
        navigate: ({ tabId, url } = {}) => {
          const tab = bFind(tabId)
          if (!tab) throw new Error('标签不存在')
          if (tab.internal) throw new Error('内部页面不支持地址导航')
          const next = browserTab(url)
          tab.url = next.url
          tab.title = next.title
          bEmit()
          return clone(tab)
        },
        activate: (tabId) => {
          if (bFind(tabId)) {
            bActive = tabId
            bAttached = tabId
            bEmit()
          }
          return bState()
        },
        close: (tabId) => {
          bTabs = bTabs.filter((t) => t.id !== tabId)
          if (bActive === tabId) bActive = bTabs.length ? bTabs[bTabs.length - 1].id : null
          if (bAttached === tabId) bAttached = null
          bEmit()
          return bState()
        },
        command: () => bState(),
        toggleDevTools: (tabId) => clone(bFind(tabId)),
        selectElement: () => ({ selecting: true, selected: null }),
        cancelElementSelection: () => ({ selecting: false, selected: null }),
        inspectorState: () => ({ selecting: false, selected: null }),
        updateElementStyles: () => ({ selected: null }),
        resetElementStyles: () => ({ selected: null }),
        setDevice: () => bState(),
        clearDevice: () => bState(),
        attach: (tabId) => {
          if (bFind(tabId)) bAttached = tabId
          bEmit()
          return bState()
        },
        detach: () => {
          bAttached = null
          bEmit()
          return bState()
        },
        takeover: () => bState(),
        release: () => bState(),
        screenshot: () => {
          throw new Error('预览环境不支持截图')
        },
        clearData: () => bState()
      }
    })(),
    on
  }

  window.api = api
}

export function installMockApi() {
  if (window.api) return
  install()
}
