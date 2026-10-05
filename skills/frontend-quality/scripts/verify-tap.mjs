#!/usr/bin/env node
/**
 * Touch targets: checked with a REAL tap, not with layout numbers.
 *
 * Why a separate script. Measuring the box lies twice over. First, `click({force})`
 * in Playwright lands exactly in the centre of an element and physically cannot
 * show that the hit area ends right next to the label. Second, negative margins
 * (`-mx-3`) do not widen the box, they move it: the "enlarged" target stays the
 * same size.
 *
 * Worse than the size is WHERE a miss goes. A tap next to an item's status that
 * lands on the row opens the modifiers sheet — to the user that reads as "it did
 * not work", not as "I missed". Hence two questions:
 *   1. does the target cover its own visible area (corners inside the box);
 *   2. what a miss 8 pixels outside lands on — nothing, or SOMEONE ELSE'S action.
 *
 * How this stays side-effect free. The tap is dispatched for real, through CDP
 * `Input.dispatchTouchEvent` — with genuine hit testing, `touch-action` and
 * overlays. But a capture-phase sink sits on the window and swallows the event:
 * the application never reaches its own handlers, state does not change, and we
 * still learn whose element would have received the tap.
 *
 * Usage:
 *   node verify-tap.mjs --url http://localhost:3000
 *   node verify-tap.mjs --scenario ./perf/order-screen.mjs --limit 40
 *   node verify-tap.mjs --scenario ./perf/order-screen.mjs --gestures
 *
 * --gestures runs three real gestures with live handlers instead (see below):
 * a short tap, a 650 ms hold, and a swipe with momentum followed by a quick tap.
 *
 * Touch goes through CDP, so both modes need Chromium. On another engine the
 * target is reported as "skipped on <engine>" and does not fail the run.
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, loadConfig, resolveTargets, closeQuietly, openCDP } from './lib/session.mjs';

const INTERACTIVE =
  'a[href], button, [role="button"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Below this size the finger misses. The number comes from interface guidelines
// and from real misses in the field, not from taste.
const MIN_TOUCH_PX = 44;
// How far outside the target a miss is probed.
const HALO_PX = 8;

/** The sink: a real tap reaches hit testing, but never the application. */
const INSTALL_SINK = (interactiveSelector) => {
  window.__tap = { hits: [] };
  window.__tapSelector = interactiveSelector;
  const record = (event) => {
    const el = event.target instanceof Element ? event.target : null;
    const owner = el ? el.closest(window.__tapSelector) : null;
    const box = owner ? owner.getBoundingClientRect() : null;
    window.__tap.hits.push({
      probe: owner ? owner.getAttribute('data-tap-probe') : null,
      ownerTag: owner ? owner.tagName.toLowerCase() : null,
      ownerLabel: owner
        ? (owner.getAttribute('aria-label') || owner.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 40)
        : null,
      ownerArea: box ? Math.round(box.width * box.height) : 0,
      hitTag: el ? el.tagName.toLowerCase() : null,
    });
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  };
  for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    window.addEventListener(type, record, { capture: true });
  }
};

async function collectTargets(page, limit) {
  return page.evaluate(
    ({ selector, limit }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
      };
      const all = Array.from(document.querySelectorAll(selector)).filter(visible);
      const items = [];
      all
        // Nested interactive elements (a button inside a link) add noise: take the
        // outer one, the inner gets its own row in the report.
        .filter((el) => !all.some((other) => other !== el && other.contains(el)))
        .slice(0, limit)
        .forEach((el, index) => {
          el.setAttribute('data-tap-probe', String(index));
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          items.push({
            probe: String(index),
            tag: el.tagName.toLowerCase(),
            label:
              (el.getAttribute('aria-label') || el.textContent || '')
                .trim()
                .replace(/\s+/g, ' ')
                .slice(0, 40) || '(unnamed)',
            x: r.x,
            y: r.y,
            width: Math.round(r.width),
            height: Math.round(r.height),
            // Hit testing respects rounding: on a pill the geometric corner lies
            // OUTSIDE the shape, and a tap there legitimately goes to the parent.
            // The radius is needed to probe corners inside the shape instead.
            radius: Math.min(parseFloat(s.borderTopLeftRadius) || 0, Math.min(r.width, r.height) / 2),
            // A disabled element is not meant to catch taps — not a target defect.
            disabled:
              el.hasAttribute('disabled') ||
              el.getAttribute('aria-disabled') === 'true' ||
              s.pointerEvents === 'none',
          });
        });
      return items;
    },
    { selector: INTERACTIVE, limit }
  );
}

