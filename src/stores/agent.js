import { defineStore } from 'pinia'

export const useAgentStore = defineStore('agent', {
  state: () => ({
    runs: [],
    activeRunId: null,
    calls: [],
    confirms: []
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
    },
    stopRun(id) {
      return window.api.agent.stop(id)
    },
    respond(requestId, allow, remember) {
      this.confirms = this.confirms.filter((c) => c.requestId !== requestId)
      return window.api.agent.respond({ requestId, allow, remember })
    },
    pushConfirm(c) {
      this.confirms.push(c)
    },
    handleEvent(ev) {
      if (ev.type === 'started' || ev.type === 'done') this.loadRuns()
    }
  }
})
