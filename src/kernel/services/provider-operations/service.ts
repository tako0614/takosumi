import type {
  ProviderMaterializationPlan,
  ProviderOperation,
} from "../../adapters/provider/mod.ts";
import type { RuntimeDesiredState } from "../../domains/runtime/mod.ts";
import type {
  FailedProviderOperationLike,
  ProviderMaterializationStatusDto,
  ProviderOperationFailureClassification,
  ProviderOperationRecord,
  ProviderOperationRecordStore,
  ProviderOperationServiceExecuteInput,
  ProviderOperationServiceExecuteResult,
  ProviderOperationServiceOptions,
} from "./types.ts";

export class InMemoryProviderOperationRecordStore
  implements ProviderOperationRecordStore {
  readonly #records = new Map<string, ProviderOperationRecord>();

  get(idempotencyKey: string): Promise<ProviderOperationRecord | undefined> {
    return Promise.resolve(this.#records.get(idempotencyKey));
  }

  put(record: ProviderOperationRecord): Promise<ProviderOperationRecord> {
    const frozen = freezeClone(record);
    this.#records.set(frozen.idempotencyKey, frozen);
    return Promise.resolve(frozen);
  }
}

export class ProviderOperationService {
  readonly #provider: string;
  readonly #materializer: ProviderOperationServiceOptions["materializer"];
  readonly #store: ProviderOperationRecordStore;
  readonly #auditStore?: ProviderOperationServiceOptions["auditStore"];
  readonly #auditIdFactory: () => string;
  readonly #clock: () => Date;

  constructor(options: ProviderOperationServiceOptions) {
    this.#provider = options.provider;
    this.#materializer = options.materializer;
    this.#store = options.store ?? new InMemoryProviderOperationRecordStore();
    this.#auditStore = options.auditStore;
    this.#auditIdFactory = options.auditIdFactory ??
      (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
  }

  async execute(
    input: ProviderOperationServiceExecuteInput,
  ): Promise<ProviderOperationServiceExecuteResult> {
    const idempotencyKey = input.idempotencyKey ??
      await deriveProviderOperationIdempotencyKey({
        provider: this.#provider,
        desiredState: input.desiredState,
      });

    const existing = await this.#store.get(idempotencyKey);
    if (existing) {
      return { record: existing, status: toMaterializationStatusDto(existing) };
    }

    const startedAt = this.#now();
    const running = await this.#store.put({
      idempotencyKey,
      provider: this.#provider,
      desiredStateId: input.desiredState.id,
      activationId: input.desiredState.activationId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    const credentialScopeError = validateProviderCredentialRefs(
      this.#provider,
      input.credentialRefs ?? [],
    );
    if (credentialScopeError) {
      const failed = await this.#store.put({
        ...running,
        status: "failed",
        updatedAt: this.#now(),
        failure: {
          reason: "provider_rejected",
          retryable: false,
          message: credentialScopeError,
        },
      });
      return { record: failed, status: toMaterializationStatusDto(failed) };
    }
    await this.#appendCredentialAudit(input, idempotencyKey, startedAt);

    try {
      const materialization = await this.#materializer.materialize(
        input.desiredState,
      );
      const failedOperations = findFailedProviderOperations(materialization);
      const completed = failedOperations.length === 0
        ? await this.#store.put({
          ...running,
          status: "succeeded",
          updatedAt: this.#now(),
          materialization,
        })
        : await this.#store.put({
          ...running,
          status: "failed",
          updatedAt: this.#now(),
          materialization,
          failure: classifyProviderOperationFailure(failedOperations[0]),
        });
      return {
        record: completed,
        status: toMaterializationStatusDto(completed),
      };
    } catch (error) {
      const failed = await this.#store.put({
        ...running,
        status: "failed",
        updatedAt: this.#now(),
        failure: classifyProviderOperationFailure(error),
      });
      return { record: failed, status: toMaterializationStatusDto(failed) };
    }
  }

  async getStatus(
    idempotencyKey: string,
  ): Promise<ProviderMaterializationStatusDto | undefined> {
    const record = await this.#store.get(idempotencyKey);
    return record ? toMaterializationStatusDto(record) : undefined;
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  async #appendCredentialAudit(
    input: ProviderOperationServiceExecuteInput,
    idempotencyKey: string,
    occurredAt: string,
  ): Promise<void> {
    const credentialRefs = input.credentialRefs ?? [];
    if (!this.#auditStore || credentialRefs.length === 0) {
      return;
    }
    const payload: Record<string, string | string[]> = {
      provider: this.#provider,
      desiredStateId: input.desiredState.id,
      activationId: input.desiredState.activationId,
      credentialRefs: [...credentialRefs],
    };
    if (input.actorId) payload.actorId = input.actorId;
    await this.#auditStore.append({
      id: this.#auditIdFactory(),
      eventClass: "security",
      type: "provider.credentials.used",
      severity: "warning",
      spaceId: input.desiredState.spaceId,
      groupId: input.desiredState.groupId,
      targetType: "provider-operation",
      targetId: idempotencyKey,
      payload,
      occurredAt,
      requestId: input.requestId,
    });
  }
}

