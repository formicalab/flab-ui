// Follows the OS light/dark preference through Bootstrap's color-mode attribute.

const scheme = matchMedia('(prefers-color-scheme: dark)');
const apply = () => document.documentElement.setAttribute('data-bs-theme', scheme.matches ? 'dark' : 'light');

export function initTheme() {
  scheme.addEventListener('change', apply);
  apply();
}
