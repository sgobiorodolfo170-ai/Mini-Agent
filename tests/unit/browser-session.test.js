import { describe, expect, it } from 'vitest'
import { createBrowserSession } from '../../electron/main/agent/browser-session'

function makeFakeWindow({ failLoad = false, hangLoad = false, missingSelector = '' } = {}) {
  const win = {
    destroyed: false,
    loadCalls: [],
    isDestroyed() {
      return this.destroyed
    },
    destroy() {
      this.destroyed = true
    },
    async loadURL(url) {
      win.loadCalls.push(url)
      if (failLoad) throw new Error('ERR_NAME_NOT_RESOLVED')
      if (hangLoad) return new Promise(() => {}) // 模拟挂起，触发外层超时
    },
    webContents: {
      async executeJavaScript(code) {
        if (code.includes('document.title'))
          return { title: '测试页', url: 'https://example.com/x', text: '正文文本' }
        if (code.includes('el.click()'))
          return code.includes(missingSelector) ? '未找到元素' : '已点击'
        if (code.includes('el.value='))
          return code.includes(missingSelector)
            ? '未找到元素'
            : code.includes('if(true)')
              ? '已输入并提交'
              : '已输入'
        return 'ok'
      }
    }
  }
  return win
}

describe('browser session', () => {
  it('navigates, snapshots and reuses the same window', async () => {
    const windows = [makeFakeWindow()]
    const s = createBrowserSession({ windowFactory: () => windows[0] })
    const out = await s.navigate('https://example.com/x')
    expect(out).toContain('标题: 测试页')
    expect(out).toContain('URL: https://example.com/x')
    expect(out).toContain('正文文本')
    await s.navigate('https://example.com/y')
    expect(windows[0].loadCalls).toEqual(['https://example.com/x', 'https://example.com/y'])
    expect(s._getWindow()).toBe(windows[0])
    expect(s.close()).toContain('已关闭')
    expect(windows[0].destroyed).toBe(true)
    expect(s._getWindow()).toBe(null)
  })

  it('rejects non-http URLs', async () => {
    const s = createBrowserSession({ windowFactory: () => makeFakeWindow() })
    await expect(s.navigate('ftp://x')).rejects.toThrow(/http/)
    await expect(s.navigate('')).rejects.toThrow()
  })

  it('maps load failures to errors and load hangs to a timeout hint', async () => {
    const s1 = createBrowserSession({
      windowFactory: () => makeFakeWindow({ failLoad: true })
    })
    await expect(s1.navigate('https://broken.example')).rejects.toThrow(/ERR_NAME/)

    const s2 = createBrowserSession({
      windowFactory: () => makeFakeWindow({ hangLoad: true }),
      loadTimeoutMs: 30
    })
    const r = await s2.navigate('https://slow.example')
    expect(r).toContain('超时')
  })

  it('click / type / close behave, missing elements surface as errors', async () => {
    const s = createBrowserSession({
      windowFactory: () => makeFakeWindow({ missingSelector: 'missing-el' })
    })
    expect(await s.click('#btn')).toBe('已点击')
    await expect(s.click('missing-el')).rejects.toThrow('未找到元素')
    expect(await s.type({ selector: '#input', text: 'hi' })).toBe('已输入')
    expect(await s.type({ selector: '#input', text: 'hi', submit: true })).toBe('已输入并提交')
    await expect(s.type({ selector: 'missing-el', text: 'x' })).rejects.toThrow('未找到元素')
    s.close()
  })

  it('errors when no windowFactory is available', async () => {
    const s = createBrowserSession({})
    await expect(s.navigate('https://example.com')).rejects.toThrow(/不支持/)
  })
})