function validateProviderCredentialRefs(
  provider: string,
  refs: readonly string[],
): string | undefined {
  const allowed = `secret://providers/${provider}`;
  for (const ref of refs) {
    if (ref === allowed || ref.startsWith(`${allowed}/`)) continue;
    return `provider credential ref ${ref} is outside provider scope ${allowed}`;
  }
  return undefined;
}

export async function deriveProviderOperationIdempotencyKey(options: {
  readonly provider: string;
  readonly desiredState: RuntimeDesiredState;
}): Promise<string> {
  const digest = await sha256Hex(stableStringify({
    provider: options.provider,
    desiredState: options.desiredState,
  }));
  return `provider-operation:${options.provider}:${options.desiredState.id}:${digest}`;
}

export function toMaterializationStatusDto(
  record: ProviderOperationRecord,
): ProviderMaterializationStatusDto {
  const operations = record.materialization?.operations ?? [];
  const failedProviderOperationCount = findFailedOperations(operations).length;
  return Object.freeze({
    idempotencyKey: record.idempotencyKey,
    provider: record.provider,
    desiredStateId: record.desiredStateId,
    activationId: record.activationId,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    materializationPlanId: record.materialization?.id,
    recordedOperationCount: operations.length,
    failedProviderOperationCount,
    failureReason: record.failure?.reason,
    retryable: record.failure?.retryable ?? false,
    message: record.failure?.message,
  });
}

export function classifyProviderOperationFailure(
  failure: unknown,
): ProviderOperationFailureClassification {
  const message = failureMessage(failure);
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return { reason: "provider_timeout", retryable: true, message };
  }
  if (
    normalized.includes("econnrefused") ||
    normalized.includes("connection refused") ||
    normalized.includes("network") ||
    normalized.includes("unavailable")
  ) {
    return { reason: "provider_unavailable", retryable: true, message };
  }
  if (
    normalized.includes("conflict") ||
    normalized.includes("already exists") ||
    normalized.includes("locked")
  ) {
    return { reason: "provider_conflict", retryable: true, message };
  }
  if (
    normalized.includes("invalid") ||
    normalized.includes("denied") ||
    normalized.includes("forbidden") ||
    normalized.includes("unauthorized") ||
    normalized.includes("not found")
  ) {
    return { reason: "provider_rejected", retryable: false, message };
  }
  return { reason: "unknown", retryable: false, message };
}

function findFailedProviderOperations(
  plan: ProviderMaterializationPlan,
): readonly ProviderOperation[] {
  return findFailedOperations(plan.operations);
}

function findFailedOperations(
  operations: readonly ProviderOperation[],
): readonly ProviderOperation[] {
  return operations.filter((operation) =>
    operation.execution?.status === "failed"
  );
}

function failureMessage(failure: unknown): string {
  if (isFailedProviderOperationLike(failure)) {
    const target = failure.targetName ?? failure.targetId ?? failure.kind;
    const stderr = failure.execution?.stderr?.trim();
    const stdout = failure.execution?.stdout?.trim();
    const output = stderr || stdout || `exit code ${failure.execution?.code}`;
    return `${failure.kind} ${target}: ${output}`;
  }
  if (failure instanceof Error) return failure.message || failure.name;
  if (typeof failure === "string") return failure;
  return "provider materialization failed";
}

function isFailedProviderOperationLike(
  value: unknown,
): value is FailedProviderOperationLike {
  return !!value && typeof value === "object" && "execution" in value &&
    "kind" in value;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")
  }}`;
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
