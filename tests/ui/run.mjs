/**
 * verify-ui regression: hydration errors are named as such, links to missing
 * sections are reported, and the scenario's ignoreConsole is honoured.
 *
 * page.html prints three console errors and links to four fragments:
 *
 *   "Minified React error #418"   - a production hydration mismatch: BLOCK, named;
 *   uncaught "Hydration failed…"  - the same class as an uncaught exception: BLOCK;
 *   "harness noise: …"            - declared in scenario.mjs → ignoreConsole: silent
 *                                   (the list used to be dropped on the way in);
 *   href="#pricing"               - no such id: FLAG;
 *   href="#faq", "#", "#/settings" - fine: silent.
 *
 * It also runs with --font-scale 1.25, so the option is exercised, and the page
 * is over 7000 px long, so every full-page shot must get a .preview.jpg that an
 * agent can open (at most 2000 px tall).
 *
 * Run: node tests/ui/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Port 0: the system picks a free one, so parallel test runs never collide.
const REQUESTED_PORT = Number(process.env.PORT || 0);
const html = readFileSync(new URL("./page.html", import.meta.url));
const script = fileURLToPath(new URL("../../skills/frontend-quality/scripts/verify-ui.mjs", import.meta.url));
const scenario = fileURLToPath(new URL("./scenario.mjs", import.meta.url));
const config = fileURLToPath(new URL("./uiverify.json", import.meta.url));

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((done) => server.listen(REQUESTED_PORT, "127.0.0.1", done));
const PORT = server.address().port;

// A scratch working directory: screenshots land there, not in the repository.
const cwd = mkdtempSync(join(tmpdir(), "fq-ui-"));
const out = await new Promise((done) => {
  const run = spawn("node", [script, "--scenario", scenario, "--config", config, "--font-scale", "1.25"], {
    cwd,
    env: { ...process.env, UI_FIXTURE_URL: `http://127.0.0.1:${PORT}/` },
  });
  let text = "";
  run.stdout.on("data", (c) => (text += c));
  run.stderr.on("data", (c) => (text += c));
  run.on("close", () => done(text));
});
server.close();

// A crashed run would otherwise read as "no findings", that is, as a pass.
if (!out.includes("Blocking:")) {
  console.error("verify-ui did not run — there is no report. Output:\n" + out.trim());
  console.error("\nIf it complains about playwright: npm install in skills/frontend-quality");
  process.exit(1);
}

const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) fails.push(label);
};
const lines = out.split("\n");
/** Finding text: a BLOCK prints its detail on the next line, a FLAG on the same. */
const blocks = lines.flatMap((l, i) => (l.trim().startsWith("BLOCK") ? [`${l.trim()} ${(lines[i + 1] || "").trim()}`] : []));
const flags = lines.filter((l) => l.trim().startsWith("FLAG"));

const hydration = blocks.filter((l) => l.includes("[hydration]") && l.includes("hydration mismatch"));
check(hydration.some((l) => l.includes("#418")), "React error #418 is a BLOCK named hydration mismatch", hydration[0] || "");
check(hydration.some((l) => /uncaught .*Hydration failed/.test(l)), "an uncaught hydration error is reported too");
check(!out.includes("harness noise"), "scenario ignoreConsole is honoured — declared noise is silent");
check(flags.some((l) => l.includes("[broken-anchor]") && l.includes("#pricing")), "a link to a missing id is a FLAG", flags.find((l) => l.includes("#pricing")) || "");
check(!/#faq|"#"|#\/settings/.test(flags.join("\n")), "links to an existing id, bare # and hash routes stay silent");
check(/^Engine: \S+ \S+/m.test(out), "the report names the engine and its version", (out.match(/^Engine: .*/m) || [""])[0]);
check(/Font scale: 125%/.test(out), "--font-scale is applied and stated");
check(/× 2 widths/.test(out), "both new default sizes ran (smallest phone, landscape phone)");

/** JPEG height from its start-of-frame marker. */
const jpegHeight = (path) => {
  const b = readFileSync(path);
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return b.readUInt16BE(i + 5);
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
};
const previews = lines.map((l) => l.trim()).filter((l) => l.endsWith(".preview.jpg"));
const previewPath = previews[0] || ""; // printed as an absolute path
const previewOk = previews.length === 2 && existsSync(previewPath) && jpegHeight(previewPath) <= 2000;
check(
  /open the preview instead/.test(out) && previewOk,
  "a full-page shot over 7000 px gets a .preview.jpg of at most 2000 px, and the report points to it",
  previewPath ? `${previews.length} preview(s), first ${jpegHeight(previewPath)} px tall` : "no preview listed"
);

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(", ")}` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
