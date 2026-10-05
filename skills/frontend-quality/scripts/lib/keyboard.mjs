/**
 * An on-screen keyboard for a headless browser, in the two models real phones use.
 *
 * A headless browser has no on-screen keyboard, yet almost every defect of a
 * sheet with a text field is about it: the field ends up under the keyboard, the
 * sheet jumps when the keyboard closes, a "+" button closes the keyboard because
 * it takes focus. Phones open the keyboard in one of two ways, and an interface
 * can be right in one and broken in the other:
 *
 *   resize   the layout viewport shrinks: window.innerHeight drops and the window
 *            gets a resize event. Android Chrome with
 *            `interactive-widget=resizes-content`, older Android Chrome, most
 *            Android web views.
 *   overlay  the layout viewport stays; only window.visualViewport shrinks (its
 *            height drops, its resize event fires). iOS Safari, and Android Chrome
 *            by default since version 108 (`resizes-visual`). Anything laid out
 *            against innerHeight or `bottom: 0` of a fixed box stays under the
 *            keyboard.
 *
 * The overlay model is emulated by overriding visualViewport.height and
 * visualViewport.offsetTop in the page and firing the visualViewport resize and
 * scroll events — exactly what an app that follows the keyboard reads.
 */

/** Share of the screen height an on-screen keyboard takes on a typical phone. */
export const KEYBOARD_SHARE = 0.45;

export const MODELS = {
  resize: 'the window shrinks — Android Chrome with resizes-content, Android web views',
  overlay: 'only the visual viewport shrinks — iOS Safari, Android Chrome with resizes-visual',
};

/**
 * Runs in the page. Idempotent: install it as an init script AND evaluate it on
 * the current document (a scenario has often navigated before the check starts).
 */
export const KEYBOARD_SHIM = () => {
  if ('__fqKeyboard' in window) return;
  const vv = window.visualViewport;
  if (!vv) {
    window.__fqKeyboard = null;
    return;
  }
  const proto = Object.getPrototypeOf(vv);
  const realHeight = Object.getOwnPropertyDescriptor(proto, 'height').get;
  const realTop = Object.getOwnPropertyDescriptor(proto, 'offsetTop').get;
  let covered = 0;
  let shift = 0;
  Object.defineProperty(vv, 'height', {
    configurable: true,
    get: () => Math.max(0, realHeight.call(vv) - covered),
  });
  Object.defineProperty(vv, 'offsetTop', {
    configurable: true,
    get: () => realTop.call(vv) + shift,
  });
  window.__fqKeyboard = (px, offsetTop = 0) => {
    covered = px;
    shift = offsetTop;
    vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
  };
};

/** Install the shim for every future document and for the current one. */
export async function installKeyboardShim(page) {
  await page.addInitScript(KEYBOARD_SHIM);
  await page.evaluate(KEYBOARD_SHIM).catch(() => {});
}

/** Keyboard height in px for a viewport: ~45% of its height. */
export function keyboardHeight(viewport, share = KEYBOARD_SHARE) {
  return Math.round(viewport.height * share);
}

/**
 * Open the keyboard in `model` with `height` px. Returns `close()`, which puts the
 * page back the way a closing keyboard does.
 */
export async function openKeyboard(page, model, height, settleMs = 400) {
  const viewport = page.viewportSize();
  if (model === 'resize') {
    await page.setViewportSize({ width: viewport.width, height: viewport.height - height });
  } else if (model === 'overlay') {
    await page.evaluate(KEYBOARD_SHIM);
    const ok = await page.evaluate((px) => {
      if (!window.__fqKeyboard) return false;
      window.__fqKeyboard(px);
      return true;
    }, height);
    if (!ok) throw new Error('overlay model: this engine has no window.visualViewport');
  } else {
    throw new Error(`Unknown keyboard model "${model}": use resize or overlay`);
  }
  await page.waitForTimeout(settleMs);
  let closed = false;
  return async function close() {
    if (closed) return;
    closed = true;
    if (model === 'resize') await page.setViewportSize(viewport);
    else await page.evaluate(() => window.__fqKeyboard && window.__fqKeyboard(0)).catch(() => {});
    await page.waitForTimeout(settleMs);
  };
}

/** What the person sees above the keyboard, in layout-viewport coordinates. */
export function visibleArea(page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    return { top, bottom: vv ? top + vv.height : window.innerHeight };
  });
}

/**
 * What the browser itself does after the keyboard opens: it scrolls the focused
 * field into view through every scrollable ancestor, the document included. It
 * cannot move a box with `position: fixed` that way — on iOS the whole visual
 * viewport pans instead and the screen "jumps", which is precisely the defect.
 * An approximation: real browsers differ in margins and in timing.
 */
export function revealLikeBrowser(page, fieldSelector) {
  return page.evaluate((sel) => {
    const el = document.activeElement && document.activeElement.matches(sel) ? document.activeElement : document.querySelector(sel);
    if (!el) return;
    const vv = window.visualViewport;
    const visTop = () => (vv ? vv.offsetTop : 0);
    const visBottom = () => (vv ? vv.offsetTop + vv.height : window.innerHeight);
    const margin = 8;
    let insideFixed = false;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const r = el.getBoundingClientRect();
      const down = r.bottom + margin - visBottom();
      const up = visTop() - (r.top - margin);
      if (down <= 0 && up <= 0) return;
      const isRoot = node === document.documentElement || node === document.body;
      if (isRoot) {
        if (!insideFixed) window.scrollBy(0, down > 0 ? down : -up);
        return;
      }
      const style = getComputedStyle(node);
      if (style.position === 'fixed') insideFixed = true;
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
        node.scrollTop += down > 0 ? down : -up;
      }
    }
  }, fieldSelector);
}

/** A tap from a finger. Chromium: CDP touch with real hit testing. */
export async function touchTap(cdp, point) {
  const touchPoint = { x: Math.round(point.x), y: Math.round(point.y) };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
