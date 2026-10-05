---
name: frontend-quality
description: A frontend quality standard — the working process, laws of interface behaviour, a 50-point rubric, mechanical checks in a real browser (layout, states, touch and gestures, the on-screen keyboard, double taps and stale responses, consistency across pages, old browsers and the Safari engine, visual regression) and a catalogue of failure modes from production. Use for any interface work: building from a mock, fixing layout, spacing, states, forms or responsiveness, and before saying "done" or "matches the design". Not for backend or scripts.
user-invocable: true
argument-hint: "[verify|rubric|adopt]"
---

# Frontend quality

The part shared by every interface, product or promo. Work goes in three levels,
bottom-up: **project context → a contract for the screen → mechanical checks.**
Skipping any level produces an averaged result that gets rebuilt later.

| Task | Where |
|---|---|
| An application, an admin panel, a point of sale, a dashboard | [reference/product.md](reference/product.md) |
| A landing page, a promo page | [reference/landing.md](reference/landing.md) |
| What the interface must do that nobody wrote down | [reference/behaviour-laws.md](reference/behaviour-laws.md) |
| Which browsers to support and what breaks on old ones | [reference/browser-floor.md](reference/browser-floor.md) |
| Forms, sheets and the keyboard on a phone | [reference/forms-mobile.md](reference/forms-mobile.md) |
| Network, stale responses, errors, optimistic updates | [reference/network-state.md](reference/network-state.md) |
| Before saying "done" | [reference/checklist.md](reference/checklist.md) |
| What has already broken in production | [reference/failure-modes.md](reference/failure-modes.md) |
| Layout teardowns | [reference/layout-lessons.md](reference/layout-lessons.md) |
| Adopting this on a new project | [reference/adopt.md](reference/adopt.md) |
| Visual decisions and taste | the `visual-taste` skill |
| Speed and smoothness | the `frontend-performance` skill |

## Three levels

### Level 1. Project context (once)

Design skills without project context produce the average: a dark theme, a
lavender gradient, frosted glass, a centred hero with a badge, a grid of identical
cards. That is not a style, it is the statistical mean of the training data.

Before any design work a project needs an `.impeccable.md`: audience, scenarios,
character and tone. It cannot be derived from the code — code says what was built,
not who it is for or how it should feel. No file — get the answers from whoever
owns the product.

If there is a mock in Figma, pull the numbers through the Figma MCP
(`get_design_context`, `get_variable_defs`) instead of reading them off a
screenshot: a screenshot holds neither tokens nor fractional values.

### Level 2. A contract for the screen (before the code)

For a new screen or a substantial rework, the contract comes first. It declares:
the point of focus and the visual hierarchy, the type scale, the colour roles, the
spacing step, every state (empty, error, loading, disabled) and the button labels.
A new composition is shown as 2–3 variants on real data before the code; the
approved one is frozen and committed before the next step.

**Every change, small ones included, derives its cases before the code** — for the
element being touched, not the whole screen: what the person wants here → which
events change that (scroll, keyboard, back, a late response, a second tap, another
path to the same action, another width or theme) → what each of the laws in
[reference/behaviour-laws.md](reference/behaviour-laws.md) demands. Most of what
owners call "obvious, but you missed it" falls out of this list; a defect that
returns again and again is a starting state nobody walked through.

For a small fix the rest of the contract is overkill — derive the cases, then go to
level 3.

### Level 3. Mechanical checks (before the word "done")

"Matches the design", "done" and "works" are only said after the checks have run.
"Should work" and "looks right" without a measurement are banned — write "looks
similar, not verified by instrument" instead.

```bash
SK=~/.claude/skills/frontend-quality/scripts

bash  $SK/check-forbidden.sh .                             # bans in the source
node $SK/check-browser-floor.mjs src                       # features above the browser floor
node $SK/verify-ui.mjs          --url http://localhost:3000 # overlaps, scroll, console, hydration, axe
node $SK/verify-states.mjs      --url http://localhost:3000 # hover, focus, contrast in states
node $SK/verify-tap.mjs         --url http://localhost:3000 --gestures # real taps, holds, swipes
node $SK/verify-keyboard.mjs    --scenario ./e2e/scenarios/form.mjs   # the on-screen keyboard, two models
node $SK/verify-races.mjs       --scenario ./e2e/scenarios/cart.mjs   # double taps, late answers, settling
node $SK/verify-consistency.mjs --config .uiverify.json    # the same thing the same on every page
node $SK/verify-regression.mjs  --url http://localhost:3000 # comparison against baselines
node $SK/verify-motion.mjs      --url http://localhost:3000 --throttle 4  # frames, cut animations, reduced-motion
node $SK/verify-perf.mjs        --url http://localhost:3000 --throttle 20 # who ate the budget, by name
node $SK/verify-vocabulary.mjs  --url http://localhost:3000 # how many different values are in use
```

