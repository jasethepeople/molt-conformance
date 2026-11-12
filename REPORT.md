# MOLT-CORE Conformance — REPORT

## 1. Scope

Implementation-independent conformance suite for MOLT-CORE-SPEC v1.0.
Two verifiers exercised against the same fixtures: L1 standalone verifier
(`molt-verify`) and Foundry's independent verifier. 64 conformance fixtures
+ doc-046 = 65 packages; 62 scored (3 non-ASCII pending, excluded).

## 2. Method

Fixtures are materialised by `tools/build-fixtures.mjs` (deterministic keys,
Camp 1 sealing, own RFC 8785 canonicalizer — independent of both verifiers).
Each adapter runs one verifier over every fixture and emits one JSON line
`{ok, check?, reason?, anchor?}`. The runner scores verdicts and checks.
`tools/diff.mjs` compares the two runner outputs.

## 3. Differential results — L1 vs Foundry (MEASURED, 2026-11-12)

Environment: Node 24, bun 1.4.4. Command sequence:
    node tools/build-fixtures.mjs
    node runner.mjs --verifier "node adapters/l1.mjs"      --json l1.json
    node runner.mjs --verifier "node adapters/foundry.mjs" --json foundry.json
    node tools/diff.mjs l1.json foundry.json

### Headline (post-fix)
- L1: CONFORMANT — 62/62 scored fixtures matched.
- Foundry: 51/62 matched. 11 failures = 10 real divergences + 1 anchor-reporting mismatch.
- diff.mjs: agreement 52/62, disagreements 10 (all VERDICT_DISAGREE).
- 3 pending (non-ASCII) excluded from scoring.

### The 10 real divergences (L1 vs Foundry, observed)
| # | Fixture | L1 | Foundry | Cause |
|---|---------|-----|---------|-------|
| 1 | pos-001-payload-forms | PASS | FAIL "Event payload is invalid." | D1 |
| 2 | neg-051-line-key-order | FAIL CANONICALIZATION | PASS | D2 |
| 3 | neg-052-line-whitespace | FAIL CANONICALIZATION | PASS | D2 |
| 4 | neg-057-line-nested-order | FAIL CANONICALIZATION | PASS | D2 |
| 5 | neg-env-seq-float | FAIL CANONICALIZATION | PASS | D2 |
| 6 | neg-071-missing-ledger-bytes | FAIL MANIFEST_SHAPE | PASS | D3 |
| 7 | neg-076-ledger-size | FAIL LEDGER_SIZE | PASS | D3 |
| 8 | neg-075-artifact-size | FAIL ARTIFACT_SIZE | PASS | D4 |
| 9 | neg-043-anchor-tail | FAIL ANCHOR_MISMATCH | PASS | D5 |
| 10 | neg-091-anchor-mismatch | FAIL ANCHOR_MISMATCH | PASS | D5 |

Plus 1 anchor-reporting mismatch (not a verdict disagreement): pos-090-
anchor-match — both PASS, Foundry reports anchoring `local-only`
(adapter → none), L1 reports `verified` (adapter → present).

Direction: 9 of 10 are Foundry being LESS strict than the spec (it accepts
packages the spec rejects). Only pos-001 is Foundry being MORE strict.

### Pre-fix measurement (for the record)
Before the fixture fixes, L1 was 60/62 and Foundry 49/62. The 2 misses on
each side were fixture-construction bugs (neg-081, doc-046), not spec or
implementation bugs. The diff was already 52/62 with the same 10
divergences, because the two buggy fixtures were cases where both verifiers
agreed on the wrong outcome. Fixing them moved the runner scores but not
the diff — the divergences are the point of the suite.

### Prediction vs measurement
The first-draft prediction was 13 disagreements; measurement is 10. The
arithmetic in the prediction summary was itself off by one — the listed
items D1(1)+D2(8)+D3(2)+D4(1)+D5(1)+D6(1) sum to 14, not 13. Corrections:

- D1 CONFIRMED (1).
- D2 PARTIALLY CONFIRMED (4, not 8). neg-053..056 use non-object payloads
  (100, 1.5, "A", "/"), so Foundry fails them on payload type (D1) before
  canonicalization matters. Both verifiers fail them; the check differs but
  the verdict does not, so the runner records MATCH. The canonicalization
  gap is *masked* by the payload-type gap for non-object payloads.
