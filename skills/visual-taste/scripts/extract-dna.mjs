#!/usr/bin/env node
/**
 * Takes the measurable "DNA" of a reference site: which font sizes, weights,
 * line heights, tracking, spacing, colours, radii, shadows and motion durations
 * it actually uses — with the frequency of each value.
 *
 * Why. A trained eye is built from numbers, not impressions. The point is not
 * to copy someone's site, it is to see what decisions people who do it well
 * make and how NARROW their set is: six font sizes against your twenty-three
 * says more than "it feels cleaner". verify-vocabulary.mjs measures your own
 * site the same way; put the two side by side.
 *
 * Usage:
 *   node extract-dna.mjs --url https://example.com [--slug example] [--out ./dna]
 *
 * Writes into --out (default ./dna in the current directory):
 *   <slug>.md         a summary to read
 *   <slug>.json       the raw counts
 *   <slug>-full.png   desktop screenshot (1440×900, full page)
 *   <slug>-mobile.png phone screenshot (390×844, full page)
 *
 * Exit: 0 — written, 2 — the page could not be measured (a stub card with the
 * reason is still written, so the gap in the library is visible).
 *
 * Playwright comes from the frontend-quality skill next door
 * (npm install in skills/frontend-quality), like the other scripts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Playwright from skills/frontend-quality/node_modules, else from wherever Node finds it. */
