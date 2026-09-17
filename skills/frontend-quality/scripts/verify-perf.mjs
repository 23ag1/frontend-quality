#!/usr/bin/env node
/**
 * Performance analysis with a NAMED CAUSE.
 *
 * verify-motion.mjs answers "are we within budget". This script answers "who
 * exactly ate it": which function, in which file, in which phase of the frame,
 * and what it cost.
 *
 * What it measures:
 *   long-animation-frame  — frames longer than 50 ms broken down by script (>5 ms):
 *                           function name, file, invoker type, forced layout time
 *                           and synchronous pauses;
 *   event timing          — input delay, processing and presentation time for
 *                           every interaction (the components of INP);
 *   rAF                   — frame durations under real scrolling;
 *   CDP Performance       — counters for layouts, style recalculations, nodes,
 *                           listeners and heap size.
 *
 * The central idea of the report is normalisation by throttling. With the CPU
 * slowed N times, a 16.67 ms frame means 16.67/N ms of real work. So next to the
 * measured milliseconds the report prints "unthrottled" ones: only those can be
 * compared between runs with different throttling.
 *
 * Usage:
 *   node verify-perf.mjs --url http://localhost:3000
 *   node verify-perf.mjs --scenario ./perf/order-screen.mjs --throttle 20
 *   node verify-perf.mjs --url ... --profile landing --json report.json
 *
 * Exit: 0 — within budget, 1 — thresholds broken, 2 — could not run.
 */

import { writeFileSync } from 'node:fs';
import {
  parseArgs,
  loadConfig,
  resolveTargets,
  closeQuietly,
} from './lib/session.mjs';

/**
 * Budgets are expressed in UNTHROTTLED milliseconds — in CPU work, not in
 * stopwatch time. That way one limit works for ×4 and for ×20 alike.
 */
const PROFILES = {
  product: {
    label: 'product interface',
    workPerFrameMs: 4, // main-thread work per frame under scroll
    inputDelayMs: 8, // from the event to the start of the handler
    processingMs: 12, // the handler itself
    presentationMs: 16, // from the end of the handler to the frame on screen
    interactionMs: 40, // the whole interaction
    typeLatencyP90Ms: 40, // one character typed → next frame
    longFrameRatio: 0.05,
    thrashingMs: 2, // forced layout inside scripts
    idleScriptMs: 30, // script work on an open, untouched screen
    heapGrowthMb: 8, // heap growth across the interaction pass
  },
  landing: {
    label: 'promo page',
    workPerFrameMs: 6,
    inputDelayMs: 10,
    processingMs: 16,
    presentationMs: 24,
    interactionMs: 60,
    typeLatencyP90Ms: 60,
    longFrameRatio: 0.05,
    thrashingMs: 4,
    idleScriptMs: 40,
    heapGrowthMb: 16,
  },
};

/** Observers are installed BEFORE the page loads, otherwise the first frames are lost. */
const INSTALL_OBSERVERS = () => {
  window.__perf = { loaf: [], events: [], lcp: 0, cls: 0, longTasks: [] };

  const safe = (fn) => {
    try {
      fn();
    } catch {
      /* observer type not supported — not a reason to fail */
    }
  };

  safe(() =>
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.loaf.push({
          startTime: entry.startTime,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          firstUIEventTimestamp: entry.firstUIEventTimestamp,
          scripts: (entry.scripts || []).map((s) => ({
            duration: s.duration,
            invoker: s.invoker,
            invokerType: s.invokerType,
            sourceURL: s.sourceURL,
            sourceFunctionName: s.sourceFunctionName,
            forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
            pauseDuration: s.pauseDuration,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true })
  );

  safe(() =>
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.interactionId) continue;
        window.__perf.events.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          interactionId: entry.interactionId,
        });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  );

  safe(() =>
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__perf.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  );

  safe(() =>
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__perf.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true })
  );

  safe(() =>
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true })
  );
};

const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

/**
 * Frames are counted with rAF: when the main thread is busy the callback arrives
 * late, and that is exactly what we are after. Scrolling uses real wheel or touch
 * events: a programmatic scrollTo bypasses the compositor and flatters the result.
 */
