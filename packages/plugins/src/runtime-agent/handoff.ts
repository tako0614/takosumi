/**
 * Provider handoff bridge — converts a kernel-side {@link RuntimeAgentRegistry}
 * into the per-provider `runtimeAgentHandoff` hook shape each provider plugin
 * (AWS / GCP / k8s) consumes.
 *
 * Provider plugins use a small `enqueue(input)` hook to push long-running
 * operations onto the runtime-agent work queue. Each provider has its own
 * input shape (e.g. {@link GcpRuntimeAgentEnqueueInput}); the bridge below
 * normalises that into a single `LongRunningOperationEnqueue` descriptor and
 * forwards it to the kernel registry via
 * {@link RuntimeAgentRegistry.enqueueLongRunningOperation}.
 */
import type {
  EnqueueLongRunningOperationInput,
  RuntimeAgentRegistry,
} from "takosumi-contract";

export interface ProviderHandoffBridgeOptions {
  readonly registry: RuntimeAgentRegistry;
  readonly provider: string;
  /** Default priority for handed-off operations. */
  readonly priority?: number;
  readonly clock?: () => Date;
}

export interface ProviderHandoffEnqueueInput {
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly idempotencyKey?: string;
  readonly enqueuedAt?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Hook surface returned by the bridge. Each provider's `runtimeAgentHandoff`
 * hook is wired to {@link createProviderHandoff}.
 */
export interface ProviderRuntimeAgentHandoff {
  /** Returns the kernel work id assigned to the handoff. */
  enqueue(input: ProviderHandoffEnqueueInput): Promise<string>;
}

/**
 * Build a provider-shaped runtime-agent handoff hook backed by the kernel
 * registry. Long-running provider operations end up as work items the
 * remote agent will lease.
 */
export function createProviderHandoff(
  options: ProviderHandoffBridgeOptions,
): ProviderRuntimeAgentHandoff {
  const clock = options.clock ?? (() => new Date());
  return {
    async enqueue(input) {
      const enqueueInput: EnqueueLongRunningOperationInput = {
        provider: options.provider,
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        targetId: input.targetId,
        payload: input.payload ?? {},
        priority: options.priority,
        idempotencyKey: input.idempotencyKey,
        enqueuedAt: input.enqueuedAt ?? clock().toISOString(),
      };
      const work = await options.registry.enqueueLongRunningOperation(
        enqueueInput,
      );
      return work.id;
    },
  };
}

/**
 * Threshold helper used by provider runtime hooks to decide whether to hand
 * off. Returns `true` when `elapsedMs` exceeds the configured threshold.
 *
 * Default 30 000ms — anything longer than that should not block the kernel
 * inline.
 */
export function shouldHandoff(
  elapsedMs: number,
  thresholdMs = 30_000,
): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= thresholdMs;
}
