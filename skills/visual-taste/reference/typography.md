# Typography

Text is 95% of an interface. Mistakes here are the most visible and the cheapest
to fix — if you catch them before the code.

## Choosing a typeface

**Character first, catalogue second.** Three concrete words about the product and
the physical object it resembles (see the skill body), and only then browsing a
library with that object in mind.

**Anti-reflexes worth knowing about yourself:**

- a technical product does **not** need serifs "for warmth" — a tool should look
  like a tool;
- "premium" does **not** equal the expressive serif everyone is using right now:
  premium can be a Swiss grotesque, and it can be a monospace;
- a children's product does **not** have to be a rounded display face: children's
  books are set in real type;
- "modern" does **not** mean a geometric sans. The most modern decision available
  is not taking the typeface everyone else takes.

**System fonts are underrated.** `system-ui` loads instantly, looks native on
every platform and reads well. For a working tool, where speed and familiarity
matter more than personality, that is often the best choice rather than a
compromise.

**You usually do not need a second family.** One family in several weights gives
a cleaner hierarchy than two competing typefaces. A second face is for genuine
contrast (display headings against a text serif), and the contrast must run along
several axes at once: serif against sans, geometric against humanist, narrow
against wide. Two similar grotesques are the worst pairing of all: tension
without hierarchy.

## The scale

A common mistake is many close sizes: 14, 15, 16, 18. The hierarchy comes out
muddy.

**Fewer sizes, more contrast between them.** Five to seven roles cover nearly
everything:

| Role | Typical | Where |
|---|---|---|
| Caption | 12 | labels, metadata |
| Body-sm | 14 | body text in a dense interface |
| Body | 16 | body text |
| Headline | 18–20 | section heading, dialog title |
| Title | 24–28 | screen title |
| Display | 36+ | hero, large numbers |

The scale is built by ratio: size = base × ratio^step. Use 1.125–1.2 for dense
interfaces, 1.25–1.333 for marketing. Pick one and stay with it.

**The minimum in an interface is 12px.** Anything smaller reads badly even on a
good screen and fails accessibility on a phone. Set sizes in `rem` so user
settings are respected.

**Fluid size (`clamp`) is for headings on marketing pages.** In a product
interface use a fixed scale with breakpoint adjustments: no serious product design
system uses fluid typography, because layout needs predictability. Body text is
always fixed — the difference across widths is too small to justify the movement.

## Line height

Not one multiplier for everything, but ranges:

| Size | Line height |
|---|---|
| captions 12–14 | 1.25–1.5 |
| body 16–18 | 1.4–1.65 |
| headings >24 | 1.15–1.3 |

Two rules people forget:

- **Light text on a dark background** reads thinner — add 0.05–0.1 to the usual
  value.
- **Line height depends on measure**: a narrow column wants it tighter, a wide
  one wants more air.

**Vertical rhythm.** The line height of body text is the base unit for every
vertical space. Body 16px × 1.5 = 24px, so spacing values are multiples of 24 (or
half of it). Text and air then live in the same arithmetic, and it shows even to
people who cannot say why.

## Tracking

- caps and small labels: +0.05…+0.08em (otherwise letters clot);
- headings above 36px: −0.02…−0.03em (otherwise they fall apart);
- body: 0, leave it alone.

## Measure

65–75 characters. Shorter and the eye jumps; longer and it loses the line. In CSS
that is `max-width: 65ch`, not a hand-picked pixel value.

## Numbers and tables

- Figures in columns are tabular: `font-variant-numeric: tabular-nums`. Without it
  numbers dance on every update and the column looks jittery.
- Format money and dates through `Intl`, not by string concatenation: otherwise
  the first other language or currency breaks the look.

## Font loading

The font arrives after the markup, text reflows, the layout jumps. That is both
CLS and needless layout work.

```css
@font-face {
  font-family: 'Brand';
  src: url('brand.woff2') format('woff2');
  font-display: swap;            /* text is visible immediately in the fallback */
}

/* The fallback is matched by metrics so the swap does not move lines. */
@font-face {
  font-family: 'Brand-fallback';
  src: local('Arial');
  size-adjust: 105%;
  ascent-override: 90%;
  descent-override: 20%;
}

body { font-family: 'Brand', 'Brand-fallback', system-ui, sans-serif; }
```

Load exactly the weights you use. Three weights are three files; "just in case"
costs kilobytes and first-screen delay.

## What not to do

- More than two or three families per project.
- A display face for body text.
- Disabling zoom (`user-scalable=no`). If the layout breaks at 200%, fix the
  layout instead of forbidding the zoom.
- Body sizes in pixels: the user's font setting stops working.
