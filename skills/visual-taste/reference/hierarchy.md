# Hierarchy, focus, scanning

Hierarchy is the only thing that separates an interface from a pile of elements.
Its absence cannot be cured with colour or animation.

## The two-second test

Open the finished screen and time it: **how long does it take the eye to find the
main thing?** More than two seconds means there is no hierarchy. Improving details
after that is pointless; the structure has to change.

A useful trick: squint (or blur the screenshot by 8–10px). Only patches of
different density remain. Whatever is still noticeable is the actual hierarchy. If
three things are noticeable at once, you have three, not one.

## One point of focus per screen

A screen has **one** job, and it reads first. Everything else is the second and
third level. Two "main" elements compete and cancel each other out: two large
buttons of equal weight side by side mean the choice was handed to the user
without explaining the difference.

Three levels is the working maximum:

1. **First**: what the screen was opened for (the total, the status, the primary
   action).
2. **Second**: what helps to decide (list rows, labels).
3. **Third**: the utility layer (metadata, timestamps, secondary links).

## What creates hierarchy, by strength

1. **Size** — the strongest and the bluntest instrument.
2. **Weight** — subtler, better for dense screens.
3. **Contrast** (light ↔ dark) — works even at small sizes.
4. **Colour** — for meaning only: accent, danger. As hierarchy it is weak.
5. **Position** — top and left (in left-to-right reading) weigh more.
6. **Air** — isolation makes an element prominent without a single extra pixel.

The rule: **one or two instruments per level.** Large plus bold plus coloured plus
boxed plus shadowed is not an accent, it is shouting.

## Scanning

People do not read an interface, they search it. It follows that:

- **What matters goes on the left** in a list row: the eye runs down the left edge
  and finds the name there, not in the second column.
- **Numbers align right** and use tabular figures: that way magnitudes compare,
  not string lengths.
- **Repeating structure**: if list rows are built the same way, the eye learns
  them in two rows and moves fast afterwards. Every exception is expensive and
  needs to be justified.
- **Group by proximity**, not by boxes. A box is one more line on the screen; air
  is free.

## Empty space

Emptiness is not "unused room", it is an instrument. But there are two kinds and
confusing them is not allowed:

- **Working emptiness**: margins, gaps between groups, air around the main thing.
  It makes structure visible.
- **A hole**: an empty grid cell, a gap under a heading, a dead centre on a wide
  screen. That is not minimalism, that is unfinished layout.

Telling them apart is easy: working emptiness is even and rhythmic, a hole is
random and lopsided. Automation cannot see this — only an eye on a full section
screenshot.

## Density to match the job

- **A working tool**: the person sees a lot and acts fast; dense, predictable, no
  decoration. Extra air here means less data on screen and more scrolling.
- **Promo and onboarding**: one thought per screen, large, with air. Density here
  reads as "complicated" and scares people off.

The same person in different roles expects different things — and that is about
the screen, not about the designer's taste.

## Common failures

- **Everything of equal importance**: flat grey text of one size across the screen.
- **A heading detached from its content**: more space below it than above.
- **An accent on the utility layer**: the creation timestamp larger than the total.
- **Monotony**: twelve identical cards in a row with nothing for the eye to hold
  on to. The cure is not decoration but differing importance: something has to be
  the main thing.
- **Competing actions**: "Send" and "Save draft" at equal weight. The secondary
  action is a text button, not a second primary one.
