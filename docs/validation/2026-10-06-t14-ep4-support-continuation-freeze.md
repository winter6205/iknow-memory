# T14 — EP4 — Support continuation: five-axis review repair (#363)

An independent five-axis review of the IK diff range `5a47db8..0cde380` returned 1 High and 3 Medium. The review was
read-only and **confirmed the production code**: no nested `BEGIN` in the dispatch path, no selector silently dropped
at the seam, no widening of the typed refusal's closed set, and the `envelopeBytes()` over-refusal repair correct — a
page that fits was being answered `too_large` because that helper stringifies each descriptor before measuring, so
every quote inside an extraction ref is escaped and what it measures is not what `renderSupports` emits. None of that
was touched here.

**The repair is test-only.** `git status --porcelain` in this worktree shows one modified file, and
`git diff --stat -- src/` is empty.

The Fin half of the same review — the missing valid-envelope success parse and the dual-selector case that only ran
behind the live lane's `pytestmark` — is recorded in the Fin worktree's own copy of this record
(`docs/validation/2026-10-06-t14-ep4-support-continuation-freeze.md` §13), since those are Fin tests over the same wire.

## 1. The High: two assertions that could not fail

`tests/storage/evidence-read-supports-dispatch.test.ts` carried a case named *"refuses a request carrying both
selectors, before the grant is read"*, ending in:

```ts
expect(client.statements.filter((sql) => sql.includes("evidence_grants"))).toEqual([]);
expect(scope).toBeDefined();
```

Both were vacuous. The `client` and `scope` were constructed in the test body and then **dropped on the floor**:
`refusalOf()` called `dispatch()`, which built its own `recordingClient()` internally, so the statement list under
assertion belonged to a client that was never dispatched against and could only ever be empty. The second line
asserts that a local `const` is defined.

**Reproduced before changing anything:** deleting both lines from the committed file left the suite green at
`12 passed`.

### 1.1 The fix

The seam was made observable rather than the lines being deleted. `dispatch()` now takes the client as a parameter
and `refusalOf()` returns both the refusal and the client the dispatch actually ran against, so a case asserting on
issued statements passes the very client the path used. A seam built in a test and handed to a helper that builds its
own is a seam nothing is ever read from — that, not the missing `toBeDefined`, was the defect.

### 1.2 The name was wrong too, and that mattered more

The case claimed *"before the grant is read"*, but `readGrantFacts` (`evidence-read.ts:487`) runs **first** and
`decideSupportContinuation` (`:496`) second. The build's own order is grant-then-continuation, the reverse of the name
the test asserted. Asserting the order the code does not have is worse than asserting nothing, so the case was
renamed to what it can actually prove:

- the grant facts **are** read — `evidence_grants` and `evidence_scope_revisions` appear in the statement list;
- what the refusal withholds is the **extraction links**. `resolveSelectors` answers before `selectPage` and before
  the page's own reader is ever called, so no page — not even a partial one — is assembled from the membership.

An earlier draft of the repair asserted the opposite (that the pinned membership was never read) and went **red
immediately**, which is how the fixture's real statement order was observed instead of assumed:
`BEGIN`, grants, scope revisions, count, membership, `COMMIT`, `RELEASE`. `readGrantFacts` reads the whole membership
before the selector verdict is consulted, so the membership *is* read; only the page is never assembled.

Renamed to `refuses a request carrying both selectors, and reads no extraction link for it`.

### 1.3 Prove-it

Removing an assertion can only loosen the suite, so "delete it and check red" proves nothing about a negative
statement. The discriminative check is breaking the production behavior the assertion names.

| Mutation | Result |
|---|---|
| `resolveSelectors` returns its refusal, but the page's extraction links are read **first** (a real member id, not an empty list) | **red** — `expected [ Array(1) ] to deeply equal []`; restored → **green** |
| the mutual-exclusivity guard removed outright | red, 3 cases |
| the `selectors` verdict ignored entirely | red, 4 cases |

The first row is the one the High was about: an implementation that resolved the page and *then* refused is now
caught, where the committed version was not. An initial version of that mutation passed, because it read extraction
links for an **empty** id list and issued no statement — using a real member id is what makes the statement appear.

