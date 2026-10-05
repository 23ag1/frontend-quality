# The browser floor

The oldest engine the product must work on, and how to keep it working. Read it
before using a CSS feature or a web API newer than about three years, and before
choosing what to run the checks on.

## Why this is a separate file

A production app for restaurant staff was built with the bundler's defaults. The
access log over three working days: 75% of requests from a current Chrome, 24.5%
from Chrome 106 — a phone model without Google services, whose browser never
updates. The end-to-end suite ran only on a fresh Chromium, so nobody saw what
broke on 106: sheets without height, a card that never loaded, a tap that landed on
the wrong tile. In Safari below 16 not a single request left the app, because the
network layer called `AbortSignal.timeout` and nothing provided it.

The bundler's defaults are not your users. Next.js, for example, builds for
**Chrome 111 and Safari 16.4** unless told otherwise.

## 1. Take the floor from traffic

The floor comes from real request logs, not from a framework default or a guess.

```bash
# Requests by browser major version in an nginx "combined" log, newest files included.
# Count your app's API paths, not bots and static files.
zcat -f /var/log/nginx/access.log* | grep ' /api/' | awk -F'"' '{print $6}' \
  | grep -oE '(Chrome|CriOS|Firefox|Version)/[0-9]+' | sort | uniq -c | sort -rn | head -20
```

- Safari reports its version as `Version/16.4 … Safari`; an Android WebView reports
  the Chrome version of the WebView, with `wv` in the string.
- The floor is the oldest engine with a meaningful share: anything above about 1% of
  requests, and **any device the business itself owns** (a fleet of staff phones is
  100% of one shift, whatever its share of the total).
- Write it down where the tools read it — `browserslist` in `package.json`:

```json
{
  "browserslist": ["chrome >= 106", "edge >= 106", "samsung >= 20",
                   "firefox >= 102", "safari >= 15", "ios_saf >= 15"]
}
```

What the floor changes and what it does not:

- The bundler transpiles **syntax** for these targets and prefixes some CSS.
- It does **not** add missing APIs (`AbortSignal.timeout`, `structuredClone`) and
  does **not** make `dvh`, `oklch` or `subgrid` work. Frameworks polyfill a short
  list on their own (Next.js covers `.at()` and `Object.hasOwn`); read that list
  instead of assuming.
- Tailwind CSS 4 is designed for Chrome 111 and Safari 16.4 and emits `oklch`,
  `color-mix` and `@property`. 4.1 added partial fallbacks. Below that floor, look
  at the built CSS on the floor engine rather than trusting either version.

## 2. Catch APIs above the floor in the linter

`eslint-plugin-compat` reads `browserslist` and reports web APIs the floor lacks.

```js
// eslint.config.mjs
import compat from 'eslint-plugin-compat';

export default [
  compat.configs['flat/recommended'],
  {
    // What the first script provides (section 3) — not reported.
    settings: { polyfills: ['AbortSignal.timeout', 'AbortSignal.any'] },
  },
];
```

It covers JavaScript APIs only. CSS is covered by `check-browser-floor.mjs`
(section 7).

## 3. Polyfills: the first script before the bundle

What the bundler does not provide goes into a small script that runs **first in
`<head>`, before the bundle**. It is not transpiled, so it is written in ES5, and it
touches nothing where the feature exists. In the Next.js App Router that is a plain
`<script>` in the `<head>` of the root layout. A ready copy ships with the plugin as
`templates/compat-script.js`; keep its marker comment, which tells
`check-browser-floor.mjs` that these APIs are covered.

```html
<script>
/* frontend-quality:compat — check-browser-floor.mjs counts the APIs named here as polyfilled */
(function () {
  try {
    if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined') return;

    // AbortSignal.timeout — Chrome 103, Safari 16. Aborts with TimeoutError, like the native one.
    if (!AbortSignal.timeout) {
      AbortSignal.timeout = function (ms) {
        var c = new AbortController(), e;
        try { e = new DOMException('signal timed out', 'TimeoutError'); }
        catch (x) { e = new Error('signal timed out'); e.name = 'TimeoutError'; }
        setTimeout(function () { c.abort(e); }, ms);
        return c.signal;
      };
    }

    // AbortSignal.any — Chrome 116, Safari 17.4.
    if (!AbortSignal.any) {
      AbortSignal.any = function (signals) {
        var c = new AbortController(), subs = [];
        function done(reason) {
          if (c.signal.aborted) return;
          c.abort(reason);
          for (var j = 0; j < subs.length; j++) subs[j].s.removeEventListener('abort', subs[j].h);
        }
        for (var i = 0; i < signals.length; i++) {
          var s = signals[i];
          if (s.aborted) { done(s.reason); break; }
          var h = (function (sig) { return function () { done(sig.reason); }; })(s);
          s.addEventListener('abort', h);
          subs.push({ s: s, h: h });
        }
        return c.signal;
      };
    }
  } catch (e) {}
})();
</script>
```

