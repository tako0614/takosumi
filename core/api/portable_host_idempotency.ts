import type { ActorContext } from "takosumi-contract";
import { sha256HexAsync } from "../shared/runtime/hash.ts";

const FINGERPRINT_FORMAT =
  "takosumi.portable-host-idempotency-fingerprint@v1" as const;
const HTTP_FIELD_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HTTP_FIELD_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/u;

export type PortableHostIdempotencyErrorCode =
  | "invalid_scope"
  | "invalid_request"
  | "idempotency_conflict"
  | "reservation_conflict"
  | "invalid_success_response"
  | "ledger_invariant_violation";

export class PortableHostIdempotencyError extends Error {
  constructor(
    readonly code: PortableHostIdempotencyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PortableHostIdempotencyError";
  }
}

export interface PortableHostIdempotencyRequest {
  /**
   * Already authenticated AND authorized Actor. The caller MUST complete both
   * checks before lookup/reserve; this module deliberately performs neither.
   */
  readonly actor: ActorContext;
  readonly space: string;
  readonly idempotencyKey: string;
  readonly method: string;
  /** Exact request target, including its original path and query string. */
  readonly requestTarget: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
  /** Raw request-body bytes, before JSON parsing or canonicalization. */
  readonly body: Uint8Array;
}

export interface PortableHostIdempotencyScope {
  readonly workspaceId: string;
  readonly actorAccountId: string;
  readonly space: string;
  readonly idempotencyKey: string;
}

export interface PortableHostRequestFingerprint {
  readonly format: typeof FINGERPRINT_FORMAT;
  readonly method: string;
  readonly requestTarget: string;
  readonly ifMatch: string | null;
  readonly ifNoneMatch: string | null;
  readonly body: {
    readonly sha256: `sha256:${string}`;
    readonly sizeBytes: number;
  };
}

export interface PortableHostIdempotencyReservation {
  readonly scope: PortableHostIdempotencyScope;
  readonly fingerprint: PortableHostRequestFingerprint;
  readonly reservationId: string;
}

export interface PortableHostIdempotencyReservedRecord
  extends PortableHostIdempotencyReservation {
  readonly state: "reserved";
}

export interface PortableHostSuccessWireResponse {
  readonly status: number;
  readonly statusText: string;
  /**
   * Ordered raw header pairs. A plain object or `Headers` would merge duplicate
   * fields and could not reproduce the exact successful response.
   */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export interface PortableHostIdempotencySucceededRecord
  extends PortableHostIdempotencyReservation {
  readonly state: "succeeded";
  readonly response: PortableHostSuccessWireResponse;
}

export type PortableHostIdempotencyRecord =
  | PortableHostIdempotencyReservedRecord
  | PortableHostIdempotencySucceededRecord;

export type PortableHostIdempotencyLedgerReserveResult =
  | {
      readonly kind: "reserved";
      readonly record: PortableHostIdempotencyReservedRecord;
    }
  | {
      readonly kind: "existing";
      readonly record: PortableHostIdempotencyRecord;
    };

export type PortableHostIdempotencyLedgerStoreResult =
  | {
      readonly kind: "stored" | "existing";
      readonly record: PortableHostIdempotencySucceededRecord;
    }
  | {
      readonly kind: "conflict";
    };

export type PortableHostIdempotencyLedgerReleaseResult =
  | { readonly kind: "released" }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict" };

export type PortableHostIdempotencyLedgerQuarantineResult =
  | { readonly kind: "quarantined" }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict" };

/**
 * Durable persistence port. Implementations MUST atomically create at most one
 * record for an exact scope and compare-and-set completion using the exact
 * reservation id and fingerprint. Release is the same compare-and-delete
 * operation and MUST never remove a succeeded or substituted reservation.
 */
export interface PortableHostIdempotencyLedger {
  lookup(
    scope: PortableHostIdempotencyScope,
  ): Promise<PortableHostIdempotencyRecord | undefined>;
  reserve(
    candidate: PortableHostIdempotencyReservedRecord,
  ): Promise<PortableHostIdempotencyLedgerReserveResult>;
  storeSuccess(
    candidate: PortableHostIdempotencySucceededRecord,
  ): Promise<PortableHostIdempotencyLedgerStoreResult>;
  release(
    reservation: PortableHostIdempotencyReservation,
  ): Promise<PortableHostIdempotencyLedgerReleaseResult>;
  /**
   * Compare-and-delete one succeeded response. Implementations MUST bind the
   * complete scope, reservation, fingerprint, and serialized response bytes;
   * a valid success or a substituted record must never be removed.
   */
  readonly quarantineSuccess?: (
    record: PortableHostIdempotencySucceededRecord,
  ) => Promise<PortableHostIdempotencyLedgerQuarantineResult>;
}

export type PortableHostIdempotencyReserveResult =
  | {
      readonly kind: "execute";
      readonly reservation: PortableHostIdempotencyReservation;
    }
  | {
      readonly kind: "in_progress";
      readonly reservation: PortableHostIdempotencyReservation;
    }
  | {
      readonly kind: "replay";
      readonly response: PortableHostSuccessWireResponse;
    };

export type PortableHostIdempotencyLookupResult =
  | { readonly kind: "miss" }
  | { readonly kind: "in_progress" }
  | {
      readonly kind: "replay";
      readonly response: PortableHostSuccessWireResponse;
    };

export type PortableHostIdempotencyQuarantineResult =
  | { readonly kind: "quarantined" }
  | { readonly kind: "missing" }
  | { readonly kind: "valid" };

export type PortableHostIdempotencyReleaseResult =
  | { readonly kind: "released" }
  | { readonly kind: "missing" };

export interface PortableHostIdempotencyCoordinatorOptions {
  readonly reservationIdFactory?: () => string;
}

export class PortableHostIdempotencyCoordinator {
  readonly #reservationIdFactory: () => string;