What each one answers:

| Script | The question it answers |
|---|---|
| `check-forbidden.sh` | are the source bans broken: leading zeros, inline styles, viewport units the floor cannot read, raw colours and palette classes, raw `fetch` outside the network layer, storage read during render, text below the minimum size, internal terms in visible text |
| `check-browser-floor.mjs` | does the code use CSS or JS that the oldest supported browser does not have, without a fallback or a polyfill |
| `verify-ui.mjs` | do elements overlap, is there horizontal scroll, does text escape its box, is anything unreachable, console errors, hydration mismatches, broken in-page anchors, critical accessibility — from 320 px to wide, in landscape and with large system text |
| `verify-states.mjs` | is focus visible, does hover respond, is there enough contrast **in every state** |
| `verify-tap.mjs` | does the finger hit the target, where does a miss go, does a hold or a tap right after a swipe land where it should |
| `verify-keyboard.mjs` | with the keyboard open (the window shrinks, or the bottom is covered): is the field visible, does tapping inside the sheet keep the keyboard and the height, does Back close the overlay |
| `verify-races.mjs` | does a double tap send twice, does an older answer overwrite a newer screen, does the screen change by itself seconds later, does a failure look like success |
| `verify-consistency.mjs` | are gutters, headings, columns, row lines, toggle heights and focus rings the same everywhere |
| `verify-regression.mjs` | did anything break that you did not touch |
| `verify-motion.mjs` | are we inside the motion and weight budgets, is any animation cut before it ends |
| `verify-perf.mjs` | **who exactly** ate the budget: function, file, frame phase |
| `verify-vocabulary.mjs` | how narrow the decision vocabulary is |

Playwright and axe-core already live inside the skill — nothing is installed into
the project, and the scripts run from any directory.

**Engines.** Every browser check runs in Chromium by default. `FQ_BROWSER=webkit`
runs it in the Safari engine; `FQ_BROWSER=chromium FQ_CHROME_PATH=<path>` runs it in
an old Chromium that `scripts/fetch-chromium.sh <major>` downloads. Run the critical
scenarios on the floor engine too: in one production app a quarter of the traffic
came from a browser four years old, and nothing that ran on a fresh Chromium saw
its breakages. Checks that need Chromium's debugging protocol (CPU throttle, real
touch) say "skipped on <engine>" instead of passing quietly.

The project config is `.uiverify.json` in the root (addresses, scenarios,
breakpoints, exclusions); the template is `reference/uiverify.example.json`.
**The file's presence switches the gate on:** the Stop hook will not let a turn
close while the check is red. In projects without the file the hook stays silent.

In a monorepo the scope of the bans is limited by `checkPaths`: the new frontend
usually sits next to legacy code with hundreds of violations, and a gate over the
whole tree would be red always — which means it would simply be switched off.

```json
{ "checkPaths": ["src", "packages/ui/src"] }
```

The gate runs three things: the source bans, the browser-floor scan (only when
`browserFloor` or a browserslist is declared) and `verify-ui.mjs` on **one
scenario** named in `gateScenario` — the working screen, one breakpoint, an answer
in seconds. Without `gateScenario` the browser part does not run at all: on an
entry screen it produced nothing but noise. The gate reports blocking findings
only (warnings are counted), skips when nothing in `checkPaths` changed, and a red
state blocks once — it does not hold every later turn of every session hostage.

## Scenarios: check the state where the defects live

A check that merely opens an address sees the first state: a login screen, an
empty list, closed sheets. Real defects live further in — a cart with data, an open
sheet, a list of three hundred rows. So every browser check accepts a **scenario**:
a module that brings the environment up and drives the app to the right screen.

