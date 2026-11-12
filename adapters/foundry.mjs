#!/usr/bin/env node
import { independentlyVerifyMoltPackage } from '../vendor/foundry/independent-verifier.ts';

const pkg = process.argv[2];
let r;
try { r = await independentlyVerifyMoltPackage(pkg); }
catch (e) { console.log(JSON.stringify({ ok: false, reason: 'adapter: threw: ' + e.message })); process.exit(0); }

const out = { ok: !!r.valid, reason: r.reason ?? null };
if (r.anchoring) out.anchor = r.anchoring === 'verified' ? 'present' : 'none';
console.log(JSON.stringify(out));
