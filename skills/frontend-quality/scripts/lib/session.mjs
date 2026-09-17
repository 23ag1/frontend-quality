/**
 * Shared plumbing for every check: argument parsing, browser launch and — most
 * importantly — SCENARIOS.
 *
 * Why scenarios. A check that merely opens a URL sees the first state of the
 * page: a login screen, an empty list, closed sheets. Real defects live further
 * in: a cart with data, an open sheet, a list of three hundred rows. A scenario
 * is a module that drives the app into the state worth checking and hands the
 * page over.
 *
 * Scenario module contract (any .mjs file):
 *
 *   export const name = 'order-screen';            // label used in reports
 *   export async function open({ throttle, viewport, touch }) {
 *     // Return { browser, context, page } — the scenario decides how to bring
 *     // the environment up: mock the API, set an auth cookie, and so on.
 *   }
 *   export async function ready(page) {}           // drive to the state
 *   export const interactions = [                  // used by verify-perf
 *     { name: 'open the menu', run: async (page) => {} },
 *   ];
 *   export const typeTarget = 'input[type=search]'; // where to measure typing
 *
 * Only `open` OR `url` is required. Everything else is optional.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function loadConfig(args, defaults = {}) {
  const path = resolve(args.config || '.uiverify.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { ...defaults, ...config };
}

/** Every check launches the browser the same way: same flags, same DSF valve. */
export async function launchBrowser() {
  return chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : []),
    ],
  });
}

async function importScenario(modulePath) {
  const full = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  if (!existsSync(full)) throw new Error(`Scenario not found: ${full}`);
  return import(pathToFileURL(full).href);
}

/**
 * A target is always a pair: how to open it and what to call it.
 * It comes from `--url`, from `--scenario`, or from a list in `.uiverify.json`.
 */
export async function resolveTargets(args, config) {
  const targets = [];

  if (args.scenario) {
    targets.push(await makeScenarioTarget(args.scenario, args));
    return targets;
  }

  if (args.url) {
    targets.push(makeUrlTarget(args.url, args, config));
    return targets;
  }

  for (const entry of config.scenarios || []) {
    targets.push(await makeScenarioTarget(entry.module, args, entry));
  }
  for (const url of config.urls || []) {
    targets.push(makeUrlTarget(url, args, config));
  }

  if (!targets.length) {
    throw new Error(
      'Nothing to check. Pass --url or --scenario, or fill in "urls"/"scenarios" in .uiverify.json'
    );
  }
  return targets;
}

function viewportFrom(args, config) {
  const width = Number(args.width || config.width || 1280);
  const height = Number(args.height || config.height || 800);
  return { width, height };
}

function makeUrlTarget(url, args, config) {
  const viewport = viewportFrom(args, config);
  const touch = args.touch === true || args.touch === 'true' || config.touch === true;
  return {
    name: url,
    kind: 'url',
    url,
    async open({ throttle = 1, viewport: override } = {}) {
      const browser = await launchBrowser();
      const context = await browser.newContext({
        viewport: override || viewport,
        hasTouch: touch,
        isMobile: touch,
        deviceScaleFactor: Number(process.env.DSF || 1),
      });
      const page = await context.newPage();
      await applyThrottle(context, page, throttle);
      return { browser, context, page };
    },
    async ready(page) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    },
    interactions: [],
  };
}

async function makeScenarioTarget(modulePath, args, entry = {}) {
  const mod = await importScenario(modulePath);
  if (typeof mod.open !== 'function' && !mod.url) {
    throw new Error(`Scenario ${modulePath} must export open() or url`);
  }
  return {
    name: entry.name || mod.name || modulePath,
    kind: 'scenario',
    module: modulePath,
    url: mod.url || entry.url || null,
    async open(options) {
      if (typeof mod.open === 'function') {
        const opened = await mod.open(options);
        if (!opened?.page) throw new Error(`Scenario ${modulePath}: open() returned no page`);
        await applyThrottle(opened.context || opened.page.context(), opened.page, options.throttle || 1);
        return opened;
      }
      return makeUrlTarget(mod.url, args, {}).open(options);
    },
    async ready(page) {
      if (typeof mod.ready === 'function') return mod.ready(page);
      if (mod.url) await page.goto(mod.url, { waitUntil: 'networkidle', timeout: 60_000 });
    },
    interactions: mod.interactions || [],
    typeTarget: mod.typeTarget || null,
    // The scenario declares its own environment noise: mocks never cover
    // everything, and route prefetching hits addresses that do not exist. That is
    // a property of the harness, not a product defect, so the list lives next to
    // the scenario rather than in the shared config.
    ignoreRequests: mod.ignoreRequests || [],
  };
}

/**
 * CPU throttling is applied AFTER the scenario opens the page. Otherwise setting
 * the environment up (mocks, login) slows down several times over for nothing.
 */
export async function applyThrottle(context, page, rate) {
  if (!rate || rate <= 1) return null;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

/** Close whatever the scenario opened without failing the run on a stray error. */
export async function closeQuietly(opened) {
  try {
    if (opened?.close) return await opened.close();
    if (opened?.browser) return await opened.browser.close();
  } catch {
    /* the browser may already be gone — not a reason to fail the report */
  }
  return undefined;
}
