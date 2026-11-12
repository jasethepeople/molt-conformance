#!/usr/bin/env node
// Implementation-independent conformance runner. Knows nothing about L1 or Foundry.
// Usage: node runner.mjs --verifier "node adapters/l1.mjs" [--json out.json]
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function die(m) { console.error(`runner: ${m}`); process.exit(2); }

function parseArgs(argv) {
  const o = { fixtures: path.join(ROOT, 'fixtures'), verifier: null,
              json: null, filter: null, pending: false, timeout: 30000, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verifier') o.verifier = argv[++i];
    else if (a === '--fixtures') o.fixtures = path.resolve(argv[++i]);
    else if (a === '--json') o.json = path.resolve(argv[++i]);
    else if (a === '--filter') o.filter = argv[++i];
    else if (a === '--include-pending') o.pending = true;
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else die(`unknown argument: ${a}`);
  }
  return o;
}

function loadFixtures(dir, includePending, filter) {
  if (!existsSync(dir)) die(`fixtures dir not found: ${dir}`);
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const fd = path.join(dir, name);
    if (!statSync(fd).isDirectory()) continue;
    const metaPath = path.join(fd, 'fixture.json');
    const pkgPath = path.join(fd, 'package');
    if (!existsSync(metaPath) || !existsSync(pkgPath)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); }
    catch (e) { die(`${name}/fixture.json is not valid JSON: ${e.message}`); }
    if (!meta.id || !meta.expect || typeof meta.expect.ok !== 'boolean')
      die(`${name}/fixture.json missing id or boolean expect.ok`);
    if (meta.pending && !includePending) continue;
    if (filter && !meta.id.includes(filter)) continue;
    out.push({ dir: fd, pkg: pkgPath, meta });
  }
  if (!out.length) die('no fixtures matched');
  return out;
}

// The adapter contract: argv[1] is the package dir. Its LAST non-empty stdout
// line must be a JSON object {ok:boolean, check?:string, reason?:string, anchor?:string}.
// Exit code is ignored. Non-JSON or missing ok => ADAPTER_ERROR (a finding, not a pass).
function invoke(cmd, pkg, timeout) {
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (!parts.length) die('--verifier is empty');
  const r = spawnSync(parts[0], [...parts.slice(1), pkg],
    { encoding: 'utf8', timeout, maxBuffer: 16 << 20 });
  if (r.error) return { protocol: 'error', detail: String(r.error.message) };
  const lines = (r.stdout || '').trim().split('\n').filter(l => l.trim());
  if (!lines.length) return { protocol: 'error', detail: 'adapter produced no stdout' };
  let obj;
  try { obj = JSON.parse(lines[lines.length - 1]); }
  catch { return { protocol: 'error', detail: `adapter last line is not JSON: ${lines.at(-1).slice(0,200)}` }; }
  if (typeof obj.ok !== 'boolean') return { protocol: 'error', detail: 'adapter JSON has no boolean ok' };
  return { protocol: 'ok', outcome: obj, stderr: (r.stderr || '').slice(0, 2000) };
}

function judge(meta, outcome) {
  const e = meta.expect;
  if (outcome.ok !== e.ok)
    return { status: 'MISMATCH_VERDICT',
             detail: `expected ok=${e.ok}, got ok=${outcome.ok}${outcome.check ? ` (${outcome.check})` : ''}` };
  if (e.check && outcome.check && e.check !== outcome.check)
    return { status: 'MISMATCH_CHECK', detail: `expected ${e.check}, got ${outcome.check}` };
  if (e.anchor && outcome.anchor && e.anchor !== outcome.anchor)
    return { status: 'MISMATCH_ANCHOR', detail: `expected anchor ${e.anchor}, got ${outcome.anchor}` };
  const unchecked = [];
  if (e.check && !outcome.check) unchecked.push('check');
  if (e.anchor && !outcome.anchor) unchecked.push('anchor');
  return { status: 'MATCH', unchecked };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || (!opt.verifier && !opt.list)) {
    console.log(`usage: node runner.mjs --verifier "<cmd>" [--fixtures DIR] [--filter S] [--include-pending] [--json FILE] [--list]`);
    process.exit(opt.help ? 0 : 2);
  }
  const fixtures = loadFixtures(opt.fixtures, opt.pending, opt.filter);
  if (opt.list) {
    for (const f of fixtures)
      console.log(`${f.meta.pending ? 'P' : ' '} ${f.meta.id.padEnd(34)} ${f.meta.expect.ok ? 'PASS' : 'FAIL'} ${f.meta.expect.check || '-'}`);
    return;
  }

  const results = [];
  for (const f of fixtures) {
    const res = invoke(opt.verifier, f.pkg, opt.timeout);
    let row;
    if (res.protocol !== 'ok') {
      row = { id: f.meta.id, class: f.meta.class, pending: !!f.meta.pending,
              status: 'ADAPTER_ERROR', detail: res.detail, expect: f.meta.expect };
    } else {
      const j = judge(f.meta, res.outcome);
      row = { id: f.meta.id, class: f.meta.class, pending: !!f.meta.pending,
              status: j.status, detail: j.detail || '', unchecked: j.unchecked || [],
              expect: f.meta.expect, got: res.outcome };
    }
    results.push(row);
    const tag = row.status === 'MATCH' ? 'ok  ' : row.status === 'ADAPTER_ERROR' ? 'ERR ' : 'FAIL';
    console.log(`${tag} ${row.id.padEnd(34)} ${row.status}${row.detail ? ' — ' + row.detail : ''}`);
  }

  const scored = results.filter(r => !r.pending);
  const pending = results.filter(r => r.pending);
  const bad = scored.filter(r => r.status !== 'MATCH');
  const unchecked = scored.filter(r => (r.unchecked || []).length);

  const summary = {
    total: results.length, scored: scored.length, passed: scored.length - bad.length,
    failed: bad.length, pending: pending.length,
    check_coverage_gaps: unchecked.map(r => r.id),
    verdict: bad.length === 0 ? 'CONFORMANT' : 'NONCONFORMANT'
  };
  console.log(`\n${summary.verdict}: ${summary.passed}/${summary.scored} scored fixtures matched, ` +
              `${summary.pending} pending (excluded), ${unchecked.length} with unverifiable checks.`);
  if (unchecked.length) console.log(`check-coverage gaps (adapter supplied no "check"): ${unchecked.map(r => r.id).join(', ')}`);

  if (opt.json) {
    writeFileSync(opt.json, JSON.stringify({ verifier: opt.verifier, summary, results }, null, 2));
    console.log(`wrote ${opt.json}`);
  }
  process.exit(bad.length === 0 ? 0 : 1);
}

main();
