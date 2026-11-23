const { spawn } = require('child_process')
const { processRegistry } = require('../lifecycle')

// 划词 capture: simulate Ctrl+C on the focused window, then diff the clipboard.
// `simulate` is injectable so tests can stub the keystroke.
function simulateCopy() {
  return new Promise((resolve) => {
    try {
      const p = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-STA',
          '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"
        ],
        { windowsHide: true }
      )
      processRegistry.track(p)
      p.on('error', () => resolve())
      p.on('close', () => resolve())
    } catch {
      resolve()
    }
  })
}

async function captureSelectedText(clipboard, { waitMs = 450, simulate = simulateCopy } = {}) {
  const before = clipboard.readText()
  await simulate()
  await new Promise((r) => setTimeout(r, waitMs))
  const after = clipboard.readText()
  if (after && after !== before) {
    // Restore the user's previous clipboard so we don't clobber it.
    setTimeout(() => {
      try {
        clipboard.writeText(before)
      } catch {
        /* ignore */
      }
    }, 150)
    return after
  }
  return null
}

module.exports = { captureSelectedText, simulateCopy }
