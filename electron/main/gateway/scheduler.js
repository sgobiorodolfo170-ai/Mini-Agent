// Pure key-scheduler logic: selection + state transitions. No I/O.
function usable(keys, nowTs) {
  return (keys || []).filter(
    (k) =>
      (!k.status || k.status === 'unknown' || k.status === 'ok') &&
      (!k.cooldownUntil || k.cooldownUntil <= nowTs)
  )
}

function pickKey(keys, strategy, excludeIds, nowTs) {
  const candidates = usable(keys, nowTs).filter((k) => !excludeIds.includes(k.id))
  if (!candidates.length) return null
  const sorted = [...candidates].sort((a, b) => (a.sort || 0) - (b.sort || 0))
  if (strategy === 'round_robin') {
    sorted.sort(
      (a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || (a.sort || 0) - (b.sort || 0)
    )
  }
  return sorted[0]
}

// result: 'ok' | 'invalid' | 'rate_limited' | 'retryable' | 'network_error' | 'bad_request'
function applyKeyResult(key, result, nowTs, opts = {}) {
  switch (result) {
    case 'ok':
      return { status: 'ok', cooldownUntil: null, lastError: null, rateCount: 0 }
    case 'invalid':
      return { status: 'invalid', cooldownUntil: null, lastError: '鉴权失败(401/403)' }
    case 'rate_limited': {
      const n = (key.rateCount || 0) + 1
      const base = opts.baseCooldownMs || 60000
      const cd = nowTs + Math.min(base * n, 30 * 60000)
      return { status: 'cooldown', cooldownUntil: cd, lastError: '触发限流(429)', rateCount: n }
    }
    case 'bad_request':
      return {
        status: key.status || 'unknown',
        cooldownUntil: key.cooldownUntil || null,
        lastError: '请求被拒绝(400/404)，检查模型名与参数'
      }
    default:
      return {
        status: key.status || 'unknown',
        cooldownUntil: key.cooldownUntil || null,
        lastError: (opts && opts.lastError) || '临时错误'
      }
  }
}

module.exports = { usable, pickKey, applyKeyResult }
