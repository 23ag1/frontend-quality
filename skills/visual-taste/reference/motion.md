# Motion

Animation in an interface exists for one reason: to explain **where something came
from and where it went**. All other movement is delay that the user pays for on
every action.

## The roles of motion

| Role | Example | Duration |
|---|---|---|
| Feedback on touch | a button press, a row responding | 80–120 ms |
| A small thing appearing or leaving | a tooltip, a toast, a menu | 150–200 ms |
| A large surface transition | a sheet, a modal, a screen | 200–300 ms |
| A list rearranging | insert, delete, sort | 200–250 ms |
| A meaningful accent | highlighting a changed number | 300–500 ms, once |

The numbers are not absolute, but the ordering matters: **the larger the surface,
the longer it takes**, and anything over 300 ms in a working tool is perceived as
lag. On a promo page the ceiling is higher, but even there 500 ms is an event, not
a transition.

## Curves

- **Entering** — decelerate at the end (`ease-out`): the object flies in fast and
  settles softly.
- **Leaving** — accelerate (`ease-in`): it does not hold attention.
- **Moving within the screen** — `ease-in-out`.
- **Linear** — only for indefinite indicators (a spinner).
- A spring fits where an object is "physical": a sheet dragged by a finger.
  Elsewhere it adds time without meaning.

## What may be animated

Only `transform` and `opacity`. Those two are handled by the compositor without
running layout or paint. `height`, `top`, `width`, `filter` on every frame mean
layout work — that is, jank on a weak phone.

The height of an expanding block is the most common temptation. The options:
`grid-template-rows: 0fr → 1fr`, `clip-path`, or animating a wrapper with
`transform` and compensating inside. Details and budgets live in the
`frontend-performance` skill.

## Respecting "reduce motion"

The system `prefers-reduced-motion` setting is not a recommendation: for some
people motion causes physical illness.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Importantly, **the meaning of the transition must survive**. A sheet does not
teleport — it appears instantly, but it is still visibly a sheet. This is checked
automatically: `verify-motion.mjs` opens the page with the setting on and fails the
check if infinite animations keep running.

## Interruptibility

An animation must be interruptible. The person pressed again — the new state
starts from the current point, not after the old one finishes playing. An
interface that "finishes playing" feels less responsive than a slow one.

Hence the rule: **never finish an animation by timer**. The timer and the real
end diverge, and you get a jolt at the end. Finish on `transitionend` /
`animationend`, and keep element keys stable so the node is not recreated at the
moment of commit.

Interrupted animations are a measurable defect: the browser fires
`animationcancel` and `transitioncancel`. An audit counts the finished ones
against the aborted ones.

## Motion as feedback

Up to 100 ms feels instant. Between 100 and 300 ms it is noticeable but tolerable.
Longer than that needs an explicit answer: a changed button state, a loading
skeleton, progress.

An important subtlety: **do not show a wait shorter than ~200 ms**. An indicator
that flashes and disappears reads as a glitch, not as speed.

## Anti-patterns

- **Animation for "liveliness"**: elements sliding in on every scroll. The second
  time it annoys, the tenth it enrages.
- **Long transitions in a working tool**: someone performs a hundred actions per
  shift; 400 ms each is minutes per shift.
- **Motion that cannot be skipped**: a splash screen, a mandatory wait.
- **Different durations for transitions of the same meaning**: the motion system
  should be as narrow as the palette — three or four durations for the whole
  product.
- **Animating what is already obvious**: highlighting every row on every data
  update turns the screen into a string of fairy lights.
