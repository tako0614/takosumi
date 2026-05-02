import type {
  RuntimeDesiredState,
  RuntimeObservedResourceState,
  RuntimeObservedRouteState,
  RuntimeObservedWorkloadState,
} from "./types.ts";

export interface RuntimeObservationProviderMaterialization {
  readonly id: string;
  readonly provider: string;
  readonly desiredStateId: string;
  readonly recordedAt: string;
}

export interface RuntimeObservationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly materialization: RuntimeObservationProviderMaterialization;
  readonly observedAt?: string;
}

export interface RuntimeReadinessObservation {
  readonly observedAt: string;
  readonly workloads: readonly RuntimeObservedWorkloadState[];
  readonly resources: readonly RuntimeObservedResourceState[];
  readonly routes: readonly RuntimeObservedRouteState[];
  readonly diagnostics: readonly string[];
}

export interface RuntimeObserver {
  observe(input: RuntimeObservationInput): Promise<RuntimeReadinessObservation>;
}

export class NoopRuntimeObserver implements RuntimeObserver {
  readonly #clock: () => Date;

  constructor(options: { readonly clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  observe(
    input: RuntimeObservationInput,
  ): Promise<RuntimeReadinessObservation> {
    const observedAt = input.observedAt ??
      input.materialization.recordedAt ??
      this.#clock().toISOString();
    return Promise.resolve(freezeClone({
      observedAt,
      workloads: input.desiredState.workloads.map((workload) => ({
        workloadId: workload.id,
        phase: "unknown" as const,
        message: "Live workload observer is not configured.",
      })),
      resources: input.desiredState.resources.map((resource) => ({
        resourceId: resource.id,
        phase: "unknown" as const,
        message: "Live resource observer is not configured.",
      })),
      routes: input.desiredState.routes.map((route) => ({
        routeId: route.id,
        ready: false,
        message: "Live route observer is not configured.",
      })),
      diagnostics: [
        `provider_materialization=${input.materialization.id}`,
        "live observation adapter not configured",
      ],
    }));
  }
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
