# 0009. Write-time contradiction resolution is on by default

Date: 2026-09-11
Status: accepted

Resolving contradicting triples at extract write time is ledger infrastructure, not an optional retrieval feature. Same `(head, relation)` with a different tail and an overlapping **valid_window** supersedes the older row (`superseded_by` + closed window); nothing is deleted. Default on. Explicit off lives in global settings for tests only, same shape as `graphEnabled=false`. The consolidate CLI remains the offline backfill / dry-run path, not the daily master switch.

**Does not decide:** the env var name, FK statement order, or concurrent-writer invariants — those stay in the extract implementation.
