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
 *   export const url = 'http://localhost:3000/';   // instead of open(), when no setup is needed
 *   export async function open({ throttle, viewport, touch, launch, engine }) {
 *     // Return { browser, context, page } — the scenario decides how to bring
 *     // the environment up: mock the API, set an auth cookie, and so on.
 *     // `launch()` starts the engine chosen by FQ_BROWSER / --browser; a scenario
 *     // that calls chromium.launch() itself always runs on Chromium.
 *   }
 *   export async function ready(page) {}           // drive to the state
 *   export const interactions = [                  // used by verify-perf
 *     { name: 'open the menu', run: async (page) => {} },
 *   ];
 *   export const typeTarget = 'input[type=search]'; // where to measure typing
 *   export const ignoreConsole = ['ResizeObserver loop'];   // harness noise in the console
 *   export const ignoreRequests = ['/_next/data/'];         // harness noise in the network
 *   export const keyboardTargets = [                // used by verify-keyboard
 *     { name: 'search sheet', open: async (page) => {}, field: 'input[type=search]', inside: '[role=dialog]' },
 *   ];
 *
 * Only `open` OR `url` is required. Everything else is optional.
 *
 * Engine. Every check runs on the engine chosen by FQ_BROWSER (or --browser):
 * chromium (default), webkit or firefox. FQ_CHROME_PATH (or --chrome-path) runs a
 * specific Chromium build, e.g. an old one from scripts/fetch-chromium.sh. The
 * engine name and version are printed before the report. Features that exist only
 * in the Chrome DevTools Protocol (CPU throttling, real touch dispatch, tracing)
 * are skipped on other engines with one "skipped on <engine>: <feature>" line —
 * never silently, so an unthrottled run cannot pass for a throttled one.
 */

import { chromium, webkit, firefox } from 'playwright';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
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

// ─── Engine ──────────────────────────────────────────────────────────────────

const ENGINES = { chromium, webkit, firefox };

/**
 * Which engine to run: flags win over the environment, the environment over the
 * default. Read from process.argv on every call, so scripts that never pass their
 * arguments here still honour --browser and --chrome-path.
 */
export function engineOptions(args = parseArgs(process.argv)) {
  const flag = typeof args.browser === 'string' ? args.browser : null;
  const name = String(flag || process.env.FQ_BROWSER || 'chromium').toLowerCase();
  if (!ENGINES[name]) {
    throw new Error(`Unknown browser "${name}": use chromium, webkit or firefox`);
  }
  const pathFlag = typeof args['chrome-path'] === 'string' ? args['chrome-path'] : null;
  const chromePath = pathFlag || process.env.FQ_CHROME_PATH || null;
  if (chromePath && name !== 'chromium') {
    throw new Error(`FQ_CHROME_PATH / --chrome-path is a Chromium build, but the engine is ${name}`);
  }
  if (chromePath && !existsSync(chromePath)) {
    throw new Error(
      `Chromium not found at ${chromePath} (scripts/fetch-chromium.sh <major> downloads one and prints its path)`
    );
  }
  return { name, chromePath };
}

/** Every check launches the browser the same way: same flags, same DSF valve. */
export async function launchBrowser() {
  const { name, chromePath } = engineOptions();
  const options =
    name === 'chromium'
      ? {
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : []),
          ],
          ...(chromePath ? { executablePath: chromePath } : {}),
        }
      : {};
  try {
    return await ENGINES[name].launch(options);
  } catch (error) {
    if (/Executable doesn't exist/i.test(error.message)) {
      throw new Error(
        `${name} is not installed for Playwright — run \`npx playwright install ${name}\` in skills/frontend-quality`
      );
    }
    throw error;
  }
}

/**
 * Context options that every engine accepts. Firefox has no mobile viewport mode
 * in Playwright (isMobile throws there), so it gets a phone-sized window with
 * touch but without the meta-viewport emulation — said once in the engine line.
 */
export function contextOptions({ viewport, touch }) {
  const { name } = engineOptions();
  return {
    viewport,
    hasTouch: Boolean(touch),
    ...(name === 'firefox' ? {} : { isMobile: Boolean(touch) }),
    deviceScaleFactor: Number(process.env.DSF || 1),
  };
}

/** The engine actually behind a page — a scenario may have launched its own. */
export function engineOf(page) {
  try {
    const browser = page.context().browser();
    if (browser) return { name: browser.browserType().name(), version: browser.version() };
  } catch {
    /* a persistent context has no browser object */
  }
  return { name: engineOptions().name, version: 'unknown' };
}

let announced = false;

/** One line before the report: which engine, which version, from where. */
export function announceEngine(page) {
  if (announced) return;
  announced = true;
  const requested = engineOptions();
  const actual = engineOf(page);
  const source =
    actual.name === 'chromium' && requested.chromePath ? `from ${requested.chromePath}` : 'bundled with Playwright';
  console.log(`Engine: ${actual.name} ${actual.version} (${source})`);
  if (actual.name !== requested.name) {
    console.log(
      `  note: ${requested.name} was requested, but the scenario launched ${actual.name} itself — use the launch() it receives in open()`
    );
  }
  if (actual.name === 'firefox') {
    console.log('  note: Firefox has no mobile viewport mode in Playwright — phone sizes run as a narrow desktop window');
  }
}

