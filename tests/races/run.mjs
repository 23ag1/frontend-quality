/**
 * verify-races regression: a tiny app with six toggles over a mock backend that
 * keeps writes. Five toggles carry one race defect each, the sixth is correct.
 *
 *   double   - two taps send two requests                 -> double tap BLOCK
 *   rollback - the value flips back 1.5 s after a success  -> settle BLOCK
 *   stale    - a refresh overwrites the unconfirmed action -> late answer BLOCK
 *   silent   - a failure rolls back without a word         -> failure BLOCK
 *   liar     - a failure says "Saved"                      -> failure BLOCK
 *   correct  - must stay silent on all four probes
 *
 * Run: node tests/races/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUESTED_PORT = Number(process.env.PORT || 0); // 0: any free port, so parallel runs never collide
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-races.mjs", import.meta.url));
const scenario = fileURLToPath(new URL("./scenario.mjs", import.meta.url));
const html = readFileSync(new URL("./page.html", import.meta.url));

const IDS = ["double", "rollback", "stale", "silent", "liar", "correct"];
const store = Object.fromEntries(IDS.map((id) => [id, false]));

const server = createServer((req, res) => {
  const json = (body) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/api/state") return json(store);
  const toggle = req.method === "POST" && req.url.match(/^\/api\/toggle\/(\w+)$/);
  if (toggle && toggle[1] in store) {
    store[toggle[1]] = !store[toggle[1]];
    return json({ id: toggle[1], on: store[toggle[1]] });
  }
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  res.writeHead(404);
  res.end();
});
await new Promise((done) => server.listen(REQUESTED_PORT, "127.0.0.1", done));
const PORT = server.address().port;

const out = await new Promise((done) => {
  const run = spawn("node", [script, "--scenario", scenario], {
    env: { ...process.env, RACES_URL: `http://127.0.0.1:${PORT}/` },
  });
  let text = "";
  run.stdout.on("data", (c) => (text += c));
  run.stderr.on("data", (c) => (text += c));
  run.on("close", (code) => done({ text, code }));
});
server.close();

if (!out.text.includes("Blocking:")) {
  console.error("verify-races did not reach its report. Output:\n" + out.text.trim());
  process.exit(1);
}

/** The report lines of one action, from its header to the next one. */
const section = (id) => {
  const start = out.text.indexOf(`── toggle ${id} ──`);
  if (start < 0) return [];
  const rest = out.text.slice(start).split("\n").slice(1);
  const lines = [];
  for (const line of rest) {
    if (line.startsWith("── ") || line.startsWith("Blocking:")) break;
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
};
const finding = (id, probe) => section(id).find((l) => /^(BLOCK|FLAG)/.test(l) && l.includes(probe)) || "";

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) fails.push(label);
};

const expected = [
  ["double", "double tap", "two taps send two requests"],
  ["rollback", "settle", "a delayed rollback changes the screen by itself"],
  ["stale", "late answer", "a refresh during the request ends on older data"],
  ["silent", "failure", "a silent failure leaves no trace on screen"],
  ["liar", "failure", "a failure that says Saved"],
];
for (const [id, probe, label] of expected) {
  const line = finding(id, probe);
  check(line.startsWith("BLOCK"), `${id}: ${label} is a BLOCK`, line);
}
const correct = section("correct");
const noise = correct.filter((l) => /^(BLOCK|FLAG)/.test(l));
check(correct.length >= 4 && noise.length === 0, "correct: all four probes ran and stayed silent", noise.join(" | ") || `${correct.length} ok lines`);
check(out.code === 1, "exit 1 when anything blocks", `exit ${out.code}`);

if (fails.length) console.log("\n--- output ---\n" + out.text.trim());
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
