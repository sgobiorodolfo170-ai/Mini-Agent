import { beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'

let db
let conversationId

beforeEach(() => {
  dbm.close()
  db = dbm.open(':memory:')
  conversationId = repos.createConversation(db, {
    title: '项目报销流程',
    systemPrompt: '请遵循公司费用规范'
  }).id
})

describe('消息全文检索', () => {
  it('支持中文子串、标题、系统提示词和工具调用', () => {
    const message = repos.insertMessage(db, {
      conversationId,
      role: 'assistant',
      content: '报销流程怎么走？请提交发票。',
      toolCalls: [{ function: { name: 'read_file' } }]
    })
    expect(repos.searchMessages(db, { query: '报销流程' }).results).toContainEqual(
      expect.objectContaining({ messageId: message.id, matchField: 'content' })
    )
    expect(repos.searchMessages(db, { query: '报销' }).results).toContainEqual(
      expect.objectContaining({ messageId: message.id })
    )
    expect(repos.searchMessages(db, { query: 'read_file' }).results).toContainEqual(
      expect.objectContaining({ messageId: message.id, matchField: 'tool_calls' })
    )
    expect(repos.searchMessages(db, { query: '公司费用' }).results).toContainEqual(
      expect.objectContaining({ conversationId, messageId: null, matchField: 'title' })
    )
  })

  it('更新和软删除后索引保持一致', () => {
    const message = repos.insertMessage(db, {
      conversationId,
      role: 'user',
      content: '旧的报销内容'
    })
    repos.updateMessage(db, message.id, { content: '新的差旅规范' })
    expect(repos.searchMessages(db, { query: '旧的报销' }).results).toEqual([])
    expect(repos.searchMessages(db, { query: '差旅规范' }).results).toContainEqual(
      expect.objectContaining({ messageId: message.id })
    )
    db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(Date.now(), message.id)
    expect(repos.searchMessages(db, { query: '差旅规范' }).results).toEqual([])
  })

  it('转义 FTS 与 LIKE 保留字符并支持分页', () => {
    for (const content of ['abc "quoted" value', 'second value', '100% 完成', 'under_score 文本']) {
      repos.insertMessage(db, { conversationId, role: 'user', content })
    }
    expect(() => repos.searchMessages(db, { query: '" OR 1=1 --' })).not.toThrow()
    expect(repos.searchMessages(db, { query: '100%' }).results).toHaveLength(1)
    expect(repos.searchMessages(db, { query: 'under_score' }).results).toHaveLength(1)
    const first = repos.searchMessages(db, { query: 'value', limit: 1 })
    expect(first.results).toHaveLength(1)
    expect(first.nextCursor).toBe(1)
  })
})
