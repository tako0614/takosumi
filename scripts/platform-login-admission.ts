/** Shared-account login composition. Namespace IDs remain operator inputs. */
const HOSTED_LOGIN_LIMITERS = [
  "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER",
  "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER",
] as const;

interface PlatformRateLimitBinding {
  readonly name: string;
  readonly type: "ratelimit";
  readonly namespace_id: string;
  readonly simple: { readonly limit: number; readonly period: number };
}

const invalid = () => new Error("platform_worker_login_admission_invalid");
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function parseConfig(source: string): Record<string, unknown> {
  try {
    const value: unknown = Bun.TOML.parse(source);
    if (record(value)) return value;
  } catch {
    // Do not print private config text in a TOML parser diagnostic.
  }
  throw invalid();
}

/** Closed Wrangler/API tuple; a declared binding alone is not runtime proof. */
export function platformRateLimitBindings(config: Record<string, unknown>): readonly PlatformRateLimitBinding[] {
  if (config.ratelimits === undefined) return [];
  if (!Array.isArray(config.ratelimits)) throw invalid();
  const names = new Set<string>();
  return config.ratelimits.map((value: unknown) => {
    if (!record(value) || !keys(value, ["name", "namespace_id", "simple"]) ||
      typeof value.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value.name) || names.has(value.name) ||
      typeof value.namespace_id !== "string" || !/^[1-9][0-9]*$/u.test(value.namespace_id) ||
      !record(value.simple) || !keys(value.simple, ["limit", "period"]) ||
      !Number.isSafeInteger(value.simple.limit) || (value.simple.limit as number) < 1 ||
      (value.simple.period !== 10 && value.simple.period !== 60)) throw invalid();
    names.add(value.name);
    return { name: value.name, type: "ratelimit", namespace_id: value.namespace_id,
      simple: { limit: value.simple.limit as number, period: value.simple.period as number } };
  });
}

/** Stock OSS has no Hosted dependency. A configured shared login requires both. */
export function assertPlatformLoginAdmission(source: string): boolean {
  const config = parseConfig(source);
  const vars = config.vars;
  const required = record(vars) && (vars.TAKOSUMI_SHARED_AUTH_PROFILE !== undefined || vars.TAKOSUMI_SHARED_AUTH_ORIGIN !== undefined);
  const bindings = platformRateLimitBindings(config);
  if (!required) return false;
  const selected = HOSTED_LOGIN_LIMITERS.map(name => bindings.find(binding => binding.name === name));
  if (selected.some(binding => !binding) || selected[0]!.namespace_id === selected[1]!.namespace_id) throw invalid();
  return true;
}

/** Only the dedicated integration transition may start with both ports absent. */
export function platformLoginAdmissionPredecessorSource(source: string, origin: string): string {
  const config = parseConfig(source);
  if (!record(config.vars) || config.vars.TAKOSUMI_SHARED_AUTH_PROFILE !== "shared-account" ||
    config.vars.TAKOSUMI_SHARED_AUTH_ORIGIN !== origin || !assertPlatformLoginAdmission(source)) throw invalid();
  const bindings = platformRateLimitBindings(config);
  if (bindings.length !== 2 || HOSTED_LOGIN_LIMITERS.some((name, index) => {
    const binding = bindings.find(value => value.name === name);
    return !binding || binding.simple.limit !== (index === 0 ? 60 : 10) || binding.simple.period !== 60;
  })) throw invalid();
  let removed = 0;
  let skipping = false;
  const before = source.split(/(?<=\n)/u).filter(line => {
    const heading = /^\s*(\[\[?[^\]\r\n]+\]?\])\s*(?:#.*)?$/u.exec(line);
    if (heading) {
      skipping = heading[1] === "[[ratelimits]]" || heading[1] === "[ratelimits.simple]";
      if (heading[1] === "[[ratelimits]]") removed++;
    }
    return !skipping;
  }).join("");
  const expected = { ...config };
  delete expected.ratelimits;
  if (removed !== 2 || JSON.stringify(Bun.TOML.parse(before)) !== JSON.stringify(expected)) throw invalid();
  return before;
}

interface LoginStartResponseFailure {
  readonly reason:
    | "unexpected_http_status"
    | "serving_version_missing"
    | "serving_version_mismatch"
    | "redirect_missing"
    | "redirect_invalid"
    | "redirect_target_mismatch";
  readonly httpStatus: number;
  readonly servingVersion: "match" | "missing" | "mismatch";
}

export class PlatformLoginStartReadbackError extends Error {
  constructor(readonly diagnostic: LoginStartResponseFailure | { readonly reason: "request_timeout" | "request_failed" }) {
    super("platform_worker_login_start_readback_invalid");
    this.name = "PlatformLoginStartReadbackError";
  }
}

/** One fresh anonymous GET; never follow or retain the state/cookie/Location. */
export async function verifyPlatformLoginStart(input: {
  readonly origin: string;
  readonly issuer: string;
  readonly versionId: string;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(`${input.origin}/auth/oidc/login?return=%2F`, {
      redirect: "manual", cache: "no-store", headers: { "cache-control": "no-cache" }, signal,
    });
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof DOMException && error.name === "TimeoutError");
    throw new PlatformLoginStartReadbackError({ reason: timedOut ? "request_timeout" : "request_failed" });
  }
  try {
    const version = response.headers.get("x-takosumi-version-id");
    const servingVersion = version === input.versionId ? "match" : version ? "mismatch" : "missing";
    const fail = (reason: LoginStartResponseFailure["reason"]) =>
      new PlatformLoginStartReadbackError({ reason, httpStatus: response.status, servingVersion });

    if (response.status !== 302 && response.status !== 303) throw fail("unexpected_http_status");
    if (servingVersion === "missing") throw fail("serving_version_missing");
    if (servingVersion === "mismatch") throw fail("serving_version_mismatch");
    const location = response.headers.get("location");
    if (!location) throw fail("redirect_missing");
    const destination = URL.parse(location);
    if (!destination) throw fail("redirect_invalid");
    if (destination.origin !== input.issuer || destination.pathname !== "/oauth/authorize" ||
      destination.username || destination.password || destination.hash) throw fail("redirect_target_mismatch");
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
