<script setup>
import { computed, nextTick, ref } from 'vue'
import UiIcon from '../UiIcon.vue'
import ComposerInput from './ComposerInput.vue'
import ComposerMenu from './ComposerMenu.vue'
import ComposerStatusBar from './ComposerStatusBar.vue'
import './agent-composer.css'

// 对话输入区唯一组件：两种呈现状态（standard / task-followup）通过同一套模板 + 配置切换。
// 所有文案、模型、模式、状态与能力可用性均来自上层业务层；本组件只采集输入与点击，
// 不执行 Agent 任务、不决定模型路由、不申请新权限、不实现语音或附件后端。
const props = defineProps({
  variant: { type: String, default: 'standard' }, // standard | task-followup
  placeholder: { type: String, default: '' },
  hint: { type: String, default: '' },
  value: { type: String, default: '' },
  submitting: { type: Boolean, default: false },
  streaming: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  model: { type: Object, default: null }, // { id, name, tierLabel }
  // 二级模型目录：[{ id, name, models: [{ id, label, hint, selected }] }]
  modelGroups: { type: Array, default: () => [] },
  statusItems: { type: Array, default: () => [] },
  // { id, label, icon, hint, selected, enabled, options: [{ id, label, hint, selected }] }
  modeAction: { type: Object, default: null },
  // { label, icon, active, enabled }
  contextAction: { type: Object, default: null },
  // { label, icon, enabled, active }
  addAction: { type: Object, default: null },
  // { label, icon, enabled, active, hint } —— Agent 集群开关
  clusterAction: { type: Object, default: null },
  // { value: 0..1, label } —— 上下文占用比例，null 时不渲染状态环
  contextUsage: { type: Object, default: null },
  // { label, icon, enabled }
  voiceAction: { type: Object, default: null },
  runtimeState: { type: String, default: 'idle' }, // idle | running | success | error
  sendLabel: { type: String, default: '发送' },
  stopLabel: { type: String, default: '停止' }
})
const emit = defineEmits([
  'update:value',
  'submit',
  'stop',
  'add',
  'voice',
  'context',
  'toggle-cluster',
  'select-mode',
  'select-model',
  'status-select'
])

const modeOpen = ref(false)
const modelOpen = ref(false)
// 模型菜单的当前层：null = 提供商列表；providerId = 该提供商的模型列表
const modelGroup = ref(null)
const inputRef = ref(null)

const canSend = computed(
  () => !props.disabled && !props.submitting && !props.streaming && props.value.trim().length > 0
)
const runtimeRunning = computed(() => props.runtimeState === 'running' || props.streaming === true)
const showModel = computed(() => !!(props.model && (props.model.name || props.model.id)))
const modelInteractive = computed(
  () => showModel.value && props.modelGroups.length > 0 && !props.disabled
)
const modeSelected = computed(() => !!(props.modeAction && props.modeAction.selected))
const clusterActive = computed(() => !!(props.clusterAction && props.clusterAction.active))
const hintId = 'ac-input-hint'

// 当前层级的菜单项：提供商列表 → 某提供商的模型列表
const modelMenuItems = computed(() => {
  if (!modelGroup.value) {
    return props.modelGroups.map((g) => ({
      id: g.id,
      label: g.name,
      hint: `${(g.models || []).length} 个模型`,
      icon: 'provider',
      hasChildren: true,
      selected: (g.models || []).some((m) => m.selected)
    }))
  }
  const group = props.modelGroups.find((g) => g.id === modelGroup.value)
  return ((group && group.models) || []).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    hint: m.hint || '',
    // 选中状态只由 selected 统一渲染勾选，避免出现两个勾
    selected: !!m.selected
  }))
})
const modelMenuLabel = computed(() => {
  if (!modelGroup.value) return '选择供应商'
  const group = props.modelGroups.find((g) => g.id === modelGroup.value)
  return group ? group.name : '选择模型'
})

