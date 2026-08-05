import type { Capsule } from "@takosumi/internal/deploy-control-api";
import {
  parseResourceShapeKind,
  TAKOSUMI_API_VERSION,
  type ResourcePhase,
  type ResourcePortability,
} from "takosumi-contract";
import type { PublicCapsule } from "takosumi-contract/capsules";
import { publicCapsule } from "../deploy-control/mod.ts";
import { normalizeCapsuleRecord } from "../deploy-control/store_row_mappers.ts";
import type { WorkspaceResourceSummary } from "./service.ts";

export interface WorkspaceResourceProjectionRow
  extends Record<string, unknown> {
  readonly id: string;
  readonly space_id: string;
  readonly project: string | null;
  readonly environment: string | null;
  readonly kind: string;
  readonly name: string;
  readonly managed_by: string;
  readonly phase: string;
  readonly observed_generation: number | string;
  readonly labels_json: unknown;
  readonly created_at: string;
  readonly resolution_resource_id: string | null;
  readonly selected_implementation: string | null;
  readonly target: string | null;
  readonly locked: boolean | number | null;
  readonly portability: string | null;
}

export interface WorkspaceCapsuleProjectionRow extends Record<string, unknown> {
  readonly record_json: unknown;
}

const RESOURCE_PHASES = new Set<ResourcePhase>([
  "Pending",
  "Resolving",
  "Planning",
  "Applying",
  "Ready",
  "Degraded",
  "Failed",
  "Deleting",
  "Deleted",
]);

const RESOURCE_PORTABILITY = new Set<ResourcePortability>([
  "portable",
  "mostly_portable",
  "partial",
  "locked_in",
]);

export function projectWorkspaceResourceRow(
  row: WorkspaceResourceProjectionRow,
): WorkspaceResourceSummary {
  const phase = row.phase as ResourcePhase;
  if (!RESOURCE_PHASES.has(phase)) {
    throw new TypeError(`invalid durable Resource phase ${row.phase}`);
  }
  const observedGeneration = Number(row.observed_generation);
  if (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0) {
    throw new TypeError(
      `invalid durable Resource observedGeneration ${String(row.observed_generation)}`,
    );
  }
  const labels = parseLabels(row.labels_json);
  if (
    row.resolution_resource_id !== null &&
    typeof row.resolution_resource_id !== "string"
  ) {
    throw new TypeError("invalid durable Resource resolution identity");
  }
  const hasResolution = typeof row.resolution_resource_id === "string";
  let portability: ResourcePortability = "partial";
  if (hasResolution && row.portability !== null) {
    if (!RESOURCE_PORTABILITY.has(row.portability as ResourcePortability)) {
      throw new TypeError(
        `invalid durable Resource portability ${row.portability}`,
      );
    }
    portability = row.portability as ResourcePortability;
  }
  if (
    hasResolution &&
    (row.selected_implementation === null || row.target === null)
  ) {
    throw new TypeError("incomplete durable Resource resolution projection");
  }
  if (
    hasResolution &&
    row.locked !== true &&
    row.locked !== false &&
    row.locked !== 1 &&
    row.locked !== 0
  ) {
    throw new TypeError("invalid durable Resource resolution lock state");
  }
  return {
    id: row.id,
    apiVersion: TAKOSUMI_API_VERSION,
    kind: parseResourceShapeKind(row.kind),
    metadata: {
      name: row.name,
      space: row.space_id,
      ...(row.project === null ? {} : { project: row.project }),
      ...(row.environment === null ? {} : { environment: row.environment }),
      ...(labels === undefined ? {} : { labels }),
      managedBy: row.managed_by,
    },
    status: {
      phase,
      observedGeneration,
      ...(hasResolution
        ? {
            resolution: {
              selectedImplementation: row.selected_implementation!,
              target: row.target!,
              locked: row.locked === true || row.locked === 1,
              portability,
            },
          }
        : {}),
    },
  };
}

export function projectWorkspaceCapsuleRow(
  row: WorkspaceCapsuleProjectionRow,
  workspaceId: string,
): PublicCapsule {
  const parsed = parseJson(row.record_json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("invalid durable Capsule projection");
  }
  const capsule = normalizeCapsuleRecord(parsed as Capsule);
  if (
    typeof capsule.id !== "string" ||
    typeof capsule.createdAt !== "string" ||
    capsule.workspaceId !== workspaceId ||
    capsule.status === "destroyed"
  ) {
    throw new TypeError("invalid durable Capsule workspace projection");
  }
  return publicCapsule(capsule);
}

function parseLabels(value: unknown): Readonly<Record<string, string>> | undefined {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined) return undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("invalid durable Resource labels");
  }
  const labels = Object.entries(parsed).map(([key, label]) => {
    if (typeof label !== "string") {
      throw new TypeError("invalid durable Resource label value");
    }
    return [key, label] as const;
  });
  return Object.fromEntries(labels);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "") return null;
  return JSON.parse(value);
}
