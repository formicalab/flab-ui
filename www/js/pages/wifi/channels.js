// The geometry of Wi-Fi channels (pure: no DOM, no router), used by the Wi-Fi radios page and its unit test. A radio is an entry
// of the flab.radio status reply: its name is the `wifi-device` section of /etc/config/wireless, `config.channel` and
// `config.htmode` are what is configured, and `channels` lists what the regulatory domain allows
// ({ channel, freq, disabled, dfs, max_power }).
//
// A channel is chosen as a number or `auto`, at the width the radio's htmode says, so a channel is only offered when the
// whole block of that width fits around it in the regulatory domain. `spanOf()` tells the page which channels the radio
// would occupy, for the hover preview, and `channelCheck()` what is wrong with a choice. The draft, the review list and
// the operations are in model.js.

// Channel width in MHz of a `htmode` such as HT20, VHT80, HE160 or HT40+ (20 when it names none).
export function widthOf(htmode) {
  const m = /(\d+)[+-]?$/.exec(htmode ?? '');
  return m ? +m[1] : 20;
}

// Center frequency (MHz) of a channel number in a band, for channels the phy did not list.
const freqOf = (band, channel) => (band === '6g' ? 5950 : 5000) + 5 * channel;

// The channels a block of spectrum `lo`..`hi` (MHz) is made of and touches:
//   channels  the 20 MHz channels it is made of (the listed ones whose center is 10 MHz inside `lo`, then every 20 MHz)
//   inside    channels that are not part of it but lie entirely within it (on 2.4 GHz, the ones between the two halves
//             of a 40 MHz block)
//   overlap   channels that stick out of it, so they are only partly covered
function blockOf(list, lo, hi) {
  const channels = list.filter(c => c.freq > lo && c.freq < hi && (c.freq - lo - 10) % 20 === 0).map(c => c.channel);
  const rest = list.filter(c => !channels.includes(c.channel));
  const inside = rest.filter(c => c.freq - 10 >= lo && c.freq + 10 <= hi).map(c => c.channel);
  const overlap = rest.filter(c => c.freq + 10 > lo && c.freq - 10 < hi && !inside.includes(c.channel)).map(c => c.channel);
  return { channels, inside, overlap };
}

// Which side of a 40 MHz channel on 2.4 GHz the second 20 MHz channel is on, the way netifd decides it
// (/lib/netifd/wireless/mac80211.sh): an explicit HT40+ or HT40- in the htmode wins, otherwise channels 1-6 use the
// one above and channels 7-13 the one below.
const secondaryOf = (htmode, channel) => /40\+$/.test(htmode ?? '') ? 'above' : /40-$/.test(htmode ?? '') ? 'below' : channel < 7 ? 'above' : 'below';

