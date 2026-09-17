# React and Next: what matters on weak hardware

A companion to [the skill body](../SKILL.md). The browser mechanics live in
[perf-playbook.md](perf-playbook.md); this file is only what is specific to React
and Next.

## How React decides what to re-render

React keeps two trees: the current one on screen and a work-in-progress one built
in memory. The work-in-progress tree is walked with a loop rather than recursion,
so the work can be paused, the thread handed back to the browser, and resumed
later. The finished tree replaces the current one in one short synchronous step.

Update priority is encoded as a bit mask — a "lane". Two practical consequences:

1. **Direct input runs on an urgent lane** and is not interrupted. Which is why
   long work inside a press handler is a guaranteed frame delay.
2. **Updates marked as transitions** (`startTransition`, `useDeferredValue`) run on
   an interruptible lane: React will abandon them mid-flight when input arrives and
   recompute later. That is precisely the cure for "the list lags while typing".

Starvation does not happen: a deferred lane has an expiry, after which React
forces it through.

## Techniques in order of payoff

### 1. Separate the urgent from the heavy

```jsx
function MenuSearch({ dishes }) {
  const [query, setQuery] = useState('');
  // The input updates immediately, the list updates when the thread is free.
  const deferred = useDeferredValue(query);
  const filtered = useMemo(() => filterDishes(dishes, deferred), [dishes, deferred]);

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <DishList items={filtered} stale={query !== deferred} />
    </>
  );
}
```

This is the first thing to do when someone says typing lags: a 300-item list stops
being filtered in lockstep with the keystroke and does it when the thread is free.
The signature in a report: `verify-perf` shows a high typing p90 with a short wait
before the handler.

### 2. Stable references at the edge of a list

An object or a function created in the parent's body is new on every render, so
children re-render even when wrapped in `memo`.

```jsx
// Bad: a new object and a new callback on every parent render.
<Row style={{ padding: 8 }} onPick={() => pick(id)} />

// Good: stable references, so the child's memoisation works.
const handlePick = useCallback((rowId) => pick(rowId), [pick]);
<Row className="row" onPick={handlePick} id={id} />
```

An unstable callback has already caused an infinite render loop in production —
this is not a theoretical risk. The React compiler removes part of this chore
automatically, but only where it is enabled and the rules of hooks are respected;
verify the effect by measurement, not by faith.

### 3. Correct keys and the shape of state

An index key with an insertion in the middle makes React reuse the wrong nodes:
instead of inserting one row it re-renders the tail of the list. A key is a stable
identifier of the entity.

State that changes often (typed text, scroll position) must not live in a context
half the application reads: every change re-renders every subscriber. Split
contexts by change frequency.

### 4. List virtualisation

Neither memoisation nor lanes save a list of a thousand rows: the existence of the
nodes is what costs. Virtualisation is the only answer, paired with
`content-visibility` for sections that do not fit a virtual list.

### 5. Effects that hit the frame

`useLayoutEffect` runs synchronously before paint — on weak hardware that adds
directly to frame time. Measuring geometry inside it is doubly bad: that is forced
layout in the hottest possible place. Keep there only what genuinely must happen
before the frame.

Subscriptions in `useEffect` must be torn down: a shift lasts hours and the tab is
never reloaded, so unclosed timers and event streams produce exactly the heap
growth the report shows.

## Next: loading and hydration

On a weak phone the first screen is limited not by the network but by executing
JS: parsing the bundle, building the tree, attaching listeners. In a long-frame
breakdown that appears as one or two scripts of several hundred milliseconds with
the `classic-script` invoker — exactly what the worked run in
[the skill body](../SKILL.md) shows.

What works:

- **Server components.** Logic the client does not need never reaches the bundle:
  the client receives markup, not code.
- **`Suspense` boundaries.** Markup streams and paints immediately while heavy
  client parts come alive separately instead of blocking the whole thread.
- **Dynamic imports** for heavy widgets (maps, charts, editors) — they must not sit
  in the first bundle of a screen.
- **Client components should be few and small.** A `"use client"` at the top of a
  page cancels the point of every server component below it.

## Order of investigation for "it is slow"

1. Take a `verify-perf` run on a production build at the intended throttling.
2. Look at **which phase dominates** the response: waiting, the handler, or
   painting. That alone rules out two thirds of the hypotheses.
3. If waiting — hunt the long task (per-script breakdown, `blockingDuration`).
4. If the handler — see what runs synchronously on press; move the rest into a
   transition or a worker.
5. If painting — count the nodes and see what re-renders: virtualisation,
   `content-visibility`, split contexts, stable props.
6. One change at a time, re-measure with the same script, report "before → after".
