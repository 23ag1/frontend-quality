# The network and the truth on screen

How data travels between the server and the screen without the screen lying. This
is where the most expensive product defects live: not "the margin shifted" but "the
order went through twice" or "the list said empty while the kitchen was busy".
Read it before touching a request, a mutation or a loading state.

## 1. One network layer

Every request goes through one client. It has:

- **a timeout on every request** (`AbortSignal.timeout`; on old engines it needs the
  polyfill from [browser-floor.md](browser-floor.md));
- **cancellation** by key: a new request for the same thing cancels the old one;
- **one error model** — a kind, a code, a status;
- **one translator** from that model to text a person reads.

```ts
export type NetError =
  | { kind: 'offline' }
  | { kind: 'timeout' }                         // outcome unknown, see section 4
  | { kind: 'http'; status: number; code?: string }
  | { kind: 'invalid' }                         // the response failed validation
  | { kind: 'aborted' };                        // we cancelled it ourselves

export function errorText(e: NetError, action: string): string { /* one place */ }
```

**Why.** A dashboard skeleton hung forever: a proxy cut the response mid-flight,
`await res.json()` never settled, and `finally` never ran
([failure-modes.md](failure-modes.md), mode 8). With a client, the fix is one line in
one file; without one it is a hunt through every screen.

**How it is held.** `fetch` outside the client file is banned by a lint rule
(`no-restricted-globals` with an override for that file); `check-forbidden.sh`
flags `fetch` without a signal.

## 2. A response is unknown until it passes the boundary

`res.json() as Order[]` is a promise to the compiler, not a check. A list endpoint
answered with `{ "error": … }` and `.map()` brought the whole page down.

- Parse at the boundary: a schema (zod, valibot) or a hand-written guard. For lists
  at least `Array.isArray`.
- A response that fails is `kind: 'invalid'` in the error model and is shown as an
  error, never as an empty list.
- Hold it with the linter, not a comment. Lists go through one helper that checks
  the shape, and the raw call with an array type is banned:

```js
// eslint.config.mjs — part of no-restricted-syntax
{
  selector: "CallExpression[callee.name='apiGet'] > TSTypeParameterInstantiation > TSArrayType",
  message: 'Lists go through getList<T>(): it checks that an array arrived.',
}
```

## 3. A response has an age

A response to a request sent **before** the person's last edit must not undo that
edit. The general form:

> **The screen = the last server snapshot + the person's unconfirmed intents on
> top.**

- An intent is applied over every snapshot until a snapshot shows it or the server
  rejects it.
- If the downstream system confirms late (a till, a queue, a second service), the
  intent is held for a bounded time **counted from the server's answer**, not from
  the tap.
- **One mechanism for every mutation**, not a guard per action. In one production
  app the same protection against a stale response was written eleven times, eleven
  different ways — and the class of defect kept coming back. One module with one
  rule closed it.

```ts
type Intent<S> = { key: string; apply: (s: S) => S; answeredAt?: number };

const view = <S>(snapshot: S, intents: Intent<S>[]) =>
  intents.reduce((s, i) => i.apply(s), snapshot);
```

The edit counter from [failure-modes.md](failure-modes.md) (mode 9) is the minimal
version of the same idea.

## 4. Mutations: an intent key, and an unknown outcome is not a failure

- **Every mutation carries an intent key** (an idempotency key). A repeated tap
  sends the same key and the server does not create a second entity.
- **"Success" only after the server confirmed.** Not after the press.
- **A timeout is an unknown outcome, not a failure.** The order may well have
  reached the kitchen. "Failed, try again" invites a duplicate. Say "not confirmed
  yet", re-read the state by the intent key, and resend only with the same key.

## 5. The screen never changes by itself seconds later

Showing the result of a tap before the server answers is fine — it is there for the
speed of the tap. What is not fine is any design in which **the screen later changes
without the person doing anything**:

- a rollback three seconds after the tap;
- an offline queue that sends when the connection returns and flips statuses;
- an automatic retry that changes what the person sees;
- a server response that overwrites what was just done.

To the person all of these look like a bug: "I did it, and it undid itself". This
replaces the older rule "optimistic only with a rollback" — a late rollback is
exactly the self-change.

Instead, an **explicit state** on the item: "Not sent" with a "Send again" button.
The person decides. Avoid conflicts rather than reconciling them after the fact.

