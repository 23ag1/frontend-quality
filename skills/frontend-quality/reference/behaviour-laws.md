# Behaviour laws

Sixteen laws of interface behaviour and a procedure that turns them into cases for
the element you are touching. Read it before writing code for any interactive
element, and before reviewing one.

## Where the laws come from

An audit of 686 cases where something "obvious" was missed in shipped interfaces:
343 from review remarks of one product owner across several products over two and a
half months, 343 from fix commits. Five reviewers worked independently and assigned
each case to a classic law or marked it new. 54% were covered by the ten classic
laws alone (Norman, Nielsen's heuristics, Apple HIG, Material); 19% needed a classic
law plus a new one; 27% fit only a new one. Six new groups were needed, and all five
reviewers found them independently. A later held-out period produced no group that
had not appeared before, so the set is closed enough to work from. About 40 cases
under law 7 were network races.

The more useful finding is about the misses themselves: long series of repeated
defects (the sheet, the keyboard, the frames) came from **states nobody walked
through**, not from a missing law. Hence the procedure at the end — the laws only
work when they are run against every state the element can be in.

## The laws

### 1. The interface follows intent

When intent changes, whatever served the old intent leaves.

- The person collapses the menu to see the whole order — the search keyboard stays
  up and covers half the screen. Collapsing releases focus.
- A filter chip stays highlighted after the person opened another section by a
  direct link.
- A hint for a step is still shown after the step was done.

### 2. Untouched does not move

Fresh data arrives on its own, but the person's choice and what they created never
change or disappear by themselves. After a temporary state the screen returns to
the chosen one.

- A poll returns and the list re-sorts under the finger: the tap lands on another
  row.
- An item marked "served" flips back to "ready" three seconds later because a
  response requested before the tap arrived late.
- After a temporary search the category tab resets to the first one instead of the
  one the person had picked.

### 3. An action has a visible result where the person is looking, in the first frame

- A tap on a tile waits 400 ms for the network with no change on screen; the person
  taps again and gets two items. The pressed state and a loading mark appear on the
  tile in the first frame.
- "Saved" appears at the top of the screen while the person looks at a sheet at the
  bottom.
- An item goes into a cart that is off screen, and no counter changes.

### 4. Friction matches the cost of a mistake; nothing the system will reject can be assembled

- One tap deletes a whole order without undo, while removing one line asks for
  confirmation — the friction is inverted.
- A form lets the person pick a time window the server rejects on submit. The
  picker offers only valid windows.
- A confirmation on a cheap, reversible action teaches people to press "OK" without
  reading, so the dangerous one gets confirmed blindly too.

### 5. No dead ends

- An error screen with no action on it.
- A sheet on a phone that closes only by a gesture nobody knows; browser Back leaves
  the page instead of closing the sheet.
- An empty search result without "clear the filter".

### 6. One thing behaves the same everywhere

Every page, entry path, theme, language and state.

- The same item opened from the list and from search offers different actions.
- "Ready" is green on one screen and blue on another.
- The dark theme forgets the disabled state, which then looks active.

### 7. The screen tells the truth about state

- A failed request is drawn as "No orders yet".
- A tick appears before the server confirmed.
- Cached data is shown offline without its age.

### 8. The device sets the conditions

A finger, a keyboard, screen edges, an old browser, weak hardware, a poor network,
interruptions. Speed is a condition too.

- The bottom bar sits under the home indicator because
  `env(safe-area-inset-bottom)` is 0 without `viewport-fit=cover`.
- A feature above the browser floor drops a whole declaration and a card renders
  blank on a three-year-old Android phone.
- The app goes to the background mid-request; on return the spinner never ends.

### 9. Do not make the person do what the system knows

- A screen opened from a table asks for the table number.
- A prefilled field gets focus with the caret at the start.
- "Change email" goes back to an empty form instead of the filled one.

### 10. Frequent and important — closer and earlier

- The most used action lives in an overflow menu.
- The submit button of a short form is below the fold at 390×640.
- A list is sorted alphabetically where frequency would save every person a scroll.

### 11. Worst real data

45 characters, a word without spaces, widths of 320–360, 47 items instead of 2,
duplicates in the data, empty values, old saved values. Things that look the same
are different entities with their own id. When something does not fit, the layout
reflows; it does not shrink.

- Two identical dishes in one order are keyed by product id; editing the second
  changes the first.
- A long name without spaces pushes the price off screen at 320.
- A setting saved by an older version holds a value the new code does not know, and
  the screen crashes on it.

### 12. The person's words about their work

No codes, wrappers, slang, foreign words or system internals. One action — one
word. A label does not promise what does not exist. A placeholder is not a value.
Every word is needed for an action or a decision.

- A toast says "Error 409".
- The same action is "Send" on one screen and "Submit" on another.
- A greyed "0" placeholder in a price field is read as a real zero price.

### 13. The eye sees 1–2 px

Optical alignment by letters and drawing. Common axes, heights and radii among
neighbours. A nested radius = the outer radius − the inset. One surface — one layer
without seams. Distance carries meaning. Contrast ≥ 4.5:1. A change of state does
not change geometry. Image proportions are honest.

- An icon centred by its box looks one pixel low next to the text.
- Two stacked `backdrop-filter` layers on one panel show a seam where they meet.
- A selected chip gains a 1 px border and the row grows by 2 px.

### 14. Every element earns its place

No duplicates or explanations; empty things are not drawn; rare things collapse; a
working screen is dense; hierarchy comes from weight.

- A heading repeats the label of the tab that opened it.
- An empty "Notes" block is rendered with a dash in it.
- A paragraph explains a form that explains itself.

### 15. Motion is physics

One system of durations and curves. Motion starts from the current position and
velocity and can be interrupted by a gesture. It ends when the transition ends, not
on a timer. Opening decelerates, closing accelerates. Only what the person caused
and what is visible is animated. A thing moves together with its carrier. A press
is visible from the first frames. Nothing is remounted at the end. Nothing moves on
its own. An effect exists only for meaning, and softly.

- A staggered entrance over 47 cards runs down the whole list; the last card
  arrives two seconds later, off screen.
- A sheet grabbed mid-animation snaps back to where the animation started.
- A toast slides in by itself on every poll.

### 16. Familiar beats invented

The reference product and the platform's conventions win. A website is not an app.
A deviation is a decision named before the work, not discovered in review.

- A bottom sheet for signing in on a website feels like an app; on a phone the form
  becomes a page.
- Swipe-to-delete goes the opposite way from the platform.
- The order of steps differs from the tool the staff already use every shift.

## When laws conflict

They do, regularly. Even law 2 pulls two ways — fresh data arrives on its own, yet
nothing moves under the finger: data waits while a finger is down and is applied
after. Law 3 (feedback in the first frame) against law 15 (animate only what the
person caused): the press state is instant, the transition is not decorated. Law 10
(frequent closer) against law 16 (familiar first): the button stays where the
reference product has it.

**The tie-breaker is the reference product or the platform convention.** If there
is neither, write the conflict down and ask the owner; do not settle it silently.

## The procedure

The laws catch nothing on their own. They catch defects when they are run against
the states the element passes through. Keep the procedure to **the element you are
touching**, not the whole screen: a table for a whole screen is never finished and
never read.

1. **Name the element.** "The quantity stepper in an order row", not "the order
   screen".
2. **List the person's intents** with it: three to six lines. "Add one more",
   "remove one", "remove the line", "see what is already sent".
3. **List the events** that change the intent or the conditions. Go through the
   whole list and keep what applies:
   - scroll, drag, a long press;
   - the keyboard opens or closes;
   - browser or system Back;
   - rotation;
   - the app goes to the background and comes back;
   - the network drops; a response arrives late; a response arrives out of order;
   - a repeated tap; a tap while the previous request is pending;
   - a second path to the same action (another screen, a gesture, a menu item);
   - another theme, width (320, landscape) or language (text twice as long);
   - every entry path: from the list, from search, by direct link, after a reload.
4. **Run each event through the laws** and write the expected behaviour in one line.
5. **Mark how each row is checked**: a script, an e2e test, or a real device (and
   why a device).

The result is a short table in the task or the pull request description. Example
for the stepper:

| Event | Law | Expected behaviour | Checked by |
|---|---|---|---|
| tap "+" while the network is slow | 3 | the count changes in the first frame, the row shows "sending" | e2e with a delayed mock |
| second tap during the request | 4, 7 | the count goes up again, one request per intent key, no duplicate line | e2e |
| a poll response requested before the tap arrives | 2 | the count does not roll back | `verify-races.mjs` |
| the request times out | 7 | "not confirmed yet", no "failed" until the state is re-read | e2e |
| the same item added from search | 6 | the same line grows, not a second identical line | e2e |
| the list re-sorts while a finger is down | 2 | the tap belongs to the row that was pressed | `verify-tap.mjs --gestures` |
| width 320, a 45-character name | 11 | the name wraps, the stepper stays a 44×44 target | `verify-ui.mjs`, `verify-tap.mjs` |
| app in the background for a minute | 8 | on return the row shows the server's count, the person's pending intent on top | real device |

A row that could not be reproduced is not fixed "by the law" silently: the fix is
labelled **a fix by hypothesis**, with the command that would confirm it.

## Where this sits in the work

- Before code: the table is part of the contract for the screen
  ([product.md](product.md), "Before the code").
- In review: the `ui-verifier` agent derives its own table from this file
  **before** reading the implementation notes, then compares.
- Network events in detail: [network-state.md](network-state.md). The keyboard
  and forms: [forms-mobile.md](forms-mobile.md). Old engines:
  [browser-floor.md](browser-floor.md).
