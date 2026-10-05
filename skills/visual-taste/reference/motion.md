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

The height of an expanding block is the most common temptation. In order of
preference: animate a wrapper with `transform` and compensate inside, or
`clip-path`, or open instantly. `grid-template-rows: 0fr → 1fr` is often recommended
and **breaks the rule above**: it runs layout on every frame. It is tolerable for a
single small block on a promo page, not for rows in a list or anything on a weak
phone. It also needs Chrome 107 and Safari 16 — below that the block jumps open
without a transition (the browser floor is in the `frontend-quality` skill,
`reference/browser-floor.md`). Details and budgets live in the
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

That threshold is for wait indicators, not for the answer to a press. **The press
itself answers in the first frame**, even while the network is pending: the tapped
tile shows its pressed state and a small loading mark on itself, at once. A tile
that shows nothing for 400 ms gets tapped again, and the second tap becomes a
duplicate. The full-screen skeleton or spinner still waits for its 200 ms.

## Animate only what the person caused and can see

- **Only what the person caused.** A toast sliding in on every background poll, a
  row flashing on every data refresh — motion nobody asked for. Fresh data replaces
  the old quietly; nothing moves on its own.
- **Only what is visible.** A staggered entrance ("fan-out") written for a demo of
  three items ran over 47 real ones: the last card arrived about two seconds later,
  off screen, and the list kept moving under the reader. Stagger only the items in
  the viewport, cap the total spread (about 150–200 ms however many there are),
  and count each item's offset from the anchor of the motion, not from its index in
  the whole list. Test on the real volume, not three items.
- **Nothing remounts at the end.** A node recreated when the animation commits
  flickers for one frame — keep keys stable.

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
