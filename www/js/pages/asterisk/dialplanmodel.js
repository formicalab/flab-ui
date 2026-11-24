// Pure model of the Dialplan tab: Asterisk's extension pattern matching, the order contexts are searched in, what a step jumps to or dials, and
// the routing map (endpoint -> context -> dialed endpoint). No DOM, no ubus. The data is the reply of `flab.asterisk dialplan`
// ({ contexts: [{ name, includes, extensions: [{ pattern, steps: [{ prio, label, app, data }] }] }] }) and, for the map, of `flab.asterisk pjsip`.

//#region extension patterns

// Whether an extension name is a pattern (it starts with "_").
export const isPattern = name => typeof name === 'string' && name.startsWith('_');

const DIGITS = '0123456789';
const range = (from, to) => new Set([...DIGITS.slice(+from, +to + 1)]);

// The elements of a pattern after its "_": { kind: 'lit', ch } | { kind: 'set', set, label } | { kind: 'any' } ("." one or more of anything) |
// { kind: 'early' } ("!" zero or more). Spaces and dashes outside brackets are ignored, as in Asterisk.
export function patternTokens(pattern) {
  const out = [];
  const body = isPattern(pattern) ? pattern.slice(1) : '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === ' ' || ch === '-') continue;
    if (ch === 'X' || ch === 'x') out.push({ kind: 'set', set: range(0, 9), label: '0–9' });
    else if (ch === 'Z' || ch === 'z') out.push({ kind: 'set', set: range(1, 9), label: '1–9' });
    else if (ch === 'N' || ch === 'n') out.push({ kind: 'set', set: range(2, 9), label: '2–9' });
    else if (ch === '.') out.push({ kind: 'any' });
    else if (ch === '!') out.push({ kind: 'early' });
    else if (ch === '[') {
      const end = body.indexOf(']', i + 1);
      const inner = end < 0 ? body.slice(i + 1) : body.slice(i + 1, end);
      const set = new Set();
      for (let k = 0; k < inner.length; k++) {
        if (inner[k + 1] === '-' && k + 2 < inner.length) {
          for (let c = inner.charCodeAt(k); c <= inner.charCodeAt(k + 2); c++) set.add(String.fromCharCode(c));
          k += 2;
        } else set.add(inner[k]);
      }
      out.push({ kind: 'set', set, label: inner.replace(/-/g, '–') });
      i = end < 0 ? body.length : end;
    } else out.push({ kind: 'lit', ch });
  }
  return out;
}

// Whether a dialed string matches an extension name: an exact name must be equal, a pattern is matched element by element, and
// the whole string must be used. "." needs at least one more character; "!" accepts any rest, even none.
export function matchPattern(name, dialed) {
  if (!isPattern(name)) return name === dialed;
  let i = 0;
  for (const t of patternTokens(name)) {
    if (t.kind === 'any') return i < dialed.length;
    if (t.kind === 'early') return true;
    if (i >= dialed.length) return false;
    if (t.kind === 'lit' ? dialed[i] !== t.ch : !t.set.has(dialed[i])) return false;
    i++;
  }
  return i === dialed.length;
}

// The special extension names and what Asterisk uses them for.
const SPECIAL = {
  s: 'start: the entry point when a context is entered without a dialed number (a Gosub/Goto into it, such as a subroutine, or a channel with no destination)',
  h: 'hangup handler: runs when the call ends',
  i: 'invalid: runs when the dialed number matches nothing',
  t: 'timeout: runs when the caller does not dial in time',
  T: 'absolute timeout',
  o: 'operator',
  a: 'asterisk key (voicemail)',
  e: 'exception handler',
};

// A pattern in plain words ("_0[1-9]." -> '"0", then 1–9, then one or more of anything'); an exact name is "exactly …".
export function describePattern(name) {
  if (!isPattern(name)) return SPECIAL[name] ?? `exactly “${name}”`;
  const parts = patternTokens(name).map(t => {
    if (t.kind === 'lit') return `“${t.ch}”`;
    if (t.kind === 'any') return 'one or more of anything';
    if (t.kind === 'early') return 'anything, even nothing';
    return t.label === '0–9' ? 'a digit' : t.label;
  });
  return parts.join(', then ');
}
//#endregion

//#region searching the dialplan