  constructor(
    readonly ledger: PortableHostIdempotencyLedger,
    options: PortableHostIdempotencyCoordinatorOptions = {},
  ) {
    this.#reservationIdFactory =
      options.reservationIdFactory ?? (() => crypto.randomUUID());
  }

  async reserve(
    request: PortableHostIdempotencyRequest,
  ): Promise<PortableHostIdempotencyReserveResult> {
    const identity = await requestIdentity(request);
    const candidate: PortableHostIdempotencyReservedRecord = {
      ...identity,
      reservationId: requiredToken(
        this.#reservationIdFactory(),
        "reservation id",
      ),
      state: "reserved",
    };
    const result = await this.ledger.reserve(candidate);
    if (
      !isObject(result) ||
      (result.kind !== "reserved" && result.kind !== "existing")
    ) {
      throw ledgerInvariant("idempotency ledger returned an invalid reserve result");
    }
    assertValidLedgerRecord(result.record);
    if (result.kind === "reserved" && result.record.state !== "reserved") {
      throw ledgerInvariant(
        "idempotency ledger returned a non-reserved record for a new reservation",
      );
    }
    assertSameScope(result.record.scope, candidate.scope);
    if (!sameFingerprint(result.record.fingerprint, candidate.fingerprint)) {
      throw new PortableHostIdempotencyError(
        "idempotency_conflict",
        "Idempotency-Key is already bound to a different portable host request",
      );
    }
    if (result.kind === "existing") {
      return result.record.state === "succeeded"
        ? { kind: "replay", response: cloneResponse(result.record.response) }
        : {
            kind: "in_progress",
            reservation: cloneReservation(result.record),
          };
    }
    if (result.record.reservationId !== candidate.reservationId) {
      throw new PortableHostIdempotencyError(
        "ledger_invariant_violation",
        "idempotency ledger returned a substituted reservation",
      );
    }
    return {
      kind: "execute",
      reservation: cloneReservation(result.record),
    };
  }

