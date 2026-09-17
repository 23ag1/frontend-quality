# Adopting this on your own project

The kit was written on one particular application, but almost all of it is made of
things that do not depend on a project: the browser, the frame pipeline, the
finger, the keyboard and the human eye. This file is how to carry it over to any
frontend in about an hour, and what to tune for your stack.

The order matters: steps 1–3 pay off immediately, step 4 pays the most, steps 5–7
make sure the rules do not drift apart in a month.

## Step 1. Install (5 minutes)

Run `install.sh` from the plugin root — with `--dry-run` first to see what it would
do.

The skills land in `~/.claude/skills`, the acceptance agent in `~/.claude/agents`,
the hook in `~/.claude/hooks`. Playwright and axe are installed **inside the
skill**: not a single dependency is added to your project, and the scripts run from
any directory.

Check that it is alive:

```bash
SK=~/.claude/skills/frontend-quality/scripts
node $SK/verify-ui.mjs --url https://example.com/
```

## Step 2. The project config (10 minutes)

```bash
cp ~/.claude/skills/frontend-quality/reference/uiverify.example.json .uiverify.json
```

Four fields need filling in; the rest have sensible defaults:

- `urls` — addresses reachable without signing in;
- `checkPaths` — where your source lives. **This matters more than it looks:** if
  the repository holds legacy code, bans over the whole tree produce hundreds of
  findings and the check gets switched off on day one. Start with one directory you
  are ready to keep green and expand from there;
- `breakpoints` — the widths you actually live at (do not forget a low viewport,
  390×640: that is where unreachable buttons surface);
- `ignoreConsole` — noise from third-party scripts (analytics, blockers).

If your interface is not in English, set `lexicon` and `lexiconFields`: the
built-in vocabulary of internal terms is English, and your own list replaces it.

## Step 3. The first run and noise calibration (20 minutes)

```bash
bash  $SK/check-forbidden.sh <your directory>
node $SK/verify-ui.mjs     --config .uiverify.json
node $SK/verify-states.mjs --url <your address>
```

The first run is almost always noisy. That is normal: the check does not know what
you intended. How to work through it:

| Finding | What to do |
|---|---|
| A decorative element overlapping text | add the selector to `ignoreOverlap` with a comment saying why it is intended |
| "Contrast not measured: background is an image" | check by eye; this is an honest "I do not know", not a violation |
| 40×40 targets in a dense panel | decide knowingly: either it is the norm for your product, or fix it |
| Raw HEX in a theme file | theme files are already excluded; if not, narrow `checkPaths` |

The calibration rule: **an exclusion comes with a comment saying why it is
intended.** An unexplained exclusion is indistinguishable from a forgotten bug a
month later.

## Step 4. A scenario — the main step

A check pointed at an address sees the first state of the app: the login screen, an
empty list, closed dialogs. Real defects live behind the sign-in. A scenario is a
module that drives the app to the working screen.

The template is [scenario.example.mjs](../../../templates/scenario.example.mjs).
The minimum is three exports:

```js
export const name = 'cart with items';
export async function open() { /* launch the browser, mock the API, sign in */ }
export async function ready(page) { /* drive to the screen */ }
```

If you already have an e2e suite, the scenario is ten lines on top of it: reuse the
function that signs in and opens the screen.

```bash
node $SK/verify-tap.mjs  --scenario ./e2e/scenarios/cart.mjs
node $SK/verify-perf.mjs --scenario ./e2e/scenarios/cart.mjs --throttle 20
```

The difference in payoff is large: on the project this was built on, checking by
address produced almost no findings, while the same set through a scenario with
real data immediately showed 206 ms of forced layout and a 76 ms delay before the
handler.

## Step 5. The gate (5 minutes)

The presence of `.uiverify.json` switches the Stop hook on: a turn will not close
while the check is red. The hook needs to be registered once in
`~/.claude/settings.json` — the install script prints the JSON snippet.

Keep the gate fast: no heavy scenarios in it, addresses only. A gate that takes a
minute to answer gets switched off.

## Step 6. CI (15 minutes)

The template is
[frontend-quality.ci.yml](../../../templates/frontend-quality.ci.yml). A sensible
split:

- **blocks the pull request**: bans, lint, tests, `verify-ui` — these are
  deterministic;
- **warns**: performance budgets. Numbers drift on a shared runner; move them to
  blocking after two or three weeks of watching the spread.

## Step 7. Regression baselines (10 minutes)

```bash
node $SK/verify-regression.mjs --config .uiverify.json --update
```

Baselines are committed with the code — otherwise there is nothing to compare
against. Live data (clocks, counters, avatars) is masked by selectors in
`ignoreDiff`, otherwise "the clock ticked" reads as breakage.

## What depends on the stack

The browser checks work everywhere: they look at the rendered page and do not know
what built it. Text-level bans are partly tied to syntax.

| Check | React / JSX | Vue | Svelte | Plain HTML | Tailwind needed |
|---|---|---|---|---|---|
| `verify-ui`, `verify-states`, `verify-tap`, `verify-regression`, `verify-motion`, `verify-perf`, `verify-vocabulary` | yes | yes | yes | yes | no |
| Bans: leading zero, `style="..."`, `!important`, `vh`, internal terms, dash placeholder | yes | yes | yes | yes | no |
| `fetch` without a timeout | yes | yes | yes | yes | no |
| Mixed `click` and `touch` with `stopPropagation` | yes | yes | yes | yes | no |
| Fixed height `h-[240px]` | yes | yes | yes | no | **yes** |
| Half-step spacing off the grid | yes | yes | yes | no | **yes** |

Extending a rule to your own syntax is one line in `check-forbidden.sh`. That is
the mechanism: the rule lives in the script, not in a person's memory.

## What not to copy verbatim

Some of the numbers belong to one product rather than yours:

- **A 4pt grid** is a choice made for a dense point-of-sale screen. In a marketing
  interface take 8pt.
- **"Copy the industry reference, do not improve on it"** is a rule for a tool
  someone uses all shift and cannot afford to relearn. For a new product with no
  incumbent it is harmful advice.
- **Performance budgets**: the goal of "60 frames at ×20 throttling" exists because
  the application lives on cheap phones in a working environment. For an internal
  admin panel on office laptops that is overkill: take ×4 and the `landing` profile.
- **The failure examples** in [failure-modes.md](failure-modes.md) are described on
  one interface, but the mechanisms are universal: the lost tap, a sticky bar
  inside a scroller, an infinite re-render, a loading skeleton that never leaves.

What transfers unchanged: the rubric, the order of work, the mechanical checks, the
arithmetic of the frame budget, the layout teardowns, and the requirement to say
"done" only after a measurement.

## A realistic first week

1. Day 1 — steps 1–3: install, configure, work through the noise in one directory.
2. Day 2 — step 4: one scenario for the busiest screen.
3. Day 3 — run `verify-perf` on that scenario and file what it finds; do not fix it
   immediately, see the whole picture first.
4. Day 4 — the gate and CI.
5. Day 5 — regression baselines and your first entry in the failure catalogue.

By the end of the week you have something few teams have: rules a machine checks,
rather than rules that depend on memory and good intentions.
