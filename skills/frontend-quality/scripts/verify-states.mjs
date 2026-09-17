#!/usr/bin/env node
/**
 * Interactive states: hover, keyboard focus, disabled, touch targets, accessible
 * names — and CONTRAST IN EVERY STATE.
 *
 * About contrast specifically. axe measures it once, on the page at rest. That is
 * exactly where it is almost always fine: the trouble lives in the states. A
 * muted hover, a grey disabled, a highlighted selection are different colours and
 * must be checked separately — otherwise "contrast 4.5:1" in a report means "at
 * rest, and after that, who knows".
 *
 * Built so it does not burn context: the browser looks, text comes out. Crops are
 * captured only for elements that failed.
 *
 * Usage:
 *   node verify-states.mjs --url http://localhost:3000
 *   node verify-states.mjs --scenario ./perf/order-screen.mjs --limit 60
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, loadConfig, resolveTargets, closeQuietly } from './lib/session.mjs';

const INTERACTIVE =
  'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Minimum touch target. Below it the finger misses. Here it is a warning:
// verify-tap.mjs blocks on it, because that one checks the target with a real tap.
const MIN_TOUCH_PX = 44;

/** A snapshot of the properties that reveal whether a state is rendered at all. */
const STYLE_PROBE = `(el) => {
  const s = getComputedStyle(el);
  return [
    s.backgroundColor, s.color, s.borderColor, s.boxShadow, s.outlineColor,
    s.outlineWidth, s.outlineStyle, s.opacity, s.transform, s.textDecorationLine,
    s.filter, s.scale,
  ].join('|');
}`;

/**
 * WCAG contrast. The background is resolved by walking up the ancestors to the
 * first opaque one — exactly how the eye sees it. If an image or gradient shows up
 * on the way, the honest answer is "undetermined", not an invented number.
 */
const CONTRAST_PROBE = `(el) => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const mix = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const style = getComputedStyle(el);
  const color = parse(style.color);
  if (!color) return null;

  let background = null;
  let painted = false;
  for (let node = el; node; node = node.parentElement) {
    const s = getComputedStyle(node);
    if (s.backgroundImage && s.backgroundImage !== 'none') return { unknown: 'background is an image or gradient' };
    const candidate = parse(s.backgroundColor);
    if (candidate && candidate.a > 0) {
      background = background ? mix(background, candidate) : candidate;
      if (background.a >= 0.99) { painted = true; break; }
    }
  }
  if (!painted) {
    background = background
      ? mix(background, { r: 255, g: 255, b: 255, a: 1 })
      : { r: 255, g: 255, b: 255, a: 1 };
  }

  const opacity = parseFloat(style.opacity);
  const front = mix({ ...color, a: color.a * (isNaN(opacity) ? 1 : opacity) }, background);
  const l1 = luminance(front);
  const l2 = luminance(background);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  const size = parseFloat(style.fontSize);
  const weight = Number(style.fontWeight) || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  return { ratio, large, required: large ? 3 : 4.5, size, weight };
}`;

async function collectTargets(page, limit) {
  return page.evaluate(
    ({ selector, limit }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
      };
      const label = (el) =>
        (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          (el.textContent || '').trim() ||
          el.getAttribute('placeholder') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .slice(0, 48);

      const items = [];
      const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
      nodes.forEach((el, index) => {
        if (items.length >= limit) return;
        el.setAttribute('data-state-probe', String(index));
        const r = el.getBoundingClientRect();
        items.push({
          probe: String(index),
          tag: el.tagName.toLowerCase(),
          label: label(el),
          width: Math.round(r.width),
          height: Math.round(r.height),
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        });
      });
      return items;
    },
    { selector: INTERACTIVE, limit }
  );
}

/**
 * The resting state is captured in one pass with the mouse parked in the corner.
 * Comparing hover against anything else is meaningless: the previous element may
 * still be highlighted.
 */
async function snapshotResting(page) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  return page.evaluate(
    ({ probeStyle, contrastProbe }) => {
      const readStyle = new Function('el', `return (${probeStyle})(el)`);
      const readContrast = new Function('el', `return (${contrastProbe})(el)`);
      const map = {};
      for (const el of document.querySelectorAll('[data-state-probe]')) {
        map[el.getAttribute('data-state-probe')] = {
          style: readStyle(el),
          contrast: readContrast(el),
        };
      }
      return map;
    },
    { probeStyle: STYLE_PROBE, contrastProbe: CONTRAST_PROBE }
  );
}

/**
 * Focus is exercised with a real keyboard: a programmatic focus() does not trigger
 * :focus-visible and would report a false "no focus ring" on every element.
 */
