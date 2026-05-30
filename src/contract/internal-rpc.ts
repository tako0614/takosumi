import type { ActorContext } from "./types.ts";
import {
  assertNoCanonicalDelimiter,
  hmacSha256Hex,
  readHeader,
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS,
  TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
  timestampWithinSkew,
  timingSafeEqualHex,
  toHex,
} from "./internal-crypto.ts";

export {
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS,
  TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
};

const textEncoder = new TextEncoder();

export const TAKOSUMI_INTERNAL_RPC_VERSION = "takosumi-internal";
export const TAKOSUMI_INTERNAL_PROTOCOL_HEADER = "x-takosumi-internal-protocol";
export const TAKOSUMI_INTERNAL_BODY_DIGEST_HEADER = "x-takosumi-body-digest";
export const TAKOSUMI_INTERNAL_NONCE_HEADER = "x-takosumi-nonce";
export const TAKOSUMI_INTERNAL_CALLER_HEADER = "x-takosumi-caller";
export const TAKOSUMI_INTERNAL_AUDIENCE_HEADER = "x-takosumi-audience";
export const TAKOSUMI_INTERNAL_CAPABILITIES_HEADER = "x-takosumi-capabilities";
export const TAKOSUMI_TRACEPARENT_HEADER = "traceparent";
export const TAKOSUMI_REQUEST_ID_HEADER = "x-request-id";
export const TAKOSUMI_CORRELATION_ID_HEADER = "x-correlation-id";

export type TakosumiActorContext = ActorContext;

export interface TakosumiInternalRpcSigningInput {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly body: string | Uint8Array;
  readonly actor: TakosumiActorContext;
  readonly caller: string;
  readonly audience: string;
  readonly capabilities?: readonly string[];
  readonly requestId?: string;
  readonly nonce?: string;
  readonly timestamp: string;
  readonly secret: string;
}

export interface TakosumiInternalRpcCanonicalInput {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly bodyDigest: string;
  readonly actorContextHeader: string;
  readonly caller: string;
  readonly audience: string;
  readonly capabilities: readonly string[];
  readonly requestId: string;
  readonly nonce: string;
  readonly timestamp: string;
}

export interface TakosumiInternalRpcVerificationInput {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly body: string | Uint8Array;
  readonly secret: string;
  readonly headers: Headers | Record<string, string>;
  readonly now?: () => Date;
  readonly maxClockSkewMs?: number;
  readonly expectedCaller?: string | readonly string[];
  readonly expectedAudience?: string;
  readonly requiredCapabilities?: readonly string[];
  /**
   * Optional single-use nonce recorder for replay protection within the
   * clock-skew window.
   *
   * The signed envelope already binds a per-request `nonce` into the HMAC,
   * but without a host-side store of seen nonces a captured-and-replayed
   * request stays valid for as long as its timestamp is within
   * `maxClockSkewMs` (default 5 minutes). When this callback is supplied it
   * is invoked exactly once per verified request (after the signature, body
   * digest, caller/audience/capability, and timestamp-skew checks all pass)
   * with the request `nonce` and the absolute epoch-ms expiry after which the
   * recorder may safely forget the nonce (timestamp + maxClockSkewMs). It
   * must atomically record-and-check: return `true` if the nonce was not seen
   * before (first use; accept) and `false` if it was already recorded
   * (replay; reject). A `false` result causes verification to return
   * `undefined`.
   *
   * Operators wiring a shared store (e.g. an expiring KV / Redis SET-NX or a
   * unique-insert table keyed on the nonce) get strict single-use semantics.
   * When omitted, verification behaves as before: the clock-skew window is
   * the only replay-protection boundary, so operators should keep
   * `maxClockSkewMs` as tight as their clock synchronization allows.
   */
  readonly recordNonce?: (
    nonce: string,
    expiresAtEpochMs: number,
  ) => Promise<boolean>;
}

export interface VerifiedTakosumiInternalRpc {
  readonly actor: TakosumiActorContext;
  readonly caller: string;
  readonly audience: string;
  readonly capabilities: readonly string[];
  readonly requestId: string;
  readonly nonce: string;
  readonly timestamp: string;
}

export interface TakosumiInternalServiceEndpoint {
  readonly serviceId: string;
  readonly audience: string;
  readonly url: string;
}

export interface TakosumiServiceDirectory {
  resolve(serviceId: string): TakosumiInternalServiceEndpoint | undefined;
}