A ready-made template with mocks, sign-in and interactions is in
`templates/scenario.example.mjs`. If the project already has an e2e suite, a
scenario is ten lines on top of it:

```js
// e2e/scenarios/cart.mjs — reuses the existing test environment
import { openApp, openCart } from '../harness.mjs';

export const name = 'cart with items';
export const typeTarget = 'input[type="search"]';          // where to measure typing

export async function open() {
  const { browser, ctx, page } = await openApp({ items: 30 });
  return { browser, context: ctx, page };
}
export async function ready(page) { await openCart(page); }
export const interactions = [
  { name: 'open the filters', run: async (page) => { /* … */ } },
];
```

```bash
node $SK/verify-perf.mjs --scenario ./e2e/scenarios/cart.mjs --throttle 20
node $SK/verify-tap.mjs  --scenario ./e2e/scenarios/cart.mjs --gestures
```

Only `open` (or `url`) is required. Scenarios can also be listed in
`.uiverify.json`, and then every check picks them up at once. Keep heavy scenarios
out of the gate: it has to answer in seconds or it will be switched off.

Optional exports feed the behaviour checks (the contracts are in the header of each
script and in `templates/scenario.example.mjs`):

- `actions` — `[{ name, run, request }]`: what the person does and which request it
  sends; `verify-races.mjs` taps each twice, delays and reorders its answers, fails it
  once, and watches the screen settle;
- `readState` and `successText` — how to read what the screen claims, for the race
  and failure checks;
- `keyboardTargets` — `[{ name, open, field, inside }]`: the forms and sheets
  `verify-keyboard.mjs` opens with the keyboard up;
- `ignoreConsole`, `ignoreRequests` — known noise of this scenario.

**Test data is production-sized.** A list check on two cards passes while production
shows forty-seven; a scenario that seeds two rows proves nothing about the screen
people use. Seed the worst real case: the longest names, the most rows, duplicates,
empty fields, old saved values.

**How much this changes.** On the project where this was worked out, checking by
address found almost nothing; the same set run through a scenario with real data
immediately showed 206 ms of forced layout and a 76 ms delay before the handler.

## Visual regression

Every other check inspects the screen you were fixing. The defect "touched the
header, broke a card elsewhere" is caught by nobody: no overlaps, clean console.

```bash
node $SK/verify-regression.mjs --url http://localhost:3000 --update   # take baselines
node $SK/verify-regression.mjs --url http://localhost:3000            # compare
```

Baselines live in `.uiverify-baseline/` and are committed with the code. Live data
(clocks, counters, avatars) is masked by selectors from `.uiverify.json` →
`ignoreDiff`, otherwise "the clock ticked" reads as a regression. The default
threshold is 0.1% of differing pixels with a colour tolerance of 8: anti-aliasing
does not count as a change, a layout shift does.

## Severity levels

**BLOCK** fails the check: elements overlapping in flow, horizontal scroll,
critical accessibility, a console error, a hydration mismatch, a failed request,
a bare `vh`, and — when the floor is below Chrome 108 — a bare `dvh`/`svh`/`lvh` or
one inside `calc()`; a CSS or JS feature above the browser floor with no fallback;
an inline `style="..."`, `!important` (outside the `prefers-reduced-motion` block),
numbering with a leading zero, **internal terms in visible text**, **a target
smaller than 44px**, **invisible focus**, **insufficient contrast in any state**,
a focused field hidden by the keyboard, a tap inside a sheet that drops the
keyboard, a request sent twice by a double tap, an older answer overwriting a newer
screen, a screen that changes by itself, an animation cut before it ends because
its element was removed, different gutters or headings across pages, a difference
from the baseline above the threshold.

**FLAG** reports without failing — a human decides: raw HEX, palette classes
(`bg-blue-500`), a fixed height, a dynamic `style={{ }}`, `dangerouslySetInnerHTML`,
raw `fetch` outside the network layer, storage read during render, text below the
project's minimum size, monospace text, `env(safe-area-inset-*)` without
`viewport-fit=cover`, a feature above the floor that has a guard, no
`prefers-reduced-motion` while animations exist, a miss landing next to a large
target, a broken in-page anchor, a focus ring after a mouse click.

