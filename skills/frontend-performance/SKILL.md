---
name: frontend-performance
description: Frontend performance — how to reach 60 frames per second with the CPU throttled 20 times: the arithmetic of the frame budget, a measurement method on production builds, analysis attributed to functions through long-animation-frame, and a catalogue of causes split between applications and promo pages. Use when an interface stutters, lags, responds slowly to input or weighs too much.
user-invocable: true
argument-hint: "[measure|budget|react]"
---

# 60 frames where the hardware is weak

The process and the layout checks live in the `frontend-quality` skill. Deeper
material: [reference/perf-playbook.md](reference/perf-playbook.md) — techniques by
phase of the frame pipeline, [reference/perf-react.md](reference/perf-react.md) —
React and Next.

The goal here is stated bluntly: **60 frames per second with the CPU throttled 20
times.** That is not a slogan but an arithmetic requirement, and the whole
architecture follows from it.

## The arithmetic everything follows from

A frame at 60 Hz is 16.67 ms. With the CPU slowed N times, that frame leaves
`16.67 / N` milliseconds of **real** work:

| Throttling | Frame budget in unthrottled ms | What fits |
|---|---|---|
| ×1 (the developer's desktop) | 16.67 | almost anything, which is why nothing shows here |
| ×4 (a typical measurement) | 4.17 | a light re-render of a 20-row list |
| ×6 (mid-range hardware) | 2.78 | a style recalculation over a couple of hundred nodes |
| ×20 (a cheap Android, the goal) | **0.83** | practically nothing |

0.83 ms is less than a single `getBoundingClientRect()` costs on an average page.
There is only one possible conclusion:

> **At ×20 a frame must happen WITHOUT the main thread.** Not "fast JS per frame"
> but no JS per frame at all. Motion goes entirely to the compositor; the main
> thread stays empty while it happens.

Everything else in this document is a consequence.

### Three laws

1. **Motion is `transform` and `opacity` only.** Those two are changed by the
   compositor on the GPU over already-rasterised layers: style, layout and paint
   never run. Any `width`, `height`, `top`, `margin` or `filter` per frame means
   layout and paint on the main thread — that is, instantly over budget.
2. **No work is attached to the frame.** No `rAF` handlers reading geometry, no
   `scroll` listeners computing positions, no JS-driven animation. A frame should
   be empty by default, not "optimised".
3. **The work that does exist (input, data, network) is chunked.** A task longer
   than 50 ms blocks input; at ×20 that is 2.5 ms of real work. So the unit of
   work is 2–5 ms, with the thread yielded between chunks.

### Where the goal is unreachable, say so out loud

If a screen must repaint from new data every frame — a live chart, a camera, a map
with vector tiles — 60 frames at ×20 will not happen, and promising them is
dishonest. Then the goal is stated differently: **a steady 30, without jank**, with
the heavy work moved into a worker or onto `OffscreenCanvas`. A steady 30 is
perceived better than a dancing 45–60.

## How to measure

### Rules

1. **Production build only.** A development React build is three times slower and
   the numbers lie: `npm run build && next start -p 3011`.
2. **Median and p90, not one run.** The spread between runs reaches 3×. The first
   three measurements are warm-up and get dropped.
3. **Real load.** On a demo set of 48 items, filtering costs fractions of a
   millisecond and shows nothing. A real menu is ~300 items.
4. **Numbers are normalised to unthrottled ones.** `measured / N`. Otherwise a run
   at ×4 and a run at ×20 cannot be compared, and "it got better" means nothing.

### The instrument

```bash
SK=~/.claude/skills/frontend-quality/scripts

# Budgets: are we inside them or not
node $SK/verify-motion.mjs --url http://localhost:3011 --throttle 4

# Who exactly ate the budget: script, function, file, frame phase
node $SK/verify-perf.mjs --url http://localhost:3011 --throttle 20
node $SK/verify-perf.mjs --scenario ./e2e/scenarios/cart.mjs --throttle 20 --json report.json
```

`verify-perf.mjs` is the main analysis tool. It captures:

- **long frames** (`long-animation-frame`) broken down by script: function name,
  file, invoker type, forced layout time and synchronous pauses;
- **the components of the response** (`event timing`): waiting before the handler,
  the handler itself, and the time to the frame on screen — that is, what INP is
  made of;
- **frames under real scrolling** (wheel or finger, not a programmatic `scrollTo`,
  which bypasses the compositor and flatters the result);
- **input latency** from a character to the second frame, median and p90;
- **engine counters** through CDP: layouts, style recalculations, nodes,
  listeners, heap growth;
- **the idle phase**: an open, untouched screen must be doing nothing.

The report names the culprit immediately: `221 ms × 1 — hydrateRoot — chunk-16g.js
[classic-script]` is more useful than "loads slowly".

### What each number means

| Measurement | Product norm | What exceeding it says |
|---|---|---|
| work per frame (unthrottled) | ≤ 4 ms at ×4, ≤ 0.83 ms at ×20 | motion runs through the main thread |
| waiting before the handler | ≤ 8 ms | the main thread was busy at the moment of the tap |
| handler | ≤ 12 ms | the handler does extra work |
| to the frame on screen | ≤ 16 ms | expensive painting: too many nodes, shadows and filters |
| typing, p90 | ≤ 40 ms | filtering and re-rendering on every character |
| `forcedStyleAndLayoutDuration` | 0 | geometry read after a style write |
| `pauseDuration` | 0 | a synchronous request, `alert`, heavy `localStorage` |

### A worked example: a login screen at ×20

A real run, production build on `:3011`, throttling ×20:

```
Scrolling
  frames 101, median 17.2 ms (58 fps), p95 102.0 ms, worst 210 ms
  frames longer than 50 ms: 8 (7.9%)

Interactions (components of INP)
  pointerdown  total 216 ms = waiting 20 + handler 38 + painting 159

Long frames and who created them
  long frames 33, blocking time 3567 ms
  1141 ms × 1  — turbopack-…js       [classic-script]
  1025 ms × 11 — O — 16g.…js          [event-listener]
   526 ms × 8  — ReadableStream…read  [resolve-promise]

Engine counters
  nodes 79, listeners 399, layouts 10 (48 ms), style recalcs 24 (147 ms)
```

What can be read from this in half a minute:

- **Median 17.2 ms at ×20** — that is 58 frames. Exactly as it should be: nothing
  executes per frame on this screen, so motion does not disturb the compositor.
  The goal is reachable, and here is the proof.
- **What breaks is not the average frame but the tail**: 7.9% of frames longer
  than 50 ms, the worst one 210 ms. The cause is named: loading and executing
  scripts, 3.5 seconds of blocking time across the run.
- **Painting dominates the response** (159 ms out of 216), not the handler. So the
  thing to optimise is not the press logic but the cost of the frame after it: 399
  listeners and 24 style recalculations over 79 nodes is out of proportion.
- **Forced layout from scripts is 0.0 ms** — there are no geometry reads after
  style writes; that whole class of defect can be skipped.

From there the work proceeds by name, not by guesswork.

## The protocol

The order is mandatory: without it people optimise what is convenient rather than
what hurts.

1. **Reproduce the scenario.** Not "the app is slow" but "opening the cart on a
   table with three guests and a 300-item menu".
2. **Take a baseline** on a production build at the intended throttling. Write the
   numbers down.
3. **Find the dominant cause** from the `verify-perf` report: whose script, which
   phase. A hypothesis without a number is not a diagnosis.
4. **One change at a time.** Two changes at once mean you never learned the cause.
5. **Re-measure with the same script**, and put "before → after" into the report.
6. **Lock it in with a limit.** A change nothing holds will come back: the limit
   goes into `.uiverify.json`, the run goes into CI.

## Catalogue of causes: a product

In descending order of frequency from real investigations.

### 1. Redundant requests per action

One user action turning into 19 requests: every part of the screen refetches its
own. The cure is not a faster request but deduplication: one cache per screen, one
source of truth, cancellation of stale requests. The signature in the report: time
goes into waiting rather than scripts, and `blockingDuration` is small.

### 2. The whole list re-renders from one change

Unstable props and callbacks are recreated on every render and the children's
memoisation never fires. In production this has already produced an infinite
render loop from an unstable `onOrderGone`. The teardown and the techniques are in
[reference/perf-react.md](reference/perf-react.md).

### 3. A long list without virtualisation

Past roughly 1500 nodes, style recalculation and layout become noticeable on their
own. Virtualisation keeps only what is visible plus a buffer; for sections that
cannot be virtualised there is `content-visibility: auto` with
`contain-intrinsic-size`.

### 4. Animations that never finish

A node is removed from the DOM or a property is overridden midway — the browser
fires `animationcancel` / `transitioncancel`. An aborted animation reads to a human
as "it hung". Audit: a small script over the scenario attaches listeners and counts
the finished against the aborted.

### 5. Leaks in a long session

A shift lasts hours and the tab is never reloaded: subscriptions, timers,
listeners and unclosed event streams. The signature is heap growth across the
interaction pass in the `verify-perf` report.

### 6. Input latency

Filtering on every character over a large menu. The order of treatment: a deferred
value for the heavy list, memoised rows, virtualisation — and only then
micro-optimising the filter itself.

## Catalogue of causes: a promo page

### 1. Bundle weight

A library for one effect, unused icons, extra font weights. Every kilobyte over
budget is defended out loud.

### 2. Images

No modern formats, no dimensions in the markup (which causes layout shift), the
hero not loaded first. Decoding a large image on a weak CPU costs tens of
milliseconds of main thread.

### 3. Fonts

Blocking loading, no `font-display`, a swap midway. Text shifting after the swap
is both CLS and extra layout work.

### 4. Scroll animations on layout properties

`transform` and `opacity` may move. `top`, `height`, `filter` per frame may not.
The modern replacement for a hand-written scroll listener is scroll-driven
animation in the browser, and `IntersectionObserver` instead of counting positions
by hand.

### 5. Layer explosion and GPU memory

`will-change: transform` on everything and `translateZ(0)` "for speed" create
compositor layers, each with its own buffer in video memory. On phones that memory
is shared with the CPU: too many layers drop the whole application into software
rasterisation, and on iOS exceeding video memory kills the tab.

### 6. A scene that never pauses

A WebGL scene keeps computing frames outside the viewport and on a hidden tab.
Stop it with `IntersectionObserver` and `visibilitychange`.

## A threshold in CI

Numbers nothing holds drift apart within a couple of weeks. The minimum:

```yaml
- run: npm run build
- run: npx next start -p 3011 &
- run: node ~/.claude/skills/frontend-quality/scripts/verify-perf.mjs
        --url http://127.0.0.1:3011 --throttle 4 --json perf.json
```

Failing the blocking limits means a red build. One run per pull request catches
the regression a human would not notice.

## What this document does not promise

- A measurement in a headless browser on a server is not the same as a live phone:
  no thermal throttling, a different GPU, a different network. Before shipping
  heavy graphics, check on a real device.
- CDP throttling is uniform, while a real cheap phone stutters in bursts: slow
  memory and aggressive frequency scaling. Our numbers are a lower bound on the
  trouble, not an upper one.
- 60 frames at ×20 are reachable only where the frame does not need the main
  thread (see above). Everywhere else the honest goal is a steady 30.
