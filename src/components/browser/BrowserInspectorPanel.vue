<script setup>
import { ref, watch } from 'vue'
import UiIcon from '../UiIcon.vue'

const props = defineProps({
  selected: { type: Object, default: null },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'select', 'styles', 'reset'])
const activeTab = ref('design')
const cssText = ref('')

const LENGTH_PROPERTIES = new Set([
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin',
  'padding',
  'gap',
  'font-size',
  'letter-spacing',
  'border-width',
  'border-radius'
])

function value(property) {
  return String(props.selected?.styles?.[property] ?? '')
}

function patch(property, nextValue) {
  let value = String(nextValue).trim()
  if (LENGTH_PROPERTIES.has(property) && /^-?\d+(?:\.\d+)?$/.test(value)) value += 'px'
  emit('styles', { styles: { [property]: value }, resetProperties: [] })
}

function toHex(color) {
  const value = String(color || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!match) return '#000000'
  return `#${match
    .slice(1, 4)
    .map((channel) =>
      Math.max(0, Math.min(255, Number(channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function formatStyles(styles = {}) {
  return Object.entries(styles)
    .map(([property, style]) => `${property}: ${style};`)
    .join('\n')
}

function parseCss(text) {
  const styles = {}
  for (const line of String(text || '').split(/[;\n]+/)) {
    const index = line.indexOf(':')
    if (index < 1) continue
    const property = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    if (property && value) styles[property] = value
  }
  return styles
}

function applyCss() {
  const styles = parseCss(cssText.value)
  const resetProperties = Object.keys(props.selected?.customStyles || {}).filter(
    (property) => !(property in styles)
  )
  emit('styles', { styles, resetProperties })
}

watch(
  () => [props.selected?.elementId, props.selected?.customStyles],
  () => {
    cssText.value = formatStyles(props.selected?.customStyles || {})
  },
  { immediate: true, deep: true }
)
</script>

<template>
  <aside
    class="w-[300px] shrink-0 min-h-0 flex flex-col border-l border-line-subtle bg-panel"
    data-testid="browser-inspector"
  >
    <div class="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-line-subtle">
      <UiIcon name="terminal" :size="15" class="text-ink-secondary" />
      <span class="text-sm font-semibold text-ink-primary">元素检查器</span>
      <button
        class="icon-btn-sm ml-auto"
        data-testid="browser-inspector-close"
        title="关闭检查器"
        aria-label="关闭检查器"
        @click="emit('close')"
      >
        <UiIcon name="close" :size="14" />
      </button>
    </div>

    <div v-if="!props.selected" class="flex-1 grid place-items-center p-6 text-center">
      <div class="space-y-3">
        <UiIcon name="cursor" :size="30" class="mx-auto text-ink-muted" />
        <p class="text-sm text-ink-secondary">先选择一个网页元素</p>
        <button
          class="btn-compact text-xs"
          data-testid="browser-inspector-select"
          @click="emit('select')"
        >
          选择元素
        </button>
      </div>
    </div>

    <template v-else>
      <div class="shrink-0 px-3 py-2 border-b border-line-subtle space-y-1">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-brand" data-testid="browser-inspector-tag">
            {{ props.selected.tagName }}
          </span>
          <span class="truncate text-xs text-ink-secondary" :title="props.selected.selector">
            {{ props.selected.selector }}
          </span>
        </div>
        <div class="text-[11px] text-ink-muted" data-testid="browser-inspector-box">
          {{ props.selected.rect.width }} × {{ props.selected.rect.height }}
        </div>
      </div>

      <div class="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-line-subtle">
        <button
          class="h-7 px-3 rounded-md text-xs"
          :class="activeTab === 'design' ? 'bg-subtle text-ink-primary' : 'text-ink-secondary'"
          data-testid="browser-inspector-tab-design"
          @click="activeTab = 'design'"
        >
          设计
        </button>
        <button
          class="h-7 px-3 rounded-md text-xs"
          :class="activeTab === 'css' ? 'bg-subtle text-ink-primary' : 'text-ink-secondary'"
          data-testid="browser-inspector-tab-css"
          @click="activeTab = 'css'"
        >
          CSS
        </button>
        <button
          class="ml-auto text-xs text-link hover:underline"
          data-testid="browser-inspector-reselect"
          @click="emit('select')"
        >
          重新选择
        </button>
      </div>

      <div v-if="activeTab === 'design'" class="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        <section class="space-y-2">
          <h3 class="text-xs font-semibold text-ink-primary">布局</h3>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-[11px] text-ink-secondary">
              宽度
              <input
                class="field-input !h-8 !py-1 text-xs mt-1"
                data-testid="browser-inspector-width"
                :value="value('width')"
                @change="patch('width', $event.target.value)"
              />
            </label>
            <label class="text-[11px] text-ink-secondary">
              高度
              <input
                class="field-input !h-8 !py-1 text-xs mt-1"
                data-testid="browser-inspector-height"
                :value="value('height')"
                @change="patch('height', $event.target.value)"
              />
            </label>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-[11px] text-ink-secondary">
              display
              <select
                class="field-input !h-8 !py-1 text-xs mt-1"
                data-testid="browser-inspector-display"
                :value="value('display')"
                @change="patch('display', $event.target.value)"
              >
                <option
                  v-for="item in ['block', 'inline-block', 'flex', 'grid', 'none']"
                  :key="item"
                >
                  {{ item }}
                </option>
              </select>
            </label>
            <label class="text-[11px] text-ink-secondary">
              position
              <select
                class="field-input !h-8 !py-1 text-xs mt-1"
                data-testid="browser-inspector-position"
                :value="value('position')"
                @change="patch('position', $event.target.value)"
              >
                <option
                  v-for="item in ['static', 'relative', 'absolute', 'fixed', 'sticky']"
                  :key="item"
                >
                  {{ item }}
                </option>
              </select>
            </label>
          </div>
          <label class="block text-[11px] text-ink-secondary">
            margin
            <input
              class="field-input !h-8 !py-1 text-xs mt-1"
              data-testid="browser-inspector-margin"
              :value="value('margin')"
              @change="patch('margin', $event.target.value)"
            />
          </label>
          <label class="block text-[11px] text-ink-secondary">
            padding
            <input
              class="field-input !h-8 !py-1 text-xs mt-1"
              data-testid="browser-inspector-padding"
              :value="value('padding')"
              @change="patch('padding', $event.target.value)"
            />
          </label>
        </section>

        <section class="space-y-2">
          <h3 class="text-xs font-semibold text-ink-primary">外观</h3>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-[11px] text-ink-secondary">
              文字颜色
              <span class="mt-1 flex items-center gap-1">
                <input
                  type="color"
                  class="h-8 w-9 rounded border border-line-control bg-surface"
                  data-testid="browser-inspector-color-picker"
                  :value="toHex(value('color'))"
                  @input="patch('color', $event.target.value)"
                />
                <input
                  class="field-input !h-8 !py-1 text-xs min-w-0"
                  data-testid="browser-inspector-color"
                  :value="value('color')"
                  @change="patch('color', $event.target.value)"
                />
              </span>
            </label>
            <label class="text-[11px] text-ink-secondary">
              背景颜色
              <span class="mt-1 flex items-center gap-1">
                <input
                  type="color"
                  class="h-8 w-9 rounded border border-line-control bg-surface"
                  data-testid="browser-inspector-background-picker"
                  :value="toHex(value('background-color'))"
                  @input="patch('background-color', $event.target.value)"
                />
                <input
                  class="field-input !h-8 !py-1 text-xs min-w-0"
                  data-testid="browser-inspector-background"
                  :value="value('background-color')"
                  @change="patch('background-color', $event.target.value)"
                />
              </span>
            </label>
          </div>
          <label class="block text-[11px] text-ink-secondary">
            边框圆角
            <input
              class="field-input !h-8 !py-1 text-xs mt-1"
              data-testid="browser-inspector-radius"
              :value="value('border-radius')"
              @change="patch('border-radius', $event.target.value)"
            />
          </label>
          <label class="block text-[11px] text-ink-secondary">
            透明度
            <span class="mt-1 flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                class="flex-1"
                data-testid="browser-inspector-opacity"
                :value="Number(value('opacity')) || 1"
                @change="patch('opacity', $event.target.value)"
              />
              <span class="w-8 text-right">{{ value('opacity') }}</span>
            </span>
          </label>
        </section>

        <section class="space-y-2">
          <h3 class="text-xs font-semibold text-ink-primary">文本</h3>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-[11px] text-ink-secondary">
              字号
              <input
                class="field-input !h-8 !py-1 text-xs mt-1"
                data-testid="browser-inspector-font-size"
                :value="value('font-size')"
                @change="patch('font-size', $event.target.value)"
              />
            </label>
            <label class="text-[11px] text-ink-secondary">
              字重
              <select
                class="field-input !h-8 !py-1 text-xs mt-1"
                data-testid="browser-inspector-font-weight"
                :value="value('font-weight')"
                @change="patch('font-weight', $event.target.value)"
              >
                <option v-for="item in ['300', '400', '500', '600', '700']" :key="item">
                  {{ item }}
                </option>
              </select>
            </label>
          </div>
          <label class="block text-[11px] text-ink-secondary">
            对齐
            <select
              class="field-input !h-8 !py-1 text-xs mt-1"
              data-testid="browser-inspector-text-align"
              :value="value('text-align')"
              @change="patch('text-align', $event.target.value)"
            >
              <option v-for="item in ['left', 'center', 'right', 'justify']" :key="item">
                {{ item }}
              </option>
            </select>
          </label>
        </section>
      </div>

      <div v-else class="flex-1 min-h-0 flex flex-col p-3 gap-2">
        <p class="text-[11px] text-ink-muted">仅修改当前页面会话，刷新或导航后恢复。</p>
        <textarea
          v-model="cssText"
          class="field-input flex-1 min-h-40 !py-2 font-mono text-xs"
          data-testid="browser-inspector-css"
          spellcheck="false"
          placeholder="color: #2563eb;&#10;padding: 12px;"
        />
        <button
          class="btn-primary !h-8 text-xs"
          data-testid="browser-inspector-css-apply"
          :disabled="props.busy"
          @click="applyCss"
        >
          应用 CSS
        </button>
      </div>

      <div class="shrink-0 p-3 border-t border-line-subtle">
        <button
          class="btn-compact w-full !h-8 text-xs"
          data-testid="browser-inspector-reset"
          :disabled="props.busy"
          @click="emit('reset')"
        >
          恢复原始样式
        </button>
      </div>
    </template>
  </aside>
</template>
