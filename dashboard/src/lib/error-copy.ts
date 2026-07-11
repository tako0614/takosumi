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
export function friendlyError(
  err: unknown,
  t: FriendlyErrorTranslate,
): FriendlyError {
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
