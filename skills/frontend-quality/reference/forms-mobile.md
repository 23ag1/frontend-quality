# Forms, sheets and the keyboard on a phone

What to decide before writing a form or an overlay that a phone will open. Read it
together with [behaviour-laws.md](behaviour-laws.md): this file is that procedure
already run for the most expensive element class.

## Why

In one sign-in flow on a website the owner found the problems himself, one at a
time, over five rounds of review: the keyboard covering the field, Back leaving the
site instead of closing the form, autocorrect capitalising a nickname, an error
shown only as a line at the bottom, focus not moving between steps. Every one of
them is on the list below. Write the scenarios into the task **before** the code
and build them all at once, instead of waiting for the question "what else is
missing".

## 1. One geometry model, one writer of `transform`

The sheet position, the keyboard, the scroll and the bottom edge are one problem
seen from four sides. They are changed by **one model with one writer** of
`transform`.

- Two writers — a drag handler and a keyboard handler each setting `transform` —
  disagree for a frame whenever both fire: the keyboard opens during a drag and the
  sheet jumps.
- The model takes inputs (drag offset, snap position, keyboard inset, visual
  viewport) and computes one `transform`, written once per frame.

**The lifecycle matrix comes before the code.** Write down the axes and check the
build against the matrix, not against the one path you happened to test:

| Axis | Values |
|---|---|
| entry path | a tap on a row, from search, a direct link, restored after reload or Back |
| sheet position | closed, half, full |
| content | short (2 rows), long (40 rows) |
| keyboard | closed, open in the resize model, open in the overlay model |

That is 72 cells. Walk the cells where the code branches and mark the rest "same as
cell N" — out loud, in the task.

## 2. Two keyboard models

| Model | What happens | Who does it |
|---|---|---|
| **resize** (the window shrinks) | the layout viewport shrinks: `innerHeight` and `dvh` drop, fixed bottom bars ride above the keyboard | Chrome on Android before 108, Firefox on Android, any page with `interactive-widget=resizes-content` |
| **overlay** (the bottom is covered) | the layout viewport stays; only the visual viewport shrinks and may scroll; fixed bottom bars stay under the keyboard | Safari on iPhone, Chrome on Android 108+ by default |

Design for both; the fleet has both.

- **Measure in pixels without the keyboard, then freeze.** A sheet whose height is
  `dvh` shrinks with the keyboard in the resize model and its content jumps. Take
  the height in pixels when the sheet opens with the keyboard closed and do not
  re-measure while the keyboard is up.
- `lvh` and the "maximum" height jump together with the address bar on some
  browsers; do not take a maximum from them during a gesture.
- Things pinned to the bottom are positioned from `visualViewport`, not from the
  layout viewport:

```js
const vv = window.visualViewport;
const keyboardInset = () =>
  vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;

vv?.addEventListener('resize', onGeometry);   // onGeometry feeds the one model above
vv?.addEventListener('scroll', onGeometry);
```

In the resize model `innerHeight` drops too and the inset stays near 0 — correct,
the layout has already moved.

## 3. Form scenarios on a phone

The list for the task text. Each line is a decision, not an afterthought.

**Where it lives.**
- Phone: the form is a screen, like a page; the site beneath is hidden, not dimmed.
  Computer: a dialog or a side panel.
- On a website a bottom sheet reads as an app; on a phone use a page (law 16).

**How it closes.**
- A close button, a tap outside (computer), Esc, and **browser Back**.
- Back closes the overlay: push a history entry on open, close on `popstate`; the
  close button calls `history.back()` so the stack stays clean.

**Focus on open.**
- Phone: focus goes to the dialog, not into the first field. Focus in a field opens
  the keyboard at once, and in one form it closed the form it had just opened.
- Computer: the first field.

**The keyboard.**
- A tap on a field brings the field **with its label** to the top of the visible
  area.
- Enter means "next" (`enterKeyHint="next"`); on the last field it submits
  (`enterKeyHint="send"` or `"done"`).
- Moving between fields does not throw the scroll back to the top.
- When the keyboard closes, the scroll returns to where it was.

**The fields.**
- Type and autofill: `autocomplete="email"`, `"username"`, `"new-password"`,
  `"current-password"`, `"one-time-code"`.
