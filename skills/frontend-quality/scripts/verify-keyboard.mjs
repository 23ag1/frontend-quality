#!/usr/bin/env node
/**
 * Text fields and the on-screen keyboard: the field stays visible, the sheet
 * holds still, a button inside the sheet does not close the keyboard.
 *
 * A headless browser has no on-screen keyboard, so these defects never show up
 * in ordinary checks, and on a phone they are the most visible ones: the person
 * types blind, the sheet jumps under the finger, every "+" tap closes the keyboard.
 * The keyboard (~45% of the screen) is emulated in both models phones use — see
 * lib/keyboard.mjs:
 *   resize   the window shrinks (Android Chrome with resizes-content)
 *   overlay  only the visual viewport shrinks (iOS Safari, Android resizes-visual)
 *
 * For every field and model:
 *   BLOCK the focused field is not fully inside the area visible above the keyboard
 *         (after scrolling its containers the way the browser itself would);
 *   BLOCK a tap on a button inside the same sheet takes focus off the field — on a
 *         phone the keyboard closes and the sheet jumps (a real CDP touch tap);
 *   BLOCK the sheet height changes by more than 2 px across that tap;
 * once per field:
 *   FLAG  scrolling inside a full-screen overlay (or one shown over a full-screen
 *         backdrop) scrolls the page under it (scroll chaining);
 *   FLAG  history back (Android back button or gesture) does not close the overlay
 *         the person opened, or takes them off the screen instead.
 *
 * What emulation CANNOT show — needs a real device: the keyboard animation (the
 * viewport changes over ~250 ms, not in one step), iOS scrolling the page to the
 * focused field on its own terms, an installed PWA (standalone mode resizes
 * differently), the height of the suggestion / autocorrect bar, third-party
 * keyboards, and `env(keyboard-inset-*)` / VirtualKeyboard API behaviour.
 *
 * Fields come from the scenario's `keyboardTargets`:
 *   export const keyboardTargets = [
 *     { name: 'quantity sheet',
 *       open: async (page) => { await page.click('[data-row] .qty'); },  // open the sheet
 *       field: 'input[name=qty]',          // the field that gets focus
 *       inside: '[role=dialog]' },          // the sheet; optional — found from the field
 *   ];
 * Without them every visible text field on the page is checked as it is.
 *
 * Usage:
 *   node verify-keyboard.mjs --url http://localhost:3000/checkout
 *   node verify-keyboard.mjs --scenario ./e2e/scenarios/order.mjs
 *   options: --models resize,overlay  --width 390 --height 844  --keyboard 0.45 (share of the height)
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  parseArgs,
  loadConfig,
  resolveTargets,
  closeQuietly,
  openCDP,
  engineOf,
  reportSkipped,
  writeScreenshot,
} from './lib/session.mjs';
import {
  MODELS,
  KEYBOARD_SHARE,
  installKeyboardShim,
  keyboardHeight,
  openKeyboard,
  visibleArea,
  revealLikeBrowser,
  touchTap,
} from './lib/keyboard.mjs';

const HEIGHT_TOLERANCE_PX = 2;
const MAX_TAPS = 3;
const TEXT_FIELDS =
  'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number], input[type=password], textarea, [contenteditable=""], [contenteditable="true"]';

const NEEDS_DEVICE = [
  'the keyboard animation — the viewport changes over ~250 ms, not in one step',
  'iOS scrolling the page to the focused field by its own rules (approximated here)',
  'an installed PWA — standalone mode resizes differently',
  'the suggestion / autocorrect bar height and third-party keyboards',
  'env(keyboard-inset-*) and the VirtualKeyboard API',
];

// ─── In-page helpers ─────────────────────────────────────────────────────────

/** Is focus on the field, or at least on something that keeps a keyboard open? */
const focusState = (fieldSelector) => {
  const active = document.activeElement;
  const editable =
    !!active &&
    (active.isContentEditable ||
      active.tagName === 'TEXTAREA' ||
      (active.tagName === 'INPUT' &&
        !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i.test(active.type)));
  const field = document.querySelector(fieldSelector);
  const label = (el) =>
    !el || el === document.body
      ? 'the page body'
      : `${el.tagName.toLowerCase()} “${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 30)}”`;
  return {
    onField: !!field && (active === field || field.contains(active)),
    editable,
    connected: !!field && field.isConnected,
    active: label(active),
  };
};

