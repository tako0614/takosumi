// Resource Shape adapter port (`docs/internal/final-plan.md` §9 Adapter Contract).
//
// An adapter turns a resolved implementation plan into native resources on a
// Target. The opentofu-adapter (broad-first, §9/§17) drives the existing Flow A
// runner; a deterministic stub backs tests and self-host-without-runner. The
// service depends only on this port, so the runner wiring stays isolated.

import type {
  ActorContext,
  JsonObject,
  NativeResourceRef,
  ResourceDeletePolicy,
  TargetPoolEntry,
} from "takosumi-contract";
import type { ResourceShapePlan } from "./planner.ts";

/** Everything an adapter needs to preview/apply one resolved Resource Shape. */
export interface AdapterApplyInput {
  /** Canonical resource id (`tkrn:{space}:{kind}:{name}`). */
  readonly resourceId: string;
  readonly plan: ResourceShapePlan;
  /** The selected TargetPool entry the plan resolved to. */
  readonly target: TargetPoolEntry;
  /** ProviderConnection id injected into the runner for the opentofu-adapter. */
  readonly credentialRef?: string;
  /**
   * The native resources the Resolver expects to be created. The opentofu
   * adapter derives the actual set from the run/state and may ignore this; the
   * stub echoes it.
   */
  readonly nativeResources?: readonly NativeResourceRef[];
  /**
   * Optional operator-selected implementation plugin. The built-in opentofu
   * adapter may ignore it; plugin-aware adapters use this to dispatch the
   * selected implementation without hard-coding vendor breadth into core.
   */
  readonly implementationPlugin?: string;
  /** Plugin-local, non-secret configuration from TargetPoolImplementation. */
  readonly implementationOptions?: JsonObject;
  readonly actor: ActorContext;
}

export interface AdapterPreviewResult {
  /** Human-readable plan summary (e.g. "create 1 resource"). */
  readonly summary: string;
  readonly nativeResources: readonly NativeResourceRef[];
  /** Underlying Run id when the adapter previews through the runner. */
  readonly runId?: string;
}

export interface AdapterApplyResult {
  readonly nativeResources: readonly NativeResourceRef[];
  readonly outputs: JsonObject;
  readonly runId?: string;
}

export interface AdapterDeleteInput {
  readonly resourceId: string;
  /**
   * The same implementation plan used to create the resource. OpenTofu-backed
   * resources need it again for destroy because the backing Capsule is only a
   * state/identity anchor; the generated root remains the executable module.
   */
  readonly plan?: ResourceShapePlan;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly target: TargetPoolEntry;
  readonly credentialRef?: string;
  readonly implementationPlugin?: string;
  readonly implementationOptions?: JsonObject;
  readonly deletePolicy?: ResourceDeletePolicy;
  readonly actor: ActorContext;
}

/** The adapter contract (Phase 2 subset: preview / apply / delete). */
export interface ResourceAdapter {
  /** Stable adapter id, e.g. `opentofu` or `stub`. */
  readonly id: string;
  preview(input: AdapterApplyInput): Promise<AdapterPreviewResult>;
  apply(input: AdapterApplyInput): Promise<AdapterApplyResult>;
  delete(input: AdapterDeleteInput): Promise<void>;
}

/**
 * Deterministic adapter: it never touches a cloud. It echoes the resolved
 * native-resource plan and synthesizes outputs from the module's public output
 * names. Used by unit tests and as the self-host default before a runner is
 * configured.
 */
export class StubResourceShapeAdapter implements ResourceAdapter {
  readonly id = "stub";

  preview(input: AdapterApplyInput): Promise<AdapterPreviewResult> {
    const native = input.nativeResources ?? [];
    return Promise.resolve({
      summary:
        `create ${native.length} resource(s) ` +
        `via ${input.plan.templateId} on ${input.target.name}`,
      nativeResources: native,
    });
  }

  apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    const outputs: JsonObject = {};
    for (const name of input.plan.publicOutputs) {
      outputs[name] = `stub://${input.target.name}/${input.resourceId}/${name}`;
    }
    return Promise.resolve({
      nativeResources: input.nativeResources ?? [],
      outputs,
    });
  }

  delete(_input: AdapterDeleteInput): Promise<void> {
    return Promise.resolve();
  }
}
