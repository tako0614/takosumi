/**
 * Substrate-level structured logger for the takosumi kernel.
 *
 * The kernel is the deploy substrate: it boots before any service is
 * wired and emits diagnostics before `createPaaSApp` returns. A logger
 * that depended on the runtime context would not be reachable from the
 * earliest startup hooks (env validation, encryption guards, retention
 * GC) so this module is intentionally:
 *
 *  - zero-dependency (no contract / observability / runtime imports)
 *  - synchronous (one write per `info` / `warn` / `error` call)
 *  - free of module-level side effects (no `Deno.env.get` at load time;
 *    the format is resolved lazily on first emit so tests that scope env
 *    via `Deno.env.set` are not racing module evaluation)
 *
 * Output shape (`json` format, one line per event):
 *
 *   {
 *     "level": "info",
 *     "msg": "kernel.boot.starting",
 *     "ts":  "2026-05-14T09:00:00.000Z",
 *     "service": "takosumi-kernel",
 *     "event": "kernel.boot.starting",
 *     ...keys
 *   }
 *
 * `event` is the stable dot-separated identifier (`kernel.<area>.<verb>`)
 * that downstream pipelines key on. The free-form `msg` field mirrors it
 * so a single string column captures both human-readable and machine
 * filtering needs (matches the yurucommu logger contract).
 *
 * Format selection:
 *  - `TAKOSUMI_LOG_FORMAT=json|pretty` overrides explicitly
 *  - otherwise: `pretty` when `TAKOSUMI_ENVIRONMENT` / `NODE_ENV` is
 *    `local` or `development` (or unset), `json` everywhere else.
 *
 * Stderr vs stdout:
 *  - `warn` / `error` → stderr (so operator log scrapers can separate)
 *  - `info` → stdout (standard convention; kernel boot diagnostics are
 *    informational unless they include `level=error`)
 *
 * Migration note: pre-logger boot diagnostics used inline strings such
 * as `[paas-init] storage migrations up-to-date (3 applied)`. Each such
 * call site now becomes
 * `log.info("kernel.boot.storage_migrations_up_to_date", { applied: 3 })`
 * — the prefix-style tag is encoded structurally instead of textually.
 */

export type KernelLogLevel = "info" | "warn" | "error";

export interface KernelLogFields {
  readonly [key: string]: unknown;
}

export interface KernelLogger {
  info(event: string, fields?: KernelLogFields): void;
  warn(event: string, fields?: KernelLogFields): void;
  error(event: string, fields?: KernelLogFields): void;
}

export type KernelLogFormat = "json" | "pretty";

export interface KernelLoggerOptions {
  readonly service?: string;
  readonly format?: KernelLogFormat;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

const DEFAULT_SERVICE = "takosumi-kernel";

function normalizeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return { message: String(value) };
}

function normalizeFields(
  fields: KernelLogFields | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? normalizeError(value) : value;
  }
  return out;
}

function resolveDefaultFormat(
  env: Readonly<Record<string, string | undefined>>,
): KernelLogFormat {
  const explicit = env.TAKOSUMI_LOG_FORMAT?.toLowerCase();
  if (explicit === "json" || explicit === "pretty") return explicit;
  const environment = (env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? "local")
    .toLowerCase();
  if (
    environment === "local" || environment === "development" ||
    environment === "dev" || environment === "test"
  ) {
    return "pretty";
  }
  return "json";
}

function safeEnv(): Readonly<Record<string, string | undefined>> {
  // `Deno.env.toObject()` requires --allow-env. The kernel runs with
  // --allow-all in production / tests, but library consumers that import
  // this module from a sandboxed context (e.g. plugin unit tests) may
  // not. Fall back to an empty object so the logger never throws during
  // construction.
  try {
    return Deno.env.toObject();
  } catch (_error) {
    return {};
  }
}

class KernelLoggerImpl implements KernelLogger {
  readonly #service: string;
  readonly #format: KernelLogFormat;
  readonly #now: () => Date;
  readonly #stdout: (line: string) => void;
  readonly #stderr: (line: string) => void;

  constructor(options: KernelLoggerOptions = {}) {
    const env = options.env ?? safeEnv();
    this.#service = options.service ?? DEFAULT_SERVICE;
    this.#format = options.format ?? resolveDefaultFormat(env);
    this.#now = options.now ?? (() => new Date());
    this.#stdout = options.stdout ?? defaultStdout;
    this.#stderr = options.stderr ?? defaultStderr;
  }

  info(event: string, fields?: KernelLogFields): void {
    this.#emit("info", event, fields);
  }

  warn(event: string, fields?: KernelLogFields): void {
    this.#emit("warn", event, fields);
  }

  error(event: string, fields?: KernelLogFields): void {
    this.#emit("error", event, fields);
  }

  #emit(
    level: KernelLogLevel,
    event: string,
    fields: KernelLogFields | undefined,
  ): void {
    const ts = this.#now().toISOString();
    const data = normalizeFields(fields);
    const sink = level === "info" ? this.#stdout : this.#stderr;
    if (this.#format === "json") {
      sink(JSON.stringify({
        level,
        msg: event,
        ts,
        service: this.#service,
        event,
        ...data,
      }));
      return;
    }
    const extra = Object.keys(data).length > 0
      ? " " + JSON.stringify(data)
      : "";
    sink(`${ts} ${level.toUpperCase()} [${this.#service}] ${event}${extra}`);
  }
}

function defaultStdout(line: string): void {
  // The kernel runs under Deno; node:console fallback is unnecessary.
  // Keep this as a single console.log so structured output is emitted
  // even when `Deno.stdout` is replaced by the test harness.
  console.log(line);
}

function defaultStderr(line: string): void {
  console.error(line);
}

/**
 * Create a kernel logger. Each top-level boot hook / handler should
 * obtain its own instance (or share the default `log` export below) so
 * that test harnesses can inject a sink without monkey-patching
 * `console.*`.
 */
export function createKernelLogger(
  options: KernelLoggerOptions = {},
): KernelLogger {
  return new KernelLoggerImpl(options);
}

/**
 * Default kernel logger. Intended for top-level boot diagnostics in
 * `index.ts` and other module-load-time call sites; service-internal
 * components should accept an injected `KernelLogger` for testability.
 */
export const log: KernelLogger = createKernelLogger();
