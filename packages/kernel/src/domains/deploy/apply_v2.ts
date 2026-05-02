import type {
  JsonObject,
  ManifestResource,
  PlatformContext,
  ResourceHandle,
} from "takosumi-contract";
import {
  type ResolvedResourceV2,
  resolveResourcesV2,
  type ResourceResolutionIssue,
} from "./resource_resolver_v2.ts";
import {
  buildRefDag,
  type RefResolutionIssue,
  resolveSpecRefs,
} from "./ref_resolver_v2.ts";

export interface ApplyV2Outcome {
  readonly applied: readonly AppliedResource[];
  readonly issues: readonly (ResourceResolutionIssue | RefResolutionIssue)[];
  readonly status: "succeeded" | "failed-validation" | "failed-apply";
  /**
   * When `dryRun` was passed, this lists the planned operations in DAG order.
   * Empty / undefined for non-dry-run runs.
   */
  readonly planned?: readonly PlannedResource[];
}

export interface AppliedResource {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly outputs: JsonObject;
}

/**
 * A resource that would be applied if the run were not dry. `op` is always
 * `"create"` for v0 (the apply pipeline does not yet do diffs vs. observed
 * state); future versions can expand to `"update"` / `"replace"` /
 * `"no-op"`.
 */
export interface PlannedResource {
  readonly name: string;
  readonly shape: string;
  readonly providerId: string;
  readonly op: "create";
}

export interface ApplyV2Options {
  readonly resources: readonly ManifestResource[];
  readonly context: PlatformContext;
  /**
   * When `true`, run validation + ref-DAG resolution but skip
   * `provider.apply` calls. The returned outcome's `planned` field lists the
   * resources that would be applied, in DAG order. Used by
   * `takosumi plan` to produce a structured plan without side effects.
   */
  readonly dryRun?: boolean;
}

export interface DestroyV2Options {
  readonly resources: readonly ManifestResource[];
  readonly context: PlatformContext;
  /**
   * Optional handle resolver. When the caller has prior `applyV2` outputs
   * (e.g. persisted from a real deployment), this hook lets `destroyV2`
   * pass the actual provider handle to `provider.destroy`. Without it,
   * `destroyV2` falls back to the resource name as the handle, which
   * matches the convention used by in-memory / filesystem providers in
   * the bundled plugin set.
   */
  readonly handleFor?: (resource: ManifestResource) => ResourceHandle;
}

export interface ResourceDestroyResult {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
}

export interface ResourceDestroyError {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly message: string;
}

export interface DestroyV2Outcome {
  readonly destroyed: readonly ResourceDestroyResult[];
  readonly errors: readonly ResourceDestroyError[];
  readonly issues: readonly (ResourceResolutionIssue | RefResolutionIssue)[];
  readonly status: "succeeded" | "failed-validation" | "partial";
}

export async function applyV2(
  options: ApplyV2Options,
): Promise<ApplyV2Outcome> {
  const { resources, context, dryRun = false } = options;

  const resolution = resolveResourcesV2(resources);
  if (resolution.issues.length > 0) {
    return {
      applied: [],
      issues: resolution.issues,
      status: "failed-validation",
    };
  }

  const dag = buildRefDag(resources);
  if (dag.issues.length > 0) {
    return {
      applied: [],
      issues: dag.issues,
      status: "failed-validation",
    };
  }

  const resourceByName = new Map<string, ResolvedResourceV2>();
  for (const r of resolution.resolved) resourceByName.set(r.resource.name, r);

  if (dryRun) {
    const planned: PlannedResource[] = [];
    for (const name of dag.order) {
      const item = resourceByName.get(name);
      if (!item) continue;
      planned.push({
        name,
        shape: item.resource.shape,
        providerId: item.provider.id,
        op: "create",
      });
    }
    return { applied: [], issues: [], status: "succeeded", planned };
  }

  const outputsByName = new Map<string, JsonObject>();
  const applied: AppliedResource[] = [];

  for (const name of dag.order) {
    const item = resourceByName.get(name);
    if (!item) continue;
    const resolvedSpec = resolveSpecRefs(item.resource.spec, {
      outputs: outputsByName,
    }) as JsonObject;
    try {
      const result = await item.provider.apply(resolvedSpec, context);
      outputsByName.set(name, result.outputs as JsonObject);
      applied.push({
        name,
        providerId: item.provider.id,
        handle: result.handle,
        outputs: result.outputs as JsonObject,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await rollback(applied, resourceByName, context);
      return {
        applied: [],
        issues: [{
          path: `$.resources[${name}]`,
          message: `apply failed: ${message}`,
        }],
        status: "failed-apply",
      };
    }
  }

  return { applied, issues: [], status: "succeeded" };
}

async function rollback(
  applied: readonly AppliedResource[],
  resourceByName: ReadonlyMap<string, ResolvedResourceV2>,
  context: PlatformContext,
): Promise<void> {
  for (const entry of [...applied].reverse()) {
    const item = resourceByName.get(entry.name);
    if (!item) continue;
    try {
      await item.provider.destroy(entry.handle, context);
    } catch {
      // best-effort rollback; surface no further error
    }
  }
}

/**
 * Destroy the resources declared by a manifest in reverse topological order
 * (leaves first, roots last) so that providers see their dependencies still
 * present at the moment they tear themselves down.
 *
 * Best-effort: per-resource failures are accumulated in `errors` rather than
 * aborting the whole pass. The final `status` is:
 *  - `succeeded` when every provider returned without throwing.
 *  - `partial`   when at least one provider threw.
 *  - `failed-validation` when the manifest itself was invalid (unknown
 *    shape / provider, cycle, malformed ref). In this case nothing is
 *    destroyed and `issues` carries the resolver diagnostics, mirroring
 *    `applyV2`.
 *
 * Provider handle resolution: the manifest does not carry the runtime handle
 * that `provider.apply` returned at deploy time. `destroyV2` therefore relies
 * on `handleFor(resource)` to map a resource back to its handle. The default
 * handle is the resource name, which matches the in-memory and filesystem
 * provider conventions used by the bundled plugin set; production callers
 * that persist deployment state should pass an explicit `handleFor` that
 * looks up the prior apply outputs.
 */
export async function destroyV2(
  options: DestroyV2Options,
): Promise<DestroyV2Outcome> {
  const { resources, context, handleFor } = options;

  const resolution = resolveResourcesV2(resources);
  if (resolution.issues.length > 0) {
    return {
      destroyed: [],
      errors: [],
      issues: resolution.issues,
      status: "failed-validation",
    };
  }

  const dag = buildRefDag(resources);
  if (dag.issues.length > 0) {
    return {
      destroyed: [],
      errors: [],
      issues: dag.issues,
      status: "failed-validation",
    };
  }

  const resourceByName = new Map<string, ResolvedResourceV2>();
  for (const r of resolution.resolved) resourceByName.set(r.resource.name, r);

  const reverseOrder = [...dag.order].reverse();
  const destroyed: ResourceDestroyResult[] = [];
  const errors: ResourceDestroyError[] = [];

  for (const name of reverseOrder) {
    const item = resourceByName.get(name);
    if (!item) continue;
    const handle: ResourceHandle = handleFor
      ? handleFor(item.resource)
      : item.resource.name;
    try {
      await item.provider.destroy(handle, context);
      destroyed.push({ name, providerId: item.provider.id, handle });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ name, providerId: item.provider.id, handle, message });
    }
  }

  return {
    destroyed,
    errors,
    issues: [],
    status: errors.length === 0 ? "succeeded" : "partial",
  };
}