/** Mark the sheet the field lives in; returns a selector for it or null. */
const markOverlay = ({ field: fieldSelector, inside }) => {
  for (const old of document.querySelectorAll('[data-fq-overlay]')) old.removeAttribute('data-fq-overlay');
  const field = document.querySelector(fieldSelector);
  let overlay = null;
  if (inside) overlay = (field && field.closest(inside)) || document.querySelector(inside);
  if (!overlay && field) overlay = field.closest('[role="dialog"], dialog, [aria-modal="true"]');
  if (!overlay && field) {
    for (let node = field.parentElement; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') {
        overlay = node;
        break;
      }
    }
  }
  if (!overlay) return null;
  overlay.setAttribute('data-fq-overlay', '');
  return inside && overlay.matches(inside) ? inside : '[data-fq-overlay]';
};

const rectOf = (selector) => {
  const el = document.querySelector(selector);
  if (!el || !el.isConnected) return null;
  const style = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) return null;
  return { top: r.top, bottom: r.bottom, height: r.height };
};

/** Buttons inside the sheet that a finger can reach above the keyboard. */
const tapCandidates = ({ overlay, field: fieldSelector }) => {
  const root = document.querySelector(overlay);
  if (!root) return [];
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bottom = vv ? top + vv.height : window.innerHeight;
  const field = document.querySelector(fieldSelector);
  const out = [];
  for (const el of root.querySelectorAll('button, [role="button"]')) {
    if (field && (el === field || el.contains(field) || field.contains(el))) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.pointerEvents === 'none' || parseFloat(s.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (r.width < 4 || r.height < 4 || y < top + 2 || y > bottom - 2 || x < 2 || x > window.innerWidth - 2) continue;
    // Something else on top would take the finger: not this button's tap.
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    out.push({
      x,
      y,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) || '(unnamed)',
    });
  }
  return out;
};

// ─── Steps ───────────────────────────────────────────────────────────────────