  async lookup(
    request: PortableHostIdempotencyRequest,
  ): Promise<PortableHostIdempotencyLookupResult> {
    const identity = await requestIdentity(request);
    const record = await this.ledger.lookup(identity.scope);
    if (record === undefined) return { kind: "miss" };
    assertValidLedgerRecord(record);
    assertSameScope(record.scope, identity.scope);
    if (!sameFingerprint(record.fingerprint, identity.fingerprint)) {
      throw new PortableHostIdempotencyError(
        "idempotency_conflict",
        "Idempotency-Key is already bound to a different portable host request",
      );
    }
    return record.state === "succeeded"
      ? { kind: "replay", response: cloneResponse(record.response) }
      : { kind: "in_progress" };
  }

  async storeSuccess(
    reservation: PortableHostIdempotencyReservation,
    response: PortableHostSuccessWireResponse,
  ): Promise<PortableHostSuccessWireResponse> {
    const candidate: PortableHostIdempotencySucceededRecord = {
      ...cloneReservation(reservation),
      state: "succeeded",
      response: validatedResponse(response),
    };
    const result = await this.ledger.storeSuccess(candidate);
    if (
      !isObject(result) ||
      (result.kind !== "stored" &&
        result.kind !== "existing" &&
        result.kind !== "conflict")
    ) {
      throw ledgerInvariant("idempotency ledger returned an invalid store result");
    }
    if (result.kind === "conflict") {
      throw new PortableHostIdempotencyError(
        "reservation_conflict",
        "portable host idempotency reservation is missing or has changed",
      );
    }
    assertValidLedgerRecord(result.record);
    if (result.record.state !== "succeeded") {
      throw ledgerInvariant(
        "idempotency ledger returned a non-succeeded record after success storage",
      );
    }
    assertSameScope(result.record.scope, candidate.scope);
    if (
      result.record.reservationId !== candidate.reservationId ||
      !sameFingerprint(result.record.fingerprint, candidate.fingerprint)
    ) {
      throw new PortableHostIdempotencyError(
        "reservation_conflict",
        "portable host idempotency reservation is missing or has changed",
      );
    }
    if (
      result.kind === "stored" &&
      !sameResponse(result.record.response, candidate.response)
    ) {
      throw new PortableHostIdempotencyError(
        "ledger_invariant_violation",
        "idempotency ledger substituted the stored success response",
      );
    }
    return cloneResponse(result.record.response);
  }

  /**
   * Quarantines one malformed legacy success without weakening the permanent
   * idempotency boundary. The request fingerprint and the exact response
   * observed by the caller are both compared again at the durable ledger.
   */
  async quarantineReplay(
    request: PortableHostIdempotencyRequest,
    response: PortableHostSuccessWireResponse,
    malformed: (
      response: PortableHostSuccessWireResponse,
    ) => boolean | Promise<boolean>,
  ): Promise<PortableHostIdempotencyQuarantineResult> {
    const identity = await requestIdentity(request);
    const record = await this.ledger.lookup(identity.scope);
    if (record === undefined) return { kind: "missing" };
    assertValidLedgerRecord(record);
    assertSameScope(record.scope, identity.scope);
    if (!sameFingerprint(record.fingerprint, identity.fingerprint)) {
      throw new PortableHostIdempotencyError(
        "idempotency_conflict",
        "Idempotency-Key is already bound to a different portable host request",
      );
    }
    if (record.state !== "succeeded") return { kind: "missing" };
    if (!sameResponse(record.response, response)) {
      throw new PortableHostIdempotencyError(
        "reservation_conflict",
        "portable host idempotency replay changed before quarantine",
      );
    }
    if (!(await malformed(record.response))) return { kind: "valid" };
    if (!this.ledger.quarantineSuccess) {
      throw ledgerInvariant(
        "portable host idempotency ledger cannot quarantine a succeeded response",
      );
    }
    const result = await this.ledger.quarantineSuccess({
      ...cloneReservation(record),
      state: "succeeded",
      response: cloneResponse(record.response),
    });
    if (
      !isObject(result) ||
      (result.kind !== "quarantined" &&
        result.kind !== "missing" &&
        result.kind !== "conflict")
    ) {
      throw ledgerInvariant(
        "idempotency ledger returned an invalid quarantine result",
      );
    }
    if (result.kind === "conflict") {
      throw new PortableHostIdempotencyError(
        "reservation_conflict",
        "portable host idempotency replay changed before quarantine",
      );
    }
    return result;
  }

