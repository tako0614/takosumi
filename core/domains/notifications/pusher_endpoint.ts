/**
 * Where a Takosumi Mobile pusher may point.
 *
 * The instance only sends to push relays whose origins the operator lists in
 * `TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS`. There is no built-in default:
 * the official relay's production origin is not decided yet, so until the
 * operator names a relay the instance accepts no pusher. Because the
 * destination is always an operator-chosen origin, a registration cannot make
 * the instance send to an arbitrary URL, so no DNS resolution or
 * private-address check is needed and there is no MSC4174 activation step.
 */

/** The allowlist: a JSON array of https origins. Unset or empty: none. */
export const NOTIFICATION_PUSH_RELAY_ORIGINS_ENV =
  "TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS";

export const MAX_PUSHER_ENDPOINT_LENGTH = 1024;
const MAX_CONFIGURED_RELAY_ORIGINS = 16;

/**
 * The allowlist, exactly as configured (empty when unset). Throws on a
 * malformed value so a typo cannot silently change where pushes may go.
 */
export function parseNotificationPushRelayOrigins(
  value: string | undefined,
): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidRelayOrigins();
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_CONFIGURED_RELAY_ORIGINS) {
    throw invalidRelayOrigins();
  }
  const origins = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string") throw invalidRelayOrigins();
    const origin = exactHttpsOrigin(entry);
    if (!origin) throw invalidRelayOrigins();
    origins.add(origin);
  }
  return [...origins];
}

export type PusherEndpointProblem =
  | "endpoint_too_long"
  | "endpoint_invalid"
  | "endpoint_not_https"
  | "endpoint_port_not_443"
  | "endpoint_userinfo"
  | "endpoint_origin_not_allowed";

/**
 * Check a pusher endpoint (`data.url`): https, port 443, no userinfo, at most
 * 1024 characters, and an origin on the allowlist. Returns the normalized URL
 * or the reason it was refused.
 */
export function checkPusherEndpoint(
  value: string,
  allowedOrigins: readonly string[],
):
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly problem: PusherEndpointProblem } {
  if (value.length > MAX_PUSHER_ENDPOINT_LENGTH) {
    return { ok: false, problem: "endpoint_too_long" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: "endpoint_invalid" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, problem: "endpoint_not_https" };
  }
  // URL drops a default port, so any remaining port is not 443.
  if (url.port !== "") return { ok: false, problem: "endpoint_port_not_443" };
  if (url.username || url.password) {
    return { ok: false, problem: "endpoint_userinfo" };
  }
  if (url.hash) return { ok: false, problem: "endpoint_invalid" };
  if (url.href.length > MAX_PUSHER_ENDPOINT_LENGTH) {
    return { ok: false, problem: "endpoint_too_long" };
  }
  if (!allowedOrigins.includes(url.origin)) {
    return { ok: false, problem: "endpoint_origin_not_allowed" };
  }
  return { ok: true, endpoint: url.href };
}

function exactHttpsOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    // The configured value is an origin, not a URL under it.
    (url.pathname !== "/" && url.pathname !== "") ||
    /[?#]/.test(value)
  ) {
    return undefined;
  }
  return url.origin;
}

function invalidRelayOrigins(): TypeError {
  return new TypeError(
    `${NOTIFICATION_PUSH_RELAY_ORIGINS_ENV} must be a JSON array of at most ${MAX_CONFIGURED_RELAY_ORIGINS} https origins (port 443, no path)`,
  );
}
