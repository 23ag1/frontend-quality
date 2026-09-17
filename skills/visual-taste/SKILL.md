---
name: visual-taste
description: Visual decisions and taste — how to choose typography, colour, rhythm, hierarchy and motion so the result does not look averaged. The signs of statistically average design and the way out of it, a narrow decision vocabulary, and how to state a product's character. Use when building a new screen or page, redesigning, choosing fonts and palettes, or when the result "looks like everything else" and it is unclear why.
user-invocable: true
argument-hint: "[shape|review|vocabulary]"
---

# Taste: how visual decisions get made

Taste is not an innate sense. It is two skills: a **narrow vocabulary** (few
decisions, each one justified) and a **trained eye** (you have seen a lot of good
work and taken it apart to find out why it is good). Both are acquired, and both
can be checked.

This skill is about the decisions taken before the code. Mechanical checks live
in the `frontend-quality` skill, speed in `frontend-performance`.

## The main danger: a statistically average result

Without the context of a project, any model — and any person working on autopilot
— produces the average of everything they have seen. You can recognise it by a
set of signs:

- a dark theme with a purple-blue gradient; frosted glass over everything;
- a centred hero: a pill badge, a huge heading, two buttons, a screenshot at an
  angle;
- a grid of identical cards with an emoji icon, a title and three lines of text;
- Inter, Roboto, Open Sans, Montserrat — "neutral" and therefore faceless;
- a 12px radius on everything, the same soft shadow on every element;
- the words "Seamless", "Effortless", "Powerful", "Everything in one place".

None of these is a sin on its own. The trouble is that they arrive **together and
by default** — that is not a style, that is the absence of a decision.

**There is one way out: the decision has to be made, not to happen.** The order
below forces that.

## Order of work

### 1. Character in words, not in categories

"Modern", "minimal", "premium" are dead categories: anything fits them. What you
need is three **concrete** words about the product's character: "warm, mechanical,
opinionated"; "calm, clinical, careful"; "fast, dense, unimpressed".

Then a trick that turns words into material: **imagine the product as a physical
object.** A typewriter ribbon. A hand-painted shop sign. A 1979 mainframe manual.
A fabric label inside a coat. A museum caption. A tax form. The object points at
the typeface, the palette and the density far more precisely than adjectives do.

That is what `.impeccable.md` holds: audience, scenarios, three words, the object.
No file — get the answers from whoever owns the product; do not invent them.

### 2. One strong move

What separates made work from assembled work is **one** move taken to a polish,
with everything else deliberately quiet. A custom cursor, magnetic buttons,
parallax, shattering text and a shader background all at once are not five moves,
they are zero.

In a product interface the "move" is not an effect but a **decision**: how status
is shown, the rhythm of a dense table, how a list behaves under the finger.
Everything else is a calm background for work.

### 3. A narrow vocabulary

Systematic work gets by on very little: **five to seven type sizes, about ten
spacing values, three or four radii, two or three shadows, six to eight colour
roles.** A spread of twenty-odd is a reliable sign that decisions were made one at
a time.

This is the only part of taste that can be measured — and it is measured:

```bash
node ~/.claude/skills/frontend-quality/scripts/verify-vocabulary.mjs --url <address>
```

The check counts how many **different** values are actually in use: sizes,
weights, line heights, spacing, radii, shadows, colours, durations. It also shows
the tail — the values that occur exactly once, which are almost always the ones
that were eyeballed. The conclusion from a wide vocabulary is always the same:
shrink to a set instead of adding one more value.

### 4. Teardowns instead of inspiration

Three to five concrete pieces of work, taken apart on the merits: which decisions
were made, what holds the sense of quality together, what transfers and what
belongs only to that project. Copying is not allowed — that is an exercise, not
work.

## Where to go next

| Decision | File |
|---|---|
| Typeface, scale, line height, measure | [reference/typography.md](reference/typography.md) |
| Palette, colour roles, contrast, dark theme | [reference/color.md](reference/color.md) |
| Spacing, rhythm, grid, proportions | [reference/space-and-rhythm.md](reference/space-and-rhythm.md) |
| Hierarchy, focus, density, scanning | [reference/hierarchy.md](reference/hierarchy.md) |
| Motion: roles, durations, curves | [reference/motion.md](reference/motion.md) |
| Interface copy | [reference/ux-writing.md](reference/ux-writing.md) |

## How taste gets checked

Some decisions are measured, some can only be seen. Confusing the two is not
allowed.

**Measured** (the `frontend-quality` skill): contrast in every state, the rhythm
of spacing, adherence to the grid, absence of overlaps, target sizes, how narrow
the token vocabulary is.

**Seen, because formally everything is fine:** an empty cell, columns of
different heights, a hole under a heading, the monotony of identical blocks, a
dead centre of the screen, colour drifting into "cheerful". For that, a finished
section is captured **whole** and looked at, not cropped to the bit you fixed.

**A separate move is independent acceptance.** The `ui-verifier` agent never saw
the reasoning behind the result and judges what was made, not what was intended.
Call it once before hand-off, not after every edit.

## Three questions before hand-off

1. **What is the main thing here?** If the point of focus is not visible within
   two seconds, there is no hierarchy, and no amount of polish will fix that.
2. **Why exactly this way?** Every decision needs a reason shorter than one
   sentence: "dense, because the person works standing up and needs the whole
   floor on screen". No reason means it is not a decision, it is a habit.
3. **What did I remove?** Work is finished not when there is nothing left to add
   but when there is nothing left to take away. If nothing was deleted along the
   way, you are not done.
