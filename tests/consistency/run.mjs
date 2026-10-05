/**
 * verify-consistency regression: every defect on the broken page is reported,
 * and two clean pages built on the same layout stay silent.
 *
 *   a.html, b.html - one layout, different content: same column, same heading,
 *                    aligned card rows, tab panels stacked in one grid cell,
 *                    centred buttons, rings only for the keyboard;
 *   c.html         - the same layout with one override per defect: asymmetric
 *                    column padding, a bigger and lower heading, a card title
 *                    that pushes its price down, tab panels that change the
 *                    section height, an off-centre button, a label too wide for
 *                    its button, no ring for the keyboard in the header, a ring
 *                    after a mouse click in the content, too many words.
 *
 * Run: node tests/consistency/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUESTED_PORT = Number(process.env.PORT || 0); // 0: any free port, so parallel runs never collide
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-consistency.mjs", import.meta.url));
const types = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript" };
const files = Object.fromEntries(
  ["a.html", "b.html", "c.html", "base.css", "tabs.js"].map((f) => [`/${f}`, readFileSync(new URL(`./${f}`, import.meta.url))])
);

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const body = files[path];
  res.writeHead(body ? 200 : 404, { "Content-Type": types[path.split(".").pop()] || "text/plain" });
  res.end(body || "not found");
});
await new Promise((done) => server.listen(REQUESTED_PORT, "127.0.0.1", done));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), "consistency-"));
const configFor = (pages) => {
  const path = join(dir, `${pages.join("-")}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      consistency: {
        urls: pages.map((p) => `${base}/${p}`),
        content: "main",
        heading: "h1",
        groups: [{ name: "cards", item: ".card", rows: ["h3", ".price"] }],
        toggles: [{ name: "tabs", trigger: "[role=tab]", section: "[role=tabpanel]" }],
        buttons: "button, a.btn",
        maxWords: 200,
      },
    })
  );
  return path;
};

const runCheck = (args) =>
  new Promise((done) => {
    const run = spawn("node", [script, ...args]);
    let text = "";
    run.stdout.on("data", (c) => (text += c));
    run.stderr.on("data", (c) => (text += c));
    run.on("close", (code) => done({ text, code }));
  });

// One browser at a time.
const defect = await runCheck(["--config", configFor(["a.html", "c.html"])]);
const clean = await runCheck(["--config", configFor(["a.html", "b.html"])]);
const plain = await runCheck(["--url", `${base}/a.html`, "--url", `${base}/b.html`, "--config", join(dir, "none.json")]);
server.close();
rmSync(dir, { recursive: true, force: true });

for (const [name, run] of [["defect", defect], ["clean", clean], ["plain --url", plain]]) {
  if (!run.text.includes("Blocking:")) {
    console.error(`verify-consistency did not reach its report (${name}). Output:\n${run.text.trim()}`);
    process.exit(1);
  }
}

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) fails.push(label);
};
const findings = (text) => text.split("\n").filter((l) => /^\s*(BLOCK|FLAG)/.test(l)).map((l) => l.trim());
const found = (severity, ...needles) =>
  findings(defect.text).find((l) => l.startsWith(severity) && needles.every((n) => l.includes(n))) || "";

const expected = [
  ["BLOCK", "gutters differ on the broken page", ["/c.html: gutters", "off-centre"]],
  ["BLOCK", "column width differs between pages", ["between pages: column width"]],
  ["BLOCK", "heading top differs between pages", ["between pages: heading top"]],
  ["BLOCK", "heading size differs between pages", ["between pages: heading size", "28px", "32px"]],
  ["BLOCK", "card prices are not on one line", ["/c.html cards", "«.price» tops differ"]],
  ["BLOCK", "tab switch changes the section height", ["/c.html tabs: switching changes the section height"]],
  ["FLAG", "off-centre button content", ["/c.html button «Pay»", "off-centre"]],
  ["FLAG", "label spilling into the padding", ["/c.html button «Subscribe", "spills"]],
  ["FLAG", "ring after a mouse click", ["/c.html: «Read more» shows a focus ring after a mouse click"]],
  ["BLOCK", "no ring after Tab", ["/c.html: no visible focus ring after Tab on «Home»"]],
  ["FLAG", "word budget exceeded", ["/c.html:", "words in \"main\""]],
];
for (const [severity, label, needles] of expected) {
  const line = found(severity, ...needles);
  check(Boolean(line), `${label} (${severity})`, line);
}
// Per-width numbers for toggles must be printed, not only the verdict.
check((defect.text.match(/\/c\.html tabs: switching/g) || []).length >= 2, "toggle heights reported per width");
check(defect.code === 1, "defect run exits 1", `exit ${defect.code}`);

// The clean pages must stay silent, and must have been measured.
check(findings(clean.text).length === 0, "clean pages: no findings", findings(clean.text).join(" | "));
check(/ok {4}\/b\.html tabs: \d+\/\d+\/\d+ px/.test(clean.text), "clean pages: toggle heights were measured");
check(/ok {4}\/a\.html: ring after Tab/.test(clean.text), "clean pages: the keyboard ring was seen");
check(clean.code === 0, "clean run exits 0", `exit ${clean.code}`);
check(findings(plain.text).length === 0 && plain.code === 0, "repeated --url without config: clean", findings(plain.text).join(" | "));

if (fails.length) {
  console.log("\n--- defect ---\n" + defect.text.trim() + "\n\n--- clean ---\n" + clean.text.trim() + "\n\n--- plain ---\n" + plain.text.trim());
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
