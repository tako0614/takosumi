/**
 * Shared friendly-error mapper for the dashboard.
 *
 * Turns a raw thrown value — including a `ControlApiError` / `ApiError` whose
 * `.message` may be nothing more than the bare `${status} ${statusText}` HTTP
 * fallback (e.g. `"500 Internal Server Error"`) or an untranslated internal
 * server sentence — into a SAFE, localized `message` plus an optional `detail`
 * that carries the raw text for a folded disclosure (never shown by default).
 *
 * The classification spirit is ported from the `/new` install flow's
 * `safeControlApiErrorMessage` (recognize opaque server/HTTP failures vs.
 * already user-facing messages; strip the bare status line and generic API
 * bucket phrases). This module is intentionally self-contained so any view can
 * import `friendlyError` without pulling in the install-flow helpers.
 *
 * Stable signature (other views depend on it):
 *
 *   friendlyError(err, t) -> { message, detail? }
 *
 * where `t` is the dashboard translator (`i18n/index.ts`). `message` is always
 * safe to render; `detail`, when present, is the raw error text a caller MAY
 * fold behind a `common.details` disclosure. It is never required.
 */
import { ControlApiError } from "./control-api.ts";
import { ApiError } from "../views/account/lib/http.ts";
import type { MessageKey } from "../i18n/index.ts";

/** The dashboard translator — the `t` exported by `i18n/index.ts`. */
export type FriendlyErrorTranslate = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

export interface FriendlyError {
  /** Localized, always-safe-to-render headline. */
  readonly message: string;
  /**
   * Raw error text for an optional folded disclosure. Omitted when the raw
   * text is empty or adds nothing to a user (a bare status line / generic API
   * bucket phrase).
   */
  readonly detail?: string;
}

const MAX_DETAIL_LENGTH = 240;

interface RawError {
  readonly status?: number;
  readonly message: string;
  readonly httpStatusFallback: boolean;
}

function normalize(message: string): string {
  return message.replace(/\s+/gu, " ").trim();
}

function extract(err: unknown): RawError {
  if (err instanceof ControlApiError || err instanceof ApiError) {
    return {
      status: err.status,
      message: normalize(err.message),
      httpStatusFallback: err.isHttpStatusFallback === true,
    };
  }
  if (err instanceof Error) {
    return { message: normalize(err.message), httpStatusFallback: false };
  }
  if (typeof err === "string") {
    return { message: normalize(err), httpStatusFallback: false };
  }
  return { message: "", httpStatusFallback: false };
}

/** `"500 Internal Server Error"`, `"404 Not Found"`, `"502 Bad Gateway"`, … */
function isBareHttpStatusLine(message: string): boolean {
  return /^[1-5]\d{2}\s+[A-Za-z][A-Za-z ]*$/u.test(message);
}

/** Generic API bucket phrases that explain nothing to a user on their own. */
function isGenericBucketPhrase(message: string): boolean {
  return /^(?:internal(?: server)? error|invalid request|bad request|bad gateway|service unavailable|gateway timeout|request timed out|request failed|failed to fetch|network error|unknown error|not found|session expired|unauthorized|forbidden)\.?$/iu.test(
    message,
  );
}

function isOpaque(raw: RawError): boolean {
  if (raw.httpStatusFallback) return true;
  if (raw.message === "") return true;
  // Server-side (5xx) and transport (status 0: network/timeout/abort) failures
  // are never actionable for a user; keep the message generic.
  if (
    typeof raw.status === "number" &&
    (raw.status === 0 || raw.status >= 500)
  ) {
    return true;
  }
  if (isBareHttpStatusLine(raw.message)) return true;
  if (isGenericBucketPhrase(raw.message)) return true;
  return false;
}

function truncate(message: string): string {
  return message.length > MAX_DETAIL_LENGTH
    ? `${message.slice(0, MAX_DETAIL_LENGTH - 3)}...`
    : message;
}