async function measureScroll(page, hasTouch) {
  const before = await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__frameStop = false;
    const tick = () => {
      const now = performance.now();
      window.__frames.push(now - last);
      last = now;
      if (!window.__frameStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const scroller =
      document.scrollingElement || document.documentElement;
    return {
      y: scroller.scrollTop,
      scrollable: scroller.scrollHeight - scroller.clientHeight,
    };
  });

  const box = page.viewportSize() || { width: 1280, height: 800 };
  const steps = 14;
  for (let i = 0; i < steps; i += 1) {
    if (hasTouch) {
      const y0 = Math.round(box.height * 0.75);
      const y1 = Math.round(box.height * 0.25);
      await page.touchscreen.tap(box.width / 2, y0).catch(() => {});
      await page.mouse.move(box.width / 2, y0);
      await page.mouse.down();
      await page.mouse.move(box.width / 2, y1, { steps: 8 });
      await page.mouse.up();
    } else {
      await page.mouse.wheel(0, Math.round(box.height * 0.6));
    }
    await page.waitForTimeout(120);
  }

  const measured = await page.evaluate(() => {
    window.__frameStop = true;
    const frames = window.__frames.slice(1);
    const sorted = [...frames].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
    const long = frames.filter((d) => d > 50).length;
    const scroller = document.scrollingElement || document.documentElement;
    return {
      frames: frames.length,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      worstMs: sorted[sorted.length - 1] || 0,
      longFrames: long,
      longFrameRatio: frames.length ? long / frames.length : 0,
      endY: scroller.scrollTop,
    };
  });

  // Honesty beats a pretty number: on a page that does not scroll, "60 fps under
  // scroll" means nothing — there was nothing to move.
  const moved = Math.abs(measured.endY - before.y);
  return { ...measured, movedPx: moved, scrollablePx: before.scrollable, real: moved > 40 };
}

/**
 * The idle phase: the screen is open and nobody touches anything.
 *
 * Two real failures are caught here. First — an infinite re-render: an unstable
 * reference in an effect's dependencies restarted it forever and the page died
 * with "Maximum update depth exceeded". Second — a loading skeleton that hangs
 * forever: the response was cut mid-flight, the promise never settled and
 * `finally` never ran.
 *
 * Neither shows up on a screenshot or in a scroll measurement: there everything
 * "works".
 */
async function measureIdle(page, cdp, ms = 3000) {
  const before = await cdpMetrics(cdp);
  const mark = await page.evaluate(() => {
    window.__idleFrames = 0;
    window.__idleStop = false;
    const tick = () => {
      window.__idleFrames += 1;
      if (!window.__idleStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return performance.now();
  });

  await page.waitForTimeout(ms);

  const after = await cdpMetrics(cdp);
  const state = await page.evaluate(
    ({ since }) => {
      window.__idleStop = true;
      const loaf = (window.__perf?.loaf || []).filter((f) => f.startTime >= since);
      const skeletons = document.querySelectorAll(
        // Everyone names these differently, so match by meaning, not one class.
        '[aria-busy="true"], .animate-pulse, [class*="skeleton" i], [class*="shimmer" i], [class*="placeholder" i], [data-skeleton], [data-loading]'
      ).length;
      const spinners = document.querySelectorAll('[role="progressbar"], .animate-spin').length;
      return {
        loafFrames: loaf.length,
        loafMs: loaf.reduce((sum, f) => sum + f.duration, 0),
        skeletons,
        spinners,
        frames: window.__idleFrames,
      };
    },
    { since: mark }
  );

  return {
    windowMs: ms,
    scriptMs: ((after.ScriptDuration || 0) - (before.ScriptDuration || 0)) * 1000,
    layouts: (after.LayoutCount || 0) - (before.LayoutCount || 0),
    styleRecalcs: (after.RecalcStyleCount || 0) - (before.RecalcStyleCount || 0),
    ...state,
  };
}

/**
 * Input responsiveness is measured as the delay from the `input` event to the
 * second frame: the first frame may arrive before React has painted the new
 * state. The first three characters are dropped as warm-up — the spread there is
 * severalfold.
 */
async function measureTyping(page, selector, chars = 16) {
  const target = await page.$(selector);
  if (!target) return null;
  await target.click({ timeout: 2000 }).catch(() => {});
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    window.__typing = [];
    if (!el) return;
    el.addEventListener('input', () => {
      const t0 = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.__typing.push(performance.now() - t0))
      );
    });
  }, selector);

  const alphabet = 'abcdefghijklmn';
  for (let i = 0; i < chars; i += 1) {
    await page.keyboard.type(alphabet[i % alphabet.length]);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(200);

  const samples = (await page.evaluate(() => window.__typing || [])).slice(3);
  if (!samples.length) return null;
  return {
    samples: samples.length,
    medianMs: quantile(samples, 0.5),
    p90Ms: quantile(samples, 0.9),
    worstMs: Math.max(...samples),
  };
}

