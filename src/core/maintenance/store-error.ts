/**
 * Storage fault for the maintenance work store.
 *
 * It carries BOTH vocabularies on purpose. `GraphragError` keeps this package's
 * typed-error convention, and `failureCode` names the maintenance work failure a
 * worker should record — so a caller can decide whether a fault is worth
 * retrying without parsing an error message. A raw driver error carries neither.
 *
 * It lives here rather than in either store so both implementations raise the
 * same type for the same condition; a store-specific error class would let the
 * twins drift on exactly the vocabulary callers branch on.
 */
import { GraphragError } from "../errors.js";
import type { MaintenanceWorkFailureCode } from "./types.js";

export class MaintenanceStoreError extends GraphragError {
  constructor(
    message: string,
    readonly failureCode: MaintenanceWorkFailureCode
  ) {
    super(message, "STORAGE_ERROR");
    this.name = "MaintenanceStoreError";
  }
}
