/**
 * check-forbidden.sh regression: every rule must fire on its bad case and stay
 * silent on the correct pattern next to it.
 *
 * The silences matter as much as the findings. The old vh rule blocked the very
 * fallback it asked for — `height: var(--app-h, 100vh)` — and a check that
 * blocks correct code teaches people to switch it off. Each fixture line carries
 * a marker word (bad-…, ok-…, flag-…, block-…) so the test reads the report by
 * the line's text, not by line numbers.
 *
 * Fixtures:
 *   floor106/      Chrome 106 / Safari 15 floor, a declared network layer,
 *                  the default 16px floor, no viewport-fit=cover.
 *   modern/        Chrome 120 floor (dvh rules off), palette as a block,
 *                  minFontPx 12, monospace allowed, viewport-fit=cover,
 *                  h-screen classes redefined inside @supports.
 *   unknown/       browserslist that does not name chrome: dvh is a warning.
 *   browserslist/  floor taken from package.json browserslist: dvh blocks.
 *
 * Run: node tests/forbidden/run.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/check-forbidden.sh", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}/src`, import.meta.url));

/** Runs the check and splits the report into groups: {severity, title, lines}. */
function run(name, env = {}) {
  const res = spawnSync("bash", [script, fixture(name)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  const groups = [];
  for (const line of out.split("\n")) {
    const head = line.match(/^(BLOCK|FLAG) — (.+) \((\d+)\)$/);
    if (head) {
      groups.push({ severity: head[1], title: head[2], lines: [] });
    } else if (groups.length && /^ {2}\S/.test(line) && !line.startsWith("  why:")) {
      groups.at(-1).lines.push(line);
    }
  }
  return { out, groups, status: res.status };
}

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${ok || !detail ? "" : " :: " + detail}`);
  if (!ok) fails.push(label);
};

/** The marker must appear in a group of this severity whose title matches. */
function expectIn(report, severity, titlePart, marker) {
  const hit = report.groups.some(
    (g) => g.severity === severity && g.title.includes(titlePart) && g.lines.some((l) => l.includes(marker)),
  );
  const where = report.groups
    .filter((g) => g.lines.some((l) => l.includes(marker)))
    .map((g) => `${g.severity} — ${g.title}`);
  check(hit, `${marker} → ${severity} "${titlePart}"`, where.length ? `found in: ${where.join(" | ")}` : "not reported");
}

/** The marker must not appear in any group at all. */
function expectSilent(report, marker) {
  const where = report.groups
    .filter((g) => g.lines.some((l) => l.includes(marker)))
    .map((g) => `${g.severity} — ${g.title}`);
  check(where.length === 0, `${marker} → silent`, `reported in: ${where.join(" | ")}`);
}

// The report must be a report. A crash (no python3, a syntax error) prints
// nothing and would read as "all silent", that is, as a pass.
const old = run("floor106");
if (!/Bans: blocking — \d+, warnings — \d+/.test(old.out)) {
  console.error("check-forbidden.sh did not reach its summary. Output:\n" + old.out.trim());
  process.exit(1);
}
check(old.status === 1, "floor106 exits 1 (it has blocking findings)", `exit ${old.status}`);

// vh: the bad cases, a one-line file included (it used to be skipped as
// "minified"), and the three correct fallbacks that must stay silent.
const VH = "vh where the visible height is meant";
for (const m of ["bad-vh", "bad-one-line", "bad-tw-vh", "bad-h-screen", "bad-min-h-screen", "bad-max-h-screen"]) {
  expectIn(old, "BLOCK", VH, m);
}
expectSilent(old, "ok-w-screen");
for (const m of ["ok-var-fallback", "ok-nested-fallback", "ok-commented", "ok-multiline-comment",
  "ok-supports-not", "ok-base-overridden", "ok-supports-calc", "ok-dvh-fallback", "ok-tw-fallback",
  "ok-tw-covered", "ok-tw-calc-fallback", "ok-tw-supports", "dvh supported"]) expectSilent(old, m);

// dvh/svh/lvh below the floor, and calc() with them.
const DVH = "dvh/svh/lvh without a fallback";
const CALC = "calc() with dvh/svh/lvh";
for (const m of ["bad-dvh", "bad-svh", "bad-tw-dvh", "bad-tw-uncovered"]) expectIn(old, "BLOCK", DVH, m);
for (const m of ["bad-calc", "bad-tw-calc"]) expectIn(old, "BLOCK", CALC, m);

// Colour.
const HEX = "raw HEX colour";
for (const m of ["bad-hex3", "bad-hex8", "bad-hex6"]) expectIn(old, "FLAG", HEX, m);
for (const m of ["ok-order-number", "ok-anchor", "ok-url-ref", "ok-role"]) expectSilent(old, m);
for (const m of ["bad-palette", "bad-palette-variant"]) expectIn(old, "FLAG", "Tailwind default palette", m);

// Network layer.
expectIn(old, "FLAG", "raw fetch outside the network layer", "badRawFetch");
expectSilent(old, "okNetworkLayer");
expectSilent(old, "okCommentedFetch");

// Storage during render.
expectIn(old, "FLAG", "read during render", "bad-render-read");
expectIn(old, "FLAG", "read during render", "bad-lazy-state");
expectIn(old, "FLAG", "at module scope", "bad-module-read");
for (const m of ["ok-module-helper", "ok-plain-function", "ok-effect-read", "ok-external-store",
  "ok-handler", "ok-inline-handler", "typeof localStorage"]) expectSilent(old, m);

// Safe area without viewport-fit=cover.
expectIn(old, "FLAG", "viewport-fit=cover", "bad-safe-area");

// Type: the 16px default floor and monospace.
const FONT = "font size below the 16px floor";
for (const m of ["bad-text-xs", "bad-text-sm", "bad-arbitrary", "bad-font-size {", "bad-font-size-rem"]) {
  expectIn(old, "FLAG", FONT, m);
}
for (const m of ["ok-text-base", "ok-sm-breakpoint", "ok-font-size", "ok-tabular"]) expectSilent(old, m);
for (const m of ["bad-font-mono", "bad-mono-family"]) expectIn(old, "FLAG", "monospace", m);
expectSilent(old, "--font-mono: ui-monospace");
expectSilent(old, "ok-commented-mono");

// A modern floor: dvh is fine, the project's own settings take effect.
const modern = run("modern");
// h-screen redefined inside @supports (either direction) is safe; one left
// alone still blocks.
expectSilent(modern, "ok-h-screen-redefined");
expectSilent(modern, "ok-min-h-screen-covered");
expectIn(modern, "BLOCK", VH, "bad-max-h-screen-modern");
for (const m of ["ok-modern-dvh", "ok-modern-calc", "ok-text-xs-allowed", "ok-mono-allowed"]) expectSilent(modern, m);
expectIn(modern, "BLOCK", "Tailwind default palette", "bad-palette-block");
expectIn(modern, "FLAG", "font size below the 12px floor", "bad-under-12");

// No floor anywhere: the dvh rule warns and says why instead of blocking.
const unknown = run("unknown", { UIVERIFY_CONFIG: "none" });
expectIn(unknown, "FLAG", DVH, "flag-unknown-floor");
check(/Browser floor unknown/.test(unknown.out), "unknown floor: the warning says why");
check(unknown.status === 0, "unknown floor: a warning does not fail the check", `exit ${unknown.status}`);

// The floor from package.json browserslist.
const bl = run("browserslist", { UIVERIFY_CONFIG: "none" });
expectIn(bl, "BLOCK", DVH, "block-from-browserslist");
check(/Chrome 100/.test(bl.out), "browserslist floor is printed (Chrome 100)");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