/** When a scenario names no interactions, pick things that will not navigate away. */
async function genericInteractions(page) {
  const handles = await page.$$('button:not([disabled]), [role="button"]:not([aria-disabled="true"])');
  const picked = [];
  for (const handle of handles.slice(0, 4)) {
    const visible = await handle.isVisible().catch(() => false);
    if (!visible) continue;
    const label = (await handle.textContent().catch(() => ''))?.trim().slice(0, 30) || 'button';
    picked.push({
      name: `press “${label}”`,
      run: async () => {
        await handle.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      },
    });
  }
  return picked;
}

async function cdpMetrics(cdp) {
  if (!cdp) return {};
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

function summarizeLoaf(entries) {
  const byScript = new Map();
  let thrashing = 0;
  let pause = 0;
  let blocking = 0;

  for (const frame of entries) {
    blocking += frame.blockingDuration || 0;
    for (const script of frame.scripts) {
      thrashing += script.forcedStyleAndLayoutDuration || 0;
      pause += script.pauseDuration || 0;
      const file = (script.sourceURL || 'unknown file').split('/').slice(-1)[0].slice(0, 42);
      const key = `${script.sourceFunctionName || script.invoker || '?'} — ${file} [${script.invokerType || '?'}]`;
      const prev = byScript.get(key) || { ms: 0, calls: 0, forced: 0 };
      byScript.set(key, {
        ms: prev.ms + script.duration,
        calls: prev.calls + 1,
        forced: prev.forced + (script.forcedStyleAndLayoutDuration || 0),
      });
    }
  }

  const top = [...byScript.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);

  const renderCost = entries.map((f) =>
    f.renderStart ? f.startTime + f.duration - f.renderStart : 0
  );

  return {
    frames: entries.length,
    worstMs: entries.reduce((max, f) => Math.max(max, f.duration), 0),
    blockingMs: blocking,
    thrashingMs: thrashing,
    pauseMs: pause,
    renderMs: renderCost.reduce((sum, v) => sum + v, 0),
    top,
  };
}

function summarizeEvents(events) {
  if (!events.length) return null;
  const byInteraction = new Map();
  for (const event of events) {
    const prev = byInteraction.get(event.interactionId);
    if (!prev || event.duration > prev.duration) byInteraction.set(event.interactionId, event);
  }
  const list = [...byInteraction.values()].map((e) => ({
    name: e.name,
    total: e.duration,
    inputDelay: e.processingStart - e.startTime,
    processing: e.processingEnd - e.processingStart,
    presentation: e.startTime + e.duration - e.processingEnd,
  }));
  const worst = list.reduce((max, item) => (item.total > max.total ? item : max), list[0]);
  return {
    count: list.length,
    p75: quantile(list.map((i) => i.total), 0.75),
    worst,
    list: list.sort((a, b) => b.total - a.total).slice(0, 6),
  };
}

async function runTarget(target, options) {
  const opened = await target.open({ throttle: options.throttle });
  const { page, context } = opened;
  const findings = [];
  let cdp = null;

  try {
    await page.addInitScript(INSTALL_OBSERVERS);
    await target.ready(page);
    // Observers are installed again in case the scenario was already on the page
    // before addInitScript (mocks and login often navigate on their own).
    await page.evaluate(INSTALL_OBSERVERS).catch(() => {});
    await page.waitForTimeout(300);

    cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable').catch(() => {});
    const before = await cdpMetrics(cdp);

    const idle = await measureIdle(page, cdp, Number(options.idleMs || 3000));

    const hasTouch = await page
      .evaluate(() => navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
      .catch(() => false);
    const scroll = await measureScroll(page, hasTouch);

    const interactions = target.interactions?.length
      ? target.interactions
      : await genericInteractions(page);
    for (const interaction of interactions) {
      await interaction.run(page).catch(() => {});
      await page.waitForTimeout(250);
    }

    const typeSelector =
      target.typeTarget ||
      (await page
        .$('input[type="search"], input[type="text"], input:not([type]), textarea')
        .then((el) => (el ? 'input[type="search"], input[type="text"], input:not([type]), textarea' : null))
        .catch(() => null));
    const typing = typeSelector ? await measureTyping(page, typeSelector) : null;

    const after = await cdpMetrics(cdp);
    const perf = await page.evaluate(() => window.__perf || { loaf: [], events: [], longTasks: [] });
    const dom = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      listeners: 0,
    }));

    const loaf = summarizeLoaf(perf.loaf || []);
    const events = summarizeEvents(perf.events || []);

    return {
      name: target.name,
      idle,
      scroll,
      loaf,
      events,
      typing,
      vitals: { lcp: perf.lcp || 0, cls: perf.cls || 0, longTasks: (perf.longTasks || []).length },
      counters: {
        nodes: dom.nodes,
        layouts: (after.LayoutCount || 0) - (before.LayoutCount || 0),
        styleRecalcs: (after.RecalcStyleCount || 0) - (before.RecalcStyleCount || 0),
        layoutMs: ((after.LayoutDuration || 0) - (before.LayoutDuration || 0)) * 1000,
        styleMs: ((after.RecalcStyleDuration || 0) - (before.RecalcStyleDuration || 0)) * 1000,
        scriptMs: ((after.ScriptDuration || 0) - (before.ScriptDuration || 0)) * 1000,
        listeners: after.JSEventListeners || 0,
        heapMb: (after.JSHeapUsedSize || 0) / 1048576,
        heapGrowthMb: ((after.JSHeapUsedSize || 0) - (before.JSHeapUsedSize || 0)) / 1048576,
      },
      findings,
    };
  } finally {
    await closeQuietly(opened);
  }
}

