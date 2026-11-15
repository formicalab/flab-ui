// Browser test for the network board (the Devices and Interfaces page) that does not depend on what the panels contain: the layout at several widths
// in both themes (no horizontal scrolling, nothing overflowing or overlapping, four lanes with connectors on wide screens, stacked lanes on narrow
// ones), the highlighting of a card's chain, the drawer (a click opens it, Escape and the close button close it, a poll keeps it open, leaving the
// page closes it), the Device menu, the old #bridges route and the Network-wide settings button. A real browser opens the deployed UI against the real
// router, READ ONLY: every uci write that might be sent is blocked and fails the test (the draft is only in the page; nothing is saved).
// Usage: node live.mjs   (env: FLAB_SID and FLAB_ACLS from tests/TestSession.ps1, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import path from 'node:path';

const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;
const acls = JSON.parse(process.env.FLAB_ACLS);
const shots = process.env.FLAB_SHOTS;
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

const browser = await chromium.launch({ channel: 'msedge' });
const errors = [];
const unsafe = [];

// Opens the page signed in (the session in sessionStorage, as a real sign-in leaves it) at a width in a theme; writes are blocked.
async function open(width, scheme, hash = 'interfaces') {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme });
  await ctx.route('**/ubus', route => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
    if (body?.params?.[1] === 'uci' && WRITES.includes(body.params[2])) { unsafe.push(body.params[2]); return route.abort(); }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => { errors.push(String(e)); console.log(`PAGE ERROR ${e}`); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log(`CONSOLE ERROR ${m.text()}`); } });
  await page.addInitScript(([id, a]) => { sessionStorage.setItem('sid', id); sessionStorage.setItem('acls', JSON.stringify(a)); }, [sid, acls]);
  await page.goto(`${baseUrl}#${hash}`);
  await page.waitForSelector('.nb-card', { timeout: 20000 });
  // The connectors are drawn after the first layout.
  await page.waitForTimeout(800);
  return { ctx, page };
}

// Two boxes overlap when they share an area (a pixel of slack for borders).
const overlap = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

