import { describe, expect, it } from 'vitest'
import { captureSelectedText } from '../../electron/main/sys/selection'

function fakeClipboard(initial = '') {
  return {
    _t: initial,
    readText() {
      return this._t
    },
    writeText(t) {
      this._t = t
    }
  }
}

describe('captureSelectedText', () => {
  it('捕获变化后的剪贴板并随后还原原剪贴板', async () => {
    const clip = fakeClipboard('原本内容')
    const r = await captureSelectedText(clip, {
      waitMs: 5,
      simulate: async () => clip.writeText('选中的文字')
    })
    expect(r).toBe('选中的文字')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(clip.readText()).toBe('原本内容')
  })

  it('剪贴板未变化时返回 null', async () => {
    const clip = fakeClipboard('原本内容')
    const r = await captureSelectedText(clip, { waitMs: 5, simulate: async () => {} })
    expect(r).toBeNull()
  })
})