function judge(result, budget, throttle) {
  const issues = [];
  const norm = (ms) => ms / throttle; // unthrottled milliseconds
  const add = (severity, text, hint) => issues.push({ severity, text, hint });

  // Idle. A screen that is open and untouched must be doing nothing at all.
  if (result.idle) {
    const idleWork = norm(result.idle.scriptMs);
    if (idleWork > budget.idleScriptMs) {
      add(
        'block',
        `the screen never settles: ${idleWork.toFixed(1)} unthrottled ms of scripts over ${result.idle.windowMs} ms without a single touch (budget ${budget.idleScriptMs}), layouts ${result.idle.layouts}`,
        'usually an unstable reference in an effect dependency: it restarts in a loop'
      );
    }
    if (result.idle.skeletons > 0) {
      add(
        'block',
        `loading skeletons still on screen after ${result.idle.windowMs} ms: ${result.idle.skeletons}`,
        'a request without a timeout: a cut response never settles the promise, finally never runs'
      );
    }
    if (result.idle.spinners > 0) {
      add('flag', `spinners are still turning: ${result.idle.spinners}`, '');
    }
  }

  const workPerFrame = result.scroll.medianMs - 16.67 > 0 ? result.scroll.medianMs - 16.67 : 0;
  if (norm(workPerFrame) > budget.workPerFrameMs) {
    add(
      'block',
      `main-thread work per frame under scroll: ${norm(workPerFrame).toFixed(2)} unthrottled ms (budget ${budget.workPerFrameMs})`,
      'motion belongs on the compositor: transform/opacity, no layout per frame'
    );
  }
  if (result.scroll.longFrameRatio > budget.longFrameRatio) {
    add(
      'block',
      `frames longer than 50 ms: ${(result.scroll.longFrameRatio * 100).toFixed(1)}% (limit ${budget.longFrameRatio * 100}%), worst ${result.scroll.worstMs.toFixed(0)} ms`,
      'see the per-script breakdown below — the culprit is named'
    );
  }

  if (result.events) {
    const worst = result.events.worst;
    if (norm(worst.inputDelay) > budget.inputDelayMs) {
      add(
        'block',
        `delay before the handler: ${norm(worst.inputDelay).toFixed(1)} unthrottled ms (budget ${budget.inputDelayMs})`,
        'the main thread was busy at the moment of the tap: break long tasks with scheduler.yield'
      );
    }
    if (norm(worst.processing) > budget.processingMs) {
      add(
        'block',
        `handler: ${norm(worst.processing).toFixed(1)} unthrottled ms (budget ${budget.processingMs})`,
        'move everything out of the handler that the next frame does not need'
      );
    }
    if (norm(worst.presentation) > budget.presentationMs) {
      add(
        'flag',
        `from the end of the handler to the frame: ${norm(worst.presentation).toFixed(1)} unthrottled ms (budget ${budget.presentationMs})`,
        'expensive painting: many nodes, heavy shadows and filters, no content-visibility'
      );
    }
    if (norm(worst.total) > budget.interactionMs) {
      add('block', `whole interaction: ${norm(worst.total).toFixed(1)} unthrottled ms (budget ${budget.interactionMs})`, '');
    }
  }

  if (result.typing && norm(result.typing.p90Ms) > budget.typeLatencyP90Ms) {
    add(
      'block',
      `typing, p90: ${norm(result.typing.p90Ms).toFixed(1)} unthrottled ms (budget ${budget.typeLatencyP90Ms}), median ${norm(result.typing.medianMs).toFixed(1)}`,
      'filtering and re-rendering the list on every character: useDeferredValue, virtualisation, memoised rows'
    );
  }

  if (norm(result.loaf.thrashingMs) > budget.thrashingMs) {
    add(
      'block',
      `forced layout inside scripts: ${norm(result.loaf.thrashingMs).toFixed(1)} unthrottled ms`,
      'reading geometry after writing style: separate the read and write phases'
    );
  }
  if (result.loaf.pauseMs > 0) {
    add(
      'flag',
      `synchronous pauses in scripts: ${result.loaf.pauseMs.toFixed(0)} ms`,
      'synchronous XHR, alert, localStorage in a loop — get them off the main thread'
    );
  }
  if (result.counters.heapGrowthMb > budget.heapGrowthMb) {
    add(
      'flag',
      `heap grew by ${result.counters.heapGrowthMb.toFixed(1)} MB during the run`,
      'subscriptions, timers and listeners that outlived unmounting'
    );
  }
  if (result.counters.nodes > 5000) {
    add(
      'flag',
      `DOM nodes: ${result.counters.nodes}`,
      'virtualise the list and use content-visibility for off-screen sections'
    );
  }

  return issues;
}