// Name -> context.
export const contextMap = dp => new Map((dp?.contexts ?? []).map(c => [c.name, c]));

// What Asterisk finds for a dialed string in a context: the context's own extensions in the order the dialplan lists them (the exact names, then
// the patterns by how specific they are; the first that matches wins), then the included contexts in order. Returns
// { context, via: [include chain], extension } or null.
export function findExtension(dp, contextName, dialed) {
  const byName = contextMap(dp);
  const seen = new Set();
  const walk = (name, via) => {
    const ctx = byName.get(name);
    if (!ctx || seen.has(name)) return null;
    seen.add(name);
    const extension = ctx.extensions.find(e => matchPattern(e.pattern, dialed));
    if (extension) return { context: name, via, extension };
    for (const inc of ctx.includes ?? []) {
      const found = walk(inc, [...via, inc]);
      if (found) return found;
    }
    return null;
  };
  return walk(contextName, []);
}

// The step of an extension with a label, or the step with that priority number.
export function stepAt(ext, labelOrPrio) {
  if (!ext) return null;
  return ext.steps.find(s => s.label === labelOrPrio) ?? ext.steps.find(s => String(s.prio) === String(labelOrPrio)) ?? null;
}
//#endregion

//#region what a step does

// Splits `text` at the first `sep` outside brackets, parentheses, braces and quotes; returns [before, after] or [text, null].
function splitTop(text, sep) {
  let depth = 0, quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    else if (quote) continue;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === sep && depth === 0) return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, null];
}

// All top-level pieces of `text` separated by `sep`.
function splitAll(text, sep) {
  const out = [];
  let rest = text;
  for (;;) {
    const [head, tail] = splitTop(rest, sep);
    out.push(head);
    if (tail === null) return out;
    rest = tail;
  }
}

// A jump destination "[[context,]exten,]priority" (a Gosub one may end with "(args)"), as seen from the step (context, extension). The
// priority is a number or a label. Returns { context, exten, prio, dynamic, missing? } and leaves `missing` empty when the destination exists.
export function resolveDestination(dp, spec, from) {
  const clean = spec.trim().replace(/\([^)]*\)$/, '');
  if (!clean) return null;
  const parts = splitAll(clean, ',').map(p => p.trim());
  let context = from.context, exten = from.exten, prio = parts[parts.length - 1];
  if (parts.length === 2) exten = parts[0];
  else if (parts.length >= 3) [context, exten] = parts;
  const dest = { context, exten, prio, dynamic: /\$\{|\$\[/.test(context + exten + prio) };
  if (dest.dynamic) return dest;
  const ctx = contextMap(dp).get(context);
  if (!ctx) return { ...dest, missing: 'context' };
  const ext = ctx.extensions.find(e => e.pattern === exten) ?? findExtension(dp, context, exten)?.extension;
  if (!ext) return { ...dest, missing: 'extension' };
  const step = stepAt(ext, prio);
  if (!step && !/^[+-]?\d+$|^n$/.test(prio)) return { ...dest, missing: 'label' };
  return { ...dest, prio: step ? step.prio : prio, label: step?.label ?? null };
}

// A branch of "cond?then:else".
function branches(arg) {
  const [cond, rest] = splitTop(arg, '?');
  if (rest === null) return { cond: null, then: arg, else: null };
  const [then, other] = splitTop(rest, ':');
  return { cond, then, else: other };
}

// Where a step can jump: [{ kind: 'goto' | 'gosub', branch: 'always' | 'then' | 'else', cond, ...destination }]. Covers Goto, GotoIf,
// GotoIfTime, Gosub, GosubIf and ExecIf wrapping one of them. `from` is { context, exten } of the step.
export function stepJumps(dp, step, from) {
  const out = [];
  const add = (kind, branch, cond, spec) => {
    const dest = spec == null || spec.trim() === '' ? null : resolveDestination(dp, spec, from);
    if (dest) out.push({ kind, branch, cond, ...dest });
  };
  const app = step.app, data = step.data ?? '';
  if (app === 'Goto') add('goto', 'always', null, data);
  else if (app === 'Gosub') add('gosub', 'always', null, data);
  else if (app === 'GotoIf' || app === 'GotoIfTime' || app === 'GosubIf') {
    const b = branches(data);
    const kind = app === 'GosubIf' ? 'gosub' : 'goto';
    add(kind, 'then', b.cond, b.then);
    add(kind, 'else', b.cond, b.else);
  } else if (app === 'ExecIf') {
    const b = branches(data);
    for (const [branch, text] of [['then', b.then], ['else', b.else]]) {
      const inner = /^([A-Za-z]+)\((.*)\)$/.exec((text ?? '').trim());
      if (inner && ['Goto', 'Gosub'].includes(inner[1])) add(inner[1].toLowerCase(), branch, b.cond, inner[2]);
    }
  }
  return out;
}

// The [globals] of the dialplan as { NAME: value }; a redacted value is left out because it says nothing.
export function globalVars(dp) {
  const vars = {};
  for (const g of dp?.globals ?? []) if (g.value !== '<redacted>') vars[g.name] = g.value;
  return vars;
}

// ${NAME} replaced by its global value; other variables (${EXTEN}, ${ARG1}…) stay. `used` collects the names that were replaced.
function expandGlobals(text, vars, used) {
  return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (all, name) => {
    if (!Object.hasOwn(vars, name)) return all;
    used.push(name);
    return vars[name];
  });
}

