// View state of the Asterisk page, kept here so every tab module can read it and so it survives the redraw on every poll. Also the
// one way to move between tabs: go(tab, patch) opens a tab with some state set (a context to show, a configuration line to jump to).

export const state = {
  tab: 'overview', paused: false,
  // PJSIP tab: filter text, role filter ('all' | 'trunk' | 'phone').
  q: '', role: 'all',
  // Dialplan tab: the view ('browse' | 'map' | 'test'), the selected context, the extension to open and highlight, the filter text,
  // the extensions the user unfolded (context|pattern), and the number tester (where it dials from, the digits, the answers).
  dpView: 'browse', ctx: null, ext: null, hl: null, dq: '', openExt: new Set(), mapSel: null,
  test: { from: '', digits: '', local: undefined, server: null, asking: false },
  // Config tab: the file shown, the line to jump to, the file filter.
  file: null, line: null, lineScrolled: false, hideEmpty: true,
};

// Round-trip history of the contacts, filled on every PJSIP poll (see pjsipmodel.recordRtt).
export const rtt = new Map();

// The page's own operations, bound by index.js once the command bar exists.
const nav = { go: () => {}, rerender: () => {}, reload: () => {} };
export const bind = api => Object.assign(nav, api);
export const go = (tab, patch = {}) => nav.go(tab, patch);
export const rerender = () => nav.rerender();
export const reload = () => nav.reload();