The thresholds are project settings in `.uiverify.json`: `browserFloor`,
`minFontPx`, `allowMono`, `paletteClasses`, `networkPaths` (see the template).

A legitimate exception to the internal-terms vocabulary is marked in the code:
`ui-lexicon-ok` in a comment above the line clears the finding (for example when a
column name is a requirement for a file the user prepares themselves).

## What the scripts do not catch

Empty cells, columns of different heights, a hole under a heading, monotony, cheap
colour work. Formally everything there is fine. So every finished section is
captured **whole** and looked at, not cropped to the bit you fixed. A report saying
"0 violations" can be true for the checks and still say nothing about the quality
of the layout.

Calibration of the overlap detector: absolutely and fixed positioned elements are
excluded, so are elements clipped by a parent with `overflow: hidden`, and overlaps
covering less than a quarter of the smaller box. Automation cannot tell a
deliberate overlap (display type over text, a collage) from breakage — such places
go into `ignoreOverlap` with a comment saying why it is intended.

## The rubric

Five dimensions, 0–10 each, 50 in total.
Thresholds: **≥42 — ship, 30–41 — targeted fixes, <30 — rebuild.**

| # | Dimension | What is checked |
|---|---|---|
| 1 | Accuracy and tokens | Not a single raw HEX or inline px. Numbers from the mock carried over verbatim, fractions included. The mock's nesting preserved in the markup |
| 2 | Layout and rhythm | An 8px grid (4px in a dense interface). Space above a heading 2–3× a paragraph, below 0.5–0.75×. No overlaps or horizontal scroll at any width. Identical elements match in radius, height and spacing |
| 3 | States | hover, focus, active, disabled, loading, empty, error. Every added state captured in a screenshot |
| 4 | Accessibility | Contrast 4.5:1 for text, 3:1 for large. Landmarks, keyboard navigation, `aria-*`, touch targets no smaller than 44px |
| 5 | Content | Buttons named with a verb and a noun, not "Submit" or "OK". The empty state has text, the error has a way out |

Scores come from measurements, not impressions. The report carries numbers:
"1750×990 at left=85 against 1750.25×990 at 84.875", not "matches".

## The numbers that lie most often

The type scale, line heights by range, tracking, measure, the spacing grid and
proportions instead of pixels live in the `visual-taste` skill: decisions are made
there, verified here. The short version, so you do not have to switch for one line:

- fewer sizes with more contrast between them; the minimum size is set by the project; without one it is 16px;
- line height by range: body 1.4–1.65, captions 1.25–1.5, headings 1.15–1.3; light
  text on dark adds 0.05–0.1;
- space above a heading 2–3 paragraph spaces, below 0.5–0.75;
- sizes inside a block are fractions of it, with a `min()`/`clamp()` limiter; small
  text and touch targets get lower bounds.

## Layout teardowns

Two catalogues, different in origin:

- [reference/failure-modes.md](reference/failure-modes.md) — **failure modes
  collected from the fix history of a production app** (about 750 fix commits and
  a month of classified fixes): the tap that disappears or fires twice; the
  keyboard and the sheets; old browsers in the field; hydration; stale answers
  overwriting fresh edits; the screen changing by itself; text that does not fit;
  layer order; the eternal skeleton. Each with a cause, a cure and the check that
  catches it.
- [reference/layout-lessons.md](reference/layout-lessons.md) — layout teardowns.

In that month three quarters of the fixes were not missing knowledge: the knowledge
existed and was not applied. Half were repeats of a class fixed before. A written
lesson did not stop a repeat; a check did. That is why this skill turns lessons into
scripts and fixtures, and why a rule without a check is treated as a draft.

## Why such defects appear

- **Measured instead of looking.** The checks catch accidents but not an empty cell
  or a hole under a heading.
- **A template instead of the content.** The layout was chosen by habit rather than
  by what is inside.
- **Tuning a number instead of the structure.** A `min-height` fitted to today's
  text breaks on the first content change.
- **A written rule that is never checked does not work.** A ban is a line in
  `check-forbidden.sh`, not a paragraph in a document.
- **One path fixed out of several.** The same action reachable from two screens, or
  the same logic written twice (for a local record and for one that came from
  another system), got the fix on one side only. Before a fix, list every path to
  the action; the test covers each of them.
