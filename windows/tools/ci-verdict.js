'use strict';
// Reads the Playwright results and the YouTube marker the tests write, and decides what the run proved.
//   pass                every test passed (or was skipped with a reason)
//   blocked-by-youtube  the only failures are tests tagged [needs-youtube] and the tests recorded a refusal from YouTube
//   fail                anything else, including a missing results file
// Writes verdict.json next to the results, sets the `verdict` step output and a job summary.
// Exit code is 0 only for `pass`, so a blocked run is red in the Actions list too.
//
// Usage: node tools/ci-verdict.js [artifacts-dir]
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || process.env.E2E_ARTIFACTS || path.join(__dirname, '..', 'dist', 'e2e-artifacts'));

function readJson(name) { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { return null; } }

function flatten(suite, out) {
  (suite.specs || []).forEach((spec) => {
    (spec.tests || []).forEach((t) => {
      const last = (t.results || []).slice(-1)[0] || {};
      out.push({ title: spec.title, status: t.status, outcome: last.status || t.status, error: last.error ? String(last.error.message || '').split('\n')[0] : '' });
    });
  });
  (suite.suites || []).forEach((s) => flatten(s, out));
  return out;
}

const res = readJson('playwright-results.json');
const yt = readJson('youtube-status.json') || {};
let verdict = 'fail', reason = '', tests = [];

if (!res) {
  reason = 'playwright-results.json is missing, so the tests did not finish';
} else {
  tests = flatten({ suites: res.suites || [] }, []);
  const failed = tests.filter((t) => t.status === 'unexpected' || t.status === 'flaky' || t.outcome === 'failed' || t.outcome === 'timedOut');
  if (tests.length === 0) reason = 'no tests ran';
  else if (failed.length === 0) { verdict = 'pass'; reason = tests.length + ' tests, none failed'; }
  else if (failed.every((t) => /\[needs-youtube\]/.test(t.title)) && yt['blocked-by-youtube'] === true) {
    verdict = 'blocked-by-youtube';
    reason = 'YouTube refused the player (' + (yt.reason || 'no reason recorded') + ', code ' + yt.code + '). Failed: ' + failed.map((t) => t.title).join('; ');
  } else reason = 'failed: ' + failed.map((t) => t.title + ' => ' + t.error).join(' || ');
}

const out = { verdict, reason, counts: tests.reduce((a, t) => { a[t.outcome] = (a[t.outcome] || 0) + 1; return a; }, {}), youtube: yt, tests };
try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify(out, null, 2)); } catch (e) { console.log('could not write verdict.json: ' + e.message); }

const lines = ['## B-Side Windows e2e verdict: ' + verdict, '', reason, ''];
tests.forEach((t) => lines.push('- ' + t.outcome + ': ' + t.title));
if (verdict === 'blocked-by-youtube') lines.push('', 'The app is not shown to be at fault, but playback is NOT proven on this run. Re-run, or test on a real machine.');
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) { /* ignore */ } }
if (process.env.GITHUB_OUTPUT) { try { fs.appendFileSync(process.env.GITHUB_OUTPUT, 'verdict=' + verdict + '\n'); } catch (e) { /* ignore */ } }
process.exit(verdict === 'pass' ? 0 : 1);
