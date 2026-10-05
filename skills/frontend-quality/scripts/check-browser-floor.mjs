#!/usr/bin/env node
/**
 * Static scan for CSS and JavaScript features newer than the project's browser
 * floor — the oldest engines its real visitors use.
 *
 * Why. A bundler's default targets are not your visitors: Next.js compiles for
 * Chrome 111 / Safari 16.4, while a quarter of one venue's devices ran Chrome 106.
 * There `height: 100dvh` dropped the whole declaration and a sheet lost its
 * height; `AbortSignal.any` threw and a card never loaded; without a polyfill for
 * `AbortSignal.timeout` no request left Safari 15 at all. None of it shows on the
 * developer's laptop.
 *
 * Usage:
 *   node check-browser-floor.mjs [path …] [--config .uiverify.json] [--floor chrome=106,safari=15]
 *
 * Paths: the arguments, else "checkPaths" from .uiverify.json, else ./src or ".".
 * Floor: --floor, else "browserFloor" in .uiverify.json, else the nearest
 * package.json "browserslist" (or .browserslistrc). The source is printed.
 *
 * Severity:
 *   BLOCK — the feature is above the floor and no fallback is visible: the
 *           oldest engine will break.
 *   FLAG  — a fallback exists but cannot be proven from text (a typeof / `in`
 *           check near the call, an earlier declaration of the same property,
 *           which a minifier may collapse), or the feature only degrades
 *           (a transition of grid-template-rows becomes a jump).
 *   silent — the use sits inside an @supports block that tests the same feature
 *           (the engine evaluates the guard itself; nothing to verify), a
 *           var(--x, 100dvh) whose variable the code sets, a Tailwind class
 *           redefined in @supports not (…), or an API polyfilled by a first
 *           script carrying the marker comment `frontend-quality:compat`
 *           (see templates/compat-script.js) or by Next.js itself. Polyfilled
 *           APIs are listed once at the top of the report.
 *
 * Exit: 0 — no blocking findings, 1 — blocking findings, 2 — could not run
 * (no floor declared: every modern feature would be "above" nothing).
 *
 * The scan reads text, not an AST: a regex can be fooled by a string that looks
 * like code, and the support table is built in (update it when the floor moves).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// ----------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const opts = { paths: [], config: null, floor: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--config') opts.config = argv[++i];
  else if (a === '--floor') opts.floor = argv[++i];
  else if (a === '-h' || a === '--help') {
    console.log('node check-browser-floor.mjs [path …] [--config file] [--floor chrome=106,safari=15]');
    process.exit(0);
  } else opts.paths.push(a);
}

// -------------------------------------------------------------------- config
function findUp(start, name) {
  let d = resolve(start);
  if (existsSync(d) && !statSync(d).isDirectory()) d = dirname(d);
  for (;;) {
    const p = join(d, name);
    if (existsSync(p)) return p;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const envConfig = process.env.UIVERIFY_CONFIG;
let configPath = null;
if (opts.config) configPath = resolve(opts.config);
else if (envConfig === 'none') configPath = null;
else if (envConfig) configPath = resolve(envConfig);
else if (existsSync('.uiverify.json')) configPath = resolve('.uiverify.json');
else if (opts.paths[0]) configPath = findUp(opts.paths[0], '.uiverify.json');
const config = (configPath && readJson(configPath)) || {};
const configDir = configPath ? dirname(configPath) : process.cwd();

let roots = opts.paths.map((p) => resolve(p));
if (!roots.length && Array.isArray(config.checkPaths) && config.checkPaths.length) {
  roots = config.checkPaths.map((p) => resolve(configDir, p));
}
if (!roots.length) roots = [existsSync('src') ? resolve('src') : resolve('.')];
roots = roots.filter((r) => existsSync(r));
if (!roots.length) {
  console.error('check-browser-floor: none of the given paths exist.');
  process.exit(2);
}

// --------------------------------------------------------------------- floor
function parseBrowserslist(queries) {
  const text = queries.join(' , ');
  const cs = [...text.matchAll(/\bchrome\s*(>=|>)?\s*(\d+)/gi)].map((m) => Number(m[2]) + (m[1] === '>' ? 1 : 0));
  const ss = [...text.matchAll(/\b(?:safari|ios_saf|ios)\s*(?:>=|>)?\s*(\d+(?:\.\d+)?)/gi)].map((m) => Number(m[1]));
  return { chrome: cs.length ? Math.min(...cs) : null, safari: ss.length ? Math.min(...ss) : null };
}

function browserslistFrom(start) {
  let d = resolve(start);
  if (existsSync(d) && !statSync(d).isDirectory()) d = dirname(d);
  for (;;) {
    const rc = join(d, '.browserslistrc');
    if (existsSync(rc)) {
      const q = readFileSync(rc, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*[#[]/.test(l));
      return { queries: q, where: rc };
    }
    const pkgPath = join(d, 'package.json');
    if (existsSync(pkgPath)) {
      let bl = readJson(pkgPath)?.browserslist;
      if (bl && !Array.isArray(bl) && typeof bl === 'object') bl = bl.production || Object.values(bl).flat();
      if (typeof bl === 'string') bl = [bl];
      return bl && bl.length ? { queries: bl, where: pkgPath } : null;
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

let floor = null;
let floorSource = '';
if (opts.floor) {
  floor = { chrome: null, safari: null };
  for (const part of opts.floor.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim().toLowerCase());
    if (k in floor && v) floor[k] = Number(v);
  }
  floorSource = '--floor';
} else if (config.browserFloor && typeof config.browserFloor === 'object') {
  floor = { chrome: config.browserFloor.chrome ?? null, safari: config.browserFloor.safari ?? null };
  floorSource = `browserFloor in ${relative(process.cwd(), configPath) || basename(configPath)}`;
} else {
  const bl = browserslistFrom(roots[0]);
  if (bl) {
    floor = parseBrowserslist(bl.queries);
    floorSource = `browserslist in ${relative(process.cwd(), bl.where)}`;
  }
}
if (!floor || (floor.chrome == null && floor.safari == null)) {
  console.log(
    'check-browser-floor: no browser floor declared' +
      (floorSource ? ` (${floorSource} names neither chrome nor safari)` : '') +
      '.\nSet "browserFloor": {"chrome": 106, "safari": 15} in .uiverify.json — taken from real traffic, ' +
      'not from the bundler default — or a browserslist, or pass --floor chrome=106,safari=15.',
  );
  process.exit(2);
}
const floorText = [floor.chrome != null && `Chrome ${floor.chrome}`, floor.safari != null && `Safari ${floor.safari}`]
  .filter(Boolean)
  .join(' / ');

const nearestPkgPath = findUp(roots[0], 'package.json');
const nearestPkg = (nearestPkgPath && readJson(nearestPkgPath)) || {};
const deps = { ...(nearestPkg.dependencies || {}), ...(nearestPkg.devDependencies || {}) };

// ---------------------------------------------------------------- the table
// chrome / safari: the first version with the feature; safari null — none yet.
// flagOnly: the feature degrades rather than breaks, so it never blocks.
// supports: what an @supports condition must mention to count as this guard.
// fallback: 'decl' — an earlier declaration of the same property is a fallback;
//           'var'  — var(--x, <feature>) is fine when the code sets --x.
// guard: the property name a typeof / `in` check would mention (JS).
// poly: what a compat script must mention to count as polyfilling it.
// next: Next.js ships this polyfill itself (next/dist/build/polyfills).
const DYN_UNIT = String.raw`(?<![\w.#-])(?:\d+\.?\d*|\.\d+)[dsl]v(?:h|w|i|b|min|max)\b`;
const DYN_CLASS = String.raw`(?<![\w\[-])(?:min-|max-)?(?:h|w|size|top|bottom|inset|inset-x|inset-y)-[dsl]v[hw](?![\w-])`;

const FEATURES = [
  { id: 'dvh', name: 'dvh/svh/lvh viewport units', chrome: 108, safari: 15.4, lang: 'css',
    re: new RegExp(`${DYN_UNIT}|${DYN_CLASS}`, 'g'), supports: /\d*\.?\d*[dsl]v[hw]/, fallback: 'var',
    breaks: 'the whole declaration is dropped, so the element loses its height' },
  { id: 'oklch', name: 'oklch()/oklab() colours', chrome: 111, safari: 15.4, lang: 'css',
    re: /\b(?:oklch|oklab)\(/g, supports: /oklch|oklab|\blab\(|\bcolor\(/, fallback: 'decl',
    breaks: 'the declaration is dropped: the colour falls back to inherited or none' },
  { id: 'color-mix', name: 'color-mix()', chrome: 111, safari: 16.2, lang: 'css',
    re: /\bcolor-mix\(/g, supports: /color-mix/, fallback: 'decl',
    breaks: 'the declaration is dropped: the colour falls back to inherited or none' },
  { id: 'subgrid', name: 'subgrid', chrome: 117, safari: 16, lang: 'css',
    re: /\bgrid-template-(?:rows|columns)\s*:\s*subgrid\b|(?<![\w-])grid-(?:rows|cols)-subgrid(?![\w-])/g,
    supports: /subgrid/, fallback: 'decl', breaks: 'the tracks are ignored and the cards stop lining up' },
  { id: 'has', name: ':has() selector', chrome: 105, safari: 15.4, lang: 'css',
    re: /:has\(|(?<![\w-])(?:group-|peer-)?has-\[/g, supports: /:has\(/,
    breaks: 'the whole selector list is invalid, so the rule never applies' },
  { id: 'container', name: 'container queries (@container, container-type)', chrome: 105, safari: 16, lang: 'css',
    re: /@container\b|\bcontainer-type\s*:/g, supports: /container/,
    breaks: 'the query never matches and the narrow layout never kicks in' },
  { id: 'grid-rows-transition', name: 'transition of grid-template-rows', chrome: 107, safari: 16, lang: 'css',
    re: /\btransition(?:-property)?\s*:[^;{}]*grid-template-rows|transition-\[grid-template-rows\]/g,
    flagOnly: 'it degrades to an instant jump; nothing breaks, but the motion is gone' },
  { id: 'scroll-timeline', name: 'scroll-driven animations (animation-timeline)', chrome: 115, safari: 26, lang: 'css',
    re: /\banimation-timeline\s*:|\b(?:scroll|view)-timeline(?:-name)?\s*:|\banimation-range\s*:/g,
    supports: /animation-timeline|scroll-timeline|view-timeline/,
    breaks: 'the animation runs once on load instead of following the scroll, and can leave elements in the end state' },
  { id: 'starting-style', name: '@starting-style', chrome: 117, safari: 17.5, lang: 'css',
    re: /@starting-style\b|(?<![\w-])starting:/g,
    flagOnly: 'the element appears without its entry transition; nothing breaks' },
  { id: 'view-transition-css', name: 'view transitions in CSS', chrome: 111, safari: 18, lang: 'css',
    re: /\bview-transition-name\s*:|@view-transition\b|::view-transition/g,
    flagOnly: 'the change happens without the transition; nothing breaks' },
  { id: 'text-wrap', name: 'text-wrap: balance / pretty', chrome: 114, safari: 17.5, lang: 'css',
    re: /\btext-wrap(?:-style)?\s*:\s*(?:balance|pretty)|(?<![\w-])text-(?:balance|pretty)(?![\w-])/g,
    flagOnly: 'lines wrap the ordinary way; nothing breaks' },
  { id: 'popover', name: 'popover attribute / showPopover()', chrome: 114, safari: 17, lang: 'any',
    re: /\spopover=(?:["'](?:auto|manual|hint)?["']|\{)|\spopover(?=\s*\/?>|\s+[\w-]+=)|\bpopover[Tt]arget\b|\.(?:show|hide|toggle)Popover\(/g,
    guard: 'showPopover|togglePopover|popover', poly: /popover/i,
    breaks: 'the layer never opens (showPopover throws TypeError, the attribute is ignored)' },
  { id: 'view-transition-js', name: 'document.startViewTransition()', chrome: 111, safari: 18, lang: 'js',
    re: /\.startViewTransition\b/g, guard: 'startViewTransition', poly: /startViewTransition/,
    breaks: 'calling it throws TypeError and the state change in its callback never happens' },
  { id: 'abort-timeout', name: 'AbortSignal.timeout()', chrome: 103, safari: 16, lang: 'js',
    template: 'one polyfill in a first script covers every use: templates/compat-script.js',
    re: /\bAbortSignal\.timeout\b/g, guard: 'timeout', poly: /AbortSignal\.timeout|\.timeout\s*=/,
    breaks: 'it throws TypeError, so every request that uses it fails before it is sent' },
  { id: 'abort-any', name: 'AbortSignal.any()', chrome: 116, safari: 17.4, lang: 'js',
    template: 'one polyfill in a first script covers every use: templates/compat-script.js',
    re: /\bAbortSignal\.any\b/g, guard: 'any', poly: /AbortSignal\.any|\.any\s*=/,
    breaks: 'it throws TypeError, so the request that combines signals never starts' },
  { id: 'structuredClone', name: 'structuredClone()', chrome: 98, safari: 15.4, lang: 'js',
    re: /(?<![\w$.])structuredClone\s*\(/g, guard: 'structuredClone', poly: /structuredClone/,
    breaks: 'it throws ReferenceError' },
  { id: 'findLast', name: 'Array.prototype.findLast / findLastIndex', chrome: 97, safari: 15.4, lang: 'js',
    re: /\.findLast(?:Index)?\s*\(/g, guard: 'findLast', poly: /findLast/,
    breaks: 'it throws TypeError: findLast is not a function' },
  { id: 'hasOwn', name: 'Object.hasOwn()', chrome: 93, safari: 15.4, lang: 'js',
    re: /\bObject\.hasOwn\s*\(/g, guard: 'hasOwn', poly: /hasOwn/, next: true,
    breaks: 'it throws TypeError' },
  { id: 'at', name: 'Array.prototype.at / String.prototype.at', chrome: 92, safari: 15.4, lang: 'js',
    re: /[\w$)\]]\.at\(/g, guard: 'at', poly: /\.at\s*=|prototype\.at\b/, next: true,
    breaks: 'it throws TypeError: at is not a function' },
  { id: 'withResolvers', name: 'Promise.withResolvers()', chrome: 119, safari: 17.4, lang: 'js',
    re: /\bPromise\.withResolvers\s*\(/g, guard: 'withResolvers', poly: /withResolvers/,
    breaks: 'it throws TypeError' },
  { id: 'set-methods', name: 'Set methods (union, intersection, difference …)', chrome: 122, safari: 17, lang: 'js',
    re: /(?<![\w$.])([\w$]+)\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(\s*(?![\s[])/g,
    // Schema libraries share these names: z.union([…]), Joi, yup.
    skipReceiver: /^(?:z|zod|Joi|joi|yup|t|v|s|S|schema|Schema|_|lodash|R)$/,
    guard: 'union|intersection|difference', poly: /\.union\s*=|Set\.prototype\.union/,
    breaks: 'it throws TypeError' },
];

const needs = (f) => `Chrome ${f.chrome} / Safari ${f.safari ?? 'none yet'}`;
const aboveFloor = (f) =>
  (floor.chrome != null && floor.chrome < f.chrome) ||
  (floor.safari != null && (f.safari == null || floor.safari < f.safari));
const active = FEATURES.filter(aboveFloor);

// ------------------------------------------------------------------- files
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', 'build', '.output', '.vercel', 'coverage',
  '.git', '.turbo', 'storybook-static', '__tests__', 'e2e', 'tests', 'test', '__mocks__']);
const EXT = /\.(css|scss|sass|less|ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|html)$/;
const TEST_FILE = /\.(test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/;
const CSS_FILE = /\.(css|scss|sass|less)$/;
const JS_FILE = /\.([cm]?[jt]sx?|vue|svelte|astro|html)$/;

/** Minified when long lines prevail — one long line is not enough. */
function minified(text) {
  const lines = text.split('\n');
  const long = lines.filter((l) => l.length > 500).length;
  if (lines.length < 3) return long > 0;
  return long / lines.length > 0.2;
}