## 2. The Mediums

### 2.1 `optionalSelector`'s `null` and empty-string arms were untested

`evidence-read.ts:370-372` has three returns — `undefined`, `null`, and the value — and the committed tests covered
absent and non-string only. `cursor: null`, `cursor: ""` and `support_id: null` are now all covered.

The subtlety is that the two halves are only visible from **different places**. `optionalSelector`'s three returns
differ on the **parsed request**; the fold that makes `null`, `""` and absent all answer with a first page lives on the
**envelope**, in `presentSelector` (`evidence-continuation.ts:241`). A `null` arm rewritten to return `""` still
reaches `presentSelector` as absent, so a dispatch-level assertion alone stays green under exactly the mutation the
review named. Measured:

| Mutation | Result |
|---|---|
| `optionalSelector` returns `""` for a `null` value | green with a dispatch-level assertion alone → **red** once the parsed request's shape is also asserted |
| `presentSelector` stops folding `""` to absent | **red** |

The test therefore pins both: the parsed request (`undefined` / `null` / `""` are three distinct values) and the
envelope each spelling produces.

### 2.2 Descriptor fields were never asserted

`renderSupports` (`evidence-read.ts:647-658`) passes `page.supports` through whole and copies nothing, so **no** member
of a support descriptor was observed anywhere in the suite. The fixture was deliberately built to make a swap
detectable — support 11 is `ENDPOINT_DISPLAY` while 1–10 are `OCCURRENCE` — and nothing watched it, so a role or a
subject landing on the wrong row would pass on the wire.

Two cases added, covering `role`, `subject`, `result_id`, `source_ref`, `source_version`, `source_version_id`,
`location` and `span`. The fixture's spans were split so both arms of `spanOfColumns` (`evidence-source.ts:448`) appear
in one page: odd supports spell the span absent, even ones carry a real range, and the absent arm is `null` on the
wire rather than omitted or a `-1..-1` range.

An intermediate draft asserted the descriptor on the first page alone and **passed** under a mutation that hardcoded
`role: "occurrence"` — because the endpoint display is the eleventh support and the page is eight wide, so the
distinctive role is not on it. The case now reads a second, selected envelope and checks all nine entries together.

| Mutation | Result |
|---|---|
| `descriptorOf` returns a fixed `role: "occurrence"` | **red** on both descriptor cases |
| `locationOfColumns` crosses `unit` onto another value | **red** |
| the absent-span branch of `spanOfColumns` removed | **red** |

## 3. Runs

All against `feat/issue363-t14-ep4-dispatch` @ `0cde380` plus this test-only change.

| Run | Exit | Observed |
|---|---|---|
| `npx vitest run tests/storage/evidence-read-supports-dispatch.test.ts` | 0 | **15 passed** — baseline 12, plus the three new cases (descriptor field-by-field, endpoint-display role, selector spellings) |
| `npx vitest run tests/storage/` | 0 | **492 passed / 46 skipped** — baseline 489, +3. The single non-zero suite entry is `evidence-continuation-pg.test.ts`, which throws by design unless `IK_STRUCTURED_T14_EP4_PG=1` is set; that is the opt-in boundary, not a failure |
| `IK_STRUCTURED_T14_EP4_PG=1 npx vitest run tests/storage/evidence-continuation-pg.test.ts` | 0 | 18 passed — unchanged from baseline, over real PostgreSQL |
| `STRUCTURED_EVIDENCE_T13_ACCEPTANCE=1 npx vitest run tests/acceptance/t13-private-evidence-read.test.ts` | 0 | 12 passed — unchanged from baseline. Requires `GRAPHRAG_MEMORY_DB_URL`; the driver has no skip path and names the absent variable instead |
| `npm run typecheck` | 0 | — |

Every mutation in §1.3 and §2 was reverted and the suite re-run green before the commit.

## 4. Not verified

- No rebuild of `dist` was made, so nothing here claims the built artifact was compiled from the committed sources.
  The IK-side live lanes are recorded on the Fin side, which is where they were run.
- The production code was not re-reviewed. The five-axis review's own conclusions about it stand and were relied on.
