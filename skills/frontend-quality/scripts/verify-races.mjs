#!/usr/bin/env node
/**
 * Races: what happens to the screen when the network is not instant.
 *
 * Every defect here looks fine on a developer's machine, where a request answers
 * in 5 ms and nobody taps twice. In the field the answer takes seconds, a second
 * tap lands while the first is in flight, a periodic refresh arrives in the
 * middle, and the request sometimes fails. Four probes per action:
 *
 *   failure      the request is answered with 500 once.
 *                BLOCK if the screen then shows success text (`successText`), if
 *                it looks exactly like the screen after a real success, or if it
 *                shows nothing at all — no error, no retry.
 *   settle       after a successful action the visible text is watched for
 *                `settleMs` (default 4000) with no input.
 *                BLOCK if it changes by itself: a delayed rollback, an
 *                auto-retry, a queue replaying. The diff is printed.
 *   double tap   the action runs twice ~60 ms apart while the first request is
 *                held in flight.
 *                BLOCK if the request is sent twice.
 *   late answer  the request is held for 2.5 s before it reaches the server; in
 *                the meantime the data is refreshed, so an answer that knows
 *                nothing about the action lands on top of it.
 *                BLOCK if, once everything has arrived, the screen differs from
 *                what a fresh refresh shows (an older answer won). FLAG if the
 *                screen went back to the old value while the action was in flight.
 *
 * Scenario contract (on top of scripts/lib/session.mjs: `open` or `url`, `ready`):
 *
 *   export const actions = [
 *     {
 *       name: 'mark the dish',                         // label in the report
 *       run: async (page) => page.click('#mark', { timeout: 1000 }),
 *       request: /POST .*\/api\/mark/,                 // RegExp or URL substring;
 *                                                      // tested on "METHOD url" and on url
 *       settleMs: 4000,                                // optional
 *       readState: async (page) => page.textContent('#dish-1 .status'), // optional, overrides
 *       successText: ['Saved'],                        // optional, overrides
 *     },
 *   ];
 *   export async function readState(page) {}          // a string the late-answer probe compares
 *   export async function refresh(page) {}            // make the app reload its data
 *   export const refresh = /\/api\/state/;           // ...or: the app polls by itself; wait for it
 *   export const refreshRequest = /\/api\/state/;    // optional: what refresh() sends, to await its answer
 *   export const successText = ['Saved', 'Sent'];     // text that means "it worked"
 *   export const settleRoot = 'main';                 // whose text is watched (default main, else body)
 *   export const settleIgnore = ['[data-clock]'];     // live text left out of the settle probe
 *   export async function reset(page) {}              // optional: back to the initial screen
 *                                                      // (default: reload, then ready())
 *
 * Rules for `run`: one user action, nothing more. It must not wait for the
 * control to become enabled again — use a short timeout or { force: true }: the
 * double-tap probe runs it while the first request is still in flight, and the
 * default action timeout is lowered to 1 s there.
 *
 * Text inside [aria-live], [role=status], [role=alert], [role=timer],
 * [role=progressbar] and <time> is left out of the settle probe: a toast that
 * hides itself is not the screen changing its mind. It does count as "the screen
 * said something" in the failure probe.
 *
 * The late-answer probe needs state on the other side: a real backend or a mock
 * that remembers writes. Against a static mock, a fresh refresh can never agree
 * with the action, and the probe says so instead of guessing.
 *
 * Usage:
 *   node verify-races.mjs --scenario ./e2e/scenarios/cart.mjs
 *   node verify-races.mjs --scenario ./e2e/scenarios/cart.mjs --only "mark"
 *
 * Exit: 0 — clean, 1 — violations found, 2 — could not run.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, loadConfig, resolveTargets, closeQuietly } from './lib/session.mjs';

const HOLD_LATE_MS = 2500;
const HOLD_DOUBLE_MS = 1200;
const DOUBLE_GAP_MS = 60;
const FAILURE_WATCH_MS = 2300;
const DEFAULT_SETTLE_MS = 4000;

const LIVE_REGIONS = '[aria-live], [role=status], [role=alert], [role=timer], [role=marquee], [role=progressbar], time';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toMatcher(spec) {
  if (!spec) return null;
  if (typeof spec === 'function') return spec;
  if (spec instanceof RegExp) {
    const re = new RegExp(spec.source, spec.flags.replace('g', ''));
    return (req) => re.test(req.url()) || re.test(`${req.method()} ${req.url()}`);
  }
  const s = String(spec);
  return (req) => req.url().includes(s) || `${req.method()} ${req.url()}`.includes(s);
}

/** Visible text of the whole page, as a list of non-empty lines. */
const bodyLines = (page) =>
  page.evaluate(() =>
    (document.body ? document.body.innerText : '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  );

/** Visible text of the watched root, minus live regions and ignored parts. */
const rootLines = (page, root, ignore) =>
  page.evaluate(
    ({ root, ignore }) => {
      const el = (root && document.querySelector(root)) || document.querySelector('main') || document.body;
      if (!el) return [];
      const split = (t) =>
        (t || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      const lines = split(el.innerText);
      const drop = new Map();
      for (const skip of el.querySelectorAll(ignore)) {
        for (const l of split(skip.innerText)) drop.set(l, (drop.get(l) || 0) + 1);
      }
      return lines.filter((l) => {
        const n = drop.get(l) || 0;
        if (!n) return true;
        drop.set(l, n - 1);
        return false;
      });
    },
    { root, ignore }
  );

/**
 * What changed, readable: line by line when the shape is the same (a value
 * flipped), as removed/added lines when rows appeared or disappeared.
 */
function diffLines(before, after, limit = 6) {
  const out = [];
  if (before.length === after.length) {
    for (let i = 0; i < before.length && out.length < limit; i += 1) {
      if (before[i] === after[i]) continue;
      const context = i > 0 ? ` (after «${before[i - 1]}»)` : '';
      out.push(`«${before[i]}» → «${after[i]}»${context}`);
    }
    return out;
  }
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const a = count(before);
  const b = count(after);
  for (const [l, n] of a) if (n > (b.get(l) || 0)) out.push(`- ${l}`);
  for (const [l, n] of b) if (n > (a.get(l) || 0)) out.push(`+ ${l}`);
  return out.slice(0, limit);
}

const clip = (s) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

async function main() {
  const args = parseArgs(process.argv);
  if (!args.scenario) throw new Error('Pass --scenario: races need actions, see the header of verify-races.mjs');
  const config = loadConfig(args);
  const mod = await import(pathToFileURL(resolve(args.scenario)).href);
  const [target] = await resolveTargets({ scenario: args.scenario }, config);
  const actions = (mod.actions || []).filter((a) => !args.only || a.name.includes(args.only));
  if (!actions.length) throw new Error('The scenario exports no `actions` (or none match --only)');

  const viewport = { width: Number(args.width || 390), height: Number(args.height || 844) };
  const opened = await target.open({ throttle: 1, viewport });
  const { page } = opened;
  const ignore = [LIVE_REGIONS, ...(mod.settleIgnore || [])].join(', ');
  const refreshMatch = toMatcher(mod.refreshRequest || (typeof mod.refresh === 'function' ? null : mod.refresh));

  let blocking = 0;
  let warnings = 0;
  const say = (severity, probe, text, extra = []) => {
    if (severity === 'block') blocking += 1;
    if (severity === 'flag') warnings += 1;
    const mark = severity === 'block' ? 'BLOCK' : severity === 'flag' ? 'FLAG ' : 'ok   ';
    console.log(`  ${mark} ${probe}: ${text}`);
    for (const line of extra) console.log(`          ${line}`);
  };

  const reset = async () => {
    if (typeof mod.reset === 'function') {
      await mod.reset(page);
    } else {
      if (page.url() !== 'about:blank') await page.reload({ waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      await target.ready(page);
    }
    await page.waitForTimeout(250);
  };

  /** Counts matching requests from now on. */
  const watchRequests = (match) => {
    const seen = [];
    const on = (req) => {
      if (match(req)) seen.push(Date.now());
    };
    page.on('request', on);
    return { seen, stop: () => page.off('request', on) };
  };

  const waitForAnswer = (match, timeout) =>
    page.waitForResponse((res) => match(res.request()), { timeout }).catch(() => null);

  /** Make the app reload its data and wait until the answer is on screen. */
  const doRefresh = async (timeout = 3000) => {
    if (typeof mod.refresh === 'function') {
      const answered = refreshMatch ? waitForAnswer(refreshMatch, timeout) : null;
      await mod.refresh(page);
      if (answered) await answered;
      else await page.waitForTimeout(600);
      await page.waitForTimeout(150);
      return true;
    }
    if (refreshMatch) {
      // The app refreshes by itself (polling): wait for the next answer.
      const got = await waitForAnswer(refreshMatch, timeout);
      await page.waitForTimeout(150);
      return Boolean(got);
    }
    return false;
  };

  const runAction = async (action) => {
    try {
      await action.run(page);
      return null;
    } catch (error) {
      return String(error.message).split('\n')[0];
    }
  };

  try {
    await target.ready(page);
    console.log(`\n═══ ${target.name}: ${actions.length} action${actions.length === 1 ? '' : 's'} ═══`);

    for (const action of actions) {
      console.log(`\n── ${action.name} ──`);
      const match = toMatcher(action.request);
      if (!match || typeof action.run !== 'function') {
        say('flag', 'setup', 'the action needs `run` and `request`');
        continue;
      }
      const readState = action.readState || mod.readState || null;
      const successText = action.successText || mod.successText || [];
      const settleMs = Number(action.settleMs || mod.settleMs || DEFAULT_SETTLE_MS);

      // ── failure: one 500, then watch what the screen says ──────────────────
      await reset();
      const beforeFail = await bodyLines(page);
      let injected = false;
      const failRoute = async (route) => {
        if (!injected && match(route.request())) {
          injected = true;
          return route
            .fulfill({ status: 500, contentType: 'application/json', body: '{"error":"injected by verify-races"}' })
            .catch(() => {});
        }
        return route.fallback().catch(() => {});
      };
      await page.route('**/*', failRoute);
      const failCount = watchRequests(match);
      const failError = await runAction(action);
      const failAnswered = Date.now();
      await page.waitForTimeout(300);
      // A flicker of the optimistic value for a few milliseconds is not a
      // message; anything visible from 300 ms on is.
      const appeared = new Set();
      const known = new Set(beforeFail);
      while (Date.now() - failAnswered < FAILURE_WATCH_MS) {
        for (const l of await bodyLines(page)) if (!known.has(l)) appeared.add(l);
        await page.waitForTimeout(250);
      }
      const afterFail = await bodyLines(page);
      failCount.stop();
      await page.unroute('**/*', failRoute);

      if (!injected) {
        say(
          'flag',
          'setup',
          `the action sent no request matching ${action.request}${failError ? ` (run failed: ${failError})` : ''} — fix \`request\` or \`run\`; the other probes need it`
        );
        continue;
      }
      const saidSuccess = successText.filter(
        (t) => afterFail.some((l) => l.includes(t)) && !beforeFail.some((l) => l.includes(t))
      );
      const retried = failCount.seen.length > 1;
      let failVerdict = null;
      if (saidSuccess.length) {
        failVerdict = ['block', `after a failed request the screen says «${saidSuccess.join('», «')}»`];
      } else if (!appeared.size && !retried) {
        failVerdict = ['block', 'nothing on screen says it failed — no error, no retry; the action silently did not happen'];
      } else if (retried) {
        failVerdict = ['ok', `retried (${failCount.seen.length} requests)`];
      } else {
        failVerdict = ['ok', `the screen said «${clip([...appeared].join(' / '))}»`];
      }
      say(failVerdict[0], 'failure (500 once)', failVerdict[1]);

      // ── settle: a successful action, then no input at all ──────────────────
      await reset();
      const beforeSuccess = await bodyLines(page);
      const answered = waitForAnswer(match, 15_000);
      const okError = await runAction(action);
      await answered;
      await page.waitForTimeout(300);
      const afterSuccess = await bodyLines(page);
      const first = await rootLines(page, mod.settleRoot, ignore);
      const firstKey = first.join('\n');
      const started = Date.now();
      let change = null;
      while (Date.now() - started < settleMs) {
        await page.waitForTimeout(200);
        const now = await rootLines(page, mod.settleRoot, ignore);
        if (!change && now.join('\n') !== firstKey) {
          change = { at: Date.now() - started, lines: now };
        }
      }
      const last = await rootLines(page, mod.settleRoot, ignore);
      if (okError) say('flag', 'settle', `run failed: ${okError}`);
      if (change) {
        const extra = diffLines(first, change.lines);
        if (last.join('\n') !== change.lines.join('\n')) extra.push('(and changed again before the end of the wait)');
        say(
          'block',
          `settle ${(settleMs / 1000).toFixed(1)} s`,
          `the screen changed by itself ${(change.at / 1000).toFixed(1)} s after the action finished — a delayed rollback, retry or queue; show an explicit state instead`,
          extra
        );
      } else {
        say('ok', `settle ${(settleMs / 1000).toFixed(1)} s`, 'nothing changed by itself');
      }

      // A failure that looks exactly like a success, from the same starting screen.
      if (
        failVerdict[0] === 'ok' &&
        !retried &&
        beforeFail.join('\n') === beforeSuccess.join('\n') &&
        afterFail.join('\n') === afterSuccess.join('\n') &&
        afterFail.join('\n') !== beforeFail.join('\n')
      ) {
        say('block', 'failure (500 once)', 'the screen after the failed request is identical to the screen after a successful one');
      }

      // ── double tap: two runs ~60 ms apart, the first request held in flight ─
      await reset();
      const holdDouble = async (route) => {
        if (match(route.request())) await sleep(HOLD_DOUBLE_MS);
        return route.fallback().catch(() => {});
      };
      await page.route('**/*', holdDouble);
      await page.evaluate(() => {
        window.__racesTaps = [];
        window.addEventListener('pointerdown', () => window.__racesTaps.push(performance.now()), { capture: true });
      });
      const doubleCount = watchRequests(match);
      page.setDefaultTimeout(1000);
      const one = runAction(action);
      await sleep(DOUBLE_GAP_MS);
      const two = runAction(action);
      await Promise.all([one, two]);
      page.setDefaultTimeout(30_000);
      await page.waitForTimeout(HOLD_DOUBLE_MS + 300);
      doubleCount.stop();
      await page.unroute('**/*', holdDouble);
      const taps = await page.evaluate(() => window.__racesTaps || []).catch(() => []);
      const gap = taps.length >= 2 ? `${Math.round(taps[1] - taps[0])} ms apart` : `~${DOUBLE_GAP_MS} ms apart`;
      if (doubleCount.seen.length > 1) {
        say(
          'block',
          'double tap',
          `two taps ${gap} sent the request ${doubleCount.seen.length} times — ignore the action while its request is in flight`
        );
      } else {
        say('ok', 'double tap', `two taps ${gap}: ${doubleCount.seen.length} request`);
      }

      // ── late answer: held 2.5 s, data refreshed in the meantime ────────────
      if (!readState || (typeof mod.refresh !== 'function' && !refreshMatch)) {
        say('skip', 'late answer', 'skipped — the scenario exports no readState or no refresh');
        continue;
      }
      await reset();
      const stateBefore = await readState(page);
      let held = false;
      const holdLate = async (route) => {
        if (!held && match(route.request())) {
          held = true;
          await sleep(HOLD_LATE_MS);
        }
        return route.fallback().catch(() => {});
      };
      await page.route('**/*', holdLate);
      const lateAnswer = waitForAnswer(match, HOLD_LATE_MS + 10_000);
      await runAction(action);
      await page.waitForTimeout(250);
      const optimistic = await readState(page);
      const refreshed = await doRefresh(HOLD_LATE_MS - 500);
      const mid = await readState(page);
      await lateAnswer;
      await page.waitForTimeout(800);
      const shown = await readState(page);
      await page.unroute('**/*', holdLate);
      // The truth: a fresh refresh with nothing in flight.
      await doRefresh(5000);
      const truth = await readState(page);

      if (!refreshed) {
        say('flag', 'late answer', 'no refresh happened during the delay — check `refresh` / `refreshRequest`');
      } else if (truth === stateBefore && optimistic !== stateBefore) {
        say('flag', 'late answer', `fresh data still says «${clip(truth)}» after the action — the backend or mock does not keep writes, the probe cannot judge`);
      } else if (shown !== truth) {
        say(
          'block',
          'late answer',
          `once everything arrived the screen shows «${clip(shown)}», fresh data says «${clip(truth)}» — an answer that knew nothing about the action overwrote it`,
          [`before «${clip(stateBefore)}» → after the tap «${clip(optimistic)}» → after the refresh «${clip(mid)}» → final «${clip(shown)}»`]
        );
      } else if (optimistic !== stateBefore && mid === stateBefore) {
        say(
          'flag',
          'late answer',
          `while the request was in flight the refresh put the old value back («${clip(optimistic)}» → «${clip(mid)}» → «${clip(shown)}») — keep unconfirmed actions on top of fresh data`
        );
      } else {
        say('ok', 'late answer', `held ${HOLD_LATE_MS / 1000} s with a refresh in between: «${clip(shown)}» matches fresh data`);
      }
    }
  } finally {
    await closeQuietly(opened);
  }

  console.log(`\nBlocking: ${blocking} | warnings: ${warnings}`);
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
