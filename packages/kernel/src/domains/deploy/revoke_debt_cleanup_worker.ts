import {
  type CompensateResult,
  formatPlatformOperationIdempotencyKey,
  getProvider,
  type JsonObject,
  type PlatformContext,
  type PlatformOperationContext,
  type ProviderPlugin,
  type ResourceHandle,
} from "takosumi-contract";
import type { RevokeDebtRecord, RevokeDebtStore } from "./revoke_debt_store.ts";
import type {
  TakosumiDeploymentRecordStore,
} from "./takosumi_deployment_record_store.ts";

export interface RevokeDebtCleanupWorkerOptions {
  readonly revokeDebtStore: RevokeDebtStore;
  readonly deploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly context:
    | PlatformContext
    | ((ownerSpaceId: string) => PlatformContext);
  readonly providerResolver?: (
    providerId: string,
  ) => ProviderPlugin | undefined;
  readonly clock?: () => Date;
}

export interface RevokeDebtCleanupOwnerInput {
  readonly ownerSpaceId: string;
  readonly limit?: number;
}

export type RevokeDebtCleanupAttemptStatus =
  | "cleared"
  | "retrying"
  | "operator-action-required"
  | "skipped";

export interface RevokeDebtCleanupAttempt {
  readonly debtId: string;
  readonly status: RevokeDebtCleanupAttemptStatus;
  readonly message?: string;
  readonly record?: RevokeDebtRecord;
}

export interface RevokeDebtCleanupResult {
  readonly ownerSpaceId: string;
  readonly scanned: number;
  readonly aged: number;
  readonly attempted: number;
  readonly cleared: number;
  readonly retrying: number;
  readonly operatorActionRequired: number;
  readonly skipped: number;
  readonly attempts: readonly RevokeDebtCleanupAttempt[];
}

export class RevokeDebtCleanupWorker {
  readonly #revokeDebtStore: RevokeDebtStore;
  readonly #deploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly #context:
    | PlatformContext
    | ((ownerSpaceId: string) => PlatformContext);
  readonly #providerResolver: (
    providerId: string,
  ) => ProviderPlugin | undefined;
  readonly #clock: () => Date;

  constructor(options: RevokeDebtCleanupWorkerOptions) {
    this.#revokeDebtStore = options.revokeDebtStore;
    this.#deploymentRecordStore = options.deploymentRecordStore;
    this.#context = options.context;
    this.#providerResolver = options.providerResolver ?? getProvider;
    this.#clock = options.clock ?? (() => new Date());
  }

  async processOwnerSpace(
    input: RevokeDebtCleanupOwnerInput,
  ): Promise<RevokeDebtCleanupResult> {
    const now = this.#clock().toISOString();
    const aged = await this.#revokeDebtStore.ageOpenDebts({
      ownerSpaceId: input.ownerSpaceId,
      now,
      limit: input.limit,
    });
    const records = await this.#revokeDebtStore.listByOwnerSpace(
      input.ownerSpaceId,
    );
    const attempts: RevokeDebtCleanupAttempt[] = [];
    for (const debt of records) {
      if (input.limit !== undefined && attempts.length >= input.limit) break;
      if (debt.status !== "open") continue;
      if (!isRetryDue(debt, now)) {
        attempts.push({ debtId: debt.id, status: "skipped" });
        continue;
      }
      attempts.push(await this.#processDebt(debt, now));
    }

    return {
      ownerSpaceId: input.ownerSpaceId,
      scanned: records.length,
      aged: aged.length,
      attempted: attempts.filter((attempt) => attempt.status !== "skipped")
        .length,
      cleared: attempts.filter((attempt) => attempt.status === "cleared")
        .length,
      retrying: attempts.filter((attempt) => attempt.status === "retrying")
        .length,
      operatorActionRequired:
        attempts.filter((attempt) =>
          attempt.status === "operator-action-required"
        ).length + aged.length,
      skipped: attempts.filter((attempt) => attempt.status === "skipped")
        .length,
      attempts,
    };
  }

  async #processDebt(
    debt: RevokeDebtRecord,
    now: string,
  ): Promise<RevokeDebtCleanupAttempt> {
    const target = await this.#resolveTarget(debt);
    if (!target.ok) {
      const record = await this.#revokeDebtStore.recordRetryAttempt({
        id: debt.id,
        ownerSpaceId: debt.ownerSpaceId,
        result: "blocked",
        error: target.error,
        now,
      });
      return {
        debtId: debt.id,
        status: "operator-action-required",
        message: stringValue(target.error.message),
        ...(record ? { record } : {}),
      };
    }

    try {
      const context = withRevokeDebtOperationContext(
        this.#contextFor(debt.ownerSpaceId),
        debt,
      );
      const result: CompensateResult = target.provider.compensate
        ? await target.provider.compensate(target.handle, context)
        : await target.provider.destroy(target.handle, context).then(() => ({
          ok: true,
        }));
      if (result.ok && result.revokeDebtRequired !== true) {
        const record = await this.#revokeDebtStore.recordRetryAttempt({
          id: debt.id,
          ownerSpaceId: debt.ownerSpaceId,
          result: "cleared",
          now,
        });
        return {
          debtId: debt.id,
          status: "cleared",
          ...(record ? { record } : {}),
        };
      }
      const record = await this.#revokeDebtStore.recordRetryAttempt({
        id: debt.id,
        ownerSpaceId: debt.ownerSpaceId,
        result: "retryable-failure",
        error: cleanupError({
          code: result.revokeDebtRequired === true
            ? "revoke_debt_required"
            : "compensate_failed",
          message: result.note ?? "connector did not clear revoke debt",
          detail: result.detail,
        }),
        now,
      });
      return {
        debtId: debt.id,
        status: record?.status === "operator-action-required"
          ? "operator-action-required"
          : "retrying",
        message: result.note,
        ...(record ? { record } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = await this.#revokeDebtStore.recordRetryAttempt({
        id: debt.id,
        ownerSpaceId: debt.ownerSpaceId,
        result: "retryable-failure",
        error: cleanupError({ code: "connector_failed", message }),
        now,
      });
      return {
        debtId: debt.id,
        status: record?.status === "operator-action-required"
          ? "operator-action-required"
          : "retrying",
        message,
        ...(record ? { record } : {}),
      };
    }
  }

  async #resolveTarget(
    debt: RevokeDebtRecord,
  ): Promise<
    | {
      readonly ok: true;
      readonly provider: ProviderPlugin;
      readonly handle: ResourceHandle;
    }
    | { readonly ok: false; readonly error: JsonObject }
  > {
    if (!debt.providerId) {
      return {
        ok: false,
        error: cleanupError({
          code: "provider_missing",
          message: "RevokeDebt has no providerId",
        }),
      };
    }
    const provider = this.#providerResolver(debt.providerId);
    if (!provider) {
      return {
        ok: false,
        error: cleanupError({
          code: "provider_unregistered",
          message: `provider is not registered: ${debt.providerId}`,
        }),
      };
    }
    const handle = await this.#resolveHandle(debt);
    if (!handle) {
      return {
        ok: false,
        error: cleanupError({
          code: "cleanup_target_missing",
          message: "RevokeDebt cleanup target handle could not be resolved",
        }),
      };
    }
    return { ok: true, provider, handle };
  }

  async #resolveHandle(
    debt: RevokeDebtRecord,
  ): Promise<ResourceHandle | undefined> {
    const explicit = handleFromDetail(debt.detail);
    if (explicit) return explicit;
    if (
      !this.#deploymentRecordStore || !debt.deploymentName ||
      !debt.resourceName
    ) {
      return undefined;
    }
    const deployment = await this.#deploymentRecordStore.get(
      debt.ownerSpaceId,
      debt.deploymentName,
    );
    if (!deployment) return undefined;
    const resource = deployment.appliedResources.find((entry) =>
      entry.resourceName === debt.resourceName &&
      (!debt.providerId || entry.providerId === debt.providerId)
    );
    return resource?.handle;
  }

  #contextFor(ownerSpaceId: string): PlatformContext {
    return typeof this.#context === "function"
      ? this.#context(ownerSpaceId)
      : this.#context;
  }
}

