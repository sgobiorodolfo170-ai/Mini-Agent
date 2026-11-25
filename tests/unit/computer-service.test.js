import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComputerService } from '../../electron/main/computer/service'

class FakeStdin extends EventEmitter {
  constructor(onWrite) {
    super()
    this.onWrite = onWrite
    this.writes = []
    this.destroyed = false
    this.writableEnded = false
  }

  write(line, callback) {
    this.writes.push(line)
    this.onWrite(JSON.parse(line), this)
    if (callback) callback()
    return true
  }

  end() {
    this.writableEnded = true
  }
}

class FakeChild extends EventEmitter {
  constructor(onWrite) {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdin = new FakeStdin(onWrite)
    this.exitCode = null
    this.signalCode = null
    this.kill = vi.fn(() => {
      this.signalCode = 'SIGTERM'
      return true
    })
  }

  reply(response) {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(response)}\r\n`))
  }

  exit(code = 0) {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code)
    this.emit('close', code)
  }
}

const windowFixture = {
  ref: 'w1',
  name: '记事本',
  processId: 42,
  handle: 1001,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  enabled: true
}

const snapshotFixture = {
  elements: [
    {
      ref: 'e1',
      name: '编辑器',
      automationId: 'TextArea',
      controlType: 'Edit',
      isPassword: false,
      isEnabled: true,
      bounds: { x: 10, y: 20, width: 200, height: 80 },
      patterns: ['Value']
    },
    {
      ref: 'e2',
      name: '密码',
      automationId: 'PasswordBox',
      controlType: 'Edit',
      isPassword: true,
      isEnabled: true,
      bounds: { x: 10, y: 120, width: 200, height: 40 },
      patterns: ['Value']
    }
  ],
  truncated: false
}

function defaultResponse(request, state) {
  if (request.command === 'list_windows') return { ok: true, windows: [windowFixture] }
  if (request.command === 'snapshot') return { ok: true, ...snapshotFixture }
  if (request.command === 'foreground') {
    return {
      ok: true,
      ...(state ? state.foreground : { processId: 42, handle: 1001, name: '记事本' })
    }
  }
  return { ok: true }
}

function harness(options = {}) {
  const enabled = Object.hasOwn(options, 'enabled') ? options.enabled : true
  const now = options.now || (() => 1000)
  const browser = options.browser || null
  const children = []
  const state = { enabled, foreground: { processId: 42, handle: 1001, name: '记事本' } }
  let responder = defaultResponse
  const spawnImpl = vi.fn(() => {
    const child = new FakeChild((request) => {
      const response = responder(request, state)
      if (response && typeof response.then === 'function') {
        response.then((value) => value && child.reply(value))
      } else if (response) {
        child.reply(response)
      }
    })
    children.push(child)
    return child
  })
  const service = createComputerService({
    helperPath: 'computer-uia.exe',
    artifactDir: process.cwd(),
    electronApi: {},
    getSetting: (key) => (key === 'computerUseEnabled' ? state.enabled : null),
    browser,
    spawnImpl,
    now
  })
  return {
    service,
    children,
    state,
    spawnImpl,
    respond(callback) {
      responder = callback
    },
    requests(index = children.length - 1) {
      return children[index].stdin.writes.map((line) => JSON.parse(line))
    }
  }
}

function browserHarness() {
  const state = {
    activeTabId: 'user-tab',
    attachedTabId: 'user-tab',
    tabs: [
      { id: 'user-tab', kind: 'user', destroyed: false, crashed: false, visible: true },
      { id: 'agent-tab', kind: 'agent', destroyed: false, crashed: false, visible: true }
    ]
  }
  const browser = {
    getState: vi.fn(() => state),
    dispatchInput: vi.fn(async (input) => ({ ok: true, input }))
  }
  return { state, browser }
}

const tempDirs = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-computer-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('computer service', () => {
  it('requires computerUseEnabled to be explicitly true for every method', () => {
    for (const enabled of [false, undefined, null, 1, 'true']) {
      const { service, spawnImpl } = harness({ enabled })
      const calls = [
        () => service.listWindows(),
        () => service.snapshot({ processId: 42 }),
        () => service.foreground(),
        () => service.invoke({ ref: 'e1' }),
        () => service.setValue({ ref: 'e1', value: 'secret' }),
        () => service.key({ keys: '{ENTER}', processId: 42 }),
        () => service.input({ type: 'keyDown', key: 'a' }),
        () => service.capture()
      ]
      for (const call of calls)
        expect(call).toThrowError(expect.objectContaining({ code: 'COMPUTER_DISABLED' }))
      expect(spawnImpl).not.toHaveBeenCalled()
      expect(service.stop()).toBe(true)
    }
  })

  it('stops a running helper even after the feature setting is disabled', async () => {
    const { service, state, children } = harness()
    await service.listWindows()
    state.enabled = false
    expect(service.stop()).toBe(true)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    expect(() => service.listWindows()).toThrowError(
      expect.objectContaining({ code: 'COMPUTER_DISABLED' })
    )
    expect(children).toHaveLength(1)
  })

  it('checks the setting again when queued work starts', async () => {
    const { service, state, children, respond } = harness()
    let release
    respond(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const first = service.listWindows()
    const second = service.listWindows()
    await Promise.resolve()
    state.enabled = false
    release({ ok: true, windows: [windowFixture] })
    await expect(first).resolves.toEqual([windowFixture])
    await expect(second).rejects.toMatchObject({ code: 'COMPUTER_DISABLED' })
    expect(children).toHaveLength(1)
  })

  it('keeps one helper process and serializes native requests', async () => {
    const { service, children, requests, respond } = harness()
    let release
    let blocked = false
    respond((request) => {
      if (!blocked) {
        blocked = true
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return defaultResponse(request)
    })

    const first = service.listWindows()
    const second = service.listWindows()
    await Promise.resolve()
    expect(children).toHaveLength(1)
    expect(requests()).toHaveLength(1)

    release({ ok: true, windows: [windowFixture] })
    await expect(first).resolves.toEqual([windowFixture])
    await expect(second).resolves.toEqual([windowFixture])
    expect(children).toHaveLength(1)
    expect(requests()).toEqual([{ command: 'list_windows' }, { command: 'list_windows' }])
  })

  it('times out after 10 seconds, kills the helper and restarts on the next request', async () => {
    vi.useFakeTimers()
    const { service, children, respond } = harness()
    respond(() => null)
    const pending = service.listWindows()
    const rejection = expect(pending).rejects.toMatchObject({ code: 'COMPUTER_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(9999)
    expect(children[0].kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(children[0].kill).toHaveBeenCalledTimes(1)

    respond(defaultResponse)
    await expect(service.listWindows()).resolves.toEqual([windowFixture])
    expect(children).toHaveLength(2)
  })

  it('restarts after a crash and invalidates refs from the old helper', async () => {
    const { service, children } = harness()
    await service.snapshot({ windowRef: 'w1' })
    children[0].exit(1)

    await expect(service.invoke({ ref: 'e1' })).rejects.toMatchObject({
      code: 'COMPUTER_UNKNOWN_REF'
    })
    await expect(service.listWindows()).resolves.toEqual([windowFixture])
    expect(children).toHaveLength(2)
  })

  it('rejects an in-flight request when the helper crashes without poisoning the queue', async () => {
    const { service, children, respond } = harness()
    respond(() => null)
    const pending = service.listWindows()
    const rejection = expect(pending).rejects.toMatchObject({ code: 'COMPUTER_HELPER_EXITED' })
    await Promise.resolve()
    children[0].exit(2)
    await rejection

    respond(defaultResponse)
    await expect(service.listWindows()).resolves.toEqual([windowFixture])
    expect(children).toHaveLength(2)
  })

  it('rejects stdout lines larger than 1MB and recovers with a new helper', async () => {
    const { service, children, respond } = harness()
    respond(() => null)
    const pending = service.listWindows()
    const rejection = expect(pending).rejects.toMatchObject({ code: 'COMPUTER_PROTOCOL_ERROR' })
    await Promise.resolve()
    children[0].stdout.emit('data', Buffer.alloc(1024 * 1024 + 1, 0x61))
    await rejection
    expect(children[0].kill).toHaveBeenCalledTimes(1)

    respond(defaultResponse)
    await expect(service.listWindows()).resolves.toEqual([windowFixture])
    expect(children).toHaveLength(2)
  })

  it('records snapshot refs and requires both foreground processId and handle before invoke', async () => {
    const { service, state, requests } = harness()
    await service.snapshot({ windowRef: 'w1' })

    state.foreground = { processId: 43, handle: 1001, name: '其他窗口' }
    await expect(service.invoke({ ref: 'e1' })).rejects.toMatchObject({
      code: 'COMPUTER_FOREGROUND_MISMATCH'
    })
    state.foreground = { processId: 42, handle: 2002, name: '其他窗口' }
    await expect(service.invoke({ ref: 'e1' })).rejects.toMatchObject({
      code: 'COMPUTER_FOREGROUND_MISMATCH'
    })
    expect(requests().some((request) => request.command === 'invoke')).toBe(false)

    state.foreground = { processId: 42, handle: 1001, name: '记事本' }
    await expect(service.invoke({ ref: 'e1' })).resolves.toMatchObject({ ok: true })
    expect(requests().at(-1)).toEqual({ command: 'invoke', ref: 'e1' })

    await service.snapshot({ processId: 42 })
    await expect(service.invoke({ ref: 'e1' })).resolves.toMatchObject({ ok: true })
  })

  it('rejects password values before foreground lookup and never logs input values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service, requests, state } = harness()
    await service.snapshot({ windowRef: 'w1' })
    const before = requests().length

    await expect(service.setValue({ ref: 'e2', value: 'top-secret' })).rejects.toMatchObject({
      code: 'COMPUTER_PASSWORD_PROTECTED'
    })
    expect(requests()).toHaveLength(before)
    await service.setValue({ ref: 'e1', value: 'private text' })
    state.foreground = { ...state.foreground, focusedIsPassword: true }
    await expect(service.key({ keys: 'secret', processId: 42 })).rejects.toMatchObject({
      code: 'COMPUTER_PASSWORD_PROTECTED'
    })
    state.foreground = { ...state.foreground, focusedIsPassword: false }
    await service.key({ keys: '^{ENTER}', processId: 42 })
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('requires processId for key and validates it against the foreground process', async () => {
    const { service, state, requests, spawnImpl } = harness()
    await expect(service.key({ keys: '{ENTER}' })).rejects.toMatchObject({
      code: 'COMPUTER_INVALID_REQUEST'
    })
    expect(spawnImpl).not.toHaveBeenCalled()

    state.foreground = { processId: 43, handle: 1001, name: '其他窗口' }
    await expect(service.key({ keys: '{ENTER}', processId: 42 })).rejects.toMatchObject({
      code: 'COMPUTER_FOREGROUND_MISMATCH'
    })
    expect(requests().some((request) => request.command === 'key')).toBe(false)

    state.foreground = { processId: 42, handle: 1001, name: '记事本' }
    await expect(service.key({ keys: '{ENTER}', processId: 42 })).resolves.toMatchObject({
      ok: true
    })
    expect(requests().at(-1)).toEqual({ command: 'key', keys: '{ENTER}', processId: 42 })
  })

  it('limits simple native actions to 30 per rolling minute', async () => {
    let at = 1000
    const { service } = harness({ now: () => at })
    for (let i = 0; i < 30; i++) {
      await expect(service.key({ keys: '{TAB}', processId: 42 })).resolves.toMatchObject({
        ok: true
      })
    }
    await expect(service.key({ keys: '{TAB}', processId: 42 })).rejects.toMatchObject({
      code: 'COMPUTER_RATE_LIMITED'
    })

    at += 60000
    await expect(service.key({ keys: '{TAB}', processId: 42 })).resolves.toMatchObject({ ok: true })
  })

  it('captures a screen source to a PNG artifact and returns its dimensions', async () => {
    const dir = tempDir()
    const png = Buffer.from('test-png')
    const getSources = vi.fn(async () => [
      {
        display_id: 'screen:1',
        thumbnail: {
          isEmpty: () => false,
          getSize: () => ({ width: 640, height: 480 }),
          toPNG: () => png
        }
      }
    ])
    const service = createComputerService({
      helperPath: 'computer-uia.exe',
      artifactDir: dir,
      electronApi: { desktopCapturer: { getSources } },
      getSetting: () => true,
      spawnImpl: vi.fn()
    })

    const result = await service.capture()
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'] })
    expect(result.width).toBe(640)
    expect(result.height).toBe(480)
    expect(path.dirname(result.path)).toBe(dir)
    expect(path.basename(result.path)).toMatch(/^computer-\d+-[a-f0-9-]+\.png$/)
    expect(fs.readFileSync(result.path)).toEqual(png)
  })

  it('delegates browser input using only the documented fields', async () => {
    const { browser } = browserHarness()
    const { service, spawnImpl } = harness({ browser })
    const result = await service.input({
      backend: 'browser',
      type: 'mousePressed',
      x: 120,
      y: 80,
      button: 'left',
      clickCount: 2,
      key: 'ignored',
      code: 'ignored',
      text: 'ignored',
      tabId: 'agent-tab',
      extra: 'ignored'
    })

    expect(browser.dispatchInput).toHaveBeenCalledWith({
      type: 'mousePressed',
      x: 120,
      y: 80,
      button: 'left',
      clickCount: 2,
      key: 'ignored',
      code: 'ignored',
      text: 'ignored'
    })
    expect(result).toMatchObject({ ok: true })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('allows browser input only for the current visible user tab', async () => {
    const { state, browser } = browserHarness()
    const { service } = harness({ browser })

    state.attachedTabId = null
    await expect(service.input({ type: 'keyDown', key: 'a' })).rejects.toMatchObject({
      code: 'COMPUTER_BROWSER_TAB_NOT_VISIBLE'
    })
    state.attachedTabId = 'agent-tab'
    await expect(service.input({ type: 'keyDown', key: 'a' })).rejects.toMatchObject({
      code: 'COMPUTER_BROWSER_TAB_NOT_VISIBLE'
    })
    state.attachedTabId = 'user-tab'
    state.tabs[0].visible = false
    await expect(service.input({ type: 'keyDown', key: 'a' })).rejects.toMatchObject({
      code: 'COMPUTER_BROWSER_TAB_NOT_VISIBLE'
    })
    expect(browser.dispatchInput).not.toHaveBeenCalled()

    state.tabs[0].visible = true
    await expect(service.input({ type: 'keyDown', key: 'a', code: 'KeyA' })).resolves.toMatchObject(
      {
        ok: true
      }
    )
  })

  it('shares the action rate limit with browser input', async () => {
    const { browser } = browserHarness()
    const { service } = harness({ browser })
    for (let i = 0; i < 30; i++) await service.input({ type: 'mouseMoved', x: i, y: 0 })
    await expect(service.input({ type: 'mouseMoved', x: 31, y: 0 })).rejects.toMatchObject({
      code: 'COMPUTER_RATE_LIMITED'
    })
    expect(browser.dispatchInput).toHaveBeenCalledTimes(30)
  })

  it('stops the helper, rejects queued and new actions, and clears refs', async () => {
    const { service, children, respond } = harness()
    await service.snapshot({ windowRef: 'w1' })
    let release
    respond(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const inFlight = service.listWindows()
    const inFlightRejection = expect(inFlight).rejects.toMatchObject({ code: 'COMPUTER_STOPPED' })
    const queued = service.listWindows()
    const queuedRejection = expect(queued).rejects.toMatchObject({ code: 'COMPUTER_STOPPED' })
    await Promise.resolve()

    expect(service.stop()).toBe(true)
    expect(children[0].stdin.writableEnded).toBe(true)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    await inFlightRejection
    await queuedRejection
    release({ ok: true, windows: [windowFixture] })

    const calls = [
      () => service.listWindows(),
      () => service.snapshot({ processId: 42 }),
      () => service.foreground(),
      () => service.invoke({ ref: 'e1' }),
      () => service.setValue({ ref: 'e1', value: 'value' }),
      () => service.key({ keys: '{ENTER}', processId: 42 }),
      () => service.input({ type: 'keyDown', key: 'a' }),
      () => service.capture()
    ]
    for (const call of calls)
      expect(call).toThrowError(expect.objectContaining({ code: 'COMPUTER_STOPPED' }))
    expect(service.stop()).toBe(true)
    expect(children).toHaveLength(1)
  })
})
