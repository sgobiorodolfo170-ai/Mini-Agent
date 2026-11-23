<script setup>
import { computed } from 'vue'

// 中文状态映射（F17/F21）：done/running 等内部枚举不直接暴露给用户
const props = defineProps({ status: { type: String, default: '' } })

const map = {
  queued: { label: '排队中', cls: 'bg-subtle text-ink-secondary' },
  waiting_child: { label: '等待子任务', cls: 'bg-hint text-hint-ink' },
  transferred: { label: '已移交', cls: 'bg-subtle text-ink-secondary' },
  interrupted: { label: '执行中断', cls: 'bg-warn text-warn-ink' },
  running: { label: '执行中', cls: 'bg-hint text-hint-ink' },
  done: { label: '已完成', cls: 'bg-ok text-ok-ink' },
  stopped: { label: '已停止', cls: 'bg-subtle text-ink-secondary' },
  max_steps: { label: '已达步骤上限', cls: 'bg-warn text-warn-ink' },
  error: { label: '失败', cls: 'bg-bad text-bad-ink' },
  ready: { label: '已就绪', cls: 'bg-ok text-ok-ink' },
  pending: { label: '处理中', cls: 'bg-subtle text-ink-secondary' },
  ok: { label: '正常', cls: 'bg-ok text-ok-ink' },
  invalid: { label: '无效', cls: 'bg-bad text-bad-ink' },
  cooldown: { label: '冷却中', cls: 'bg-warn text-warn-ink' },
  unknown: { label: '未验证', cls: 'bg-subtle text-ink-secondary' }
}

const item = computed(
  () => map[props.status] || { label: props.status, cls: 'bg-subtle text-ink-secondary' }
)
</script>

<template>
  <span class="badge" :class="item.cls">{{ item.label }}</span>
</template>
