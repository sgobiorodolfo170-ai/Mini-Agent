const ORCHESTRATION_TOOLS = new Set([
  'run_dispatch',
  'run_plan',
  'run_plan_confirm',
  'run_plan_reject',
  'run_transfer',
  'run_wait',
  'run_status',
  'run_result',
  'run_cancel',
  'spawn_agent',
  'session_create',
  'session_send'
])

const LIMITS = Object.freeze({
  globalSlots: 4,
  directChildren: 2,
  graphNodes: 12,
  graphDepth: 3,
  graphConcurrency: 4,
  delegationDepth: 3
})

function assertClusterEnabled(cluster, toolName) {
  if (cluster) return
  throw new Error(
    toolName ? `Agent 集群未开启，工具 ${toolName} 不可用` : 'Agent 集群未开启，无法派发或移交任务'
  )
}

function filterTools(tools, { cluster = false, mandate = null } = {}) {
  return tools.filter((tool) => {
    if (ORCHESTRATION_TOOLS.has(tool.name) && !cluster) return false
    if (mandate?.deniedTools?.includes(tool.name)) return false
    if (Array.isArray(mandate?.allowedTools) && !mandate.allowedTools.includes(tool.name))
      return false
    return true
  })
}

module.exports = { ORCHESTRATION_TOOLS, LIMITS, assertClusterEnabled, filterTools }
