<script setup>
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'

// 会话设置面板（F01 详情抽屉/停靠共用；F21 参数中文命名）
const props = defineProps({
  conv: { type: Object, default: null },
  providers: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] },
  policy: { type: Object, default: () => ({}) },
  projects: { type: Array, default: () => [] },
  docked: { type: Boolean, default: false },
  detailsPinned: { type: Boolean, default: false },
  canPin: { type: Boolean, default: false }
})
const emit = defineEmits([
  'close',
  'pin',
  'unpin',
  'set-provider',
  'set-model',
  'set-prompt',
  'set-project',
  'set-field',
  'export'
])

const currentProject = computed(
  () => props.projects.find((p) => p.id === (props.conv && props.conv.projectId)) || null
)

function numValue(name) {
  const v = props.policy[name]
  return v === undefined || v === null ? '' : v
}
function onNum(name, e) {
  emit('set-field', name, e.target.value === '' ? null : Number(e.target.value))
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <div class="font-semibold text-sm">会话设置</div>
      <div class="flex items-center gap-1">
        <button
          v-if="docked && detailsPinned"
          class="btn-ghost !h-7 !px-2 text-xs"
          title="取消固定，改为抽屉展示"
          @click="emit('unpin')"
        >
          取消固定
        </button>
        <button
          v-if="!docked && canPin"
          class="btn-ghost !h-7 !px-2 text-xs"
          title="固定停靠在右侧（宽窗口可用）"
          @click="emit('pin')"
        >
          固定停靠
        </button>
        <button v-if="!docked" class="icon-btn-sm" aria-label="关闭会话设置" @click="emit('close')">
          <UiIcon name="close" :size="16" />
        </button>
      </div>
    </div>

    <div v-if="!conv" class="text-ink-muted text-sm py-8 text-center">选择一个会话查看设置</div>
    <template v-else>
      <label class="block">
        <span class="field-label !mb-1 text-xs">所属项目</span>
        <select
          class="field-input !h-8 text-xs"
          :value="conv.projectId || ''"
          @change="emit('set-project', $event.target.value)"
        >
          <option value="">不分组</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <span v-if="currentProject" class="field-help !mt-0.5 break-all">
          任务命令将在 {{ currentProject.path }} 中执行
        </span>
      </label>
      <label class="block">
        <span class="field-label !mb-1 text-xs">供应商</span>
        <select
          class="field-input !h-8 text-xs"
          :value="conv.providerId || ''"
          @change="emit('set-provider', $event.target.value)"
        >
          <option value="">跟随默认</option>
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label class="block">
        <span class="field-label !mb-1 text-xs">模型</span>
        <select
          class="field-input !h-8 text-xs"
          :value="conv.model || ''"
          @change="emit('set-model', $event.target.value)"
        >
          <option value="">跟随默认</option>
          <option v-for="m in models" :key="m.id" :value="m.id">
            {{ m.id }}{{ m.vision ? '（视觉）' : '' }}
          </option>
        </select>
      </label>
      <label class="block">
        <span class="field-label !mb-1 text-xs">系统提示词</span>
        <textarea
          rows="3"
          class="field-area !text-xs"
          :value="conv.systemPrompt || ''"
          placeholder="留空则使用全局默认"
          @change="emit('set-prompt', $event.target.value)"
        />
      </label>
      <div class="grid grid-cols-2 gap-2.5 pt-1">
        <label class="block">
          <span class="field-label !mb-1 text-xs">随机性</span>
          <input
            class="field-input !h-8 text-xs"
            :value="numValue('temperature')"
            placeholder="默认"
            @change="onNum('temperature', $event)"
          />
          <span class="field-help !mt-0.5">temperature</span>
        </label>
        <label class="block">
          <span class="field-label !mb-1 text-xs">核采样</span>
          <input
            class="field-input !h-8 text-xs"
            :value="numValue('topP')"
            placeholder="默认"
            @change="onNum('topP', $event)"
          />
          <span class="field-help !mt-0.5">top_p</span>
        </label>
        <label class="block">
          <span class="field-label !mb-1 text-xs">最大输出长度</span>
          <input
            class="field-input !h-8 text-xs"
            :value="numValue('maxTokens')"
            placeholder="默认"
            @change="onNum('maxTokens', $event)"
          />
          <span class="field-help !mt-0.5">max_tokens</span>
        </label>
        <label class="block">
          <span class="field-label !mb-1 text-xs">保留轮数</span>
          <input
            class="field-input !h-8 text-xs"
            :value="numValue('keepTurns')"
            placeholder="20"
            @change="onNum('keepTurns', $event)"
          />
        </label>
        <label class="block">
          <span class="field-label !mb-1 text-xs">上下文上限（字符）</span>
          <input
            class="field-input !h-8 text-xs"
            :value="numValue('maxChars')"
            placeholder="12000"
            @change="onNum('maxChars', $event)"
          />
        </label>
      </div>
      <div class="pt-2 border-t border-line-subtle flex gap-2">
        <button class="btn-secondary flex-1 !h-8 text-xs" @click="emit('export', 'md')">
          导出 MD
        </button>
        <button class="btn-secondary flex-1 !h-8 text-xs" @click="emit('export', 'json')">
          导出 JSON
        </button>
      </div>
    </template>
  </div>
</template>