// 上下文占用环：颜色随占用升高从中性过渡到警告/错误色
const usagePct = computed(() => {
  if (!props.contextUsage || typeof props.contextUsage.value !== 'number') return null
  return Math.max(0, Math.min(1, props.contextUsage.value))
})
const usageTone = computed(() => {
  const v = usagePct.value
  if (v === null) return 'ok'
  if (v >= 0.9) return 'bad'
  if (v >= 0.7) return 'warn'
  return 'ok'
})
// 显示用百分比：有占用时至少 1%，避免少量内容被显示成 0%（真实字符数在 tooltip 中）
const usageDisplayPct = computed(() => {
  const v = usagePct.value
  if (v === null) return 0
  if (v <= 0) return 0
  return Math.max(1, Math.round(v * 100))
})
const ringStyle = computed(() => {
  const v = usagePct.value || 0
  // 有占用时至少画出 12° 弧，避免"1%"在 16px 环上完全看不出
  const deg = v > 0 ? Math.max(12, Math.round(v * 360)) : 0
  const color =
    usageTone.value === 'bad'
      ? 'var(--status-error-ink)'
      : usageTone.value === 'warn'
        ? 'var(--status-warn-ink)'
        : 'var(--brand)'
  return {
    background: `conic-gradient(${color} ${deg}deg, color-mix(in srgb, var(--text-muted) 34%, transparent) ${deg}deg 360deg)`
  }
})

function submit() {
  modeOpen.value = false
  modelOpen.value = false
  modelGroup.value = null
  if (!canSend.value) return
  emit('submit')
}

function toggleMode() {
  if (!props.modeAction || props.modeAction.enabled === false || props.disabled) return
  modelOpen.value = false
  modeOpen.value = !modeOpen.value
}

function toggleModel() {
  if (!modelInteractive.value) return
  modeOpen.value = false
  // 每次打开都从提供商层开始
  modelGroup.value = null
  modelOpen.value = !modelOpen.value
}

function closeModel() {
  modelOpen.value = false
  modelGroup.value = null
}

function pickMode(item) {
  modeOpen.value = false
  if (item && item.id !== (props.modeAction && props.modeAction.id)) emit('select-mode', item.id)
  nextTick(() => inputRef.value && inputRef.value.focus())
}

// 一级菜单选提供商 → 下钻；二级菜单选模型 → 上报业务层
function pickModelItem(item) {
  if (!modelGroup.value) {
    modelGroup.value = item.id
    nextTick(() => inputRef.value && inputRef.value.focus())
    return
  }
  closeModel()
  emit('select-model', { providerId: modelGroup.value, modelId: item.id })
  nextTick(() => inputRef.value && inputRef.value.focus())
}

function backToProviders() {
  modelGroup.value = null
}

defineExpose({
  focus: () => inputRef.value && inputRef.value.focus()
})
</script>

