#!/usr/bin/env node
/**
 * Mechanical layout check in a real browser.
 *
 * It checks what reading the code cannot: overlapping boxes, horizontal scroll,
 * accessibility, console errors, hydration mismatches, failed requests and in-page
 * links that lead nowhere — at every declared width.
 *
 * Usage:
 *   node verify-ui.mjs --url http://localhost:3000
 *   node verify-ui.mjs --config .uiverify.json
 *   node verify-ui.mjs --url http://localhost:3000 --font-scale 1.25   # large system text
 *   FQ_BROWSER=webkit node verify-ui.mjs --url http://localhost:3000    # another engine
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, resolveTargets, closeQuietly, writeScreenshot, engineOf } from './lib/session.mjs';

const DEFAULT_BREAKPOINTS = [
  // The smallest phone still in use: 320 px is where buttons in a row stop fitting.
  { name: 'smallest', width: 320, height: 568 },
  // The low viewport is a deliberate entry: it surfaces forms whose bottom you
  // cannot reach and button bars that have slid off the edge.
  { name: 'low', width: 390, height: 640 },
  { name: 'mobile', width: 390, height: 844 },
  // A phone turned sideways: a 390 px tall window is where fixed headers and
  // bottom bars eat the whole screen.
  { name: 'landscape', width: 844, height: 390 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
];

// A generous line-height inflates the box while the glyphs never touch.
// So an overlap only counts when a noticeable share of the area is covered.
const OVERLAP_TOLERANCE_PX = 4;

// React reports a hydration mismatch with a number in production builds and with
// words in development ones. Either way the server and the first client render
// disagreed: React threw the server HTML away (a flash, lost input, layout jump)
// or, worse, kept the wrong text.
const HYDRATION_PATTERN =
  /Minified React error #(418|423|425)\b|Hydration failed|hydration mismatch|(did not|didn't) match[^]*server|server[^]*(did not|didn't) match/i;
const HYDRATION_MEANING =
  'hydration mismatch — the first render differs from the server (often storage or Date read during render)';

function loadConfig(args) {
  const configPath = resolve(args.config || '.uiverify.json');
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {};
  return {
    raw: config,
    breakpoints: config.breakpoints || DEFAULT_BREAKPOINTS,
    outDir: config.outDir || '.uiverify-out',
    // Selectors whose overlaps are checked. Text leaves by default.
    overlapSelector:
      config.overlapSelector ||
      'h1, h2, h3, h4, p, li, button, a, label, span[class], td, th',
    ignoreConsole: config.ignoreConsole || [],
    // Deliberate overlaps (display type over text, collages) are excluded by
    // selector: automation cannot tell intent from breakage.
    ignoreOverlap: config.ignoreOverlap || [],
    skipAxe: config.skipAxe === true,
    // Large system text: the root font size is raised, so everything set in rem
    // grows the way it does when a person turns text size up on the phone.
    fontScale: Number(args['font-scale'] || config.fontScale || 1),
  };
}

/** Axis-aligned bounding box overlap with tolerance. */
function boxesOverlap(a, b, tolerance) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlapX <= tolerance || overlapY <= tolerance) return false;
  // A generous line-height inflates the box by a few pixels while the glyphs
  // never touch. A real collision covers a noticeable share of the area.
  const overlapArea = overlapX * overlapY;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 && overlapArea / smaller > 0.25;
}

