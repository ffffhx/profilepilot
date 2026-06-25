/** @type {import('tailwindcss').Config} */
// ProfilePilot 的 Tailwind 配置。关键约束：重构前后样式像素一致。
// - preflight 关闭：Tailwind 的全局 reset 会改写标签默认样式，必然破坏现有外观。
// - 颜色用 var() 引用 :root 令牌，保证与现有 CSS 单一数据源、数值完全一致。
// - 现有 public/styles.src.css 作为输入源保留全部手写规则；工具类增量叠加。
module.exports = {
  content: ["./src/renderer/**/*.{ts,html}", "./public/index.html"],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-deep": "var(--bg-deep)",
        panel: "var(--panel)",
        "panel-raise": "var(--panel-raise)",
        "panel-soft": "var(--panel-soft)",
        text: "var(--text)",
        muted: "var(--muted)",
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        accent: "var(--accent)",
        "accent-bright": "var(--accent-bright)",
        "accent-dark": "var(--accent-dark)",
        "accent-ink": "var(--accent-ink)",
        "accent-soft": "var(--accent-soft)",
        "accent-line": "var(--accent-line)",
        warn: "var(--warn)",
        "warn-bright": "var(--warn-bright)",
        "warn-soft": "var(--warn-soft)",
        "warn-line": "var(--warn-line)",
        danger: "var(--danger)",
        "danger-bright": "var(--danger-bright)",
        "danger-soft": "var(--danger-soft)",
        "danger-line": "var(--danger-line)",
        info: "var(--info)",
        "info-bright": "var(--info-bright)",
        "info-soft": "var(--info-soft)",
        "info-line": "var(--info-line)",
        focus: "var(--focus)",
      },
      fontFamily: {
        display: ['"Chakra Petch"', '"PingFang SC"', "-apple-system", '"Segoe UI"', "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", '"Liberation Mono"', "monospace"],
        sans: ["-apple-system", "BlinkMacSystemFont", '"PingFang SC"', '"Segoe UI"', '"Microsoft YaHei"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "7px",
        sm: "6px",
        md: "7px",
        lg: "8px",
        xl: "10px",
        "2xl": "12px",
        "3xl": "14px",
        full: "999px",
      },
      boxShadow: {
        "glow-accent": "var(--glow-accent)",
        elevated: "var(--shadow)",
        panel: "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 18px 44px rgba(2, 6, 9, 0.35)",
        "status-grid": "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 18px 44px rgba(2, 6, 9, 0.4)",
        tooltip: "0 10px 28px rgba(2, 6, 9, 0.7), var(--glow-accent)",
        "glow-info": "0 0 18px rgba(95, 182, 255, 0.2)",
        "glow-warn": "0 0 18px rgba(242, 177, 62, 0.18)",
        "glow-danger": "0 0 18px rgba(255, 113, 100, 0.2)",
        "glow-accent-strong": "0 0 26px rgba(56, 225, 160, 0.4)",
      },
      keyframes: {
        "scan-sweep": {
          from: { "background-position": "130% 0" },
          to: { "background-position": "-130% 0" },
        },
        beacon: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "spinner-rotate": {
          to: { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "scan-sweep": "scan-sweep 2.4s linear infinite",
        beacon: "beacon 2.6s ease-in-out infinite",
        "beacon-dot": "beacon 2.2s ease-in-out infinite",
        "beacon-step": "beacon 1.4s ease-in-out infinite",
        "rise-in": "rise-in 0.45s ease both",
        "spinner-rotate": "spinner-rotate 0.8s linear infinite",
      },
    },
  },
  plugins: [],
};
