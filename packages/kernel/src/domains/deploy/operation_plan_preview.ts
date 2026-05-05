import { createHash } from "node:crypto";
import type { ManifestResource } from "takosumi-contract";
import type { DependencyEdge } from "./ref_resolver_v2.ts";
import type { PlannedResource } from "./apply_v2.ts";

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

export function buildOperationPlanPreview(input: {
  readonly resources: readonly ManifestResource[];
  readonly planned: readonly PlannedResource[];
  readonly edges: readonly DependencyEdge[];
  readonly spaceId: string;
  readonly deploymentName?: string;
}): OperationPlanPreview {
  const resourcesByName = new Map(
    input.resources.map((resource) => [resource.name, resource]),
  );
  const dependsByTarget = new Map<string, string[]>();
  for (const edge of input.edges) {
    const list = dependsByTarget.get(edge.target) ?? [];
    list.push(edge.source);
    dependsByTarget.set(edge.target, list);
  }

  const desiredSnapshotDigest = digest({
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

  const operationSeeds = input.planned.map((planned) => {
    const resource = resourcesByName.get(planned.name);
    const dependsOn = [...(dependsByTarget.get(planned.name) ?? [])].sort();
    const desiredDigest = digest({
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
  });

  const operationPlanDigest = digest({
    kind: PLAN_KIND,
    spaceId: input.spaceId,
    deploymentName: input.deploymentName,
    desiredSnapshotDigest,
    operations: operationSeeds,
  });

  const operations = operationSeeds.map((seed) => {
    const operationId = `operation:${
      digest({
        kind: "takosumi.public-operation-id@v1",
        operationPlanDigest,
        resourceName: seed.resourceName,
        desiredDigest: seed.desiredDigest,
      }).slice("sha256:".length)
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
  });

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

function digest(value: unknown): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(canonicalize(value)));
  return `sha256:${hash.digest("hex")}`;
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
