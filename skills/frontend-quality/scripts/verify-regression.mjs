#!/usr/bin/env node
/**
 * Visual regression: comparison against a baseline.
 *
 * The gap it closes. Every other check inspects the screen you were fixing. The
 * defect "touched the header, broke a card elsewhere" is caught by nobody: no
 * overlaps, clean console. It is only visible by comparing against how things
 * looked before.
 *
 * How it works. Baselines live in `.uiverify-baseline/`, are taken with
 * `--update` and committed alongside the code. Comparison is per-pixel; rather
 * than pull in a dependency for one operation, the browser does the diffing:
 * both images are drawn on a canvas and the difference is highlighted there.
 *
 * Live data (clocks, counters, other people's avatars) is masked by selectors
 * from `.uiverify.json` → `ignoreDiff`: the mask paints over the region before
 * the shot, so "the clock ticked" no longer reads as a regression.
 *
 * Usage:
 *   node verify-regression.mjs --url http://localhost:3000 --update   # take baseline
 *   node verify-regression.mjs --url http://localhost:3000            # compare
 *   node verify-regression.mjs --config .uiverify.json --threshold 0.2
 *
 * Exit: 0 — identical, 1 — difference above threshold, 2 — could not run.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, loadConfig, resolveTargets, closeQuietly } from './lib/session.mjs';

const DEFAULT_BREAKPOINTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'laptop', width: 1280, height: 800 },
];

/** Diffing two PNGs inside the browser: no dependencies, no hand-rolled decoder. */
const DIFF_IN_PAGE = async ({ baseline, current, tolerance }) => {
  const load = (dataUrl) =>
    new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error('image failed to load'));
      img.src = dataUrl;
    });

  const [a, b] = await Promise.all([load(baseline), load(current)]);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);

  const draw = (img) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  };

  const dataA = draw(a);
  const dataB = draw(b);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d');
  const diff = outCtx.createImageData(width, height);

  let changed = 0;
  for (let i = 0; i < dataA.data.length; i += 4) {
    const dr = Math.abs(dataA.data[i] - dataB.data[i]);
    const dg = Math.abs(dataA.data[i + 1] - dataB.data[i + 1]);
    const db = Math.abs(dataA.data[i + 2] - dataB.data[i + 2]);
    const delta = (dr + dg + db) / 3;
    if (delta > tolerance) {
      changed += 1;
      diff.data[i] = 255;
      diff.data[i + 1] = 0;
      diff.data[i + 2] = 96;
      diff.data[i + 3] = 255;
    } else {
      // Unchanged pixels fade to pale grey so only the differences stand out.
      const grey = 220 + (dataB.data[i] > 128 ? 20 : 0);
      diff.data[i] = grey;
      diff.data[i + 1] = grey;
      diff.data[i + 2] = grey;
      diff.data[i + 3] = 255;
    }
  }
  outCtx.putImageData(diff, 0, 0);

  return {
    width,
    height,
    changed,
    ratio: changed / (width * height),
    sizeMismatch: a.width !== b.width || a.height !== b.height,
    diffPng: out.toDataURL('image/png'),
  };
};

async function shoot(page, target, breakpoint, masks) {
  await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height });
  await target.ready(page);
  // Entry animations do not finish instantly; a shot taken mid-flight reports a
  // "regression" that is not there.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        /* infinite animations cannot be finished — leave them as they are */
      }
    }
  });
  const maskLocators = masks.map((selector) => page.locator(selector));
  return page.screenshot({ fullPage: true, mask: maskLocators, maskColor: '#808080' });
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);
  const baselineDir = resolve(args.baseline || config.baselineDir || '.uiverify-baseline');
  const outDir = resolve(args.out || join(config.outDir || '.uiverify-out', 'diff'));
  const threshold = Number(args.threshold || config.diffThreshold || 0.1) / 100;
  const tolerance = Number(args.tolerance || config.diffTolerance || 8);
  const breakpoints = config.breakpoints?.length ? config.breakpoints : DEFAULT_BREAKPOINTS;
  const masks = config.ignoreDiff || [];
  const update = args.update === true || args.update === 'true';

  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const targets = await resolveTargets(args, config);
  let blocking = 0;
  let updated = 0;
  let compared = 0;

  for (const target of targets) {
    const opened = await target.open({ throttle: 1 });
    const { page } = opened;
    try {
      for (const breakpoint of breakpoints) {
        const slug = `${String(target.name).replace(/[^\w-]+/g, '_').slice(-60)}-${breakpoint.name}`;
        const baselinePath = join(baselineDir, `${slug}.png`);
        const shot = await shoot(page, target, breakpoint, masks);

        if (update || !existsSync(baselinePath)) {
          writeFileSync(baselinePath, shot);
          updated += 1;
          console.log(`  baseline ${existsSync(baselinePath) && !update ? 'created' : 'updated'}: ${slug}`);
          continue;
        }

        const result = await page.evaluate(DIFF_IN_PAGE, {
          baseline: `data:image/png;base64,${readFileSync(baselinePath).toString('base64')}`,
          current: `data:image/png;base64,${shot.toString('base64')}`,
          tolerance,
        });
        compared += 1;

        const percent = (result.ratio * 100).toFixed(3);
        if (result.ratio > threshold || result.sizeMismatch) {
          blocking += 1;
          const diffPath = join(outDir, `${slug}.png`);
          writeFileSync(diffPath, Buffer.from(result.diffPng.split(',')[1], 'base64'));
          const size = result.sizeMismatch ? ', screenshot size changed' : '';
          console.log(`  BLOCK ${slug}: ${percent}% of pixels differ${size}`);
          console.log(`        highlighted difference: ${diffPath}`);
        } else {
          console.log(`  ok    ${slug}: difference ${percent}% (threshold ${(threshold * 100).toFixed(2)}%)`);
        }
      }
    } finally {
      await closeQuietly(opened);
    }
  }

  console.log(`\nBaselines: ${baselineDir}`);
  if (updated) console.log(`Baselines taken: ${updated}`);
  console.log(`Comparisons: ${compared} | differences above threshold: ${blocking}`);
  if (updated && !compared) {
    console.log('Baselines written. Commit them with the code — otherwise there is nothing to compare against.');
  }
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Check could not run: ${error.message}`);
  process.exit(2);
});
