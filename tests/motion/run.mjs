/**
 * verify-motion regression: animations cut short are reported per interaction,
 * and the clean twin of the same page stays silent.
 *
 *   defect.html - a toast whose 400 ms fade is cut by a 150 ms removal timer
 *                 (BLOCK), a panel whose transition is replaced by a second
 *                 state change 100 ms later (FLAG);
 *   clean.html  - removal on transitionend, one state change per action, and an
 *                 infinite spinner removed mid-turn (exempt by design).
 *
 * Both run through --scenario (scenario.mjs); the clean page also runs with
 * plain --url, so the old way of calling the script keeps working.
 *
 * Run: node tests/motion/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUESTED_PORT = Number(process.env.PORT || 0); // 0: any free port, so parallel runs never collide
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-motion.mjs", import.meta.url));
const scenario = fileURLToPath(new URL("./scenario.mjs", import.meta.url));
const pages = {
  "/defect.html": readFileSync(new URL("./defect.html", import.meta.url)),
  "/clean.html": readFileSync(new URL("./clean.html", import.meta.url)),
};

const server = createServer((req, res) => {
  const body = pages[req.url.split("?")[0]];
  res.writeHead(body ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body || "not found");
});
await new Promise((done) => server.listen(REQUESTED_PORT, "127.0.0.1", done));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;

const runCheck = (args, env = {}) =>
  new Promise((done) => {
    const run = spawn("node", [script, ...args], { env: { ...process.env, ...env } });
    let text = "";
    run.stdout.on("data", (c) => (text += c));
    run.stderr.on("data", (c) => (text += c));
    run.on("close", (code) => done({ text, code }));
  });

// One browser at a time.
const defect = await runCheck(["--scenario", scenario], { MOTION_URL: `${base}/defect.html` });
const clean = await runCheck(["--scenario", scenario], { MOTION_URL: `${base}/clean.html` });
const plain = await runCheck(["--url", `${base}/clean.html`]);
server.close();

for (const [name, run] of [["defect", defect], ["clean", clean], ["plain --url", plain]]) {
  if (!run.text.includes("Blocking:")) {
    console.error(`verify-motion did not reach its report (${name}). Output:\n${run.text.trim()}`);
    process.exit(1);
  }
}

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) fails.push(label);
};
const lineWith = (text, needle) => text.split("\n").find((l) => l.includes(needle))?.trim() || "";
const findings = (text) => text.split("\n").filter((l) => /^\s*(BLOCK|FLAG)/.test(l)).map((l) => l.trim());

const removed = lineWith(defect.text, "the element was removed after");
check(
  removed.startsWith("BLOCK") && removed.includes("#toast") && removed.includes("[dismiss the toast]"),
  "toast removed by a timer mid-fade is a BLOCK, attributed to its interaction",
  removed
);
const replaced = lineWith(defect.text, "by a new transition of the same property");
check(
  replaced.startsWith("FLAG") && replaced.includes("#panel") && replaced.includes("[slide the panel]"),
  "panel transition replaced by a second state change is a FLAG",
  replaced
);
check(defect.code === 1, "defect page exits 1", `exit ${defect.code}`);

check(findings(clean.text).length === 0, "clean twin: no findings", findings(clean.text).join(" | "));
const followed = lineWith(clean.text, "Animations followed");
check(/finished: [1-9]/.test(followed), "clean twin: animations were followed to their end, not missed", followed);
check(clean.code === 0, "clean twin exits 0", `exit ${clean.code}`);
check(plain.code === 0 && findings(plain.text).length === 0, "plain --url still works and is clean", lineWith(plain.text, "Blocking:"));

if (fails.length) {
  console.log("\n--- defect ---\n" + defect.text.trim() + "\n\n--- clean ---\n" + clean.text.trim() + "\n\n--- plain ---\n" + plain.text.trim());
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
