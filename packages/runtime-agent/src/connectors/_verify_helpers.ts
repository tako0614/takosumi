/**
 * Shared helpers for `Connector.verify(...)` implementations.
 *
 * Each connector implements `verify` by issuing the cheapest read-only API
 * call to its provider (ListBuckets / DescribeClusters / GET /namespaces /
 * etc.). The thin wrappers here translate raw HTTP status codes and thrown
 * errors into the structured `ConnectorVerifyResult` envelope so the
 * `POST /v1/lifecycle/verify` table comes out consistent across providers.
 */

import type { ConnectorVerifyResult } from "./connector.ts";

/**
 * Map an HTTP status from a verify call onto a `ConnectorVerifyResult`.
 *
 * `okStatuses` are treated as `{ ok: true, note: "credentials valid" }`. Any
 * status in `okStatuses` (default: 200, 204, 404 — 404 means the credentials
 * worked but the optional resource is absent, which still proves auth) is
 * accepted. 401 / 403 are mapped to `auth_failed` / `permission_denied`,
 * everything else to `network_error`.
 */
export function verifyResultFromStatus(
  status: number,
  options: {
    readonly okStatuses?: readonly number[];
    readonly responseText?: string;
    readonly context: string;
  },
): ConnectorVerifyResult {
  const ok = options.okStatuses ?? [200, 204, 404];
  if (ok.includes(status)) {
    return { ok: true, note: "credentials valid" };
  }
  if (status === 401) {
    return {
      ok: false,
      code: "auth_failed",
      note: trimNote(
        `${options.context}: HTTP 401 ${options.responseText ?? ""}`,
      ),
    };
  }
  if (status === 403) {
    return {
      ok: false,
      code: "permission_denied",
      note: trimNote(
        `${options.context}: HTTP 403 ${options.responseText ?? ""}`,
      ),
    };
  }
  return {
    ok: false,
    code: "network_error",
    note: trimNote(
      `${options.context}: HTTP ${status} ${options.responseText ?? ""}`,
    ),
  };
}

/**
 * Categorise a thrown error as either auth/network/permission. AWS / GCP /
 * Cloudflare lifecycle helpers all throw `Error` instances with HTTP status
 * embedded in `message`, so we pattern-match the message text. Anything that
 * looks like a DNS / TLS / fetch failure is classified as `network_error`.
 */
export function verifyResultFromError(
  err: unknown,
  context: string,
): ConnectorVerifyResult {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /HTTP 401|Unauthorized|invalid token|InvalidClientTokenId/i.test(message)
  ) {
    return {
      ok: false,
      code: "auth_failed",
      note: trimNote(`${context}: ${message}`),
    };
  }
  if (
    /HTTP 403|Forbidden|AccessDenied|permission denied|UnauthorizedOperation/i
      .test(message)
  ) {
    return {
      ok: false,
      code: "permission_denied",
      note: trimNote(`${context}: ${message}`),
    };
  }
  return {
    ok: false,
    code: "network_error",
    note: trimNote(`${context}: ${message}`),
  };
}

function trimNote(note: string): string {
  const collapsed = note.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 240) return collapsed;
  return `${collapsed.slice(0, 237)}...`;
}
