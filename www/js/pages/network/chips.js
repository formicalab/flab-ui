// Optional descriptions of well-known network chips, shown as a subtitle in the port topology. This is
// enrichment only: every fact that matters (which chip, which ports, which speeds, what is wired to what)
// comes from the router itself, so an unknown chip simply shows its name without a description. Matching is
// by substring on the name the router reports (PHY driver name or device-tree compatible, upper-cased).
const CHIPS = [
  [/MT7531/, 'Switch with 5 built-in Gigabit PHYs and two MAC ports that can run at 2.5 Gbit/s'],
  [/MT7530/, 'Switch with 5 built-in Gigabit PHYs'],
  [/RTL8221B|RTL8226|EN8811H/, 'Single-port 2.5GBASE-T PHY (10 Mbit/s to 2.5 Gbit/s)'],
  [/AQR\d+/, 'Multi-gigabit Ethernet PHY'],
];

// Description for a chip name as reported by the router, or '' when it is unknown or missing.
export const chipNote = name => (name ? CHIPS.find(([re]) => re.test(name.toUpperCase()))?.[1] ?? '' : '');
