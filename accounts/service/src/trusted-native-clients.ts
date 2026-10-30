import {
  DEFAULT_TRUSTED_NATIVE_CLIENTS,
  parseTrustedNativeClients,
  RESERVED_DEFAULT_NATIVE_CLIENTS,
  type TrustedNativeClient,
  TrustedNativeClientsError,
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

/** Why a configured value was not used. Never carries the value itself. */
export type TrustedNativeClientsEnvProblem =
  | "not_a_string"
  | "invalid_json"
  | "invalid_entries";

export interface TrustedNativeClientsEnvResult {
  readonly clients: readonly TrustedNativeClient[];
  /**
   * Set when the value was malformed. `clients` is then the built-in clients
   * marked reserved-only: they verify nothing, but no unverified declaration
   * may use their names, schemes or link hosts.
   */
  readonly problem?: TrustedNativeClientsEnvProblem;
  /**
   * For `invalid_entries`, where the list broke: the entry index and field
   * (`[0].name`), never a value.
   */
  readonly path?: string;
}

/**
 * Unset or blank: the built-in first-party clients. A JSON array string
 * replaces them entirely (`[]` trusts none). Anything else (not a string, not
 * JSON, or entries that break the rules) verifies nothing, so a typo never
 * takes Accounts, OIDC or the control API down and never silently restores
 * the trust the operator meant to replace; the built-in clients stay
 * reserved so nobody can borrow their names or schemes meanwhile. Never
 * throws.
 */
export function parseTrustedNativeClientsEnv(
  value?: unknown,
): TrustedNativeClientsEnvResult {
  if (value === undefined || value === null) {
    return { clients: DEFAULT_TRUSTED_NATIVE_CLIENTS };
  }
  if (typeof value !== "string") {
    return { clients: RESERVED_DEFAULT_NATIVE_CLIENTS, problem: "not_a_string" };
  }
  if (value.trim() === "") return { clients: DEFAULT_TRUSTED_NATIVE_CLIENTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { clients: RESERVED_DEFAULT_NATIVE_CLIENTS, problem: "invalid_json" };
  }
  try {
    return { clients: parseTrustedNativeClients(parsed) };
  } catch (error) {
    return {
      clients: RESERVED_DEFAULT_NATIVE_CLIENTS,
      problem: "invalid_entries",
      ...(error instanceof TrustedNativeClientsError && SAFE_PATH.test(error.path)
        ? { path: error.path }
        : {}),
    };
  }
}

/** An entry index and field names only: `list`, `[0]`, `[0].android.templates`. */
const SAFE_PATH = /^(?:list|\[[0-9]{1,3}\](?:\.[A-Za-z]{1,32}){0,2})$/u;

/** Reads the setting into the trusted native clients. */
export type TrustedNativeClientsEnvReader = (
  value?: unknown,
) => readonly TrustedNativeClient[];

/**
 * A reader that parses each distinct value once and reports a malformed value
 * with one structured error line on `log`: once for as long as the value
 * stays the same, which is once per isolate in a deployed host. The line
 * names the setting, the problem and where the list broke, and never includes
 * the value or the parser's message, which can quote it. A throwing `log`
 * never escapes.
 */
export function createTrustedNativeClientsEnvReader(
  log: (line: string) => void = (line) => console.error(line),
): TrustedNativeClientsEnvReader {
  let cachedRaw: unknown;
  let cachedClients: readonly TrustedNativeClient[] | undefined;
  return (value) => {
    if (cachedClients !== undefined && cachedRaw === value) return cachedClients;
    const result = parseTrustedNativeClientsEnv(value);
    cachedRaw = value;
    cachedClients = result.clients;
    if (result.problem !== undefined) {
      try {
        log(JSON.stringify({
          level: "error",
          event: "trusted_native_clients_config_invalid",
          setting: TRUSTED_NATIVE_CLIENTS_ENV,
          problem: result.problem,
          ...(result.path !== undefined ? { field: result.path } : {}),
          effect: "no_native_client_verified",
        }));
      } catch {
        // Logging is best effort; the reader always returns.
      }
    }
    return result.clients;
  };
}

/**
 * The process-wide (per isolate) reader every host uses, including hosts that
 * read `env` per request (the platform Worker, the Cloudflare Accounts
 * handler): a malformed value is reported once per isolate and verifies
 * nothing.
 */
export const trustedNativeClientsFromEnv: TrustedNativeClientsEnvReader =
  createTrustedNativeClientsEnvReader();
