#!/usr/bin/env node
// Adapter for the Go verifier (molt-verify-go). Spawns the Go binary with the
// package dir as argv[1], parses its one JSON line {ok, check, reason, anchor},
// and maps (checkId, reason) to the conformance enum via l1-map.json — the
// same mapping the L1 adapter uses, since the Go binary emits the same
// V-01..V-10 check IDs and L1-compatible reason strings.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAP = JSON.parse(readFileSync(new URL('./l1-map.json', import.meta.url), 'utf8'));
const GO_BIN = process.env.MOLT_GO_BIN || new URL('../../molt-verify-go/molt-verify-go', import.meta.url).pathname;

const pkg = process.argv[2];
if (!pkg) { console.log(JSON.stringify({ ok: false, reason: 'adapter: no package dir' })); process.exit(0); }

const r = spawnSync(GO_BIN, [pkg], { encoding: 'utf8', timeout: 30000 });
if (r.error) { console.log(JSON.stringify({ ok: false, reason: 'adapter: threw: ' + r.error.message })); process.exit(0); }

const lines = (r.stdout || '').trim().split('\n').filter(l => l.trim());
if (!lines.length) { console.log(JSON.stringify({ ok: false, reason: 'adapter: threw: no stdout from Go verifier' })); process.exit(0); }

let go;
try { go = JSON.parse(lines[lines.length - 1]); }
catch { console.log(JSON.stringify({ ok: false, reason: 'adapter: threw: Go output is not JSON: ' + lines[lines.length - 1].slice(0, 200) })); process.exit(0); }

if (typeof go.ok !== 'boolean') { console.log(JSON.stringify({ ok: false, reason: 'adapter: threw: Go output has no boolean ok' })); process.exit(0); }

const out = { ok: !!go.ok, reason: go.reason ?? null };
if (go.anchor) out.anchor = go.anchor === 'present' ? 'present' : 'none';

if (!go.ok && go.check) {
  const table = MAP[go.check];
  if (table) {
    let m = go.reason != null && Object.prototype.hasOwnProperty.call(table, go.reason)
      ? table[go.reason]
      : undefined;

    // Prefix match for dynamic reasons (e.g. "Artifact byte count mismatch for 'x'.")
    if (m === undefined && typeof go.reason === 'string') {
      for (const key of Object.keys(table)) {
        if (key === '*') continue;
        if (go.reason.startsWith(key)) { m = table[key]; break; }
      }
    }

    // Wildcard fallback
    if (m === undefined) m = table['*'];

    // null means "ambiguous — omit check"; undefined means "no mapping — omit check"
    if (m) out.check = m;
  }
}
console.log(JSON.stringify(out));
