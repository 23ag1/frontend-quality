# frontend-quality — a Claude Code plugin

A working standard for frontend: how visual decisions get made, how layout is
checked mechanically in a real browser, what has actually broken before, and how
performance is analysed down to the function that ate the budget.

It grew out of one product, but the rules do not depend on it: the browser, the
frame pipeline, the finger, the keyboard and the human eye are the same everywhere.

## What is inside

**Three skills** — picked up by topic, or invoked by hand:

| Skill | When | What it gives |
|---|---|---|
| `frontend-quality` | any interface work | the process, laws of interface behaviour, a 50-point rubric, twelve checks, 48 failure modes from production, the browser floor, forms and the keyboard on phones, network and state, hand-off checklists |
| `visual-taste` | a new screen, a redesign, "it looks like everything else" | how to make visual decisions: character, typography, colour, rhythm, hierarchy, motion, copy |
| `frontend-performance` | it stutters, lags, weighs too much | 60 frames per second at 20× CPU throttling: budget arithmetic, measurement, causes |

**The `ui-verifier` agent** — independent acceptance. It never saw the reasoning
that produced the result: it runs the measurements, looks at full screenshots and
scores against the rubric. It is not allowed to fix anything.

**An acceptance hook** — refuses to close a turn while the layout check is red.
It stays silent everywhere except projects with a `.uiverify.json` in the root.

**Templates** — a scenario module, a CI workflow with an engine matrix, an ESLint fragment that keeps the same rules in the editor, and a first-script that polyfills what old browsers lack.

## Install

```bash
# 1. Register this directory (or git URL) as a plugin source and install
claude plugin marketplace add <path to this repo or its git URL>
claude plugin install frontend-quality

# 2. Put the browser and axe INSIDE the skill (your project gets no dependencies)
cd "$(claude plugin path frontend-quality)/skills/frontend-quality"
npm install && npx playwright install chromium
```

If plugin installation is unavailable, everything also works by hand: copy
`skills/`, `agents/` and `hooks/` into `~/.claude/` and register the hook in
`~/.claude/settings.json` — `install.sh` in this repo does exactly that.

Check that it is alive:

```bash
bash scripts/check-plugin.sh          # the plugin checks itself
node skills/frontend-quality/scripts/verify-ui.mjs --url https://example.com/
```

## Starting on your own project

Read [skills/frontend-quality/reference/adopt.md](skills/frontend-quality/reference/adopt.md):
seven steps, a stack compatibility matrix and a list of what **not** to copy
verbatim. In short:

1. `.uiverify.json` in the root: URLs, `checkPaths`, breakpoints, and the browser
   floor taken from your traffic logs.
2. A first run and noise calibration — every exclusion carries a comment saying
   why it is intentional.
3. Your first scenario. This is where most of the value is: without one you are
   checking the login screen instead of the working one.
4. The hook and CI, so the rules hold without you.

## The checks

| Script | Question it answers |
|---|---|
| `check-forbidden.sh` | bans in source: leading zeros, inline styles, viewport units old browsers drop, raw colours and palette classes, raw `fetch` outside the network layer, `fetch` without a timeout, storage read during render, text below the minimum size, internal terms in visible text |
| `check-browser-floor.mjs` | CSS and JS features newer than the oldest browser you support, with no fallback |
| `verify-ui.mjs` | overlaps, horizontal scroll, text escaping its box, unreachable controls, console, hydration mismatches, broken anchors, accessibility — from 320 px, in landscape and with large system text |
| `verify-states.mjs` | keyboard focus, hover response, contrast in every state |
| `verify-tap.mjs` | touch targets by real tap; `--gestures` — the lost and the double tap, holds, a tap right after a swipe |
| `verify-keyboard.mjs` | the on-screen keyboard in two models: is the field visible, does a tap inside the sheet keep the keyboard and the height, does Back close it |
| `verify-races.mjs` | a double tap sending twice, an older answer overwriting a newer screen, a screen that changes by itself, a failure that looks like success |
| `verify-consistency.mjs` | gutters, headings, columns, row lines, toggle heights and focus rings the same on every page |
| `verify-regression.mjs` | did anything break that you did not touch |
| `verify-motion.mjs` | motion budgets, weight, `prefers-reduced-motion`, animations cut before they end |
| `verify-perf.mjs` | who ate the budget: function, file, frame phase, response components, whether the screen settles |
| `verify-vocabulary.mjs` | how narrow the decision vocabulary is: type sizes, spacing, radii, shadows, colours |

Every browser check accepts `--scenario` — a module that brings the environment
up and drives the app into the state worth checking — and runs in the Safari engine
(`FQ_BROWSER=webkit`) or an old Chromium (`FQ_CHROME_PATH`, fetched by
`scripts/fetch-chromium.sh <major>`).

## Checking the plugin itself

A check that cries wolf is worse than a missing one: two false findings out of
three teach everyone to stop opening the report. Every check ships with a fixture
in `tests/<name>/`: the cases that used to be reported falsely stand next to real
defects that must keep being reported, and the run fails if either side moves.

```bash
cd skills/frontend-quality && npm install && npx playwright install chromium   # once
cd - && bash scripts/check-plugin.sh   # manifests, links, syntax, language, every fixture
```

## Limits

- A headless browser on a server is not a real device: no thermal throttling, a
  different GPU, a different network, and no real keyboard. The keyboard check
  emulates the two ways phones make room for it; the keyboard's own animation, the
  iOS scroll-to-field and an installed web app still need a phone before hand-off.
- Some failure modes resist automation (layer order, cache invalidation on user
  switch, glass seams) — the catalogue says so plainly for each.
- Text-level bans depend on syntax: the vocabulary is configurable for any
  interface language, and rules written around Tailwind classes simply stay quiet
  on other stacks.