async function loadChromium() {
  const candidates = [
    join(HERE, '..', '..', 'frontend-quality', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  for (const from of candidates) {
    try {
      return createRequire(from)('playwright').chromium;
    } catch {
      /* try the next place */
    }
  }
  try {
    return (await import('playwright')).chromium;
  } catch {
    console.error('extract-dna: playwright is not installed. Run `npm install` in skills/frontend-quality.');
    process.exit(2);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

/** Runs in the page: tallies computed styles of every visible element. */
const COLLECT = () => {
  const tally = (map, key) => {
    if (!key || key === 'none' || key === 'normal' || key === '0px' || key === '0s' || key === 'auto') return;
    map[key] = (map[key] || 0) + 1;
  };

  const data = {
    fontSize: {}, lineHeight: {}, letterSpacing: {}, fontFamily: {}, fontWeight: {},
    spacing: {}, radius: {}, shadow: {}, transition: {}, easing: {},
    animation: {}, animationDuration: {}, colorText: {}, colorBg: {},
  };

  const elements = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
  for (const el of elements) {
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) {
      tally(data.fontSize, s.fontSize);
      tally(data.lineHeight, s.lineHeight);
      tally(data.letterSpacing, s.letterSpacing);
      tally(data.fontFamily, s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
      tally(data.fontWeight, s.fontWeight);
      tally(data.colorText, s.color);
    }
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') tally(data.colorBg, s.backgroundColor);
    for (const prop of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom', 'gap', 'rowGap', 'columnGap']) {
      tally(data.spacing, s[prop]);
    }
    tally(data.radius, s.borderRadius);
    tally(data.shadow, s.boxShadow);
    tally(data.transition, s.transitionDuration);
    tally(data.easing, s.transitionTimingFunction);
    tally(data.animation, s.animationName);
    if (s.animationName && s.animationName !== 'none') tally(data.animationDuration, s.animationDuration);
  }

  // Section rhythm: heights of the direct children of main (or body).
  const root = document.querySelector('main') || document.body;
  const sections = Array.from(root.children)
    .map((el) => Math.round(el.getBoundingClientRect().height))
    .filter((h) => h > 40);

  const container = Array.from(document.querySelectorAll('main > *, body > div > *'))
    .map((el) => Math.round(el.getBoundingClientRect().width))
    .filter((w) => w > 200)
    .sort((a, b) => b - a)
    .slice(0, 8);

  // A site can be drawn entirely on a canvas: then its DNA is not in the CSS,
  // and the summary has to say so instead of handing over empty numbers.
  const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => {
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const textNodes = Array.from(document.querySelectorAll('body *')).filter((el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()),
  ).length;

  return {
    data,
    canvases,
    textNodes,
    sections,
    container,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    docHeight: document.documentElement.scrollHeight,
    fontsLoaded: Array.from(document.fonts || []).map((f) => `${f.family} ${f.weight}`).slice(0, 12),
  };
};

/** The most frequent values: the narrowness of the set is what marks systematic work. */
function top(map, n = 10) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => `${value} (${count})`);
}

function toMarkdown(url, slug, result, weights) {
  const d = result.data;
  const uniq = (m) => Object.keys(m).length;
  const canvasSite = result.textNodes < 20 && result.canvases.length;
  return `# DNA: ${slug}

Source: ${url}
Taken: ${new Date().toISOString().slice(0, 10)}, viewport ${result.viewport.width}×${result.viewport.height}, document height ${result.docHeight}px

## Typography

- Families: ${top(d.fontFamily, 4).join(', ') || 'none'}
- Font sizes in use: **${uniq(d.fontSize)}** → ${top(d.fontSize, 10).join(', ')}
- Weights: ${top(d.fontWeight, 6).join(', ')}
- Line heights: ${top(d.lineHeight, 6).join(', ')}
- Tracking: ${top(d.letterSpacing, 6).join(', ') || 'not set anywhere'}
- Loaded faces: ${result.fontsLoaded.join(' · ') || 'none reported'}

## Space

- Spacing values in use: **${uniq(d.spacing)}** → ${top(d.spacing, 12).join(', ')}
- Container widths: ${result.container.slice(0, 5).join(', ')}
- Section heights: ${result.sections.slice(0, 12).join(', ')}

## Colour

- Text colours: **${uniq(d.colorText)}** → ${top(d.colorText, 6).join(', ')}
- Background colours: **${uniq(d.colorBg)}** → ${top(d.colorBg, 6).join(', ')}

## Shape and depth

- Radii: ${top(d.radius, 6).join(', ') || 'none'}
- Shadows: ${top(d.shadow, 4).join(', ') || 'no shadows'}

## Motion

- Transition durations: ${top(d.transition, 6).join(', ') || 'no transitions'}
- Curves: ${top(d.easing, 4).join(', ') || 'none'}
- Named animations: ${top(d.animation, 6).join(', ') || 'none'}
- Animation durations: ${top(d.animationDuration, 6).join(', ') || 'none'}

## Weight

- JS ${weights.js} KB · CSS ${weights.css} KB · images ${weights.image} KB · fonts ${weights.font} KB · total ${weights.total} KB

## Nature of the site

- Text nodes in the DOM: **${result.textNodes}**
- Canvas: ${result.canvases.length ? result.canvases.map((c) => `${c.w}×${c.h}`).join(', ') : 'none'}
${canvasSite ? '- **The site is drawn on a canvas: its typography and layout live in a GPU scene, not in CSS. Take it apart frame by frame, not by computed styles.**' : ''}

## What follows from this

_Fill in by hand after looking at the screenshots: which move carries the page,
what holds the sense of quality, what of it transfers to your product._
`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error('Usage: node extract-dna.mjs --url https://example.com [--slug name] [--out ./dna]');
    process.exit(2);
  }
  const slug = args.slug || new URL(args.url).hostname.replace(/^www\./, '').replace(/\./g, '-');
  const outDir = resolve(args.out || 'dna');
  mkdirSync(outDir, { recursive: true });

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Sites with endless network activity (analytics, streams) never reach
    // networkidle — for them "load" plus a pause is enough.
    try {
      await page.goto(args.url, { waitUntil: 'networkidle', timeout: 45_000 });
    } catch {
      await page.goto(args.url, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForTimeout(4000);
    }
    // Preloaders, lazy loading and reveal-on-scroll: without a pass down the
    // page the measurement sees an empty shell.
    await page.waitForTimeout(3000);
    await page.evaluate(async () => {
      const height = document.documentElement.scrollHeight;
      for (let y = 0; y < height; y += window.innerHeight * 0.8) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 500));
    });

    const result = await page.evaluate(COLLECT);
    const weights = await page.evaluate(() => {
      const acc = { js: 0, css: 0, image: 0, font: 0, total: 0 };
      for (const e of performance.getEntriesByType('resource')) {
        const kb = (e.transferSize || e.encodedBodySize || 0) / 1024;
        acc.total += kb;
        if (e.initiatorType === 'script') acc.js += kb;
        else if (e.initiatorType === 'link' || e.initiatorType === 'css') acc.css += kb;
        else if (e.initiatorType === 'img') acc.image += kb;
        else if (/\.(woff2?|ttf|otf)/.test(e.name)) acc.font += kb;
      }
      return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(v)]));
    });

    await page.screenshot({ path: join(outDir, `${slug}-full.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `${slug}-mobile.png`), fullPage: true });

    writeFileSync(join(outDir, `${slug}.json`), JSON.stringify({ url: args.url, ...result, weights }, null, 2));
    writeFileSync(join(outDir, `${slug}.md`), toMarkdown(args.url, slug, result, weights));

    console.log(`Written: ${join(outDir, `${slug}.md`)}`);
    console.log(`Screenshots: ${slug}-full.png, ${slug}-mobile.png`);
    console.log(
      `Font sizes: ${Object.keys(result.data.fontSize).length}, spacing values: ${Object.keys(result.data.spacing).length}, ` +
        `colours: ${Object.keys(result.data.colorText).length} text / ${Object.keys(result.data.colorBg).length} background, weight: ${weights.total} KB`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  // Heavy WebGL sites do not get ready in the time given. Staying silent is not
  // an option: the library would keep a gap nobody remembers.
  const args = parseArgs(process.argv);
  const slug = args.slug || 'unknown';
  const outDir = resolve(args.out || 'dna');
  const reason = String(error?.message || error).split('\n')[0];
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, `${slug}.md`),
      `# DNA: ${slug}\n\nSource: ${args.url}\nTaken: ${new Date().toISOString().slice(0, 10)}\n\n` +
        `## Could not be measured\n\nReason: ${reason}\n\n` +
        'Usually this means the site is drawn on a canvas and loads longer than the\n' +
        'time given. Computed styles of such a site are empty anyway — take it apart\n' +
        'frame by frame instead.\n',
    );
    console.error(`Could not take the DNA (${reason}). A card with the reason was written.`);
  } catch {
    console.error(`Could not take the DNA: ${reason}`);
  }
  process.exit(2);
});
