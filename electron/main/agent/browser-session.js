// Offscreen Electron BrowserWindow automation for the browser_* tools.
// windowFactory is injected so unit tests can supply a fake window.
const LOAD_TIMEOUT_MS = 30000

function createBrowserSession({ windowFactory, loadTimeoutMs = LOAD_TIMEOUT_MS } = {}) {
  let win = null

  function assertHttp(url) {
    const u = new URL(String(url || ''))
    if (!/^https?:$/.test(u.protocol)) throw new Error('仅支持 http(s) URL')
    return u.toString()
  }

  async function ensure() {
    if (win && !win.isDestroyed()) return win
    if (!windowFactory) throw new Error('浏览器会话不可用（当前环境不支持）')
    win = windowFactory({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    return win
  }

  async function evalInPage(code) {
    const w = await ensure()
    if (!w.webContents || typeof w.webContents.executeJavaScript !== 'function')
      throw new Error('浏览器窗口不支持执行脚本')
    return w.webContents.executeJavaScript(code)
  }

  async function loadWithTimeout(w, url) {
    let timer = null
    try {
      await Promise.race([
        w.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('页面加载超时')), loadTimeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function snapshot() {
    const info = await evalInPage(
      '({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "" })'
    )
    return `标题: ${info.title || '(无)'}\nURL: ${info.url}\n\n${String(info.text || '').slice(0, 20000) || '(空页面)'}`
  }

  async function navigate(url) {
    const target = assertHttp(url)
    const w = await ensure()
    try {
      await loadWithTimeout(w, target)
    } catch (e) {
      if (String(e.message).includes('超时')) return '页面加载超时，可稍后重试或改用 web_fetch'
      throw e
    }
    return snapshot()
  }

  async function click(selector) {
    const sel = JSON.stringify(String(selector || ''))
    const ok = await evalInPage(
      `(function(){const el=document.querySelector(${sel});if(!el)return"未找到元素";el.click();return"已点击"})()`
    )
    if (ok !== '已点击') throw new Error(ok)
    return ok
  }

  async function type({ selector, text, submit }) {
    const sel = JSON.stringify(String(selector || ''))
    const val = JSON.stringify(String(text == null ? '' : text))
    const code = `(function(){
      const el=document.querySelector(${sel});
      if(!el)return"未找到元素";
      el.focus();
      el.value=${val};
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      if(${submit ? 'true' : 'false'}){
        const f=el.closest&&el.closest('form');
        if(f&&f.requestSubmit){f.requestSubmit();return"已输入并提交"}
        return"已输入（未找到表单，未提交）"
      }
      return"已输入"
    })()`
    const ok = await evalInPage(code.replace(/\s+/g, ' '))
    if (ok === '未找到元素') throw new Error(ok)
    return ok
  }

  function close() {
    if (win && !win.isDestroyed()) win.destroy()
    win = null
    return '浏览器已关闭'
  }

  return { navigate, click, type, close, _getWindow: () => win }
}

module.exports = { createBrowserSession }
