/**
 * Scenario for the verify-motion regression: the page comes from MOTION_URL,
 * the two interactions are where the animations get cut (or not).
 */
export const name = 'motion fixture';
export const url = process.env.MOTION_URL;

export const interactions = [
  {
    name: 'dismiss the toast',
    run: async (page) => {
      await page.click('#dismiss');
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'slide the panel',
    run: async (page) => {
      await page.click('#slide');
      await page.waitForTimeout(600);
    },
  },
];
