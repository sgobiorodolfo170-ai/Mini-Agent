/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{vue,js,html}'],
  theme: {
    extend: {
      colors: {
        // 语义色统一映射到 tokens.css 变量；透明度工具类对 var() 颜色不可用，需要透明色时显式加 token
        canvas: 'var(--bg-canvas)',
        chrome: 'var(--bg-chrome)',
        panel: 'var(--bg-panel)',
        surface: 'var(--bg-surface)',
        subtle: 'var(--bg-subtle)',
        elevated: 'var(--bg-elevated)',
        line: {
          subtle: 'var(--border-subtle)',
          control: 'var(--border-control)'
        },
        ink: {
          DEFAULT: 'var(--text-primary)',
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)'
        },
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          active: 'var(--brand-active)',
          soft: 'var(--brand-soft)',
          ink: 'var(--brand-ink)'
        },
        onbrand: 'var(--on-brand)',
        link: 'var(--link)',
        focusring: 'var(--focus)',
        ok: { ink: 'var(--status-ok-ink)', bg: 'var(--status-ok-bg)' },
        warn: { ink: 'var(--status-warn-ink)', bg: 'var(--status-warn-bg)' },
        bad: { ink: 'var(--status-error-ink)', bg: 'var(--status-error-bg)' },
        hint: { ink: 'var(--status-info-ink)', bg: 'var(--status-info-bg)' },
        accent: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          soft: 'var(--brand-soft)'
        }
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        code: 'var(--font-code)'
      },
      boxShadow: {
        menu: 'var(--shadow-menu)',
        modal: 'var(--shadow-modal)'
      }
    }
  },
  plugins: []
}