function report(result, issues, throttle, budget) {
  const norm = (ms) => (ms / throttle).toFixed(1);
  console.log(`\n═══ ${result.name} ═══`);
  console.log(
    `profile: ${budget.label}, CPU throttled ×${throttle} (frame limit ${(16.67).toFixed(2)} ms = ${(16.67 / throttle).toFixed(2)} unthrottled ms)\n`
  );

  if (result.idle) {
    console.log('Idle (screen open, nobody touching it)');
    console.log(
      `  over ${result.idle.windowMs} ms: scripts ${result.idle.scriptMs.toFixed(0)} ms (${(result.idle.scriptMs / throttle).toFixed(1)} unthrottled), layouts ${result.idle.layouts}, style recalcs ${result.idle.styleRecalcs}, long frames ${result.idle.loafFrames}`
    );
    console.log(`  loading skeletons ${result.idle.skeletons}, spinners ${result.idle.spinners}\n`);
  }

  console.log('Scrolling');
  console.log(
    `  frames ${result.scroll.frames}, median ${result.scroll.medianMs.toFixed(1)} ms (${(1000 / (result.scroll.medianMs || 1)).toFixed(0)} fps), p95 ${result.scroll.p95Ms.toFixed(1)} ms, worst ${result.scroll.worstMs.toFixed(0)} ms`
  );
  console.log(`  frames longer than 50 ms: ${result.scroll.longFrames} (${(result.scroll.longFrameRatio * 100).toFixed(1)}%)`);

  if (result.events) {
    console.log('\nInteractions (components of INP)');
    for (const item of result.events.list) {
      console.log(
        `  ${item.name.padEnd(12)} total ${item.total.toFixed(0)} ms = waiting ${item.inputDelay.toFixed(0)} + handler ${item.processing.toFixed(0)} + painting ${item.presentation.toFixed(0)} (unthrottled ${norm(item.total)})`
      );
    }
  }

  if (result.typing) {
    console.log('\nTyping');
    console.log(
      `  characters ${result.typing.samples}, median ${result.typing.medianMs.toFixed(1)} ms, p90 ${result.typing.p90Ms.toFixed(1)} ms, worst ${result.typing.worstMs.toFixed(0)} ms (unthrottled p90 ${norm(result.typing.p90Ms)})`
    );
  }

  console.log('\nLong frames and who created them');
  console.log(
    `  long frames ${result.loaf.frames}, blocking time ${result.loaf.blockingMs.toFixed(0)} ms, forced layout from scripts ${result.loaf.thrashingMs.toFixed(1)} ms, synchronous pauses ${result.loaf.pauseMs.toFixed(0)} ms`
  );
  if (result.loaf.top.length) {
    for (const script of result.loaf.top) {
      const forced = script.forced > 0.5 ? `, of which forced layout ${script.forced.toFixed(1)} ms` : '';
      console.log(`  ${script.ms.toFixed(0)} ms × ${script.calls} — ${script.key}${forced}`);
    }
  } else {
    console.log('  no scripts made the breakdown: either there are none or each is under 5 ms — good news');
  }

  console.log('\nEngine counters');
  console.log(
    `  nodes ${result.counters.nodes}, listeners ${result.counters.listeners}, layouts ${result.counters.layouts} (${result.counters.layoutMs.toFixed(0)} ms), style recalcs ${result.counters.styleRecalcs} (${result.counters.styleMs.toFixed(0)} ms), scripts ${result.counters.scriptMs.toFixed(0)} ms`
  );
  console.log(
    `  heap ${result.counters.heapMb.toFixed(1)} MB, growth during the run ${result.counters.heapGrowthMb.toFixed(1)} MB, LCP ${result.vitals.lcp.toFixed(0)} ms, CLS ${result.vitals.cls.toFixed(3)}`
  );

  console.log('\nVerdict');
  if (!issues.length) {
    console.log('  within budget on every measurement');
  }
  for (const issue of issues) {
    console.log(`  ${issue.severity === 'block' ? 'BLOCK' : 'FLAG '} ${issue.text}`);
    if (issue.hint) console.log(`        → ${issue.hint}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const throttle = Number(args.throttle || config.throttle || 4);
  const profileName = args.profile || config.profile || 'product';
  const budget = { ...(PROFILES[profileName] || PROFILES.product) };
  for (const key of Object.keys(budget)) {
    if (args[`budget-${key}`]) budget[key] = Number(args[`budget-${key}`]);
  }

  const targets = await resolveTargets(args, config);
  const results = [];
  let blocking = 0;

  for (const target of targets) {
    const result = await runTarget(target, { throttle });
    const issues = judge(result, budget, throttle);
    blocking += issues.filter((i) => i.severity === 'block').length;
    report(result, issues, throttle, budget);
    results.push({ ...result, issues });
  }

  if (args.json) {
    writeFileSync(String(args.json), JSON.stringify({ throttle, profile: profileName, results }, null, 2));
    console.log(`\nDetails: ${args.json}`);
  }

  console.log(`\nBlocking violations: ${blocking}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
