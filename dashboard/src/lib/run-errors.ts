/**
 * Run failure display — friendly one-sentence explanations for run error
 * codes. The public Run carries a stable `errorCode` copied from structured
 * diagnostic/error reasons (never recovered from prose); a general
 * user must never see the raw token. Known codes map to a plain sentence with
 * the next action; unknown codes fall back to the generic hint, and the raw
 * token stays available only in the folded expert details.
 *
 * Provider-access issues (`provider_connection_*`,
 * `credential_service_unavailable`) are classified earlier by RunView's
 * dedicated access-issue layer. Host extensions must contribute their own UI;
 * this shared client never infers behavior from an extension error-code prefix.
 */
import { t } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/index.ts";

const KNOWN_RUN_ERROR_HINTS: Readonly<Record<string, MessageKey>> = {
  source_sync_failed: "runError.sourceSyncFailed",
  source_ref_not_found: "runError.sourceRefNotFound",
  state_generation_mismatch: "runError.stateGenerationMismatch",
  plan_failed: "runError.planFailed",
  apply_failed: "runError.applyFailed",
  run_failed: "runError.runFailed",
  backup_failed: "runError.backupFailed",
};

/** Friendly failure hint for a run summary — never the raw error code. */
export function runFailureHint(errorCode: string | undefined): string {
  const key = errorCode ? KNOWN_RUN_ERROR_HINTS[errorCode] : undefined;
  return t(key ?? "run.summary.failedHint");
}
