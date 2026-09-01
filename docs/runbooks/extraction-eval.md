# Extraction-eval operator runbook

Offline extraction-quality gate for pre-merge triples. Spec: `specs/p0-eval.md`
(SSOT). This runbook is the operator sequence; the spec is the contract.

## TL;DR

The eval CLI scores per-chunk **raw** triples (pre-merge, pre-canonical) on
three axes: micro-F1 (primary), schema-compliance rate, hallucination rate.
Five error types are diagnostic only — they never gate.

Gold is built by a **cross-family LLM** over a **frozen chunk snapshot** in git
(`gold-set/snapshot.json`), filtered by an in-repo code filter (no copy of the
extraction vocabulary). Audit of filter rejects is another LLM. The operator
records the axes via `--bootstrap` until adjacent F1 Δ ≤ 0.05 (steady state),
then commits **locked** thresholds. Only after the lock do the PR drift and
Release absolute gates hard-fail.

## Preconditions

- Node ≥ 20; `npm run build` so `dist/cli/eval.js` exists next to the other
  CLI binaries.
- The frozen snapshot is committed to git: `gold-set/snapshot.json` (10–40
  chunks). The loader enforces the band; `npm test` will fail if a future
  snapshot silently grew past 40.
- **Cross-family guard (SC9).** Extract model id MUST differ from the gold
  model id and from the audit model id. The CLI exits **1** (ConfigError) when
  they are equal. Sharing the gold and audit model ids is allowed.
- **No live gold credentials in `npm test`.** The test suite runs on
  `FakeLLMClient` with injected deps. A real gold-build is a one-shot
  operator action; it is documented here and not part of CI.

## Env (live gold / audit)

| Variable             | Role                                                        |
| -------------------- | ----------------------------------------------------------- |
| `EVAL_EXTRACT_MODEL` | Extract model id (SC9 cross-family guard)                   |
| `EVAL_GOLD_MODEL`    | Gold model id; CLI refuses when equal to extract model      |
| `EVAL_AUDIT_MODEL`   | Audit model id; CLI refuses when equal to extract model     |
| `GOLD_SET_DIR`       | Optional override for `gold-set/` (defaults to `gold-set/`) |
| `LOG_LEVEL`          | `debug` / `info` / `warn` / `error` (defaults to `info`)    |

Live Anthropic gold / audit clients are operator headroom; the prod binary
throws a `ConfigError` when those adapters are not wired, so the offline
contract is preserved.

## Command sequence

```bash
npm run build

# 1) Build gold against the frozen snapshot. Operator-only — requires a
#    live gold-model credential. The gold file is OVERWRITTEN for the
#    same ruler identity (SC19); no silent merge of a previous run.
node dist/cli/eval.js --gold-build \
  --snapshot gold-set/snapshot.json \
  --out gold-set/gold-v1.json \
  --extract-model <extract-model-id> \
  --gold-model <gold-model-id> \
  --prompt "produce gold triples from the following chunk:"

# 2) Audit filter rejects. Three allowed labels only:
#    agree-filter | filter-false-reject | gold-miss (SC20).
node dist/cli/eval.js --audit-rejects \
  --snapshot gold-set/snapshot.json \
  --gold gold-set/gold-v1.json \
  --out gold-set/audit-v1.json \
  --extract-model <extract-model-id> \
  --audit-model <audit-model-id>

# 3) Bootstrap: run the extract cascade against the snapshot + gold,
#    score the predictions, append one BaselineEntry. Does NOT consult
#    thresholds (SC12 / A2).
node dist/cli/eval.js --bootstrap \
  --snapshot gold-set/snapshot.json \
  --gold gold-set/gold-v1.json \
  --baseline-dir gold-set

# 4) Repeat step 3 until adjacent F1 Δ ≤ 0.05 (READY_TO_LOCK_DELTA,
#    SC13). Then commit the locked thresholds:

cat > gold-set/thresholds.json <<'JSON'
{
  "f1Minimum": 0.70,
  "schemaRateMinimum": 0.90,
  "hallucinationRateMaximum": 0.10
}
JSON

git add gold-set/thresholds.json
git commit -m "lock extraction eval thresholds after bootstrap

Why: adjacent F1 Δ across last 3 bootstrap runs was ≤ 0.02; ready-to-lock.

(specs/p0-eval.md SC12, A2)"

# 5) Wire CI. Two gates: PR is cheap drift, Release is the absolute
#    three-axis gate against locked thresholds.
npm run gate:pr        # runs: node dist/cli/eval.js --gate pr
npm run gate:release   # runs: node dist/cli/eval.js --gate release
```

### What the gates print

`npm run gate:pr` prints the latest F1 / schema / hallucination axes to
**stderr** in all cases (so the operator running locally sees them on the
terminal). The exit code depends on threshold-lock state:

- **Bootstrap period (no `gold-set/thresholds.json`)** — exits **0** even if
  F1 drifted past 0.05 against the previous bootstrap. A13 / SC18: the gate
  is intentionally non-blocking while the operator is still recording axes.
- **Locked (thresholds committed)** — exits **2** when |ΔF1| > 0.05 vs the
  last baseline (SC14). Exits **0** when within budget.

`npm run gate:release` requires locked thresholds (SC12): exits **1** with a
clear `ConfigError` if `gold-set/thresholds.json` is missing. Otherwise exits
**0** when all three axes meet their locked minimum / maximum; exits **2**
on any axis fail.

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success (incl. Bootstrap record-only; PR soft-pass with no baseline) |
| 1    | Config / fatal (model-id clash, unlocked Release, bad fixtures)      |
| 2    | Usage error **or** gate tripped (drift / release fails)              |

## New ruler rule

The ruler identity is the triple `(snapshot_id, gold_model, prompt_hash)`
(A7 / A9). Changing any of those three is a **new ruler**:

- New `gold-set/gold-v2.json` (or similar)
- New `--bootstrap` series
- Do **not** continue the previous F1 curve without a `Why:` commit that
  names the ruler change.

Changing the **extract** model must NOT rewrite gold. The whole point of the
gold model being cross-family is that an extract-model swap leaves gold
intact; only the predictions change.

## Cross-family guard

```
extract_model_id ≠ gold_model_id ≠ audit_model_id
```

`--gold-build` and `--audit-rejects` exit **1** (ConfigError) when their
respective model id equals `extract_model_id`. This is a hard rule, not a
warning — the same family of LLM cannot both propose gold and judge itself.

## Security

- Never commit API keys into `gold-set/`. Provenance fields are model ids
  and prompt hashes only.
- Live model clients live in the environment / `.env.local`, both
  gitignored.
- The eval CLI is offline-only — it never opens an MCP transport and never
  imports `src/tools/`, `src/index.ts`, or `src/core/retrieval/*` (SC3 /
  A14). The isolation guard in `tests/cli/eval.unit.test.ts` is greppable
  proof.
