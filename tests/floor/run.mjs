/**
 * check-browser-floor.mjs regression, plus a working test of the compat script.
 *
 * Severity design the fixtures pin down:
 *   BLOCK  — above the floor with no fallback in sight (oklch() bare,
 *            AbortSignal.any without a polyfill, var(--x, 100dvh) where nothing
 *            sets --x);
 *   FLAG   — a fallback that text cannot prove (an earlier declaration a
 *            minifier may collapse, a typeof check), or a feature that only
 *            degrades (grid-template-rows transition, text-wrap: balance);
 *   silent — inside @supports for the same feature, a Tailwind class covered by
 *            @supports not (…), var(--app-h, 100dvh) with --app-h set by code,
 *            an API polyfilled by a file carrying `frontend-quality:compat`.
 *
 * Fixtures (all with a Chrome 106 / Safari 15 floor):
 *   app/     CSS and JS features with and without fallbacks;
 *   nopoly/  AbortSignal.any bare (BLOCK) and behind typeof (FLAG); server
 *            code (a route handler, a "use server" module) is not the floor;
 *   poly/    the same code scanned together with templates/compat-script.js;
 *   nofloor/ no floor anywhere: the scan refuses to guess (exit 2).
 *
 * Run: node tests/floor/run.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/check-browser-floor.mjs", import.meta.url));
const compatPath = fileURLToPath(new URL("../../templates/compat-script.js", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}/src`, import.meta.url));

function run(args, env = {}) {
  const res = spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const out = (res.stdout || "") + (res.stderr || "");
  const groups = [];
  for (const line of out.split("\n")) {
    const head = line.match(/^(BLOCK|FLAG) — (.+) \((\d+)\)$/);
    if (head) groups.push({ severity: head[1], title: head[2], lines: [] });
    else if (groups.length && /^ {2}\S/.test(line) && !/^ {2}(why|note|fix):/.test(line)) groups.at(-1).lines.push(line);
  }
  return { out, groups, status: res.status };
}

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${ok || !detail ? "" : " :: " + detail}`);
  if (!ok) fails.push(label);
};
const foundIn = (r, marker) =>
  r.groups.filter((g) => g.lines.some((l) => l.includes(marker))).map((g) => `${g.severity} — ${g.title}`);
function expectIn(r, severity, titlePart, marker) {
  const ok = r.groups.some((g) => g.severity === severity && g.title.includes(titlePart) && g.lines.some((l) => l.includes(marker)));
  const where = foundIn(r, marker);
  check(ok, `${marker} → ${severity} "${titlePart}"`, where.length ? `found in: ${where.join(" | ")}` : "not reported");
}
function expectSilent(r, marker) {
  const where = foundIn(r, marker);
  check(where.length === 0, `${marker} → silent`, `reported in: ${where.join(" | ")}`);
}

// 1. CSS and JS features in one app.
const app = run([fixture("app")]);
if (!/Browser floor: blocking — \d+, warnings — \d+/.test(app.out)) {
  console.error("check-browser-floor.mjs did not reach its summary. Output:\n" + app.out.trim());
  process.exit(1);
}
check(/Browser floor: Chrome 106 \/ Safari 15 \(browserFloor in/.test(app.out), "the floor and its source are printed");
check(app.status === 1, "app exits 1 (blocking findings)", `exit ${app.status}`);
expectIn(app, "BLOCK", "oklch()", "block-oklch");
expectSilent(app, "ok-oklch-supports");
expectSilent(app, "ok-commented");
expectIn(app, "FLAG", "oklch()", "colors.css:8: color: oklch(70% 0.1 200);");
check(/note: an earlier declaration is the fallback/.test(app.out), "the declaration fallback is named in the note");
expectIn(app, "BLOCK", "oklch()", "--block-token-bare");
expectSilent(app, "--ok-token-overridden");
check(/a custom property: every var\(\) use breaks/.test(app.out), "a token holding oklch() is explained as a custom property");
expectIn(app, "BLOCK", "color-mix()", "block-color-mix");
expectIn(app, "BLOCK", "subgrid", "block-subgrid");
expectIn(app, "FLAG", "grid-template-rows", "flag-grid-rows");
expectIn(app, "FLAG", "text-wrap", "flag-balance");
expectIn(app, "BLOCK", "dvh/svh/lvh", "block-dvh");
expectIn(app, "BLOCK", "dvh/svh/lvh", "block-unset-var");
expectIn(app, "BLOCK", "dvh/svh/lvh", "block-tw-dvh");
for (const m of ["ok-app-h", "ok-covered", "ok-tw-supports", "CSS.supports"]) expectSilent(app, m);
expectIn(app, "BLOCK", "Set methods", "blockSetUnion");
expectSilent(app, "okSchema");
expectIn(app, "BLOCK", "findLast", "blockFindLast");

// 2. AbortSignal.any without a polyfill.
const nopoly = run([fixture("nopoly")]);
expectIn(nopoly, "BLOCK", "AbortSignal.any()", "blockAny");
expectIn(nopoly, "BLOCK", "AbortSignal.timeout()", "blockAny");
expectIn(nopoly, "FLAG", "AbortSignal.any()", "? AbortSignal.any([userSignal])");
expectSilent(nopoly, "typeof AbortSignal.any");
expectSilent(nopoly, "okServerRoute");   // route handler: server code
expectSilent(nopoly, "okServerAction");  // "use server" module

// 3. The same code with the template compat script in the scan: polyfilled.
const poly = run([fixture("poly"), compatPath]);
expectSilent(poly, "okPolyfilledAny");
check(/Polyfilled by the first script \(.*compat-script\.js\): AbortSignal\.any\(\)/.test(poly.out),
  "the polyfilled APIs are listed once at the top");
check(poly.status === 0, "poly exits 0", `exit ${poly.status}\n${poly.out}`);

// 4. No floor: the scan says so and exits 2 instead of guessing.
const none = run([fixture("nofloor")], { UIVERIFY_CONFIG: "none" });
check(none.status === 2 && /no browser floor declared/.test(none.out), "no floor → exit 2 with the reason", `exit ${none.status}`);
const forced = run([fixture("nofloor"), "--floor", "chrome=106,safari=15"], { UIVERIFY_CONFIG: "none" });
check(forced.status === 1 && /floor Chrome 106 \/ Safari 15/.test(forced.out), "--floor overrides a missing config", `exit ${forced.status}`);

// 5. The compat script itself, run where the APIs are missing.
const source = readFileSync(compatPath, "utf8");
check(source.startsWith("/* frontend-quality:compat"), "the template carries the marker on its first line");
// An old engine: AbortSignal exists but has neither static method. Signals still
// come from the real AbortController, so abort() and reason behave natively.
const sandbox = { AbortController, AbortSignal: class {}, DOMException, setTimeout, Array, Error };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { any, timeout } = sandbox.AbortSignal;
check(typeof any === "function" && typeof timeout === "function", "the polyfill installs AbortSignal.any and .timeout");

const a = new AbortController();
const b = new AbortController();
const combined = any([a.signal, b.signal]);
b.abort("second");
check(combined.aborted && combined.reason === "second", "any() aborts with the reason of the first signal that aborts");
const early = new AbortController();
early.abort("already");
check(any([early.signal]).reason === "already", "any() of an already aborted signal is aborted at once");

const t = timeout(20);
await new Promise((done) => setTimeout(done, 60));
check(t.aborted && t.reason?.name === "TimeoutError", "timeout() aborts with a TimeoutError", String(t.reason));

// Where the feature exists, the script does not touch it.
const native = { AbortController, AbortSignal, DOMException, setTimeout, Array, Error };
const before = AbortSignal.any;
vm.createContext(native);
vm.runInContext(source, native);
check(AbortSignal.any === before, "native AbortSignal.any is left alone");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
