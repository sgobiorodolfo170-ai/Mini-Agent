import { defineStore } from 'pinia'

// 临时会话的跨组件暂存：主会话消息里选中的文字以附件形式进入临时会话输入框。
// 附件只存在渲染层内存中，随发送带入请求，不写入主会话历史。
export const useSideTaskStore = defineStore('sideTask', {
  state: () => ({
    attachments: [],
    focusRevision: 0
  }),
  actions: {
    addSelection(text) {
      const value = String(text || '').trim()
      if (!value) return null
      const attachment = {
        id: `side-selection-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'text',
        content: value,
        preview: value.length > 80 ? `${value.slice(0, 80)}…` : value
      }
      this.attachments.push(attachment)
      this.focusRevision += 1
      return attachment
    },
    removeAttachment(id) {
      this.attachments = this.attachments.filter((a) => a.id !== id)
    },
    takeAttachments() {
      const list = this.attachments
      this.attachments = []
      return list
    },
    clear() {
      this.attachments = []
    }
  }
})
