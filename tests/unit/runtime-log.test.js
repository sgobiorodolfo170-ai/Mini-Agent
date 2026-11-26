import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeLog, redact } from '../../electron/main/runtime-log'

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-runtime-log-'))
})

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 下偶发文件占用，清理失败不影响断言 */
  }
})

describe('运行日志：内存缓冲与过滤', () => {
  it('按时间倒序返回，并支持级别与关键字过滤', () => {
    const log = createRuntimeLog({ dir })
    log.log('info', 'app', '应用启动', { version: '1.2.0' })
    log.log('warn', 'agent', '工具调用超时')
    log.log('error', 'gateway', '请求失败')

    expect(log.list().map((e) => e.message)).toEqual(['请求失败', '工具调用超时', '应用启动'])
    expect(log.list({ level: 'warn' }).map((e) => e.message)).toEqual(['工具调用超时'])
    expect(log.list({ search: '1.2.0' }).map((e) => e.message)).toEqual(['应用启动'])
    expect(log.list({ search: '不存在' })).toEqual([])
    expect(log.list({ limit: 1 }).map((e) => e.message)).toEqual(['请求失败'])
  })

  it('写入后重新创建实例可以读回历史（JSONL 持久化）', () => {
    const first = createRuntimeLog({ dir })
    first.log('info', 'db', '数据库已打开')
    const second = createRuntimeLog({ dir })
    expect(second.list().map((e) => e.message)).toEqual(['数据库已打开'])
  })

  it('清空同时移除内存记录与文件内容', () => {
    const log = createRuntimeLog({ dir })
    log.log('info', 'app', '待清空')
    expect(log.clear()).toBe(true)
    expect(log.list()).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8')).toBe('')
  })

  it('超过文件上限时轮转为 .1 备份，继续写入日志', () => {
    const log = createRuntimeLog({ dir, maxBytes: 240 })
    for (let i = 0; i < 12; i++) log.log('info', 'app', `第 ${i} 条较长的运行日志用于触发轮转`)
    expect(fs.existsSync(path.join(dir, 'runtime.log.1'))).toBe(true)
    expect(log.list()[0].message).toContain('第 11 条')
  })
})

describe('运行日志：脱敏与事件采集', () => {
  it('脱敏 API Key、Bearer 与 JSON secret 字段', () => {
    expect(redact('sk-abcdefghijklmnop')).toBe('sk-***')
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer ***')
    expect(redact('{"secret":"abcdefghijklmnop"}')).toBe('{"secret":"***"}')
  })

  it('跳过流式 delta 与未完成的进度事件，保留完成/失败和任务事件', () => {
    const log = createRuntimeLog({ dir })
    expect(log.event({ name: 'chat:event', payload: { type: 'delta', delta: 'a' } })).toBeNull()
    expect(log.event({ name: 'models:progress', payload: { done: false } })).toBeNull()
    expect(log.event({ name: 'kb:progress', payload: { current: 1 } })).toBeNull()

    expect(log.event({ name: 'run.start', payload: { runId: 'r1' } }).level).toBe('info')
    expect(log.event({ name: 'tool.after', payload: { error: '超时' } }).level).toBe('warn')
    expect(log.event({ name: 'chat:event', payload: { type: 'error' } }).level).toBe('error')
    expect(log.event({ name: 'models:progress', payload: { done: true } }).level).toBe('info')
    expect(log.list()).toHaveLength(4)

    // 聊天正文不进入运行日志，只记录长度等元信息
    const done = log.event({
      name: 'chat:event',
      payload: { type: 'done', conversationId: 'c1', content: '这是不应落盘的回复正文' }
    })
    expect(done.data).not.toContain('不应落盘')
    expect(JSON.parse(done.data).contentLength).toBe(11)
  })

  it('console 捕获仍然调用原方法，恢复后不再记录', () => {
    const log = createRuntimeLog({ dir })
    const target = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const originals = { log: target.log, warn: target.warn, error: target.error }
    const restore = log.installConsoleCapture(target)

    target.log('调度器已启动', { interval: 60 })
    target.warn('配置缺失')
    expect(originals.log).toHaveBeenCalledWith('调度器已启动', { interval: 60 })
    expect(log.list({ search: '调度器' })[0]).toMatchObject({
      level: 'info',
      scope: 'console',
      message: '调度器已启动'
    })
    expect(log.list({ search: '配置缺失' })[0].level).toBe('warn')

    restore()
    target.error('恢复后的错误')
    expect(log.list({ search: '恢复后的错误' })).toEqual([])
  })
})

