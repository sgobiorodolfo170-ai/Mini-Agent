// Vector search: cosine similarity over stored Float32 vectors (personal scale, brute force).
function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d ? dot / d : 0
}

function topK(queryVec, rows, { k = 5, minScore = 0.2 } = {}) {
  const scored = []
  for (const r of rows) {
    if (!r.vector || r.vector.length !== queryVec.length) continue
    const score = cosine(queryVec, r.vector)
    if (score >= minScore) scored.push({ chunkId: r.chunkId, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

module.exports = { cosine, topK }