/** Collects the geometry of visible text leaves inside the page. */
async function collectGeometry(page, selector, ignoreSelectors) {
  return page.evaluate(({ sel, ignore }) => {
    const isTextLeaf = (el) =>
      !Array.from(el.children).some((child) =>
        (child.textContent || '').trim()
      );

    // A collapsed accordion, a carousel and any container with overflow:hidden
    // keep content in the DOM but clip it. Such text is invisible and takes no
    // part in overlaps — otherwise every closed FAQ yields a false BLOCK.
    const isClipped = (el) => {
      const rect = el.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const centerX = rect.left + rect.width / 2;
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        const clipsY = /hidden|clip|auto|scroll/.test(style.overflow + style.overflowY);
        const clipsX = /hidden|clip|auto|scroll/.test(style.overflow + style.overflowX);
        if (!clipsY && !clipsX) continue;
        const box = node.getBoundingClientRect();
        if (box.height === 0 || box.width === 0) return true;
        if (clipsY && (centerY < box.top - 1 || centerY > box.bottom + 1)) return true;
        // Marquees and carousels move copies of elements sideways out of the
        // track: vertically they are in place, horizontally past the edge.
        if (clipsX && (centerX < box.left - 1 || centerX > box.right + 1)) return true;
      }
      return false;
    };

    return Array.from(document.querySelectorAll(sel))
      .filter((el) => {
        if (ignore.length && ignore.some((s) => el.closest(s))) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) === 0) return false;
        if (!(el.textContent || '').trim()) return false;
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
        if (isClipped(el)) return false;
        return isTextLeaf(el);
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        // Absolute and fixed decoration over an image overlaps its neighbours by
        // design. A layout bug is a collision between elements in flow.
        let positioned = false;
        for (let node = el; node && node !== document.body; node = node.parentElement) {
          const pos = getComputedStyle(node).position;
          if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') {
            positioned = true;
            break;
          }
        }
        return {
          tag: el.tagName.toLowerCase(),
          positioned,
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      })
      .filter((item) => item.box.width > 0 && item.box.height > 0);
  }, { sel: selector, ignore: ignoreSelectors });
}

/**
 * Text that does not fit.
 *
 * Two different failures, and they must not be conflated. First — the label
 * escapes the card: the parent does not clip, so the text lies over its
 * neighbours. Second — the label is clipped without an ellipsis: the user sees
 * a stump and cannot tell what follows.
 */
async function collectTextOverflow(page) {
  return page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll('h1,h2,h3,h4,p,span,li,td,th,button,a,label,div');
    for (const el of nodes) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      // Text leaves only: overflow in containers is measured differently.
      if (Array.from(el.children).some((c) => (c.textContent || '').trim())) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const overflowsSelf = el.scrollWidth > el.clientWidth + 1;
      const clipped = /hidden|clip/.test(style.overflowX);
      const hasEllipsis = style.textOverflow === 'ellipsis';

      if (overflowsSelf && clipped && !hasEllipsis) {
        out.push({
          kind: 'clipped-no-ellipsis',
          text: text.slice(0, 40),
          detail: `${el.scrollWidth}px of text in ${el.clientWidth}px, clipped without an ellipsis`,
        });
        continue;
      }

      // Not clipped and does not fit — the label lies over its neighbours. This is
      // exactly what "the item name escapes the card" looked like.
      if (overflowsSelf && !clipped) {
        out.push({
          kind: 'escapes-parent',
          text: text.slice(0, 40),
          detail: `${el.scrollWidth}px of text in a ${el.clientWidth}px box, nothing clips it`,
        });
        continue;
      }

      // Escaping the parent: it does not clip, so the label lands on its neighbours.
      const parent = el.parentElement;
      if (!parent) continue;
      const parentStyle = getComputedStyle(parent);
      if (/hidden|clip|auto|scroll/.test(parentStyle.overflow + parentStyle.overflowX)) continue;
      const parentRect = parent.getBoundingClientRect();
      const escapeRight = rect.right - parentRect.right;
      const escapeLeft = parentRect.left - rect.left;
      if (Math.max(escapeRight, escapeLeft) > 2 && parentRect.width > 0) {
        out.push({
          kind: 'escapes-parent',
          text: text.slice(0, 40),
          detail: `escapes its parent by ${Math.round(Math.max(escapeRight, escapeLeft))}px`,
        });
      }
    }
    return out.slice(0, 25);
  });
}

/**
 * Interactive elements you cannot reach.
 *
 * A failure from low viewports: the form is taller than the window and there is
 * no scroll — the "Save" button is simply unreachable. On a desktop monitor this
 * is never visible.
 */
async function collectUnreachable(page) {
  return page.evaluate(() => {
    const scrollableAncestor = (el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const s = getComputedStyle(node);
        const scrolls = /auto|scroll/.test(s.overflowY);
        if (scrolls && node.scrollHeight > node.clientHeight + 1) return true;
      }
      // Root scrolling can be disabled by style: content is taller than the window
      // yet cannot be scrolled — exactly how a form became unreachable.
      const root = document.scrollingElement || document.documentElement;
      const rootBlocked = [document.documentElement, document.body].some((node) =>
        /hidden|clip/.test(getComputedStyle(node).overflowY)
      );
      if (rootBlocked) return false;
      return root.scrollHeight > root.clientHeight + 1;
    };

    const out = [];
    const nodes = document.querySelectorAll(
      'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea'
    );
    for (const el of nodes) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const below = rect.top - window.innerHeight;
      const above = -rect.bottom;
      if (below <= 0 && above <= 0) continue;
      if (scrollableAncestor(el)) continue;
      out.push({
        label:
          (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) ||
          el.tagName.toLowerCase(),
        detail: `${below > 0 ? 'below' : 'above'} the viewport by ${Math.round(Math.max(below, above))}px, no scroll available`,
      });
    }
    return out.slice(0, 10);
  });
}

