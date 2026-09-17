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
| `frontend-quality` | any interface work | the process, a 50-point rubric, eight checks, 14 failure modes, hand-off checklists |
| `visual-taste` | a new screen, a redesign, "it looks like everything else" | how to make visual decisions: character, typography, colour, rhythm, hierarchy, motion, copy |
| `frontend-performance` | it stutters, lags, weighs too much | 60 frames per second at 20× CPU throttling: budget arithmetic, measurement, causes |

**The `ui-verifier` agent** — independent acceptance. It never saw the reasoning
that produced the result: it runs the measurements, looks at full screenshots and
scores against the rubric. It is not allowed to fix anything.

**An acceptance hook** — refuses to close a turn while the layout check is red.
It stays silent everywhere except projects with a `.uiverify.json` in the root.

**Templates** — a scenario module and a CI workflow.

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

1. `.uiverify.json` in the root: URLs, `checkPaths`, breakpoints.
2. A first run and noise calibration — every exclusion carries a comment saying
   why it is intentional.
3. Your first scenario. This is where most of the value is: without one you are
   checking the login screen instead of the working one.
4. The hook and CI, so the rules hold without you.

## The checks

| Script | Question it answers |
|---|---|
| `check-forbidden.sh` | bans in source: leading zeros, inline styles, `vh`, `fetch` without a timeout, internal terms in visible text |
| `verify-ui.mjs` | overlaps, horizontal scroll, text escaping its box, unreachable controls, console, accessibility |
| `verify-states.mjs` | keyboard focus, hover response, contrast in every state |
| `verify-tap.mjs` | touch targets by real tap; `--gestures` — the lost and the double tap |
| `verify-regression.mjs` | did anything break that you did not touch |
| `verify-motion.mjs` | motion budgets, weight, `prefers-reduced-motion` |
| `verify-perf.mjs` | who ate the budget: function, file, frame phase, response components, whether the screen settles |
| `verify-vocabulary.mjs` | how narrow the decision vocabulary is: type sizes, spacing, radii, shadows, colours |

Every browser check accepts `--scenario` — a module that brings the environment
up and drives the app into the state worth checking.

## Limits

- A headless browser on a server is not a real device: no thermal throttling, a
  different GPU, a different network. Heavy graphics still needs a phone before
  hand-off.
- Some failure modes resist automation (focus and the keyboard, layer order,
  "the edit never reaches the server", cache invalidation on user switch) — the
  catalogue says so plainly; those need scenario tests.
- Text-level bans depend on syntax: the vocabulary is configurable for any
  interface language, and rules written around Tailwind classes simply stay
  quiet on other stacks.
