import {
  EVIDENCE_SUBJECT_KIND,
  type EvidenceSubjectKind,
} from "../types.js";
import type { StructuredSubject } from "./request.js";

const SUBJECT_TO_EVIDENCE_KIND = {
  entity: EVIDENCE_SUBJECT_KIND.ENTITY,
  relation_assertion: EVIDENCE_SUBJECT_KIND.ASSERTION,
} satisfies Readonly<Record<StructuredSubject, EvidenceSubjectKind>>;

/** Translate the public query vocabulary to the persisted evidence vocabulary. */
export function toEvidenceSubjectKind(
  subject: StructuredSubject
): EvidenceSubjectKind {
  return SUBJECT_TO_EVIDENCE_KIND[subject];
}