/**
 * In-page links that lead nowhere: `href="#pricing"` with no element of that id
 * (or name). The person taps and nothing happens — a renamed section, a copied
 * menu. Bare "#" and hash routes ("#/", "#!") are not section links.
 */
async function collectBrokenAnchors(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href^="#"]')) {
      const href = a.getAttribute('href') || '';
      if (href === '#' || href.startsWith('#/') || href.startsWith('#!') || seen.has(href)) continue;
      seen.add(href);
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* keep the raw fragment */
      }
      // "#top" scrolls to the top by the HTML standard even without such an id.
      if (id.toLowerCase() === 'top') continue;
      if (document.getElementById(id) || document.getElementsByName(id).length) continue;
      out.push({
        href,
        label: (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || '(no text)',
      });
    }
    return out.slice(0, 15);
  });
}

async function checkHorizontalScroll(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/** axe-core is injected from local node_modules; without it the check is skipped. */
async function runAxe(page) {
  const candidates = [
    resolve('node_modules/axe-core/axe.min.js'),
    resolve(process.env.HOME || '', 'node_modules/axe-core/axe.min.js'),
  ];
  const axePath = candidates.find((p) => existsSync(p));
  if (!axePath) return { skipped: 'axe-core is not installed (npm i -D axe-core)' };

  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return {
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
        target: v.nodes[0]?.target?.join(' ') || '',
      })),
    };
  });
}