/** Probe points: centre and corners INSIDE the target, plus four misses outside. */
function probePoints(target) {
  const { x, y, width, height, radius } = target;
  // A point on the rounding arc: shifting the radius inwards along both axes
  // lands inside the shape, whatever the rounding — from a square corner to a pill.
  const inset = 3 + Math.round((radius || 0) * 0.3);
  return {
    inner: [
      { kind: 'centre', x: x + width / 2, y: y + height / 2 },
      { kind: 'left edge', x: x + 3, y: y + height / 2 },
      { kind: 'right edge', x: x + width - 3, y: y + height / 2 },
      { kind: 'top edge', x: x + width / 2, y: y + 3 },
      { kind: 'bottom edge', x: x + width / 2, y: y + height - 3 },
      { kind: 'top-left corner', x: x + inset, y: y + inset },
      { kind: 'bottom-right corner', x: x + width - inset, y: y + height - inset },
    ],
    outer: [
      { kind: 'miss on the left', x: x - HALO_PX, y: y + height / 2 },
      { kind: 'miss on the right', x: x + width + HALO_PX, y: y + height / 2 },
      { kind: 'miss above', x: x + width / 2, y: y - HALO_PX },
      { kind: 'miss below', x: x + width / 2, y: y + height + HALO_PX },
    ],
  };
}

async function tapAt(cdp, page, point) {
  const size = page.viewportSize() || { width: 390, height: 844 };
  if (point.x < 1 || point.y < 1 || point.x > size.width - 1 || point.y > size.height - 1) return null;
  await page.evaluate(() => {
    window.__tap.hits = [];
  });
  const touchPoint = { x: Math.round(point.x), y: Math.round(point.y) };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(20);
  const hits = await page.evaluate(() => window.__tap.hits);
  return hits.find((h) => h.probe !== null) || hits[0] || null;
}

/**
 * Gesture mode: reproduces the mechanics of the most frequent failure of all —
 * a tap that disappears, fires twice or lands on someone else.
 *
 * Three gestures, each with its own known failure:
 *
 * 1. TAP (touch held 90 ms). If the DOM changes under the finger between
 *    `touchstart` and `touchend` (lazily mounted swipe pills, a re-render from a
 *    gesture handler), the browser does NOT synthesise `click` — the tap vanishes
 *    silently. On desktop the mouse never goes through `touchstart`, hence
 *    "perfect on a laptop, needs two taps on a phone".
 *
 * 2. HOLD (touch held 650 ms). A long-press menu opens under a finger that is
 *    still down. On release the browser synthesises `click` at the same point; it
 *    lands on the backdrop or an item of the fresh menu and closes or fires it.
 *    Android also sends `contextmenu` to whatever is under the finger when the
 *    long press fires — that is the node that has just appeared. Headless
 *    Chromium does not send `contextmenu` for a CDP touch, so the check sends it
 *    itself, to the element under the finger, exactly as Android would.
 *    The fix is to swallow both tails at the document level for the gesture that
 *    opened the menu.
 *
 * 3. SWIPE, THEN TAP within 200 ms. While a list is still gliding after a swipe,
 *    the browser treats the next touch as "stop the scroll" and synthesises no
 *    `click`. A button revealed by the swipe needs two taps. The fix is to act on
 *    `touchend` for such buttons (short, finger stationary, started on the
 *    button) and suppress the click that may follow.
 *
 * Application handlers are NOT swallowed here: otherwise there is nothing to
 * observe. So this run does change application state — hence a separate flag.
 * When a gesture adds or removes nodes or navigates, the target is driven back
 * to its initial state before the next probe.
 */
