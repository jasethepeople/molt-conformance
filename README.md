# MOLT-CORE Conformance Suite

Implementation-independent conformance tests for the MOLT-CORE spec (v1.0).
Two verifiers are exercised against the same fixtures: the L1 standalone
verifier (`molt-verify`) and Foundry's independent verifier. A disagreement
is a finding, never a pass.

## Layout

- `runner.mjs` — runs one adapter over every fixture, scores verdicts and checks.
- `adapters/l1.mjs` — L1 adapter (imports `verifyMoltPackage`, maps checkId+reason to the enum via `l1-map.json`).
- `adapters/foundry.mjs` — Foundry adapter (imports `independentlyVerifyMoltPackage`; Foundry returns no checkId, so no check is ever emitted).
- `adapters/l1-map.json` — maps L1 (checkId, reason) to the check enum. Exact match, then prefix match (for dynamic reasons), then `*` wildcard. `null` means ambiguous — omit the check and report a coverage gap.
- `tools/build-fixtures.mjs` — materialises all 65 packages (deterministic keys, Camp 1 sealing, own RFC 8785 canonicalizer). Independent of L1 and Foundry.
- `tools/diff.mjs` — compares two runner JSON outputs, reports VERDICT_DISAGREE and CHECK_DISAGREE.
- `fixtures/` — 65 packages (64 conformance + doc-046). 61 scored conformance + doc-046 = 62 scored; 3 non-ASCII pending, excluded.
- `vendor/l1/` — the L1 verifier and canonicalizer under test.
- `vendor/foundry/` — Foundry's independent verifier and types under test.
- `l1.json`, `foundry.json` — measured runner outputs (post-fix, 2026-11-12).

## Run

```sh
node tools/build-fixtures.mjs
node runner.mjs --verifier "node adapters/l1.mjs"      --json l1.json
node runner.mjs --verifier "node adapters/foundry.mjs" --json foundry.json
node tools/diff.mjs l1.json foundry.json
```

The Foundry adapter imports TypeScript (`independent-verifier.ts`); run it with bun:
`bun adapters/foundry.mjs`, or pass the bun command to the runner as above.

## Measured results (2026-11-12, Node 24, bun 1.4.4; post-F10)

- **L1: CONFORMANT — 62/62 scored fixtures matched.** 19 check-coverage gaps (10 positives by runner design, the rest genuinely ambiguous reasons: `chain broken`, `bad field format`).
- **Foundry: 47/62 matched.** 15 failures = 14 real divergences + 1 anchor-reporting mismatch.
- **diff.mjs: agreement 48/62, disagreements 14** (all VERDICT_DISAGREE).

The 14 divergences: pos-001 (payload type — Foundry stricter), neg-051/052/053/054/055/056/057 + neg-env-seq-float (line canonicalization — Foundry does not check), neg-071/076 (ledger_bytes — Foundry never reads it), neg-075 (artifact_bytes — Foundry checks digest only), neg-043/091 (anchor — Foundry ignores it). Plus pos-090 anchor-reporting (both pass; Foundry says anchor none, L1 says present). 13 of 14 are Foundry being less strict than the spec; only pos-001 is Foundry being more strict.

F10 (2026-11-12) rebuilt Set B neg-053–056 with object payloads so they isolate the canonicalization divergence from the payload-type divergence. Pre-F10 the diff was 10 and Foundry 51/62; the four newly-isolated D2 rows took it to 14 and 47/62. The four are findings, not regressions.

See `REPORT.md` for the full measured differential, the prediction-vs-measurement corrections, and the findings.

## Execution requirement

Fixtures are not considered conformance-verified until `build-fixtures.mjs`
and `runner.mjs` have been EXECUTED on both verifiers. Reading the fixture
builder is not equivalent to running it — two fixture bugs in this delivery
(neg-081, doc-046) were invisible to source review and only found by running.
A suite whose fixtures were never executed is a draft, not a deliverable.

## Spec

MOLT-CORE-SPEC v1.0: https://github.com/jasethepeople/molt-core (tag v1.0).
Camp 1 is the standard: 5-field body {seq, ts, type, payload, actor},
hash = sha256(prev_hash_hex_text + canonical(5-field body)),
Ed25519 signature over the 32 raw hash bytes.
Non-ASCII canonicalization is OPEN (3 pending fixtures, excluded).
