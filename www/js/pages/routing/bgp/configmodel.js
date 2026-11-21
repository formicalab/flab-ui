// Pure model of BIRD's configuration file (/etc/bird.conf): finds its top-level blocks (protocols, templates, filters, functions), resolves
// which template a protocol inherits from, and reviews the BGP settings that matter for safety. Nothing is edited: the page only reads
// the file. The scanner understands BIRD's comments (`#` to the end of the line and `/* ... */`) and double-quoted strings, so a brace or
// a keyword inside either never counts. The file that reaches the browser already has its secrets redacted (flab.bgp config).

//#region Scanning

// The text with comments and the insides of strings replaced by spaces (newlines kept, so offsets and lines stay the same), and for each
// line the column where a comment starts there (-1 when the line has none; a line inside a block comment starts at 0).
export function mask(text) {
  const out = [];
  const commentCols = [-1];
  let state = 'code';
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') {
      out.push('\n');
      if (state === 'line') state = 'code';
      commentCols.push(state === 'block' ? 0 : -1);
      col = 0;
      continue;
    }
    const line = commentCols.length - 1;
    if (state === 'code') {
      if (c === '#') { state = 'line'; commentCols[line] = col; out.push(' '); }
      else if (c === '/' && next === '*') { state = 'block'; commentCols[line] = col; out.push(' '); }
      else if (c === '"') { state = 'string'; out.push('"'); }
      else out.push(c);
    } else if (state === 'string') {
      if (c === '\\' && next !== undefined && next !== '\n') { out.push(' ', ' '); i++; col++; }
      else if (c === '"') { state = 'code'; out.push('"'); }
      else out.push(' ');
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out.push(' ', ' '); i++; col++; }
      else out.push(' ');
    } else out.push(' ');
    col++;
  }
  return { masked: out.join(''), commentCols };
}

// The 1-based line number of each offset, from the offsets at which lines start.
function lineOf(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// What a top-level statement header says, or { kind: 'other' } for a statement this page has no use for.
// `protocol <type> [name] [from template]`, `template <type> name`, `filter name`, `function name(...)`.
function parseHeader(header) {
  let m = /^protocol\s+([A-Za-z0-9_]+)(?:\s+(?!from\b)([A-Za-z0-9_.-]+))?(?:\s+from\s+([A-Za-z0-9_.-]+))?$/.exec(header);
  if (m) return { kind: 'protocol', type: m[1], name: m[2] ?? null, from: m[3] ?? null };
  m = /^template\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_.-]+)$/.exec(header);
  if (m) return { kind: 'template', type: m[1], name: m[2], from: null };
  m = /^filter\s+([A-Za-z0-9_.-]+)$/.exec(header);
  if (m) return { kind: 'filter', type: null, name: m[1], from: null };
  m = /^function\s+([A-Za-z0-9_.-]+)\s*\(/.exec(header);
  if (m) return { kind: 'function', type: null, name: m[1], from: null };
  return { kind: 'other', type: null, name: null, from: null };
}

// Parses the configuration text into { text, lines, masked, commentCols, blocks }. A block is one top-level statement with braces:
//   { kind, type, name, from, startLine, endLine, firstLine, body }
// startLine..endLine are 1-based and inclusive; firstLine also takes in the comment lines directly above the block (its documentation);
// body is the masked text between the outer braces, where keywords can be searched without meeting comments or strings.
export function parseConfig(text) {
  const { masked, commentCols } = mask(text);
  const lines = text.split('\n');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const blocks = [];
  let depth = 0;
  let statement = 0;
  let open = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) {
        const header = masked.slice(statement, open);
        const headerText = header.replace(/\s+/g, ' ').trim();
        const startOffset = statement + (header.length - header.trimStart().length);
        const startLine = lineOf(starts, startOffset);
        const endLine = lineOf(starts, i);
        // The comment lines right above the block, up to the first blank or code line.
        let firstLine = startLine;
        while (firstLine > 1 && lines[firstLine - 2].trim().startsWith('#')) firstLine--;
        blocks.push({ ...parseHeader(headerText), startLine, endLine, firstLine, body: masked.slice(open + 1, i) });
        statement = i + 1;
      }
    } else if (c === ';' && depth === 0) statement = i + 1;
  }
  nameUnnamed(blocks);
  return { text, lines, masked, commentCols, blocks };
}

