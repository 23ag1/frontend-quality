#!/usr/bin/env node
/**
 * Width of the decision vocabulary: how many DIFFERENT values are actually in use.
 *
 * Why. The mark of systematic work is a narrow vocabulary, not the number of rules
 * in a document. Five to seven type sizes, about a dozen spacing values, three or
 * four radii, two or three shadows. A spread of twenty-odd means decisions were
 * made one at a time: someone eyeballed a number, twenty times over.
 *
 * This is the only part of taste that can be measured: it does not say whether the
 * result is beautiful, it says whether there is a system.
 *
 * Usage:
 *   node verify-vocabulary.mjs --url http://localhost:3000
 *   node verify-vocabulary.mjs --scenario ./perf/order-screen.mjs --max-font 7
 *
 * Exit: 0 — vocabulary within limits, 1 — spread above a limit, 2 — could not run.
 */

import { parseArgs, loadConfig, resolveTargets, closeQuietly } from './lib/session.mjs';

// The limits are landmarks of systematic work, not law. A dense interface with
// tables lives wider than a promo page, so every limit can be overridden by flag.
const LIMITS = {
  font: 7, // type sizes
  weight: 4, // font weights
  lineHeight: 6, // line heights
  space: 12, // spacing values (non-zero padding and margin)
  radius: 5, // corner radii
  shadow: 4, // shadows
  color: 12, // text colours
  background: 12, // background colours
  duration: 4, // transition durations
};

const COLLECT = () => {
  const round = (value) => Math.round(parseFloat(value) * 100) / 100;
  const sets = {
    font: new Map(),
    weight: new Map(),
    lineHeight: new Map(),
    space: new Map(),
    radius: new Map(),
    shadow: new Map(),
    color: new Map(),
    background: new Map(),
    duration: new Map(),
  };
  const add = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    const v = String(value);
    sets[key].set(v, (sets[key].get(v) || 0) + 1);
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || '').trim()
    );

    // Typography is counted only where the element owns text: otherwise
    // inheritance inflates the counter with identical values from wrappers.
    if (hasText) {
      add('font', `${round(s.fontSize)}px`);
      add('weight', s.fontWeight);
      add('lineHeight', s.lineHeight === 'normal' ? 'normal' : `${round(s.lineHeight)}px`);
      add('color', s.color);
    }

    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const pad = round(s[`padding${side}`]);
      const mar = round(s[`margin${side}`]);
      if (pad > 0) add('space', `${pad}px`);
      if (mar > 0) add('space', `${mar}px`);
    }
    const gap = round(s.gap);
    if (gap > 0) add('space', `${gap}px`);

    const radius = round(s.borderTopLeftRadius);
    if (radius > 0) add('radius', `${radius}px`);
    if (s.boxShadow && s.boxShadow !== 'none') add('shadow', s.boxShadow.slice(0, 60));
    if (s.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor)) {
      add('background', s.backgroundColor);
    }
    const duration = s.transitionDuration;
    if (duration && duration !== '0s') add('duration', duration.split(',')[0].trim());
  }

  const out = {};
  for (const [key, map] of Object.entries(sets)) {
    out[key] = [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
  }
  return out;
};

const TITLES = {
  font: 'type sizes',
  weight: 'font weights',
  lineHeight: 'line heights',
  space: 'spacing values',
  radius: 'corner radii',
  shadow: 'shadows',
  color: 'text colours',
  background: 'background colours',
  duration: 'transition durations',
};

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const limits = { ...LIMITS };
  for (const key of Object.keys(limits)) {
    const flag = args[`max-${key.toLowerCase()}`];
    if (flag) limits[key] = Number(flag);
  }

  const targets = await resolveTargets(args, config);
  let over = 0;

  for (const target of targets) {
    const opened = await target.open({ throttle: 1 });
    try {
      await target.ready(opened.page);
      await opened.page.waitForTimeout(400);
      const vocab = await opened.page.evaluate(COLLECT);

      console.log(`\n═══ ${target.name} ═══`);
      console.log('Decision vocabulary: how many different values are actually in use\n');

      for (const [key, items] of Object.entries(vocab)) {
        const limit = limits[key];
        const count = items.length;
        const mark = count > limit ? 'WIDE  ' : 'ok    ';
        if (count > limit) over += 1;
        const top = items
          .slice(0, 6)
          .map((i) => `${i.value}×${i.count}`)
          .join(', ');
        console.log(`  ${mark} ${TITLES[key].padEnd(24)} ${String(count).padStart(3)} (limit ${limit})`);
        if (count > limit) {
          console.log(`         most common: ${top}`);
          // The tail is usually where the accidental values live: they occur
          // exactly once and were eyeballed into existence.
          const rare = items.filter((i) => i.count === 1).map((i) => i.value);
          if (rare.length) {
            console.log(`         occur exactly once (${rare.length}): ${rare.slice(0, 8).join(', ')}`);
          }
        }
      }
    } finally {
      await closeQuietly(opened);
    }
  }

  console.log(
    `\nMeasurements above their limit: ${over}. This is not a layout bug but a sign that` +
      `\ndecisions were made one at a time: shrink to a set instead of adding more.`
  );
  process.exit(over > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
