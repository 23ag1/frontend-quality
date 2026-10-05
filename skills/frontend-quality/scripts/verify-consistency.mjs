#!/usr/bin/env node
/**
 * Consistency: the same thing looks the same everywhere.
 *
 * Each page on its own can pass every other check and the product still looks
 * assembled from parts: the column is 8 px wider on one page, the heading sits
 * lower on another, prices in a row of cards wander up and down, a tab switch
 * makes the section jump. None of it is visible on one screenshot; all of it is
 * visible to someone clicking through. So the same numbers are measured on every
 * page at every width and compared.
 *
 *   gutters      BLOCK left and right gutters of the content column differ by
 *                more than 2 px on a page, or the left gutter differs between pages
 *   column       BLOCK the content column width differs between pages (> 2 px)
 *   heading      BLOCK the heading's top offset (> 2 px) or font size differs
 *                between pages; FLAG a page without one when others have it
 *   groups       BLOCK same-role rows of neighbouring items in one visual row
 *                (title to title, price to price) differ in top by more than 2 px
 *   toggles      BLOCK switching a tab/segment changes the section's height
 *                (numbers printed per width)
 *   buttons      FLAG text + icon off-centre by more than 1.5 px, or spilling into
 *                the padding
 *   focus        FLAG a ring after a mouse click (draw it with :focus-visible);
 *                BLOCK no ring after keyboard Tab
 *   words        FLAG main's visible text exceeds `maxWords`
 *
 * Pages are compared with the first URL in the list, at the same width.
 *
 * Config (.uiverify.json):
 *   "consistency": {
 *     "urls": ["http://localhost:3000/", "http://localhost:3000/about"],
 *     "widths": [360, 390, 768, 1280],
 *     "content": "main",           // the content column (single-child wrappers are followed)
 *     "heading": "h1",
 *     "groups": [{ "name": "cards", "item": ".card", "rows": ["h3", ".price"] }],
 *     "toggles": [{ "name": "tabs", "trigger": "[role=tab]", "section": "[role=tabpanel]" }],
 *     "buttons": "button, a.btn",
 *     "maxWords": null
 *   }
 * Without "urls" the top-level "urls" are used.
 *
 * Usage:
 *   node verify-consistency.mjs --config .uiverify.json
 *   node verify-consistency.mjs --url http://localhost:3000/ --url http://localhost:3000/about
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { parseArgs, loadConfig, launchBrowser, contextOptions, announceEngine } from './lib/session.mjs';

const DEFAULT_WIDTHS = [360, 390, 768, 1280];
const HEIGHT = 900;
const GUTTER_TOLERANCE = 2;
const ROW_TOLERANCE = 2;
const CENTRE_TOLERANCE = 1.5;

/** `--url` may be repeated; parseArgs keeps only the last one. */
function urlsFromArgv(argv) {
  const urls = [];
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--url' && argv[i + 1] && !argv[i + 1].startsWith('--')) urls.push(argv[i + 1]);
  }
  return urls;
}

