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
