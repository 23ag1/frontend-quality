# Technique catalogue: where the frame actually goes

A companion to [the skill body](../SKILL.md). Organised by phase of the pipeline:
what is expensive, how it shows up in a report, and what fixes it.

## The frame pipeline

Every frame the browser walks the same phases. The further right you can stop, the
cheaper the frame.

| Phase | What it does | Where it runs | What triggers it |
|---|---|---|---|
| Script | changes state and the DOM | main thread | handlers, timers, promises |
| Style recalculation | matches CSS rules to nodes | main thread | class changes, node insertion |
| Layout | computes geometry for every affected node | main thread | `width`, `height`, `top`, `margin`, `flex`, insertion |
| Paint | turns geometry into draw commands | main thread | `background`, `box-shadow`, `color`, `border-radius`, `filter` |
| Composite | moves and blends ready layers on the GPU | compositor thread | `transform`, `opacity` |

**The rule.** An animation that gets by on composition alone costs almost no main
thread. An animation that reaches layout costs the whole frame.

```css
/* Expensive: layout, paint and composite on every frame. */
.panel { transition: height .3s, top .3s; }

/* Cheap: composite only, the main thread stays free. */
.panel { transition: transform .3s, opacity .3s; will-change: transform; }
```

`will-change` is set **for the duration of the animation**, not forever: every such
layer occupies a buffer in video memory (see "Layer explosion").

## Forced synchronous layout (layout thrashing)

The most expensive mistake on weak hardware, and the least visible in the code.

The browser batches DOM changes and computes layout once at the end of a task. But
if a script **writes** a style and then immediately **reads** geometry, the engine
must compute layout right there, synchronously. In a loop that means dozens of
layouts per frame.

Reads that force a recalculation: `offsetWidth/Height`, `clientWidth/Height`,
`getBoundingClientRect()`, `getClientRects()`, `scrollTop/Left/Width/Height`,
`getComputedStyle()`.

```js
// Bad: write → read → write → read…
for (const card of cards) {
  card.style.width = '100px';
  card.dataset.h = card.offsetHeight;   // synchronous layout on every iteration
}

// Good: all reads first, then all writes.
const heights = cards.map((card) => card.offsetHeight);
requestAnimationFrame(() => {
  cards.forEach((card, i) => {
    card.style.width = '100px';
    card.dataset.h = heights[i];
  });
});
```

**How it shows in a report:** `forcedStyleAndLayoutDuration > 0` for a script in
the long-frame breakdown — `verify-perf.mjs` prints it as "of which forced layout
N ms". A zero means this class of defect is absent and need not be hunted.

## Long tasks and yielding

A task longer than 50 ms blocks input: the tap has already happened and the
handler has not started. At ×20 that is 2.5 ms of real work — which makes almost
any noticeable function "long".

Ways to yield the thread, in ascending order of suitability:

| Technique | Where the continuation lands | Delay | Does it let the browser render |
|---|---|---|---|
| `Promise.resolve().then()` | microtask | 0 | **no** — the frame will not paint |
| `setTimeout(fn, 0)` | end of the task queue | ~4 ms (clamped) | yes |
| `MessageChannel` | end of the task queue | <1 ms | yes |
| `scheduler.yield()` | **front of its priority queue** | <1 ms | yes |

`scheduler.yield()` is the right answer today: the continuation takes priority over
other tasks, so your work does not get spread out.

```js
async function processAll(items) {
  for (const item of items) {          // a for…of loop, deliberately
    handle(item);
    if (globalThis.scheduler?.yield) await scheduler.yield();
    else await new Promise((r) => setTimeout(r, 0));
  }
}
```

**The trap.** `items.forEach(async (item) => { …; await scheduler.yield(); })` does
nothing: `forEach` does not await promises, every callback runs in one task, and no
yielding happens at all. Only `for…of` or an index loop.

Fine tuning: `navigator.scheduling.isInputPending()` lets computation keep running
while the user has pressed nothing, and yield the moment something appears in the
input queue.

## Fewer nodes and less work per node

The cost of style recalculation and layout grows with the number of nodes. A
landmark: past ~1500 nodes it is noticeable on its own, independent of the code.

**List virtualisation.** Only what is visible plus a buffer above and below lives
in the DOM; the rest exists as an array in memory. The container height is
substituted so the scrollbar behaves honestly.

**Skipping paint off-screen.** Where virtualisation is overkill (landing sections,
cards in a grid):

```css
.section {
  content-visibility: auto;          /* off-screen: no layout, no paint */
  contain-intrinsic-size: auto 480px; /* a height placeholder so scrolling is stable */
}
```

`contain-intrinsic-size: auto <length>` remembers the real size once the section
has been on screen and uses it afterwards — the scrollbar stops jumping.

**Isolating subtrees.** `contain: layout paint` tells the engine that changes
inside do not escape: recalculation stops at the boundary. For sheets, cards and
widgets that is a cheap win.

## Layer explosion and GPU memory

A compositor layer is a buffer of pixels in video memory. Every `will-change:
transform`, `translateZ(0)`, `position: fixed`, video and canvas creates one.

On a phone that memory is shared with the CPU: extra layers evict each other,
rasterisation falls back to software, and the whole application sags. On iOS
exceeding video memory does not "slow things down", it kills the tab.

The rule: a layer is created **for the duration of an animation** and removed
afterwards. Check the layer count in the browser's layers panel; the indirect
signature in a report is high paint time with a small number of nodes.

## Work away from the main thread

- **A Web Worker** — sorting, filtering large arrays, parsing JSON, preparing data.
  Communicate with `postMessage`, and send heavy payloads as `Transferable`, not as
  copies.
- **OffscreenCanvas** — all graphics (2D, WebGL) can run in a worker:
  `canvas.transferControlToOffscreen()`, after which the render loop lives off the
  main thread and no longer depends on how busy it is.
- **Storage.** `localStorage` is synchronous: every access stops the thread. In a
  loop it is catastrophic (visible in a report as `pauseDuration`). For volume use
  IndexedDB, preferably from a worker.

## Network and loading

- Preconnect to third-party origins, priority hints (`fetchpriority="high"`) for the
  hero, preload for the critical font.
- Images: modern formats, honest `width`/`height` in the markup (otherwise layout
  shift), `loading="lazy"` for everything below the fold but **not** for the hero.
- Decoding a large image is main-thread work: tens of milliseconds on a weak CPU.
  Serve a size that fits the container instead of letting the browser downscale.
- Fonts: `font-display: swap` plus fallback metrics (`size-adjust`,
  `ascent-override`) so the swap does not move text.

## Quick lookup by symptom

| What you see | What to look at in the report | The usual cause |
|---|---|---|
| Scrolling stutters | share of frames >50 ms, per-script breakdown | a scroll listener reading geometry, animation on `top`/`height` |
| The tap "did not work" | waiting before the handler | the main thread was busy in a long task |
| The response happens, the picture lags | time to the frame on screen | expensive paint: shadows, filters, many nodes |
| Typing runs a character behind | typing p90, scripts in the breakdown | filtering and re-rendering on every character |
| Everything is smooth but the first screen is slow | blocking time during load | hydration and bundle weight |
| It gets heavier over time | heap growth, listener count | leaking subscriptions and timers |
