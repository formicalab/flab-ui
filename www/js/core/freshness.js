// Keeps the browser's HTTP cache in step with the installed web files.
//
// uhttpd serves static files without Cache-Control, and the packaged files have a reproducible-build
// modification time, so browsers may reuse them without asking again for months, and keep showing an old UI
// after the package was upgraded. The router reports an identifier of its installed files (flab.system build).
// When it differs from the one stored by this browser, every file is downloaded again with cache: 'reload',
// which replaces the cached copy, and the page restarts so that the new code runs. Code that was already
// cached before this check existed needs one hard reload (Ctrl+F5); after that, upgrades refresh themselves.

import { ubus } from './ubus.js';

const STORAGE_KEY = 'flab.build';
// Downloads running at the same time; browsers limit connections per host anyway.
const PARALLEL = 6;

// Downloads every file again into the HTTP cache, a few at a time. Resolves to false when any download failed.
async function refetch(files, load) {
  const queue = [...files];
  let ok = true;
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      try {
        const response = await load(file);
        if (!response.ok) ok = false;
      } catch {
        ok = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  return ok;
}

// Compares the router's build identifier with the stored one and refreshes the cache when they differ.
// Resolves to true when the page is being reloaded (the caller should stop). Never throws: a router that cannot
// answer (older package, no permission, offline) leaves the UI as it is. The identifier is stored only after every
// file was downloaded, so a failed refresh is retried at the next start.
export async function ensureCurrent({
  call = () => ubus('flab.system', 'build'),
  load = file => fetch(file, { cache: 'reload' }),
  storage = globalThis.localStorage,
  reload = () => globalThis.location.reload(),
} = {}) {
  try {
    const { id, files } = await call();
    if (typeof id !== 'string' || !Array.isArray(files)) return false;
    const stored = storage?.getItem(STORAGE_KEY) ?? null;
    if (stored === id) return false;
    // Relative to the page, like the module imports and stylesheets are.
    if (!await refetch([...files, './'], load)) return false;
    storage?.setItem(STORAGE_KEY, id);
    // First run in this browser: the code that is running was just fetched by a reload of the page or is the
    // newest; only the unvisited files needed replacing. Otherwise the running code may be outdated.
    if (stored === null) return false;
    reload();
    return true;
  } catch {
    return false;
  }
}
