const { desktopCapturer, screen } = require('electron')

// Capture a region (CSS px, relative to the display containing the cursor) and return a data URL.
async function captureRegion(rect) {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const dpr = display.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * dpr),
      height: Math.round(display.size.height * dpr)
    }
  })
  if (!sources.length) throw new Error('无可用屏幕源')
  let src = sources.find((s) => s.display_id === String(display.id))
  if (!src) {
    src = sources.sort(
      (a, b) =>
        (b.thumbnail.getSize().width * b.thumbnail.getSize().height || 0) -
        (a.thumbnail.getSize().width * a.thumbnail.getSize().height || 0)
    )[0]
  }
  const img = src.thumbnail
  const size = img.getSize()
  const x = Math.max(0, Math.min(Math.round(rect.x * dpr), size.width - 1))
  const y = Math.max(0, Math.min(Math.round(rect.y * dpr), size.height - 1))
  const w = Math.max(1, Math.min(Math.round(rect.width * dpr), size.width - x))
  const h = Math.max(1, Math.min(Math.round(rect.height * dpr), size.height - y))
  const cropped = img.crop({ x, y, width: w, height: h })
  return cropped.toDataURL()
}

module.exports = { captureRegion }
