import {
  DEFAULT_TRUSTED_NATIVE_CLIENTS,
  parseTrustedNativeClients,
  type TrustedNativeClient,
} from "takosumi-contract";

/**
 * Operator configuration naming the native phone apps whose declarations in
 * `interface.ui.surface` `document.clients` are trusted (TASK-0119). A
 * screen's client is `verified` only when its bundle id / applicationId and
 * its link templates match an entry here; every other declaration is shown as
 * unverified with its real destination. See `parseTrustedNativeClients` for
 * the entry format.
 */
export const TRUSTED_NATIVE_CLIENTS_ENV =
  "TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS" as const;

/**
 * Unset or blank: the built-in first-party clients. A JSON array replaces
 * them entirely (`[]` trusts none). Malformed fails startup.
 */
export function parseTrustedNativeClientsEnv(
  value?: string,
): readonly TrustedNativeClient[] {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TRUSTED_NATIVE_CLIENTS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${TRUSTED_NATIVE_CLIENTS_ENV} must be valid JSON`);
  }
  try {
    return parseTrustedNativeClients(parsed);
  } catch (error) {
    throw new TypeError(
      `${TRUSTED_NATIVE_CLIENTS_ENV}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let cachedRaw: string | undefined;
let cachedClients: readonly TrustedNativeClient[] | undefined;

/**
 * `parseTrustedNativeClientsEnv` for hosts that read `env` per request (the
 * platform Worker): parsed once per distinct value, and a malformed value
 * fails every request rather than silently trusting the defaults.
 */
export function trustedNativeClientsFromEnv(
  value?: string,
): readonly TrustedNativeClient[] {
  if (cachedClients !== undefined && cachedRaw === value) return cachedClients;
  const clients = parseTrustedNativeClientsEnv(value);
  cachedRaw = value;
  cachedClients = clients;
  return clients;
}
