#!/usr/bin/env node
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures');
const ZERO = '0'.repeat(64);
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const LABELS = {
  alice: 'molt-conformance/v1/alice',
  bob: 'molt-conformance/v1/bob',
  mallory: 'molt-conformance/v1/mallory'
};

function priv(label) {
  const seed = createHash('sha256').update(LABELS[label]).digest();
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der', type: 'pkcs8'
  });
}
function pubPem(label) {
  return createPublicKey(priv(label)).export({ format: 'pem', type: 'spki' });
}
function pubHex(label) {
  const der = Buffer.from(pubPem(label).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return der.subarray(-32).toString('hex');
}
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

function canonical(v) {
  if (v === null || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error('unsupported: ' + typeof v);
}

function body(ev) {
  return { seq: ev.seq, ts: ev.ts, type: ev.type, payload: ev.payload, actor: ev.actor };
}

function sealEvents(events, label, opts = {}) {
  let prev = ZERO;
  const fulls = [];
  const privk = priv(label);
  const pub = pubHex(label);

  for (const ev of events) {
    const b = body(ev);
    let hash, sig;

    if (opts.camp2Full) {
      const b7 = { ...b, prev_hash: prev, pub };
      hash = sha256(prev + canonical(b7));
      sig = sign(null, Buffer.from(canonical(b7), 'utf8'), privk).toString('hex');
    } else if (opts.hashBodyOnly) {
      hash = sha256(canonical(b));
      sig = sign(null, Buffer.from(hash, 'hex'), privk).toString('hex');
    } else {
      const hashBody = opts.hashBodyString ? opts.hashBodyString(ev, b) : canonical(b);
      hash = sha256(prev + hashBody);
      sig = opts.signCanonicalBody
        ? sign(null, Buffer.from(canonical(b), 'utf8'), privk).toString('hex')
        : sign(null, Buffer.from(hash, 'hex'), privk).toString('hex');
    }

    const full = {
      seq: b.seq, ts: b.ts, type: b.type, actor: b.actor,
      payload: b.payload, prev_hash: prev, pub, sig, hash
    };
    fulls.push(full);
    prev = hash;
  }
  return fulls;
}

function serialize(fulls) { return fulls.map(canonical).join('\n') + (fulls.length ? '\n' : ''); }

const ART = Buffer.from('molt conformance artifact\n');

function manifestFor(fulls, text, opts = {}) {
  const artifacts = opts.artifacts ?? { 'artifact.txt': sha256(ART) };
  const artifactBytes = opts.artifactBytes ?? { 'artifact.txt': ART.length };
  const agentPubkeys = opts.agentPubkeys ?? { alice: pubHex('alice') };
  const m = {
    artifacts,
    artifact_bytes: artifactBytes,
    agent_pubkeys: agentPubkeys,
    ledger_bytes: Buffer.byteLength(text, 'utf8')
  };
  if (opts.anchor) m.anchor = opts.anchor;
  return m;
}

async function writePkg(id, { events, label = 'alice', seal = {}, lineFormat, afterSeal, manifest = {}, artifacts = {}, extra = {}, meta }) {
  const dir = path.join(FIX, id);
  const pkg = path.join(dir, 'package');
  await rm(dir, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });

  let fulls = sealEvents(events, label, seal);
  if (afterSeal) fulls = afterSeal(fulls);
  let text = lineFormat ? fulls.map(lineFormat).join('\n') + '\n' : serialize(fulls);

  const m = manifestFor(fulls, text, manifest);
  if (manifest.mutate) manifest.mutate(m);
  if (artifacts.write) await artifacts.write(pkg);
  else await writeFile(path.join(pkg, 'artifact.txt'), ART);

  await writeFile(path.join(pkg, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  await writeFile(path.join(pkg, 'events.jsonl'), text);
  await writeFile(path.join(pkg, 'ed25519-public.pem'), pubPem(label));

  await writeFile(path.join(dir, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');
}

const base = (n = 1) => Array.from({ length: n }, (_, i) => ({
  seq: i, ts: 1700000000 + i, type: 'conformance.event', payload: { i }, actor: 'alice'
}));

const F = [];
function add(id, cls, expect, build) { F.push({ id, cls, expect, build }); }

// ---- Envelope ----
add('pos-000-minimal', 'envelope', { ok: true, check: 'OK' }, () => ({ events: base(1) }));
add('pos-001-payload-forms', 'envelope', { ok: true, check: 'OK' }, () => ({
  events: [null, [], {}, true, 's', -3, { a: 1, b: [2] }].map((payload, i) => ({
    seq: i, ts: 1700000000 + i, type: 'conformance.payload', payload, actor: 'alice'
  }))
}));
add('neg-env-missing-sig', 'envelope', { ok: false, check: 'ENVELOPE_SHAPE' }, () => ({
  events: base(1), afterSeal: f => { delete f[0].sig; return f; }
}));
add('neg-env-missing-actor', 'envelope', { ok: false, check: 'ENVELOPE_SHAPE' }, () => ({
  events: base(1), afterSeal: f => { delete f[0].actor; return f; }
}));
add('neg-env-extra-field', 'envelope', { ok: false, check: 'ENVELOPE_SHAPE' }, () => ({
  events: base(1), afterSeal: f => { f[0].nonce = 1; return f; }
}));
add('neg-env-seq-negative', 'envelope', { ok: false, check: 'ENVELOPE_SHAPE' }, () => ({
  events: base(1), afterSeal: f => { f[0].seq = -1; return f; }
}));
add('neg-env-seq-string', 'envelope', { ok: false, check: 'ENVELOPE_SHAPE' }, () => ({
  events: base(1), afterSeal: f => { f[0].seq = '0'; return f; }
}));
add('neg-env-seq-gap', 'envelope', { ok: false, check: 'SEQ_NOT_CONTIGUOUS' }, () => ({
  events: base(2), afterSeal: f => { f[1].seq = 2; return f; }
}));
add('neg-env-seq-not-zero', 'envelope', { ok: false, check: 'SEQ_NOT_CONTIGUOUS' }, () => ({
  events: base(2), afterSeal: f => { f[0].seq = 1; f[1].seq = 2; return f; }
}));
add('neg-env-ts-negative', 'envelope', { ok: false, check: 'ENVELOPE_SHAPE' }, () => ({
  events: base(1), afterSeal: f => { f[0].ts = -1; return f; }
}));
add('neg-env-prev-hash-uppercase', 'envelope', { ok: false, check: 'HEX_FORMAT' }, () => ({
  events: base(2), afterSeal: f => { f[1].prev_hash = f[1].prev_hash.toUpperCase(); return f; }
}));
add('neg-env-sig-length', 'envelope', { ok: false, check: 'HEX_FORMAT' }, () => ({
  events: base(1), afterSeal: f => { f[0].sig = f[0].sig.slice(0, -1); return f; }
}));
add('neg-env-hash-uppercase', 'envelope', { ok: false, check: 'HEX_FORMAT' }, () => ({
  events: base(1), afterSeal: f => { f[0].hash = f[0].hash.toUpperCase(); return f; }
}));
add('neg-env-seq-float', 'envelope', { ok: false, check: 'CANONICALIZATION' }, () => ({
  events: base(1), lineFormat: f => canonical(f).replace('"seq":0', '"seq":0.0')
}));

// ---- Camp 1 ----
add('pos-010-camp1-two-events', 'camp1', { ok: true, check: 'OK' }, () => ({ events: base(2) }));
add('neg-011-camp2-full', 'camp1', { ok: false, check: 'HASH_MISMATCH' }, () => ({ events: base(2), seal: { camp2Full: true } }));
add('neg-012-camp2-sig-only', 'camp1', { ok: false, check: 'SIG_INVALID' }, () => ({ events: base(1), seal: { signCanonicalBody: true } }));
add('neg-013-hash-omits-prev', 'camp1', { ok: false, check: 'HASH_MISMATCH' }, () => ({ events: base(1), seal: { hashBodyOnly: true } }));
add('neg-014-sig-over-hex-text', 'camp1', { ok: false, check: 'SIG_INVALID' }, () => ({
  events: base(1), afterSeal: f => { f[0].sig = sign(null, Buffer.from(f[0].hash, 'utf8'), priv('alice')).toString('hex'); return f; }
}));

// ---- Canonicalization Set A ----
const bad = {
  insertion: (ev, b) => JSON.stringify({ seq: b.seq, ts: b.ts, type: b.type, payload: b.payload, actor: b.actor }),
  whitespace: (ev, b) => canonical(b).replace(/:/g, ': ').replace(/,/g, ', '),
  oneE2: (ev, b) => canonical(b).replace('"payload":100', '"payload":1e2'),
  oneFiveZero: (ev, b) => canonical(b).replace('"payload":1.5', '"payload":1.50'),
  unicode: (ev, b) => canonical(b).replace('"payload":"A"', '"payload":"\\u0041"'),
  solidus: (ev, b) => canonical(b).replace('"payload":"/"', '"payload":"\\/"'),
  nested: (ev, b) => canonical(b).replace('"payload":{"a":1,"b":2}', '"payload":{"b":2,"a":1}')
};
add('pos-020-canonical-sorted', 'canon-A', { ok: true, check: 'OK' }, () => ({ events: base(1) }));
for (const [id, key] of [
  ['neg-021-hash-over-insertion-order', 'insertion'],
  ['neg-022-hash-over-whitespace', 'whitespace'],
  ['neg-023-hash-over-1e2', 'oneE2'],
  ['neg-024-hash-over-1.50', 'oneFiveZero'],
  ['neg-025-hash-over-unicode-escape', 'unicode'],
  ['neg-026-hash-over-solidus-escape', 'solidus'],
  ['neg-027-hash-over-nested-order', 'nested']
]) {
  add(id, 'canon-A', { ok: false, check: 'HASH_MISMATCH' }, () => {
    const payload =
      key === 'oneE2' ? 100 :
      key === 'oneFiveZero' ? 1.5 :
      key === 'unicode' ? 'A' :
      key === 'solidus' ? '/' :
      key === 'nested' ? { a: 1, b: 2 } : { i: 0 };
    return { events: [{ seq: 0, ts: 1700000000, type: 'conformance.event', payload, actor: 'alice' }],
             seal: { hashBodyString: bad[key] } };
  });
}

// ---- Canonicalization Set B ----
const line = {
  insertion: f => JSON.stringify({ seq: f.seq, ts: f.ts, type: f.type, actor: f.actor, payload: f.payload, prev_hash: f.prev_hash, pub: f.pub, sig: f.sig, hash: f.hash }),
  whitespace: f => canonical(f).replace(/:/g, ': ').replace(/,/g, ', '),

  // F10 — object payloads so Foundry's payload-type check (D1) does not
  // fire before its (missing) canonicalization check (D2) is exercised.
  oneE2:       f => canonical(f).replace('"payload":{"n":100}', '"payload":{"n":1e2}'),
  oneFiveZero: f => canonical(f).replace('"payload":{"n":1.5}', '"payload":{"n":1.50}'),
  unicode:     f => canonical(f).replace('"payload":{"s":"A"}', '"payload":{"s":"\\u0041"}'),
  solidus:     f => canonical(f).replace('"payload":{"s":"/"}', '"payload":{"s":"\\/"}'),

  nested: f => canonical(f).replace('"payload":{"a":1,"b":2}', '"payload":{"b":2,"a":1}')
};
for (const [id, key] of [
  ['neg-051-line-key-order', 'insertion'],
  ['neg-052-line-whitespace', 'whitespace'],
  ['neg-053-line-1e2', 'oneE2'],
  ['neg-054-line-1.50', 'oneFiveZero'],
  ['neg-055-line-unicode-escape', 'unicode'],
  ['neg-056-line-solidus-escape', 'solidus'],
  ['neg-057-line-nested-order', 'nested']
]) {
  add(id, 'canon-B', { ok: false, check: 'CANONICALIZATION' }, () => {
    const payload =
      key === 'oneE2'       ? { n: 100 } :
      key === 'oneFiveZero' ? { n: 1.5 } :
      key === 'unicode'     ? { s: 'A' } :
      key === 'solidus'     ? { s: '/' } :
      key === 'nested'      ? { a: 1, b: 2 } : { i: 0 };
    return { events: [{ seq: 0, ts: 1700000000, type: 'conformance.event', payload, actor: 'alice' }],
             lineFormat: line[key] };
  });
}

// ---- Pending non-ASCII ----
for (const id of ['pending-028-nfc-nfd', 'pending-029-astral-pair', 'pending-030-lone-surrogate']) {
  add(id, 'canon-pending', { ok: false, check: null, pending: true }, () => ({ events: base(1) }));
}

// ---- Hash chain ----
add('pos-040-chain-3', 'chain', { ok: true, check: 'OK' }, () => ({ events: base(3) }));
add('neg-041-broken-link', 'chain', { ok: false, check: 'CHAIN_BROKEN' }, () => ({
  events: base(3), afterSeal: f => { f[1].prev_hash = 'a'.repeat(64); return f; }
}));
add('neg-042-truncated-midline', 'chain', { ok: false, check: 'LEDGER_PARSE' }, () => ({
  events: base(2), extra: { truncate: true }
}));
add('neg-043-anchor-tail', 'chain', { ok: false, check: 'ANCHOR_MISMATCH' }, () => {
  const events = base(3);
  return { events, afterSeal: f => f.slice(0, 2), manifest: { anchor: { seq: 2, hash: sha256('tail') } } };
});
add('neg-044-reordered-kept-seq', 'chain', { ok: false, check: 'SEQ_NOT_CONTIGUOUS' }, () => ({
  events: base(3), afterSeal: f => [f[1], f[0], f[2]]
}));
add('neg-045-intermediate-start', 'chain', { ok: false, check: 'CHAIN_BROKEN' }, () => ({
  events: base(2), afterSeal: f => { f[0].prev_hash = f[1].hash; return f; }
}));
add('doc-046-reorder-renumbered', 'doc', { ok: true, check: 'OK', written_reason: 'Valid package whose ts is non-monotonic. Demonstrates that the spec verification procedure (V-09 sub-steps 1-9) does not check temporal ordering; a reordered-then-renumbered-then-resealed history is indistinguishable from a naturally ordered one. Documented limitation, not a conformance failure.' }, () => ({
  // Sealed fresh with seq 0,1 — a structurally valid chain.
  // Content order is "reordered" in the sense that ts is non-monotonic
  // (1700000001 at seq 0, 1700000000 at seq 1). The spec does not require
  // ts monotonicity, so both verifiers PASS. The fixture documents that
  // limitation; it is not a conformance failure.
  events: [
    { seq: 0, ts: 1700000001, type: 'conformance.event', payload: { i: 1 }, actor: 'alice' },
    { seq: 1, ts: 1700000000, type: 'conformance.event', payload: { i: 0 }, actor: 'alice' }
  ]
}));

// ---- Signatures ----
add('pos-060-valid', 'sig', { ok: true, check: 'OK' }, () => ({ events: base(1) }));
add('neg-061-flipped-byte', 'sig', { ok: false, check: 'SIG_INVALID' }, () => ({
  events: base(1), afterSeal: f => {
    const c = f[0].sig.slice(0, -1) + (f[0].sig.at(-1) === '0' ? '1' : '0');
    f[0].sig = c; return f;
  }
}));
add('neg-062-wrong-key', 'sig', { ok: false, check: 'SIG_INVALID' }, () => ({
  events: base(1), afterSeal: f => {
    f[0].sig = sign(null, Buffer.from(f[0].hash, 'hex'), priv('mallory')).toString('hex');
    return f;
  }
}));
add('neg-063-pub-unbound', 'sig', { ok: false, check: 'PUB_NOT_BOUND' }, () => ({
  events: base(1), manifest: { agentPubkeys: { carol: pubHex('alice') } }
}));
add('pos-064-two-agents', 'sig', { ok: true, check: 'OK' }, () => ({
  events: [
    { seq: 0, ts: 1700000000, type: 'conformance.event', payload: { n: 0 }, actor: 'alice' },
    { seq: 1, ts: 1700000001, type: 'conformance.event', payload: { n: 1 }, actor: 'bob' }
  ],
  manifest: { agentPubkeys: { alice: pubHex('alice'), bob: pubHex('alice') } }
}));
add('neg-065-manifest-binding-mismatch', 'sig', { ok: false, check: 'PUB_NOT_BOUND' }, () => ({
  events: base(1), manifest: { agentPubkeys: { alice: pubHex('bob') } }
}));

// ---- Manifest ----
add('pos-070-valid', 'manifest', { ok: true, check: 'OK' }, () => ({ events: base(1) }));
add('neg-071-missing-ledger-bytes', 'manifest', { ok: false, check: 'MANIFEST_SHAPE' }, () => ({
  events: base(1), manifest: { mutate: m => { delete m.ledger_bytes; } }
}));
add('neg-072-missing-artifacts', 'manifest', { ok: false, check: 'MANIFEST_SHAPE' }, () => ({
  events: base(1), manifest: { mutate: m => { delete m.artifacts; } }
}));
add('neg-073-wrong-type-agent-pubkeys', 'manifest', { ok: false, check: 'MANIFEST_SHAPE' }, () => ({
  events: base(1), manifest: { mutate: m => { m.agent_pubkeys = []; } }
}));
add('neg-074-artifact-digest', 'manifest', { ok: false, check: 'ARTIFACT_DIGEST' }, () => ({
  events: base(1), manifest: { mutate: m => { m.artifacts['artifact.txt'] = '0'.repeat(64); } }
}));
add('neg-075-artifact-size', 'manifest', { ok: false, check: 'ARTIFACT_SIZE' }, () => ({
  events: base(1), manifest: { mutate: m => { m.artifact_bytes['artifact.txt'] = 999; } }
}));
add('neg-076-ledger-size', 'manifest', { ok: false, check: 'LEDGER_SIZE' }, () => ({
  events: base(1), manifest: { mutate: m => { m.ledger_bytes += 1; } }
}));
add('neg-077-path-escape', 'manifest', { ok: false, check: 'PATH_ESCAPE' }, () => ({
  events: base(1), manifest: { mutate: m => {
    m.artifacts['../outside.txt'] = sha256('x');
    m.artifact_bytes['../outside.txt'] = 1;
  } }
}));
add('neg-078-absolute-path', 'manifest', { ok: false, check: 'PATH_ESCAPE' }, () => ({
  events: base(1), manifest: { mutate: m => {
    m.artifacts['/etc/hostname'] = sha256('x');
    m.artifact_bytes['/etc/hostname'] = 1;
  } }
}));
add('neg-079-symlink-artifact', 'manifest', { ok: false, check: 'SYMLINK_ARTIFACT' }, () => ({
  events: base(1),
  artifacts: { write: async pkg => {
    await writeFile(path.join(pkg, 'outside.txt'), ART);
    await symlink(path.join(pkg, 'outside.txt'), path.join(pkg, 'artifact.txt'));
  } }
}));
add('neg-080-artifact-missing', 'manifest', { ok: false, check: 'ARTIFACT_MISSING' }, () => ({
  events: base(1), manifest: { mutate: m => {
    m.artifacts['missing.txt'] = sha256('x');
    m.artifact_bytes['missing.txt'] = 1;
  } }
}));
add('neg-081-manifest-not-json', 'manifest', { ok: false, check: 'MANIFEST_PARSE' }, () => ({
  events: base(1)
}));

// ---- Anchor ----
add('pos-090-anchor-match', 'anchor', { ok: true, check: 'OK', anchor: 'present' }, () => {
  const events = base(2);
  return { events, manifest: { anchor: { seq: 1, hash: sha256('placeholder') } } };
});
add('neg-091-anchor-mismatch', 'anchor', { ok: false, check: 'ANCHOR_MISMATCH' }, () => {
  const events = base(2);
  return { events, manifest: { anchor: { seq: 1, hash: 'f'.repeat(64) } } };
});
add('pos-092-anchor-absent', 'anchor', { ok: true, check: 'OK', anchor: 'none' }, () => ({ events: base(1) }));

// ---- materialise ----
await rm(FIX, { recursive: true, force: true });
for (const f of F) {
  const built = f.build();
  const meta = {
    id: f.id,
    class: f.cls,
    spec_ref: '',
    pending: !!f.expect.pending,
    expect: { ok: f.expect.ok, check: f.expect.check ?? null, anchor: f.expect.anchor ?? null },
    written_reason: f.expect.written_reason ?? 'See REPORT.md catalog.',
    notes: ''
  };
  // Special cases that need the sealed text
  if (f.id === 'neg-042-truncated-midline') {
    const dir = path.join(FIX, f.id, 'package');
    await mkdir(dir, { recursive: true });
    const fulls = sealEvents(built.events, 'alice');
    let text = serialize(fulls);
    text = text.slice(0, text.length - 8); // cut mid-line, drop final newline
    const m = manifestFor(fulls, text);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    await writeFile(path.join(dir, 'events.jsonl'), text);
    await writeFile(path.join(dir, 'ed25519-public.pem'), pubPem('alice'));
    await writeFile(path.join(FIX, f.id, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');
    continue;
  }
  if (f.id === 'neg-081-manifest-not-json') {
    const dir = path.join(FIX, f.id, 'package');
    await mkdir(dir, { recursive: true });
    const fulls = sealEvents(built.events, 'alice');
    const text = serialize(fulls);
    const m = manifestFor(fulls, text);
    await writeFile(path.join(dir, 'artifact.txt'), ART);
    await writeFile(path.join(dir, 'events.jsonl'), text);
    await writeFile(path.join(dir, 'ed25519-public.pem'), pubPem('alice'));
    await writeFile(path.join(dir, 'manifest.json'), '{"broken":'); // AFTER everything else
    await writeFile(path.join(FIX, f.id, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');
    continue;
  }
  if (f.id === 'pos-090-anchor-match') {
    const fulls = sealEvents(built.events, 'alice');
    const text = serialize(fulls);
    const m = manifestFor(fulls, text, { anchor: { seq: 1, hash: fulls[1].hash } });
    const dir = path.join(FIX, f.id, 'package');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'artifact.txt'), ART);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    await writeFile(path.join(dir, 'events.jsonl'), text);
    await writeFile(path.join(dir, 'ed25519-public.pem'), pubPem('alice'));
    await writeFile(path.join(FIX, f.id, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');
    continue;
  }
  await writePkg(f.id, { ...built, meta });
}
console.log(`built ${F.length} fixtures in ${FIX}`);
