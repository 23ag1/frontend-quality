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
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, loadConfig, resolveTargets, closeQuietly } from './lib/session.mjs';

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
 * a tap that disappears or fires twice.
 *
 * The cause, found once by experiment: if the DOM changes under the finger
 * between `touchstart` and `touchend` (lazily mounted swipe pills, a re-render
 * from a gesture handler), the browser does NOT synthesise `click` — and the tap
 * vanishes silently. On desktop the mouse never goes through `touchstart`, hence
 * "perfect on a laptop, needs two taps on a phone".
 *
 * Application handlers are NOT swallowed here: otherwise there is nothing to
 * observe. So this run does change application state — hence a separate flag.
 */
const INSTALL_GESTURE_WATCH = () => {
  window.__gesture = { mutations: 0, clicks: 0, watching: false };
  const observer = new MutationObserver((records) => {
    if (!window.__gesture.watching) return;
    window.__gesture.mutations += records.length;
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener(
    'click',
    (event) => {
      window.__gesture.clicks += 1;
      const el = event.target instanceof Element ? event.target : null;
      // Where the click landed matters as much as whether it arrived at all.
      // A ghost click after a long press used to land on the backdrop of the menu
      // that had just opened and closed it instantly: the user never got to press.
      window.__gesture.clickProbe = el ? el.closest('[data-tap-probe]')?.getAttribute('data-tap-probe') ?? null : null;
      window.__gesture.clickLabel = el
        ? (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
        : null;
    },
    { capture: true }
  );
};

async function probeGesture(cdp, page, item) {
  const point = { x: Math.round(item.x + item.width / 2), y: Math.round(item.y + item.height / 2) };
  await page.evaluate(() => {
    window.__gesture.mutations = 0;
    window.__gesture.clicks = 0;
    window.__gesture.watching = true;
  });

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(90);
  const duringGesture = await page.evaluate(() => window.__gesture.mutations);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);

  const after = await page.evaluate(() => {
    window.__gesture.watching = false;
    return {
      clicks: window.__gesture.clicks,
      mutations: window.__gesture.mutations,
      clickProbe: window.__gesture.clickProbe ?? null,
      clickLabel: window.__gesture.clickLabel ?? null,
    };
  });

  return {
    duringGesture,
    clicks: after.clicks,
    totalMutations: after.mutations,
    clickProbe: after.clickProbe,
    clickLabel: after.clickLabel,
  };
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

  let blocking = 0;
  let flagged = 0;

  for (const target of targets) {
    const opened = await target.open({ throttle: 1, viewport: { width, height } });
    const { page, context } = opened;
    try {
      await target.ready(page);
      await page.waitForTimeout(300);
      const cdp = await context.newCDPSession(page);

      // Gesture mode works with LIVE handlers, so the sink that swallows events is
      // installed only in the regular mode.
      const gestures = args.gestures === true || args.gestures === 'true';
      if (gestures) {
        await page.evaluate(INSTALL_GESTURE_WATCH);
      } else {
        await page.evaluate(INSTALL_SINK, INTERACTIVE);
      }

      const items = await collectTargets(page, gestures ? Math.min(limit, 8) : limit);
      console.log(`\n═══ ${target.name} ═══`);
      if (gestures) {
        console.log('Gesture mode: handlers are live, application state changes.\n');
        let blocks = 0;
        for (const item of items) {
          if (item.disabled) continue;
          const before = page.url();
          const result = await probeGesture(cdp, page, item);
          const problems = [];
          if (result.clicks === 0) {
            problems.push('BLOCK the tap produced no click — on a phone it disappears silently');
          }
          // A click that lands off target matters precisely when something changed
          // under the finger: that is the signature of the failure where a
          // re-render swapped the node and the action went to a neighbour.
          if (result.clicks > 0 && result.duringGesture > 0 && result.clickProbe !== item.probe) {
            problems.push(
              `BLOCK the click landed on “${result.clickLabel || 'another element'}” instead of the target — the node changed under the finger`
            );
          }
          if (result.clicks > 1) {
            problems.push(`BLOCK one touch produced ${result.clicks} clicks — the action fires twice`);
          }
          if (result.duringGesture > 0) {
            problems.push(
              `FLAG  the DOM changed during the gesture (${result.duringGesture} mutations between touch and release) — click may not be synthesised`
            );
          }
          if (problems.length) {
            blocks += problems.filter((p) => p.startsWith('BLOCK')).length;
            console.log(`  ${item.tag} «${item.label}» ${item.width}×${item.height}`);
            for (const p of problems) console.log(`      ${p}`);
          }
          if (page.url() !== before) {
            // The tap navigated away — restore the scenario to its initial state.
            await target.ready(page).catch(() => {});
            await page.evaluate(INSTALL_GESTURE_WATCH).catch(() => {});
          }
        }
        console.log(`\nBlocking: ${blocks}`);
        process.exitCode = blocks > 0 ? 1 : 0;
        continue;
      }
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

  console.log(`\nCrops of problem targets: ${outDir}`);
  console.log(`Blocking: ${blocking} | warnings: ${flagged}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