const skippedFeatures = new Set();

/** "skipped on webkit: CPU throttle ×4" — once per feature, never silently. */
export function reportSkipped(engine, feature) {
  const key = `${engine}:${feature}`;
  if (skippedFeatures.has(key)) return;
  skippedFeatures.add(key);
  console.log(`skipped on ${engine}: ${feature}`);
}

/**
 * A CDP session, or null with a "skipped on" line when the engine has none.
 * Callers MUST treat null as "not measured", never as "measured and fine".
 */
export async function openCDP(context, page, feature) {
  const { name } = engineOf(page);
  if (name !== 'chromium') {
    reportSkipped(name, feature);
    return null;
  }
  return context.newCDPSession(page);
}

// ─── Targets ─────────────────────────────────────────────────────────────────

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
  // A wrong engine name or a missing Chromium build fails before anything opens.
  engineOptions();
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
      const context = await browser.newContext(contextOptions({ viewport: override || viewport, touch }));
      const page = await context.newPage();
      announceEngine(page);
      await applyThrottle(context, page, throttle);
      return { browser, context, page };
    },
    async ready(page) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    },
    interactions: [],
    typeTarget: null,
    ignoreConsole: [],
    ignoreRequests: [],
    keyboardTargets: [],
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
    async open(options = {}) {
      if (typeof mod.open === 'function') {
        const opened = await mod.open({ ...options, launch: launchBrowser, engine: engineOptions().name });
        if (!opened?.page) throw new Error(`Scenario ${modulePath}: open() returned no page`);
        announceEngine(opened.page);
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
    // a property of the harness, not a product defect, so the lists live next to
    // the scenario rather than in the shared config. Both must travel with the
    // target — a dropped list turns harness noise into BLOCK findings.
    ignoreConsole: mod.ignoreConsole || [],
    ignoreRequests: mod.ignoreRequests || [],
    keyboardTargets: mod.keyboardTargets || [],
  };
}

/**
 * CPU throttling is applied AFTER the scenario opens the page. Otherwise setting
 * the environment up (mocks, login) slows down several times over for nothing.
 * Returns the CDP session, or null when nothing was throttled (rate 1, or an
 * engine without CDP — then a "skipped on" line has been printed).
 */
export async function applyThrottle(context, page, rate) {
  if (!rate || rate <= 1) return null;
  const cdp = await openCDP(context, page, `CPU throttle ×${rate} (timings are unthrottled)`);
  if (!cdp) return null;
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

// ─── Screenshots an agent can read ───────────────────────────────────────────

// Agents stall on images over about 5 MB and refuse very long sides. A full-page
// shot of a long screen at DSF 2 crosses both easily, and then the one artefact
// meant for "look at it yourself" cannot be looked at.
export const PREVIEW_MAX_BYTES = 4.5 * 1024 * 1024;
export const PREVIEW_MAX_SIDE = 7000;
export const PREVIEW_TARGET_SIDE = 2000;

/** PNG width and height straight from the IHDR chunk — no image library needed. */
export function pngSize(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(24);
    readSync(fd, head, 0, 24, 0);
    if (head.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/**
 * For a PNG too large for an agent, writes `<name>.preview.jpg` next to it (at
 * most 2000 px on the long side) and returns its path; otherwise returns null.
 * The browser itself does the scaling, in a separate context, so the page under
 * test is not touched.
 */
export async function ensurePreview(pngPath, page) {
  if (!existsSync(pngPath)) return null;
  const bytes = statSync(pngPath).size;
  const size = pngSize(pngPath);
  if (!size) return null;
  if (bytes <= PREVIEW_MAX_BYTES && Math.max(size.width, size.height) <= PREVIEW_MAX_SIDE) return null;

  const scale = Math.min(1, PREVIEW_TARGET_SIDE / size.height, PREVIEW_TARGET_SIDE / size.width);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const previewPath = pngPath.replace(/\.png$/i, '') + '.preview.jpg';

  const browser = page.context().browser();
  const context = browser ? await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 }) : null;
  const scratch = context ? await context.newPage() : await page.context().newPage();
  try {
    if (!context) await scratch.setViewportSize({ width, height });
    const data = readFileSync(pngPath).toString('base64');
    await scratch.setContent(
      `<!doctype html><body style="margin:0"><img style="display:block;width:${width}px;height:${height}px" src="data:image/png;base64,${data}"></body>`
    );
    await scratch.evaluate(() => document.images[0].decode());
    await scratch.screenshot({ path: previewPath, type: 'jpeg', quality: 80 });
  } finally {
    await (context ? context.close() : scratch.close()).catch(() => {});
  }
  return previewPath;
}

/** page.screenshot plus the preview rule. Returns { path, preview } (preview may be null). */
export async function writeScreenshot(page, path, options = {}) {
  await page.screenshot({ ...options, path });
  const preview = await ensurePreview(path, page).catch((error) => {
    console.log(`  note: could not write a preview for ${path}: ${error.message}`);
    return null;
  });
  return { path, preview };
}