function walk(p, out) {
  const st = statSync(p);
  if (st.isFile()) {
    if (EXT.test(p)) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (EXT.test(name) && !TEST_FILE.test(name) && !/\.(min|bundle|chunk)\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [...new Set(roots.flatMap((r) => walk(r, [])))];

// ------------------------------------------------------------ comment strip
/** Comments become spaces, line breaks stay; strings are skipped so that
 *  "src/**\/*.ts" does not open a comment. */
function stripComments(text, path) {
  const css = path.endsWith('.css');
  const out = text.split('');
  const n = text.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const TOKEN = /\/\*|\/\/|<!--|["'`]/g;
  let i = 0;
  for (;;) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(text);
    if (!m) break;
    const t = m[0];
    const p = m.index;
    if (t === '/*') {
      let e = text.indexOf('*/', p + 2);
      e = e < 0 ? n : e + 2;
      blank(p, e);
      i = e;
    } else if (t === '<!--') {
      let e = text.indexOf('-->', p + 4);
      e = e < 0 ? n : e + 3;
      blank(p, e);
      i = e;
    } else if (t === '//') {
      if (!css && (p === 0 || ' \t\n;{}(,'.includes(text[p - 1]))) {
        let e = text.indexOf('\n', p);
        e = e < 0 ? n : e;
        blank(p, e);
        i = e;
      } else i = p + 2;
    } else {
      let j = p + 1;
      while (j < n) {
        const c = text[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === t || (c === '\n' && t !== '`')) break;
        j++;
      }
      i = j + 1;
    }
  }
  return out.join('');
}

// ---------------------------------------------------- tree-wide knowledge
const MARKER = 'frontend-quality:compat';
const texts = new Map();
const compatFiles = [];
const setVars = new Set();
const coveredClasses = new Set();
const overriddenProps = []; // {prop, header} declared inside @supports not (…)

for (const f of files) {
  let raw;
  try {
    raw = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (minified(raw)) continue;
  const s = stripComments(raw, f);
  texts.set(f, { raw, s });
  if (raw.includes(MARKER)) compatFiles.push(f);
  for (const m of raw.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) setVars.add(m[1]);
  if (CSS_FILE.test(f)) {
    for (const m of s.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) setVars.add(m[1]);
  }
}

// The compat file can sit outside the scanned paths (public/, app root): look
// for it next to the project too, so a correct polyfill is not reported.
if (!compatFiles.length) {
  const projectDir = nearestPkgPath ? dirname(nearestPkgPath) : configDir;
  for (const extra of walkShallow(projectDir)) {
    try {
      if (readFileSync(extra, 'utf8').includes(MARKER)) compatFiles.push(extra);
    } catch {
      /* unreadable: skip */
    }
  }
}
function walkShallow(dir) {
  const found = [];
  const visit = (d, depth) => {
    if (depth > 4) return;
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) visit(full, depth + 1);
      } else if (/\.(js|mjs|ts|tsx|html)$/.test(name) && st.size < 64_000) found.push(full);
    }
  };
  visit(dir, 0);
  return found;
}
const compatText = compatFiles.map((f) => texts.get(f)?.raw ?? readFileSync(f, 'utf8')).join('\n');

function supportsKind(header) {
  if (!header.startsWith('@supports')) return null;
  return /\bnot\b/.test(header) ? 'neg' : 'pos';
}

// Tailwind classes redefined inside @supports not (…dvh…) are covered.
for (const [f, { s }] of texts) {
  if (!CSS_FILE.test(f)) continue;
  const stack = [];
  let last = -1;
  for (const m of s.matchAll(/[{};]/g)) {
    if (m[0] === '{') {
      const header = s.slice(last + 1, m.index).trim().replace(/\s+/g, ' ');
      const kind = supportsKind(header);
      stack.push({ kind, header });
      if (!header.startsWith('@') && stack.some((b) => b.kind === 'neg' && FEATURES[0].supports.test(b.header))) {
        for (const c of header.matchAll(/\.((?:\\.|[\w-])+)/g)) coveredClasses.add(c[1].replace(/\\/g, ''));
      }
    } else {
      // A declaration inside @supports not (…): the property has an override
      // for engines without the feature.
      const decl = s.slice(last + 1, m.index).match(/^\s*(--[\w-]+|[\w-]+)\s*:/);
      const negs = stack.filter((b) => b.kind === 'neg');
      if (decl && negs.length) {
        for (const b of negs) overriddenProps.push({ prop: decl[1], header: b.header });
      }
      if (m[0] === '}') stack.pop();
    }
    last = m.index;
  }
}

// --------------------------------------------------------------- the scan
const nextPolyfills = 'next' in deps;
const polyfilled = new Map(); // feature id -> {by, uses}
const groups = new Map(); // `${severity}|${id}` -> {severity, feature, lines}

function add(severity, feature, file, lineNo, rawLine, note) {
  const key = `${severity}|${feature.id}`;
  if (!groups.has(key)) groups.set(key, { severity, feature, lines: [] });
  const text = rawLine.trim().slice(0, 120);
  groups.get(key).lines.push({ text: `${relative(process.cwd(), file)}:${lineNo}: ${text}`, note });
}

const lineStarts = (s) => {
  const starts = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') starts.push(i + 1);
  return starts;
};
const lineOf = (starts, pos) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** Is pos inside the fallback of var(--x, …)? Returns the variable name. */
function varFallback(prefix) {
  const stack = [];
  for (const m of prefix.matchAll(/([\w-]*)\(|\)|,/g)) {
    if (m[0] === ')') stack.pop();
    else if (m[0] === ',') {
      const top = stack[stack.length - 1];
      if (top && top.name === 'var') top.fallback = true;
    } else {
      const name = m[1].toLowerCase();
      const v = name === 'var' ? prefix.slice(m.index + m[0].length).match(/^\s*(--[\w-]+)/) : null;
      stack.push({ name, fallback: false, variable: v ? v[1] : null });
    }
  }
  const hit = [...stack].reverse().find((f) => f.name === 'var' && f.fallback);
  return hit ? hit.variable : null;
}

/** An earlier declaration of the same property in the same block. */
function declFallback(s, blockStart, pos, feature) {
  const before = s.slice(blockStart + 1, pos);
  const declStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'));
  const decl = before.slice(declStart + 1).match(/([\w-]+)\s*:[^;{}]*$/);
  if (!decl) return false;
  const prop = decl[1];
  const earlier = before.slice(0, declStart + 1);
  const rx = new RegExp(`(?:^|[;{\\s])${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;{}]+)`, 'g');
  for (const m of earlier.matchAll(rx)) {
    feature.re.lastIndex = 0;
    if (!feature.re.test(m[1])) return true;
  }
  return false;
}

/** A feature check on the same line or up to four lines above: an `if`, a
 *  ternary or an early return. Further away it guards something else. */
function jsGuardNearby(lines, ln, guard) {
  const win = lines.slice(Math.max(0, ln - 4), ln + 1).join('\n');
  const g = `(?:${guard})`;
  return new RegExp(
    `typeof\\s+[\\w$.]*\\b${g}\\b|['"]${g}['"]\\s+in\\b|\\b${g}\\s*\\?\\.|if\\s*\\(\\s*!?\\s*[\\w$.]*\\.${g}\\s*\\)|[\\w$.]*\\.${g}\\s*(?:&&|\\?(?!\\.))`,
  ).test(win);
}

/** Code that never reaches the browser: its JavaScript APIs run on the server's
 *  Node, which is not the floor. Its CSS class names still render, so CSS
 *  features are scanned anyway. Next.js: route handlers, middleware, "use server"
 *  modules, and App Router entry files (page, layout …) without "use client". */
const NEXT_ENTRY = /^(page|layout|template|default|not-found|loading|head|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.[jt]sx?$/;
function serverOnly(file, raw) {
  const name = basename(file);
  if (/^(route|middleware|instrumentation)\.[jt]s$/.test(name) || /\.server\.[jt]sx?$/.test(name)) return true;
  const directive = raw.match(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use (client|server)['"]/);
  if (directive) return directive[1] === 'server';
  return 'next' in deps && NEXT_ENTRY.test(name) && file.split(sep).includes('app');
}

for (const [file, { raw, s }] of texts) {
  if (compatFiles.includes(file)) continue; // the polyfill itself names the APIs
  const isCss = CSS_FILE.test(file);
  const isJs = JS_FILE.test(file) && !serverOnly(file, raw);
  const hits = [];
  for (const f of active) {
    if (f.lang === 'js' && !isJs) continue;
    f.re.lastIndex = 0;
    for (const m of s.matchAll(f.re)) {
      if (f.skipReceiver && m[1] && f.skipReceiver.test(m[1])) continue;
      hits.push({ pos: m.index, f, m });
    }
  }
  if (!hits.length) continue;
  hits.sort((a, b) => a.pos - b.pos);
  const starts = lineStarts(s);
  const rawLines = raw.split('\n');
  const sLines = s.split('\n');
  // Walk the blocks once, attaching the open @supports headers to every hit.
  const events = [...s.matchAll(/[{};]/g)];
  const stack = [];
  let ei = 0;
  let last = -1;
  const seen = new Set();
  for (const h of hits) {
    while (ei < events.length && events[ei].index < h.pos) {
      const e = events[ei];
      if (e[0] === '{') {
        const header = s.slice(last + 1, e.index).trim().replace(/\s+/g, ' ');
        stack.push({ header, kind: supportsKind(header), start: e.index });
      } else if (e[0] === '}') stack.pop();
      last = e.index;
      ei++;
    }
    const { f } = h;
    const ln = lineOf(starts, h.pos);
    const prefix = s.slice(starts[ln], h.pos);
    const key = `${f.id}:${ln}`;
    if (seen.has(key)) continue;

    // A support check is not a use: typeof X.y, @supports (…), CSS.supports(…).
    if (/typeof\s+[\w$.]*$/.test(prefix)) continue;
    if (/@supports[^{]*$/.test(prefix) || /supports\s*\([^)]*$/.test(prefix)) continue;
    if (/(?:^|[\s"'`])[^\s"'`]*supports-\[[^\]]*\]:[^\s"'`]*$/.test(prefix)) continue;
    if (/supports-\[[^\]\s]*$/.test(prefix)) continue;
    // Inside @supports for the same feature: the engine checks for itself.
    if (f.supports && stack.some((b) => b.kind === 'pos' && f.supports.test(b.header))) continue;
    if (f.lang === 'js' || f.id === 'popover') {
      if (f.poly && compatFiles.length && f.poly.test(compatText)) {
        const p = polyfilled.get(f.id) || { by: 'compat', uses: 0, f };
        p.uses++;
        polyfilled.set(f.id, p);
        seen.add(key);
        continue;
      }
      if (f.next && nextPolyfills) {
        const p = polyfilled.get(f.id) || { by: 'next', uses: 0, f };
        p.uses++;
        polyfilled.set(f.id, p);
        seen.add(key);
        continue;
      }
    }
    seen.add(key);

    let severity = 'BLOCK';
    let note = '';
    if (f.flagOnly) {
      severity = 'FLAG';
    } else if (f.fallback === 'var') {
      const variable = varFallback(prefix);
      const cls = h.m[0];
      if (/^[a-z]/.test(cls) && coveredClasses.has(cls)) continue;
      if (variable) {
        if (setVars.has(variable)) continue;
        note = `nothing in the scanned code sets ${variable}, so old engines get the fallback itself`;
      }
    } else if (f.fallback === 'decl' && isCss) {
      const block = [...stack].reverse().find((b) => !b.header.startsWith('@'));
      const decl = s.slice(block ? block.start + 1 : 0, h.pos);
      const custom = decl.match(/(?:^|[;{\s])(--[\w-]+)\s*:[^;{}]*$/);
      if (custom) {
        // A custom property is never validated: an earlier value does not act
        // as a fallback, the last one always wins and every var() use breaks.
        // Silent when @supports not (…this feature…) redefines it.
        if (overriddenProps.some((o) => o.prop === custom[1] && f.supports.test(o.header))) continue;
        note = 'a custom property: every var() use breaks; override it in @supports not (…) with a supported value';
      } else if (block && declFallback(s, block.start, h.pos, f)) {
        severity = 'FLAG';
        note = 'an earlier declaration is the fallback — check the minifier kept both in the built CSS';
      }
    } else if (f.guard && jsGuardNearby(sLines, ln, f.guard)) {
      severity = 'FLAG';
      note = 'a feature check is nearby — make sure its other branch still does the job';
    }
    add(severity, f, file, ln + 1, rawLines[ln] || '', note);
  }
}

// ------------------------------------------------------ project-level flags
const projectFlags = [];
const below = (c, sv) => (floor.chrome != null && floor.chrome < c) || (floor.safari != null && floor.safari < sv);
if ('next' in deps && !nearestPkg.browserslist && !findUp(roots[0], '.browserslistrc') && below(111, 16.4)) {
  projectFlags.push(
    'Next.js without a browserslist compiles for Chrome 111 / Safari 16.4: syntax newer than the floor reaches ' +
      `old engines untranspiled. Add a browserslist matching the floor to ${relative(process.cwd(), nearestPkgPath)}.`,
  );
}
if (/^[\^~]?4/.test(String(deps.tailwindcss || '')) && below(111, 16.4)) {
  projectFlags.push(
    'Tailwind CSS v4 is documented for Chrome 111 / Safari 16.4: its default palette is oklch() and opacity ' +
      'modifiers use color-mix(). Open the built CSS on the floor engine before trusting the colours.',
  );
}

// ------------------------------------------------------------------ report
console.log(`Browser floor: ${floorText} (${floorSource})`);
console.log(`Scanned ${texts.size} file${texts.size === 1 ? '' : 's'} in: ${roots.map((r) => relative(process.cwd(), r) || '.').join(', ')}`);
if (polyfilled.size) {
  const byCompat = [...polyfilled.values()].filter((p) => p.by === 'compat');
  const byNext = [...polyfilled.values()].filter((p) => p.by === 'next');
  if (byCompat.length) {
    console.log(
      `Polyfilled by the first script (${compatFiles.map((f) => relative(process.cwd(), f)).join(', ')}): ` +
        byCompat.map((p) => `${p.f.name} — ${p.uses} use(s)`).join('; '),
    );
  }
  if (byNext.length) {
    console.log(`Polyfilled by Next.js: ${byNext.map((p) => `${p.f.name} — ${p.uses} use(s)`).join('; ')}`);
  }
}

let blocking = 0;
let warnings = 0;
const ordered = [...groups.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCK' ? -1 : 1));
for (const g of ordered) {
  const { feature: f, severity, lines } = g;
  console.log('');
  console.log(`${severity} — ${f.name}: needs ${needs(f)}, floor ${floorText} (${lines.length})`);
  console.log(`  why: ${f.flagOnly || f.breaks}`);
  if (severity === 'BLOCK' && f.template) console.log(`  fix: ${f.template}`);
  // One note shared by every line is printed once, not forty times.
  const shared = lines.every((l) => l.note && l.note === lines[0].note) ? lines[0].note : '';
  if (shared) console.log(`  note: ${shared}`);
  for (const l of lines.slice(0, 15)) console.log(`  ${l.text}${l.note && !shared ? `   [${l.note}]` : ''}`);
  if (lines.length > 15) console.log(`  … and ${lines.length - 15} more`);
  if (severity === 'BLOCK') blocking += lines.length;
  else warnings += lines.length;
}
if (projectFlags.length) {
  console.log('');
  console.log(`FLAG — build targets above the floor (${projectFlags.length})`);
  for (const p of projectFlags) console.log(`  ${p}`);
  warnings += projectFlags.length;
}

console.log('');
console.log(`Browser floor: blocking — ${blocking}, warnings — ${warnings}`);
process.exit(blocking ? 1 : 0);
