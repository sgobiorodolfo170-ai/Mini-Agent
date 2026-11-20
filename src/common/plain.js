import { toRaw } from 'vue'

// Convert a Vue reactive object into a plain, structured-clone-safe value.
// contextBridge (and ipcRenderer.invoke) cannot serialize reactive Proxies —
// they throw "An object could not be cloned" — so every IPC payload that may
// carry store/ref state must pass through this helper first.
export function plain(x) {
  const raw = toRaw(x)
  if (Array.isArray(raw)) return raw.map((v) => plain(v))
  if (raw && typeof raw === 'object') {
    const out = {}
    for (const k of Object.keys(raw)) out[k] = plain(raw[k])
    return out
  }
  return x
}