/**
 * Resolves service endpoints from a supplied environment map. The env-var key
 * for a given service id is `${envPrefix}_${SERVICE_ID}_INTERNAL_URL` where
 * `SERVICE_ID` is upper-cased and any `-` is replaced with `_`. Operators may
 * pass a custom `envPrefix` (default `TAKOSUMI`) to namespace their deployment.
 *
 * The `env` map is required and has no runtime default: this contract package
 * is published to JSR for cross-runtime consumption, so it does not read
 * `Deno.env` / `process.env` itself. The caller (operator distribution /
 * runtime adapter) is responsible for snapshotting the environment for its
 * runtime and passing it in.
 */
export class EnvTakosumiServiceDirectory implements TakosumiServiceDirectory {
  readonly #env: Record<string, string | undefined>;
  readonly #envPrefix: string;

  constructor(
    env: Record<string, string | undefined>,
    envPrefix: string = "TAKOSUMI",
  ) {
    this.#env = env;
    this.#envPrefix = envPrefix;
  }

  resolve(serviceId: string): TakosumiInternalServiceEndpoint | undefined {
    const key = `${this.#envPrefix}_${
      serviceId.toUpperCase().replace(/-/g, "_")
    }_INTERNAL_URL`;
    const url = this.#env[key];
    if (!url) return undefined;
    return { serviceId, audience: serviceId, url };
  }
}

export interface TakosumiInternalClientOptions {
  readonly caller: string;
  readonly audience: string;
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
  readonly traceSink?: TakosumiInternalTraceSink;
  readonly traceIdFactory?: () => string;
  readonly spanIdFactory?: () => string;
  readonly warn?: (message: string) => void;
}

export type TakosumiInternalTraceSpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";
export type TakosumiInternalTraceSpanStatus = "unset" | "ok" | "error";

export interface TakosumiInternalTraceContext {
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly correlationId?: string;
}

export interface TakosumiInternalTraceSpanEvent {
  readonly id: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: TakosumiInternalTraceSpanKind;
  readonly status: TakosumiInternalTraceSpanStatus;
  readonly statusMessage?: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly attributes?: Record<string, string | number | boolean>;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface TakosumiInternalTraceSink {
  recordTrace(event: TakosumiInternalTraceSpanEvent): Promise<unknown>;
}

export class TakosumiInternalClient {
  readonly #caller: string;
  readonly #audience: string;
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #traceSink?: TakosumiInternalTraceSink;
  readonly #traceIdFactory?: () => string;
  readonly #spanIdFactory?: () => string;
  readonly #warn?: (message: string) => void;

  constructor(options: TakosumiInternalClientOptions) {
    this.#caller = options.caller;
    this.#audience = options.audience;
    this.#baseUrl = options.baseUrl;
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#traceSink = options.traceSink;
    this.#traceIdFactory = options.traceIdFactory;
    this.#spanIdFactory = options.spanIdFactory;
    this.#warn = options.warn;
  }

