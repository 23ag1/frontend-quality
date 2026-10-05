/**
 * SCENARIO TEMPLATE. Copy it over, fix three places, delete the rest.
 *
 * Why it exists. A check pointed at a URL sees the first state of the app —
 * usually the login screen. Real defects live behind it: a list with data, an
 * open dialog, a form with errors. A scenario drives the app there and hands the
 * page to the checks.
 * Used by every browser check:
 *   SK=~/.claude/skills/frontend-quality/scripts
 *   node $SK/verify-ui.mjs   --scenario ./e2e/scenarios/cart.mjs
 *   node $SK/verify-tap.mjs  --scenario ./e2e/scenarios/cart.mjs --gestures
 *   node $SK/verify-perf.mjs --scenario ./e2e/scenarios/cart.mjs --throttle 20
 *   node $SK/verify-races.mjs --scenario ./e2e/scenarios/cart.mjs
 *   node $SK/verify-keyboard.mjs --scenario ./e2e/scenarios/cart.mjs
 *
 * Only `open` is required (or an exported `url`, if no login is needed).
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';

/** How the screen is labelled in reports. */
export const name = 'cart with items';

/** Where to measure input latency. No input field — delete this line. */
export const typeTarget = 'input[type="search"]';

/**
 * Environment noise, not product defects: mocks never cover everything, route
 * prefetching hits addresses that do not exist, analytics gets blocked. Anything
 * that belongs to the harness is declared here, not in the shared config.
 */
export const ignoreConsole = [];
export const ignoreRequests = [];

/**
 * Bring the environment up. Three typical jobs here: mock the API (so the data is
 * stable), set the sign-in marker and open the page.
 *
 * If you already have an e2e suite, do not write this twice: import your own
 * function that launches the browser with mocks and return its result.
 */
export async function open({ launch } = {}) {
  // `launch` starts the engine chosen by FQ_BROWSER / --browser (Chromium, the
  // Safari engine, an old Chromium); fall back to Chromium when run on its own.
  const browser = launch
    ? await launch()
    : await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  // 1. Data. A stable response beats a real one: the check must not depend on
  //    whatever happens to be in the database today.
  await context.route('**/api/cart', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: Array.from({ length: 30 }, (_, i) => ({
          id: i + 1,
          // A long title is a required case, not an exception: this is exactly
          // where cards fall apart.
          title: `Item ${i + 1} with a fairly long title that exercises wrapping`,
          price: 100 * (i + 1),
        })),
      }),
    })
  );

  // 2. Sign-in. A cookie or localStorage, depending on how your auth works.
  await context.addCookies([{ name: 'session', value: 'test', url: BASE }]);

  const page = await context.newPage();
  return { browser, context, page };
}

/** Drive to the state under test. Wait for real data here, too. */
export async function ready(page) {
  await page.goto(`${BASE}/cart`, { waitUntil: 'networkidle', timeout: 60_000 });
  // Wait for the data to appear rather than for a guessed timeout: otherwise the
  // check sometimes captures an empty screen and reports that all is well.
  await page.waitForSelector('[data-cart-row]', { timeout: 20_000 }).catch(() => {});
}

/**
 * What to do on the screen to measure responsiveness. Every action must be
 * reversible or safe: the scenario runs many times in a row.
 */
export const interactions = [
  {
    name: 'open the filters',
    run: async (page) => {
      await page.locator('[aria-label="Filters"]').first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape').catch(() => {});
    },
  },
  {
    name: 'scroll the list',
    run: async (page) => {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(300);
    },
  },
];

/**
 * Races (verify-races.mjs): one user action each, the request it sends, and how
 * to read and reload what the screen claims. The checks tap it twice, delay and
 * reorder its answer, fail it once, and watch the screen settle.
 */
export const actions = [
  {
    name: 'add the first item',
    run: (page) => page.click('[data-cart-row] [aria-label="Add"]', { timeout: 1000 }),
    request: /POST .*\/api\/cart/, // the request this action sends
    settleMs: 4000, // how long the screen must stay still afterwards
  },
];
/** What the late-answer probe compares. */
export const readState = (page) => page.textContent('[data-cart-row] [data-qty]');
/** How the data is reloaded (or a RegExp: the app polls by itself). */
export const refresh = (page) => page.click('[aria-label="Refresh"]');
export const refreshRequest = /\/api\/cart$/;
/** Text that must never appear after a failed request. */
export const successText = ['Added', 'Saved'];

/**
 * Keyboard (verify-keyboard.mjs): forms and sheets opened with the on-screen
 * keyboard up, in both models — the window shrinks, or the bottom is covered.
 */
export const keyboardTargets = [
  {
    name: 'quantity sheet',
    open: async (page) => { await page.click('[data-cart-row] [data-qty]'); },
    field: 'input[aria-label="Quantity"]', // must stay visible above the keyboard
    inside: '[role="dialog"]', // taps inside must keep the keyboard and the height
  },
];
