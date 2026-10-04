import { describe, expect, it } from "vitest";

import { EVIDENCE_SUBJECT_KIND } from "../../src/core/types.js";
import type { StructuredSubject } from "../../src/core/structured/request.js";
import { toEvidenceSubjectKind } from "../../src/core/structured/evidence-subject.js";

describe("structured query evidence subjects", () => {
  it.each([
    ["entity", EVIDENCE_SUBJECT_KIND.ENTITY],
    ["relation_assertion", EVIDENCE_SUBJECT_KIND.ASSERTION],
  ] as const)("maps public subject %s to the evidence vocabulary", (subject, expected) => {
    expect(toEvidenceSubjectKind(subject satisfies StructuredSubject)).toBe(expected);
  });
});
