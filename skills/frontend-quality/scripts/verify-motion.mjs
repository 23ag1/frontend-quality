#!/usr/bin/env node
/**
 * Motion and weight: frame durations under scroll, long tasks, resource weight,
 * LCP, CLS, respect for prefers-reduced-motion — and animations cut short.
 *
 * This is what a screenshot cannot show: a site can be beautiful and stutter at
 * the same time. Heavy graphics without this check is a blind bet.
 *
 * Animations cut short. A rotating indicator that breaks on every revolution, a
 * card that jolts at the end of a swipe: a timer ran next to the animation and
 * "finished" it on its own schedule, or the node was unmounted mid-way. Every CSS
 * transition and CSS animation started during the run is followed to its end:
 *
 *   BLOCK  the element was removed before its own transition or animation ended
 *          (unmount by a timer, a key change, a state flip) — the motion is cut
 *          off visibly;
 *   FLAG   a new transition of the same property replaced the running one
 *          (an interruption — sometimes intended, often a double state change);
 *   FLAG   cancelled with the element still on the page (display:none, the
 *          transition removed, the class dropped by a timer).
 *
 * Infinite animations (spinners) are exempt: removing a spinner when the data
 * arrives is how it is meant to end.
 *
 * Usage:
 *   node verify-motion.mjs --url http://localhost:3000
 *   node verify-motion.mjs --url ... --budget-js 600
 *   node verify-motion.mjs --url ... --throttle 4     # emulate mid-range hardware
 *   node verify-motion.mjs --scenario ./e2e/scenarios/cart.mjs
 *
 * With --scenario the page is driven to its state by `ready()`, then every entry
 * of the scenario's `interactions` is run and cut animations are reported with
 * the interaction they happened in. Same contract as the other checks
 * (scripts/lib/session.mjs).
 *
 * Exit: 0 — within budget, 1 — thresholds broken, 2 — could not run.
 */

import { parseArgs, resolveTargets, closeQuietly, loadConfig } from './lib/session.mjs';

const THRESHOLDS = {
  // Share of frames longer than 50 ms across one scroll pass. Above it — visible jank.
  longFrameRatio: 0.05,
  fpsP50: 50,
  lcpMs: 2500,
  cls: 0.1,
  jsKb: 900,
  totalKb: 3500,
};

// An animation that loses less than a frame at its end is not visibly cut.
const CUT_TOLERANCE_MS = 17;

/** Scrolls the page smoothly and measures the duration of every frame. */
async function measureScroll(page) {
  return page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    let running = true;

    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const height = document.documentElement.scrollHeight;
    const step = Math.max(30, Math.round(window.innerHeight / 20));
    for (let y = 0; y < height; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 32));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
    running = false;

    const sorted = frames.slice(1).sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
    const longFrames = sorted.filter((d) => d > 50).length;
    return {
      frames: sorted.length,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      worstMs: sorted[sorted.length - 1] || 0,
      longFrames,
      longFrameRatio: sorted.length ? longFrames / sorted.length : 0,
    };
  });
}

/** LCP and CLS are collected by observers installed before the page loads. */
const VITALS_INIT = () => {
  if (window.__vitals) return;
  window.__vitals = { lcp: 0, cls: 0, longTasks: 0, longTaskMs: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__vitals.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__vitals.longTasks += 1;
        window.__vitals.longTaskMs += entry.duration;
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* browser without the required observer types */
  }
};

/**
 * Follows every CSS transition and CSS animation from its start to its end.
 *
 * `transitioncancel` / `animationcancel` on the window are not enough: an element
 * that is removed from the document cancels its animations, but the event never
 * reaches a window listener — the node is no longer in the tree. So the Animation
 * objects themselves are tracked: their `cancel` event fires whatever happened to
 * the element, and a MutationObserver notices a removal in the same task.
 */
