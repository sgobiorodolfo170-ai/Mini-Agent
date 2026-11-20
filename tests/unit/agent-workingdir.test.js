import { beforeEach, describe, expect, it } from 'vitest'
import os from 'os'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import { resolveWorkingDir } from '../../electron/main/agent'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

// 任务模式命令执行目录：会话所属项目 → 旧全局设置（遗留）→ 用户主目录
describe('agent workingDir resolution', () => {
  it('uses the conversation project path first', () => {
    const db = dbm.get()
    const p = repos.createProject(db, { name: 'P', path: 'C:\\proj' })
    const cid = repos.createConversation(db, { projectId: p.id }).id
    expect(resolveWorkingDir(db, cid, { agentWorkingDir: 'C:\\legacy' })).toBe('C:\\proj')
  })

  it('falls back to legacy setting then homedir', () => {
    const db = dbm.get()
    const cid = repos.createConversation(db, {}).id
    expect(resolveWorkingDir(db, cid, { agentWorkingDir: 'C:\\legacy' })).toBe('C:\\legacy')
    expect(resolveWorkingDir(db, cid, {})).toBe(os.homedir())
    expect(resolveWorkingDir(db, null, {})).toBe(os.homedir())
  })

  it('falls back when the project is gone or conversation missing', () => {
    const db = dbm.get()
    const p = repos.createProject(db, { name: 'P', path: 'C:\\proj' })
    const cid = repos.createConversation(db, { projectId: p.id }).id
    repos.softDeleteProject(db, p.id)
    expect(resolveWorkingDir(db, cid, {})).toBe(os.homedir())
    expect(resolveWorkingDir(db, '不存在', {})).toBe(os.homedir())
  })
})