- D3 CONFIRMED (2).
- D4 CONFIRMED (1).
- D5 CONFIRMED plus one (2, not 1). neg-043 is also a divergence because
  Foundry ignores anchors entirely. The prediction missed it.
- D6 NOT A DIVERGENCE. Both fail neg-env-ts-negative. L1 fails on
  'bad field format'; Foundry fails on hash mismatch (ts was tampered
  post-seal, so recomputation differs). The ts-non-negativity check is
  unreachable through Foundry because the hash check fails first. The
  prediction was wrong.

## 4. Findings

- D1: Foundry requires payload = non-array object; spec §4 allows any JSON
  value. Foundry is stricter. Fixture: pos-001.
- D2: Foundry never checks line canonicalization; L1 enforces V-09 step 2.
  Fixtures: neg-051, 052, 057, neg-env-seq-float.
- D3: Foundry never reads manifest.ledger_bytes. Fixtures: neg-071, 076.
- D4: Foundry checks artifact digest only, never artifact_bytes.
  Fixture: neg-075.
- D5: Foundry ignores manifest.anchor entirely. Fixtures: neg-043, 091.
  Plus pos-090 anchor-reporting (Foundry `local-only` vs L1 `verified`).
- D6 RETRACTED: not a divergence (see §3). The two implementations apply
  V-09 sub-checks in a different effective order because Foundry collapses
  steps 2 and 4 into hash failure — itself a finding, but not the D6
  described.
- F10 (Set B masking): the canonicalization Set B fixtures whose payload is
  non-object cannot isolate D2 from D1. To exercise the canonicalization
  divergence cleanly, the payload must be a canonical-form object with
  keys/values that trip the specific canonicalization failure (e.g.
  {"a":1,"b":2} with keys in wrong order, rather than 100 / "A" / /).
  Set B should be rebuilt with object payloads for the four currently-masked
  fixtures. Fixture design fix, not a spec or implementation change.
- F11 (execution requirement): two fixtures in this delivery were buggy on
  first execution (neg-081, doc-046). The suite carries an execution
  requirement in its README: fixtures are not considered
  conformance-verified until build-fixtures.mjs && runner.mjs passes on
  both verifiers. Reading the builder is not equivalent to running it.

## 5. Bugs found by running (fixed in this delivery)

- neg-081-manifest-not-json: writePkg overwrote the intentionally broken
  manifest with a valid one. Both verifiers PASSed. Fixed by special-casing
  the fixture in the materialise loop (write the broken manifest AFTER
  everything else).
- doc-046-reorder-renumbered: afterSeal swapped and renumbered events
  without re-sealing, so prev_hash/hash/sig were stale. Both verifiers
  FAILed with chain-broken. Fixed by building the package from scratch with
  non-monotonic ts (the property the spec does not check); the fixture is
  now a valid package and both verifiers PASS it, demonstrating the
  limitation. written_reason records the finding.
- Artifact path (systematic blocker): the manifest declared `artifact.txt`
  but writePkg wrote the file to `artifacts/artifact.txt`. Every fixture
  failed V-08 with ENOENT before its intended check fired. Fixed by writing
  the artifact to the package root, matching L1's sample-good layout.
- Adapter `*` fallback: the map had `*` wildcards but the adapter only did
  exact-reason lookup, so V-04/V-06 mappings never fired. Fixed with exact,
  then prefix, then `*` fallback. The prefix step is needed for dynamic
  L1 reasons (e.g. "Artifact byte count mismatch for 'x'.").
- V-04 byte-count: the `*` → LEDGER_PARSE mapping was too coarse; the
  byte-count reason maps to LEDGER_SIZE. Added an exact reason entry.
- V-08 / V-10 / V-09 'wrong fields' are now fully mapped (prefix + exact),
  cutting L1 check-coverage gaps from 28 to 19. The remaining gaps are the
  genuinely ambiguous reasons (`chain broken`, `bad field format`) and the
  10 positives (runner design — the adapter never emits a check on success).

## 6. What this means

The spec and L1 agree (L1 62/62). Foundry diverges from the spec in 10
places. Each divergence needs a ruling: either Foundry is updated to match
the spec, or the spec is adjusted. The suite found ten places where an
independent implementation disagrees with the spec, and it found two bugs
in its own fixtures before publication. The second is only possible because
the fixtures were executed.