const INSTALL_GESTURE_WATCH = () => {
  const fresh = {
    mutations: 0,
    structural: 0,
    clicks: 0,
    watching: false,
    pressed: null,
    clickProbe: null,
    clickLabel: null,
    clickForeign: false,
    clickReached: false,
    mutationsAtClick: 0,
    menus: [],
  };
  if (window.__gesture) {
    Object.assign(window.__gesture, fresh);
    return;
  }
  window.__gesture = fresh;
  const label = (el) =>
    el ? (el.getAttribute('aria-label') || el.textContent || el.tagName.toLowerCase()).trim().replace(/\s+/g, ' ').slice(0, 40) : null;
  // "Foreign" = neither the pressed element, nor inside it, nor one of its
  // ancestors. An ancestor (body, the list) is where a tap goes when nothing
  // claims it — that is not someone else's action.
  const foreign = (el) => {
    const pressed = window.__gesture.pressed;
    if (!el || !pressed) return false;
    return !pressed.contains(el) && !el.contains(pressed);
  };
  const observer = new MutationObserver((records) => {
    const g = window.__gesture;
    if (!g.watching) return;
    g.mutations += records.length;
    for (const r of records) if (r.type === 'childList') g.structural += 1;
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  window.addEventListener(
    'click',
    (event) => {
      const g = window.__gesture;
      g.clicks += 1;
      const el = event.target instanceof Element ? event.target : null;
      // Where the click landed matters as much as whether it arrived at all.
      g.clickProbe = el ? el.closest('[data-tap-probe]')?.getAttribute('data-tap-probe') ?? null : null;
      g.clickLabel = label(el);
      if (!foreign(el)) return;
      // A click on a foreign node is a defect only if the application let it
      // through and it did something: a menu that swallows the tail at the
      // document level, or a backdrop that ignores a click it did not see start,
      // is the correct fix and stays silent.
      g.clickForeign = true;
      g.mutationsAtClick = g.mutations;
      const mark = () => {
        g.clickReached = true;
      };
      el.addEventListener('click', mark);
      setTimeout(() => el.removeEventListener('click', mark), 0);
    },
    { capture: true }
  );
  window.addEventListener(
    'contextmenu',
    (event) => {
      const g = window.__gesture;
      if (!g.watching) return;
      const el = event.target instanceof Element ? event.target : null;
      const record = { label: label(el), foreign: foreign(el), reached: false, prevented: false, synthetic: !event.isTrusted };
      g.menus.push(record);
      // Did the event get as far as the node itself? A listener added to the
      // target during the capture phase runs when dispatch reaches it, and not at
      // all if the application stopped the event higher up.
      const mark = () => {
        record.reached = true;
      };
      if (el) el.addEventListener('contextmenu', mark);
      setTimeout(() => {
        record.prevented = event.defaultPrevented;
        if (el) el.removeEventListener('contextmenu', mark);
      }, 0);
    },
    { capture: true }
  );
};

const HOLD_MS = 650;
const SWIPE_TAP_LIMIT_MS = 200;

async function startWatch(page, item) {
  await page.evaluate((probe) => {
    const g = window.__gesture;
    Object.assign(g, {
      mutations: 0,
      structural: 0,
      clicks: 0,
      clickProbe: null,
      clickLabel: null,
      clickForeign: false,
      clickReached: false,
      mutationsAtClick: 0,
      menus: [],
      pressed: probe === null ? null : document.querySelector(`[data-tap-probe="${probe}"]`),
      watching: true,
    });
  }, item ? item.probe : null);
}

async function stopWatch(page) {
  return page.evaluate(() => {
    const g = window.__gesture;
    g.watching = false;
    return {
      clicks: g.clicks,
      mutations: g.mutations,
      structural: g.structural,
      clickProbe: g.clickProbe ?? null,
      clickLabel: g.clickLabel ?? null,
      clickForeign: g.clickForeign,
      clickActed: g.clickForeign && g.clickReached && g.mutations > g.mutationsAtClick,
      menus: g.menus.map((m) => ({ ...m })),
    };
  });
}

const centreOf = (item) => ({ x: Math.round(item.x + item.width / 2), y: Math.round(item.y + item.height / 2) });

async function probeTap(cdp, page, item) {
  const point = centreOf(item);
  await startWatch(page, item);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(90);
  const duringGesture = await page.evaluate(() => window.__gesture.mutations);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);
  return { duringGesture, ...(await stopWatch(page)) };
}

async function probeHold(cdp, page, item) {
  const point = centreOf(item);
  await startWatch(page, item);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(HOLD_MS);
  // Android fires contextmenu at the element under the finger when the long
  // press is recognised. Headless Chromium does not; send it the same way.
  await page.evaluate(({ x, y }) => {
    if (window.__gesture.menus.length) return;
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2 })
    );
  }, point);
  await page.waitForTimeout(20);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);
  return stopWatch(page);
}

