#!/usr/bin/env node
/* ============================================================
   Runs every suite in this directory in sequence and reports one total.

   Until Phase 5D, only two of these suites lived in the repository — the rest
   sat in a scratch directory outside it and would not have survived a clone.
   They are all here now, they all resolve their paths from __dirname, and this
   runner is what makes "the tests pass" a checkable claim rather than a
   report of what happened on one machine.

   Usage:  npm test                      (expects the app on TEST_BASE)
           TEST_BASE=http://localhost:8123 node tests/run-all.js

   Every suite needs a running server and the development database. Suites that
   create accounts remove them; none deletes an audit entry.
   ============================================================ */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR = __dirname;
const BASE = process.env.TEST_BASE || 'http://localhost:8123';

/* Ordered roughly as the phases were built, so a failure reads as a timeline.
   run-all itself is excluded. */
const SUITES = [
  'phase0_sec', 'phase0_role', 'acceptance', 'qa1', 'qa2', 'qa3', 'portal',
  'phase2b', 'phase2c', 'phase3', 'phase4', 'phase5a',
  'phase5a_security', 'phase5b_location', 'phase5d_hardening',
  'phase5e_production', 'tamper',
  'sourcetruth', 'sourcetruth15', 'crossref'
];

const missing = SUITES.filter(s => !fs.existsSync(path.join(DIR, s + '.js')));
if (missing.length) {
  console.error('Missing suite file(s): ' + missing.join(', '));
  process.exit(2);
}

/* Global, because a suite may print more than one section total — `portal`
   reports its own 35 and then 21 more for the Phase 2C additions. Taking only
   the first (or only the last) silently undercounts it. */
const COUNT = /(\d+)\s+passed,\s+(\d+)\s+failed|passed\s+(\d+)\s+failed\s+(\d+)/g;
const METRIC = /(\d+)\s+metric\(s\) match the database,\s+(\d+)\s+mismatch|(\d+)\s+match,\s+(\d+)\s+mismatch/g;

let totalPass = 0, totalFail = 0, hardFailures = [];

console.log(`\nRunning ${SUITES.length} suites against ${BASE}\n` + '='.repeat(64));

for (const name of SUITES) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, name + '.js')], {
    encoding: 'utf8',
    env: { ...process.env, TEST_BASE: BASE },
    timeout: 10 * 60 * 1000
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const counts = [...out.matchAll(COUNT)];
  const metrics = [...out.matchAll(METRIC)];
  let pass = 0, fail = 0, summary;

  if (counts.length) {
    for (const g of counts) { pass += Number(g[1] ?? g[3]); fail += Number(g[2] ?? g[4]); }
    summary = `${pass} passed, ${fail} failed`
            + (counts.length > 1 ? ` (${counts.length} sections)` : '');
  } else if (metrics.length) {
    for (const g of metrics) { pass += Number(g[1] ?? g[3]); fail += Number(g[2] ?? g[4]); }
    summary = `${pass} matched, ${fail} mismatched`;
  } else if (/self-contained/.test(out)) {
    summary = 'ok — both portals self-contained';
  } else {
    summary = 'NO SUMMARY LINE';
    hardFailures.push(name);
  }

  totalPass += pass; totalFail += fail;
  if (fail > 0 || r.status !== 0) hardFailures.push(name);

  const flag = (fail > 0 || r.status !== 0 || summary === 'NO SUMMARY LINE') ? 'FAIL' : ' ok ';
  console.log(`  ${flag}  ${name.padEnd(18)} ${summary.padEnd(30)} ${secs}s`);
  if (flag === 'FAIL') {
    for (const line of out.split('\n').filter(l => /^\s+FAIL/.test(l)).slice(0, 6)) {
      console.log('        ' + line.trim());
    }
    if (r.status !== 0 && !counts.length && !metrics.length) console.log('        exit ' + r.status);
  }
}

console.log('='.repeat(64));
console.log(`  ${totalPass} passed, ${totalFail} failed across ${SUITES.length} suites`);
if (hardFailures.length) {
  console.log('  suites needing attention: ' + [...new Set(hardFailures)].join(', '));
}
process.exitCode = (totalFail > 0 || hardFailures.length) ? 1 : 0;
