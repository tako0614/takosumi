import type {
  PortableHostIdempotencyLedger,
  PortableHostIdempotencyLedgerReleaseResult,
  PortableHostIdempotencyLedgerReserveResult,
  PortableHostIdempotencyLedgerStoreResult,
  PortableHostIdempotencyRecord,
  PortableHostIdempotencyReservation,
  PortableHostIdempotencyReservedRecord,
  PortableHostIdempotencySucceededRecord,
  PortableHostIdempotencyScope,
  PortableHostRequestFingerprint,
  PortableHostSuccessWireResponse,
} from "../../core/api/portable_host_idempotency.ts";
import type { D1Database, D1Result } from "./bindings.ts";
import {
  ensureD1OpenTofuLedgerSchema,
  type D1OpenTofuControlSchemaMode,
  verifyD1OpenTofuLedgerSchemaPredeployed,
} from "./d1_opentofu_store.ts";

interface D1PortableHostIdempotencyRow {
  readonly workspace_id: string;
  readonly actor_account_id: string;
  readonly space: string;
  readonly idempotency_key: string;
  readonly state: string;
  readonly reservation_id: string;
  readonly fingerprint_json: string;
  readonly response_json: string | null;
}

interface StoredPortableHostResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly bodyBase64: string;
}

/**
 * Durable, exact-scope replay ledger for the portable Form host.
 *
 * Each statement binds at most eight values. Reservation is insert-if-absent;
 * success storage and release are compare-and-set operations over the exact
 * reservation id and canonical fingerprint.
 */
export class D1PortableHostIdempotencyLedger
  implements PortableHostIdempotencyLedger
{
  #initialized?: Promise<void>;

  constructor(
    private readonly db: D1Database,
    private readonly options: {
      readonly schemaMode?: D1OpenTofuControlSchemaMode;
    } = {},
  ) {}

  async lookup(
    scope: PortableHostIdempotencyScope,
  ): Promise<PortableHostIdempotencyRecord | undefined> {
    await this.#ensureSchema();
    return await this.#lookup(scope);
  }

  async reserve(
    candidate: PortableHostIdempotencyReservedRecord,
  ): Promise<PortableHostIdempotencyLedgerReserveResult> {
    await this.#ensureSchema();
    const result = await this.db
      .prepare(
        `insert into portable_host_idempotency (
          workspace_id,
          actor_account_id,
          space,
          idempotency_key,
          state,
          reservation_id,
          fingerprint_json,
          response_json
        ) values (?, ?, ?, ?, 'reserved', ?, ?, null)
        on conflict (
          workspace_id,
          actor_account_id,
          space,
          idempotency_key
        ) do nothing`,
      )
      .bind(
        candidate.scope.workspaceId,
        candidate.scope.actorAccountId,
        candidate.scope.space,
        candidate.scope.idempotencyKey,
        candidate.reservationId,
        serializeFingerprint(candidate.fingerprint),
      )
      .run();
    if (changes(result) === 1) {
      return { kind: "reserved", record: cloneReserved(candidate) };
    }
    const existing = await this.#lookup(candidate.scope);
    if (!existing) {
      throw new Error(
        "portable host idempotency reservation conflict returned no row",
      );
    }
    return { kind: "existing", record: existing };
  }

  async storeSuccess(
    candidate: PortableHostIdempotencySucceededRecord,
  ): Promise<PortableHostIdempotencyLedgerStoreResult> {
    await this.#ensureSchema();
    const fingerprintJson = serializeFingerprint(candidate.fingerprint);
    const result = await this.db
      .prepare(
        `update portable_host_idempotency
         set state = 'succeeded', response_json = ?
         where workspace_id = ?
           and actor_account_id = ?
           and space = ?
           and idempotency_key = ?
           and state = 'reserved'
           and reservation_id = ?
           and fingerprint_json = ?`,
      )
      .bind(
        serializeResponse(candidate.response),
        candidate.scope.workspaceId,
        candidate.scope.actorAccountId,
        candidate.scope.space,
        candidate.scope.idempotencyKey,
        candidate.reservationId,
        fingerprintJson,
      )
      .run();
    if (changes(result) === 1) {
      return { kind: "stored", record: cloneSucceeded(candidate) };
    }
    const existing = await this.#lookup(candidate.scope);
    if (
      existing?.state === "succeeded" &&
      existing.reservationId === candidate.reservationId &&
      serializeFingerprint(existing.fingerprint) === fingerprintJson
    ) {
      return { kind: "existing", record: existing };
    }
    return { kind: "conflict" };
  }

  async release(
    reservation: PortableHostIdempotencyReservation,
  ): Promise<PortableHostIdempotencyLedgerReleaseResult> {
    await this.#ensureSchema();
    const fingerprintJson = serializeFingerprint(reservation.fingerprint);
    const result = await this.db
      .prepare(
        `delete from portable_host_idempotency
         where workspace_id = ?
           and actor_account_id = ?
           and space = ?
           and idempotency_key = ?
           and state = 'reserved'
           and reservation_id = ?
           and fingerprint_json = ?`,
      )
      .bind(
        reservation.scope.workspaceId,
        reservation.scope.actorAccountId,
        reservation.scope.space,
        reservation.scope.idempotencyKey,
        reservation.reservationId,
        fingerprintJson,
      )
      .run();
    if (changes(result) === 1) return { kind: "released" };
    return (await this.#lookup(reservation.scope))
      ? { kind: "conflict" }
      : { kind: "missing" };
  }

  async #lookup(
    scope: PortableHostIdempotencyScope,
  ): Promise<PortableHostIdempotencyRecord | undefined> {
    const row = await this.db
      .prepare(
        `select
          workspace_id,
          actor_account_id,
          space,
          idempotency_key,
          state,
          reservation_id,
          fingerprint_json,
          response_json
         from portable_host_idempotency
         where workspace_id = ?
           and actor_account_id = ?
           and space = ?
           and idempotency_key = ?`,
      )
      .bind(
        scope.workspaceId,
        scope.actorAccountId,
        scope.space,
        scope.idempotencyKey,
      )
      .first<D1PortableHostIdempotencyRow>();
    return row ? recordFromRow(row) : undefined;
  }

  async #ensureSchema(): Promise<void> {
    if (!this.#initialized) {
      const attempt = (
        this.options.schemaMode === "predeployed"
          ? verifyD1OpenTofuLedgerSchemaPredeployed(this.db)
          : ensureD1OpenTofuLedgerSchema(this.db)
      ).catch((error: unknown) => {
        if (this.#initialized === attempt) this.#initialized = undefined;
        throw error;
      });
      this.#initialized = attempt;
    }
    await this.#initialized;
  }
}

