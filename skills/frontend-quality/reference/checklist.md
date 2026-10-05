# Hand-off checklists

Two lists: a product screen and a promo page. An item counts as done only with a
number or a screenshot — "looked at it, seems fine" does not count.

## Shared (both cases)

- [ ] `bash $SK/check-forbidden.sh .` — zero blocking.
- [ ] `node $SK/verify-ui.mjs --config .uiverify.json` — zero blocking, and every
      warning addressed by name (fixed, or explained).
- [ ] `node $SK/verify-regression.mjs --config .uiverify.json` — no differences
      from the baselines, or each one explained and the baseline updated knowingly.
- [ ] The run went **through a scenario** for screens with data, not against the
      first page's address. Checking the login screen instead of the working one is
      self-deception.
- [ ] Full screenshots of every affected section looked at with your own eyes (not
      crops).
- [ ] Every state captured: hover, keyboard focus, active, disabled, loading,
      empty, error.
- [ ] `node $SK/verify-states.mjs` — contrast sufficient **in every state** (rest,
      hover, focus), focus visible, elements have accessible names.
- [ ] Copy is in the user's language, without internal terms or references to other
      projects. Buttons are a verb with a noun.
- [ ] Not a single instance of numbering with a leading zero.
- [ ] The rubric score from [the skill body](../SKILL.md) is ≥42/50, every figure
      backed by a measurement.
- [ ] Everything that can be checked by reading code or running a script was
      checked before the report. The "needs a device or access" section lists only
      the rest, each item with its reason.
- [ ] If the project declares a browser floor, `node $SK/check-browser-floor.mjs
      <src>` is clean, and the working screen was run once on the floor engine
      ([browser-floor.md](browser-floor.md)).

where `SK=~/.claude/skills/frontend-quality/scripts`

## A product screen

- [ ] A new screen: two or three composition variants were shown on real data and
      one was chosen; every approved state is its own commit.
- [ ] The behaviour table for the touched element exists — intents × events ×
      expected behaviour, by [behaviour-laws.md](behaviour-laws.md) — and every row
      is either checked or marked "needs a device". An unreproduced defect is
      reported as "a fix by hypothesis".
- [ ] A fix for a defect has a guard test, and that test was seen red once on the
      code before the fix.
- [ ] A second defect of a class already seen got a shared mechanism (or a task for
      one, linked from the temporary patch), not a third local patch.
- [ ] The screen was checked at real data volume (hundreds of items, dozens of
      rows), not on a demo set.
- [ ] `node $SK/verify-tap.mjs --scenario <scenario>` — zero blocking: targets
      ≥44×44, corners not intercepted, a miss does not land on a large foreign
      element.
- [ ] States under data walked through by hand: empty, one row, a hundred rows, a
      long name, a lost connection, a repeated tap (no duplicate appeared).
- [ ] `node $SK/verify-tap.mjs --scenario <scenario> --gestures` — the tap does not
      land on a foreign node and does not fire twice (this mode changes application
      state, so run it against a scenario with mocks).
- [ ] `verify-perf` shows that the screen **settles**: with no touches the scripts
      go quiet and no loading skeletons remain.
- [ ] Row and section heights did not drift after the change — compared as numbers
      at every width, with a 0px spread between toggle states.
- [ ] A repeated tap and a lost connection do not create a duplicate (order, table,
      payment).
- [ ] Nothing on the screen changes by itself seconds after an action (no late
      rollback, no silent retry or queue); a failed request is an explicit state, an
      error is never drawn as "empty" ([network-state.md](network-state.md)).
- [ ] Forms and sheets on a phone: the scenarios from
      [forms-mobile.md](forms-mobile.md) were written before the code, and
      `verify-keyboard.mjs` was run in both keyboard models.
- [ ] `npm run lint`, `npm test`, `npm run test:e2e` — green.
- [ ] Nothing unapproved was added: no new functions, buttons or behavioural
      "improvements", or they were explicitly approved.
- [ ] No new duplicate elements appeared (`grep` before adding).
- [ ] A performance measurement on a production build if lists, input or animation
      were touched: `verify-perf.mjs --scenario … --throttle 20`, with "before →
      after" numbers in unthrottled milliseconds.
- [ ] The measurement report names the culprits (function, file, frame phase), not
      "it feels smoother".

## A promo page

- [ ] `node $SK/verify-motion.mjs --url <address> --throttle 4` — within budget:
      median fps ≥50, share of long frames ≤5%, LCP, CLS, weight.
- [ ] The budgets from [landing.md](landing.md) written down and met; every excess
      defended out loud.
- [ ] `prefers-reduced-motion` respected: infinite animations stopped.
- [ ] **One** signature moment; everything else restrained.
- [ ] The page works without WebGL and on mid-range hardware; it is decided what is
      switched off on mobile.
- [ ] The mobile version checked on a real device, not only in emulation: `dvh`,
      the bottom edge, scroll inertia, scene weight.
- [ ] Every inner page opens by direct link; meta tags and the share image are in
      place.
- [ ] Forms: success, network error, double submission, autofill, mobile keyboard,
      Back closes the form — the full list is in [forms-mobile.md](forms-mobile.md).
- [ ] Media is real in every section, no placeholders.
- [ ] The canvas scene is mirrored by a semantic DOM layer for screen readers.

## Report format

```
VERDICT: ship / fix / rebuild            (≥42 / 30–41 / <30 out of 50)

Measurements
  verify-ui       blocking N, warnings M
  verify-states   checked N, findings M
  verify-motion   median fps, share of long frames, CLS, weight
  check-forbidden blocking N

Scores
  1 Accuracy and tokens   N/10  — rationale
  2 Layout and rhythm     N/10  — rationale
  3 States                N/10  — rationale
  4 Accessibility         N/10  — rationale
  5 Content               N/10  — rationale

What to fix (most important first)
  1. <file:line or screen> — what is wrong, why it matters

Taste (not violations)
  — suggestions that can be ignored

Needs a device or access I do not have
  — <what> — <why it cannot be checked here: a real device, a write to shared
    data, an account or environment I cannot reach>
```

The last section is mandatory, and it is short. Anything that can be checked by
reading the code or running a script — states under data, WebKit, the floor engine,
the keyboard models — is checked before the report, not listed here. "Did not
check" is not an outcome for those. What remains has a reason: the iPhone keyboard
and its focus rules need a real device; a check that writes to shared data needs
permission; an environment behind a login needs access.