  async release(
    reservation: PortableHostIdempotencyReservation,
  ): Promise<PortableHostIdempotencyReleaseResult> {
    // Callers may release only after a result that proves no canonical
    // mutation occurred after authorization (for example request validation or
    // capability rejection). Ambiguous backend outcomes must remain reserved
    // until the canonical lifecycle is reconciled.
    const result = await this.ledger.release(cloneReservation(reservation));
    if (
      !isObject(result) ||
      (result.kind !== "released" &&
        result.kind !== "missing" &&
        result.kind !== "conflict")
    ) {
      throw ledgerInvariant("idempotency ledger returned an invalid release result");
    }
    if (result.kind === "conflict") {
      throw new PortableHostIdempotencyError(
        "reservation_conflict",
        "portable host idempotency reservation is missing or has changed",
      );
    }
    return result;
  }
}

/**
 * Explicit in-memory evidence/test composition. Production compositions must
 * inject their durable ledger; the coordinator never creates this fallback.
 */
export class InMemoryPortableHostIdempotencyLedger
  implements PortableHostIdempotencyLedger
{
  readonly #records = new Map<string, PortableHostIdempotencyRecord>();

  async lookup(
    scope: PortableHostIdempotencyScope,
  ): Promise<PortableHostIdempotencyRecord | undefined> {
    const record = this.#records.get(scopeKey(scope));
    return record ? cloneRecord(record) : undefined;
  }

  async reserve(
    candidate: PortableHostIdempotencyReservedRecord,
  ): Promise<PortableHostIdempotencyLedgerReserveResult> {
    const key = scopeKey(candidate.scope);
    const existing = this.#records.get(key);
    if (existing) {
      return { kind: "existing", record: cloneRecord(existing) };
    }
    const stored = cloneRecord(candidate);
    this.#records.set(key, stored);
    return { kind: "reserved", record: cloneRecord(stored) };
  }

  async storeSuccess(
    candidate: PortableHostIdempotencySucceededRecord,
  ): Promise<PortableHostIdempotencyLedgerStoreResult> {
    const key = scopeKey(candidate.scope);
    const existing = this.#records.get(key);
    if (
      !existing ||
      existing.reservationId !== candidate.reservationId ||
      !sameFingerprint(existing.fingerprint, candidate.fingerprint)
    ) {
      return { kind: "conflict" };
    }
    if (existing.state === "succeeded") {
      return { kind: "existing", record: cloneRecord(existing) };
    }
    const stored = cloneRecord(candidate);
    this.#records.set(key, stored);
    return { kind: "stored", record: cloneRecord(stored) };
  }

  async release(
    reservation: PortableHostIdempotencyReservation,
  ): Promise<PortableHostIdempotencyLedgerReleaseResult> {
    const key = scopeKey(reservation.scope);
    const existing = this.#records.get(key);
    if (!existing) return { kind: "missing" };
    if (
      existing.state !== "reserved" ||
      existing.reservationId !== reservation.reservationId ||
      !sameFingerprint(existing.fingerprint, reservation.fingerprint)
    ) {
      return { kind: "conflict" };
    }
    this.#records.delete(key);
    return { kind: "released" };
  }

  async quarantineSuccess(
    candidate: PortableHostIdempotencySucceededRecord,
  ): Promise<PortableHostIdempotencyLedgerQuarantineResult> {
    const key = scopeKey(candidate.scope);
    const existing = this.#records.get(key);
    if (!existing) return { kind: "missing" };
    if (
      existing.state !== "succeeded" ||
      existing.reservationId !== candidate.reservationId ||
      !sameFingerprint(existing.fingerprint, candidate.fingerprint) ||
      !sameResponse(existing.response, candidate.response)
    ) {
      return { kind: "conflict" };
    }
    this.#records.delete(key);
    return { kind: "quarantined" };
  }
}

async function requestIdentity(
  request: PortableHostIdempotencyRequest,
): Promise<{
  readonly scope: PortableHostIdempotencyScope;
  readonly fingerprint: PortableHostRequestFingerprint;
}> {
  const workspaceId = requiredToken(
    request.actor.workspaceId,
    "authenticated Actor workspaceId",
    "invalid_scope",
  );
  const actorAccountId = requiredToken(
    request.actor.actorAccountId,
    "authenticated Actor account id",
    "invalid_scope",
  );
  const space = requiredToken(request.space, "Space", "invalid_scope");
  const idempotencyKey = requiredToken(
    request.idempotencyKey,
    "Idempotency-Key",
    "invalid_scope",
  );
  const method = requiredToken(request.method, "request method");
  const requestTarget = requiredToken(
    request.requestTarget,
    "exact request target",
  );
  if (!(request.body instanceof Uint8Array)) {
    throw new PortableHostIdempotencyError(
      "invalid_request",
      "raw request body must be a Uint8Array",
    );
  }
  const ifMatch = optionalHeaderValue(request.ifMatch, "If-Match");
  const ifNoneMatch = optionalHeaderValue(
    request.ifNoneMatch,
    "If-None-Match",
  );
  const body = new Uint8Array(request.body);
  const bodySize = body.byteLength;
  const bodySha256 = await sha256HexAsync(body);
  return {
    scope: { workspaceId, actorAccountId, space, idempotencyKey },
    fingerprint: {
      format: FINGERPRINT_FORMAT,
      method,
      requestTarget,
      ifMatch,
      ifNoneMatch,
      body: {
        sha256: `sha256:${bodySha256}`,
        sizeBytes: bodySize,
      },
    },
  };
}

function requiredToken(
  value: unknown,
  label: string,
  code: PortableHostIdempotencyErrorCode = "invalid_request",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PortableHostIdempotencyError(code, `${label} is required`);
  }
  return value;
}

