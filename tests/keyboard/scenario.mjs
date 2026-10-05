/**
 * Scenario for the keyboard fixture: two sheets with a text field each. The
 * address comes from run.mjs, which serves page.html on a free port.
 */
export const name = 'keyboard fixture';
export const url = process.env.KEYBOARD_FIXTURE_URL || 'http://127.0.0.1:8978/';

export const keyboardTargets = [
  {
    name: 'good sheet',
    open: async (page) => page.click('#open-good'),
    field: '#good-field',
    inside: '#good',
  },
  {
    // No `inside`: the sheet is found from the field (role="dialog").
    name: 'broken sheet',
    open: async (page) => page.click('#open-broken'),
    field: '#broken-field',
  },
];