function isRetryDue(record: RevokeDebtRecord, now: string): boolean {
  if (!record.nextRetryAt) return false;
  return Date.parse(record.nextRetryAt) <= Date.parse(now);
}

function withRevokeDebtOperationContext(
  context: PlatformContext,
  debt: RevokeDebtRecord,
): PlatformContext {
  if (!debt.resourceName || !debt.providerId) return context;
  const operationPlanDigest = debt.operationPlanDigest ?? debt.sourceKey;
  const idempotencyKey = {
    spaceId: debt.ownerSpaceId,
    operationPlanDigest,
    journalEntryId: `revoke-debt:${debt.id}`,
  } as const;
  const operation: PlatformOperationContext = {
    phase: "compensate",
    walStage: "commit",
    operationId: debt.operationId ?? `revoke-debt-cleanup:${debt.id}`,
    resourceName: debt.resourceName,
    providerId: debt.providerId,
    op: "delete",
    desiredDigest: desiredDigestFromDetail(debt.detail) ?? debt.sourceKey,
    operationPlanDigest,
    idempotencyKey,
    idempotencyKeyString: formatPlatformOperationIdempotencyKey(
      idempotencyKey,
    ),
    recoveryMode: "compensate",
  };
  return { ...context, operation };
}

function handleFromDetail(detail: JsonObject | undefined): string | undefined {
  const direct = stringValue(detail?.handle);
  if (direct) return direct;
  const effect = objectValue(detail?.effect);
  const effectHandle = stringValue(effect?.handle);
  if (effectHandle) return effectHandle;
  const target = objectValue(detail?.target);
  return stringValue(target?.handle);
}

function desiredDigestFromDetail(
  detail: JsonObject | undefined,
): `sha256:${string}` | undefined {
  const candidate = stringValue(detail?.desiredDigest);
  return candidate?.startsWith("sha256:")
    ? candidate as `sha256:${string}`
    : undefined;
}

function cleanupError(input: {
  readonly code: string;
  readonly message: string;
  readonly detail?: JsonObject;
}): JsonObject {
  return {
    kind: "takosumi.revoke-debt-cleanup-error@v1",
    code: input.code,
    message: input.message,
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}
