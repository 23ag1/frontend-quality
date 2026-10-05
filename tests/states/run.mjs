/**
 * verify-states regression: the check must stay silent where there is nothing
 * to measure.
 *
 * page.html holds six cases side by side — three known false alarms and two
 * real defects. The false ones came from production as "findings" and taught
 * people to stop reading the report:
 *
 *   disabled icon-only button  - contrast was measured on an empty element, and
 *                                hover never fired because of
 *                                disabled:pointer-events-none;
 *   disabled text button       - WCAG 1.4.3 excludes disabled controls;
 *   enabled icon-only button   - "16px, weight 400" describes text that is not
 *                                there (the content is an <svg>).
 *
 * The real ones must survive: unreadable text on an enabled button and a button
 * that Tab never reaches (tabindex="-1").
 *
 * Run: node tests/states/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8977);
const html = readFileSync(new URL("./page.html", import.meta.url));
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-states.mjs", import.meta.url));

/** What the report must say and what it must keep quiet about. */
const MUST_REPORT = ["Continue", "Unreachable"];
const MUST_STAY_SILENT = ["Erase", "Sign in", "Refresh"];

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((done) => server.listen(PORT, "127.0.0.1", done));

const out = await new Promise((done) => {
  const run = spawn("node", [script, "--url", `http://127.0.0.1:${PORT}/`], { encoding: "utf8" });
  let text = "";
  run.stdout.on("data", (c) => (text += c));
  run.stderr.on("data", (c) => (text += c));
  run.on("close", () => done(text));
});
server.close();

// The check must actually REACH its report. Without this line a crashed run
// (dependencies missing, no browser) would read as "no findings", that is, as a
// pass — exactly the lie this test exists to catch.
if (!out.includes("Blocking:")) {
  console.error("verify-states did not run — there is no report. Output:\n" + out.trim());
  console.error("\nIf it complains about playwright: npm install in skills/frontend-quality");
  process.exit(1);
}

/** Findings for a button, except the touch target — that is not about states. */
const findingsFor = (label) => {
  const at = out.indexOf(`button “${label}”`);
  if (at < 0) return [];
  const rest = out.slice(at).split("\n").slice(1);
  const lines = [];
  for (const line of rest) {
    if (!/^\s{6}(BLOCK|FLAG)/.test(line)) break;
    if (!line.includes("touch target")) lines.push(line.trim());
  }
  return lines;
};

const fails = [];
for (const label of MUST_STAY_SILENT) {
  const found = findingsFor(label);
  const ok = found.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} :: "${label}" — nothing to measure, no findings expected${ok ? "" : " :: " + found.join(" | ")}`);
  if (!ok) fails.push(label);
}
for (const label of MUST_REPORT) {
  const found = findingsFor(label);
  const ok = found.some((l) => l.startsWith("BLOCK"));
  console.log(`${ok ? "PASS" : "FAIL"} :: "${label}" — a real defect, it must stay reported${ok ? " :: " + found[0] : ""}`);
  if (!ok) fails.push(label);
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(", ")}` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
