import { defineStore } from 'pinia'
import { plain } from '../common/plain'

export const useAgentStore = defineStore('agent', {
  state: () => ({
    runs: [],
    activeRunId: null,
    calls: [],
    confirms: [],
    graph: null,
    recovery: null
  }),
  getters: {
    activeRun(state) {
      return state.runs.find((r) => r.id === state.activeRunId) || null
    }
  },
  actions: {
    async loadRuns() {
      this.runs = await window.api.agent.runs()
    },
    async select(id) {
      this.activeRunId = id
      this.calls = await window.api.agent.calls(id)
      await this.loadGraph(id)
      await this.loadRecovery(id)
    },
    async loadRecovery(id) {
      this.recovery = window.api.agent.recovery && id ? await window.api.agent.recovery(id) : null
      return this.recovery
    },
    async continueInterrupted(id, reason = '') {
      const run = await window.api.agent.resumeInterrupted({ runId: id, reason })
      await this.loadRuns()
      await this.select(id)
      return run
    },
    async retryInterrupted(id, reason = '') {
      const run = await window.api.agent.retryInterrupted({ runId: id, reason })
      await this.loadRuns()
      await this.select(run.runId)
      return run
    },
    async loadGraph(id) {
      this.graph = window.api.agent.graph && id ? await window.api.agent.graph(id) : null
      return this.graph
    },
    async mutateGraph(input) {
      const graph = await window.api.agent.mutateGraph(plain(input))
      this.graph = graph
      await this.loadRuns()
      return graph
    },
    stopRun(id) {
      // 本地先清掉该运行的确认卡：主进程随后会广播 confirmCancel，
      // 但主窗隐藏时事件不可见，这里保证点击停止立即生效
      this.clearConfirms({ runId: id })
      return window.api.agent.stop(id)
    },
    respond(requestId, allow, remember) {
      this.confirms = this.confirms.filter((c) => c.requestId !== requestId)
      return window.api.agent.respond({ requestId, allow, remember })
    },
    async decideAcceptance(runId, decision, reason = '') {
      const run = await window.api.agent.acceptanceDecide({ runId, decision, reason })
      await this.loadRuns()
      return run
    },
    pushConfirm(c) {
      this.confirms.push(c)
    },
    // 停止运行或确认超时后，按 runId / requestId 清掉僵尸确认卡
    clearConfirms({ runId, requestId, requestIds } = {}) {
      const ids = new Set(requestIds || (requestId ? [requestId] : []))
      this.confirms = this.confirms.filter((c) => {
        if (ids.size && ids.has(c.requestId)) return false
        if (runId && c.runId === runId) return false
        return true
      })
    },
    handleEvent(ev) {
      if (['queued', 'started', 'state', 'done', 'acceptance', 'workspace'].includes(ev.type))
        this.loadRuns()
      if (['state', 'done', 'acceptance', 'graph'].includes(ev.type) && this.activeRunId)
        this.loadGraph(this.activeRunId)
      if (ev.type === 'done' && this.activeRunId) this.loadRecovery(this.activeRunId)
      // 运行结束（含被停止/出错）时，该运行遗留的确认卡一律失效
      if (ev.type === 'done' && ev.runId) this.clearConfirms({ runId: ev.runId })
    }
  }
})
