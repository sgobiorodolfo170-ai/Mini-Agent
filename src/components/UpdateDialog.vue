<script setup>
import { computed } from 'vue'
import { useUpdaterStore } from '../stores/updater'
import UiDialog from './UiDialog.vue'
import UiIcon from './UiIcon.vue'

// 更新详情：只回答「有什么更新 / 去哪看」。
// 本项目自用、安装包未做签名与发布渠道，自动静默下载安装不可靠，
// 因此这里给出 GitHub 对比链接，由用户决定何时拉取与重新打包。
defineProps({
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const updater = useUpdaterStore()

const latest = computed(() => updater.latest || null)
const currentVersion = computed(() => (updater.current && updater.current.version) || '')
const currentShort = computed(() => (updater.current && updater.current.shortCommit) || '')
const checkedText = computed(() => {
  if (!updater.checkedAt) return '尚未检查'
  const d = new Date(updater.checkedAt)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})
const commitDate = computed(() => {
  if (!latest.value || !latest.value.date) return ''
  const d = new Date(latest.value.date)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
})

function openGithub() {
  const url = (latest.value && latest.value.compareUrl) || 'https://github.com/'
  window.api.app.openExternal(url)
}
</script>

<template>
  <UiDialog :open="open" title="检查更新" width="520px" @close="emit('close')">
    <div class="space-y-4 text-sm">
      <div
        v-if="updater.available && latest"
        class="rounded-xl border border-brand/40 bg-brand-soft px-3.5 py-3 text-brand-ink"
      >
        <div class="flex items-center gap-2 font-medium">
          <UiIcon name="download" :size="16" />
          GitHub 上有新提交
        </div>
        <p class="mt-1 text-xs opacity-90">
          本地落后
          {{
            updater.behind > 0 ? updater.behind + ' 个提交' : '若干提交'
          }}，拉取后重新构建即可用上。
        </p>
      </div>

      <dl class="grid grid-cols-[86px_1fr] items-baseline gap-y-2">
        <dt class="text-ink-muted">当前版本</dt>
        <dd class="text-ink-primary">
          v{{ currentVersion || '—' }}
          <span v-if="currentShort" class="ml-1 text-xs text-ink-muted">{{ currentShort }}</span>
        </dd>

        <dt class="text-ink-muted">远端最新</dt>
        <dd class="text-ink-primary">
          <span v-if="latest">
            <span v-if="latest.version">v{{ latest.version }}</span>
            <span v-else class="text-ink-muted">版本未变</span>
            <span class="ml-1 text-xs text-ink-muted">{{ latest.shortCommit }}</span>
          </span>
          <span v-else class="text-ink-muted">未取到</span>
        </dd>

        <dt class="text-ink-muted">检查时间</dt>
        <dd class="text-ink-primary">{{ checkedText }}</dd>
      </dl>

      <div v-if="latest && latest.message" class="rounded-lg bg-subtle px-3 py-2.5">
        <div class="text-xs text-ink-muted">最新提交 {{ commitDate }}</div>
        <div class="mt-1 break-words text-[13px] leading-5 text-ink-primary">
          {{ latest.message }}
        </div>
      </div>

      <p v-if="updater.error" class="field-error">
        <UiIcon name="warn" :size="14" />
        检查失败：{{ updater.error }}
      </p>
    </div>

    <template #footer>
      <button class="btn-ghost" :disabled="updater.checking" @click="updater.check(true)">
        <UiIcon name="refresh" :size="15" />
        {{ updater.checking ? '检查中…' : '重新检查' }}
      </button>
      <button class="btn-secondary" @click="emit('close')">关闭</button>
      <button class="btn-primary" @click="openGithub">
        <UiIcon name="external" :size="15" />
        在 GitHub 查看
      </button>
    </template>
  </UiDialog>
</template>