- Below Chrome 98 and Safari 15.4, `abort()` ignores its reason: the error arrives
  as `AbortError`, not `TimeoutError`. If the network layer tells "timed out" from
  "cancelled" by the error name, it needs its own flag on those engines.
- **The guard test.** An end-to-end test deletes the native API before any page
  script runs (`page.addInitScript(() => { delete AbortSignal.timeout; })`) and
  expects the working screen to load. On the code without the polyfill it was red
  ("the floor plan is empty"); it is the cheapest proof the script runs first.

## 4. Features and their floors

Chrome and Safari versions where the feature is on by default. Numbers are from
MDN and caniuse as of 2026; check the exact row against your floor before relying on
it.

| Feature | Chrome | Safari | Below the floor | Fallback |
|---|---|---|---|---|
| `dvh` / `svh` / `lvh` | 108 | 15.4 | the whole declaration is dropped | `var(--app-h, 100dvh)`, see section 5 |
| `oklch()` | 111 | 15.4 | the declaration is dropped, colour falls to inherited or initial | sRGB value first, `oklch` inside `@supports (color: oklch(0% 0 0))` |
| `color-mix()` | 111 | 16.2 | dropped | precomputed token; `color-mix` inside `@supports` |
| `subgrid` | 117 | 16 | the card becomes its own grid, rows of neighbours misalign | card as a flex column, footer `margin-top: auto`; `subgrid` inside `@supports` |
| `:has()` | 105 | 15.4 | the whole selector list is dropped | a class or data attribute set from script |
| container queries, `cqw` | 105 | 16 | container rules ignored | viewport media queries as the base, container rules on top |
| transition of `grid-template-rows` | 107 | 16 | the block jumps open | accept the jump, or `transform` on a wrapper |
| scroll-driven animations | 115 | 26 | no animation | `IntersectionObserver` toggling a class; the start state equals the end state |
| `@starting-style` | 117 | 17.5 | no entrance animation | nothing: the element simply appears; never hide content behind it |
| view transitions (same document) | 111 | 18 | `startViewTransition` is undefined | `document.startViewTransition ? … : update()` |
| `popover` | 114 | 17 | the element is a plain node in the flow | own overlay through a portal |
| `text-wrap: balance` | 114 | 17.5 | normal wrapping | nothing; do not compensate with `<br>` |
| `content-visibility: auto` | 85 | 18 | everything renders | nothing; measure the long list on Safari separately |
| `AbortSignal.timeout` | 103 | 16 | `TypeError`, no request leaves | polyfill, section 3 |
| `AbortSignal.any` | 116 | 17.4 | `TypeError` | polyfill, section 3 |
| `structuredClone` | 98 | 15.4 | `ReferenceError` | JSON round trip for plain data, or a polyfill |

One trap applies to every CSS row: **two declarations in a row (`old; new`) are not
a fallback you can rely on.** A minifier may merge duplicate properties into one.
Put the new value under `@supports` and check the built CSS, not the source.

## 5. Viewport height

Three traps, each seen in production:

- `height: 100vh; height: 100dvh;` in one rule — the minifier collapsed the pair into
  a single declaration.
- `calc(100dvh - var(--gap))` — Chrome 106 accepts it at parse time (a `var()`
  postpones validation), finds it invalid at computed-value time and resets the
  property: `height` becomes `auto`. Sheets lost their height.
- A bare `100vh` as the fallback — on Android it is taller than the visible area,
  and the bottom of the sheet goes under the address bar.

What works: a variable set from the first script, only where `dvh` is missing.

```js
// In the same first script as the polyfills.
if (window.CSS && !CSS.supports('height', '100dvh')) {
  var setAppHeight = function () {
    document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
  };
  setAppHeight();
  window.addEventListener('resize', setAppHeight);
}
```

```css
.sheet     { height: var(--app-h, 100dvh); }
.sheet-max { max-height: calc(var(--app-h, 100dvh) - var(--sheet-gap)); }
```

Where `dvh` exists the variable is never set and the value is plain `100dvh`. Hold
it with a machine, not memory: a lint rule that bans bare `dvh`/`svh`/`lvh` outside
the one file that defines these classes.

