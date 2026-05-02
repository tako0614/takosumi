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
}

export interface AppliedResource {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly outputs: JsonObject;
}

export interface ApplyV2Options {
  readonly resources: readonly ManifestResource[];
  readonly context: PlatformContext;
}

export async function applyV2(
  options: ApplyV2Options,
): Promise<ApplyV2Outcome> {
  const { resources, context } = options;

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
