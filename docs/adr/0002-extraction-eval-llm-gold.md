# 0002. Extraction eval gold is LLM + code filter, not human annotation

Date: 2026-08-30
Status: accepted

Q2 used filter-first ground truth with 10–15 human anchor chunks and a human auditor. Operator 2026-08-30 replaced every human labeling/audit step with a **gold model** (id ≠ extractor) plus a git **eval filter**, and an **audit model** (id ≠ extractor) on the reject pile. Threshold lock and model-id env remain operator actions. Changing the extract model must not regenerate gold; changing gold model, prompt hash, or chunk snapshot is a new ruler.

**Why not keep human anchors:** they were the only non-LLM calibration; the operator accepted F1 as extract-vs-gold-model, not extract-vs-human, in order to ship the Completion-gate harness.

Evidence: `specs/p0-eval.md`.