// BIRD names a protocol that the file does not name after its type and a counter ("kernel1", "static1"), taking the next number that
// no other name uses, counting per type. The live state calls the protocols by these names, so each unnamed block gets its `autoName`.
function nameUnnamed(blocks) {
  const taken = new Set(blocks.map(b => b.name).filter(Boolean));
  const counters = new Map();
  for (const b of blocks) {
    if (b.kind !== 'protocol' || b.name) continue;
    let n = counters.get(b.type) ?? 0, name;
    do name = `${b.type}${++n}`; while (taken.has(name));
    counters.set(b.type, n);
    taken.add(name);
    b.autoName = name;
  }
}

// The name a block goes by in BIRD: the one the file gives it, or, for an unnamed protocol, the one BIRD made up.
export const nameOf = b => b.name ?? b.autoName ?? null;

// The source lines of a block as text, with its documentation comment above it when `withDoc` is true.
export function blockText(config, block, withDoc = true) {
  return config.lines.slice((withDoc ? block.firstLine : block.startLine) - 1, block.endLine).join('\n');
}

//#endregion

//#region Lookup

// The configuration of the last text parsed, so a redraw on every poll does not parse an unchanged file again.
let memo = { text: null, config: null };

// The parsed configuration of a reply of flab.bgp config, or null when the file could not be read. Parsing is cached on the text.
export function configOf(reply) {
  if (!reply?.available || typeof reply.text !== 'string') return null;
  if (memo.text !== reply.text) memo = { text: reply.text, config: parseConfig(reply.text) };
  return memo.config;
}

// The block of `kind` called `name` (for a protocol: also the name BIRD gave it when the file does not), or undefined.
export const findBlock = (config, kind, name) => config?.blocks.find(b => b.kind === kind && nameOf(b) === name);

// A BGP protocol's own block and the template it names (both may be missing: the protocol may come from another file).
export function protocolBlocks(config, name) {
  const own = findBlock(config, 'protocol', name);
  const template = own?.from ? findBlock(config, 'template', own.from) : undefined;
  return { own, template };
}

//#endregion

//#region Options

// The last match of a global pattern in the given bodies, in order (a template first, the protocol itself last, so what the protocol
// says wins), or null.
function lastMatch(bodies, pattern) {
  let found = null;
  for (const body of bodies) for (const m of body.matchAll(pattern)) found = m;
  return found;
}

// What a BGP protocol's configuration (its template and its own block) sets, for the options the review looks at.
// `bodies` are the masked block bodies in inheritance order. Nested channel blocks are part of the body.
export function optionsOf(config, name) {
  const { own, template } = protocolBlocks(config, name);
  if (!own) return null;
  const bodies = [template?.body, own.body].filter(b => b != null);
  const boundary = '(?:^|[;{}\\s])';
  const auth = lastMatch(bodies, new RegExp(`${boundary}authentication\\s+(none|md5|ao)\\s*;`, 'g'));
  const password = lastMatch(bodies, new RegExp(`${boundary}password\\s+"`, 'g'));
  const limit = key => {
    const m = lastMatch(bodies, new RegExp(`${boundary}${key}\\s+limit\\s+(\\d+|off)\\b`, 'g'));
    return Boolean(m) && m[1] !== 'off';
  };
  return {
    authenticated: auth ? auth[1] !== 'none' : Boolean(password),
    importLimit: limit('import') || limit('receive'),
    importAll: Boolean(lastMatch(bodies, new RegExp(`${boundary}import\\s+all\\s*;`, 'g'))),
    exportAll: Boolean(lastMatch(bodies, new RegExp(`${boundary}export\\s+all\\s*;`, 'g'))),
  };
}

//#endregion

//#region Channel policies

// The address families (channel names) a channel statement can have in a protocol body.
const CHANNEL_NAME = /^(?:ipv4|ipv6|vpn4|vpn6|roa4|roa6|flow4|flow6|mpls|evpn|aspa)(?: (?:multicast|mpls))?$/;

// The nested channel blocks of a masked protocol or template body as a map from channel name to the masked text of its settings (an empty
// string for a bare `ipv4;`, which is a channel with every default).
function channelBodies(body) {
  const out = new Map();
  let depth = 0, statement = 0, open = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) {
        const header = body.slice(statement, open).replace(/\s+/g, ' ').trim();
        if (CHANNEL_NAME.test(header)) out.set(header, `${out.get(header) ?? ''} ${body.slice(open + 1, i)}`);
        statement = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      const header = body.slice(statement, i).replace(/\s+/g, ' ').trim();
      if (CHANNEL_NAME.test(header) && !out.has(header)) out.set(header, '');
      statement = i + 1;
    }
  }
  return out;
}

