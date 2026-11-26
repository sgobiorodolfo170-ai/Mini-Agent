import { defineStore } from 'pinia'
import { plain } from '../common/plain'

export const useAgentStore = defineStore('agent', {
  state: () => ({
    runs: [],
    activeRunId: null,
    calls: [],
    confirms: [],
    graph: null,
    plans: [],
    queue: null,
    recovery: null
  }),
  getters: {
    activeRun(state) {
      return state.runs.find((r) => r.id === state.activeRunId) || null
    },
    runTree(state) {
      const byParent = new Map()
      for (const run of state.runs) {
        const key = run.parent_run_id || run.parentRunId || run.trace_id || run.traceId || run.id
        const list = byParent.get(key) || []
        list.push(run)
        byParent.set(key, list)
      }
      return byParent
    }
  },
  actions: {
    async loadRuns() {
      this.runs = await window.api.agent.runs()
      if (window.api.agent.queue) this.queue = await window.api.agent.queue()
    },
    async select(id) {
      this.activeRunId = id
      this.calls = await window.api.agent.calls(id)
      await this.loadGraph(id)
      await this.loadPlans(id)
      await this.loadRecovery(id)
    },
    async loadPlans(id) {
      this.plans = window.api.agent.plans ? await window.api.agent.plans(id) : []
      return this.plans
    },
    async confirmPlan(planId, etag) {
      const plan = await window.api.agent.confirmPlan({ planId, etag })
      await this.loadRuns()
      await this.loadPlans(plan.parentRunId)
      await this.loadGraph(plan.parentRunId)
      return plan
    },
    async rejectPlan(planId, etag) {
      const plan = await window.api.agent.rejectPlan({ planId, etag })
      await this.loadPlans(plan.parentRunId)
      return plan
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
    async saveGraphLayout(input) {
      const result = await window.api.agent.saveGraphLayout(plain(input))
      if (this.graph) {
        this.graph.layout = result.layout
        this.graph.viewport = result.viewport
        this.graph.layoutRevision = result.layoutRevision
      }
      return result
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
      if (
        ['queued', 'started', 'state', 'done', 'acceptance', 'workspace', 'plan'].includes(ev.type)
      )
        this.loadRuns()
      if (ev.type === 'plan' && this.activeRunId) this.loadPlans(this.activeRunId)
      if (['state', 'done', 'acceptance', 'graph'].includes(ev.type) && this.activeRunId)
        this.loadGraph(this.activeRunId)
      if (ev.type === 'done' && this.activeRunId) this.loadRecovery(this.activeRunId)
      // 运行结束（含被停止/出错）时，该运行遗留的确认卡一律失效
      if (ev.type === 'done' && ev.runId) this.clearConfirms({ runId: ev.runId })
    }
  }
})