// What a Dial step calls: [{ tech, kind: 'endpoint' | 'dynamic' | 'local' | 'other', endpoint, context, raw, via }]. PJSIP/1001 and
// PJSIP/+39${EXTEN}@Vodafone name an endpoint (1001, Vodafone); a variable in the endpoint position makes it dynamic unless it is a global
// (`vars`, from globalVars()): PJSIP/${ARG1}@${OUTBOUND_TRUNK} then names the endpoint that OUTBOUND_TRUNK holds (`via` = the global's name);
// Local/x@ctx names a context.
export function stepDials(step, vars = {}) {
  if (step.app !== 'Dial') return [];
  const used = [];
  const first = expandGlobals(splitTop(step.data ?? '', ',')[0], vars, used);
  const via = used[0] ?? null;
  return splitAll(first, '&').map(raw => raw.trim()).filter(Boolean).map(raw => {
    const slash = raw.indexOf('/');
    const tech = slash < 0 ? raw : raw.slice(0, slash);
    const rest = slash < 0 ? '' : raw.slice(slash + 1);
    if (tech === 'PJSIP') {
      const at = rest.lastIndexOf('@');
      const name = (at >= 0 ? rest.slice(at + 1) : rest).split('/')[0];
      return /\$\{/.test(name) ? { tech, kind: 'dynamic', endpoint: null, raw } : { tech, kind: 'endpoint', endpoint: name, raw, ...(via ? { via } : {}) };
    }
    if (tech === 'Local') {
      const at = rest.lastIndexOf('@');
      return { tech, kind: 'local', context: at >= 0 ? rest.slice(at + 1).split('/')[0] : null, raw };
    }
    return { tech, kind: 'other', raw };
  });
}

// Everything an extension can dial: its own Dial steps, then those of the extensions it jumps or Gosubs to (any depth, each extension once; a
// jump through a variable cannot be followed). A dial found in another context carries `through`, the context that holds it ("sub-trunk").
export function extensionDials(dp, contextName, extension, vars = {}) {
  const out = [], seen = new Set(), byName = contextMap(dp);
  const walk = (context, ext) => {
    const key = `${context}|${ext.pattern}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const step of ext.steps) {
      for (const d of stepDials(step, vars)) out.push(context === contextName ? d : { ...d, through: context });
      for (const j of stepJumps(dp, step, { context, exten: ext.pattern })) {
        if (j.dynamic || j.missing) continue;
        const next = byName.get(j.context)?.extensions.find(e => e.pattern === j.exten) ?? findExtension(dp, j.context, j.exten)?.extension;
        if (next) walk(j.context, next);
      }
    }
  };
  walk(contextName, extension);
  return out;
}
//#endregion

//#region the routing map

// The routing map: which endpoints enter which context, which contexts reach which dialed endpoints, and what is wrong with the wiring.
// `pjsip` may be null (PJSIP not available). Returns { entries, contexts, targets, edges, findings }.
export function buildMap(dp, pjsip) {
  const endpoints = pjsip?.available ? pjsip.endpoints : [];
  const byEndpoint = new Map(endpoints.map(e => [e.name, e]));
  const ctxs = contextMap(dp);
  const findings = [];
  const edges = [];
  const targets = new Map();
  const note = (level, text) => findings.push({ level, text });

  const vars = globalVars(dp);
  const contexts = (dp?.contexts ?? []).map(c => ({
    name: c.name, extensions: c.extensions.length, includes: c.includes ?? [], jumps: [], dials: 0, entries: [], reached: false,
  }));
  const ctxNode = new Map(contexts.map(c => [c.name, c]));

  const entries = endpoints.map(e => ({ name: e.name, role: e.role, state: e.state, context: e.context, known: ctxs.has(e.context ?? '') }));
  for (const e of entries) {
    if (!e.context) continue;
    if (e.known) {
      edges.push({ from: `ep:${e.name}`, to: `ctx:${e.context}`, kind: 'enter' });
      ctxNode.get(e.context).entries.push(e.name);
    } else {
      note('warn', `Endpoint ${e.name} sends its calls to the context “${e.context}”, which the dialplan does not define: they are rejected.`);
    }
  }

  // Dial and jump edges, one per (context, target) with the extension names that use it.
  const dialEdges = new Map();
  for (const c of dp?.contexts ?? []) {
    for (const ext of c.extensions) {
      for (const step of ext.steps) {
        for (const d of stepDials(step, vars)) {
          let id, node;
          if (d.kind === 'endpoint') {
            id = `tg:${d.endpoint}`;
            const ep = byEndpoint.get(d.endpoint);
            node = { id, kind: 'endpoint', name: d.endpoint, state: ep?.state ?? null, role: ep?.role ?? null, known: Boolean(ep) };
            if (!ep && pjsip?.available) note('warn', `The dialplan dials PJSIP/${d.endpoint}${d.via ? ` (the value of ${d.via})` : ''} (context ${c.name}, extension ${ext.pattern}), but Asterisk has no endpoint of that name.`);
          } else if (d.kind === 'dynamic') {
            id = 'tg:dynamic';
            node = { id, kind: 'dynamic', name: 'any endpoint (chosen at run time)', state: null, role: null, known: true };
          } else if (d.kind === 'local') {
            id = `tg:local:${d.context}`;
            node = { id, kind: 'local', name: `Local channel → ${d.context ?? '?'}`, state: null, role: null, known: true };
          } else {
            id = `tg:${d.tech}`;
            node = { id, kind: 'other', name: `${d.tech} channel`, state: null, role: null, known: true };
          }
          if (!targets.has(id)) targets.set(id, node);
          const key = `${c.name}|${id}`;
          const edge = dialEdges.get(key) ?? { from: `ctx:${c.name}`, to: id, kind: 'dial', patterns: [], count: 0 };
          if (!edge.patterns.includes(ext.pattern)) edge.patterns.push(ext.pattern);
          edge.count++;
          dialEdges.set(key, edge);
          ctxNode.get(c.name).dials++;
        }
        for (const j of stepJumps(dp, step, { context: c.name, exten: ext.pattern })) {
          if (j.missing) note('warn', `${c.name} ${ext.pattern} step ${step.prio} (${step.app}) jumps to ${j.context},${j.exten},${j.prio}: the ${j.missing} does not exist.`);
          else if (!j.dynamic && j.context !== c.name && !ctxNode.get(c.name).jumps.includes(j.context)) ctxNode.get(c.name).jumps.push(j.context);
        }
      }
    }
  }
  edges.push(...dialEdges.values());

  // A context is in use when an endpoint enters it or a context in use includes or jumps to it.
  const queue = contexts.filter(c => c.entries.length).map(c => c.name);
  while (queue.length) {
    const c = ctxNode.get(queue.pop());
    if (!c || c.reached) continue;
    c.reached = true;
    for (const next of [...c.includes, ...c.jumps]) if (ctxNode.has(next) && !ctxNode.get(next).reached) queue.push(next);
  }
  if (endpoints.length) {
    for (const c of contexts) if (!c.reached) note('info', `The context “${c.name}” is not used by any endpoint and nothing includes or jumps to it.`);
  }
  return { entries, contexts, targets: [...targets.values()], edges, findings };
}
//#endregion
