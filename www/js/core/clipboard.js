// Copying text to the clipboard, for the "Copy" buttons of the Toolbox (certificates, iperf3 commands).
import { h } from './dom.js';
import { button } from './ui.js';

// Copies `text` to the clipboard (the async API where the page may use it, a selected textarea otherwise). Resolves to
// whether it worked.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* no clipboard access at all */ }
    area.remove();
    return ok;
  }
}

// A button that copies `text` and says so on itself for a moment. `label` is what it normally reads.
export function copyButton(text, label = 'Copy') {
  return button(label, null, async e => {
    const btn = e.currentTarget;
    const ok = await copyText(text);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = label; }, 1500);
  });
}