//#region Layout
for (const width of [1920, 1280, 900]) {
  for (const scheme of ['light', 'dark']) {
    console.log(`\n== ${width} px, ${scheme} ==`);
    const { ctx, page } = await open(width, scheme);
    const label = `${width} ${scheme}`;
    const wide = await page.evaluate(() => document.querySelector('.nb').getBoundingClientRect().width >= 760);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: the page does not scroll sideways`, await page.evaluate(() => `${document.documentElement.scrollWidth} > ${innerWidth}`));
    const cut = await page.evaluate(() => [...document.querySelectorAll('.nb-card')].filter(c => c.scrollWidth > c.clientWidth + 1).map(c => c.dataset.id));
    check(cut.length === 0, `${label}: no card has text that overflows it`, cut.join());
    // Nothing overlaps its neighbours: the cards of one lane are in a column, and every card stays inside its lane.
    const geometry = await page.evaluate(() => [...document.querySelectorAll('.nb-lane')].map(lane => ({
      lane: lane.getBoundingClientRect().toJSON(),
      cards: [...lane.querySelectorAll('.nb-card')].map(c => ({ id: c.dataset.id, ...c.getBoundingClientRect().toJSON() })),
    })));
    let overlapping = '';
    let outside = '';
    for (const g of geometry) {
      for (let i = 0; i < g.cards.length; i++) {
        if (g.cards[i].x < g.lane.x - 1 || g.cards[i].x + g.cards[i].width > g.lane.x + g.lane.width + 1) outside += `${g.cards[i].id} `;
        for (let j = i + 1; j < g.cards.length; j++) if (overlap(g.cards[i], g.cards[j])) overlapping += `${g.cards[i].id}/${g.cards[j].id} `;
      }
    }
    check(!overlapping && !outside, `${label}: no cards overlap and every card stays inside its lane`, `${overlapping}| ${outside}`);
    const lefts = await page.evaluate(() => [...document.querySelectorAll('.nb-lane')].map(l => Math.round(l.getBoundingClientRect().left)));
    if (wide) {
      check(new Set(lefts).size === 4, `${label}: four lanes side by side`, lefts.join());
      check(await page.locator('.nb-svg path').count() >= 3, `${label}: connectors are drawn between the lanes`);
      // Every connector ends on the edge of a card.
      const loose = await page.evaluate(() => {
        const box = document.querySelector('.nb').getBoundingClientRect();
        const cards = [...document.querySelectorAll('.nb-card')].map(c => c.getBoundingClientRect());
        return [...document.querySelectorAll('.nb-svg circle')].filter(c => {
          const x = +c.getAttribute('cx') + box.left, y = +c.getAttribute('cy') + box.top;
          return !cards.some(r => Math.abs(x - r.left) < 2 || Math.abs(x - r.right) < 2) || !cards.some(r => y >= r.top - 1 && y <= r.bottom + 1);
        }).length;
      });
      check(loose === 0, `${label}: every connector starts and ends on the side of a card`, String(loose));
    } else {
      check(new Set(lefts).size === 1 && await page.locator('.nb-svg').evaluate(e => getComputedStyle(e).display) === 'none', `${label}: the lanes are stacked and the connectors are off`, lefts.join());
    }
    if (shots) await page.screenshot({ path: path.join(shots, `netboard-${width}-${scheme}.png`), fullPage: true });
    await ctx.close();
  }
}
//#endregion

//#region Highlighting, the drawer, the Device menu
console.log('\n== highlighting and the drawer ==');
const { ctx, page } = await open(1920, 'light');
const iface = page.locator('.nb-lane-interfaces .nb-card').first();
const first = await iface.getAttribute('data-id');
await iface.hover();
check(await page.locator('.nb').evaluate(e => e.classList.contains('nb-focus')) && await page.locator('.nb-card.nb-rel').count() >= 2 && await page.locator(`.nb-card[data-id="${first}"]`).evaluate(e => e.classList.contains('nb-self')), 'hovering a card highlights it and what it is connected to');
check(await page.locator('.nb-edge.nb-hl').count() >= 1, 'and its connectors');
check(await page.locator('.nb-card:not(.nb-rel)').first().evaluate(e => +getComputedStyle(e).opacity < 1), 'the other cards step back');
await page.mouse.move(2, 2);
check(await page.locator('.nb-card.nb-rel').count() === 0 && await page.locator('.nb-edge.nb-hl').count() === 0, 'moving away removes the highlighting');

check(await page.locator('.fl-drawer').count() === 0, 'no drawer until a card is clicked');
await iface.click({ position: { x: 6, y: 6 } });
await page.waitForSelector('.fl-drawer.show');
const title = await page.locator('.fl-drawer .fl-drawer-title').innerText();
check(title.length > 0 && await page.locator('.fl-drawer .fl-drawer-body').count() === 1 && await page.locator('body.fl-drawer-open').count() === 1, 'a click opens the drawer with a title and a body');
check(await iface.evaluate(e => e.classList.contains('nb-sel')) && await page.locator('.nb-card.nb-rel').count() >= 2, 'the open card stays selected and its chain stays highlighted');
const drawerBox = await page.locator('.fl-drawer').boundingBox();
check(drawerBox.x + drawerBox.width >= 1919 && drawerBox.height >= 990 && drawerBox.width >= 480 && drawerBox.width <= 560, 'the drawer is a full-height panel on the right edge, about 34 rem wide', JSON.stringify(drawerBox));
check(await page.locator('.nb').evaluate(e => e.getBoundingClientRect().right <= document.querySelector('.fl-drawer').getBoundingClientRect().left + 1), 'on a wide screen the board makes room: the drawer does not cover it');
await page.locator('.nb-lane-interfaces .nb-card').nth(1).click({ position: { x: 6, y: 6 } });
await page.waitForTimeout(300);
check(await page.locator('.fl-drawer').count() === 1 && await page.locator('.nb-card.nb-sel').count() === 1, 'clicking another card shows it in the same drawer');
await page.locator('.fl-drawer .fl-drawer-body').evaluate(e => { e.scrollTop = 80; });
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(1500);
check(await page.locator('.fl-drawer').count() === 1 && await page.locator('.nb-card.nb-sel').count() === 1, 'a poll or a refresh keeps the drawer open on the same item');
await page.keyboard.press('Escape');
check(await page.locator('.fl-drawer').count() === 0 && await page.locator('body.fl-drawer-open').count() === 0 && await page.locator('.nb-card.nb-sel').count() === 0, 'Escape closes the drawer and clears the selection');
await iface.click({ position: { x: 6, y: 6 } });
await page.waitForSelector('.fl-drawer.show');
await page.click('.fl-drawer .btn-close');
check(await page.locator('.fl-drawer').count() === 0, 'the close button closes it');
await page.locator('.nb-lane-zones .nb-card').first().click({ position: { x: 6, y: 6 } });
await page.waitForSelector('.fl-drawer.show');
check(/Firewall page/.test(await page.locator('.fl-drawer').innerText()) && await page.locator('.fl-drawer a[href="#firewall"]').count() === 1, 'a firewall zone opens a read-only recap with a link to the Firewall page');
await page.click('.fl-drawer .btn-close');

console.log('\n== the Device menu, the wizard button and Network-wide settings ==');
await page.locator('.nb-lane-devices .nb-menu-wrap > button').click();
check(await page.locator('.nb-menu-item').count() === 3 && await page.locator('.nb-menu').isVisible(), 'the Device menu offers a bridge, a VLAN device and port settings');
await page.keyboard.press('Escape');
check(await page.locator('.nb-menu').isHidden(), 'Escape closes the menu');
await page.locator('.nb-lane-devices .nb-menu-wrap > button').click();
await page.locator('.nb-legend').click({ position: { x: 4, y: 4 } });
check(await page.locator('.nb-menu').isHidden(), 'a click elsewhere closes it too');
await page.locator('.nb-lane-devices .nb-menu-wrap > button').click();
await page.locator('.nb-menu-item:has(strong:text-is("Bridge"))').click();
await page.waitForSelector('.fl-drawer.show');
check(await page.locator('.nb-lane-devices .nb-card.nb-new').count() === 1 && /new/.test(await page.locator('.nb-lane-devices .nb-card.nb-new').innerText()), 'adding a bridge puts a card marked new on the board and opens it');
check(await page.locator('.nb-card.nb-sel.nb-new').count() === 1, 'and selects it');
await page.keyboard.press('Escape');
check(await page.locator('.fl-drawer').count() === 0 && await page.locator('.nb-lane-devices .nb-card.nb-new').count() === 1, 'closing the panel keeps the draft: the new card stays');
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(900);
check(await page.locator('.nb-card.nb-new').count() === 0, 'Discard edits removes it');
await page.locator('.nb-toolbar button:has-text("Network-wide settings")').click();
await page.waitForSelector('.fl-drawer.show');
check((await page.locator('.fl-drawer .fl-drawer-title').innerText()).length > 0 && await page.locator('.nb-card.nb-sel').count() === 0, 'Network-wide settings opens a panel and selects no card');
await page.click('.fl-drawer .btn-close');
if (shots) await page.screenshot({ path: path.join(shots, 'netboard-final.png') });

console.log('\n== leaving the page, the old Bridges route ==');
await iface.click({ position: { x: 6, y: 6 } });
await page.waitForSelector('.fl-drawer.show');
await page.click('a[href="#network"]');
await page.waitForSelector('.port-ic');
check(await page.locator('.fl-drawer').count() === 0 && await page.locator('body.fl-drawer-open').count() === 0, 'leaving the page closes the drawer');
await page.evaluate(() => { location.hash = 'bridges'; });
await page.waitForFunction(() => location.hash === '#interfaces', null, { timeout: 5000 });
await page.waitForSelector('.nb-card');
check(await page.locator('.nav-pane a[href="#bridges"]').count() === 0 && await page.locator('.nav-pane a.active:has-text("Devices and Interfaces")').count() === 1, '#bridges opens the Devices and Interfaces page; the navigation lists no Bridges page');
await ctx.close();
//#endregion

check(unsafe.length === 0, 'no uci write reached the router', unsafe.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall network board browser checks passed');
process.exit(failed ? 1 : 0);