- **An old assumption nobody revisited.** A behaviour designed for a draft kept
  running after the data started going straight to the server. When the conditions
  change, grep everything that relied on the old ones.

## How the work is done

These are the steps that, by the fix history, decide whether a defect comes back.

1. **Behaviour along every entry path and state, written before the code.** Not
   reproduced — then the change is "a fix by hypothesis", and the report says so.
2. **A guard test is shown red on the old code once.** A test that was never red
   proves nothing; one that passed on broken code happened more than once.
3. **The second defect of the same class is a mechanism, not a third patch.** Name
   the class, price the shared fix (a primitive, one network layer, one geometry
   model, an id per entity), file it; a patch in place is allowed only as temporary,
   pointing to that task.
4. **Fix the primitive that others bypass.** If three screens build their own sheet
   because the shared one cannot do something, the shared one gets that ability.
   One focus ring, one field, one back link for the whole site.
5. **One truth, one definition.** A value that lives in CSS and in JS, a skeleton
   and the row it stands for, a document and the code — derive one from the other.
6. **An early return gets its side effects listed.** Everything below it (a metric,
   a scroll, closing a sheet, a request) is decided one by one.
7. **"Done" names its stage** — merged, deployed to staging, live — and is said after
   looking at that stage itself (the live bundle, not the push).

## Text in the interface

- The user's language only. No names of other venues or projects, no internal terms
  or field names (`SKU`, `product_id`, `already_bought=true`), no words like
  "backend", "server", "endpoint", no explanations of how the engine computes. The
  reason is threefold: it exposes how the system is built, hands your work to
  competitors, and announces that the text was written by a machine.
- Instead of "will appear after the backend update" → "not available yet". Instead
  of "the backend cannot count several items" → "only part of your selection was
  counted, pick one item or try again later".
- Service `notes`/`detail` from API responses are never rendered — only your own
  human copy.
- A button is a verb with a noun: "Send order", not "OK". The empty state has text,
  the error has a way out. No slang.

## Reuse instead of new elements

An element needed in two states is **one** element with a modifier (a menu arrow is
one button with `rotate-180`), not two copies. Before adding a button or an icon,
`grep` the component and its neighbours: is there one already? If yes, extract it
into one place and parameterise. Orphaned props (`collapsed`, `onToggle`) get
deleted immediately.

A visual effect ("as if the menu slid under the bar") is solved by order in the
flow and existing controls, not by `z-index`, shadows and other crutches.

## Independent acceptance

The `ui-verifier` agent checks the work: it did not do it and never saw the
reasoning. It runs the measurement scripts, looks at **full** screenshots, compares
against the original, scores against the rubric — and is not allowed to fix
anything.

Call it explicitly before hand-off, **not after every edit**: reflexively verifying
each step with subagents burns tokens without adding quality. One pass at the end,
with a fresh eye, is a different matter.

Before looking at what was done, it derives the cases itself with
[reference/behaviour-laws.md](reference/behaviour-laws.md) for the touched element;
a case it finds that the implementation never considered is a finding.

Anything that can be checked by reading or running is checked before the report.
The "what I did not check" section lists only what needed a real device, a write,
or access the agent did not have — each with that reason. "Did not check" as a
conclusion of something checkable is not a limit, it is unfinished work.

## Bans that apply to everything

- Numbering with a leading zero (01, 02, 03) — **nowhere**: not in text, diagrams,
  component data, captions, or through `counter()`. Only 1, 2, 3.
- Inline `style="..."`, `!important` (except the reduced-motion reset).
- Viewport height: a bare `100vh` is taller than the visible area on Android; a bare
  `dvh` is dropped whole by Chrome 107 and older; `calc(100dvh - x)` is accepted by
  Chrome 106 and resets to `auto`; a `100vh; 100dvh` pair is merged by minifiers.
  The one form that works everywhere: `var(--app-h, 100dvh)` with `--app-h` set
  from `window.innerHeight` by a script (details in
  [reference/browser-floor.md](reference/browser-floor.md)).
- Raw HEX and default palette classes in components instead of a role token.
- Hard-coded sizes instead of the scale and the tokens.
- Text below 16px and monospace text, unless the project records an exception
  (`minFontPx`, `allowMono`) — a dense working tool may need 12px, a site does not.
