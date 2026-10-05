/**
 * Scenario for the verify-ui fixture. The address comes from run.mjs. The
 * ignoreConsole list is part of the test: harness noise declared here must not
 * turn into a finding.
 */
export const name = 'ui fixture';
export const url = process.env.UI_FIXTURE_URL || 'http://127.0.0.1:8980/';
export const ignoreConsole = ['harness noise'];