/** Fresh state: the screen, the sheet opened by the person, focus in the field. */
async function prepare(page, cdp, target, kt, base) {
  await page.setViewportSize(base);
  await target.ready(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const urlBeforeOpen = page.url();
  await kt.open(page);
  await page.waitForTimeout(300);
  const field = page.locator(kt.field).first();
  if (!(await field.count())) return { error: `the field ${kt.field} is not on the page after open()` };

  // Focus the way a person does: a tap. Not every field is tappable from where it
  // is (scrolled away, covered) — then focus() so the remaining checks still run.
  const box = await field.boundingBox();
  if (cdp && box && box.y >= 0 && box.y + box.height <= base.height) {
    await touchTap(cdp, { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 });
    await page.waitForTimeout(150);
  }
  if (!(await page.evaluate(focusState, kt.field)).onField) await field.focus().catch(() => {});
  if (!(await page.evaluate(focusState, kt.field)).onField) return { error: 'the field does not take focus' };

  const overlay = await page.evaluate(markOverlay, { field: kt.field, inside: kt.inside || null });
  return { overlay, urlBeforeOpen };
}

async function checkModel(page, cdp, target, kt, model, base, kbHeight, outDir, slug) {
  const findings = [];
  const notes = [];
  const state = await prepare(page, cdp, target, kt, base);
  if (state.error) return { findings: [{ severity: 'block', kind: 'setup', text: state.error }], notes };

  let close = await openKeyboard(page, model, kbHeight);
  await revealLikeBrowser(page, kt.field);
  await page.waitForTimeout(100);

  // 1. The field is visible above the keyboard.
  const focus = await page.evaluate(focusState, kt.field);
  const field = await page.evaluate(rectOf, kt.field);
  const view = await visibleArea(page);
  if (!focus.onField) {
    findings.push({ severity: 'block', kind: 'focus-lost', text: `the field lost focus when the keyboard opened (focus is on ${focus.active})` });
  } else if (!field) {
    findings.push({ severity: 'block', kind: 'field-hidden', text: 'the field disappeared when the keyboard opened' });
  } else if (field.bottom > view.bottom + 1 || field.top < view.top - 1) {
    findings.push({
      severity: 'block',
      kind: 'under-keyboard',
      text: `the field is not fully visible: it spans ${Math.round(field.top)}–${Math.round(field.bottom)} px, the person sees ${Math.round(view.top)}–${Math.round(view.bottom)} px above the keyboard`,
    });
  }

  // 2–3. A tap on a button inside the sheet keeps focus, and the sheet holds still.
  if (!state.overlay) {
    notes.push('no sheet around the field — the tap checks do not apply');
  } else if (!cdp) {
    notes.push('tap checks not run on this engine');
  } else {
    let tested = 0;
    let index = 0;
    let fresh = true;
    while (tested < MAX_TAPS) {
      if (!fresh) {
        await close();
        const again = await prepare(page, cdp, target, kt, base);
        if (again.error) break;
        state.overlay = again.overlay || state.overlay;
        close = await openKeyboard(page, model, kbHeight);
        await revealLikeBrowser(page, kt.field);
      }
      const candidates = await page.evaluate(tapCandidates, { overlay: state.overlay, field: kt.field });
      const button = candidates[index];
      if (!button) {
        if (index === 0) notes.push('no button of the sheet is reachable above the keyboard');
        break;
      }
      index += 1;
      const before = await page.evaluate(rectOf, state.overlay);
      const urlBefore = page.url();
      await touchTap(cdp, button);
      await page.waitForTimeout(350);
      const after = await page.evaluate(focusState, kt.field);
      const sheetAfterTap = await page.evaluate(rectOf, state.overlay);
      if (!sheetAfterTap || !after.connected || page.url() !== urlBefore) {
        // The button closes the sheet or leaves the screen: focus leaving is its job.
        fresh = false;
        continue;
      }
      tested += 1;
      fresh = true;
      let sheetNow = sheetAfterTap;
      if (!after.editable) {
        findings.push({
          severity: 'block',
          kind: 'focus-steal',
          text: `tapping “${button.label}” inside the sheet takes focus off the field (to ${after.active}) — on a phone the keyboard closes and the sheet jumps`,
        });
        // A real phone closes the keyboard here; the sheet height below is what
        // the person then sees.
        await close();
        sheetNow = await page.evaluate(rectOf, state.overlay);
        fresh = false;
      }
      if (before && sheetNow && Math.abs(sheetNow.height - before.height) > HEIGHT_TOLERANCE_PX) {
        findings.push({
          severity: 'block',
          kind: 'sheet-jump',
          text: `the sheet height changed ${Math.round(before.height)} → ${Math.round(sheetNow.height)} px across a tap on “${button.label}”`,
        });
      }
      if (!fresh) break;
    }
    if (tested === 0 && index > 0 && !notes.length) notes.push('every reachable button closes the sheet — nothing to tap inside it');
  }

  if (findings.length) {
    findings.screenshot = await shotWithKeyboard(page, model, kbHeight, join(outDir, `${slug}-${model}.png`));
  }
  await close();
  return { findings, notes };
}

/** A viewport shot with the keyboard area painted, so the reader sees what is covered. */
async function shotWithKeyboard(page, model, kbHeight, path) {
  const view = await visibleArea(page);
  await page.evaluate(
    ({ top, height }) => {
      const k = document.createElement('div');
      k.id = '__fq-keyboard';
      k.style.cssText = `position:fixed;left:0;right:0;top:${top}px;height:${height}px;background:rgba(40,40,40,.55);z-index:2147483647;pointer-events:none`;
      document.documentElement.appendChild(k);
    },
    { top: view.bottom, height: model === 'overlay' ? kbHeight : 0 }
  );
  const { preview } = await writeScreenshot(page, path).catch(() => ({ preview: null }));
  await page.evaluate(() => document.getElementById('__fq-keyboard')?.remove()).catch(() => {});
  return preview || path;
}

/** Once per field: scroll chaining and the back button. */
async function checkOverlayBehaviour(page, cdp, target, kt, base, openedByPerson) {
  const findings = [];
  const notes = [];
  // A field found on the page as it is (no keyboardTargets) sits in nothing the
  // person opened: a fixed search bar is not a sheet, and back is not its business.
  if (!openedByPerson) {
    notes.push('nothing was opened by the person — declare keyboardTargets to check sheets');
    return { findings, notes };
  }

  // Scroll chaining.
  let state = await prepare(page, cdp, target, kt, base);
  if (state.error) return { findings, notes };
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const probe = state.overlay
    ? await page.evaluate((sel) => {
        const overlay = document.querySelector(sel);
        let fixed = false;
        for (let n = overlay; n && n !== document.body; n = n.parentElement) {
          if (getComputedStyle(n).position === 'fixed') fixed = true;
        }
        const root = document.scrollingElement || document.documentElement;
        const pageScrolls = root.scrollHeight > root.clientHeight + 1;
        // Full-screen: the overlay, or a backdrop shown with it, covers the whole
        // window. A bar or a corner popover is part of the page, and the wheel
        // over it is expected to scroll the page.
        const covers = (el) => {
          if (getComputedStyle(el).position !== 'fixed') return false;
          const b = el.getBoundingClientRect();
          return b.width >= window.innerWidth * 0.9 && b.height >= window.innerHeight * 0.9;
        };
        let fullScreen = false;
        for (let n = overlay; n && n !== document.body && !fullScreen; n = n.parentElement) fullScreen = covers(n);
        if (!fullScreen) {
          const top = document.elementsFromPoint(window.innerWidth / 2, 4);
          fullScreen = top.some((el) => el !== document.documentElement && el !== document.body && covers(el));
        }
        // The biggest scroller inside the overlay is where a person scrolls.
        let area = overlay;
        let best = 0;
        for (const el of [overlay, ...overlay.querySelectorAll('*')]) {
          const s = getComputedStyle(el);
          if (!/(auto|scroll)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
          const size = el.clientWidth * el.clientHeight;
          if (size > best) {
            best = size;
            area = el;
          }
        }
        const r = area.getBoundingClientRect();
        const y = Math.min(Math.max(r.top + r.height / 2, 5), window.innerHeight - 5);
        return { fixed, fullScreen, pageScrolls, x: r.left + r.width / 2, y, scrollY: window.scrollY };
      }, state.overlay)
    : null;
  if (probe && probe.fixed && probe.fullScreen && probe.pageScrolls) {
    // Wheel steps, not a touch drag: chaining follows the same CSS rule
    // (overscroll-behavior) for both, the wheel behaves the same in every engine,
    // and a synthetic CDP touch drag did not scroll at all in headless Chromium.
    // Several separate steps: the first reaches the end of the inner list, the
    // next ones show whether the scroll passes on to the page.
    let scrolled = true;
    try {
      await page.mouse.move(probe.x, probe.y);
      for (let i = 0; i < 3; i += 1) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(250);
      }
    } catch (error) {
      // Mobile WebKit in Playwright has no wheel and no touch drag: nothing can
      // scroll the overlay the way a person does, so the check is not run.
      scrolled = false;
      notes.push('scroll chaining not checked on this engine');
      reportSkipped(engineOf(page).name, `scroll chaining — ${error.message.split('\n')[0]}`);
    }
    const scrollY = await page.evaluate(() => window.scrollY);
    if (scrolled && Math.abs(scrollY - probe.scrollY) > 1) {
      findings.push({
        severity: 'flag',
        kind: 'scroll-chaining',
        text: `scrolling inside the overlay scrolled the page under it by ${Math.round(scrollY - probe.scrollY)} px — add overscroll-behavior: contain or lock the page`,
      });
    }
  }

  // History back.
  state = await prepare(page, cdp, target, kt, base);
  if (state.error || !state.overlay) return { findings, notes };
  // A token unique to this attempt: a document restored from the back/forward
  // cache keeps its old globals and must not pass for "the same document".
  const token = `${Date.now()}-${Math.random()}`;
  await page.evaluate((t) => {
    window.__fqDocument = t;
  }, token);
  await page.goBack({ waitUntil: 'commit', timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(500);
  const sameDocument = await page.evaluate((t) => window.__fqDocument === t, token).catch(() => false);
  if (!sameDocument) {
    findings.push({
      severity: 'flag',
      kind: 'back-leaves',
      text: 'history back leaves the screen instead of closing the overlay — the Android back button or gesture throws the person out',
    });
  } else {
    const stillOpen = await page.evaluate(rectOf, state.overlay);
    if (stillOpen) {
      findings.push({ severity: 'flag', kind: 'back-ignored', text: 'history back does not close the overlay' });
    } else if (page.url() !== state.urlBeforeOpen) {
      findings.push({
        severity: 'flag',
        kind: 'back-leaves',
        text: `history back closed the overlay but also moved to ${page.url()} — the person lands on another screen`,
      });
    }
  }
  return { findings, notes };
}

/** No keyboardTargets: every visible text field on the page, as it is. */
async function discoverFields(page, target) {
  await target.ready(page);
  const count = await page.evaluate((sel) => {
    let i = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width < 4 || r.height < 4 || s.visibility === 'hidden' || el.disabled || el.readOnly) continue;
      i += 1;
      if (i >= 6) break;
    }
    return i;
  }, TEXT_FIELDS);
  return Array.from({ length: count }, (_, n) => ({
    name: `text field ${n + 1}`,
    field: `[data-fq-field="${n}"]`,
    async open(p) {
      await p.evaluate(
        ({ sel, n: wanted }) => {
          let i = 0;
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            if (r.width < 4 || r.height < 4 || s.visibility === 'hidden' || el.disabled || el.readOnly) continue;
            if (i === wanted) {
              el.setAttribute('data-fq-field', String(wanted));
              el.scrollIntoView({ block: 'center' });
              return;
            }
            i += 1;
          }
        },
        { sel: TEXT_FIELDS, n }
      );
    },
  }));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const base = { width: Number(args.width || 390), height: Number(args.height || 844) };
  const share = Number(args.keyboard || KEYBOARD_SHARE);
  const kbHeight = keyboardHeight(base, share);
  const models = String(args.models || 'resize,overlay')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  for (const m of models) if (!MODELS[m]) throw new Error(`Unknown model "${m}": use resize and/or overlay`);
  const outDir = resolve(args.out || '.uiverify-out/keyboard');
  mkdirSync(outDir, { recursive: true });

  // On-screen keyboards exist on touch phones: mobile viewport with touch.
  const targets = await resolveTargets({ ...args, touch: true, ...base }, config);

  let blocking = 0;
  let flagged = 0;
  const shots = [];

  for (const target of targets) {
    const opened = await target.open({ throttle: 1, viewport: base, touch: true });
    const { page, context } = opened;
    try {
      await installKeyboardShim(page);
      const engine = engineOf(page);
      const cdp = await openCDP(
        context,
        page,
        'real touch tap (CDP) — the focus-steal and sheet-height-on-tap checks are not run'
      );
      if (models.includes('overlay') && !(await page.evaluate(() => !!window.visualViewport))) {
        reportSkipped(engine.name, 'overlay model — no window.visualViewport');
      }

      const kts = target.keyboardTargets.length ? target.keyboardTargets : await discoverFields(page, target);
      console.log(`\n═══ ${target.name} ═══`);
      console.log(
        `Keyboard: ${kbHeight}px (${Math.round(share * 100)}% of ${base.width}×${base.height}), models: ${models.join(', ')}`
      );
      if (!kts.length) console.log('No text fields found — nothing to check.');

      for (const kt of kts) {
        const slug = `${String(target.name)}-${kt.name}`.replace(/[^\w-]+/g, '_').slice(-60);
        for (const model of models) {
          const { findings, notes } = await checkModel(page, cdp, target, kt, model, base, kbHeight, outDir, slug);
          console.log(`\n  «${kt.name}» — ${model}: ${MODELS[model]}`);
          // "ok" only when everything ran; otherwise say what did not.
          if (!findings.length) console.log(notes.length ? `      no findings (${notes.join('; ')})` : '      ok');
          for (const f of findings) {
            console.log(`      ${f.severity === 'block' ? 'BLOCK' : 'FLAG '} [${f.kind}] ${f.text}`);
          }
          if (findings.length && notes.length) console.log(`      note: ${notes.join('; ')}`);
          if (findings.screenshot) shots.push(findings.screenshot);
          blocking += findings.filter((f) => f.severity === 'block').length;
          flagged += findings.filter((f) => f.severity !== 'block').length;
        }
        const behaviour = await checkOverlayBehaviour(page, cdp, target, kt, base, target.keyboardTargets.length > 0);
        console.log(`\n  «${kt.name}» — scrolling and history back`);
        if (!behaviour.findings.length) {
          console.log(behaviour.notes.length ? `      no findings (${behaviour.notes.join('; ')})` : '      ok');
        }
        for (const f of behaviour.findings) {
          console.log(`      ${f.severity === 'block' ? 'BLOCK' : 'FLAG '} [${f.kind}] ${f.text}`);
        }
        blocking += behaviour.findings.filter((f) => f.severity === 'block').length;
        flagged += behaviour.findings.filter((f) => f.severity !== 'block').length;
      }
    } finally {
      await closeQuietly(opened);
    }
  }

  if (shots.length) {
    console.log('\nScreenshots with the keyboard area shaded:');
    for (const s of shots) console.log(`  ${s}`);
  }
  console.log(`\nBlocking: ${blocking} | warnings: ${flagged}`);
  console.log('\nWhat emulation cannot show — needs a real device:');
  for (const line of NEEDS_DEVICE) console.log(`  - ${line}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