async function walkFocusByKeyboard(page, resting, maxTabs) {
  const seen = new Map();
  await page.evaluate(() => document.body.focus?.());
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const info = await page.evaluate(
      ({ probeStyle, contrastProbe }) => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const probe = el.getAttribute('data-state-probe');
        if (probe === null) return null;
        const readStyle = new Function('e', `return (${probeStyle})(e)`);
        const readContrast = new Function('e', `return (${contrastProbe})(e)`);
        return { probe, style: readStyle(el), contrast: readContrast(el) };
      },
      { probeStyle: STYLE_PROBE, contrastProbe: CONTRAST_PROBE }
    );
    if (!info) continue;
    if (!seen.has(info.probe)) {
      seen.set(info.probe, {
        visible: info.style !== resting[info.probe]?.style,
        contrast: info.contrast,
      });
    }
  }
  return seen;
}

async function checkHover(page, target) {
  const locator = page.locator(`[data-state-probe="${target.probe}"]`);
  try {
    await locator.hover({ timeout: 2000 });
    // Transitions default to up to 300 ms: measuring earlier catches the midpoint.
    await page.waitForTimeout(350);
    return {
      ok: true,
      style: await locator.evaluate(STYLE_PROBE),
      contrast: await locator.evaluate(CONTRAST_PROBE),
    };
  } catch {
    return { ok: false, style: null, contrast: null };
  }
}

function contrastProblem(stateName, contrast) {
  if (!contrast || contrast.unknown || !contrast.ratio) return null;
  if (contrast.ratio >= contrast.required) return null;
  return `contrast in the “${stateName}” state is ${contrast.ratio.toFixed(2)}:1 against a required ${contrast.required}:1 (size ${Math.round(contrast.size)}px, weight ${contrast.weight})`;
}

async function runTarget(target, args) {
  const limit = Number(args.limit || 40);
  const outDir = resolve(args.out || '.uiverify-out/states');
  mkdirSync(outDir, { recursive: true });

  const opened = await target.open({ throttle: 1 });
  const { page } = opened;
  const failures = [];
  let checked = 0;

  try {
    await target.ready(page);
    await page.waitForTimeout(300);

    const items = await collectTargets(page, limit);
    const resting = await snapshotResting(page);
    const focusable = await walkFocusByKeyboard(page, resting, Math.min(80, limit * 2));

    for (const item of items) {
      checked += 1;
      const problems = [];

      const hover = await checkHover(page, item);
      if (!hover.ok) {
        problems.push({ severity: 'flag', text: 'element cannot be hovered (covered or off-screen)' });
      } else if (hover.style === resting[item.probe]?.style && !item.disabled) {
        problems.push({ severity: 'flag', text: 'no reaction to hover' });
      }

      const focus = focusable.get(item.probe);
      if (focus) {
        if (!focus.visible) {
          problems.push({ severity: 'block', text: 'focus is invisible: the keyboard user cannot tell where they are' });
        }
      } else if (!item.disabled) {
        problems.push({ severity: 'block', text: 'not reachable with Tab' });
      }

      if (item.width < MIN_TOUCH_PX || item.height < MIN_TOUCH_PX) {
        problems.push({
          severity: 'flag',
          text: `touch target ${item.width}×${item.height} is smaller than ${MIN_TOUCH_PX}px — check with verify-tap.mjs`,
        });
      }
      if (!item.label) {
        problems.push({ severity: 'block', text: 'no accessible name (neither text nor aria-label)' });
      }

      // Contrast in every state: rest, hover, focus.
      for (const [name, contrast] of [
        ['rest', resting[item.probe]?.contrast],
        ['hover', hover.contrast],
        ['focus', focus?.contrast],
      ]) {
        const problem = contrastProblem(name, contrast);
        if (problem) problems.push({ severity: item.disabled ? 'flag' : 'block', text: problem });
      }
      if (resting[item.probe]?.contrast?.unknown) {
        problems.push({
          severity: 'flag',
          text: `contrast not measured: ${resting[item.probe].contrast.unknown} — verify by eye`,
        });
      }

      if (!problems.length) continue;

      const shot = join(outDir, `state-${item.probe}.png`);
      await page
        .locator(`[data-state-probe="${item.probe}"]`)
        .screenshot({ path: shot })
        .catch(() => {});
      failures.push({ ...item, problems, screenshot: shot });
    }
  } finally {
    await closeQuietly(opened);
  }

  return { name: target.name, checked, failures, outDir };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const targets = await resolveTargets(args, config);

  let blocking = 0;
  let total = 0;

  for (const target of targets) {
    const result = await runTarget(target, args);
    console.log(`\n═══ ${result.name} ═══`);
    console.log(`States: elements checked ${result.checked}, with findings ${result.failures.length}`);
    console.log(`Crops of problem elements: ${result.outDir}\n`);
    for (const failure of result.failures) {
      console.log(`  ${failure.tag} “${failure.label || 'unnamed'}” ${failure.width}×${failure.height}`);
      for (const problem of failure.problems) {
        console.log(`      ${problem.severity === 'block' ? 'BLOCK' : 'FLAG '} ${problem.text}`);
      }
    }
    blocking += result.failures.flatMap((f) => f.problems.filter((p) => p.severity === 'block')).length;
    total += result.failures.length;
  }

  console.log(`\nBlocking: ${blocking} | elements with findings: ${total}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
