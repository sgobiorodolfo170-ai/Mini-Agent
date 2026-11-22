const { contextBridge, ipcRenderer } = require('electron')

const inv = (ch, ...args) =>
  ipcRenderer.invoke(
    ch,
    ...args.map((a) => (a && typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : a))
  )

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function bridgeArg() {
  const a = process.argv.find((s) => s.startsWith('--bridge='))
  return a ? a.slice('--bridge='.length) : 'main'
}

function buildMain() {
  contextBridge.exposeInMainWorld('api', {
    settings: {
      get: (k) => inv('settings:get', k),
      set: (k, v) => inv('settings:set', k, v),
      all: () => inv('settings:all')
    },
    providers: {
      list: () => inv('providers:list'),
      save: (p) => inv('providers:save', p),
      remove: (id) => inv('providers:delete', id),
      fetchModels: (id, baseUrl) => inv('providers:fetchModels', { id, baseUrl }),
      addKey: (o) => inv('keys:add', o),
      removeKey: (id) => inv('keys:remove', id),
      probeKey: (id) => inv('keys:probe', id),
      probeAll: (pid) => inv('keys:probeAll', pid),
      events: () => inv('keys:events')
    },
    conversations: {
      list: () => inv('conversations:list'),
      create: (o) => inv('conversations:create', o),
      update: (o) => inv('conversations:update', o),
      remove: (id) => inv('conversations:delete', id),
      search: (q) => inv('conversations:search', q),
      messages: (id) => inv('conversations:messages', id)
    },
    projects: {
      list: () => inv('projects:list'),
      create: (o) => inv('projects:create', o),
      update: (o) => inv('projects:update', o),
      remove: (id) => inv('projects:delete', id)
    },
    chat: {
      send: (o) => inv('chat:send', o),
      stop: (msgId) => inv('chat:stop', msgId),
      regenerate: (cid) => inv('chat:regenerate', cid),
      editResend: (o) => inv('chat:editResend', o),
      export: (o) => inv('chat:export', o),
      deleteMessage: (msgId) => inv('chat:messageDelete', msgId)
    },
    kb: {
      list: () => inv('kb:list'),
      create: (o) => inv('kb:create', o),
      update: (o) => inv('kb:update', o),
      remove: (id) => inv('kb:delete', id),
      docs: (kbId) => inv('kb:docs', kbId),
      removeDoc: (id) => inv('kb:removeDoc', id),
      import: (o) => inv('kb:import', o),
      rebuild: (o) => inv('kb:rebuild', o),
      search: (o) => inv('kb:search', o)
    },
    models: {
      list: () => inv('models:list'),
      download: (id) => inv('models:download', id),
      remove: (id) => inv('models:remove', id)
    },
    agent: {
      run: (o) => inv('agent:run', o),
      stop: (runId) => inv('agent:stop', runId),
      respond: (o) => inv('agent:respond', o),
      runs: () => inv('agent:runs'),
      calls: (runId) => inv('agent:calls', runId)
    },
    sessions: {
      status: (id) => inv('sessions:status', id),
      list: (o) => inv('sessions:list', o),
      result: (o) => inv('sessions:result', o),
      send: (o) => inv('sessions:send', o),
      wait: (o) => inv('sessions:wait', o)
    },
    events: {
      since: (o) => inv('events:since', o),
      recent: (o) => inv('events:recent', o),
      stats: () => inv('events:stats')
    },
    hooks: {
      meta: () => inv('hooks:meta'),
      list: () => inv('hooks:list'),
      save: (list) => inv('hooks:save', list),
      dryRun: (o) => inv('hooks:dryRun', o)
    },
    sys: {
      clipboardRead: () => inv('sys:clipboardRead'),
      clipboardWrite: (t) => inv('sys:clipboardWrite', t),
      selectionCapture: () => inv('sys:selectionCapture')
    },
    dialog: { pickFiles: (o) => inv('dialog:pickFiles', o), pickDir: () => inv('dialog:pickDir') },
    data: { export: (o) => inv('data:export', o), import: () => inv('data:import') },
    app: {
      showMain: (cid) => inv('app:showMain', cid),
      toggleMain: () => inv('app:toggleMain'),
      quit: () => inv('app:quit'),
      openExternal: (url) => inv('app:openExternal', url),
      info: () => inv('app:info'),
      autostart: () => inv('autostart:get'),
      setAutostart: (v) => inv('autostart:set', v),
      hotkeys: () => inv('hotkeys:get'),
      setHotkeys: (m) => inv('hotkeys:set', m),
      captureStart: () => inv('capture:start')
    },
    on
  })
}

function buildQuick() {
  contextBridge.exposeInMainWorld('api', {
    settings: { all: () => inv('settings:all'), set: (k, v) => inv('settings:set', k, v) },
    conversations: {
      list: () => inv('conversations:list'),
      create: (o) => inv('conversations:create', o),
      messages: (id) => inv('conversations:messages', id)
    },
    chat: { send: (o) => inv('chat:send', o), stop: (msgId) => inv('chat:stop', msgId) },
    clipboard: { write: (t) => inv('sys:clipboardWrite', t) },
    app: { hideQuick: () => inv('win:hide', 'quick'), showMain: (cid) => inv('app:showMain', cid) },
    on
  })
}

function buildBall() {
  contextBridge.exposeInMainWorld('api', {
    activate: () => inv('app:showQuickFromBall'),
    hide: () => inv('win:hide', 'ball')
  })
}

function buildCapture() {
  contextBridge.exposeInMainWorld('api', {
    finish: (rect) => inv('capture:finish', rect),
    cancel: () => inv('capture:cancel')
  })
}

const bridge = bridgeArg()
if (bridge === 'quick') buildQuick()
else if (bridge === 'ball') buildBall()
else if (bridge === 'capture') buildCapture()
else buildMain()
