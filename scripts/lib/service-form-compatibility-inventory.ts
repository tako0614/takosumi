import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SERVICE_FORM_COMPATIBILITY_INVENTORY_KIND =
  "takosumi.service-form-compatibility-inventory@v1" as const;

const LEGACY_FORM_RESOURCE_TYPES = new Set([
  "takosumi_container_service",
  "takosumi_durable_workflow",
  "takosumi_edge_worker",
  "takosumi_kv_store",
  "takosumi_object_bucket",
  "takosumi_queue",
  "takosumi_schedule",
  "takosumi_sql_database",
  "takosumi_stateful_actor_namespace",
  "takosumi_vector_index",
]);

const TAKOSUMI_ADMIN_RESOURCE_TYPES = new Set(["takosumi_target_pool"]);

export type CompatibilityResourceClass =
  "legacy_form" | "portable_form" | "takosumi_admin" | "unknown_takosumi";

export interface CompatibilityResourceUsage {
  readonly providerAddress: string | null;
  readonly mode: "managed" | "data";
  readonly resourceType: string;
  readonly resourceClass: CompatibilityResourceClass;
  readonly instanceCount: number;
}

export interface ProviderLockUsage {
  readonly providerAddress: string;
  readonly version: string | null;
  readonly constraints: string | null;
  readonly hashes: readonly string[];
}

export interface CompatibilityInventorySource {
  readonly kind: "terraform_state" | "dependency_lock";
  readonly sha256: string;
}

export interface ServiceFormCompatibilityInventory {
  readonly kind: typeof SERVICE_FORM_COMPATIBILITY_INVENTORY_KIND;
  readonly sources: readonly CompatibilityInventorySource[];
  readonly summary: {
    readonly terraformStateCount: number;
    readonly dependencyLockCount: number;
    readonly relevantResourceCount: number;
    readonly relevantInstanceCount: number;
    readonly otherResourceCount: number;
    readonly otherProviderLockCount: number;
  };
  readonly resources: readonly CompatibilityResourceUsage[];
  readonly providerLocks: readonly ProviderLockUsage[];
  readonly removalDecision: {
    readonly eligible: false;
    readonly missingEvidence: readonly [
      "external_usage_observation_window",
      "announced_minimum_support_window",
      "no_op_state_migration_fixtures",
      "rollback_artifacts",
    ];
  };
}

export interface CompatibilityInventoryInput {
  readonly kind: CompatibilityInventorySource["kind"];
  readonly bytes: Uint8Array;
}

interface TerraformStateResource {
  readonly mode?: unknown;
  readonly type?: unknown;
  readonly provider?: unknown;
  readonly instances?: unknown;
}

/**
 * Produces a redacted compatibility inventory. Resource attributes, state
 * values, provider configuration, serials, lineage, and local paths are never
 * copied into the result.
 */
export function buildServiceFormCompatibilityInventory(
  inputs: readonly CompatibilityInventoryInput[],
): ServiceFormCompatibilityInventory {
  if (inputs.length === 0) {
    throw new TypeError(
      "at least one state or dependency-lock input is required",
    );
  }

  const sources: CompatibilityInventorySource[] = [];
  const resources: CompatibilityResourceUsage[] = [];
  const providerLocks: ProviderLockUsage[] = [];
  let terraformStateCount = 0;
  let dependencyLockCount = 0;
  let otherResourceCount = 0;
  let otherProviderLockCount = 0;

  for (const input of inputs) {
    const sha256 = digest(input.bytes);
    sources.push({ kind: input.kind, sha256 });
    const text = new TextDecoder().decode(input.bytes);

    if (input.kind === "terraform_state") {
      terraformStateCount += 1;
      const parsed = parseJsonRecord(text, "Terraform/OpenTofu state");
      const stateResources = Array.isArray(parsed.resources)
        ? parsed.resources
        : [];
      for (const entry of stateResources) {
        if (!isRecord(entry)) continue;
        const resource = entry as TerraformStateResource;
        if (typeof resource.type !== "string") continue;
        const resourceClass = classifyResourceType(resource.type);
        if (!resourceClass) {
          otherResourceCount += 1;
          continue;
        }
        resources.push({
          providerAddress:
            typeof resource.provider === "string"
              ? parseStateProviderAddress(resource.provider)
              : null,
          mode: resource.mode === "data" ? "data" : "managed",
          resourceType: resource.type,
          resourceClass,
          instanceCount: Array.isArray(resource.instances)
            ? resource.instances.length
            : 0,
        });
      }
      continue;
    }

    dependencyLockCount += 1;
    for (const provider of parseDependencyLock(text)) {
      if (isCompatibilityProviderAddress(provider.providerAddress)) {
        providerLocks.push(provider);
      } else {
        otherProviderLockCount += 1;
      }
    }
  }

  return {
    kind: SERVICE_FORM_COMPATIBILITY_INVENTORY_KIND,
    sources: sources.sort(compareSources),
    summary: {
      terraformStateCount,
      dependencyLockCount,
      relevantResourceCount: resources.length,
      relevantInstanceCount: resources.reduce(
        (sum, resource) => sum + resource.instanceCount,
        0,
      ),
      otherResourceCount,
      otherProviderLockCount,
    },
    resources: resources.sort(compareResources),
    providerLocks: providerLocks.sort((left, right) =>
      left.providerAddress.localeCompare(right.providerAddress),
    ),
    removalDecision: {
      eligible: false,
      missingEvidence: [
        "external_usage_observation_window",
        "announced_minimum_support_window",
        "no_op_state_migration_fixtures",
        "rollback_artifacts",
      ],
    },
  };
}