async function verifyOne(page, target, breakpoint, config, outDir) {
  const findings = [];
  const consoleErrors = [];
  const failedRequests = [];

  const ignoreConsole = [...config.ignoreConsole, ...(target.ignoreConsole || [])];
  const ignoreRequests = target.ignoreRequests || [];

  const onConsole = (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ignoreConsole.some((pattern) => text.includes(pattern))) return;
    consoleErrors.push(text.slice(0, 200));
  };
  // An uncaught exception never reaches the console listener in Playwright, and a
  // production React build reports hydration failures exactly that way.
  const onPageError = (error) => {
    const text = `uncaught ${error.name || 'Error'}: ${error.message || error}`;
    if (ignoreConsole.some((pattern) => text.includes(pattern))) return;
    consoleErrors.push(text.slice(0, 200));
  };
  const onFailed = (request) => {
    const url = request.url();
    if (ignoreRequests.some((pattern) => url.includes(pattern))) return;
    failedRequests.push(`${request.method()} ${url.slice(0, 160)}`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onFailed);

  await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height });
  // Drives the page into the state under test: a navigation for a URL, or login,
  // mocks and the right screen for a scenario.
  await target.ready(page);
  if (config.fontScale !== 1) {
    await page.addStyleTag({ content: `html{font-size:${Math.round(config.fontScale * 100)}% !important}` });
    await page.waitForTimeout(150);
  }

  const scroll = await checkHorizontalScroll(page);
  if (scroll.scrollWidth > scroll.clientWidth) {
    findings.push({
      kind: 'horizontal-scroll',
      severity: 'block',
      detail: `scrollWidth ${scroll.scrollWidth} > clientWidth ${scroll.clientWidth}`,
    });
  }

  const geometry = (
    await collectGeometry(page, config.overlapSelector, config.ignoreOverlap)
  ).filter(
    (item) => !item.positioned
  );
  for (let i = 0; i < geometry.length; i++) {
    for (let j = i + 1; j < geometry.length; j++) {
      if (boxesOverlap(geometry[i].box, geometry[j].box, OVERLAP_TOLERANCE_PX)) {
        findings.push({
          kind: 'overlap',
          severity: 'block',
          detail: `“${geometry[i].text}” overlaps “${geometry[j].text}”`,
        });
      }
    }
  }

  for (const item of await collectTextOverflow(page)) {
    findings.push({
      kind: item.kind === 'escapes-parent' ? 'text-escapes' : 'text-clipped',
      // Escaping the parent lands on neighbours — that is a layout failure.
      // Clipping without an ellipsis is a human call: sometimes it is intended.
      severity: item.kind === 'escapes-parent' ? 'block' : 'flag',
      detail: `«${item.text}»: ${item.detail}`,
    });
  }

  for (const item of await collectUnreachable(page)) {
    findings.push({
      kind: 'unreachable',
      severity: 'block',
      detail: `“${item.label}” cannot be reached: ${item.detail}`,
    });
  }

  if (!config.skipAxe) {
    const axe = await runAxe(page);
    if (axe.skipped) {
      findings.push({ kind: 'axe-skipped', severity: 'info', detail: axe.skipped });
    } else {
      for (const violation of axe.violations) {
        findings.push({
          kind: 'a11y',
          severity: violation.impact === 'critical' ? 'block' : 'flag',
          detail: `${violation.id}: ${violation.help} (${violation.nodes} nodes) ${violation.target}`,
        });
      }
    }
  }

  for (const item of await collectBrokenAnchors(page)) {
    findings.push({
      kind: 'broken-anchor',
      severity: 'flag',
      detail: `link “${item.label}” points to ${item.href}, but the page has no element with that id`,
    });
  }

  for (const error of consoleErrors) {
    if (HYDRATION_PATTERN.test(error)) {
      findings.push({ kind: 'hydration', severity: 'block', detail: `${HYDRATION_MEANING}: ${error}` });
    } else {
      findings.push({ kind: 'console-error', severity: 'block', detail: error });
    }
  }
  for (const request of failedRequests) {
    findings.push({ kind: 'request-failed', severity: 'block', detail: request });
  }

  const slug = String(target.name).replace(/[^\w-]+/g, '_').slice(-40);
  const shot = join(outDir, `${slug}-${breakpoint.name}-${breakpoint.width}.png`);
  const { preview } = await writeScreenshot(page, shot, { fullPage: true });

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('requestfailed', onFailed);

  return {
    url: target.name,
    breakpoint: breakpoint.name,
    width: breakpoint.width,
    screenshot: shot,
    preview,
    findings,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const outDir = resolve(config.outDir);
  mkdirSync(outDir, { recursive: true });

  const targets = await resolveTargets(args, config.raw);
  const results = [];
  let engine = null;

  for (const target of targets) {
    // A scenario brings up its own environment (mocks, login), so each target gets
    // its own browser: cookies and route handlers must not leak between them.
    const opened = await target.open({ throttle: 1 });
    engine = engine || engineOf(opened.page);
    try {
      for (const breakpoint of config.breakpoints) {
        results.push(await verifyOne(opened.page, target, breakpoint, config, outDir));
      }
    } finally {
      await closeQuietly(opened);
    }
  }

  const blocking = results.flatMap((r) =>
    r.findings.filter((f) => f.severity === 'block').map((f) => ({ ...f, at: `${r.url} @${r.width}` }))
  );
  // The same broken link or clipped label shows up at every width: one line each.
  const seenFlags = new Set();
  const flags = results
    .flatMap((r) => r.findings.filter((f) => f.severity === 'flag'))
    .filter((f) => {
      const key = `${f.kind}|${f.detail}`;
      if (seenFlags.has(key)) return false;
      seenFlags.add(key);
      return true;
    });

  console.log(`\nEngine: ${engine ? `${engine.name} ${engine.version}` : 'unknown'}`);
  console.log(`Checked: ${targets.length} target(s) × ${config.breakpoints.length} widths`);
  if (config.fontScale !== 1) {
    console.log(
      `Font scale: ${Math.round(config.fontScale * 100)}% root size — text set in rem/em grows, text set in px does not`
    );
  }
  console.log(`Screenshots: ${outDir}`);
  const previews = results.filter((r) => r.preview);
  if (previews.length) {
    console.log('Too large to read as an image — open the preview instead:');
    for (const r of previews) console.log(`  ${r.preview}`);
  }
  console.log(`Blocking: ${blocking.length} | warnings: ${flags.length}\n`);
  for (const finding of blocking) {
    console.log(`  BLOCK [${finding.kind}] ${finding.at}\n         ${finding.detail}`);
  }
  for (const finding of flags.slice(0, 20)) {
    console.log(`  FLAG  [${finding.kind}] ${finding.detail}`);
  }

  process.exit(blocking.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