```js
// eslint.config.mjs — part of no-restricted-syntax
const VIEW_UNIT = '/\\d(dvh|svh|lvh)\\b/';
const VIEW_MSG = 'Viewport units only through var(--app-h, 100dvh) or the view classes.';
const NO_RAW_VIEW = [
  { selector: `Literal[value=${VIEW_UNIT}]`, message: VIEW_MSG },
  { selector: `TemplateElement[value.raw=${VIEW_UNIT}]`, message: VIEW_MSG },
];
```

How the keyboard changes the visible height is in [forms-mobile.md](forms-mobile.md).

## 6. Engine quirks that only the floor shows

**Chrome 106 sends a finger tap's `click` with `detail` 0.** Code that read
`detail === 0` as "keyboard or `el.click()`" skipped its check that the finger was
released on the same tile it pressed, and an item nobody touched went into the
order. Decide by the pointer type of the press instead:

```js
let lastPointer = '';
document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
document.addEventListener('keydown', () => { lastPointer = ''; }, true);

const fromPointer = (e) => e.detail > 0 || lastPointer === 'touch' || lastPointer === 'pen';
```

**Chrome 106 drops the fraction of `scrollTop`** (10.6 becomes 10). An easing loop
that scrolled by 0.9 px per frame moved nothing and stopped 4 px short of its
target. Round the target to a whole pixel and make every programmatic step at least
1 px:

```js
const target = Math.round(rawTarget);   // the engine keeps no fraction anyway
const step = (left) => Math.sign(left) * Math.max(1, Math.round(Math.abs(left) * 0.2));
```

**WebKit: `preventDefault()` on `pointerdown` cancels the `click` too.** The usual
trick for keeping focus (and the keyboard) in a field while tapping a button beside
it killed the button. Call `preventDefault()` on `mousedown` instead: it stops the
focus change and leaves `click` alone.

## 7. Running the checks on the floor engine

Every browser check in this skill runs on a fresh Chromium by default. Point it at
the floor:

```bash
SK=~/.claude/skills/frontend-quality/scripts

# WebKit — Playwright's build, the closest you get to Safari on Linux
FQ_BROWSER=webkit node $SK/verify-ui.mjs --scenario ./e2e/scenarios/cart.mjs

# An old Chromium: download a snapshot of the given major (from the plugin
# checkout), then point the check at the path it prints
bash /path/to/frontend-quality/scripts/fetch-chromium.sh 106
FQ_BROWSER=chromium FQ_CHROME_PATH=/path/printed/by/the/script \
  node $SK/verify-tap.mjs --scenario ./e2e/scenarios/cart.mjs

# Static scan: CSS and APIs above the declared floor
node $SK/check-browser-floor.mjs src
node $SK/check-browser-floor.mjs src --floor chrome=106,safari=15   # without a config
```

`check-browser-floor.mjs` takes the floor from `--floor`, then from `browserFloor`
in `.uiverify.json`, then from `browserslist`; with none of them it has nothing to
compare against, exits with 2, and the Stop gate skips it.

```json
{ "browserFloor": { "chrome": 106, "safari": 15 } }
```

Its verdicts: **BLOCK** — a feature above the floor with no visible fallback;
**FLAG** — a fallback that text cannot prove (two declarations in a row, a
`typeof` check nearby) or a feature that only degrades; **silent** — the use sits
under `@supports` for the same feature, inside `var(--app-h, 100dvh)` with the
variable set by the code, or is polyfilled by the marked first script. It reads text,
not an AST: a string that looks like code can fool it.

Rules for the engine matrix:

- Keep an old Chromium outside Playwright's browser cache: `playwright install`
  deletes directories it does not recognise.
- A test the engine cannot run is reported as a separate "–" line, not as a
  failure and not silently skipped. Touch through CDP exists only in Chromium;
  Firefox with touch emulation turned on sent `click` without `pointerdown`, and a
  correct tap guard rejected it — 56 false failures in one run.
- Playwright's WebKit is the engine, not iOS Safari: the keyboard, the address bar,
  rubber-band scrolling and the focus rules of a real iPhone are not there.

## 8. The screen matrix

The default widths of `verify-ui.mjs` start at 390. Phones in the field are
narrower, turned sideways, and have a larger system font. Add to `breakpoints` in
`.uiverify.json`:

```json
{ "name": "narrow",    "width": 320, "height": 568 },
{ "name": "small",     "width": 360, "height": 640 },
{ "name": "landscape", "width": 844, "height": 390 }
```

and run the working screens once with the root font at 125% (the scenario's
`ready()` can do it with `page.addStyleTag({ content: 'html { font-size: 125% }' })`).
What to look at: no horizontal scroll, no button past the edge, no text out of its
button. The combination of 320 px and 125% pushed one header 15 px off screen: a
segmented control without `min-width: 0`.