describe('运行日志：持久化健康诊断', () => {
  it('exposes healthy and disabled states, including through stats', () => {
    const log = createRuntimeLog({ dir })
    log.log('info', 'app', '正常写入')
    expect(log.getPersistenceHealth()).toMatchObject({
      enabled: true,
      status: 'healthy',
      lastError: null,
      failureCount: 0,
      diagnosticsEmitted: 0
    })
    expect(log.stats().persistence).toEqual(log.getPersistenceHealth())

    const memoryOnly = createRuntimeLog()
    memoryOnly.log('info', 'app', '仅内存')
    expect(memoryOnly.getPersistenceHealth()).toMatchObject({
      enabled: false,
      status: 'disabled',
      failureCount: 0
    })
    expect(memoryOnly.list()[0].message).toBe('仅内存')
  })

  it('reports mkdir failures once, rate-limits repeats, and never exposes error contents', () => {
    let at = 1000
    const secret = 'sk-abcdefghijklmnop'
    const body = 'private-message-body'
    const fsImpl = {
      ...fs,
      mkdirSync() {
        const error = new Error(`${body} ${secret}`)
        error.code = 'EACCES'
        throw error
      }
    }
    const log = createRuntimeLog({ dir, now: () => at, fsImpl })

    for (let i = 0; i < 3; i++) {
      at += 1000
      expect(log.log('info', 'app', `业务日志 ${i}`).message).toBe(`业务日志 ${i}`)
    }
    expect(log.list().filter((e) => e.scope === 'app')).toHaveLength(3)
    expect(log.list().filter((e) => e.scope === 'runtime-log.persistence')).toHaveLength(1)
    expect(log.getPersistenceHealth()).toMatchObject({
      enabled: true,
      status: 'degraded',
      lastError: {
        operation: 'mkdir',
        code: 'EACCES',
        reason: '无法创建运行日志目录',
        at: 4000
      },
      failureCount: 3,
      consecutiveFailures: 3,
      diagnosticsEmitted: 1,
      diagnosticsSuppressed: 2
    })
    expect(JSON.stringify(log.list()) + JSON.stringify(log.getPersistenceHealth())).not.toContain(
      secret
    )
    expect(JSON.stringify(log.list()) + JSON.stringify(log.getPersistenceHealth())).not.toContain(
      body
    )

    at += 60000
    log.log('info', 'app', '限流窗口后的业务日志')
    expect(log.getPersistenceHealth()).toMatchObject({
      failureCount: 4,
      diagnosticsEmitted: 2,
      diagnosticsSuppressed: 2
    })
  })

  it('keeps memory entries when append fails and reports a stable error code', () => {
    const fsImpl = {
      ...fs,
      appendFileSync() {
        const error = new Error('append failed with private content')
        error.code = 'ENOSPC'
        throw error
      }
    }
    const log = createRuntimeLog({ dir, fsImpl })
    const entry = log.log('warn', 'agent', '工具调用失败')

    expect(log.list().some((e) => e.id === entry.id)).toBe(true)
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      lastError: { operation: 'append', code: 'ENOSPC', reason: '无法追加运行日志' },
      failureCount: 1
    })
    expect(JSON.stringify(log.list())).not.toContain('private content')
  })

  it('surfaces read errors during startup without preventing memory logging', () => {
    fs.writeFileSync(path.join(dir, 'runtime.log'), '{"id":"old"}\n', 'utf8')
    const fsImpl = {
      ...fs,
      readFileSync() {
        const error = new Error('read failed')
        error.code = 'EIO'
        throw error
      }
    }
    const log = createRuntimeLog({ dir, fsImpl })
    expect(log.getPersistenceHealth().lastError).toMatchObject({
      operation: 'read',
      code: 'EIO',
      reason: '无法读取运行日志历史'
    })

    log.log('info', 'app', '读取失败后仍可使用')
    expect(log.list({ search: '读取失败后仍可使用' })).toHaveLength(1)
  })

  it('reports damaged JSONL without retaining or echoing the damaged line', () => {
    const valid = JSON.stringify({
      id: 'valid',
      at: 1,
      level: 'info',
      scope: 'app',
      message: '有效历史',
      data: null
    })
    const damaged = 'not-json sk-abcdefghijklmnop private-body'
    fs.writeFileSync(path.join(dir, 'runtime.log'), `${valid}\n${damaged}\n`, 'utf8')

    const log = createRuntimeLog({ dir })
    expect(log.list({ search: '有效历史' })).toHaveLength(1)
    expect(log.getPersistenceHealth().lastError).toMatchObject({
      operation: 'read',
      code: 'INVALID_JSONL',
      reason: '运行日志历史包含损坏行'
    })
    expect(JSON.stringify(log.list()) + JSON.stringify(log.getPersistenceHealth())).not.toContain(
      'private-body'
    )
    expect(JSON.stringify(log.list())).not.toContain('sk-')
  })

  it('keeps rotate failures degraded until a complete rotation and append succeed', () => {
    let at = 1000
    let failRename = true
    const old = JSON.stringify({
      id: 'old',
      at: 1,
      level: 'info',
      scope: 'app',
      message: 'x'.repeat(160),
      data: null
    })
    fs.writeFileSync(path.join(dir, 'runtime.log'), old + '\n', 'utf8')
    const fsImpl = {
      ...fs,
      renameSync(...args) {
        if (failRename) {
          const error = new Error('rename failed')
          error.code = 'EPERM'
          throw error
        }
        return fs.renameSync(...args)
      }
    }
    const log = createRuntimeLog({ dir, maxBytes: 120, now: () => at, fsImpl })
    at = 2000
    log.log('info', 'app', '轮转失败后的新日志')

    // 普通 append 成功只更新 lastSuccessAt，不能清除轮转失败造成的降级。
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      lastError: { operation: 'rotate', code: 'EPERM', reason: '无法轮转运行日志' },
      lastSuccessAt: 2000,
      recoveredAt: null,
      consecutiveFailures: 1
    })
    expect(log.list({ search: '轮转失败后的新日志' })).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8')).toContain('轮转失败后的新日志')

    failRename = false
    at = 3000
    log.log('info', 'app', '完整轮转后的新日志')
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'healthy',
      lastError: { operation: 'rotate', code: 'EPERM' },
      recoveredAt: 3000,
      consecutiveFailures: 0,
      failureCount: 1
    })
    expect(fs.readFileSync(path.join(dir, 'runtime.log.1'), 'utf8')).toContain('轮转失败后的新日志')
    const active = fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8')
    expect(active).toContain('完整轮转后的新日志')
    expect(active).not.toContain('轮转失败后的新日志')
  })

  it('does not recover from an incomplete retry rotation until a later full rotation', () => {
    let at = 1000
    let renameCalls = 0
    let appendCalls = 0
    const old = JSON.stringify({
      id: 'old',
      at: 1,
      level: 'info',
      scope: 'app',
      message: 'x'.repeat(160),
      data: null
    })
    fs.writeFileSync(path.join(dir, 'runtime.log'), old + '\n', 'utf8')
    const fsImpl = {
      ...fs,
      renameSync(...args) {
        renameCalls += 1
        if (renameCalls === 1) {
          const error = new Error('rename failed')
          error.code = 'EPERM'
          throw error
        }
        return fs.renameSync(...args)
      },
      appendFileSync(...args) {
        appendCalls += 1
        if (appendCalls === 2) {
          const error = new Error('append failed after rotation')
          error.code = 'EIO'
          throw error
        }
        return fs.appendFileSync(...args)
      }
    }
    const log = createRuntimeLog({ dir, maxBytes: 120, now: () => at, fsImpl })

    at = 2000
    log.log('info', 'app', '第一次轮转失败')
    at = 3000
    log.log('info', 'app', '重试轮转后追加失败')
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      lastError: { operation: 'append', code: 'EIO' },
      recoveredAt: null
    })
    expect(fs.existsSync(path.join(dir, 'runtime.log'))).toBe(false)

    at = 4000
    log.log('info', 'app', '不完整轮转后的普通追加')
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      lastSuccessAt: 4000,
      recoveredAt: null,
      consecutiveFailures: 2
    })

    at = 5000
    log.log('info', 'app', '再次完整轮转后恢复')
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'healthy',
      recoveredAt: 5000,
      consecutiveFailures: 0
    })
  })

  it('keeps old memory and disk logs when clear fails, then treats successful clear as recovery', () => {
    let at = 1000
    let failWrite = false
    const old = JSON.stringify({
      id: 'old',
      at: 1,
      level: 'info',
      scope: 'app',
      message: '必须保留的旧日志',
      data: null
    })
    fs.writeFileSync(path.join(dir, 'runtime.log'), old + '\n', 'utf8')
    const fsImpl = {
      ...fs,
      renameSync() {
        const error = new Error('rename failed')
        error.code = 'EPERM'
        throw error
      },
      writeFileSync(...args) {
        if (failWrite) {
          const error = new Error('write failed')
          error.code = 'EACCES'
          throw error
        }
        return fs.writeFileSync(...args)
      }
    }
    const log = createRuntimeLog({ dir, maxBytes: 120, now: () => at, fsImpl })
    at = 2000
    log.log('info', 'app', '轮转失败后的日志')
    const diskBefore = fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8')
    const bytesBefore = log.stats().bytes

    failWrite = true
    at = 3000
    expect(log.clear()).toBe(false)
    expect(log.list({ search: '必须保留的旧日志' })).toHaveLength(1)
    expect(log.list({ search: '轮转失败后的日志' })).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8')).toBe(diskBefore)
    expect(log.stats().bytes).toBe(bytesBefore)
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      lastError: { operation: 'write', code: 'EACCES' },
      recoveredAt: null
    })

    failWrite = false
    at = 4000
    expect(log.clear()).toBe(true)
    expect(log.list()).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8')).toBe('')
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'healthy',
      recoveredAt: 4000,
      consecutiveFailures: 0
    })
  })

  it('recovers health after persistence succeeds again', () => {
    let at = 1000
    let fail = true
    const fsImpl = {
      ...fs,
      appendFileSync(file, line, encoding) {
        if (fail) {
          const error = new Error('disk unavailable')
          error.code = 'EIO'
          throw error
        }
        return fs.appendFileSync(file, line, encoding)
      }
    }
    const log = createRuntimeLog({ dir, now: () => at, fsImpl })
    log.log('info', 'app', '失败')
    expect(log.getPersistenceHealth().status).toBe('degraded')

    fail = false
    at += 1000
    log.log('info', 'app', '恢复')
    expect(log.getPersistenceHealth()).toMatchObject({
      status: 'healthy',
      lastError: { operation: 'append', code: 'EIO' },
      lastSuccessAt: 2000,
      recoveredAt: 2000,
      consecutiveFailures: 0,
      failureCount: 1
    })
  })
})
