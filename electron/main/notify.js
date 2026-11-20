// Broadcast helper: main process pushes events to every renderer window.
// Backed by globalThis for the same reason as store/db.js.

function setBroadcaster(fn) {
  globalThis.__miniagentBroadcaster = fn
}

function broadcast(channel, payload) {
  const fn = globalThis.__miniagentBroadcaster
  if (fn) fn(channel, payload)
}

module.exports = { setBroadcaster, broadcast }
