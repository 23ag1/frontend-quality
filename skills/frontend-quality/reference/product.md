# Product frontend: applications, admin panels, points of sale

Read it together with [the skill body](../SKILL.md). This file is what separates a
working tool from a promo page. For landings see [landing.md](landing.md).

## How a product differs from a landing

| | Product | Landing |
|---|---|---|
| Goal | a person does their job fast and without mistakes | a person is impressed and understands the offer |
| Success | fewer misses, fewer steps, predictability | watched it, clicked, remembered |
| Animation | feedback and explaining a transition only | the move they came for |
| Novelty | the enemy: unfamiliar means relearning | value |
| Density | high, the screen is a workplace | air, one thought per screen |
| Verification | scenarios, states under data, touch | sections, motion, budgets |

The main consequence: **in a product a new idea is rejected by default.** If there
is an industry reference next to you (the incumbent point-of-sale app, the tool
everyone already uses), it gets copied rather than improved. "Make it exactly like
the one they know" is a requirement, not laziness on the client's part: nobody
relearns their tool mid-shift.

## Iron rules

1. **Do not add unapproved functionality.** Collapsing sections, "smart" hints,
   reordering — propose them, do not ship them by default. Add it on your own and
   it will most likely be removed, with the time wasted.
2. **Reuse, do not multiply.** One element with a modifier instead of two copies
   (see the skill body).
3. **The user's language only in copy** (see the skill body, the text section).
4. **Touch targets ≥44×44**, verified with a real tap — see below.
5. **States under data are part of the task, not an afterthought**: empty, one row,
   a hundred rows, a long name, a zero price, a lost connection, a repeated tap.

## Before you edit — the failure catalogue

[failure-modes.md](failure-modes.md) was assembled by going through the history of
a real project: 190 fix commits and the closed bugs. Almost any defect you are
about to fix has happened there already — with its cause and the check that
catches it.

## Touch targets: why "we made it bigger" usually means nothing

A real failure: the target for an item's status was "made bigger", the numeric test
passed, and people kept missing it. Two causes at once:

- `click({force})` in Playwright lands exactly in the centre of an element and
  physically cannot show that the hit area ends right beside the label;
- inside a flex column `w-full` measures the width **of the column**, and negative
  margins (`-mx-3`, `-my-2`) do not widen the box — they move it. The "enlarged"
  target stayed 56×32 against a norm of 44×44.

Worse than the size was **where the miss went**: a tap on the price or near the
screen edge landed on the row and opened the modifiers sheet — to the user that is
"it did not work", not "I missed".

**How to do it.** Measure the target from the parent column: `relative` on the
column plus `absolute -inset-x-3 -top-0.5 -bottom-0.5` on the button. Keep the
label inside the target and give the space in the flow to an invisible twin
(`invisible` + `aria-hidden`) — otherwise the column shrinks and the name wraps
differently.

**How to check.** This is no longer a manual procedure:

```bash
node ~/.claude/skills/frontend-quality/scripts/verify-tap.mjs --url http://localhost:3000
node ~/.claude/skills/frontend-quality/scripts/verify-tap.mjs --scenario ./e2e/scenarios/cart.mjs
```

The script dispatches a real tap through CDP `Input.dispatchTouchEvent` at the
centre, the edges and the corners of the target, plus four miss points 8 pixels
outside. To keep the run from changing application state, a capture-phase sink sits
on the window: the event reaches hit testing but never the handlers.

What it counts as a violation:

- a target smaller than 44×44 — **BLOCK**;
- a tap on an edge or a corner taken by another element (the target is covered) —
  **BLOCK**;
- a miss next to a small target landing on an element **four times larger** —
  BLOCK: exactly the "tapped next to the status, opened the modifiers" case.

What it deliberately does NOT count: a miss onto an equal neighbour (keypad keys
are meant to sit side by side) and the geometric corner of a rounded button, where
the hit legitimately belongs to the parent.

One thing stays manual: check that row heights did not drift — negative margins
easily add 4px and the list starts to breathe.

## Grid and scale in a dense interface

A point-of-sale screen is denser than a marketing one: the grid is **4pt**, not
8pt. In Tailwind that means whole classes; half values (`p-2.5`, `gap-1.5`,
`mt-0.5`) give 2/6/10/14px — off the grid, do not use them. Replacements:
`2.5→2 or 3`, `1.5→1 or 2`, `0.5→1` or remove it.

Radii come from a set: `rounded-lg`(8) / `rounded-xl`(12) / `rounded-2xl`(16) /
`rounded-full`. Arbitrary `[10px]`, `[0.8rem]` are banned.

A type scale with semantic roles (an example of a working system):