// The channels a radio would occupy on `channel` at `width` MHz:
//   { fits, channels, inside, overlap, lo, hi, secondary }
//     channels   the 20 MHz channels the block is made of (one for 20 MHz, two for 40 MHz, ...)
//     inside     channels fully within the block that are not part of it, and overlap channels partly covered by it
//                (both only on 2.4 GHz, where channel numbers are 5 MHz apart and a 20 MHz channel is four numbers wide)
//     lo, hi     the frequency range of the block in MHz
//     secondary  'above' or 'below': where the second half of a 40 MHz block on 2.4 GHz is (null otherwise)
//     fits       every 20 MHz channel of the block is allowed here
// 5 GHz and 6 GHz use fixed blocks (for example 36-48 for 80 MHz, 100-128 for 160 MHz). On 2.4 GHz a 40 MHz block is
// the channel and the one four channel numbers above or below it: adjacent in frequency (the two halves touch), four
// numbers apart in numbering, so for example channel 4 with channel 8 covers 2417-2457 MHz.
export function spanOf(radio, channel, width = widthOf(radio.config?.htmode)) {
  const list = radio.channels ?? [];
  const byNo = new Map(list.map(c => [c.channel, c]));
  // Whether the radio offers channel `n` and it is not disabled by the regulatory domain.
  const usable = n => byNo.has(n) && !byNo.get(n).disabled;
  const me = byNo.get(channel);
  if (!me) return { fits: false, channels: [], inside: [], overlap: [], lo: null, hi: null, secondary: null };
  // Result for the block lo..hi: whether it fits, its channels split into inside/overlap, and the secondary channel.
  const build = (fits, lo, hi, secondary = null) => ({ fits, ...blockOf(list, lo, hi), lo, hi, secondary });

  if (radio.band === '2g') {
    if (width <= 20) return build(usable(channel), me.freq - 10, me.freq + 10);
    const secondary = secondaryOf(radio.config?.htmode, channel);
    const lo = secondary === 'above' ? me.freq - 10 : me.freq - 30;
    return build(width === 40 && usable(channel) && usable(channel + (secondary === 'above' ? 4 : -4)), lo, lo + 40, secondary);
  }

  const n = Math.max(1, width / 20);
  const band = radio.band ?? (me.freq > 5900 ? '6g' : '5g');
  const start = band === '6g' ? 1 : channel < 100 ? 36 : channel < 149 ? 100 : 149;
  const index = (channel - start) / 4;
  if (!Number.isInteger(index) || index < 0) return build(false, me.freq - 10, me.freq + 10);
  const first = start + Math.floor(index / n) * n * 4;
  const members = Array.from({ length: n }, (_, k) => first + 4 * k);
  const lo = (byNo.get(first)?.freq ?? freqOf(band, first)) - 10;
  const hi = (byNo.get(members.at(-1))?.freq ?? freqOf(band, members.at(-1))) + 10;
  return build(members.every(usable), lo, hi);
}

// The block a radio is running on right now, as { channels, inside, overlap } (see spanOf): its live center frequency
// and width say where it is. Empty lists when the radio is not running.
export function runningBlock(radio) {
  const { center, width } = radio.live ?? {};
  if (center == null || !width) return { channels: [], inside: [], overlap: [] };
  return blockOf(radio.channels ?? [], center - width / 2, center + width / 2);
}

// Whether `channel` may be chosen on this radio: allowed by the regulatory domain and with room for the width.
export const canUse = (radio, channel) => {
  const c = radio.channels?.find(x => x.channel === channel);
  return Boolean(c && !c.disabled && spanOf(radio, channel).fits);
};

// Whether the page can offer channels for a radio: the phy listed them.
export const editable = radio => Boolean(radio.channels?.length);

// The channel option of a radio as a string: a number, or `auto` when none is configured.
export const channelOf = radio => String(radio.config?.channel ?? 'auto');

// Checks choosing `channel` (a number or `auto`, as a string) for `radio` while it runs in `htmode`: returns { error?, warnings }.
// An error means the channel cannot be used: the regulatory domain does not allow it, or the whole block of the htmode's width
// does not fit around it. The warnings are about radar (DFS) channels, which need an availability check before clients can
// connect, and about `auto`.
export function channelCheck(radio, channel, htmode) {
  const name = radio.name;
  if (channel === 'auto') return { warnings: [`${name}: with channel auto the radio picks its own channel when it starts, so it may land on a different one than its neighbors.`] };
  if (!/^\d+$/.test(channel) || !radio.channels?.some(x => x.channel === +channel && !x.disabled)) {
    return { error: `${name}: channel ${channel} is not allowed on this radio in the current regulatory domain.`, warnings: [] };
  }
  // The radio as it would run: its geometry depends on the htmode (the width, and on 2.4 GHz the side of a 40 MHz block).
  const span = spanOf({ ...radio, config: { ...radio.config, htmode } }, +channel);
  const width = widthOf(htmode);
  if (!span.fits) {
    return { error: `${name}: channel ${channel} cannot carry ${htmode || 'the driver default mode'} (${width} MHz): the whole ${width} MHz block around it must be allowed. Choose another channel or a narrower mode.`, warnings: [] };
  }
  const dfs = span.channels.some(n => radio.channels.find(x => x.channel === n)?.dfs);
  return { warnings: dfs ? [`${name}: channel ${channel} is a radar (DFS) channel. The radio listens for radar for 1 to 10 minutes before clients can connect, and it moves away if radar is detected.`] : [] };
}