/** Everything that needs no clicking, in one pass over the page. */
function measurePage({ content, heading, groups, buttons, tolerance }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
    return typeof el.checkVisibility !== 'function' || el.checkVisibility();
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const viewWidth = document.documentElement.clientWidth;

  // ── column ──
  const root = document.querySelector(content) || document.body;
  const contentBox = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      left: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
      right: r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight),
    };
  };
  // The column is where the horizontal padding or the max-width lives. A
  // full-width main hands it down: to its single wrapper (`main > .container`),
  // or, with several full-width sections, to the box most of them share.
  const inFlow = (el) =>
    Array.from(el.children)
      .slice(0, 30)
      .filter((k) => visible(k) && !/absolute|fixed/.test(getComputedStyle(k).position));
  const columnOf = (el, depth) => {
    const box = contentBox(el);
    if (depth > 6 || box.right - box.left < viewWidth - 1) return { el, box };
    const kids = inFlow(el);
    if (!kids.length) return { el, box };
    if (kids.length === 1) return columnOf(kids[0], depth + 1);
    const votes = new Map();
    for (const kid of kids) {
      const found = columnOf(kid, depth + 1);
      const key = `${Math.round(found.box.left)}|${Math.round(found.box.right)}`;
      const entry = votes.get(key) || { n: 0, found };
      entry.n += 1;
      votes.set(key, entry);
    }
    return [...votes.values()].sort((a, b) => b.n - a.n)[0].found;
  };
  const { el: column, box } = columnOf(root, 0);
  const describe = (el) =>
    el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '');
  const col = {
    selector: column === root ? content : `${content} … ${describe(column)}`,
    left: Math.round(box.left),
    right: Math.round(viewWidth - box.right),
    width: Math.round(box.right - box.left),
  };

  // ── heading ──
  const h = Array.from(document.querySelectorAll(heading)).find(visible);
  const head = h
    ? {
        top: Math.round(h.getBoundingClientRect().top + scrollY),
        size: getComputedStyle(h).fontSize,
        text: label(h),
      }
    : null;

  // ── groups: same-role rows of neighbours in one visual row ──
  const groupFindings = [];
  for (const group of groups) {
    const items = Array.from(document.querySelectorAll(group.item)).filter(visible);
    const byParent = new Map();
    for (const it of items) {
      const list = byParent.get(it.parentElement) || [];
      list.push(it);
      byParent.set(it.parentElement, list);
    }
    for (const siblings of byParent.values()) {
      // Visual rows: same top (±6 px) and the same width — in a bento grid
      // cells of different sizes have their own rhythm and are not compared.
      const rows = [];
      for (const it of siblings) {
        const r = it.getBoundingClientRect();
        const row = rows.find((x) => Math.abs(x.top - r.top) < 6 && Math.abs(x.width - r.width) < 1.5);
        if (row) row.items.push(it);
        else rows.push({ top: r.top, width: r.width, items: [it] });
      }
      for (const row of rows) {
        if (row.items.length < 2) continue;
        for (const sel of group.rows || []) {
          const tops = row.items.map((it) => {
            const el = Array.from(it.querySelectorAll(sel)).find(visible);
            return el ? el.getBoundingClientRect().top : null;
          });
          if (tops.some((t) => t === null)) continue;
          const spread = Math.max(...tops) - Math.min(...tops);
          if (spread > 2) {
            groupFindings.push({
              group: group.name || group.item,
              role: sel,
              spread: Math.round(spread * 10) / 10,
              count: row.items.length,
              sample: label(row.items[0]),
            });
          }
        }
      }
    }
  }

  // ── buttons: content centred and inside the padding ──
  const buttonFindings = [];
  const seen = new Set();
  for (const el of Array.from(document.querySelectorAll(buttons)).slice(0, 120)) {
    if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (/hidden|auto|scroll|clip/.test(cs.overflowX)) continue;
    // A button cut by a scrolling or clipping ancestor (carousel) is not judged here.
    let clipped = false;
    const B = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const R = a.getBoundingClientRect();
      if (B.right > R.right + 1 || B.left < R.left - 1) {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    const hiddenParts = Array.from(el.querySelectorAll('*')).filter((x) => {
      const c = getComputedStyle(x);
      return (
        (c.position === 'absolute' && (c.clip !== 'auto' || c.clipPath !== 'none')) ||
        c.display === 'none' ||
        c.opacity === '0' ||
        c.visibility === 'hidden'
      );
    });
    const rects = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode()); ) {
      if (!n.textContent.trim()) continue;
      const parent = n.parentElement;
      if (hiddenParts.some((x) => x === parent || x.contains(parent))) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width) rects.push(r);
    }
    for (const g of el.querySelectorAll('svg, img')) {
      if (hiddenParts.some((x) => x === g || x.contains(g))) continue;
      const r = g.getBoundingClientRect();
      if (r.width) rects.push(r);
    }
    if (!rects.length) continue;
    const T = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
    const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
    const spill = Math.max(B.left + pl - T.left, T.right - (B.right - pr));
    const centred =
      cs.justifyContent === 'center' ||
      (cs.textAlign === 'center' && /^(block|inline-block|list-item)$/.test(cs.display));
    const off = centred ? (T.left + T.right) / 2 - (B.left + B.right) / 2 : 0;
    const name = label(el) || el.tagName.toLowerCase();
    const key = `${name}|${Math.round(B.width)}`;
    if (seen.has(key)) continue;
    if (spill > tolerance) {
      seen.add(key);
      buttonFindings.push({ name, kind: 'spill', px: Math.round(spill * 10) / 10, width: Math.round(B.width) });
    } else if (Math.abs(off) > tolerance) {
      seen.add(key);
      buttonFindings.push({ name, kind: 'off', px: Math.round(off * 10) / 10, width: Math.round(B.width) });
    }
  }

  const words = (root.innerText || '').split(/\s+/).filter(Boolean).length;
  return { column: col, head, groupFindings, buttonFindings, words, rootFound: Boolean(document.querySelector(content)) };
}

