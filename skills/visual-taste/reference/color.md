# Colour and contrast

Colour in an interface carries meaning, not mood. Every shade has to answer the
question "what does it tell the user"; otherwise it is decoration that gets in the
way of reading.

## Roles, not shades

A palette is described by roles, not by colour names. The minimum working set:

| Role | What it means |
|---|---|
| surface | screen and card background |
| text primary | headings, significant numbers |
| text secondary | explanations, metadata |
| text muted | hints, inactive items |
| border | dividers, outlines |
| accent | action, link, selection |
| danger | deletion, refusal, overdue |
| success / warning | when needed, not "because we can" |

Tokens are named by role (`--text-muted`), not by value (`--gray-500`): the value
will change one day and a name like `--gray-500: #7a7a80` starts lying.

Six to eight roles cover a product interface. If a palette holds twenty shades,
some of them appeared by eye and live in exactly one place.

## Build the scale in OKLCH, not HSL

HSL deceives: the same lightness looks different in yellow and in blue. OKLCH is
perceptually uniform — equal steps in lightness look equal.

```css
--accent-500: oklch(62% 0.16 255);
--accent-600: oklch(54% 0.15 255);  /* lower lightness, slightly lower chroma */
--accent-700: oklch(46% 0.13 255);
```

The rule for building it: hold the hue, vary the lightness — and **reduce chroma
towards the extremes**. High chroma next to white or black looks toxic.

## Contrast: what actually gets checked

- Text — 4.5:1; large text (24px and up, or 18.66px bold) — 3:1.
- Borders of interactive elements and meaningful icons — 3:1.
- **Check in every state**, not only at rest: a muted hover, a grey disabled, text
  on a selected row. That is exactly where contrast fails, and tools that measure
  a static page never see it.

```bash
node ~/.claude/skills/frontend-quality/scripts/verify-states.mjs --url <address>
```

Text over an image or a gradient resists automation: it needs a scrim with a
measurable opacity, and a look with your own eyes.

## A dark theme is not an inversion

A finished light theme cannot simply be flipped:

- pure black (`#000`) with pure white text produces halation and hurts; use a very
  dark neutral (12–18% lightness) with text at 90–95%;
- shadows barely work in the dark — depth comes from borders and differences in
  surface lightness;
- saturated colours look brighter in the dark: the accent usually needs toning
  down;
- light text reads thinner — either slightly more line height or a slightly
  heavier weight.

If a dark theme is claimed, it gets checked in full: states, contrast, shadows,
screenshots. Half a dark theme is worse than none.

## Colour with meaning

- **Never the only carrier of meaning.** A red row without an icon and a word is
  invisible to colour-blind users and in bright sunlight on a phone. Colour plus
  shape plus word.
- Keep status colours in one vocabulary across the product: if "ready" is green on
  one screen and blue on another, that is not style, it is a bug.
- Colour a dangerous action where it is performed, not everywhere it is mentioned.

## Common mistakes

- **A gradient instead of a decision.** A purple-blue gradient on the hero is the
  first sign that the character was never stated.
- **A shadow on everything.** A shadow is height above a surface. If everything is
  raised, there is no hierarchy. Two or three shadow levels, each with a meaning.
- **Pure grey on a coloured background.** Neutral text over a tinted surface looks
  dirty: mix the background hue into the neutral.
- **Colour instead of density.** When a screen is overloaded, air and order save it
  more often than tinting blocks.
- **Raw HEX in markup.** Tokens exist precisely so a colour changes in one place;
  `check-forbidden.sh` catches this.
