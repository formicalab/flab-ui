// Follows the OS light/dark preference through Bootstrap's color-mode attribute.

const scheme = matchMedia('(prefers-color-scheme: dark)');
// Sets the theme attribute from the current preference.
const apply = () => document.documentElement.setAttribute('data-bs-theme', scheme.matches ? 'dark' : 'light');

// Applies the preference now and again whenever the OS setting changes.
export function initTheme() {
  scheme.addEventListener('change', apply);
  apply();
}
