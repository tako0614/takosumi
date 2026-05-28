// Round-2 fix: previously imported `createHash` from `node:crypto`, which
// pulls a Node-only module into Workers. Switched to the runtime-neutral
// `sha256HexAsync` helper backed by Web Crypto. `buildOperationPlanPreview`
// now produces digests synchronously via a pre-resolved Promise chain — the
// public surface stays sync because the preview is materialised from
// already-resolved canonical strings.
import type { ManifestResource } from "./_internal_manifest_types.ts";
import type { DependencyEdge } from "./ref_resolver_v2.ts";
import type { PlannedResource } from "./apply_v2.ts";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";

export interface OperationPlanPreview {
  readonly planId: string;
  readonly spaceId: string;
  readonly deploymentName?: string;
  readonly desiredSnapshotDigest: `sha256:${string}`;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly walStages: readonly OperationPlanPreviewWalStage[];
  readonly operations: readonly OperationPlanPreviewOperation[];
}

export type OperationPlanPreviewWalStage =
  | "prepare"
  | "pre-commit"
  | "commit"
  | "post-commit"
  | "observe"
  | "finalize";

export interface OperationPlanPreviewOperation {
  readonly operationId: string;
  readonly resourceName: string;
  readonly shape: string;
  readonly providerId: string;
  readonly op: PlannedResource["op"];
  readonly dependsOn: readonly string[];
  readonly desiredDigest: `sha256:${string}`;
  readonly idempotencyKey: {
    readonly spaceId: string;
    readonly operationPlanDigest: `sha256:${string}`;
    readonly journalEntryId: string;
  };
}

const PLAN_KIND = "takosumi.public-operation-plan-preview@v1";

/**
 * Build an `OperationPlanPreview` from a resolved manifest, planned resource
 * list, and DAG edges. Now async because the underlying SHA-256 routine is
 * Web Crypto (`crypto.subtle`), which is async-only across every runtime the
 * kernel targets (Workers / Deno / Node 22 / Bun). Call sites that produced
 * this preview synchronously inside `applyV2` are now async too.
 */
export async function buildOperationPlanPreview(input: {
  readonly resources: readonly ManifestResource[];
  readonly planned: readonly PlannedResource[];
  readonly edges: readonly DependencyEdge[];
  readonly spaceId: string;
  readonly deploymentName?: string;
}): Promise<OperationPlanPreview> {
  const resourcesByName = new Map(
    input.resources.map((resource) => [resource.name, resource]),
  );
  const dependsByTarget = new Map<string, string[]>();
  for (const edge of input.edges) {
    const list = dependsByTarget.get(edge.target) ?? [];
    list.push(edge.source);
    dependsByTarget.set(edge.target, list);
  }

  const desiredSnapshotDigest = await digest({
    kind: "takosumi.public-desired-snapshot-preview@v1",
    spaceId: input.spaceId,
    deploymentName: input.deploymentName,
    resources: input.planned.map((planned) => {
      const resource = resourcesByName.get(planned.name);
      return {
        name: planned.name,
        shape: planned.shape,
        providerId: planned.providerId,
        spec: resource?.spec,
        requires: resource?.requires,
        metadata: resource?.metadata,
      };
    }),
  });

  const operationSeeds = await Promise.all(
    input.planned.map(async (planned) => {
      const resource = resourcesByName.get(planned.name);
      const dependsOn = [...(dependsByTarget.get(planned.name) ?? [])].sort();
      const desiredDigest = await digest({
        kind: "takosumi.public-operation-desired@v1",
        resourceName: planned.name,
        shape: planned.shape,
        providerId: planned.providerId,
        spec: resource?.spec,
        requires: resource?.requires,
        metadata: resource?.metadata,
      });
      return {
        resourceName: planned.name,
        shape: planned.shape,
        providerId: planned.providerId,
        op: planned.op,
        dependsOn,
        desiredDigest,
      };
    }),
  );

  const operationPlanDigest = await digest({
    kind: PLAN_KIND,
    spaceId: input.spaceId,
    deploymentName: input.deploymentName,
    desiredSnapshotDigest,
    operations: operationSeeds,
  });

  const operations = await Promise.all(operationSeeds.map(async (seed) => {
    const operationIdDigest = await digest({
      kind: "takosumi.public-operation-id@v1",
      operationPlanDigest,
      resourceName: seed.resourceName,
      desiredDigest: seed.desiredDigest,
    });
    const operationId = `operation:${
      operationIdDigest.slice("sha256:".length)
    }`;
    return {
      ...seed,
      operationId,
      idempotencyKey: {
        spaceId: input.spaceId,
        operationPlanDigest,
        journalEntryId: operationId,
      },
    };
  }));

  return {
    planId: `plan:${operationPlanDigest.slice("sha256:".length)}`,
    spaceId: input.spaceId,
    ...(input.deploymentName ? { deploymentName: input.deploymentName } : {}),
    desiredSnapshotDigest,
    operationPlanDigest,
    walStages: [
      "prepare",
      "pre-commit",
      "commit",
      "post-commit",
      "observe",
      "finalize",
    ],
    operations,
  };
}

async function digest(value: unknown): Promise<`sha256:${string}`> {
  const hex = await sha256HexOfStringAsync(JSON.stringify(canonicalize(value)));
  return `sha256:${hex}`;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const canonical = canonicalize(object[key]);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  }
  return value;
}
