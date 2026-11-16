// The editor of the wireless configuration (/etc/config/wireless), shared by the Wi-Fi radios page (the radios' own settings) and the Wi-Fi page (the
// wireless networks): one draft, one review banner, one Save, so edits made on one page survive a visit to the other. The configuration is read through
// the flab.radio plugin's `config` method, which leaves out every secret (the browser never calls `uci get` on this config), and written through
// core/uci.js applyChange(): stage, apply with the rollback countdown, read back, check the radios come up, confirm.
import { ubus, optional } from '../../core/ubus.js';
import { createEditor } from '../../core/editpage.js';
import { CONFIG, changesOf, checkApplied, draftFrom, isDirty, plan, problems, upTargets } from './model.js';
// How long to wait, after a change is applied, for the radios to come back up (the router undoes the change by itself 30
// seconds after the apply, so this must stay well below that), and how often to look.
const RADIO_WAIT_MS = 16000;
const RADIO_POLL_MS = 2000;

// Waits until every radio of `targets` ([{ radio, sections }], see upTargets) is up again after the change, with the networks that
// were added or changed running, or throws, which makes the change be undone.
async function waitForRadios(targets) {
  if (!targets.length) return;
  const deadline = Date.now() + RADIO_WAIT_MS;
  for (;;) {
    const hw = await optional(ubus('flab.radio', 'status'));
    const down = targets.filter(t => {
      const r = hw?.radios?.find(x => x.name === t.radio);
      return !(r?.up && !r.pending && !r.retry_failed && t.sections.every(s => r.interfaces.find(i => i.section === s)?.up));
    });
    if (!down.length) return;
    if (Date.now() > deadline) throw new Error(`${down.map(t => t.radio).join(', ')} did not come back up after the change, so it was undone.`);
    await new Promise(resolve => setTimeout(resolve, RADIO_POLL_MS));
  }
}

// The draft, the review banner, saving and discarding, shared with the other editing pages (core/editpage.js). What it edits
// is the radios and the wireless networks. It reads back through the plugin, never `uci get`, because the config holds the Wi-Fi keys.
export const editor = createEditor({
  config: CONFIG,
  readAfter: () => ubus('flab.radio', 'config'),
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: async (base, draft, after) => {
    checkApplied(base, draft, after);
    await waitForRadios(upTargets(base, draft, after));
  },
});
