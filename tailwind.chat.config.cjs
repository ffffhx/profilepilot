/** Utilities used by Streamdown stay inside the React conversation. */
module.exports = {
  content: ['./src/renderer/task-chat.tsx', './node_modules/streamdown/dist/**/*.js'],
  important: '.task-chat-surface',
  corePlugins: { preflight: false },
  theme: { extend: { colors: {
    background: 'var(--panel)', foreground: 'var(--ink)', border: 'var(--line)',
    muted: { DEFAULT: 'var(--raised)', foreground: 'var(--muted)' },
    primary: { DEFAULT: 'var(--accent)', foreground: 'var(--bg)' },
    accent: { DEFAULT: 'var(--hover)', foreground: 'var(--ink)' }
  } } },
  plugins: []
};