/**
 * Map any thrown value to safe, localized display copy.
 *
 * - Opaque server/HTTP failures → `t("error.generic")`, with the raw text (when
 *   it carries more than a bare status line / generic phrase) returned as
 *   `detail` for a folded disclosure.
 * - Otherwise the message is a real, user-facing sentence (e.g. a 4xx
 *   validation reason) and is returned as-is.
 */
/**
 * Stable deploy-control `details.reason` tokens → localized sentences.
 *
 * The control plane throws these as 4xx with an engineer-facing English
 * message (`state_generation_mismatch: plan run pr_x was created against …`).
 * `friendlyError` passes 4xx text through by design — a real validation
 * sentence IS the best copy — but these particular ones are internal prose, so
 * they are translated here instead. Unmapped reasons keep the existing
 * behaviour.
 */
const REASON_MESSAGES: Readonly<Record<string, MessageKey>> = {
  state_generation_mismatch: "controlError.stateGenerationMismatch",
  dependency_snapshot_stale: "controlError.dependencySnapshotStale",
  dependency_snapshot_missing: "controlError.dependencySnapshotStale",
  dependency_snapshot_tampered: "controlError.dependencySnapshotStale",
  dependency_outputs_unavailable: "controlError.dependencyUnavailable",
  dependency_state_unavailable: "controlError.dependencyUnavailable",
  dependency_value_sealer_unavailable: "controlError.dependencyUnavailable",
  sensitive_output_resolver_unavailable: "controlError.dependencyUnavailable",
  source_ref_changed: "controlError.sourceChanged",
  source_snapshot_mismatch: "controlError.sourceChanged",
  source_snapshot_missing: "controlError.sourceChanged",
  compatibility_report_missing: "controlError.compatibilityStale",
  compatibility_report_capsule_mismatch: "controlError.compatibilityStale",
  compatibility_report_snapshot_mismatch: "controlError.compatibilityStale",
  compatibility_report_source_mismatch: "controlError.compatibilityStale",
  compatibility_report_not_runnable: "controlError.compatibilityStale",
  compatibility_report_output_metadata_missing:
    "controlError.compatibilityStale",
  runner_infrastructure_error: "controlError.runnerUnavailable",
  runner_infrastructure_retry_exhausted: "controlError.runnerUnavailable",
  runner_capability_missing: "controlError.runnerUnavailable",
  capsule_plan_creation_timeout: "controlError.runnerUnavailable",
  slot_limit_reached: "controlError.slotLimitReached",
  owner_slot_limit_reached: "controlError.slotLimitReached",
  capsule_not_found: "controlError.capsuleNotFound",
  install_config_not_found: "controlError.configNotFound",
  output_share_revoked: "controlError.shareRevoked",
};

function mappedReasonMessage(
  err: unknown,
  t: FriendlyErrorTranslate,
): string | undefined {
  if (!(err instanceof ControlApiError)) return undefined;
  const key = err.reason ? REASON_MESSAGES[err.reason] : undefined;
  return key ? t(key) : undefined;
}

export function friendlyError(
  err: unknown,
  t: FriendlyErrorTranslate,
): FriendlyError {
  const mapped = mappedReasonMessage(err, t);
  if (mapped !== undefined) return { message: mapped };
  const raw = extract(err);
  if (isOpaque(raw)) {
    const detail =
      raw.message &&
      !isBareHttpStatusLine(raw.message) &&
      !isGenericBucketPhrase(raw.message)
        ? truncate(raw.message)
        : undefined;
    return {
      message: t("error.generic"),
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  return { message: raw.message };
}

/**
 * One-line copy for a failed READ (list/detail fetch).
 *
 * Views used to interpolate `ControlApiError.message` straight into
 * `common.fetchFailed`, which put `500 Internal Server Error` on a Japanese
 * screen. Opaque failures now collapse to one localized sentence; a genuine
 * 4xx explanation is still shown, and anything longer is left to `friendlyError`
 * callers that render a folded detail.
 */
export function fetchFailedMessage(
  err: unknown,
  t: FriendlyErrorTranslate,
): string {
  const friendly = friendlyError(err, t);
  return friendly.message === t("error.generic")
    ? t("common.fetchFailedGeneric")
    : t("common.fetchFailed", { message: friendly.message });
}