The question to ask of any optimistic update, retry, queue or sync: **will anything
on this screen change later than instantly, without the person's action?** If yes —
either do not build it, or make it a visible state the person acts on.

Fresh data from other people still arrives on its own (law 2 in
[behaviour-laws.md](behaviour-laws.md)) — but never under a finger, and never over
the person's own pending intent.

## 6. An error is never drawn as "empty"

"Empty" means the server said there is nothing. An error means we do not know. A
failed request shown as "No orders yet" makes the person act on a false picture.

- Offline: keep the last data and say how old it is — **"No connection. Data from
  14:32"**. Actions that need the server are disabled with the reason next to them.
- A refusal is never drawn as success.
- The states — loading, empty, error, offline, retry — are shared components, not
  markup repeated per screen.

## 7. A feature whose endpoint is not deployed yet

The frontend often ships before the backend. On a **404 from a route that does not
exist yet**, the feature shows "not available yet" in its own place ("Similar items
are unavailable right now") — it does not break the screen and does not pretend the
result is empty. To tell "no such route" from "no such entity", the error model
needs the code from the response body, not only the status.

## 8. A save that replaces a whole object

An endpoint that takes the **whole** settings object and replaces it: two features
each saving their own part erase each other. Saving one preference wiped the order
of sections another screen had stored.

- Writes go through one helper that reads the current object, merges the part and
  writes it back; the raw save is not exported.
- A guard test: save part A, save part B, part A is still there.
- Two tabs doing read-merge-write still race. The real fix is a partial update
  (`PATCH`) on the server — name it to the backend as a task.

## 9. Telemetry from the field

Emulation does not show what breaks on the phones people actually hold. Collect it:

- **page errors:** `window` `error` and `unhandledrejection`;
- **hydration errors**, which React reports as recoverable errors rather than
  window errors — capture them where the framework exposes them;
- **the device:** the model through
  `navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion'])` —
  Chrome hides the model in the user-agent string; elsewhere, the string itself;
- **the build:** a build id, or the name of the main chunk if there is none.

Limits, so telemetry never becomes the load: at most 50 events per batch and 200 per
page lifetime, one event up to 4 KB, at most 20 errors per tab lifetime, identical
errors once. Send with `navigator.sendBeacon` on `pagehide`. A backend that does not
know a new event kind yet drops it; the frontend must not break on that.

## 10. A business metric fires at every call that creates the fact

An "ordered" event hung on the Send button. Three other ways to send — another
screen, sending a selection, sending by course — never fired it, and the button
fired it before checking whether printing had failed.

- The metric goes **next to the API call that creates the fact**, after the server
  confirmed it — not on a button.
- A guard test requires it: every file that calls the sending API also calls the
  metric. Show it red once on the old code.

```js
// tests/metric-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';   // globSync: Node 22+

test('every call that sends an order also records the metric', () => {
  const missing = globSync('src/**/*.{ts,tsx}')
    .filter((f) => /\bsendOrder\(/.test(readFileSync(f, 'utf8')))
    .filter((f) => !/\btrackOrdered\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(missing, []);
});
```

## 11. How it is checked

```bash
SK=~/.claude/skills/frontend-quality/scripts
node $SK/verify-races.mjs --scenario ./e2e/scenarios/cart.mjs
```

The scenario lists its `actions` — how to trigger each one and which request it
sends. For every action `verify-races.mjs` runs four probes:

| Probe | What it does | Blocks when |
|---|---|---|
| failure | answers the request with 500 once | the screen shows success, looks like a real success, or shows nothing |
| settle | watches the visible text for 4 s after a success, with no input | the text changes by itself (section 5) |
| double tap | runs the action twice ~60 ms apart while the first request is held | the request is sent twice (section 4) |
| late answer | holds the request 2.5 s while the data refreshes underneath | the final screen differs from a fresh refresh: an older answer won (section 3) |

Two cases it does not cover belong in the end-to-end suite of any screen that writes
data, each shown red once on code without the protection:

- a timeout, after which the server turns out to have done it — no duplicate, no
  "failed" (section 4);
- the connection drops — the last data stays, with its time (section 6); and a new
  endpoint answering 404 — "not available yet", the rest of the screen works
  (section 7).
