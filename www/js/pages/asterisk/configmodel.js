// Pure reading of an Asterisk configuration file for the Config tab: line kinds for coloring and the sections for the index. The text is what
// `flab.asterisk config` returns (secrets already redacted, line numbers unchanged).

// Lines of `text` as [{ no, text, kind, name?, type? }]. Kinds: blank, comment, section ([name]), exten (exten/same lines of the dialplan),
// include (#include, #exec), option (key = value) and other. `;--` ... `--;` blocks are comments.
export function readLines(text) {
  const out = [];
  let block = false;
  (text ?? '').split('\n').forEach((raw, i) => {
    const line = { no: i + 1, text: raw, kind: 'other' };
    const t = raw.trim();
    if (block) {
      line.kind = 'comment';
      if (t.includes('--;')) block = false;
    } else if (t.startsWith(';--')) {
      line.kind = 'comment';
      block = !t.slice(3).includes('--;');
    } else if (t === '') line.kind = 'blank';
    else if (t.startsWith(';')) line.kind = 'comment';
    else if (/^#(include|exec|tryinclude)\b/.test(t)) line.kind = 'include';
    else if (/^\[[^\]]*\]/.test(t)) {
      line.kind = 'section';
      line.name = /^\[([^\]]*)\]/.exec(t)[1];
    } else if (/^(exten|same)\s*=>/.test(t)) line.kind = 'exten';
    else if (/^[A-Za-z0-9_.-]+\s*=>?\s*/.test(t)) line.kind = 'option';
    out.push(line);
  });
  return out;
}

// The sections of a file: [{ name, type, line }]. pjsip.conf may repeat a name for objects of different types, so the type (the first
// `type =` option in the section) tells them apart.
export function sections(lines) {
  const out = [];
  let current = null;
  for (const l of lines) {
    if (l.kind === 'section') {
      current = { name: l.name, type: null, line: l.no };
      out.push(current);
    } else if (current && current.type == null && l.kind === 'option') {
      const m = /^type\s*=\s*([A-Za-z_]+)/.exec(l.text.trim());
      if (m) current.type = m[1];
    }
  }
  return out;
}

// Splits an option line into [key, separator, value, comment]; the comment is what follows an unquoted ";".
export function splitOption(text) {
  const m = /^(\s*)([A-Za-z0-9_.-]+)(\s*=>?\s*)(.*?)(\s*;.*)?$/.exec(text);
  return m ? { indent: m[1], key: m[2], sep: m[3], value: m[4], comment: m[5] ?? '' } : null;
}