// What an `import` or `export` statement says, from the channel texts in inheritance order (the last one wins), or null when no
// channel text has one: { kind: 'all' | 'none' | 'filter' | 'inline', name? }. `import limit`, `import keep filtered` and the other
// options that start with the same word are not policies and do not match.
function policyStatement(bodies, direction) {
  const pattern = new RegExp(`(?:^|[;{}\\s])${direction}\\s+(?:in\\s+[^\\s;{]+\\s+)?(?:(all|none)\\s*;|filter\\s+([A-Za-z0-9_.-]+)\\s*;|(filter\\s*\\{|where\\b))`, 'g');
  const m = lastMatch(bodies, pattern);
  if (!m) return null;
  if (m[1]) return { kind: m[1] };
  if (m[2]) return { kind: 'filter', name: m[2] };
  return { kind: 'inline' };
}

// The import and export policy that the configuration file gives one channel of a protocol (its own channel block over the one of
// its template): { known, import, export } where `known` says the protocol is defined in the file at all, and import / export are the
// statement or null when the file says nothing, which means BIRD's default for the protocol (import all; export none; external BGP
// has no default and must say it).
export function channelPolicy(config, name, channel) {
  const { own, template } = protocolBlocks(config, name);
  if (!own) return { known: false, import: null, export: null };
  const bodies = [template, own].filter(Boolean).map(b => channelBodies(b.body).get(channel)).filter(b => b != null);
  return { known: true, import: policyStatement(bodies, 'import'), export: policyStatement(bodies, 'export') };
}

//#endregion

//#region Review

// "a", "a and b", "a, b and c".
const listOf = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
// "session" or "sessions" for a count.
const sessions = n => n === 1 ? 'session' : 'sessions';

// Findings about the configuration file itself, as [{ level, text }] in the shape of the backend's findings: whether BIRD has read the
// file since it was changed, whether every configured BGP protocol is running, and, for the external sessions, authentication, route
// limits and accept-everything policies. The same remark about several sessions is one finding naming all of them.
// `data` is the reply of flab.bgp status with the file's reply in `data.config`.
export function reviewConfig(data) {
  const reply = data.config;
  const config = configOf(reply);
  if (!config) return [];
  const out = [];
  const modified = reply.mtime, loaded = data.daemon?.reconfigured;
  if (modified != null && loaded != null && modified > loaded) {
    out.push({ level: 'warn', text: `${reply.path} was changed after BIRD last read its configuration, so the running state may differ from the file. Run "birdc configure" (or restart BIRD) to apply it.` });
  }
  const running = new Set(data.peers.map(p => p.name));
  const absent = config.blocks.filter(b => b.kind === 'protocol' && b.type === 'bgp' && nameOf(b) && !running.has(nameOf(b))).map(nameOf);
  if (absent.length) out.push({ level: 'warn', text: `${listOf(absent)} ${absent.length === 1 ? 'is' : 'are'} in ${reply.path} but not running in BIRD.` });

  const external = data.peers.filter(p => /\bexternal\b/.test(p.session ?? ''));
  const bad = { auth: [], limit: [], importAll: [], exportAll: [] };
  for (const p of external) {
    const o = optionsOf(config, p.name);
    if (!o) continue;
    if (!o.authenticated) bad.auth.push(p.name);
    if (!o.importLimit) bad.limit.push(p.name);
    if (o.importAll) bad.importAll.push(p.name);
    if (o.exportAll) bad.exportAll.push(p.name);
  }
  if (bad.importAll.length) out.push({ level: 'warn', text: `${listOf(bad.importAll)} import every route a peer sends (import all), so only the peer's own discipline protects the routing table.` });
  if (bad.exportAll.length) out.push({ level: 'warn', text: `${listOf(bad.exportAll)} announce every route to the peer (export all) instead of an allow-list.` });
  if (bad.limit.length) out.push({ level: 'info', text: `No route limit (import limit or receive limit) on the external ${sessions(bad.limit.length)} ${listOf(bad.limit)}: a peer that sends far too many routes would not be stopped.` });
  if (bad.auth.length) out.push({ level: 'info', text: `No TCP authentication (MD5 or AO) on the external ${sessions(bad.auth.length)} ${listOf(bad.auth)}.` });
  return out;
}

//#endregion