<template>
  <div class="agent-composer" :data-variant="variant">
    <ComposerStatusBar :items="statusItems" @select="emit('status-select', $event)" />

    <div class="ac-card">
      <!-- 上层：文本输入，文字从卡片左上开始 -->
      <div class="ac-input-area">
        <slot name="attachment" />
        <ComposerInput
          ref="inputRef"
          :model-value="value"
          :placeholder="placeholder"
          :disabled="disabled"
          :described-by="hint ? hintId : undefined"
          @update:model-value="emit('update:value', $event)"
          @submit="submit"
        />
        <span v-if="hint" :id="hintId" class="sr-only">{{ hint }}</span>
      </div>

      <!-- 下层：左右两组操作同一水平线、保持单行、无分割线 -->
      <div class="ac-actions">
        <div class="ac-left">
          <button
            v-if="addAction"
            class="ac-btn"
            type="button"
            data-testid="composer-add"
            :aria-label="addAction.label"
            :title="addAction.label"
            :disabled="addAction.enabled === false || disabled"
            @click="emit('add')"
          >
            <UiIcon :name="addAction.icon || 'plus'" :size="18" />
          </button>

          <div v-if="modeAction" class="ac-anchor">
            <button
              class="ac-select"
              :class="modeSelected ? 'ac-select--emphasis' : ''"
              type="button"
              data-testid="agent-toggle"
              data-composer-trigger
              :disabled="modeAction.enabled === false || disabled"
              :aria-expanded="modeOpen ? 'true' : 'false'"
              aria-haspopup="menu"
              :title="modeAction.hint || modeAction.label"
              @click="toggleMode"
            >
              <UiIcon :name="modeAction.icon || 'shield'" :size="15" />
              <span class="ac-select__label">{{ modeAction.label }}</span>
              <UiIcon name="chevronDown" :size="13" class="ac-select__chev" />
            </button>
            <ComposerMenu
              v-if="modeAction.options && modeAction.options.length"
              :open="modeOpen"
              align="left"
              :label="modeAction.label"
              :items="modeAction.options"
              max-width="320px"
              @close="modeOpen = false"
              @select="pickMode"
            />
          </div>

          <div v-if="contextAction" class="ac-anchor">
            <button
              class="ac-select ac-select--collapsible"
              type="button"
              data-testid="kb-chip"
              data-composer-trigger
              :disabled="contextAction.enabled === false || disabled"
              :aria-expanded="contextAction.active ? 'true' : 'false'"
              :aria-label="contextAction.label"
              :title="contextAction.label"
              @click="emit('context')"
            >
              <UiIcon :name="contextAction.icon || 'kb'" :size="15" />
              <span class="ac-select__label">{{ contextAction.label }}</span>
            </button>
            <slot name="context-panel" />
          </div>

          <!-- Agent 集群：开启后允许一次派发多个并行子 Agent -->
          <button
            v-if="clusterAction"
            class="ac-select ac-select--collapsible"
            :class="clusterActive ? 'ac-select--emphasis' : ''"
            type="button"
            data-testid="composer-cluster"
            :disabled="clusterAction.enabled === false || disabled"
            :aria-pressed="clusterActive ? 'true' : 'false'"
            :title="clusterAction.hint || clusterAction.label"
            @click="emit('toggle-cluster')"
          >
            <UiIcon :name="clusterAction.icon || 'cluster'" :size="15" />
            <span class="ac-select__label">{{ clusterAction.label }}</span>
          </button>
        </div>

        <div class="ac-right">
          <!-- 运行状态指示：仅真实进行中显示并旋转 -->
          <span
            v-if="runtimeRunning"
            class="ac-ring"
            role="img"
            aria-label="正在执行"
            data-testid="composer-runtime"
          />

          <!-- 上下文状态环：仅在业务层给出真实占用比例时显示 -->
          <span
            v-if="usagePct !== null"
            class="ac-usage"
            :class="`ac-usage--${usageTone}`"
            role="img"
            data-testid="composer-usage"
            :aria-label="`上下文已用 ${usageDisplayPct}%${contextUsage.label ? '，' + contextUsage.label : ''}`"
            :title="`上下文已用 ${usageDisplayPct}%${contextUsage.label ? '（' + contextUsage.label + '）' : ''}`"
          >
            <span class="ac-usage__ring" :style="ringStyle" aria-hidden="true" />
          </span>

          <div v-if="showModel" class="ac-anchor ac-model">
            <button
              class="ac-select"
              type="button"
              data-testid="composer-model"
              data-composer-trigger
              :disabled="!modelInteractive || disabled"
              :aria-expanded="modelOpen ? 'true' : 'false'"
              aria-haspopup="menu"
              :title="modelInteractive ? '切换供应商与模型' : model.name || model.id"
              @click="toggleModel"
            >
              <span class="ac-select__label">{{ model.name || model.id }}</span>
              <span v-if="model.tierLabel" class="ac-tier">{{ model.tierLabel }}</span>
              <UiIcon
                v-if="modelInteractive"
                name="chevronDown"
                :size="13"
                class="ac-select__chev"
              />
            </button>
            <!-- 二级目录：一级提供商 → 二级该提供商模型 -->
            <ComposerMenu
              :open="modelOpen"
              align="right"
              :label="modelMenuLabel"
              :items="modelMenuItems"
              :header="modelGroup ? '返回供应商列表' : ''"
              empty-text="没有可用的供应商与模型"
              max-width="336px"
              @close="closeModel"
              @back="backToProviders"
              @select="pickModelItem"
            />
          </div>

          <button
            v-if="voiceAction"
            class="ac-btn"
            type="button"
            data-testid="composer-voice"
            :aria-label="voiceAction.label"
            :title="voiceAction.label"
            :disabled="voiceAction.enabled === false || disabled"
            @click="emit('voice')"
          >
            <UiIcon :name="voiceAction.icon || 'mic'" :size="17" />
          </button>

          <!-- 进行中：真实停止入口；否则发送按钮始终位于最末端 -->
          <button
            v-if="streaming"
            class="ac-stop"
            type="button"
            data-testid="chat-stop"
            @click="emit('stop')"
          >
            <UiIcon name="stop" :size="15" />
            {{ stopLabel }}
          </button>
          <button
            v-else
            class="ac-send"
            type="button"
            data-testid="chat-send"
            :disabled="!canSend"
            :aria-label="sendLabel"
            :title="sendLabel"
            @click="submit"
          >
            <UiIcon name="arrowUp" :size="17" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