- Nicknames, logins, emails and codes: `autocapitalize="off"`,
  `autocorrect="off"`, `spellcheck={false}`.
- Numbers: `inputMode="numeric"` (not `type="number"` for codes — it drops leading
  zeros and adds a spinner).
- An input below 16 px makes Safari on iPhone zoom the page on focus.
- A prefilled field that receives focus gets the caret at the end:
  `el.setSelectionRange(el.value.length, el.value.length)`.

**Steps and errors.**
- After a step is submitted, focus goes to the first field of the next step.
- An error moves focus and scroll to its field, not only a line at the bottom; the
  message is tied to the field with `aria-describedby`.
- While waiting for the answer the button is busy and a repeat does not leave.

**Return.**
- After closing, focus returns to the element that opened the form, and the scroll
  position is where it was.
- Reduced motion: the same transitions, without the smoothness.
- Rotation with the keyboard up, and the password manager bar above the keyboard,
  which takes another 40–50 px.

## 4. Focus on iPhone

- **The keyboard opens only from a focus inside the same tap.** `focus()` after an
  `await` or a `setTimeout` focuses the field and shows no keyboard. Focus
  synchronously in the tap handler.
- **A field under a `transform` at the moment of focus makes iOS scroll the page**
  to where it thinks the field is, and the screen jumps. Start lifting the panel on
  the touch itself (`pointerdown` on the field), so that by the time focus lands the
  field is already in place.
- **Safari may show a layer in its end position for one frame** at the start of a
  transition. Set the start state, let one frame pass (`requestAnimationFrame`),
  then set the end state.

## 5. The bottom edge and the scroll

- `env(safe-area-inset-bottom)` is **0 without `viewport-fit=cover`** in the
  viewport meta. With `cover` the padding is yours to add:
  `padding-bottom: max(12px, env(safe-area-inset-bottom))`.
- **Safari has no scroll anchoring.** When a block above the viewport collapses,
  Chrome keeps the visible content in place; Safari leaves a hole and the content
  jumps. Collapse only what is below the fold, or correct `scrollTop` by the
  measured difference in the same frame.

## 6. A global switch needs a list of everything it changes

The viewport meta, `interactive-widget`, the height of `html`/`body` and the root
`overflow` touch every screen. Switching `interactive-widget=resizes-content` to fix
one form changes what `dvh` means on every screen while the keyboard is up, moves
every fixed bottom bar and every sheet.

A local problem is solved locally. A global switch is made only with a written
list of everything it changes and a check of each item on that list.

## 7. How it is checked

```bash
SK=~/.claude/skills/frontend-quality/scripts
node $SK/verify-keyboard.mjs --scenario ./e2e/scenarios/checkout.mjs
node $SK/verify-keyboard.mjs --scenario ./e2e/scenarios/checkout.mjs --models resize,overlay --width 320 --height 568
```

`verify-keyboard.mjs` emulates a keyboard of about 45% of the screen in both models:
resize by shrinking the viewport, overlay by substituting the `visualViewport`
height and offset. For every field and model it blocks when the focused field is
not fully inside the area above the keyboard, when a tap on a button inside the same
sheet takes focus off the field (on a phone the keyboard closes and the sheet
jumps — the WebKit `pointerdown` trap from [browser-floor.md](browser-floor.md)), and
when that tap changes the sheet height by more than 2 px. It flags scroll chaining
from an overlay into the page, and a history Back that does not close the overlay.
The fields come from the scenario's `keyboardTargets` (how to open the sheet, which
field, which container). Run it over the cells of the lifecycle matrix, not one.

**What needs a real device**, and why emulation cannot replace it:

- the keyboard animation: the viewport changes over about 250 ms, not in one step;
- the iPhone rule "keyboard only from focus inside the tap" and the scroll iOS makes
  to the focused field on its own terms;
- the suggestion, autocorrect and password bar above the keyboard, and third-party
  keyboards with their own heights;
- an installed web app in standalone mode, which resizes differently;
- Safari's one-frame flash at the start of a transition;
- rubber-band scrolling, the address bar collapsing, rotation with the keyboard open.

Name these in the report as "needs a device", each with its reason — not as "not
checked".
