import { defineStore } from 'pinia'

export const useComposerStore = defineStore('composer', {
  state: () => ({
    text: '',
    focusRevision: 0
  }),
  actions: {
    append(text) {
      const value = String(text || '').trim()
      if (!value) return
      this.text = this.text.trimEnd() ? `${this.text.trimEnd()}\n\n${value}` : value
      this.focusRevision += 1
    },
    clear() {
      this.text = ''
    },
    restoreSent(content) {
      const draft = this.text.trim()
      this.text = draft ? `${content}\n\n${draft}` : content
    }
  }
})
