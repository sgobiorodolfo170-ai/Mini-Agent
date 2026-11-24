import { defineStore } from 'pinia'
import { plain } from '../common/plain'

// 项目工作目录：会话分类 + Agent 任务模式命令执行目录
export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: []
  }),
  getters: {
    byId(state) {
      return (id) => state.projects.find((p) => p.id === id) || null
    }
  },
  actions: {
    async load() {
      this.projects = await window.api.projects.list()
    },
    async create(o) {
      const p = await window.api.projects.create(plain(o))
      await this.load()
      return p
    },
    async update(id, patch) {
      const p = await window.api.projects.update({ id, patch: plain(patch) })
      await this.load()
      return p
    },
    async remove(id) {
      await window.api.projects.remove(id)
      await this.load()
    },
    createIndex(id, rebuild = true) {
      return window.api.projects.createIndex({ projectId: id, rebuild })
    }
  }
})
