/**
 * verify-keyboard regression: a sheet built right stays silent, a broken one is
 * reported — in both keyboard models.
 *
 * page.html holds two sheets with a quantity field and −/+ buttons:
 *
 *   good sheet    buttons keep focus in the field, a fixed height whose bottom
 *                 edge follows the keyboard, a list with overscroll containment,
 *                 history back closes it;
 *   broken sheet  plain buttons take focus (the keyboard would close on every
 *                 tap), the height follows visualViewport (the sheet jumps when
 *                 the keyboard closes), glued to the layout bottom (under the
 *                 keyboard in the overlay model), the page under it scrolls,
 *                 history back ignores it.
 *
 * Run: node tests/keyboard/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Port 0: the system picks a free one, so parallel test runs never collide.
const REQUESTED_PORT = Number(process.env.PORT || 0);
const html = readFileSync(new URL("./page.html", import.meta.url));
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-keyboard.mjs", import.meta.url));
const scenario = fileURLToPath(new URL("./scenario.mjs", import.meta.url));

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((done) => server.listen(REQUESTED_PORT, "127.0.0.1", done));
const PORT = server.address().port;

const out = await new Promise((done) => {
  const run = spawn("node", [script, "--scenario", scenario, "--out", mkdtempSync(join(tmpdir(), "fq-keyboard-"))], {
    env: { ...process.env, KEYBOARD_FIXTURE_URL: `http://127.0.0.1:${PORT}/` },
  });
  let text = "";
  run.stdout.on("data", (c) => (text += c));
  run.stderr.on("data", (c) => (text += c));
  run.on("close", () => done(text));
});
server.close();

// A crashed run (no browser, no dependencies) would otherwise read as "no
// findings", that is, as a pass.
if (!out.includes("Blocking:")) {
  console.error("verify-keyboard did not run — there is no report. Output:\n" + out.trim());
  console.error("\nIf it complains about playwright: npm install in skills/frontend-quality");
  process.exit(1);
}

/** Finding lines of one section: «name» — <section heading prefix>. */
const section = (name, heading) => {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.trim().startsWith(`«${name}» — ${heading}`));
  if (at < 0) return null;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || line.trim().startsWith("«")) break;
    body.push(line.trim());
  }
  return body;
};

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) fails.push(label);
};

for (const model of ["resize", "overlay"]) {
  const good = section("good sheet", `${model}:`);
  check(
    good !== null && good.every((l) => !/^(BLOCK|FLAG)/.test(l)),
    `good sheet, ${model} — no findings`,
    good === null ? "section missing" : good.join(" | ")
  );
  const broken = section("broken sheet", `${model}:`);
  const blocks = (broken || []).filter((l) => l.startsWith("BLOCK"));
  check(blocks.length > 0, `broken sheet, ${model} — reported`, blocks.join(" | ") || (broken || ["section missing"]).join(" | "));
}

// In the resize model the field stays visible; what breaks is the tap: focus
// leaves the field, and once the keyboard closes the sheet changes height.
const brokenResize = (section("broken sheet", "resize:") || []).join("\n");
check(/\[focus-steal\]/.test(brokenResize), "broken sheet, resize — the −/+ tap that takes focus is named");
check(/\[sheet-jump\]/.test(brokenResize), "broken sheet, resize — the height change across the tap is named");
// In the overlay model the sheet stays glued to the layout bottom: under the keyboard.
check(/\[under-keyboard\]/.test((section("broken sheet", "overlay:") || []).join("\n")), "broken sheet, overlay — the field under the keyboard is named");

const goodBehaviour = section("good sheet", "scrolling and history back");
check(
  goodBehaviour !== null && goodBehaviour.every((l) => !/^(BLOCK|FLAG)/.test(l)),
  "good sheet — no scroll chaining, closes on back",
  (goodBehaviour || ["section missing"]).join(" | ")
);
const brokenBehaviour = (section("broken sheet", "scrolling and history back") || []).join("\n");
check(/\[scroll-chaining\]/.test(brokenBehaviour), "broken sheet — the page scrolling under it is named");
check(/\[back-(leaves|ignored)\]/.test(brokenBehaviour), "broken sheet — history back not closing it is named");
check(/needs a real device/.test(out), "the report says what emulation cannot show");

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(", ")}` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
