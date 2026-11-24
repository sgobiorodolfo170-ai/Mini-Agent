import { defineStore } from 'pinia'
import { plain } from '../common/plain'

export const useKbStore = defineStore('kb', {
  state: () => ({
    kbs: [],
    activeKbId: null,
    docs: [],
    progress: null,
    searchResults: [],
    lastSearch: null, // { kbId, query }：切库后用于隔离展示（F16）
    filterText: ''
  }),
  getters: {
    activeKb(state) {
      return state.kbs.find((k) => k.id === state.activeKbId) || null
    },
    visibleKbs(state) {
      const q = state.filterText.trim().toLowerCase()
      if (!q) return state.kbs
      return state.kbs.filter((k) => (k.name || '').toLowerCase().includes(q))
    },
    // 检索结果只属于发起检索的库（F16：A 库结果不展示成 B 库结果）
    activeSearchResults(state) {
      if (!state.lastSearch || state.lastSearch.kbId !== state.activeKbId) return []
      return state.searchResults
    }
  },
  actions: {
    async load() {
      this.kbs = await window.api.kb.list()
    },
    async select(id) {
      this.activeKbId = id
      this.docs = await window.api.kb.docs(id)
      const active = this.kbs.find((k) => k.id === id)
      if (active) {
        active.stats = {
          docs: this.docs.length,
          chunks: this.docs.reduce((sum, doc) => sum + Number(doc.chunkCount || 0), 0)
        }
      }
      this.searchResults = []
      this.lastSearch = null
    },
    async create(form) {
      const kb = await window.api.kb.create(plain(form))
      await this.load()
      if (kb) await this.select(kb.id)
      return kb
    },
    async update(id, patch) {
      await window.api.kb.update({ id, patch: plain(patch) })
      await this.load()
    },
    async remove(id) {
      await window.api.kb.remove(id)
      this.kbs = this.kbs.filter((k) => k.id !== id)
      if (this.activeKbId === id) {
        this.activeKbId = null
        this.docs = []
      }
    },
    importDocs(paths) {
      if (!this.activeKbId) return
      return window.api.kb.import({ kbId: this.activeKbId, paths: plain(paths) })
    },
    rebuild() {
      if (!this.activeKbId) return
      return window.api.kb.rebuild({ kbId: this.activeKbId })
    },
    // 删除成功后同步本地文档列表与库统计（F08），失败保留原行并抛错给调用方提示
    async removeDoc(id) {
      await window.api.kb.removeDoc(id)
      this.docs = this.docs.filter((d) => d.id !== id)
      await this.load()
      return true
    },
    async search(query) {
      if (!this.activeKbId) return []
      const r = await window.api.kb.search({ kbId: this.activeKbId, query })
      this.searchResults = (r && r.blocks) || []
      this.lastSearch = { kbId: this.activeKbId, query }
      return this.searchResults
    },
    handleProgress(p) {
      this.progress = p
      if (p && p.done) {
        setTimeout(async () => {
          this.progress = null
          await this.load()
          if (this.activeKbId) this.docs = await window.api.kb.docs(this.activeKbId)
        }, 800)
      }
    }
  }
})
