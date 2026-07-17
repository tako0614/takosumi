// Resource Shape adapter port (`docs/internal/final-plan.md` §9 Adapter Contract).
//
// An adapter turns a resolved implementation plan into native resources on a
// Target. The opentofu-adapter (broad-first, §9/§17) drives the shared OpenTofu
// runner with a first-class Resource run subject; a deterministic stub backs
// tests. The service depends only on this port, so runner wiring stays isolated.

import type {
  ActorContext,
  InstalledFormReference,
  JsonObject,
  NativeResourceRef,
  ResourceConnectionPermission,
  ResourceDeletePolicy,
  ResourceProjectionKind,
  ResourceShapeKind,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import type { ResourceShapePlan } from "./planner.ts";
import type {
  ResourceShapeExecutionRecord,
  ResourceShapeStateAdoptionDescriptor,
} from "./records.ts";

/**
 * A connection after the control plane has resolved and authorized its
 * referenced Resource. Adapters receive only public Resource outputs and
 * native identifiers; credential material remains in Credential /
 * ProviderConnection handling.
 */
export interface ResolvedResourceConnection {
  readonly resourceId: string;
  readonly kind: ResourceShapeKind;
  /** Exact owning Form for replay-safe Resource connection evidence. */
  readonly form?: InstalledFormReference;
  readonly permissions: readonly ResourceConnectionPermission[];
  readonly projection: ResourceProjectionKind;
  readonly target: string;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly outputs: JsonObject;
}

/** Everything an adapter needs to preview/apply one resolved Resource Shape. */
export interface AdapterApplyInput {
  /** Canonical resource id (`tkrn:{space}:{kind}:{name}`). */
  readonly resourceId: string;
  /** Exact immutable Form selected by the Resource/ResolutionLock pair. */
  readonly form?: InstalledFormReference;
  /**
   * Core-minted stable operation identity for direct adapter plugins. When it
   * is present, `apply` MUST be safe to replay with the same key and
   * `resourceId`: native create/update uses stable names and must reconcile the
   * same provider object instead of allocating a duplicate. Observe/refresh
   * remain read-only and may use the key only for correlation.
   */
  readonly operationKey?: string;
  readonly environment: string;
  readonly stateGeneration: number;
  readonly stateAdoption?: ResourceShapeStateAdoptionDescriptor;
  readonly plan: ResourceShapePlan;
  /** The selected TargetPool entry the plan resolved to. */
  readonly target: TargetPoolEntry;
  /** Complete selected descriptor, pinned by ResolutionLock. */
  readonly implementation: TargetImplementationDescriptor;
  /** ProviderConnection id injected into the runner for the opentofu-adapter. */
  readonly credentialRef?: string;
  /**
   * The native resources the Resolver expects to be created. The opentofu
   * adapter derives the actual set from the run/state and may ignore this; the
   * stub echoes it.
   */
  readonly nativeResources?: readonly NativeResourceRef[];
  /**
   * Resource references validated by the control plane immediately before
   * adapter execution. The map key is the application-visible connection
   * name, for example `ASSETS` or `DATABASE`.
   */
  readonly resolvedConnections?: Readonly<
    Record<string, ResolvedResourceConnection>
  >;
  readonly actor: ActorContext;
}

export interface AdapterPreviewResult {
  /** Human-readable plan summary (e.g. "create 1 resource"). */
  readonly summary: string;
  readonly nativeResources: readonly NativeResourceRef[];
  /** Underlying Run id when the adapter previews through the runner. */
  readonly runId?: string;
  /** Opaque provider correlation id; never accepted as Run authority. */
  readonly backendOperationId?: string;
}

export interface AdapterApplyResult {
  readonly nativeResources: readonly NativeResourceRef[];
  readonly outputs: JsonObject;
  readonly runId?: string;
  /** Opaque provider correlation id; never accepted as Run authority. */
  readonly backendOperationId?: string;
  readonly execution?: ResourceShapeExecutionRecord;
}

/**
 * Explicit proof attached only when an adapter can guarantee that a failed
 * apply performed no provider mutation. Untyped errors are outcome-unknown and
 * must never trigger automatic billing release or a terminal Failed state.
 */
export class ResourceAdapterApplyError extends Error {
  readonly mutationOutcome: "none" | "unknown";

  constructor(
    message: string,
    options: {
      readonly mutationOutcome: "none" | "unknown";
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ResourceAdapterApplyError";
    this.mutationOutcome = options.mutationOutcome;
  }
}

export function adapterApplyMutationOutcome(
  error: unknown,
): "none" | "unknown" {
  return error instanceof ResourceAdapterApplyError
    ? error.mutationOutcome
    : "unknown";
}

/**
 * State/output publication after a backend refresh. Unlike observe, refresh is
 * allowed to advance Resource-owned state and public outputs, but must not
 * mutate native provider resources.
 */
export interface AdapterRefreshResult extends AdapterApplyResult {
  readonly summary: string;
}

/** Existing provider identity to adopt into Resource-owned state. */
export interface AdapterImportInput extends AdapterApplyInput {
  readonly nativeId: string;
}

/** State/output publication produced by a read-only backend adoption. */
export interface AdapterImportResult extends AdapterApplyResult {
  readonly summary: string;
}

export type AdapterObservationStatus = "current" | "drifted" | "missing";

/** Read-only backend observation. It never updates provider state or outputs. */
export interface AdapterObserveResult {
  readonly status: AdapterObservationStatus;
  readonly summary: string;
  /** Underlying drift-check Run id when observation uses the shared runner. */
  readonly runId?: string;
  /** Opaque provider correlation id; never accepted as Run authority. */
  readonly backendOperationId?: string;
}

export interface AdapterDeleteInput {
  readonly resourceId: string;
  /** Exact immutable Form selected by the Resource/ResolutionLock pair. */
  readonly form?: InstalledFormReference;
  /**
   * Core-minted stable operation identity. `delete` MUST be idempotent for the
   * same key and `resourceId`, including replay after a lost provider response.
   */
  readonly operationKey?: string;
  readonly environment: string;
  readonly stateGeneration: number;
  readonly stateAdoption?: ResourceShapeStateAdoptionDescriptor;
  /**
   * The same implementation plan used to create the Resource. OpenTofu-backed
   * Resources need it again for destroy so the runner can replay the pinned
   * operator module against the Resource-owned state.
   */
  readonly plan?: ResourceShapePlan;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly target: TargetPoolEntry;
  readonly implementation: TargetImplementationDescriptor;
  readonly credentialRef?: string;
  readonly deletePolicy?: ResourceDeletePolicy;
  readonly actor: ActorContext;
}

/** Stable adapter contract for plan, reconcile, observation, and teardown. */
export interface ResourceAdapter {
  /** Stable adapter id, e.g. `opentofu` or `stub`. */
  readonly id: string;
  preview(input: AdapterApplyInput): Promise<AdapterPreviewResult>;
  /** Stable-name idempotent create/update when `operationKey` is present. */
  apply(input: AdapterApplyInput): Promise<AdapterApplyResult>;
  importResource(input: AdapterImportInput): Promise<AdapterImportResult>;
  observe(input: AdapterApplyInput): Promise<AdapterObserveResult>;
  refresh(input: AdapterApplyInput): Promise<AdapterRefreshResult>;
  /** Idempotent teardown when `operationKey` is present. */
  delete(input: AdapterDeleteInput): Promise<void>;
}

/**
 * Deterministic adapter: it never touches a cloud. It echoes the resolved
 * native-resource plan and synthesizes outputs from the module's public output
 * names. Available only through explicit test injection; production and
 * self-host composition fail closed when no real adapter is installed.
 */
export class StubResourceShapeAdapter implements ResourceAdapter {
  readonly id = "stub";

  preview(input: AdapterApplyInput): Promise<AdapterPreviewResult> {
    const native = input.nativeResources ?? [];
    return Promise.resolve({
      summary:
        `create ${native.length} resource(s) ` +
        `via ${input.plan.executionId} on ${input.target.name}`,
      nativeResources: native,
    });
  }

  apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    const outputs: JsonObject = {};
    for (const output of input.plan.publicOutputs) {
      outputs[output.name] =
        output.type === "json"
          ? {}
          : `stub://${input.target.name}/${input.resourceId}/${output.name}`;
    }
    return Promise.resolve({
      nativeResources: input.nativeResources ?? [],
      outputs,
    });
  }

  async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    const result = await this.apply(input);
    return {
      ...result,
      nativeResources:
        result.nativeResources.length > 0
          ? result.nativeResources.map((resource, index) =>
              index === 0 ? { ...resource, id: input.nativeId } : resource,
            )
          : [{ type: input.plan.shape, id: input.nativeId }],
      summary: `imported ${input.nativeId} as ${input.resourceId}`,
      execution: {
        runId: `stub-import:${input.resourceId}`,
        stateGeneration: input.stateGeneration + 1,
        stateRef: `stub://state/${input.resourceId}`,
        updatedAt: new Date(0).toISOString(),
      },
    };
  }

  observe(input: AdapterApplyInput): Promise<AdapterObserveResult> {
    return Promise.resolve({
      status: "current",
      summary: `observed ${input.resourceId} through ${input.plan.executionId}`,
    });
  }

  async refresh(input: AdapterApplyInput): Promise<AdapterRefreshResult> {
    const result = await this.apply(input);
    return {
      ...result,
      summary: `refreshed ${input.resourceId} through ${input.plan.executionId}`,
    };
  }

  delete(_input: AdapterDeleteInput): Promise<void> {
    return Promise.resolve();
  }
}
