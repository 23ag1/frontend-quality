# Layout teardowns

Collected from real failures. Each entry: symptom → cause → fix → what checks it.

## A toggle changes the size of the section

**Symptom.** Tabs, an accordion, a slider or a filter swap the content and the
section jumps. At the width you built it on it may look level; at 1024, 1512 and on
mobile it shifts by 20px.

**Cause.** The variants have different text lengths: two rows in one, one in the
other.

**The fix is structural, not a tweak.** All states go into one grid cell (`grid`,
every child on `col-start-1 row-start-1`), the inactive ones get `invisible` and
`aria-hidden`. The container is always as tall as the longest variant. A
hand-picked `min-height` is banned — it breaks on the first content change.

**Verification.** Cycle through every state at 390 / 768 / 1024 / 1152 / 1280 /
1440 / 1512 / 1600 / 1920 and compare the section height as a number. The allowed
spread is 0px.

## A grid container jumps when the data changes

**Cause.** The container was drawn for today's content instead of for the maximum.
Some months have five weeks, some have six.

**Fix.** Draw for the maximum: a calendar always takes six rows. Build the height
limit together with the inner padding, otherwise the labels hit the edge. A hard
`height` on variable content is banned — only `min-height`: a hard height does not
hold the layout, it silently cuts the excess off.

## A row with arrows: a short word floating in a third of the screen

**Cause.** A `grid-cols-[1fr_auto_1fr_auto_1fr]` template was taken "because that
is how it is done". The cells hold 14 and 36 characters of text, and `1fr`
equalised the columns.

**Fix.** Steps, chains and rows with arrows are laid out by content (`flex` plus a
single `gap`). `1fr` is only for content of comparable size.

## Mismatched rows in neighbouring cards

**The symptom-treating cause.** Picking a `min-height` (43px, then 64px). As soon as
a heading became one line, a hole appeared.

**Fix.** Align rows of neighbouring cards with `subgrid` (`grid-rows-subgrid` plus
`row-span-N` on the card), not with a height fitted to today's text.

## Neighbouring columns of different heights, empty space below

**Cause.** The column with tabs is as tall as its content, the panel beside it is
as tall as its own; nothing connects them.

**Fix.** Connect them explicitly: `lg:h-full` plus stretching the children, or one
grid covering both columns.

## Nested radii poking out as rectangles

**Rule.** The inner radius ≈ the outer radius − the inset, or a full pill.

**Trap.** Never take a radius from a mock for an element that has NO fill there and
then add your own background: in the mock the corner is invisible, with a fill it
pokes out as a rectangle inside a round backing.

## A state that is not in the mock

Added hover, active, focus or disabled — you are obliged to verify it with a
screenshot. A state reveals what a static mock hides: radii, borders, shadows,
contrast.

## A silently broken style branch

**Symptom.** An element lost its styling and there are no console errors.

**Cause.** The value being compared against changed: a path `/x` → `/x/`, a renamed
key or variant. The condition stopped matching.

**Rule.** Changed a value — recheck every comparison against it. Search
exhaustively: `grep` for the old value.

## The bottom edge on a phone

The layout viewport on a phone is taller than the visible one: the browser chrome
and the keyboard cover it from below.

- Anything pinned to the bottom (`position: fixed; bottom: 0`) is measured from
  `visualViewport`, not from the layout viewport. Otherwise the sheet slides under
  the browser bar and the input field under the keyboard.
- Height is `dvh`, never `vh`, always with a ceiling and internal scrolling: if
  something eats space from below, the content compresses instead of being cut off.
- Found a fix for one case — apply it to all the similar ones at once. The keyboard
  and the browser bar are one trouble from two sides.

## False positives in overlap detection

A large `line-height` inflates the box while the glyphs never collide. The script
uses a 4px tolerance, but suspicious pairs are still worth looking at as crops.

Distinguish two different cases, which are easy to confuse:

1. overflowing the parent or the screen;
2. a pairwise overlap between boxes of neighbouring elements.

The second is only caught by walking the pairs of text leaves, and it shows up at
intermediate widths (1280–1728) rather than at 1920.

## Why such defects appear

The root cause, not the symptoms:

- **Measured instead of looking.** Overflow and overlap checks catch accidents but
  not an empty cell, columns of different heights or a hole under a heading —
  formally everything is fine there. A report saying "0 violations" can be true for
  the checks and have nothing to do with the quality of the layout.
- **A template instead of the content.** The layout is chosen by habit rather than
  by what is inside it.
- **Tuning a number instead of the structure.** A `min-height` fitted to today's
  text breaks on the first content change.
- **A written rule that is never checked does not work.** A ban must be a line in
  `check-forbidden.sh`, not a paragraph in an instruction.