export async function readCompatibilityInventoryInputs(input: {
  readonly statePaths: readonly string[];
  readonly lockPaths: readonly string[];
}): Promise<readonly CompatibilityInventoryInput[]> {
  const out: CompatibilityInventoryInput[] = [];
  for (const path of input.statePaths) {
    out.push({ kind: "terraform_state", bytes: await readFile(path) });
  }
  for (const path of input.lockPaths) {
    out.push({ kind: "dependency_lock", bytes: await readFile(path) });
  }
  return out;
}

export function stableCompatibilityInventoryJson(
  inventory: ServiceFormCompatibilityInventory,
): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function parseStateProviderAddress(value: string): string | null {
  const match = /provider\["([^"]+)"\](?:\.[A-Za-z0-9_-]+)?$/u.exec(value);
  if (match) return match[1] ?? null;
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes("[") ? trimmed : null;
}

function classifyResourceType(
  resourceType: string,
): CompatibilityResourceClass | undefined {
  if (LEGACY_FORM_RESOURCE_TYPES.has(resourceType)) return "legacy_form";
  if (TAKOSUMI_ADMIN_RESOURCE_TYPES.has(resourceType)) return "takosumi_admin";
  if (resourceType.startsWith("takoform_")) return "portable_form";
  if (resourceType.startsWith("takosumi_")) return "unknown_takosumi";
  return undefined;
}

function isCompatibilityProviderAddress(address: string): boolean {
  const providerName = address.split("/").at(-1);
  return providerName === "takosumi" || providerName === "takoform";
}

function parseDependencyLock(text: string): readonly ProviderLockUsage[] {
  const out: ProviderLockUsage[] = [];
  const pattern = /^provider\s+"([^"]+)"\s*\{([\s\S]*?)^\}/gmu;
  for (const match of text.matchAll(pattern)) {
    const providerAddress = match[1];
    const body = match[2];
    if (!providerAddress || body === undefined) continue;
    out.push({
      providerAddress,
      version: readLockString(body, "version"),
      constraints: readLockString(body, "constraints"),
      hashes: readLockHashes(body),
    });
  }
  return out;
}

function readLockString(body: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "mu").exec(body);
  return match?.[1] ?? null;
}

function readLockHashes(body: string): readonly string[] {
  const block = /^\s*hashes\s*=\s*\[([\s\S]*?)^\s*\]/mu.exec(body)?.[1];
  if (!block) return [];
  return [...block.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .sort();
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    // Do not retain the parser error as a cause: runtimes may include a source
    // excerpt in that error, and state values must never reach CLI diagnostics.
    throw new TypeError(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareSources(
  left: CompatibilityInventorySource,
  right: CompatibilityInventorySource,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.sha256.localeCompare(right.sha256)
  );
}

function compareResources(
  left: CompatibilityResourceUsage,
  right: CompatibilityResourceUsage,
): number {
  return (
    left.resourceType.localeCompare(right.resourceType) ||
    (left.providerAddress ?? "").localeCompare(right.providerAddress ?? "") ||
    left.mode.localeCompare(right.mode)
  );
}