const MOTION_WATCH = () => {
  if (window.__motion) return;
  const m = (window.__motion = { phase: 'page load', tracked: [], events: 0 });
  const seen = new WeakSet();

  const describe = (el) => {
    if (!el || !el.tagName) return '(unknown)';
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += `.${cls.join('.')}`;
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return text ? `${s} «${text}»` : s;
  };

  const settle = (record, outcome) => {
    if (record.outcome) return;
    record.outcome = outcome;
    record.elapsed = Math.round(performance.now() - record.startedAt);
  };

  const track = (anim) => {
    if (seen.has(anim)) return;
    const isTransition = typeof CSSTransition !== 'undefined' && anim instanceof CSSTransition;
    const isAnimation = typeof CSSAnimation !== 'undefined' && anim instanceof CSSAnimation;
    if (!isTransition && !isAnimation) return;
    const el = anim.effect && anim.effect.target;
    if (!el) return;
    const timing = anim.effect.getComputedTiming();
    if (!(timing.activeDuration > 0)) return;
    seen.add(anim);
    const infinite = timing.activeDuration === Infinity;
    const record = {
      phase: m.phase,
      kind: isTransition ? 'transition' : 'animation',
      name: isTransition ? anim.transitionProperty : anim.animationName,
      element: describe(el),
      infinite,
      total: Math.round((timing.delay || 0) + (infinite ? 0 : timing.activeDuration)),
      startedAt: performance.now() - Math.max(0, Number(anim.currentTime) || 0),
      outcome: null,
      elapsed: 0,
      _el: el,
    };
    m.tracked.push(record);
    anim.addEventListener('finish', () => settle(record, 'finished'));
    anim.addEventListener('cancel', () => {
      // Removal is checked first: a removed node also cancels, and that is the
      // worse of the two.
      if (!el.isConnected) return settle(record, 'removed');
      const replaced = el
        .getAnimations()
        .some(
          (other) =>
            other !== anim &&
            typeof CSSTransition !== 'undefined' &&
            other instanceof CSSTransition &&
            other.transitionProperty === record.name
        );
      settle(record, replaced ? 'replaced' : 'cancelled');
    });
  };

  const scan = (root) => {
    const list = root && root.getAnimations ? root.getAnimations({ subtree: true }) : document.getAnimations();
    for (const anim of list) track(anim);
  };

  for (const type of ['transitionrun', 'animationstart']) {
    window.addEventListener(type, (event) => scan(event.target), { capture: true });
  }
  for (const type of ['transitioncancel', 'animationcancel']) {
    window.addEventListener(type, () => (m.events += 1), { capture: true });
  }
  // The end event reaches this capture listener BEFORE the application's own
  // handler, which may remove the node right there. Settling here first keeps a
  // correct "remove on transitionend" from reading as a removal mid-way.
  for (const type of ['transitionend', 'animationend']) {
    window.addEventListener(
      type,
      (event) => {
        const name = event.propertyName || event.animationName;
        for (const record of m.tracked) {
          if (!record.outcome && record._el === event.target && record.name === name) settle(record, 'finished');
        }
      },
      { capture: true }
    );
  }

  // Unmount: the removal is seen in the same task, before any frame is painted.
  const watchRemovals = () => {
    new MutationObserver(() => {
      for (const record of m.tracked) {
        if (!record.outcome && !record._el.isConnected) settle(record, 'removed');
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) watchRemovals();
  else document.addEventListener('DOMContentLoaded', watchRemovals);

  // Backup for anything that started without an event reaching the window.
  const poll = () => {
    scan(null);
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
};

async function readMotion(page) {
  return page.evaluate(() => {
    const m = window.__motion;
    if (!m) return { tracked: 0, finished: 0, events: 0, cuts: [] };
    const cuts = m.tracked.filter((r) => r.outcome && r.outcome !== 'finished').map(({ _el, ...rest }) => rest);
    return {
      tracked: m.tracked.length,
      finished: m.tracked.filter((r) => r.outcome === 'finished').length,
      events: m.events,
      cuts,
    };
  });
}

/** Let everything an interaction started run to its end (or be cut). */
async function waitForMotion(page, limitMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const pending = await page.evaluate(() =>
      window.__motion ? window.__motion.tracked.filter((r) => !r.outcome && !r.infinite).length : 0
    );
    if (!pending) return;
    await page.waitForTimeout(100);
  }
}

function classifyCut(cut) {
  if (cut.infinite) return null;
  const where = `[${cut.phase}]`;
  const what = `${cut.kind} of ${cut.name} (${cut.total} ms)`;
  if (cut.outcome === 'removed') {
    const left = cut.total - cut.elapsed;
    if (left <= CUT_TOLERANCE_MS) return null;
    return {
      severity: 'block',
      text: `${cut.element}: ${what} — the element was removed after ${cut.elapsed} ms, ${left} ms before its own end; finish on transitionend/animationend, not by a timer ${where}`,
    };
  }
  if (cut.outcome === 'replaced') {
    return {
      severity: 'flag',
      text: `${cut.element}: ${what} cancelled after ${cut.elapsed} ms by a new transition of the same property ${where}`,
    };
  }
  return {
    severity: 'flag',
    text: `${cut.element}: ${what} cancelled after ${cut.elapsed} ms with the element still on the page (display:none, transition removed or class dropped by a timer) ${where}`,
  };
}

async function run(target, options) {
  const findings = [];
  const opened = await target.open({ throttle: options.throttle, viewport: options.viewport });
  const { page } = opened;

  try {
    await page.addInitScript(VITALS_INIT);
    await page.addInitScript(MOTION_WATCH);
    await target.ready(page);
    // A scenario whose open() already navigated never ran the init scripts.
    await page.evaluate(VITALS_INIT);
    await page.evaluate(MOTION_WATCH);
    await waitForMotion(page, 2000);

    const weights = await page.evaluate(() => {
      const acc = { js: 0, css: 0, image: 0, font: 0, media: 0, total: 0 };
      for (const entry of performance.getEntriesByType('resource')) {
        const kb = (entry.transferSize || entry.encodedBodySize || 0) / 1024;
        if (!kb) continue;
        acc.total += kb;
        const kind = entry.initiatorType;
        if (kind === 'script') acc.js += kb;
        else if (kind === 'link' || kind === 'css') acc.css += kb;
        else if (kind === 'img' || kind === 'image') acc.image += kb;
        else if (kind === 'video' || kind === 'audio') acc.media += kb;
        else if (/font/.test(entry.name)) acc.font += kb;
      }
      // The document itself never appears among resource entries.
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) acc.total += (nav.transferSize || 0) / 1024;
      return acc;
    });

    // The scenario's interactions: this is where unmounts and timers live.
    for (const interaction of target.interactions || []) {
      await page.evaluate((name) => {
        window.__motion.phase = name;
      }, interaction.name);
      try {
        await interaction.run(page);
      } catch (error) {
        findings.push({
          ok: false,
          severity: 'flag',
          text: `interaction "${interaction.name}" failed: ${String(error.message).split('\n')[0]}`,
        });
      }
      await waitForMotion(page);
    }

    await page.evaluate(() => {
      window.__motion.phase = 'scroll';
    });
    const scroll = await measureScroll(page);
    await waitForMotion(page, 1500);
    const vitals = await page.evaluate(() => window.__vitals);
    const motion = await readMotion(page);

    // Second pass: the site must respect the system "reduce motion" setting.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (target.kind === 'scenario') {
      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    }
    await target.ready(page);
    await page.waitForTimeout(1500);
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== 1).length
    );

    const fpsP50 = scroll.medianMs > 0 ? 1000 / scroll.medianMs : 0;
    const check = (ok, severity, text) => findings.push({ ok, severity, text });

    check(scroll.longFrameRatio <= THRESHOLDS.longFrameRatio, 'block',
      `frames longer than 50ms: ${(scroll.longFrameRatio * 100).toFixed(1)}% (limit ${THRESHOLDS.longFrameRatio * 100}%), worst ${scroll.worstMs.toFixed(0)}ms`);
    check(fpsP50 >= THRESHOLDS.fpsP50, 'block',
      `median fps under scroll: ${fpsP50.toFixed(0)} (limit ${THRESHOLDS.fpsP50})`);
    check(vitals.cls <= THRESHOLDS.cls, 'block',
      `CLS: ${vitals.cls.toFixed(3)} (limit ${THRESHOLDS.cls})`);
    check(vitals.lcp <= THRESHOLDS.lcpMs, 'flag',
      `LCP: ${vitals.lcp.toFixed(0)}ms (limit ${THRESHOLDS.lcpMs})`);
    check(weights.js <= (options.budgetJs || THRESHOLDS.jsKb), 'flag',
      `JS: ${weights.js.toFixed(0)} KB (budget ${options.budgetJs || THRESHOLDS.jsKb})`);
    check(weights.total <= THRESHOLDS.totalKb, 'flag',
      `total transferred: ${weights.total.toFixed(0)} KB (budget ${THRESHOLDS.totalKb})`);
    check(running === 0, 'block',
      `animations still running under prefers-reduced-motion: ${running}`);
    check(vitals.longTasks < 10, 'flag',
      `long tasks: ${vitals.longTasks} totalling ${vitals.longTaskMs.toFixed(0)}ms`);

    const cuts = motion.cuts.map(classifyCut).filter(Boolean);
    return { findings, cuts, motion, scroll };
  } finally {
    await closeQuietly(opened);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url && !args.scenario) throw new Error('Pass --url or --scenario');
  const config = loadConfig(args);
  const throttle = args.throttle ? Number(args.throttle) : 1;
  const viewport = { width: Number(args.width || 1440), height: Number(args.height || 900) };
  const targets = await resolveTargets(args, config);

  let blocking = 0;
  let warnings = 0;
  for (const target of targets) {
    const result = await run(target, {
      budgetJs: args['budget-js'] ? Number(args['budget-js']) : null,
      throttle,
      viewport,
    });

    const throttleNote = throttle > 1 ? `, CPU throttled ${throttle}×` : '';
    console.log(`\nMotion and weight: ${target.name}`);
    console.log(`Frames measured: ${result.scroll.frames}${throttleNote}\n`);
    for (const finding of result.findings) {
      const mark = finding.ok ? 'ok   ' : finding.severity === 'block' ? 'BLOCK' : 'FLAG ';
      console.log(`  ${mark} ${finding.text}`);
    }

    const { motion } = result;
    const count = (target.interactions || []).length;
    const phases = count ? `page load, ${count} interaction${count === 1 ? '' : 's'}, scroll` : 'page load, scroll';
    console.log(
      `\nAnimations followed (${phases}): ${motion.tracked}, finished: ${motion.finished}, cancelled: ${motion.cuts.length}, cancel events seen on the page: ${motion.events}`
    );
    for (const cut of result.cuts) {
      console.log(`  ${cut.severity === 'block' ? 'BLOCK' : 'FLAG '} ${cut.text}`);
    }

    const all = [...result.findings.filter((f) => !f.ok), ...result.cuts];
    blocking += all.filter((f) => f.severity === 'block').length;
    warnings += all.filter((f) => f.severity === 'flag').length;
  }

  console.log(`\nBlocking: ${blocking} | warnings: ${warnings}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
