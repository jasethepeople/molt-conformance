#!/usr/bin/env node
import { verifyMoltPackage } from '../vendor/l1/verifier.mjs';
import { readFileSync } from 'node:fs';

const MAP = JSON.parse(readFileSync(new URL('./l1-map.json', import.meta.url), 'utf8'));
const pkg = process.argv[2];
if (!pkg) { console.log(JSON.stringify({ ok: false, reason: 'adapter: no package dir' })); process.exit(0); }

let r;
try { r = await verifyMoltPackage(pkg); }
catch (e) { console.log(JSON.stringify({ ok: false, reason: 'adapter: threw: ' + e.message })); process.exit(0); }

const out = { ok: !!r.valid, reason: r.reason ?? null };
if (r.anchor) out.anchor = r.anchor === 'verified' ? 'present' : 'none';
if (!r.valid && r.checkId) {
  const table = MAP[r.checkId];
  if (table) {
    let m = r.reason != null && Object.prototype.hasOwnProperty.call(table, r.reason)
      ? table[r.reason]
      : undefined;

    // Prefix match for dynamic L1 reasons (e.g. "Artifact byte count mismatch for 'x'.")
    if (m === undefined && typeof r.reason === 'string') {
      for (const key of Object.keys(table)) {
        if (key === '*') continue;
        if (r.reason.startsWith(key)) { m = table[key]; break; }
      }
    }

    // Wildcard fallback
    if (m === undefined) m = table['*'];

    // null means "ambiguous — omit check"; undefined means "no mapping — omit check"
    if (m) out.check = m;
  }
}
console.log(JSON.stringify(out));
