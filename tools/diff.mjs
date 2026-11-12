#!/usr/bin/env node
// Usage: node tools/diff.mjs l1.json foundry.json
// Reads two runner --json outputs, reports per-fixture agreement.
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
const byId = r => new Map(r.results.map(x => [x.id, x]));
const A = byId(a), B = byId(b);
const ids = [...new Set([...A.keys(), ...B.keys()])].sort();

let agree = 0, disagree = 0;
const findings = [];
for (const id of ids) {
  const x = A.get(id), y = B.get(id);
  if (!x || !y) { findings.push({ id, status: 'MISSING', a: x?.status, b: y?.status }); disagree++; continue; }
  if (x.status === 'ADAPTER_ERROR' || y.status === 'ADAPTER_ERROR') {
    findings.push({ id, status: 'ADAPTER_ERROR', a: x.status, b: y.status }); disagree++; continue;
  }
  if (x.got.ok === y.got.ok) {
    agree++;
    // check-level agreement only where both emitted a check
    if (x.got.check && y.got.check && x.got.check !== y.got.check)
      findings.push({ id, status: 'CHECK_DISAGREE', a: x.got.check, b: y.got.check });
  } else {
    disagree++;
    findings.push({ id, status: 'VERDICT_DISAGREE',
                    a: { ok: x.got.ok, check: x.got.check, reason: x.got.reason },
                    b: { ok: y.got.ok, check: y.got.check, reason: y.got.reason } });
  }
}
console.log(`agreement: ${agree}/${ids.length}, disagreements: ${disagree}`);
for (const f of findings) console.log(JSON.stringify(f));
process.exit(disagree === 0 ? 0 : 1);
