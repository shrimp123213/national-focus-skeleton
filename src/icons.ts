const paths: Record<string, string> = {
  crown: '<path d="M10 18l10 9 12-17 12 17 10-9-6 29H16z"/><path d="M16 53h32M21 38h22"/>',
  industry: '<path d="M10 53V28l15 8V24l14 8V11h9l3 42z"/><path d="M17 43h5m8 0h5m8 0h3"/>',
  army: '<path d="M15 10l39 39-5 5L10 15zM49 10L10 49l5 5 39-39zM7 40l17 17m16-50 17 17"/>',
  science:
    '<path d="M24 9h16M28 9v21L14 49q-3 6 4 6h28q7 0 4-6L36 30V9M23 40h18"/><circle cx="32" cy="46" r="2"/>',
  trade: '<path d="M10 25h44L44 13m10 12L44 37M54 43H10l10-12M10 43l10 12"/>',
  diplomacy:
    '<circle cx="32" cy="32" r="22"/><ellipse cx="32" cy="32" rx="10" ry="22"/><path d="M10 32h44M15 19h34M15 45h34"/>',
  eagle:
    '<path d="M32 15l-7-6-4 3 6 9-9-4L6 8l3 20 14 10-9 7 12-2 6 14 6-14 12 2-9-7 14-10 3-20-12 9-9 4 6-9-4-3z"/><path d="M27 28l5 13 5-13"/>',
};
export function icon(name: string, className = ''): string {
  return `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.crown}</svg>`;
}
