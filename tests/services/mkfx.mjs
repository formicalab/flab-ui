// Builds the fixtures of the Services backend test. Every scenario is a directory with the file names flab.services
// reads when FLAB_FIXTURES is set (see rpcd/lib/flab/util.uc), so the plugin never runs a command: it only
// finds, in the fixture folder, what the command would have printed. Also writes cases.json for harness.uc.
// Scenarios differ in what an init script does: ok (exit 0), fail (exit 1), timeout (exit 124), noresult (no
// exit code at all).
// Usage: node mkfx.mjs <output dir>
import fs from 'node:fs';
import path from 'node:path';
import { CASES, INSTALLED, JUNK, LIST_CMD, NETSTAT, NETSTAT_CMD, OUTPUT_CMD, RANGE_CMD, RC, RC_CMD, slug, waitCmd } from './cases.mjs';

const root = process.argv[2];

// The scenarios: the exit code and the output the scripts produce.
const SCENARIOS = {
  ok: { code: '0\n', output: 'Restarting service\n' },
  fail: { code: '1\n', output: 'Failed to start: bad config\n' },
  timeout: { code: '124\n', output: '' },
  noresult: { code: '', output: '' },
};

// Writes one scenario: the listing, and a result for the command line of every call in CASES (valid or not, so a
// refused call that was run anyway would be answered, and shows up in the checks).
function scenario(name, { code, output }) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
    // Writes `text` as the fixture of command `cmd`.
  const put = (cmd, text) => fs.writeFileSync(path.join(dir, slug(cmd)), text);
  put(LIST_CMD, [...INSTALLED, ...JUNK].sort().join('\n') + '\n');
  put(RC_CMD, RC.join('\n') + '\n');
  put(NETSTAT_CMD, NETSTAT);
  put(RANGE_CMD, '32768\t60999\n');
  put(OUTPUT_CMD, output);
  for (const c of CASES) {
    if (typeof c.args.name === 'string' && typeof c.args.action === 'string') put(waitCmd(c.args.name, c.args.action), code);
  }
}

fs.mkdirSync(root, { recursive: true });
for (const [name, spec] of Object.entries(SCENARIOS)) scenario(name, spec);
fs.writeFileSync(path.join(root, 'cases.json'), JSON.stringify(CASES));
