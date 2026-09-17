#!/usr/bin/env node
/**
 * Motion and weight: frame durations under scroll, long tasks, resource weight,
 * LCP, CLS and respect for prefers-reduced-motion.
 *
 * This is what a screenshot cannot show: a site can be beautiful and stutter at
 * the same time. Heavy graphics without this check is a blind bet.
 *
 * Usage:
 *   node verify-motion.mjs --url http://localhost:3000
 *   node verify-motion.mjs --url ... --budget-js 600
 *   node verify-motion.mjs --url ... --throttle 4     # emulate mid-range hardware
 *
 * Exit: 0 — within budget, 1 — thresholds broken, 2 — could not run.
 */

import { chromium } from 'playwright';

const THRESHOLDS = {
  // Share of frames longer than 50 ms across one scroll pass. Above it — visible jank.
  longFrameRatio: 0.05,
  fpsP50: 50,
  lcpMs: 2500,
  cls: 0.1,
  jsKb: 900,
  totalKb: 3500,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

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

async function run(url, options) {
  const browser = await chromium.launch();
  const findings = [];
  const weights = { js: 0, css: 0, image: 0, font: 0, media: 0, total: 0 };

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(VITALS_INIT);

    // Development happens on a fast machine, the site is viewed on a mid-range one.
    // Throttling shows what would otherwise surface only for the user.
    if (options.throttle > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
    }

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

    const measured = await page.evaluate(() => {
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
    Object.assign(weights, measured);
    const scroll = await measureScroll(page);
    const vitals = await page.evaluate(() => window.__vitals);

    // Second pass: the site must respect the system "reduce motion" setting.
    const reducedContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const reducedPage = await reducedContext.newPage();
    await reducedPage.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await reducedPage.waitForTimeout(1500);
    const running = await reducedPage.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== 1).length
    );

    const fpsP50 = scroll.medianMs > 0 ? 1000 / scroll.medianMs : 0;

    const check = (ok, severity, text) =>
      findings.push({ ok, severity, text });

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

    return { findings, scroll, vitals, weights };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) throw new Error('Pass --url');
  const result = await run(args.url, {
    budgetJs: args['budget-js'] ? Number(args['budget-js']) : null,
    throttle: args.throttle ? Number(args.throttle) : 1,
  });

  const failed = result.findings.filter((f) => !f.ok && f.severity === 'block');
  const flagged = result.findings.filter((f) => !f.ok && f.severity === 'flag');

  const throttleNote = args.throttle ? `, CPU throttled ${args.throttle}×` : '';
  console.log(`\nMotion and weight: ${args.url}`);
  console.log(`Frames measured: ${result.scroll.frames}${throttleNote}\n`);
  for (const finding of result.findings) {
    const mark = finding.ok ? 'ok   ' : finding.severity === 'block' ? 'BLOCK' : 'FLAG ';
    console.log(`  ${mark} ${finding.text}`);
  }
  console.log(`\nBlocking: ${failed.length} | warnings: ${flagged.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