function optionalHeaderValue(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new PortableHostIdempotencyError(
      "invalid_request",
      `${label} must be the exact header value when present`,
    );
  }
  return value;
}

function scopeKey(scope: PortableHostIdempotencyScope): string {
  return JSON.stringify([
    scope.workspaceId,
    scope.actorAccountId,
    scope.space,
    scope.idempotencyKey,
  ]);
}

function sameFingerprint(
  left: PortableHostRequestFingerprint,
  right: PortableHostRequestFingerprint,
): boolean {
  return (
    left.format === right.format &&
    left.method === right.method &&
    left.requestTarget === right.requestTarget &&
    left.ifMatch === right.ifMatch &&
    left.ifNoneMatch === right.ifNoneMatch &&
    left.body.sha256 === right.body.sha256 &&
    left.body.sizeBytes === right.body.sizeBytes
  );
}

function assertValidLedgerRecord(
  value: unknown,
): asserts value is PortableHostIdempotencyRecord {
  if (!isObject(value)) {
    throw ledgerInvariant("idempotency ledger returned a malformed record");
  }
  const scope = value.scope;
  const fingerprint = value.fingerprint;
  if (
    !isObject(scope) ||
    !nonEmptyString(scope.workspaceId) ||
    !nonEmptyString(scope.actorAccountId) ||
    !nonEmptyString(scope.space) ||
    !nonEmptyString(scope.idempotencyKey) ||
    !nonEmptyString(value.reservationId) ||
    !isObject(fingerprint) ||
    fingerprint.format !== FINGERPRINT_FORMAT ||
    !nonEmptyString(fingerprint.method) ||
    !nonEmptyString(fingerprint.requestTarget) ||
    !optionalString(fingerprint.ifMatch) ||
    !optionalString(fingerprint.ifNoneMatch) ||
    !isObject(fingerprint.body) ||
    typeof fingerprint.body.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(fingerprint.body.sha256) ||
    !Number.isSafeInteger(fingerprint.body.sizeBytes) ||
    (fingerprint.body.sizeBytes as number) < 0 ||
    (value.state !== "reserved" && value.state !== "succeeded")
  ) {
    throw ledgerInvariant("idempotency ledger returned a malformed record");
  }
  if (value.state === "succeeded") {
    try {
      validatedResponse(value.response as PortableHostSuccessWireResponse);
    } catch {
      throw ledgerInvariant(
        "idempotency ledger returned a malformed success response",
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function ledgerInvariant(message: string): PortableHostIdempotencyError {
  return new PortableHostIdempotencyError(
    "ledger_invariant_violation",
    message,
  );
}

function assertSameScope(
  actual: PortableHostIdempotencyScope,
  expected: PortableHostIdempotencyScope,
): void {
  if (scopeKey(actual) !== scopeKey(expected)) {
    throw new PortableHostIdempotencyError(
      "ledger_invariant_violation",
      "idempotency ledger returned a record from another scope",
    );
  }
}

function cloneReservation(
  value: PortableHostIdempotencyReservation,
): PortableHostIdempotencyReservation {
  return {
    scope: { ...value.scope },
    fingerprint: {
      ...value.fingerprint,
      body: { ...value.fingerprint.body },
    },
    reservationId: value.reservationId,
  };
}

function cloneRecord(
  value: PortableHostIdempotencyReservedRecord,
): PortableHostIdempotencyReservedRecord;
function cloneRecord(
  value: PortableHostIdempotencySucceededRecord,
): PortableHostIdempotencySucceededRecord;
function cloneRecord(
  value: PortableHostIdempotencyRecord,
): PortableHostIdempotencyRecord;
function cloneRecord(
  value: PortableHostIdempotencyRecord,
): PortableHostIdempotencyRecord {
  return value.state === "succeeded"
    ? {
        ...cloneReservation(value),
        state: "succeeded",
        response: cloneResponse(value.response),
      }
    : {
        ...cloneReservation(value),
        state: "reserved",
      };
}

function validatedResponse(
  value: PortableHostSuccessWireResponse,
): PortableHostSuccessWireResponse {
  if (
    !Number.isSafeInteger(value.status) ||
    value.status < 200 ||
    value.status > 299
  ) {
    throw new PortableHostIdempotencyError(
      "invalid_success_response",
      "only successful HTTP status codes can be stored for replay",
    );
  }
  if (
    typeof value.statusText !== "string" ||
    !HTTP_FIELD_VALUE_PATTERN.test(value.statusText)
  ) {
    throw new PortableHostIdempotencyError(
      "invalid_success_response",
      "success response status text is invalid",
    );
  }
  if (
    !Array.isArray(value.headers) ||
    !value.headers.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === "string" &&
        HTTP_FIELD_NAME_PATTERN.test(header[0]) &&
        typeof header[1] === "string" &&
        HTTP_FIELD_VALUE_PATTERN.test(header[1]),
    )
  ) {
    throw new PortableHostIdempotencyError(
      "invalid_success_response",
      "success response headers must be ordered raw name/value pairs",
    );
  }
  if (!(value.body instanceof Uint8Array)) {
    throw new PortableHostIdempotencyError(
      "invalid_success_response",
      "success response body must be raw bytes",
    );
  }
  return cloneResponse(value);
}

function cloneResponse(
  value: PortableHostSuccessWireResponse,
): PortableHostSuccessWireResponse {
  return {
    status: value.status,
    statusText: value.statusText,
    headers: value.headers.map(
      ([name, headerValue]) => [name, headerValue] as const,
    ),
    body: new Uint8Array(value.body),
  };
}

function sameResponse(
  left: PortableHostSuccessWireResponse,
  right: PortableHostSuccessWireResponse,
): boolean {
  if (
    left.status !== right.status ||
    left.statusText !== right.statusText ||
    left.headers.length !== right.headers.length ||
    left.body.byteLength !== right.body.byteLength
  ) {
    return false;
  }
  for (let index = 0; index < left.headers.length; index += 1) {
    if (
      left.headers[index][0] !== right.headers[index][0] ||
      left.headers[index][1] !== right.headers[index][1]
    ) {
      return false;
    }
  }
  for (let index = 0; index < left.body.byteLength; index += 1) {
    if (left.body[index] !== right.body[index]) return false;
  }
  return true;
}