/** Scroll containers worth swiping: tall enough, really scrollable, with controls inside. */
async function findScrollers(page, selector) {
  return page.evaluate((selector) => {
    const visibleControl = (el, box) => {
      const r = el.getBoundingClientRect();
      return r.width >= 8 && r.height >= 8 && r.bottom > box.top && r.top < box.bottom;
    };
    const out = [];
    const candidates = [document.scrollingElement, ...document.querySelectorAll('*')];
    for (const el of candidates) {
      if (!el) continue;
      const isRoot = el === document.scrollingElement;
      if (!isRoot) {
        const s = getComputedStyle(el);
        if (!/(auto|scroll)/.test(s.overflowY)) continue;
      }
      const room = el.scrollHeight - el.clientHeight;
      if (room < 150) continue;
      const box = isRoot
        ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
        : el.getBoundingClientRect();
      const height = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
      if (height < 220) continue;
      const controls = Array.from(el.querySelectorAll(selector)).filter((c) => visibleControl(c, box));
      if (!controls.length) continue;
      const id = `s${out.length}`;
      if (!isRoot) el.setAttribute('data-tap-scroller', id);
      out.push({
        id: isRoot ? 'root' : id,
        label: isRoot ? 'the page' : `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
        top: Math.max(box.top, 0),
        bottom: Math.min(box.bottom, innerHeight),
        left: Math.max(box.left, 0),
        right: Math.min(box.right, innerWidth),
        area: height * (Math.min(box.right, innerWidth) - Math.max(box.left, 0)),
      });
    }
    // Larger first: the main list is where people swipe.
    return out.sort((a, b) => b.area - a.area).slice(0, 2);
  }, selector);
}

async function probeSwipeThenTap(cdp, page, scroller, selector) {
  const x = Math.round((scroller.left + scroller.right) / 2);
  const height = scroller.bottom - scroller.top;
  const startY = Math.round(scroller.top + height * 0.8);
  const distance = Math.round(Math.min(320, height * 0.6));
  const steps = 6;

  const scrollTopOf = () =>
    page.evaluate((id) => {
      const el = id === 'root' ? document.scrollingElement : document.querySelector(`[data-tap-scroller="${id}"]`);
      return el ? el.scrollTop : 0;
    }, scroller.id);
  const before = await scrollTopOf();

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
  for (let i = 1; i <= steps; i += 1) {
    await new Promise((r) => setTimeout(r, 8));
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: Math.round(startY - (distance * i) / steps) }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const releasedAt = Date.now();
  await page.waitForTimeout(40);

  // The control nearest to the middle of the container that a finger can hit right now.
  const target = await page.evaluate(
    ({ id, selector }) => {
      const root = id === 'root' ? document.scrollingElement : document.querySelector(`[data-tap-scroller="${id}"]`);
      if (!root) return null;
      const box = id === 'root' ? { top: 0, bottom: innerHeight } : root.getBoundingClientRect();
      const mid = (Math.max(box.top, 0) + Math.min(box.bottom, innerHeight)) / 2;
      let best = null;
      for (const el of root.querySelectorAll(selector)) {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cy < Math.max(box.top, 0) + 4 || cy > Math.min(box.bottom, innerHeight) - 4) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !el.contains(hit)) continue;
        const d = Math.abs(cy - mid);
        if (!best || d < best.d) best = { d, cx, cy, el };
      }
      if (!best) return null;
      best.el.setAttribute('data-tap-swipe-target', '1');
      return {
        x: Math.round(best.cx),
        y: Math.round(best.cy),
        label: (best.el.getAttribute('aria-label') || best.el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      };
    },
    { id: scroller.id, selector }
  );
  if (!target) return { skipped: 'no control under the finger after the swipe' };

  await page.evaluate(() => {
    const g = window.__gesture;
    Object.assign(g, { mutations: 0, structural: 0, clicks: 0, menus: [], clickForeign: false, clickReached: false, watching: true });
    g.pressed = document.querySelector('[data-tap-swipe-target]');
  });
  const delay = Date.now() - releasedAt;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);
  const result = await stopWatch(page);
  await page.evaluate(() => document.querySelector('[data-tap-swipe-target]')?.removeAttribute('data-tap-swipe-target'));
  const scrolled = (await scrollTopOf()) - before;
  return { ...result, delay, scrolled, label: target.label };
}

async function runGestures({ target, page, cdp, limit }) {
  const report = { block: 0, flag: 0 };
  const say = (severity, text) => {
    report[severity] += 1;
    console.log(`      ${severity === 'block' ? 'BLOCK' : 'FLAG '} ${text}`);
  };

  const restore = async () => {
    await target.ready(page).catch(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(INSTALL_GESTURE_WATCH).catch(() => {});
    return collectTargets(page, limit);
  };

  console.log('Gesture mode: handlers are live, application state changes.\n');
  let items = await collectTargets(page, limit);
  for (let index = 0; index < items.length; index += 1) {
    let item = items[index];
    if (item.disabled) continue;
    let header = false;
    const heading = () => {
      if (!header) console.log(`  ${item.tag} «${item.label}» ${item.width}×${item.height}`);
      header = true;
    };

    // 1. Tap.
    let url = page.url();
    const tap = await probeTap(cdp, page, item);
    if (tap.clicks === 0) {
      heading();
      say('block', 'tap: no click — on a phone the tap disappears silently');
    }
    // A click that lands off target matters precisely when something changed
    // under the finger: that is the signature of a re-render that swapped the
    // node and sent the action to a neighbour.
    if (tap.clicks > 0 && tap.duringGesture > 0 && tap.clickProbe !== item.probe) {
      heading();
      say('block', `tap: the click landed on “${tap.clickLabel || 'another element'}” instead of the target — the node changed under the finger`);
    }
    if (tap.clicks > 1) {
      heading();
      say('block', `tap: one touch produced ${tap.clicks} clicks — the action fires twice`);
    }
    if (tap.duringGesture > 0) {
      heading();
      say('flag', `tap: the DOM changed during the gesture (${tap.duringGesture} mutations between touch and release) — click may not be synthesised`);
    }
    if (page.url() !== url || tap.structural > 0) {
      items = await restore();
      item = items[index];
      if (!item) break;
    }

    // 2. Hold.
    url = page.url();
    const hold = await probeHold(cdp, page, item);
    if (hold.clickActed) {
      heading();
      say(
        'block',
        `hold ${HOLD_MS} ms: the click after release landed on “${hold.clickLabel || 'another element'}”, not on the pressed element, and acted — whatever appeared under the finger took the tap`
      );
    }
    const strayMenu = hold.menus.find((m) => m.foreign && m.reached && !m.prevented);
    if (strayMenu) {
      heading();
      say(
        'block',
        `hold ${HOLD_MS} ms: contextmenu reached “${strayMenu.label}”, which appeared under the finger during the hold, and nobody cancelled it — Android sends it there; swallow it at the document level${strayMenu.synthetic ? ' (event sent by the check, as Android would)' : ''}`
      );
    }
    if (page.url() !== url || hold.structural > 0) {
      items = await restore();
    }
  }

  // 3. Swipe with momentum, then a quick tap on a control the swipe revealed.
  const startUrl = page.url();
  const scrollers = await findScrollers(page, INTERACTIVE);
  for (const scroller of scrollers) {
    const result = await probeSwipeThenTap(cdp, page, scroller, INTERACTIVE);
    if (result.skipped) {
      console.log(`  swipe on ${scroller.label}: skipped — ${result.skipped}`);
      continue;
    }
    if (result.delay > SWIPE_TAP_LIMIT_MS) {
      console.log(`  swipe on ${scroller.label}: skipped — the tap came ${result.delay} ms after release, later than ${SWIPE_TAP_LIMIT_MS} ms (slow machine?)`);
      continue;
    }
    // No click AND no reaction: the tap was spent on stopping the glide. A
    // control that acts on touchend changes the page even without a click.
    const outcome =
      result.clicks > 0 ? 'click arrived' : result.mutations > 0 ? 'no click, the control reacted on touchend' : 'nothing happened';
    console.log(`  swipe on ${scroller.label} (moved ${result.scrolled}px), then tap on «${result.label}» ${result.delay} ms later: ${outcome}`);
    if (result.clicks === 0 && result.mutations === 0) {
      say(
        'flag',
        'swipe-then-tap: no click and no reaction — the browser took the tap as "stop scrolling"; act on touchend for controls revealed by a swipe'
      );
    }
    // A tap that navigated ends the probe: the next container belongs to another page.
    if (page.url() !== startUrl) break;
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const limit = Number(args.limit || 40);
  const outDir = resolve(args.out || '.uiverify-out/tap');
  mkdirSync(outDir, { recursive: true });

  const width = Number(args.width || 390);
  const height = Number(args.height || 844);
  // Fingers only exist on phones: the check runs in a mobile viewport with touch.
  const targets = await resolveTargets({ ...args, touch: true, width, height }, config);
  const gestures = args.gestures === true || args.gestures === 'true';

  let blocking = 0;
  let flagged = 0;
  // A run where the engine could not dispatch a single touch checked nothing.
  // "Blocking: 0" there would read as a pass, so it ends as "could not run".
  let checked = 0;

  for (const target of targets) {
    const opened = await target.open({ throttle: 1, viewport: { width, height } });
    const { page, context } = opened;
    try {
      console.log(`\n═══ ${target.name} ═══`);
      // Touch is dispatched through CDP: another engine gets one "skipped on" line.
      const cdp = await openCDP(context, page, gestures ? 'touch gestures (CDP touch dispatch)' : 'real taps (CDP touch dispatch)');
      if (!cdp) continue;
      checked += 1;
      await target.ready(page);
      await page.waitForTimeout(300);

      // Gesture mode works with LIVE handlers, so the sink that swallows events is
      // installed only in the regular mode.
      if (gestures) {
        await page.evaluate(INSTALL_GESTURE_WATCH);
        const report = await runGestures({ target, page, cdp, limit: Math.min(limit, 8) });
        blocking += report.block;
        flagged += report.flag;
        continue;
      }
      await page.evaluate(INSTALL_SINK, INTERACTIVE);

      const items = await collectTargets(page, limit);
      const view = page.viewportSize();
      console.log(`Elements under the finger: ${items.length}, viewport ${view?.width}×${view?.height}\n`);

      for (const item of items) {
        // A disabled button is not meant to accept taps: checking its target is
        // pointless, and reporting it drowns the real findings in noise.
        if (item.disabled) continue;

        const problems = [];
        const { inner, outer } = probePoints(item);
        const small = item.width < MIN_TOUCH_PX || item.height < MIN_TOUCH_PX;

        if (small) {
          problems.push({
            severity: 'block',
            text: `target ${item.width}×${item.height} is smaller than ${MIN_TOUCH_PX}px`,
          });
        }

        for (const point of inner) {
          const hit = await tapAt(cdp, page, point);
          if (!hit) continue;
          if (hit.probe === null) {
            problems.push({
              severity: 'block',
              text: `${point.kind}: the tap reached no interactive element at all`,
            });
          } else if (hit.probe !== item.probe) {
            problems.push({
              severity: 'block',
              text: `${point.kind}: the tap is taken by “${hit.ownerLabel}” — the target is covered`,
            });
          }
        }

        // A miss onto an equal neighbour is fine: keypad keys are meant to sit side
        // by side. The defect is a LARGE element with its own action next to a small
        // target: a tap next to the item status lands on the row and opens the
        // modifiers sheet, which the user reads as "it did not work".
        const itemArea = item.width * item.height;
        for (const point of outer) {
          const hit = await tapAt(cdp, page, point);
          if (!hit || hit.probe === null || hit.probe === item.probe) continue;
          if (hit.ownerArea < itemArea * 3) continue;
          problems.push({
            severity: small ? 'block' : 'flag',
            text: `${point.kind} (${HALO_PX}px): the miss lands on “${hit.ownerLabel}” — four times larger, its action wins`,
          });
        }

        if (!problems.length) continue;

        const shot = join(outDir, `tap-${item.probe}.png`);
        await page
          .locator(`[data-tap-probe="${item.probe}"]`)
          .screenshot({ path: shot })
          .catch(() => {});

        const blocks = problems.filter((p) => p.severity === 'block');
        blocking += blocks.length;
        flagged += problems.length - blocks.length;

        console.log(`  ${item.tag} «${item.label}» ${item.width}×${item.height}`);
        for (const problem of problems) {
          console.log(`      ${problem.severity === 'block' ? 'BLOCK' : 'FLAG '} ${problem.text}`);
        }
      }
    } finally {
      await closeQuietly(opened);
    }
  }

  if (!gestures) console.log(`\nCrops of problem targets: ${outDir}`);
  if (checked === 0) {
    console.log('\nNot checked: this engine cannot dispatch real touches. Run it in Chromium.');
    process.exit(2);
  }
  console.log(`\nBlocking: ${blocking} | warnings: ${flagged}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
