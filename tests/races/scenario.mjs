/**
 * Scenario for the verify-races regression. The page and its mock backend come
 * from run.mjs (RACES_URL); every toggle is one action.
 */
export const name = 'races fixture';
export const url = process.env.RACES_URL;

export async function ready(page) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#row-correct');
}

const toggle = (id) => ({
  name: `toggle ${id}`,
  run: (page) => page.click(`#row-${id} button`, { timeout: 1000 }),
  request: new RegExp(`POST .*/api/toggle/${id}$`),
  settleMs: 2500,
  readState: (page) => page.textContent(`#row-${id} .state`),
});

export const actions = ['double', 'rollback', 'stale', 'silent', 'liar', 'correct'].map(toggle);

export async function refresh(page) {
  await page.click('#refresh');
}
export const refreshRequest = /\/api\/state$/;
export const successText = ['Saved'];
