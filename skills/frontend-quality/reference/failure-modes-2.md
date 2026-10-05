# Failure modes, part 2

Entries 15–48 of the catalogue. Entries 1–14, where the catalogue came from and
how to use it are in [failure-modes.md](failure-modes.md). Same format:
**symptom → the real cause → how to fix it → what catches it.**

These come from one month of a production app (a restaurant point-of-sale app used
on staff phones, several of them old Android devices): about 750 fix commits and
295 fixes classified by cause.

---

# Touch and gestures

Continues [1. The tap disappears or fires twice](failure-modes.md#1-the-tap-disappears-or-fires-twice).

## 15. The list changes between press and release

**Symptom.** The user taps one dish and a different one lands in the order. A tap
on a category opens its neighbour. Rare, and impossible to reproduce on purpose.

**Cause.** The list changed under the finger: search results caught up with typing,
a filter switched, a response arrived. The grid was keyed by index — the same node
now showed another category. Keying by id did not save it either: Chromium sends a
touch's `click` to the new element under the finger. The first version assumed a
static list; a later feature made it changeable and kept the index key. No check
"pressed and released on the same thing" ever existed.

**Fix.** Keys from data only. One document-level `pointerdown` listener records the
item under the finger (key plus the value it shows, and the items within the touch
radius); an item accepts `click` only if it is the same item with the same value.
Keyboard and programmatic clicks skip the check — see 24 on telling them apart.

**What catches it.** `verify-tap.mjs --gestures`: DOM mutations between touch and
release (FLAG), a click landing on another node (BLOCK). `verify-races.mjs` with
reordered responses makes the list change mid-tap.

---

## 16. The tap right after a swipe is lost

**Symptom.** A row is swiped to reveal "Delete"; an immediate tap on it does
nothing. The second tap works.

**Cause.** The finger left the row with momentum. For about 200 ms the browser
treats the next touch as "stop the fling": `touchend` arrives, `click` is never
synthesised. Measured on a production build: taps 30–180 ms after the swipe sent
no request; at 200 ms and later, or with the finger paused before lifting, they did.

**Fix.** Buttons revealed by a swipe act on `touchend` (short, finger stationary,
started on the button), and `preventDefault` on that `touchend` suppresses the late
click — one press, one action. A press longer than the long-press threshold does
not fire.

**What catches it.** `verify-tap.mjs --gestures`: swipe, then tap within 200 ms.

---

## 17. The hold leaks into the element that replaced it

**Symptom.** Holding a card replaces the strip with similar items; without lifting
the finger, a second hold fires on the card that appeared under it.

**Cause.** The hold handler replaced the content under the finger, and the tail of
the same gesture went to whatever is under the finger now. The trailing `click` had
been suppressed long before; the `contextmenu` that Android fires on its own at
about 0.5 s had not — the same class, a second instance.

**Fix.** A hold consumes all of its tails at document level, in one shared hook:
`click`, `contextmenu`, the trailing `touchend`. A `contextmenu` from touch
(`pointerType` touch, `sourceCapabilities.firesTouchEvents`, or a touch in the last
few seconds) is never a new hold; a right mouse click still is.

**What catches it.** `verify-tap.mjs --gestures`: hold, then the contextmenu
retarget after the hold.

---

## 18. `preventDefault` on `pointerdown` swallows the click in WebKit

**Symptom.** Tapping "+" in a quantity dialog closed the keyboard, the visible area
grew, the dialog dropped and the second tap missed. The first fix cancelled
`pointerdown` — fine in Chromium, but in Safari the dialog's buttons stopped
responding at all.

**Cause.** Focus moves in the default action of `mousedown`. In WebKit, cancelling
the `pointerdown` of a touch also cancels its `click`.

**Fix.** `preventDefault` on `mousedown` only: focus stays in the field and the
click survives. Apply it to the dialog's controls (or as an option of the sheet),
not globally.

**What catches it.** `verify-tap.mjs --gestures` under `FQ_BROWSER=webkit`: a tap
that produces no click. Whether focus stayed in the field — review by hand.

---

## 19. Nothing happens on the first frame of a tap

**Symptom.** "The options open with a delay." A tap on a dish waits about a second
for the network and nothing on the screen changes in that time. A second tap on the
same dish is instant — the data is cached.

**Cause.** The first visible change was the dialog, which waits for the response.
Opening it early was not possible: the list does not know whether a dish has
options, and an empty dialog would flash and close.

**Fix.** The pressed element reacts in the first frame: a busy ring on that tile
(`aria-busy`) shows the tap registered and on which item; the dialog opens when the
data arrives. Busy state belongs to the element, not to a global spinner.

**What catches it.** No automation — review by hand: delay the response (as
`verify-races.mjs` does) and look at the frame right after the tap — the pressed
element must already have changed.

---

## 20. Two rows open at once

**Symptom.** Swiping row 1 reveals its buttons. Swiping row 2 reveals its own — and
row 1 still shows its buttons.

**Cause.** Each row kept its own "open" flag. A mutually exclusive state stored per
instance can never be exclusive.

**Fix.** One shared marker "which row is open" (a module store or context). As soon
as a gesture on another row is recognised as horizontal, the previous one closes —
in both swipe directions.

**What catches it.** No automation — review by hand: an `open` or `expanded` flag
in each row's own state where only one may be open. In e2e: swipe two rows in turn,
only the second stays shifted.

---

## 21. A system dialog in the middle of the product

**Symptom.** Deleting asks for confirmation in the browser's own dialog: the site
address in the title, system buttons, no theme. The owner asked for it "inside the
site".

**Cause.** `window.confirm` is one line and the confirmation was added in a hurry.
It also blocks the page, ignores the theme, can be suppressed by the browser
("prevent this page from creating additional dialogs") and looks foreign in an
installed web app.

**Fix.** The project's own dialog: the action named on the button ("Delete
campaign"), destructive colour, focus on the safe choice.

**What catches it.** No automation — review by hand:
`grep -rnE '(window\.)?(confirm|alert|prompt)\(' src`.

---

# Old browsers

A framework's default build target is not your users' floor. One framework builds
for Chrome 111 / Safari 16.4 by default; a quarter of this app's traffic came from
a phone model stuck on Chrome 106 (no store updates), and no test ran on that
engine. Take the floor from server logs, write it into `browserslist`, and run the
scenarios once on the oldest engine: `FQ_BROWSER=chromium FQ_CHROME_PATH=…` with a
build fetched by `scripts/fetch-chromium.sh <major>`, and `FQ_BROWSER=webkit`.

## 22. A viewport unit the browser does not know

**Symptom.** On one phone a half-height sheet is 170 px instead of 338, a
full-height sheet sticks to the top of the screen and `max-height` caps do nothing.
Every developer device is fine.

**Cause.** Chrome before 108 does not know `dvh`, `svh`, `lvh` and drops the whole
declaration; the element falls back to content height. The obvious fallbacks fail
too: a `height: 100vh; height: 100dvh` pair gets collapsed by minifiers into the
last line alone; `calc(100dvh - 56px)` is accepted by Chrome 106 and resolves to
`auto`; a bare `100vh` on Android is the height with the address bar hidden —
taller than the visible area.

**Fix.** One form: `height: var(--app-h, 100dvh)`, and
`calc(var(--app-h, 100dvh) - 56px)` for arithmetic. A script in `<head>` sets
`--app-h` from `window.innerHeight` (or `visualViewport.height`) only where
`CSS.supports('height', '100dvh')` is false, and updates it on resize. Utility
classes such as `h-dvh` go behind `@supports (height: 100dvh)` with that variable
outside.

**What catches it.** `check-forbidden.sh`: a bare `dvh`/`svh`/`lvh`, or `calc()`
built on them (BLOCK); the same unit as a `var()` fallback passes.
`check-browser-floor.mjs` for the rest of the CSS above the floor.

---

## 23. A newer API kills the request before it leaves

**Symptom.** On older devices the app is empty: no list, no error. On another
browser one card always says "Could not load details" while every other request
works; server logs show zero requests to that route from that browser.

**Cause.** The network layer called `AbortSignal.timeout` on every request — it
exists from Chrome 103 / Safari 16; below that the call throws `TypeError` before
`fetch` starts. The card combined its signal with a timeout through
`AbortSignal.any` — Chrome 116 / Safari 17.4 — and failed on Chrome 106. The
framework's own polyfills cover neither.

**Fix.** A polyfill as the first script in `<head>`, before the bundle, written in
ES5 and touching only what is missing; the timeout aborts with a `TimeoutError`
`DOMException`, like the native one, so code that tells a timeout from a cancel
keeps working. Combine signals with a small hand-written helper in the network
layer.

**What catches it.** `check-browser-floor.mjs`: APIs above the project's floor. A
scenario run on an old engine (`FQ_BROWSER=chromium FQ_CHROME_PATH=…`): the request
must leave.

---

## 24. A finger click that looks like a keyboard click

**Symptom.** The guard from 15 ("the click must land on the item that was pressed")
lets a different dish into the order — on one browser only.

**Cause.** The guard skipped verification for `detail === 0`, reading it as a
keyboard press or `el.click()`. Chrome 106 sends a finger-originated click with
`detail: 0`.

**Fix.** "Was it a pointer" comes from `detail`, and when that is 0, from
`pointerType` (`touch`, `mouse`, `pen` → pointer). Safari leaves `pointerType`
empty on `click` but reports an honest `detail`, so both are needed.

**What catches it.** `verify-tap.mjs --gestures` on an old Chromium
(`FQ_BROWSER=chromium FQ_CHROME_PATH=…`): a click landing on another node (BLOCK).

---

## 25. A fractional scroll step that never moves

**Symptom.** A programmatic scroll stops 4 px short: the gap above a button is 20
instead of 24, only on the old phone.

**Cause.** An eased follow-scroll moves by sub-pixel steps near the end. Chrome 106
truncates a fractional `scrollTop` (10.6 → 10), newer Chrome rounds it. A 0.9 px
step moved nothing, and the loop read "no movement" as "reached the edge" and
stopped.

**Fix.** While at least a pixel remains, step at least one whole pixel. "Did not
move" is never "reached the edge" without comparing with
`scrollHeight - clientHeight`.

**What catches it.** No automation — review by hand: run the scroll scenario on an
old Chromium (`FQ_BROWSER=chromium FQ_CHROME_PATH=…`) and measure the final gap; in
code, look for steps that can fall below 1 px.

---

# Keyboard and viewport

Continues [3. The keyboard and focus on a phone](failure-modes.md#3-the-keyboard-and-focus-on-a-phone)
and [4. Sticky bars, low viewports](failure-modes.md#4-sticky-bars-low-viewports-unreachable-buttons).

## 26. The keyboard resizes the window on one phone and covers it on another

**Symptom.** On Android the menu jumps 38 px when the keyboard closes; a panel
maximised while the keyboard was open stays squashed after it closes. A fix made
for the iPhone changed nothing there and did not help Android.

**Cause.** Two models. Android Chrome shrinks the window (and `dvh` with it); iOS
Safari covers the bottom and moves only the visual viewport. A ruler in `lvh` — the
height with the address bar hidden — also moved with the keyboard. A height frozen
at the moment of maximising froze the squashed value.

**Fix.** Measure in pixels from the height without the keyboard: remember the last
window height seen with no keyboard and freeze that, on the platform whose window
actually resizes. No `lvh` as a ruler. Write both models down before code; a fix
names the platform it is for.

**What catches it.** `verify-keyboard.mjs`: both models (the window shrinks / the
bottom is covered), the focused field above the keyboard, no jump after it closes.

---

## 27. iOS shifts the whole page when focus lands

**Symptom.** The search field needs two taps to raise the keyboard; when it rises,
the whole page moves about 95 px up and the header disappears.

**Cause.** iOS raises the keyboard only for a focus inside the same touch. The panel
jumped up on release, and the delayed iOS tap arrived at the old coordinates — on
the tiles, not the field. Once focus moved into code, iOS measured the field right
after focus, including a running `transform`: the field was still low in the
animation, iOS saw it under the coming keyboard and scrolled the page.

**Fix.** Suppress the native tap on the field and focus it yourself in the same
touch, when it is already at its final place without a transform; start the panel's
lift on `touchstart`, so most of the travel is done by release. Where suggestions
are not needed, turn off the suggestion bar (`autocomplete`, `autocorrect`,
`autocapitalize` off, `spellcheck="false"`) — the keyboard is lower.

**What catches it.** `verify-keyboard.mjs` (bottom-covered model): the field ends
up above the keyboard. The page shift shows only on a real iPhone — check the header
is still on screen after focus.

---

## 28. The safe-area inset that is always zero

**Symptom.** The search bar sits in the iPhone home-gesture zone: the swipe that
leaves the app drags the menu open instead.

**Cause.** `env(safe-area-inset-bottom)` is `0` unless the viewport meta has
`viewport-fit=cover`. The padding "for the home indicator" was in the code and did
nothing.

**Fix.** Either `viewport-fit=cover` — a global switch that also moves the top of
every screen under the status bar, so list everything it changes first — or a
floor: `max(34px, env(safe-area-inset-bottom))` on the bottom bar. Make that strip
inert so a touch there does not start a drag.

**What catches it.** No automation — review by hand: for every
`env(safe-area-inset-*)`, check that the viewport meta has `viewport-fit=cover`.

---

## 29. The caret lands before the old text

**Symptom.** Editing a comment: the dialog opens focused, the caret sits at the
start, and the user types in front of the old text.

**Cause.** Autofocus on a prefilled field leaves the caret at position 0.

**Fix.** On the first focus of an autofocused, prefilled field move the caret to
the end (`setSelectionRange(len, len)`). Only on that first focus: a later tap in
the middle keeps the caret where the finger put it. In the shared field component,
not per screen.

**What catches it.** No automation — review by hand: open each edit dialog with
existing text and type one character.

---

# React and hydration

## 30. A storage read during render breaks hydration

**Symptom.** Reloading an open screen logs React error #418 and the whole tree is
rendered again from scratch: local state is lost, and see 31.

**Cause.** A component read `localStorage` during render. The server cannot see it
and renders the default; the browser renders the stored value; the markup differs.

**Fix.** The first client render equals the server's: read storage through
`useSyncExternalStore`, whose `getServerSnapshot` returns the server default; the
real value arrives right after. `getServerSnapshot` returns a stable value — a new
`{}` on every call reads as a change, and React warns about an infinite loop.

**What catches it.** `check-forbidden.sh`: storage reads in render.
`verify-ui.mjs`: names hydration errors #418/#423/#425 — reload a screen with each
stored value.

---

## 31. A hydration error wipes the attributes off `<html>`

**Symptom.** After a reload, on a phone without `dvh`, the bottom action bar is
below the screen edge every other time; in every browser the dark theme falls back
to light.

**Cause.** A script in `<head>` put a CSS variable (`--app-h`, see 22) and the
theme class on `<html>`. After a hydration error React 19 renders the root again
and, taking over `<html>`, removes the attributes it did not render. The screen
grows to content height.

**Fix.** Fix the hydration error (30), and also restore document-level state in a
`useLayoutEffect` in the root layout — same commit, before paint. Keep the rules for
that state in one module used by both the head script and the effect.

**What catches it.** `verify-ui.mjs` names the hydration error. Then by hand: after
a reload that hits it, `<html>` still carries its variable and theme class.

---

## 32. An effect that read a ref once

**Symptom.** A fix ("scrolling the menu releases the keyboard") silently does
nothing. An earlier version was rejected by eslint for reading a ref during render.

**Cause.** The listener was attached in `useEffect(..., [])` through
`ref.current`. The list mounted after the screen, so at that moment `ref.current`
was `null`; the ref object never changes, so the effect never ran again. On another
entry path the screen that scrolled had no ref at all.

**Fix.** A callback ref (attaches when the node appears, detaches when it goes), or
a listener on `document` filtered by the event — independent of mount order and of
which screen is open. Never read `ref.current` during render.

**What catches it.** No automation — review by hand: every `useEffect` that reads
`ref.current` with empty dependencies — can that node mount later or be replaced?

---

## 33. The interface looks alive but ignores every tap

**Symptom.** The page renders normally and nothing responds; a PIN pad is where it
shows first.

**Cause.** Several `next start` servers served one `.next` directory. A rebuild
overwrote it; every server started before the build kept a stale file index and
answered 404 for the new script chunks. No scripts, no hydration — static HTML.

**Fix.** Before touching component code, request every script URL from the page's
HTML; a 404 means a stale server. Rebuild, then restart every server on that
directory — or give each server its own build directory.

**What catches it.** `verify-ui.mjs`: failed requests on the page (the 404 chunks).

---

# Network and state

Continues [8](failure-modes.md#8-the-eternal-loading-skeleton),
[9](failure-modes.md#9-the-frontend-thinks-it-is-the-source-of-truth) and
[10](failure-modes.md#10-the-edit-never-reaches-the-server).

## 34. A failed load drawn as "nothing here"

**Symptom.** During a network outage the order list says "No orders yet" — and so
does every cold start without a network. When polling fails, the old list stays up
with no sign.

**Cause.** On error the loader logged to the console and removed the skeleton; the
empty list then rendered the empty state. The screen had no notion of "was there
ever a successful answer".

**Fix.** Load state per list: last success, failures in a row, the reason. The empty
state only after a successful answer. First load failed → "Could not load orders",
the reason and Retry. Data present but polls failing → "No connection, list as of
14:05" in the header row (cards do not move), removed on the first success. Same
class nearby: a failed request written to a shared store as an empty list;
"Refreshed" shown without a server answer.

**What catches it.** No automation — review by hand: make the list route return 500
and open the screen cold; it must not say "empty".

---

## 35. An unknown outcome treated as a failure

**Symptom.** "Send to kitchen" times out, the app says "Failed, try again", the
user taps again — and the kitchen prints a second portion.

**Cause.** A client timeout was shown as a refusal. A timeout means the request
left and no answer came; what the server did is unknown. The same holds for a
connection that dropped mid-request.

**Fix.** Three outcomes, not two: done, refused, unknown. Unknown says so and names
the check ("check the order on the till before repeating") instead of inviting a
blind retry. The mutation carries an idempotency key, so a repeat cannot create a
second entity. Then re-read the state from the server.

**What catches it.** `verify-races.mjs` (double tap, delayed responses): a repeat
must not create a second entity. The wording after a timeout — review by hand.

---

## 36. The screen changes by itself seconds later

**Symptom.** After sending, the whole order disappears and comes back. A mark set
without a network reappears or vanishes three seconds later. Users read it as a bug.

**Cause.** Anything that changes the screen later without a user action: a late
rollback of an optimistic change, an automatic retry when the network returns, a
queue flushed later, a response to an old request overwriting a newer edit, keys
switching from draft to confirmed ids and remounting the list.

**Fix.** Optimistic display is for speed only: the tap shows at once, then the
screen changes only on the user's action. When the outcome must change it, show an
explicit state ("Not sent" with a Retry button), not a silent switch. A response
older than the last edit does not apply (one mechanism, see 9). Keys stay stable
from draft to confirmed.

**What catches it.** `verify-races.mjs`: the screen settles and does not change by
itself.

---

## 37. A toast that lives in a closing screen

**Symptom.** "The order was already closed on the till" and "Pre-check sent" — no
one ever saw these messages.

**Cause.** The screen showed a toast and closed in the same tick; the toast lived
in that screen's state and unmounted with it.

**Fix.** One mechanism, not a fix per place: the toast hook remembers the last
toast; on close the screen hands it to a small channel; the screen the user lands
on shows it — at once if it was under an overlay, or on mount. An expired toast is
not passed on.

**What catches it.** No automation — review by hand: every toast followed by a
close or navigation in the same handler; e2e asserts the message on the landing
screen.

---

## 38. A route that is not deployed yet breaks the screen

**Symptom.** A new feature reaches an environment before its backend route does;
the screen breaks, hangs or shows a raw error.

**Cause.** Frontend and backend ship separately, and a route can answer 404 for
days in one environment.

**Fix.** A 404 from a new route means "not available here yet": a quiet message
("Similar items are unavailable right now"), the rest of the screen working, no
retry loop.

**What catches it.** No automation — review by hand: make the new route answer 404
(route interception in the scenario) and use the screen.

---

# Layout, scroll and motion

## 39. A container-query wrapper captures `position: fixed`

**Symptom.** A dialog's backdrop stops short of the bottom of the screen.

**Cause.** `container-type` (any value but `normal`) applies containment, and the
element becomes the containing block for `position: fixed` descendants — "fixed" is
now relative to the wrapper.

**Fix.** Dialogs, sheets and toasts render through a portal into `body`. Adding
`container-type` to a wrapper means checking what fixed elements live inside it.

**What catches it.** No automation — review by hand: for every `container-type` or
`@container` wrapper, no `fixed` element inside it.

---

## 40. A collapse above the rows leaves a hole in Safari

**Symptom.** Adding a dish collapses a suggestion strip above the rows (161 → 0
px): the rows jump up and a 185 px hole opens above the bottom button. Fine in
Chrome.

**Cause.** Chromium and Firefox anchor the scroll position when content above
changes size; WebKit, as of this writing, does not (`overflow-anchor` is
unsupported).

**Fix.** Emulate anchoring where content above can change height: remember the
bottom visible row's position before the change and restore it through `scrollTop`
after layout, in the same frame (`useLayoutEffect`).

**What catches it.** Partly: the scenario under `FQ_BROWSER=webkit` reproduces it,
but no check measures the hole — compare the anchor row's position before and after
by hand.

---

## 41. A panel flashes to another position when a tap turns into a drag

**Symptom.** A bottom panel rises when the search field is touched. When that touch
turns out to be a swipe, the panel flashes to full height for one frame and then
back, "jumping" at every size. It looked like a Safari rendering quirk.

**Cause.** Two writers of the same position. The tap started a rise animation; the
drag gesture then took over from its own assumed origin instead of where the panel
was on screen, and cancelling the rise removed the whole offset in one frame. The
first fix — `will-change: transform` for a supposed WebKit layer quirk — was shipped
on a hypothesis, changed nothing, and the jump reproduced in Chromium as well.

**Fix.** The gesture picks the panel up where it currently is on screen; a re-render
in the middle of a drag never overwrites the finger's position; the tap threshold of
the field and the drag threshold are the same number. One writer of `transform` per
element (see [forms-mobile.md](forms-mobile.md)). And before naming an engine quirk as
the cause, reproduce it in a second engine: if it appears there too, it is your code.

**What catches it.** `verify-tap.mjs --gestures` (DOM changing under the finger) and
a frame-by-frame recording of the drag in two engines (`FQ_BROWSER=webkit` and the
default); no automation for the visual jump itself.

---

## 42. Glass that tears at the seams

**Symptom.** A thin bright line between the search bar and the menu below it, in
the dark theme.

**Cause.** The panel was three glass layers, each with its own `backdrop-filter`.
Blur is computed within each layer's bounds, so at the seam neither sees what is
under the other; a coloured edge behind gave a sharp stripe (brightness 23 → 36
within one pixel).

**Fix.** One surface, one glass: the blur on the container that covers the whole
panel, children transparent. Only elements that truly float above the edge keep
their own.

**What catches it.** No automation — review by hand: adjacent elements both carrying
`backdrop-filter`; screenshot the seam in both themes with something coloured
behind.

---

## 43. Rows animate in on the first data load

**Symptom.** Opening a table, twelve rows and three guest blocks grow from zero
height and push the list down under the finger.

**Cause.** The gate that allows entrance animations opened one frame after mount;
data arrived seconds later, so the first fill animated as if the user had added
everything. A second instance of a class seen before (a remount gave a jump).

**Fix.** Open the gate one frame after the first data fill, not after mount: the
first content appears in place, only later additions animate. Layout shift on
opening went from up to 0.84 to 0.000.

**What catches it.** `verify-perf.mjs` or `verify-motion.mjs` with `--scenario` on
a screen that loads its data: layout shift (CLS) on opening.

---

## 44. A scroll target measured from a zero-height row

**Symptom.** A newly added item stays under the bottom panel or never arrives; a
new guest stayed 305 px below the edge.

**Cause.** The target was computed once, in the insertion frame, from a row that
animates its height from zero, and the browser clamped it to the old maximum
scroll. The row grew, the maximum grew, the scroll had already ended. The effect
cleanup also cancelled the follow when a temporary row was replaced by the
confirmed one, and the key change replayed the entrance.

**Fix.** Follow per frame: recompute the target while the row grows and ease
towards it; start in `useLayoutEffect` in the insertion frame; stop when the target
settles; cancel on touch. The visible edge is one rule: the top of whichever overlay
is higher. Keys stable across confirmation (see 36).

**What catches it.** No automation — review by hand: add an item at the end of a
long list at CPU 1× and 4×; it must end fully above the panel.

---

## 45. Search results open at the old scroll position

**Symptom.** Search results open scrolled down; the first matches hide under the
search field.

**Cause.** One scroll container serves every view (categories, results), and the
position was not reset when the view changed. The results view also had one key for
every query, so a new query did not start over either.

**Fix.** Key the list by view plus query: a change of either starts from the top.
Keep the transition animation on the coarser view key, so it does not fire on
every keystroke.

**What catches it.** No automation — review by hand: scroll the category view, then
type a query; the first result must be at the top.

---

## 46. A fan-out animation built for three items, shipped with forty

**Symptom.** Opening a picker, cards run behind and over the held one for about two
seconds, then settle.

**Cause.** Designed and tested with a couple of cards; production had dozens. The
stacking layer came from the count (`n − i`), so past ten cards they rose above the
held card. Every card fanned out with a 40 ms stagger — about 2.5 s of motion,
mostly off-screen.

**Fix.** Animate only the items visible in the viewport; the rest stand in place.
Compute layers down from the anchor's layer (one constant), never from the count.
Test with production volume.

**What catches it.** No automation — review by hand: run the scenario with 40+
items; no item passes above the anchor and the motion ends within the transition's
duration.

---

## 47. A long word, and an ellipsis that makes two items identical

**Symptom.** A long name with no spaces escapes its tile. Two wines whose names
differ only in the volume at the end ("… 150 ml" and "… 750 ml") look identical
once the ellipsis cuts the tail.

**Cause.** Wrapping was tuned for ordinary words, and the part that tells two names
apart sat at the end — exactly where the ellipsis falls.

**Fix.** `overflow-wrap: break-word` followed by `overflow-wrap: anywhere` (old
browsers skip the second and keep the first; check that the built CSS keeps both).
For long names, put the distinguishing tail (volume, weight, size) on its own line,
so the clamp cuts the middle. Full names in rows and dialog titles.

**What catches it.** `verify-ui.mjs`: text escaping its box (BLOCK) — feed it the
longest real names. Identical truncated names: no automation — compare the visible
text of neighbouring items by hand.

---

# Text and language

## 48. `\b` does not see non-ASCII letters

**Symptom.** A rule that finds a word in a name works on English data and silently
fails on names in another script, or matches inside a word: `/\bcaf\b/` finds a
match in "café".

**Cause.** In JavaScript, `\b` and `\w` know only `[A-Za-z0-9_]`, with or without
the `u` flag. Any other letter is a non-word character, so a boundary appears in
the middle of a word.

**Fix.** Spell the boundary with Unicode classes:
`/(^|[^\p{L}\p{N}_])word(?![\p{L}\p{N}_])/u`. A lookbehind `(?<!…)` is neater but
arrives only in Safari 16.4 — check the floor. Test with the languages the data
contains.

**What catches it.** No automation — review by hand: `grep -rn '\\b' src` in code
that handles user or catalogue text.
