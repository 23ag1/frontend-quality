# Failure modes: what actually broke

Assembled by going through the history of a real project: 190 fix commits across
two frontends, the closed bug tracker and the project's long-term notes. These are
not general recommendations — every entry happened, cost time, and repeated.

Format: **symptom → the real cause → how to fix it → what catches it**. The last
line matters most: a rule nothing can check does not work.

---

## 1. The tap disappears or fires twice

The most frequent class of failure in the whole history: a dozen and a half
commits.

**Symptom.** "Perfect on a laptop, needs two taps on a phone." A modifier is added
twice from one touch. The first tap on a status does not register after every entry
to a screen. A context menu flashes and dies.

**Causes, all different.**

- **A re-render inside the gesture.** A `touchstart` handler changed state, the
  framework inserted nodes above the button, and the browser **did not synthesise
  `click`** — the tap vanished silently. The fix: set the state in a deferred effect
  after mount, not inside the gesture handler.
- **Stopping propagation on the wrong event type.** A tile listened to `touchend`
  (otherwise the tap was lost inside a scrollable sheet) while the nested "+/−"
  buttons stopped only `click`. The finger reached both: the counter went 1 → 3 and
  "−" looked broken. The fix: stop propagation on the same type the parent listens
  to, and compare against `currentTarget`.
- **Gesture thresholds set for an ideal finger.** A 420 ms long-press threshold
  caught an ordinary press, and an 8 px swipe threshold fired from natural hand
  tremor — after which the browser synthesised no click at all. Raised to 620 ms
  and 14 px.
- **The ghost click.** A long-press menu opens under a finger that has not been
  lifted; the browser synthesises `click` at the same point, it lands on the
  backdrop of the fresh menu and closes it instantly. The fix is by meaning, not by
  a timeout: the backdrop only reacts to a click that belongs to a **new** gesture
  (it arms itself on its own `pointerdown`).
- **Relying on `click` at all.** If something moved under the finger or the gesture
  looked like scrolling to the browser, `click` never arrives. The tap has to be
  recognised from `touchend` (short, finger stationary, started on the element's own
  button), and the ghost click that follows suppressed by coordinates.

**What catches it.**
`verify-tap.mjs --gestures` reproduces the mechanics: DOM mutations between touch
and release (FLAG), a click landing on another node (BLOCK), two clicks from one
touch (BLOCK). Plus `check-forbidden.sh`: `click` and `touch` in one component with
`stopPropagation` (FLAG).

---

## 2. The target is smaller than it looks

**Symptom.** People miss a button that was "already made bigger".

**Cause.** Measuring the box lies: inside a flex column `w-full` measures the width
of the column, and negative margins (`-mx-3`) do not widen the box, they move it.
The target stayed 56×32 against a norm of 44×44. Worse than the size is where the
miss goes: a tap beside the status landed on the row and opened the modifiers sheet.

**Fix.** Measure the target from the parent column (`relative` on the column,
`absolute -inset-…` on the button), keep the label inside the target, and give the
place in the flow to an invisible twin.

**What catches it.** `verify-tap.mjs`: size (BLOCK), covered corners (BLOCK), a
miss landing on an element four times larger (BLOCK for a small target).

---

## 3. The keyboard and focus on a phone

**Symptom.** The menu was collapsed to see the whole order — and the keyboard
stayed up, covering half the screen. Tapping an item from search leaves the
keyboard open.

**Cause.** Focus was cleared in individual handlers, while the state changes by
three different paths: a tap on the handle, a drag on it, a swipe on the list body.

**Fix.** Clear focus at the **single point where the state changes**, not in every
handler: one change covers every path at once. The reverse action (expanding) does
not touch focus — there the tap on the field raises the keyboard itself.

**What catches it.** No automation — this is e2e: "focus in search → collapse →
focus released". Keep such a test alive when touching the menu panel.

---

## 4. Sticky bars, low viewports, unreachable buttons

**Symptom.** The "Cancel / Save" bar slides out from under the finger. On a low
screen the form does not scroll far enough to reach the button. There is a gap
above a sticky header.

**Cause.** The button bar was stuck **inside** the scroller and stretched the
window with negative margins by the height of the safe area — so even short content
got an extra stretch of scroll.

**Fix.** The footer is rendered **after** the scroller and takes no part in its
height (a dedicated prop on the sheet). No sticky hacks with negative margins. The
window height is `dvh` with a ceiling and internal scrolling.

**What catches it.** `verify-ui.mjs`: a `low` 390×640 breakpoint in the default set
plus the check "cannot reach this element: it is outside the viewport and there is
no scroll" (BLOCK).

---

## 5. Text that does not fit

**Symptom.** An item name escapes its card. A tag falls onto two lines. A total
wraps. A long category squeezes the name out.

**Cause.** The layout was checked on exemplary data. Inside a flex row a child does
not shrink by default (`min-width: auto`), so long text pushes its neighbours apart
instead of being clipped.

**Fix.** `min-w-0` on the shrinkable element, an explicit `truncate` with an
ellipsis where clipping is acceptable, and a check on the longest real name.

**What catches it.** `verify-ui.mjs`: text escaping its own box without clipping
(BLOCK), text clipped without an ellipsis (FLAG).

---

## 6. Layers: a sheet under a modal, a toast over a sheet

**Symptom.** A course sheet appeared UNDER the item modal. A sync warning got lost
behind a toast.

**Cause.** `z-index` was assigned one element at a time, in place.

**Fix.** One list of application layers: every kind of surface has its place in the
order, and new surfaces are added to that list instead of inventing a number.