| Role | Tailwind | px | Weight |
|---|---|---|---|
| Display (screen title) | `text-4xl` | 36 | `extrabold` |
| Title (sheet title) | `text-xl` | 20 | `bold` |
| Headline (section heading) | `text-lg` | 18 | `bold` |
| Body | `text-base` | 16 | `normal`/`medium` |
| Body-sm (the workhorse in dense UI) | `text-sm` | 14 | `normal`/`medium` |
| Caption (labels, metadata) | `text-xs` | 12 | `medium` |

Weights: 400 text, 500 emphasis, 600 buttons and labels, 700 headings, extrabold
for Display only. Do not use `font-light`.

Colour by semantic role, not by eyeballed shade: heading 900, secondary 500, muted
400, accent and links blue-500/600, danger red-500. Do not multiply shades.

## Code structure

- A file ≤800 lines, a component ≤300. God components of 1400–1700 lines are not
  "a big file" any more, they are an inability to change anything without a
  regression.
- Split by meaning: a guest row, an item row, the menu panel, the sheets, the
  session and cart hooks.
- One primitive per role: `Sheet`/`ActionSheet` instead of inline overlays, a
  `Button` (cva) instead of raw `<button>`, `icons.tsx` instead of repeated inline
  SVG, `formatMoney` instead of copy-pasted `toLocaleString`.
- Layers (pragmatic FSD on top of an app router): `app → widgets → features →
  entities → shared`, dependencies pointing down only. Migrate one slice at a time
  with a visual check of the screen, never all at once.
- In a panel with a monolithic `index.html`, extract features one by one into
  separate slices instead of growing the monolith. Watch shared CSS classes: after
  extracting a feature, check who else uses its classes.

## States and data

- Every state (hover, focus, active, disabled, loading, empty, error) is captured
  in a screenshot. A state reveals what a static mock hides: radii, borders,
  shadows, contrast.
- Lists are checked at real volume, not on three rows: a real menu is ~300 items, a
  floor is dozens of tables. Toy data shows neither performance, nor wrapping, nor
  scrolling.
- Networks fail and requests duplicate: a second tap must not send a second order,
  and "success" must not be shown before confirmation.
- A long session is normal: a shift lasts hours and the tab is never reloaded.
  Check for leaks and memory growth, not only the first render.

## Data and asynchrony

This is where the most expensive product defects live: not "the margin shifted" but
"the order went through twice". Rules worth holding from the first line:

- **A skeleton beats a spinner.** When the shape of the content is known, draw a
  skeleton of the same geometry: the data arriving then does not move the layout. A
  spinner belongs where the shape is unknown or the wait is short.
- **A threshold for showing a wait.** A load shorter than ~200 ms should show
  nothing: an indicator that flashes and vanishes reads as a glitch.
- **An optimistic update only with a rollback.** If you showed the result before the
  answer, you are obliged to restore the previous state and say it did not work.
  Without a rollback that is not optimism, it is the interface lying.
- **A repeated tap does not create a second entity.** The button that sends is
  disabled for the duration of the request, and the request carries an idempotency
  key. "Success" appears after confirmation, not after the press.
- **Races get cancelled.** A response to a stale request must not overwrite a fresh
  one: cancel the previous request or check that the answer matches the current key.
- **A lost connection is a normal state.** Every screen has a "connection lost"
  view: what happened, what was saved, what to do. Silence is unacceptable.
- **An error names the way out.** Not "failed" but "the item did not reach the
  kitchen, send it again".

## Dark theme, long strings, another language

A gap worth knowing about in advance rather than fixing later:

- If a dark theme is claimed, both modes are checked, states and contrast included.
  You cannot rely on inverting colours: shadows and borders behave differently in
  the dark.
- Interface text is often twice as long as in the mock: "Send" against "Send the
  selected items". Buttons and headings are checked on the long variant, not only
  on the exemplary one.
- Numbers and money are formatted by locale (`Intl`), not by string concatenation;
  dates the same way. A hard-coded format breaks on the first change of venue.

## Checks before hand-off

```bash
SK=~/.claude/skills/frontend-quality/scripts
bash  $SK/check-forbidden.sh src
node $SK/verify-ui.mjs         --config .uiverify.json
node $SK/verify-states.mjs     --url http://localhost:3000
node $SK/verify-tap.mjs        --url http://localhost:3000
node $SK/verify-regression.mjs --url http://localhost:3000
npm run lint && npm test && npm run test:e2e
```

If you touched lists, input or animation, add a measurement through a scenario:

```bash
node $SK/verify-perf.mjs --scenario ./e2e/scenarios/cart.mjs --throttle 20
```

Next: the `frontend-performance` skill for measuring smoothness, and
[checklist.md](checklist.md) for hand-off.
