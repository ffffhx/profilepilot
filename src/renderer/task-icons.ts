const paths = {
  usage: '<path d="M4 20V10m8 10V4m8 16v-7"/>',
  desktop: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8M12 17v4m-5-9 3 3-3 3m6 0h4"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>',
  sidebarRight: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3v18"/>',
  compose: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M16 3l5 5M10 14l1-5 7-7 5 5-7 7-5 1"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  history: '<path d="M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2"/>',
  template: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M10 9v12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--sidebar)"/><circle cx="15" cy="17" r="3" fill="var(--sidebar)"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  paperclip: '<path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/>',
  bookmark: '<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  message: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pin: '<path d="m16 3 5 5-4 2-3 6-6-6 6-3 2-4ZM8 16l-5 5"/>',
  unpin: '<path d="m16 3 5 5-4 2-1.5 3M8 10l6 6M8 16l-5 5M3 3l18 18"/>',
  archive: '<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v13h14V7M10 11h4"/>',
  restore: '<path d="M4 8v12h16V8M2 4h7m6 0h7M12 14V3m-4 4 4-4 4 4"/>',
  rename: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
} as const;

export function taskIcon(name: keyof typeof paths): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
