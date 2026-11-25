import { defineStore } from 'pinia'

export const useRemoteStore = defineStore('remote', {
  state: () => ({
    status: 'stopped',
    host: '',
    port: 37651,
    transport: 'tls',
    fingerprint: '',
    error: null,
    networkInterfaces: [],
    devices: [],
    pairings: [],
    connectionCount: 0,
    eventEpoch: '',
    sync: null,
    qrDataUrl: '',
    qrExpiresAt: 0,
    loading: false
  }),
  getters: {
    running: (s) => s.status === 'ready',
    activeDevices: (s) => s.devices.filter((d) => d.status === 'active')
  },
  actions: {
    apply(state) {
      if (!state) return
      Object.assign(this, state)
    },
    async refresh() {
      if (!window.api.remote) return
      this.apply(await window.api.remote.state())
    },
    async start(opts) {
      this.loading = true
      try {
        this.apply(await window.api.remote.start(opts))
        await this.refreshQr()
      } finally {
        this.loading = false
      }
    },
    async stop() {
      this.loading = true
      try {
        await window.api.remote.stop()
        this.status = 'stopped'
        this.qrDataUrl = ''
      } finally {
        this.loading = false
      }
    },
    async refreshQr() {
      if (!window.api.remote) return
      const qr = await window.api.remote.qrcode()
      this.qrDataUrl = qr ? qr.dataUrl : ''
      this.qrExpiresAt = qr ? qr.expiresAt : 0
    },
    async updateDevice(deviceId, patch) {
      await window.api.remote.updateDevice({ deviceId, ...patch })
      await this.refresh()
    },
    async revokeDevice(deviceId) {
      await window.api.remote.revokeDevice(deviceId)
      await this.refresh()
    }
  }
})
