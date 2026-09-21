# Spec: merge gray-zone judge

## Objective

Keep L0–L3 cosine/rule gates. When L3 would take the gray-zone reject path, a judge returns one of three levels: merge, do not merge, leave for operator. Judge-down keeps today’s gray-zone reject + structured log (no merge). Operator-held pairs use the same maintenance lane as extract verify (entity page visible, not in projection until promoted).

**Who:** extract persist merge.

## Boundaries

- **Does:** three-level judge only after L0–L3 leave gray; merge/reject/human; human → maintenance record; L0/L1/L2/L3 thresholds unchanged; no judge on every candidate pair.
- **Confirms with human:** none.
- **Out of this spec:** [extract verify](extract-verify.md) (shared lane UI is owned there; this spec only emits human-hold records that surface on that lane); [entity type and filter](entity-type-and-filter.md); [contextual wrap](contextual-wrap-embed.md); [retrieve judge rerank](retrieve-judge-rerank.md).

## Success Criteria

- L0 exact same name+type still merges with zero judge calls (unit test with fake judge counting calls).
- Pair below L3 merge floor: fake judge `merge` writes `merged_into`; `do not merge` leaves two live entities; `human` writes no merge and a failed/hold record listable with extract failures.
- Fake judge throw: no merge, gray-zone log still emitted.
- `npx vitest run` on merge/extract suites this change touches exits 0.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** L0–L3 `merge.ts`; gray-zone log; `merged_into`; extract persist.

**Changes:** three-level judge on gray only; human hold into maintenance lane.

**待写入:** CONTEXT `gray zone` — three-level judge; default on judge-down remains reject.

## Architecture Change Reviewer

bounded-context-guardian: yes — merge stays in entities/extract persist.
input-contract-tests: yes — three judge levels, judge down, L0 skip judge.
error-handling-enforcer: yes — judge-down does not merge.
complexity-anti-drift: yes — one gray-zone helper after L3.
minimal-change-verifier: yes — gray zone only.
