// 一次性技术验证:Electron 主进程加载 onnxruntime-node + faiss-node(NAPI ABI 兼容性)
const { app } = require('electron')

app.whenReady().then(() => {
  const out = {
    electron: process.versions.electron,
    node: process.versions.node,
    mainModule: process.mainModule ? process.mainModule.path : null
  }
  try {
    const faiss = require('faiss-node')
    const idx = new faiss.IndexFlatIP(2)
    idx.add([1, 0, 0, 1])
    out.faiss = { ok: true, search: idx.search([1, 0], 1).labels }
  } catch (e) {
    out.faiss = { ok: false, error: String(e && e.message).slice(0, 300) }
  }
  try {
    const ort = require('onnxruntime-node')
    out.ort = {
      ok: true,
      hasSession: typeof ort.InferenceSession === 'function',
      tensor: (() => {
        const t = new ort.Tensor('float32', new Float32Array([1, 2]), [1, 2])
        return t.data[1] === 2
      })()
    }
  } catch (e) {
    out.ort = { ok: false, error: String(e && e.message).slice(0, 300) }
  }
  console.log('SPIKE_NATIVE ' + JSON.stringify(out))
  app.exit(0)
})
