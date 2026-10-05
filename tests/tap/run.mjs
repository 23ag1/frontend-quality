/**
 * verify-tap --gestures regression: each gesture defect is reported, and the
 * clean twin of the same page stays silent.
 *
 *   defect.html - a long press opens a menu under the finger and lets the tail of
 *                 the gesture through (contextmenu reaches the menu); list
 *                 buttons react to click only, so a tap right after a swipe is
 *                 lost to "stop scrolling";
 *   clean.html  - the same page with both fixes: the long press swallows its own
 *                 contextmenu and click at the document level, list buttons act
 *                 on touchend.
 *
 * Run: node tests/tap/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUESTED_PORT = Number(process.env.PORT || 0); // 0: any free port, so parallel runs never collide
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-tap.mjs", import.meta.url));
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

const runCheck = (page, env = {}) =>
  new Promise((done) => {
    const run = spawn("node", [script, "--url", `http://127.0.0.1:${PORT}${page}`, "--gestures"], {
      env: { ...process.env, ...env },
    });
    let text = "";
    run.stdout.on("data", (c) => (text += c));
    run.stderr.on("data", (c) => (text += c));
    run.on("close", (code) => done({ text, code }));
  });

// One browser at a time: the machine this runs on may be small.
const defect = await runCheck("/defect.html");
const clean = await runCheck("/clean.html");
const webkit = await runCheck("/defect.html", { FQ_BROWSER: "webkit" });
server.close();

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) fails.push(label);
};

// A crashed run would read as "no findings". Demand the report line itself.
for (const [name, run] of [["defect", defect], ["clean", clean]]) {
  if (!run.text.includes("Blocking:")) {
    console.error(`verify-tap did not reach its report on ${name}.html. Output:\n${run.text.trim()}`);
    console.error("\nIf it complains about playwright: npm install in skills/frontend-quality");
    process.exit(1);
  }
}

const lineWith = (text, needle) => text.split("\n").find((l) => l.includes(needle))?.trim() || "";

const ghost = lineWith(defect.text, "the click after release landed on");
check(ghost.startsWith("BLOCK"), "hold: the click after release acting on the menu under the finger is a BLOCK", ghost);
const menu = lineWith(defect.text, "contextmenu reached");
check(menu.startsWith("BLOCK"), "hold: contextmenu reaching the menu that appeared under the finger is a BLOCK", menu);
const swipe = lineWith(defect.text, "swipe-then-tap");
check(swipe.startsWith("FLAG"), "swipe-then-tap: a click-only button revealed by a swipe is flagged", swipe);
check(defect.code === 1, "defect page exits 1", `exit ${defect.code}`);

const noise = clean.text.split("\n").filter((l) => /^\s*(BLOCK|FLAG)/.test(l)).map((l) => l.trim());
check(noise.length === 0, "clean twin: no findings", noise.join(" | "));
check(clean.code === 0, "clean twin exits 0", `exit ${clean.code}`);
// Silence must come from a probe that ran, not from one that was skipped.
const swipeRan = lineWith(clean.text, "swipe on div#list");
check(/reacted on touchend/.test(swipeRan), "clean twin: the swipe probe ran and saw the touchend reaction", swipeRan);

// Another engine: CDP touch does not exist there — one explicit line, not a pass in disguise.
if (/not installed/.test(webkit.text)) {
  console.log("SKIP :: webkit is not installed for Playwright here");
} else {
  const skipped = lineWith(webkit.text, "skipped on webkit");
  check(Boolean(skipped) && !/BLOCK|FLAG/.test(webkit.text), "webkit: gestures reported as skipped", skipped);
}

if (fails.length) {
  console.log("\n--- defect output ---\n" + defect.text.trim());
  console.log("\n--- clean output ---\n" + clean.text.trim());
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