**What catches it.** No automation. The signal in review: any new `z-` number in
the markup is a reason to ask why it is not in the shared list.

---

## 7. The screen never settles

**Symptom.** The page dies with "Maximum update depth exceeded". The application
sends 19 requests for one action. A paginated fetch loops forever.

**Cause.** An unstable reference in an effect's dependencies: a callback is not
memoised → the function inside the hook is new on every render → the effect
restarts forever → fresh empty state → another render.

**Fix.** Stabilise the reference (a ref wrapper keeps identity forever while the
current logic is read from the latest render's closure). Check effect dependencies
at the edges of lists and in hooks that run unconditionally.

**What catches it.** `verify-perf.mjs`, the idle phase: the screen is open and
untouched — if scripts keep working (budget 30 unthrottled ms over 3 s) that is a
BLOCK, with the layout count attached.

---

## 8. The eternal loading skeleton

**Symptom.** The dashboard skeleton hangs forever.

**Cause.** `fetch` without a timeout. The response was cut mid-flight (a proxy
severed the chunked transfer) — `await res.json()` neither resolved nor rejected
**ever**, the code stayed inside `try`, and `finally` never ran.

**Fix.** `AbortSignal.timeout(...)` on every request, with a value aligned to the
polling interval. The error must reach the screen's state.

**What catches it.** `check-forbidden.sh`: `fetch` without a signal or timeout
(FLAG). `verify-perf.mjs`: loading skeletons still present after 3 s (BLOCK).

---

## 9. The frontend thinks it is the source of truth

**Symptom.** An item added on another device was never shown to the user — until
their own first edit. Cart changes were lost on network failures.

**Cause.** The merge said "the local snapshot beats the server response". The order
lives in the back office, where other people change it — our cache has no right to
override fresh data.

**Fix.** The server wins. The only exception is an edit made while the request was
in flight: it must not be dropped, and that is solved with an **edit counter**
(compare before and after the wait), not with a guessed timeout.

**What catches it.** An e2e scenario: open the screen → leave → the data changes
elsewhere → come back → the screen shows the server's state.

---

## 10. The edit never reaches the server

A separate class, worth checking on **any** complaint of the form "it does not
save". Six such places were found in one pass through the project's notes.

**Symptom.** The user changes a value, sees the result, leaves the screen — and the
value is back. Or: changed on one device, still old on the second.

**Causes, all three seen in the wild:**

- **The edit lives only in component state.** The screen shows the new value and no
  request is made at all. Externally indistinguishable from saving — until a reload.
- **Two independent stores for one value.** A comment on an order: the list sent it
  to the server while the detail screen kept its own state and only submitted it on
  send. One value, two sources — they always diverge.
- **A local marker instead of shared state.** A course was kept in `sessionStorage`
  because the team believed the server had nowhere to store it. The marker is
  invisible to the second device and to the back office — the complaint "it works
  wrong" was about that, not about the interface.

**Fix.** Only what the server does not have by definition stays local: display
preferences and a draft the server does not know about yet. Anything that is a
user's decision about a domain entity reaches the server.

**A cheap, reliable method:** map the client's paths against the backend's routes,
and for every "user decision" on the screen trace whether it makes it into a
request. Then a scenario: change → leave the screen → come back → the value is
there; and a second window sees the same thing.

**What catches it.** No automation; this is e2e. But the question is mandatory in
acceptance: "does this edit go to the server, or does it live in screen state?"

---

## 11. You were checking something other than what you thought

Two traps that produce a false "all is well".

- **A build is not a check.** `next build` with Turbopack does not run eslint — only
  compilation and types. A green build says nothing about the linter; the gate is a
  separate `eslint` run.
- **A screen opened over a live screen.** An order opens as an overlay above the
  dashboard through intercepting routes, and the screen underneath is not unmounted.
  A check that searches for text across the whole page sees both — and can "find"
  something that is not on the visible screen. Search within the boundaries of the
  block under test, not across the whole `textContent`.

Hence the general rule: **a check that cannot fail is useless.** Before trusting a
green report, make sure it goes red on a deliberately broken input.

---

## 12. Row identity is not entity identity

**Symptom.** Two identical items in one order swap places. Status and course land
on the wrong row. Editing a modifier creates a duplicate downstream.

**Cause.** Addressing by `product_id` when an order holds two rows of the same
product — row identity is not the identity of the product.

**Fix.** A row's key is its own identity, preserved across edits. The same rule
applies in React: an index key with an insertion in the middle makes it reuse the
wrong nodes.

**What catches it.** No automation — tests for the "two rows of the same product"
scenario.

---

## 13. The cache outlives the user switch

**Symptom.** After signing out and back in as someone else, another person's data
is visible.

**Cause.** Module-level caches and the query cache were not cleared on account
change.

**Fix.** A user switch invalidates every cache through an explicit action, not
through a page reload.

**What catches it.** No automation — an e2e "sign in as another user".

---

## 14. An animation aborted by its own timer

**Symptom.** A rotating indicator broke on every revolution. A card "jolted" at the
end of a swipe.

**Cause.** A timer ran alongside the animation and "finished" it on its own
schedule; on top of that the node was remounted at the moment of completion.

**Fix.** Finish on `transitionend` / `animationend`, never by timer; keep keys
stable so the node is not recreated as it commits.

**What catches it.** A small audit script over the scenario: it counts finished
animations against aborted ones (`animationcancel` / `transitioncancel`).

---

## How to use this

Before touching an area, read the matching entry: that defect has almost certainly
happened here before. After the change, run the check from the entry's last line.
If you find a failure that is not on the list, add it **together with whatever now
catches it**: an entry without a check lives until the first person forgets.
