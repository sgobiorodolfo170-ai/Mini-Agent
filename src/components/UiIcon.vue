<script setup>
import { computed } from 'vue'

// 统一线性图标（方案 §1：常规 20px、线宽 1.75px；行内 16px），替换 emoji 功能图标（F21）
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 20 }
})

const paths = {
  chat: 'M21 12a8 8 0 0 1-8 8H4l2.5-2.7A8 8 0 1 1 21 12Z',
  kb: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z M4 18.5A2.5 2.5 0 0 1 6.5 16H20',
  agent:
    'M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M19.5 12c0 .4 0 .8-.1 1.2l2 1.6-2 3.4-2.4-1a7.6 7.6 0 0 1-2 1.2L14.5 21h-4l-.5-2.6a7.6 7.6 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6a7.7 7.7 0 0 1 0-2.4l-2-1.6 2-3.4 2.4 1a7.6 7.6 0 0 1 2-1.2L9.5 3h4l.5 2.6c.7.3 1.4.7 2 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2Z',
  theme: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 3v18a9 9 0 0 0 0-18Z',
  pin: 'M12 17v5 M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7Z',
  trash: 'M4 7h16 M10 4h4 M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13 M10 11v6 M14 11v6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M20 20l-4-4',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  send: 'M4.5 12L20 4l-4.5 16-4-7-7-1Z',
  stop: 'M8 8h8v8H8V8Z M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  copy: 'M9 9h10v12H9V9Z M5 15V3h10',
  edit: 'M4 20h4L20 8l-4-4L4 16v4Z M13.5 6.5l4 4',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  more: 'M12 6.5v.01 M12 12v.01 M12 17.5v.01',
  export: 'M12 15V3 M7 8l5-5 5 5 M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  check: 'M5 13l4 4L19 7',
  warn: 'M12 3l10 18H2L12 3Z M12 10v4 M12 17v.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.3 M20 5v6h-6',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  external: 'M14 5h5v5 M19 5l-8 8 M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3',
  panelRight: 'M4 4h16v16H4V4Z M14 4v16',
  panelLeft: 'M4 4h16v16H4V4Z M9 4v16',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  key: 'M15 9a4 4 0 1 0-3.5 3.97L10 14.5H8v2H6v2H3v-3l8.5-8.5A4 4 0 0 1 15 9Z M15.5 8.5v.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 3',
  db: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z M14 3v5h5'
}

const d = computed(() => paths[props.name] || '')
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="d" />
  </svg>
</template>