  async request(input: {
    readonly method: string;
    readonly path: string;
    readonly search?: string;
    readonly body?: string | Uint8Array;
    readonly actor: TakosumiActorContext;
    readonly capabilities?: readonly string[];
    readonly headers?: HeadersInit;
    readonly trace?: TakosumiInternalTraceContext;
  }): Promise<Response> {
    const body = input.body ?? "";
    const url = new URL(input.path, this.#baseUrl);
    if (input.search) url.search = input.search;
    let httpStatus: number | undefined;
    const trace = createTakosumiInternalTraceContext(
      {
        traceId: input.trace?.traceId ?? input.actor.traceId,
        parentSpanId: input.trace?.parentSpanId,
        correlationId: input.trace?.correlationId ?? input.actor.requestId,
      },
      { traceIdFactory: this.#traceIdFactory },
    );
    return await withTakosumiInternalTraceSpan(
      {
        trace,
        requestId: input.actor.requestId,
        traceSink: this.#traceSink,
        now: () => this.#clock().toISOString(),
        traceIdFactory: this.#traceIdFactory,
        spanIdFactory: this.#spanIdFactory,
        warn: this.#warn,
      },
      {
        name: "takosumi.internal_rpc.client",
        kind: "client",
        attributes: {
          "http.request.method": input.method.toUpperCase(),
          "http.route": input.path,
          "takosumi.internal_rpc.caller": this.#caller,
          "takosumi.internal_rpc.audience": this.#audience,
        },
        statusForResult: (response) => response.status >= 400 ? "error" : "ok",
        resultAttributes: () => ({
          "http.response.status_code": httpStatus,
        }),
      },
      async (span) => {
        const signed = await signTakosumiInternalRequest({
          method: input.method,
          path: input.path,
          query: url.search,
          body,
          actor: input.actor,
          caller: this.#caller,
          audience: this.#audience,
          capabilities: input.capabilities,
          timestamp: this.#clock().toISOString(),
          secret: this.#secret,
        });
        const headers = new Headers(input.headers);
        for (const [key, value] of Object.entries(signed.headers)) {
          headers.set(key, value);
        }
        headers.set(
          TAKOSUMI_TRACEPARENT_HEADER,
          renderTakosumiTraceparent(span.trace.traceId, span.spanId),
        );
        headers.set(TAKOSUMI_REQUEST_ID_HEADER, input.actor.requestId);
        if (span.trace.correlationId) {
          headers.set(TAKOSUMI_CORRELATION_ID_HEADER, span.trace.correlationId);
        }
        if (
          typeof body === "string" && body.length > 0 &&
          !headers.has("content-type")
        ) {
          headers.set("content-type", "application/json");
        }
        const fetchBody = typeof body === "string"
          ? body
          : bytesToArrayBuffer(body);
        const response = await this.#fetch(url, {
          method: input.method,
          headers,
          body: body.length > 0 ? fetchBody : undefined,
        });
        httpStatus = response.status;
        return response;
      },
    );
  }
}

interface TakosumiInternalTraceOptions {
  readonly trace: TakosumiInternalTraceContext;
  readonly requestId: string;
  readonly traceSink?: TakosumiInternalTraceSink;
  readonly now?: () => string;
  readonly traceIdFactory?: () => string;
  readonly spanIdFactory?: () => string;
  readonly warn?: (message: string) => void;
}

interface StartedTakosumiInternalTraceSpan {
  readonly trace: TakosumiInternalTraceContext;
  readonly spanId: string;
}

interface TakosumiInternalTraceSpanInput<T> {
  readonly name: string;
  readonly kind?: TakosumiInternalTraceSpanKind;
  readonly attributes?: Record<string, string | number | boolean | undefined>;
  readonly resultAttributes?: (
    result: T,
  ) => Record<string, string | number | boolean | undefined>;
  readonly statusForResult?: (result: T) => TakosumiInternalTraceSpanStatus;
  readonly statusMessageForResult?: (result: T) => string | undefined;
}

function createTakosumiInternalTraceContext(
  input: Partial<TakosumiInternalTraceContext>,
  options: Pick<TakosumiInternalTraceOptions, "traceIdFactory"> = {},
): TakosumiInternalTraceContext {
  return {
    traceId: input.traceId ?? (options.traceIdFactory ?? randomTraceId)(),
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

async function withTakosumiInternalTraceSpan<T>(
  options: TakosumiInternalTraceOptions,
  input: TakosumiInternalTraceSpanInput<T>,
  fn: (span: StartedTakosumiInternalTraceSpan) => Promise<T>,
): Promise<T> {
  const spanId = (options.spanIdFactory ?? randomSpanId)();
  const startedAt = now(options);
  try {
    const result = await fn({ trace: options.trace, spanId });
    await recordTakosumiInternalTraceSpan(options, {
      ...input,
      spanId,
      status: input.statusForResult?.(result) ?? "ok",
      statusMessage: input.statusMessageForResult?.(result),
      startTime: startedAt,
      endTime: now(options),
      attributes: {
        ...input.attributes,
        ...input.resultAttributes?.(result),
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordTakosumiInternalTraceSpan(options, {
      ...input,
      spanId,
      status: "error",
      statusMessage: message,
      startTime: startedAt,
      endTime: now(options),
    });
    throw error;
  }
}

async function recordTakosumiInternalTraceSpan(
  options: TakosumiInternalTraceOptions,
  input: {
    readonly name: string;
    readonly kind?: TakosumiInternalTraceSpanKind;
    readonly spanId: string;
    readonly attributes?: Record<string, string | number | boolean | undefined>;
    readonly status: TakosumiInternalTraceSpanStatus;
    readonly statusMessage?: string;
    readonly startTime: string;
    readonly endTime: string;
  },
): Promise<void> {
  const sink = options.traceSink;
  if (!sink) return;
  const attributes = compactAttributes(input.attributes ?? {});
  const span: TakosumiInternalTraceSpanEvent = {
    id: `span_${input.spanId}`,
    traceId: options.trace.traceId,
    spanId: input.spanId,
    ...(options.trace.parentSpanId
      ? { parentSpanId: options.trace.parentSpanId }
      : {}),
    name: input.name,
    kind: input.kind ?? "internal",
    status: input.status,
    ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
    startTime: input.startTime,
    endTime: input.endTime,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    requestId: options.requestId,
    ...(options.trace.correlationId
      ? { correlationId: options.trace.correlationId }
      : {}),
  };
  try {
    await sink.recordTrace(span);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.warn ?? console.warn)(
      `[takosumi-internal-rpc-trace] failed to record ${span.name}: ${message}`,
    );
  }
}

function renderTakosumiTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function compactAttributes(
  input: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function now(options: Pick<TakosumiInternalTraceOptions, "now">): string {
  return (options.now ?? (() => new Date().toISOString()))();
}

function randomTraceId(): string {
  return randomHex(16);
}

function randomSpanId(): string {
  return randomHex(8);
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalTakosumiInternalRequest(
  input: TakosumiInternalRpcCanonicalInput,
): string {
  const fields = {
    version: TAKOSUMI_INTERNAL_RPC_VERSION,
    method: input.method.toUpperCase(),
    pathWithQuery: pathWithQuery(input.path, input.query),
    timestamp: input.timestamp,
    requestId: input.requestId,
    nonce: input.nonce,
    caller: input.caller,
    audience: input.audience,
    capabilities: normalizeCapabilities(input.capabilities).join(","),
    bodyDigest: input.bodyDigest,
    actorContextHeader: input.actorContextHeader,
  };
  assertNoCanonicalDelimiter(fields);
  return Object.values(fields).join("\n");
}

export function encodeActorContext(actor: TakosumiActorContext): string {
  return btoa(JSON.stringify(actor));
}

export function decodeActorContext(value: string): TakosumiActorContext {
  const parsed = JSON.parse(atob(value)) as TakosumiActorContext;
  if (
    !parsed.actorAccountId || !parsed.requestId || !Array.isArray(parsed.roles)
  ) {
    throw new TypeError("Invalid Takosumi actor context");
  }
  return parsed;
}

export async function signTakosumiInternalRequest(
  input: TakosumiInternalRpcSigningInput,
): Promise<{ headers: Record<string, string> }> {
  const actorContextHeader = encodeActorContext(input.actor);
  const bodyDigest = await sha256Hex(input.body);
  const requestId = input.requestId ?? input.actor.requestId;
  const nonce = input.nonce ?? crypto.randomUUID();
  const capabilities = normalizeCapabilities(input.capabilities ?? []);
  const signature = await hmacSha256Hex(
    input.secret,
    canonicalTakosumiInternalRequest({
      method: input.method,
      path: input.path,
      query: input.query,
      bodyDigest,
      actorContextHeader,
      caller: input.caller,
      audience: input.audience,
      capabilities,
      requestId,
      nonce,
      timestamp: input.timestamp,
    }),
  );
  return {
    headers: {
      [TAKOSUMI_INTERNAL_PROTOCOL_HEADER]: TAKOSUMI_INTERNAL_RPC_VERSION,
      [TAKOSUMI_INTERNAL_ACTOR_HEADER]: actorContextHeader,
      [TAKOSUMI_INTERNAL_BODY_DIGEST_HEADER]: bodyDigest,
      [TAKOSUMI_INTERNAL_NONCE_HEADER]: nonce,
      [TAKOSUMI_INTERNAL_REQUEST_ID_HEADER]: requestId,
      [TAKOSUMI_INTERNAL_TIMESTAMP_HEADER]: input.timestamp,
      [TAKOSUMI_INTERNAL_CALLER_HEADER]: input.caller,
      [TAKOSUMI_INTERNAL_AUDIENCE_HEADER]: input.audience,
      [TAKOSUMI_INTERNAL_CAPABILITIES_HEADER]: capabilities.join(","),
      [TAKOSUMI_INTERNAL_SIGNATURE_HEADER]: signature,
    },
  };
}

/**
 * Verifies a signed internal RPC request from its headers.
 *
 * Replay protection: the canonical envelope binds a per-request `nonce` and
 * `timestamp` into the HMAC, but signature verification alone does not stop a
 * captured request from being replayed while its timestamp is still within
 * the clock-skew window (`maxClockSkewMs`, default 5 minutes). The skew window
 * is therefore the replay-protection boundary unless an `input.recordNonce`
 * store is supplied. Operators that need strict single-use semantics should
 * wire `recordNonce` to an expiring shared store; operators without one should
 * keep `maxClockSkewMs` as tight as their clock synchronization allows.
 */
export async function verifyTakosumiInternalRequestFromHeaders(
  input: TakosumiInternalRpcVerificationInput,
): Promise<VerifiedTakosumiInternalRpc | undefined> {
  const version = readHeader(input.headers, TAKOSUMI_INTERNAL_PROTOCOL_HEADER);
  const signature = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  );
  const timestamp = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
  );
  const requestId = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  );
  const nonce = readHeader(input.headers, TAKOSUMI_INTERNAL_NONCE_HEADER);
  const caller = readHeader(input.headers, TAKOSUMI_INTERNAL_CALLER_HEADER);
  const audience = readHeader(input.headers, TAKOSUMI_INTERNAL_AUDIENCE_HEADER);
  const capabilities = normalizeCapabilities(
    parseCapabilities(
      readHeader(input.headers, TAKOSUMI_INTERNAL_CAPABILITIES_HEADER),
    ),
  );
  const bodyDigest = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_BODY_DIGEST_HEADER,
  );
  const actorContextHeader = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_ACTOR_HEADER,
  );
  if (
    version !== TAKOSUMI_INTERNAL_RPC_VERSION || !signature || !timestamp ||
    !requestId || !nonce || !caller || !audience || !bodyDigest ||
    !actorContextHeader
  ) {
    return undefined;
  }
  if (!timestampWithinSkew(timestamp, input)) return undefined;
  if (!callerAllowed(caller, input.expectedCaller)) return undefined;
  if (input.expectedAudience && audience !== input.expectedAudience) {
    return undefined;
  }
  for (const capability of input.requiredCapabilities ?? []) {
    if (!capabilities.includes(capability)) return undefined;
  }
  const actualBodyDigest = await sha256Hex(input.body);
  if (!timingSafeEqualHex(actualBodyDigest, bodyDigest)) return undefined;
  let actor: TakosumiActorContext;
  try {
    actor = decodeActorContext(actorContextHeader);
  } catch {
    return undefined;
  }
  if (actor.requestId !== requestId) return undefined;
  const expectedSignature = await hmacSha256Hex(
    input.secret,
    canonicalTakosumiInternalRequest({
      method: input.method,
      path: input.path,
      query: input.query,
      bodyDigest,
      actorContextHeader,
      caller,
      audience,
      capabilities,
      requestId,
      nonce,
      timestamp,
    }),
  );
  if (!timingSafeEqualHex(expectedSignature, signature)) return undefined;
  // Replay guard: only consult the nonce store once the request is fully
  // authenticated, so an attacker cannot exhaust / poison the store with
  // forged-signature requests. The store records the nonce until the request
  // can no longer be within the skew window (timestamp + maxClockSkewMs); a
  // `false` result means the nonce was already used (replay) and the request
  // is rejected.
  if (input.recordNonce) {
    const maxClockSkewMs = input.maxClockSkewMs ??
      TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS;
    const parsedTimestamp = Date.parse(timestamp);
    const expiresAtEpochMs = Number.isFinite(maxClockSkewMs)
      ? parsedTimestamp + maxClockSkewMs
      : parsedTimestamp + TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS;
    const accepted = await input.recordNonce(nonce, expiresAtEpochMs);
    if (!accepted) return undefined;
  }
  return Object.freeze({
    actor: Object.freeze(structuredClone(actor)),
    caller,
    audience,
    capabilities,
    requestId,
    nonce,
    timestamp,
  });
}

function parseCapabilities(value: string | null): string[] {
  return (value ?? "").split(",").map((capability) => capability.trim()).filter(
    Boolean,
  );
}

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [
    ...new Set(
      capabilities.map((capability) => capability.trim()).filter(
        Boolean,
      ),
    ),
  ].sort();
}

function callerAllowed(
  caller: string,
  expected: string | readonly string[] | undefined,
): boolean {
  if (!expected) return true;
  return typeof expected === "string"
    ? caller === expected
    : expected.includes(caller);
}

function pathWithQuery(path: string, query?: string): string {
  if (!query) return path;
  const normalized = query.startsWith("?") ? query : `?${query}`;
  if (!path.includes("?")) return `${path}${normalized}`;
  return `${path}${normalized.replace(/^\?/, "&")}`;
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  return toHex(
    await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes)),
  );
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