/** Section height across every trigger of a toggle. */
async function measureToggle(page, toggle) {
  const count = await page.evaluate((sel) => {
    const vis = (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    return Array.from(document.querySelectorAll(sel)).filter(vis).length;
  }, toggle.trigger);
  if (count < 2) return null;
  const heights = [];
  const labels = [];
  for (let i = 0; i < Math.min(count, 8); i += 1) {
    const name = await page.evaluate(
      ({ sel, i }) => {
        const vis = (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
        const el = Array.from(document.querySelectorAll(sel)).filter(vis)[i];
        if (!el) return null;
        el.click();
        return (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      },
      { sel: toggle.trigger, i }
    );
    if (name === null) break;
    await page.waitForTimeout(320);
    const h = await page.evaluate((sel) => {
      let total = 0;
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden') total += r.height;
      }
      return Math.round(total);
    }, toggle.section);
    heights.push(h);
    labels.push(name);
  }
  // Back to the first state, so whatever runs next sees the page as it loaded.
  await page.evaluate((sel) => {
    const el = Array.from(document.querySelectorAll(sel)).find((x) => x.getBoundingClientRect().width > 0);
    if (el) el.click();
  }, toggle.trigger);
  await page.waitForTimeout(200);
  return { heights, labels };
}

const RING_STYLE = (el) => {
  const s = getComputedStyle(el);
  return {
    outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && !/rgba\(.*,\s*0\)$|transparent/.test(s.outlineColor)
      ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`
      : 'none',
    shadow: s.boxShadow,
    border: s.borderColor,
  };
};
const ringDiffers = (a, b) => a.outline !== b.outline || a.shadow !== b.shadow || a.border !== b.border;

/**
 * Ring after keyboard Tab (must be there) and after a mouse click (should not).
 * Keyboard goes first, on the page as loaded: after a click Chromium starts Tab
 * navigation from the clicked node, and the first stop would depend on the
 * mouse probe.
 */
async function measureFocus(page, content) {
  const result = { mouse: null, keyboard: null };
  const labelOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);

  // Keyboard: the first link or button that Tab reaches.
  await page.mouse.move(1, 1);
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      if (!el.matches('a[href], button, [role="button"], [role="tab"], [role="link"]')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      el.setAttribute('data-consistency-focus', 'keyboard');
      return true;
    });
    if (hit) break;
  }
  const kbd = await page.$('[data-consistency-focus="keyboard"]');
  if (kbd) {
    await page.waitForTimeout(350);
    const focused = await kbd.evaluate(RING_STYLE);
    const label = await kbd.evaluate(labelOf);
    await kbd.evaluate((el) => {
      el.blur();
      el.removeAttribute('data-consistency-focus');
    });
    await page.waitForTimeout(350);
    const blurred = await kbd.evaluate(RING_STYLE);
    result.keyboard = { label, ring: ringDiffers(blurred, focused) };
  }

  // Mouse: the first link or button in the content. The click itself is
  // swallowed before the page sees it — no navigation, no state change; focus
  // comes from mousedown, and that is what is looked at.
  const handle = await page.evaluateHandle((content) => {
    const root = document.querySelector(content) || document.body;
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(el).visibility !== 'hidden';
    };
    return Array.from(root.querySelectorAll('a[href], button:not([disabled])')).find(vis) || null;
  }, content);
  const el = handle.asElement();
  if (el) {
    const box = await el.boundingBox();
    await page.evaluate(() => {
      window.__consistencySwallow = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      window.addEventListener('click', window.__consistencySwallow, { capture: true });
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    const hovered = await el.evaluate(RING_STYLE);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(350);
    const after = await el.evaluate(RING_STYLE);
    const state = await el.evaluate((node) => ({
      focused: document.activeElement === node,
      visible: node.matches(':focus-visible'),
    }));
    result.mouse = {
      label: await el.evaluate(labelOf),
      // The browser itself decides a ring is due after a click into a text
      // field; for links and buttons it does not, and neither should the page.
      ring: state.focused && !state.visible && ringDiffers(hovered, after),
    };
    await page.evaluate(() => {
      window.removeEventListener('click', window.__consistencySwallow, { capture: true });
      document.activeElement?.blur?.();
    });
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const block = config.consistency || {};
  const cliUrls = urlsFromArgv(process.argv);
  const urls = cliUrls.length ? cliUrls : block.urls || config.urls || [];
  if (!urls.length) throw new Error('No pages: pass --url (repeatable) or fill "consistency.urls" in .uiverify.json');

  const widths = (args.widths ? String(args.widths).split(',').map(Number) : block.widths) || DEFAULT_WIDTHS;
  const options = {
    content: block.content || 'main',
    heading: block.heading || 'h1',
    groups: block.groups || [],
    buttons: block.buttons || 'button, [role="button"]',
  };
  const toggles = block.toggles || [];
  const maxWords = block.maxWords ?? null;
  const focusWidth = Math.max(...widths);
  const short = (url) => {
    try {
      const u = new URL(url);
      return u.pathname + u.search || url;
    } catch {
      return url;
    }
  };

  let blocking = 0;
  let warnings = 0;
  const say = (severity, text) => {
    if (severity === 'block') blocking += 1;
    else warnings += 1;
    console.log(`  ${severity === 'block' ? 'BLOCK' : 'FLAG '} ${text}`);
  };

  const browser = await launchBrowser();
  const measured = new Map(); // width -> [{url, m}]
  const focus = [];
  const words = [];
  try {
    console.log(`\nConsistency: ${urls.length} page${urls.length === 1 ? '' : 's'} × widths ${widths.join(', ')}`);
    for (const width of widths) {
      const rows = [];
      console.log(`\n── ${width} px ──`);
      for (const url of urls) {
        const context = await browser.newContext(contextOptions({ viewport: { width, height: HEIGHT }, touch: false }));
        const page = await context.newPage();
        announceEngine(page);
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
          await page.waitForTimeout(300);
          const m = await page.evaluate(measurePage, { ...options, tolerance: CENTRE_TOLERANCE });
          m.toggles = [];
          for (const toggle of toggles) {
            const t = await measureToggle(page, toggle);
            if (t) m.toggles.push({ name: toggle.name || toggle.trigger, ...t });
          }
          if (width === focusWidth) {
            focus.push({ url, ...(await measureFocus(page, options.content)) });
            words.push({ url, words: m.words });
          }
          rows.push({ url, m });
        } finally {
          await context.close();
        }
      }
      measured.set(width, rows);

      // The numbers, so a silent run can be told from one that measured nothing.
      for (const { url, m } of rows) {
        const h = m.head ? `${m.head.top}px / ${m.head.size}` : 'none';
        console.log(
          `  ${short(url).padEnd(28)} gutters ${m.column.left}/${m.column.right}  column ${m.column.width} (${m.column.selector})  heading ${h}`
        );
      }
      const ref = rows[0];
      for (const { url, m } of rows) {
        const name = short(url);
        if (!m.rootFound) say('flag', `${name}: no "${options.content}" — the column was measured on <body>`);
        if (Math.abs(m.column.left - m.column.right) > GUTTER_TOLERANCE) {
          say('block', `${name}: gutters ${m.column.left} px left, ${m.column.right} px right — the column is off-centre`);
        }
        if (url !== ref.url) {
          const r = ref.m;
          const refName = short(ref.url);
          if (Math.abs(m.column.left - r.column.left) > GUTTER_TOLERANCE) {
            say('block', `between pages: left gutter ${r.column.left} px (${refName}) vs ${m.column.left} px (${name})`);
          }
          if (Math.abs(m.column.width - r.column.width) > GUTTER_TOLERANCE) {
            say('block', `between pages: column width ${r.column.width} px (${refName}) vs ${m.column.width} px (${name})`);
          }
          if (r.head && m.head) {
            if (Math.abs(m.head.top - r.head.top) > GUTTER_TOLERANCE) {
              say('block', `between pages: heading top ${r.head.top} px (${refName}) vs ${m.head.top} px (${name})`);
            }
            if (m.head.size !== r.head.size) {
              say('block', `between pages: heading size ${r.head.size} (${refName}) vs ${m.head.size} (${name})`);
            }
          } else if (r.head && !m.head) {
            say('flag', `${name}: no "${options.heading}" while ${refName} has one`);
          }
        }
        for (const g of m.groupFindings) {
          say(
            'block',
            `${name} ${g.group}: «${g.role}» tops differ by ${g.spread} px across ${g.count} items in one row (first: «${g.sample}»)`
          );
        }
        for (const t of m.toggles) {
          const jump = Math.max(...t.heights) - Math.min(...t.heights);
          const numbers = t.heights.join('/');
          if (jump > 1) {
            say('block', `${name} ${t.name}: switching changes the section height — ${numbers} px (${t.labels.join(' / ')})`);
          } else {
            console.log(`  ok    ${name} ${t.name}: ${numbers} px`);
          }
        }
        for (const b of m.buttonFindings) {
          say(
            'flag',
            b.kind === 'spill'
              ? `${name} button «${b.name}» ${b.width}px: content spills ${b.px} px into the padding`
              : `${name} button «${b.name}» ${b.width}px: content off-centre by ${b.px} px`
          );
        }
      }
    }

    console.log(`\n── focus (${focusWidth} px) ──`);
    for (const f of focus) {
      const name = short(f.url);
      if (f.mouse) {
        if (f.mouse.ring) say('flag', `${name}: «${f.mouse.label}» shows a focus ring after a mouse click — draw it with :focus-visible`);
        else console.log(`  ok    ${name}: no ring after a mouse click on «${f.mouse.label}»`);
      }
      if (f.keyboard) {
        if (!f.keyboard.ring) say('block', `${name}: no visible focus ring after Tab on «${f.keyboard.label}»`);
        else console.log(`  ok    ${name}: ring after Tab on «${f.keyboard.label}»`);
      } else {
        say('flag', `${name}: Tab reached no link or button in 25 presses`);
      }
    }

    if (maxWords) {
      console.log(`\n── words (budget ${maxWords}) ──`);
      for (const w of words) {
        if (w.words > maxWords) say('flag', `${short(w.url)}: ${w.words} words in "${options.content}" (budget ${maxWords})`);
        else console.log(`  ok    ${short(w.url)}: ${w.words} words`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\nBlocking: ${blocking} | warnings: ${warnings}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
