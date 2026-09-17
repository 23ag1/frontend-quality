---
name: frontend-quality
description: A frontend quality standard — the working process, a 50-point rubric, mechanical layout checks in a real browser (layout, states, touch targets, visual regression) and a catalogue of failure modes. Use for any interface work: building from a mock, fixing layout, spacing, states or responsiveness, and before saying "done" or "matches the design". Not for backend or scripts.
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
| Before saying "done" | [reference/checklist.md](reference/checklist.md) |
| What has already broken here (14 failure modes) | [reference/failure-modes.md](reference/failure-modes.md) |
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

For a small fix a contract is overkill — go straight to level 3.

### Level 3. Mechanical checks (before the word "done")

"Matches the design", "done" and "works" are only said after the checks have run.
"Should work" and "looks right" without a measurement are banned — write "looks
similar, not verified by instrument" instead.

```bash
SK=~/.claude/skills/frontend-quality/scripts

bash  $SK/check-forbidden.sh .                             # bans in the source
node $SK/verify-ui.mjs         --url http://localhost:3000 # overlaps, scroll, console, axe
node $SK/verify-states.mjs     --url http://localhost:3000 # hover, focus, contrast in states
node $SK/verify-tap.mjs        --url http://localhost:3000 # touch targets by real tap
node $SK/verify-regression.mjs --url http://localhost:3000 # comparison against baselines
node $SK/verify-motion.mjs     --url http://localhost:3000 --throttle 4  # frames, weight, reduced-motion
node $SK/verify-perf.mjs       --url http://localhost:3000 --throttle 20 # who ate the budget, by name
node $SK/verify-vocabulary.mjs --url http://localhost:3000 # how many different values are in use
```

What each one answers:

| Script | The question it answers |
|---|---|
| `check-forbidden.sh` | are the source bans broken (leading zeros, inline styles, `vh`, internal terms in visible text) |
| `verify-ui.mjs` | do elements overlap, is there horizontal scroll, does text escape its box, is anything unreachable, console errors, critical accessibility |
| `verify-states.mjs` | is focus visible, does hover respond, is there enough contrast **in every state** |
| `verify-tap.mjs` | does the finger hit the target and where does a miss go |
| `verify-regression.mjs` | did anything break that you did not touch |
| `verify-motion.mjs` | are we inside the motion and weight budgets |
| `verify-perf.mjs` | **who exactly** ate the budget: function, file, frame phase |
| `verify-vocabulary.mjs` | how narrow the decision vocabulary is |

Playwright and axe-core already live inside the skill — nothing is installed into
the project, and the scripts run from any directory.

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
critical accessibility, a console error, a failed request, `vh` instead of `dvh`,
an inline `style="..."`, `!important`, numbering with a leading zero, **internal
terms in visible text**, **a target smaller than 44px**, **invisible focus**,
**insufficient contrast in any state**, a difference from the baseline above the
threshold.

**FLAG** reports without failing — a human decides: raw HEX, a fixed height, a
dynamic `style={{ }}`, `dangerouslySetInnerHTML`, no `prefers-reduced-motion` while
animations exist, a miss landing next to a large target.

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

- fewer sizes with more contrast between them; the minimum in an interface is 12px;
- line height by range: body 1.4–1.65, captions 1.25–1.5, headings 1.15–1.3; light
  text on dark adds 0.05–0.1;
- space above a heading 2–3 paragraph spaces, below 0.5–0.75;
- sizes inside a block are fractions of it, with a `min()`/`clamp()` limiter; small
  text and touch targets get lower bounds.

## Layout teardowns

Two catalogues, different in origin:

- [reference/failure-modes.md](reference/failure-modes.md) — **14 failure modes
  collected by going through 190 fix commits of a real project**: the tap that
  disappears or fires twice; the keyboard after a panel collapses; a sticky bar
  inside a scroller; text that does not fit a card; layer order; infinite
  re-renders; a loading skeleton that never goes away; the frontend acting as a
  false source of truth. Each with a cause, a cure and the check that catches it.
- [reference/layout-lessons.md](reference/layout-lessons.md) — layout teardowns.

## Why such defects appear

- **Measured instead of looking.** The checks catch accidents but not an empty cell
  or a hole under a heading.
- **A template instead of the content.** The layout was chosen by habit rather than
  by what is inside.
- **Tuning a number instead of the structure.** A `min-height` fitted to today's
  text breaks on the first content change.
- **A written rule that is never checked does not work.** A ban is a line in
  `check-forbidden.sh`, not a paragraph in a document.

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

The report must contain a "what I did not check" section (Safari, a real device,
states under data). A report without its limits stated misleads more than no report
at all.

## Bans that apply to everything

- Numbering with a leading zero (01, 02, 03) — **nowhere**: not in text, diagrams,
  component data, captions, or through `counter()`. Only 1, 2, 3.
- Inline `style="..."`, `!important`, `vh` instead of `dvh`.
- Raw HEX in markup instead of a token.
- Hard-coded sizes instead of the scale and the tokens.
