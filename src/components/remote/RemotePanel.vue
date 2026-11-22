<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRemoteStore } from '../../stores/remote'
import { useUiStore } from '../../stores/ui'

const remote = useRemoteStore()
const ui = useUiStore()
const selectedHost = ref('')
const selectedPort = ref(37651)

onMounted(async () => {
  await remote.refresh()
  if (remote.host) selectedHost.value = remote.host
  else if (remote.networkInterfaces.length) selectedHost.value = remote.networkInterfaces[0].address
  if (remote.port) selectedPort.value = remote.port
})

const hasPlain = computed(() => remote.transport === 'restricted_plain')

async function toggle() {
  try {
    if (remote.running) { await remote.stop(); return }
    if (!selectedHost.value) { ui.toast('请选择局域网网卡', 'warn'); return }
    await remote.start({ host: selectedHost.value, port: Number(selectedPort.value) || 37651, transport: 'tls' })
    ui.toast('远程服务已启动，手机扫码配对', 'success')
  } catch (e) {
    ui.toast('启动失败：' + String(e.message || e), 'error')
  }
}

async function startPlain() {
  try {
    await remote.start({ host: selectedHost.value, port: Number(selectedPort.value) || 37651, transport: 'restricted_plain', allowPlain: true })
    ui.toast('已启动受限明文模式（仅普通消息）', 'warn')
  } catch (e) { ui.toast('启动失败：' + String(e.message || e), 'error') }
}

async function revoke(d) {
  const ok = await ui.confirm({ title: '撤销设备', message: `确定撤销「${d.name}」的远程访问权限？`, impact: '该设备将立即断开连接，需要重新配对。', confirmText: '撤销' })
  if (ok) await remote.revokeDevice(d.deviceId)
}

async function changeRole(d, role) { await remote.updateDevice(d.deviceId, { role }) }
</script>

<template>
  <div class="flex flex-col gap-4 p-5 overflow-y-auto h-full bg-panel">
    <div class="flex items-center justify-between">
      <h2 class="text-base font-semibold text-ink-primary m-0">远程控制</h2>
      <span class="text-xs px-2 py-0.5 rounded-full" :class="remote.running ? 'bg-ok/15 text-ok' : 'bg-subtle text-ink-muted'">
        {{ remote.running ? '运行中' : remote.status === 'draining' ? '关闭中' : '已停止' }}
      </span>
    </div>

    <!-- 服务配置 -->
    <section class="rounded-xl border border-line-subtle bg-surface p-4 flex flex-col gap-3">
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          网卡地址
          <select v-model="selectedHost" class="input" :disabled="remote.running">
            <option v-for="n in remote.networkInterfaces" :key="n.address" :value="n.address">
              {{ n.address }}（{{ n.name }}）
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-secondary">
          端口
          <input v-model.number="selectedPort" type="number" min="1024" max="65535" class="input" :disabled="remote.running" />
        </label>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-primary text-sm px-4 py-2 rounded-lg" :disabled="remote.loading" @click="toggle">
          {{ remote.running ? '停止服务' : '启动 HTTPS 服务' }}
        </button>
        <button v-if="!remote.running" class="btn-ghost text-sm px-3 py-2 rounded-lg" :disabled="remote.loading" @click="startPlain">
          受限明文模式
        </button>
      </div>
      <p v-if="hasPlain" class="text-xs text-warn m-0">当前为明文兼容模式，仅支持普通消息，高危操作已禁用。</p>
      <p v-if="remote.error" class="text-xs text-bad m-0">{{ remote.error }}</p>
    </section>

    <!-- 二维码 -->
    <section v-if="remote.running && remote.qrDataUrl" class="rounded-xl border border-line-subtle bg-surface p-4 flex flex-col items-center gap-3">
      <img :src="remote.qrDataUrl" alt="配对二维码" class="w-48 h-48 rounded-lg" />
      <p class="text-xs text-ink-secondary m-0">手机扫码即完成连接，全部会话自动授权；二维码仅可使用一次，180 秒内有效。</p>
      <button class="btn-ghost text-xs px-3 py-1.5 rounded" @click="remote.refreshQr">刷新二维码</button>
      <p v-if="remote.fingerprint" class="text-[11px] text-ink-muted font-mono break-all text-center m-0">CA 指纹：{{ remote.fingerprint }}</p>
    </section>

    <!-- 已配对设备 -->
    <section class="rounded-xl border border-line-subtle bg-surface p-4 flex flex-col gap-3">
      <h3 class="text-sm font-medium text-ink-primary m-0">已配对设备（{{ remote.activeDevices.length }}）</h3>
      <p v-if="!remote.activeDevices.length" class="text-xs text-ink-muted m-0">暂无设备</p>
      <div v-for="d in remote.activeDevices" :key="d.deviceId" class="flex items-center justify-between gap-2 rounded-lg border border-line-subtle p-3">
        <div class="flex flex-col gap-0.5 min-w-0">
          <span class="text-sm text-ink-primary truncate">{{ d.name }}</span>
          <span class="text-[11px] text-ink-muted">{{ d.deviceId.slice(0, 8) }}… · {{ d.role }}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <select :value="d.role" class="input text-xs" @change="changeRole(d, $event.target.value)">
            <option value="viewer">查看</option>
            <option value="operator">操作</option>
            <option value="approver">审批</option>
          </select>
          <button class="text-xs text-bad hover:underline" @click="revoke(d)">撤销</button>
        </div>
      </div>
    </section>

    <p class="text-[11px] text-ink-muted text-center m-0">
      连接数 {{ remote.connectionCount }} · 事件流 {{ remote.eventEpoch ? remote.eventEpoch.slice(0, 8) : '—' }}
    </p>
  </div>
</template>

<style scoped>
.input {
  padding: 6px 10px;
  border: 1px solid var(--line-strong, #cbd5e1);
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
}
</style>