function recordFromRow(
  row: D1PortableHostIdempotencyRow,
): PortableHostIdempotencyRecord {
  const base = {
    scope: {
      workspaceId: row.workspace_id,
      actorAccountId: row.actor_account_id,
      space: row.space,
      idempotencyKey: row.idempotency_key,
    },
    fingerprint: parseFingerprint(row.fingerprint_json),
    reservationId: row.reservation_id,
  };
  if (row.state === "reserved" && row.response_json === null) {
    return { ...base, state: "reserved" };
  }
  if (row.state === "succeeded" && row.response_json !== null) {
    return {
      ...base,
      state: "succeeded",
      response: parseResponse(row.response_json),
    };
  }
  throw new Error("portable host idempotency row has an invalid state");
}

function serializeFingerprint(
  value: PortableHostRequestFingerprint,
): string {
  return JSON.stringify({
    format: value.format,
    method: value.method,
    requestTarget: value.requestTarget,
    ifMatch: value.ifMatch,
    ifNoneMatch: value.ifNoneMatch,
    body: {
      sha256: value.body.sha256,
      sizeBytes: value.body.sizeBytes,
    },
  });
}

function parseFingerprint(value: string): PortableHostRequestFingerprint {
  const parsed = JSON.parse(value) as PortableHostRequestFingerprint;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.format !== "takosumi.portable-host-idempotency-fingerprint@v1" ||
    typeof parsed.method !== "string" ||
    typeof parsed.requestTarget !== "string" ||
    !(
      parsed.ifMatch === null ||
      typeof parsed.ifMatch === "string"
    ) ||
    !(
      parsed.ifNoneMatch === null ||
      typeof parsed.ifNoneMatch === "string"
    ) ||
    !parsed.body ||
    typeof parsed.body.sha256 !== "string" ||
    typeof parsed.body.sizeBytes !== "number"
  ) {
    throw new Error(
      "portable host idempotency row has an invalid fingerprint",
    );
  }
  return parsed;
}

function serializeResponse(value: PortableHostSuccessWireResponse): string {
  return JSON.stringify({
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
    bodyBase64: bytesToBase64(value.body),
  } satisfies StoredPortableHostResponse);
}

function parseResponse(value: string): PortableHostSuccessWireResponse {
  const parsed = JSON.parse(value) as StoredPortableHostResponse;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.status !== "number" ||
    typeof parsed.statusText !== "string" ||
    !Array.isArray(parsed.headers) ||
    !parsed.headers.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === "string" &&
        typeof header[1] === "string",
    ) ||
    typeof parsed.bodyBase64 !== "string"
  ) {
    throw new Error("portable host idempotency row has an invalid response");
  }
  return {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers.map(([name, headerValue]) => [
      name,
      headerValue,
    ]),
    body: base64ToBytes(parsed.bodyBase64),
  };
}

function cloneReserved(
  value: PortableHostIdempotencyReservedRecord,
): PortableHostIdempotencyReservedRecord {
  return {
    scope: { ...value.scope },
    fingerprint: parseFingerprint(serializeFingerprint(value.fingerprint)),
    reservationId: value.reservationId,
    state: "reserved",
  };
}

function cloneSucceeded(
  value: PortableHostIdempotencySucceededRecord,
): PortableHostIdempotencySucceededRecord {
  return {
    ...cloneReserved({ ...value, state: "reserved" }),
    state: "succeeded",
    response: parseResponse(serializeResponse(value.response)),
  };
}

function changes(result: D1Result): number {
  return result.meta?.changes ?? 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
