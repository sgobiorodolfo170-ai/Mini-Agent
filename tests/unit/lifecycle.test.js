import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import {
  shouldCloseToTray,
  isShuttingDown,
  markShuttingDown,
  _resetShuttingDown,
  withTimeout,
  runShutdownSteps,
  createProcessRegistry,
  terminateChild,
  CLOSE_TO_TRAY_KEY
} from '../../electron/main/lifecycle'

function fakeChild({ exitOnSignal } = {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    if (exitOnSignal && signal === exitOnSignal) {
      setImmediate(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
        child.emit('close', null, signal)
      })
    }
    return !exitOnSignal || signal !== 'SIGKILL'
  }
  return child
}

describe('关闭行为设置', () => {
  it('closeToTray 默认开启（缺值/true 都隐藏到托盘）', () => {
    expect(CLOSE_TO_TRAY_KEY).toBe('closeToTray')
    expect(shouldCloseToTray(undefined)).toBe(true)
    expect(shouldCloseToTray(null)).toBe(true)
    expect(shouldCloseToTray(true)).toBe(true)
    expect(shouldCloseToTray('true')).toBe(true)
  })

  it('只有显式 false 才改为退出软件', () => {
    expect(shouldCloseToTray(false)).toBe(false)
  })
})

describe('退出阶段编排', () => {
  it('按声明顺序串行执行', async () => {
    const order = []
    const results = await runShutdownSteps([
      { name: 'a', run: async () => order.push('a') },
      { name: 'b', run: async () => order.push('b') },
      { name: 'c', run: async () => order.push('c') }
    ])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['a', 'ok'],
      ['b', 'ok'],
      ['c', 'ok']
    ])
  })

  it('单步抛错不阻塞后续阶段，错误被记录', async () => {
    const warn = vi.fn()
    const order = []
    const results = await runShutdownSteps(
      [
        {
          name: 'boom',
          run: () => {
            order.push('boom')
            throw new Error('清理失败')
          }
        },
        {
          name: 'next',
          run: async () => order.push('next')
        }
      ],
      { logger: { warn } }
    )
    expect(order).toEqual(['boom', 'next'])
    expect(results[0]).toMatchObject({ name: 'boom', status: 'error', error: '清理失败' })
    expect(results[1].status).toBe('ok')
    expect(warn).toHaveBeenCalledWith('[shutdown] boom: 清理失败')
  })

  it('卡住的阶段只影响该阶段超时，后续仍继续退出', async () => {
    const warn = vi.fn()
    let reached = false
    const started = Date.now()
    const results = await runShutdownSteps(
      [
        { name: 'hang', timeoutMs: 60, run: () => new Promise(() => {}) },
        { name: 'last', run: async () => (reached = true) }
      ],
      { logger: { warn } }
    )
    expect(results[0].status).toBe('timeout')
    expect(results[1].status).toBe('ok')
    expect(reached).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('退出标志供后台任务在检查点中止', () => {
    _resetShuttingDown()
    expect(isShuttingDown()).toBe(false)
    markShuttingDown()
    expect(isShuttingDown()).toBe(true)
    _resetShuttingDown()
  })

  it('withTimeout 透传正常结果与异常', async () => {
    expect(await withTimeout(async () => 'v', 50, 'ok')).toEqual({ status: 'ok', value: 'v' })
    expect(
      await withTimeout(
        async () => {
          throw new Error('e')
        },
        50,
        'bad'
      )
    ).toMatchObject({
      status: 'error',
      error: 'e'
    })
  })
})

describe('子进程登记与逐级回收', () => {
  it('注册表跟踪存活进程，退出后自动注销', async () => {
    const registry = createProcessRegistry({ execFile: vi.fn(), platform: 'linux' })
    const a = fakeChild()
    const b = fakeChild()
    registry.track(a)
    registry.track(b)
    expect(registry.size).toBe(2)
    b.exitCode = 0
    b.emit('close', 0)
    expect(registry.size).toBe(1)
  })

  it('stopAll 逐级升级：先 SIGTERM，仍存活再 SIGKILL', async () => {
    const registry = createProcessRegistry({ execFile: vi.fn(), platform: 'linux' })
    const stubborn = fakeChild({ exitOnSignal: 'SIGKILL' })
    registry.track(stubborn)
    await registry.stopAll({ graceMs: 30, killMs: 300 })
    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(registry.size).toBe(0)
    expect(registry.closing).toBe(true)
  })

  it('优雅退出的子进程只收到 SIGTERM', async () => {
    const registry = createProcessRegistry({ execFile: vi.fn(), platform: 'linux' })
    const polite = fakeChild({ exitOnSignal: 'SIGTERM' })
    registry.track(polite)
    await registry.stopAll({ graceMs: 300, killMs: 300 })
    expect(polite.signals).toEqual(['SIGTERM'])
  })

  it('退出开始后再创建的子进程会被立即回收', async () => {
    const registry = createProcessRegistry({ execFile: vi.fn(), platform: 'linux' })
    await registry.stopAll({ graceMs: 10, killMs: 10 })
    const late = fakeChild({ exitOnSignal: 'SIGTERM' })
    expect(registry.track(late)).toBe(late)
    expect(registry.size).toBe(0)
    expect(late.signals).toContain('SIGTERM')
  })

  it('Windows 下超时进程走 taskkill 整树回收', async () => {
    const execFile = vi.fn((cmd, args, _o, cb) => {
      expect(cmd).toBe('taskkill.exe')
      expect(args).toEqual(['/pid', '4242', '/T', '/F'])
      cb()
    })
    const stuck = fakeChild()
    stuck.kill = () => true // 信号完全无效
    const status = await terminateChild(stuck, {
      execFile,
      platform: 'win32',
      graceMs: 10,
      killMs: 10
    })
    expect(status).toBe('timeout')
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('已退出进程不再发送信号', async () => {
    const exited = fakeChild()
    exited.exitCode = 0
    expect(await terminateChild(exited, { platform: 'linux' })).toBe('exited')
    expect(exited.signals).toEqual([])
  })
})
