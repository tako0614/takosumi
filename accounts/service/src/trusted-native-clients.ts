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

/** Why a configured value was not used. Never carries the value itself. */
export type TrustedNativeClientsEnvProblem = "invalid_json" | "invalid_entries";

export interface TrustedNativeClientsEnvResult {
  readonly clients: readonly TrustedNativeClient[];
  /** Set when the value was malformed; `clients` is then empty. */
  readonly problem?: TrustedNativeClientsEnvProblem;
}

/**
 * Unset or blank: the built-in first-party clients. A JSON array replaces
 * them entirely (`[]` trusts none). A malformed value trusts none and reports
 * why, so a typo never takes Accounts, OIDC or the control API down and never
 * silently restores the defaults the operator meant to replace. Never throws.
 */
export function parseTrustedNativeClientsEnv(
  value?: string,
): TrustedNativeClientsEnvResult {
  if (value === undefined || value.trim() === "") {
    return { clients: DEFAULT_TRUSTED_NATIVE_CLIENTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { clients: NONE, problem: "invalid_json" };
  }
  try {
    return { clients: parseTrustedNativeClients(parsed) };
  } catch {
    return { clients: NONE, problem: "invalid_entries" };
  }
}

const NONE: readonly TrustedNativeClient[] = Object.freeze([]);

/** Reads the setting into the trusted native clients. */
export type TrustedNativeClientsEnvReader = (
  value?: string,
) => readonly TrustedNativeClient[];

/**
 * A reader that parses each distinct value once and reports a malformed value
 * at most once with one structured error line on `log`. The line names the
 * setting and the problem and never includes the value or the parser's
 * message, which can quote it.
 */
export function createTrustedNativeClientsEnvReader(
  log: (line: string) => void = (line) => console.error(line),
): TrustedNativeClientsEnvReader {
  let cachedRaw: string | undefined;
  let cachedClients: readonly TrustedNativeClient[] | undefined;
  let reported = false;
  return (value) => {
    if (cachedClients !== undefined && cachedRaw === value) return cachedClients;
    const result = parseTrustedNativeClientsEnv(value);
    if (result.problem !== undefined && !reported) {
      reported = true;
      log(JSON.stringify({
        level: "error",
        event: "trusted_native_clients_config_invalid",
        setting: TRUSTED_NATIVE_CLIENTS_ENV,
        problem: result.problem,
        effect: "no_native_client_verified",
      }));
    }
    cachedRaw = value;
    cachedClients = result.clients;
    return result.clients;
  };
}

/**
 * The process-wide (per isolate) reader every host uses, including hosts that
 * read `env` per request (the platform Worker, the Cloudflare Accounts
 * handler): a malformed value is reported once per isolate and trusts none.
 */
export const trustedNativeClientsFromEnv: TrustedNativeClientsEnvReader =
  createTrustedNativeClientsEnvReader();
