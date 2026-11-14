'use strict';
const path = require('path');
const { defineConfig } = require('@playwright/test');

const out = path.resolve(process.env.E2E_ARTIFACTS || path.join(__dirname, 'dist', 'e2e-artifacts'));

// One app at a time: the tests share a single running copy and a single user data folder.
module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240000,
  expect: { timeout: 15000 },
  outputDir: path.join(out, 'test-results'),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(out, 'playwright-results.json') }],
    ['html', { outputFolder: path.join(out, 'playwright-report'), open: 'never' }]
  ],
  use: { trace: 'off' }
});
