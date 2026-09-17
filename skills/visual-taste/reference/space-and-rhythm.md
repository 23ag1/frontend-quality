# Spacing, rhythm, proportions

Air is the cheapest instrument of hierarchy and the most underrated one. Most of
"it looks off and I cannot say why" is about spacing, not colour.

## The grid

Every spacing value is a multiple of a base step. **8px** for ordinary interfaces
and marketing, **4px** for dense working screens where a lot has to be visible.

Half values (2, 6, 10, 14) break the system: they appear when something was
adjusted by eye, and they spread from there. In Tailwind that means whole classes:
`p-2`, `p-3`, `p-4`; `p-2.5` and `gap-1.5` are off the grid.

The set of radii is finite too: usually 8 / 12 / 16 and a full pill. An arbitrary
`[10px]` is the same eyeballing.

**A nested radius ≈ the outer radius − the inset.** Otherwise the inner element
pokes out as a rectangle from a rounded backing. And a separate trap: never take a
radius from a mock for an element that has no fill there and then give it your own
background — in the mock the corner is invisible, with a fill it shows.

## The rhythm of headings

Space above a heading is 2–3 paragraph spaces, below it 0.5–0.75. This single
move instantly turns "a list of text" into a structure: the heading belongs to
what is under it, not to what is above.

The general principle is that **proximity means connection**. Elements of one
group sit closer to each other than to the next group. If the distances are equal,
the user invents their own grouping, and almost certainly the wrong one.

## Vertical rhythm

The base unit is the line height of body text (see `typography.md`). Body 16px ×
1.5 = 24px, so vertical spacing is a multiple of 24 or 12. Text and gaps then live
in the same arithmetic and the page "adds up" without explanation.

## Proportions instead of pixels

A mock is drawn at one particular width — that is a proportion, not an absolute.

- Sizes inside a block are fractions of it: `cqw` with `container-type`, or
  percentages with `aspect-ratio`.
- The blocks themselves use the same fractions but with a limiter: `min()`,
  `clamp()`. Without one the section bloats on a wide screen and overflows on a
  narrow one.
- Small text and touch targets get lower bounds in absolute units: a proportion
  must not shrink them below legibility.

## Density is a decision, not an accident

A dense screen (a point of sale, a table, a dashboard) and an airy one (promo,
onboarding) need different values, and mixing them inside one product without a
reason is not allowed. Decide once and write it down: "working screens use step 4,
marketing uses 8".

Density is not crowding: even in the densest interface there is air between
meaningful groups, otherwise the eye cannot find the edges.

## What breaks most often

- **Tuning `min-height` to the current text.** It works until the first content
  change. Height must come from structure: all states in one grid cell, the
  container sized for the maximum.
- **`1fr` where the content differs in length.** Columns equalise and a short word
  floats in a third of the screen. Steps, chains and rows with arrows are laid out
  by content (`flex` plus a single `gap`).
- **Neighbouring cards of different heights.** Align with `subgrid`, not by
  setting a height to fit today's text.
- **Negative margins used to "widen" an element.** They move it, they do not widen
  it: the box stays the same and so does the target.
- **A fixed height on variable content.** Only `min-height`, otherwise the extra
  is silently cut off.

Detailed teardowns of these cases live in the `frontend-quality` skill,
`reference/layout-lessons.md`.

## How it gets checked

Rhythm and grid are checked with numbers, not impressions: identical elements must
match in height, radius and spacing, and the spread between states of a toggle
must be zero at every width.

```bash
node ~/.claude/skills/frontend-quality/scripts/verify-ui.mjs --config .uiverify.json
bash  ~/.claude/skills/frontend-quality/scripts/check-forbidden.sh .
```
