// Agent 运行与 sessions 模块之间的桥接层。
//
// 单独成模块的原因：参数透传与目标会话归属校验是纯逻辑，不依赖 Electron，
// 可以单测覆盖。index.js 只负责注入当前运行上下文。
function createSessionBridge({ db, repos, sessionsApi, conversationId, runId, state }) {
  if (!db || !repos || !sessionsApi) throw new Error('session-bridge 缺少依赖')
  const runState = state || {}

  return {
    createSession: (opts = {}) =>
      sessionsApi.createSession({
        ...opts,
        parentConversationId: conversationId,
        runId
      }),

    sendToSession: ({
      conversationId: targetId,
      content,
      mode,
      controlMode,
      acceptancePolicy,
      idempotencyKey
    } = {}) => {
      // 只允许向「本运行派生的子会话」或本会话发送，避免跨会话乱发
      const target = repos.getConversation(db, targetId)
      if (!target) throw new Error('目标会话不存在')
      const isChild = target.parentId === conversationId
      const isSelf = target.id === conversationId
      if (!isChild && !isSelf) throw new Error('只能向本会话或其派生的子会话发送提示词')

      return sessionsApi.sendToSession({
        conversationId: targetId,
        content,
        permission: mode === 'agent' ? runState.permission : 'default',
        cluster: !!runState.cluster,
        runId,
        controlMode: controlMode || 'delegated',
        // 父运行的授权快照随子任务下传；没有快照时由 startAgentRun 收敛到受限默认。
        mandate: runState.mandate || null,
        acceptancePolicy: acceptancePolicy || null,
        idempotencyKey: idempotencyKey || null
      })
    },

    getSessionStatus: (opts) => sessionsApi.getSessionStatus(opts),
    waitForSession: (opts) => sessionsApi.waitForSession(opts),
    getSessionResult: (opts) => sessionsApi.getSessionResult(opts),
    listSessions: (opts) => sessionsApi.listSessions({ ...opts, runId })
  }
}

module.exports = { createSessionBridge }
