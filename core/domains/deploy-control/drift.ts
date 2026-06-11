/**
 * Drift classification helpers for the deploy-control domain.
 *
 * `classifyDriftResourceChanges` groups a drift `plan` JSON's resource changes
 * by resource type / provider / action and derives semantic tags and
 * remediation hints. These were lifted verbatim out of `mod.ts`; they take no
 * controller or store state and operate only over contract plan-change types.
 */

import type { JsonValue } from "takosumi-contract";
import type { PlanResourceChange } from "@takosumi/internal/deploy-control-api";

export function classifyDriftResourceChanges(
  changes: readonly PlanResourceChange[],
): {
  readonly resourceTypes: Readonly<Record<string, number>>;
  readonly providers: Readonly<Record<string, number>>;
  readonly actions: Readonly<Record<string, number>>;
  readonly remediationHints: readonly Readonly<Record<string, JsonValue>>[];
} {
  const resourceTypes: Record<string, number> = {};
  const providers: Record<string, number> = {};
  const actions: Record<string, number> = {};
  const semanticTags = new Set<string>();
  for (const change of changes) {
    if (change.actions.includes("no-op")) continue;
    const type = change.type.trim();
    if (type.length > 0) {
      resourceTypes[type] = (resourceTypes[type] ?? 0) + 1;
    }
    const provider = driftProviderForChange(change);
    if (provider) {
      providers[provider] = (providers[provider] ?? 0) + 1;
    }
    const actionKey = change.actions
      .map((action) => action.trim())
      .filter((action) => action.length > 0)
      .join("+");
    if (actionKey.length > 0) {
      actions[actionKey] = (actions[actionKey] ?? 0) + 1;
    }
    for (const tag of driftSemanticTags(provider, type, actionKey)) {
      semanticTags.add(tag);
    }
  }
  const sortedProviders = Object.fromEntries(Object.entries(providers).sort());
  const sortedActions = Object.fromEntries(Object.entries(actions).sort());
  return {
    resourceTypes: Object.fromEntries(Object.entries(resourceTypes).sort()),
    providers: sortedProviders,
    actions: sortedActions,
    remediationHints: driftRemediationHints({
      providers: sortedProviders,
      actions: sortedActions,
      semanticTags: [...semanticTags].sort(),
    }),
  };
}

function driftSemanticTags(
  provider: string | undefined,
  type: string,
  actionKey: string,
): string[] {
  const tags: string[] = [];
  if (actionKey.includes("delete")) tags.push("destructive");
  if (actionKey === "delete+create" || actionKey === "create+delete") {
    tags.push("replacement");
  }
  if (provider === "cloudflare") {
    tags.push("cloudflare");
    if (type === "cloudflare_dns_record") tags.push("cloudflare_dns");
    if (type.startsWith("cloudflare_workers_")) tags.push("cloudflare_workers");
    if (type === "cloudflare_r2_bucket") tags.push("cloudflare_storage");
  }
  if (provider === "aws") {
    tags.push("aws");
    if (type.startsWith("aws_s3_bucket")) tags.push("aws_storage");
  }
  if (provider === "random" || provider === "tls") {
    tags.push("local_material");
  }
  return tags;
}

function driftRemediationHints(input: {
  readonly providers: Readonly<Record<string, number>>;
  readonly actions: Readonly<Record<string, number>>;
  readonly semanticTags: readonly string[];
}): readonly Readonly<Record<string, JsonValue>>[] {
  const tags = new Set(input.semanticTags);
  const hints: Record<string, JsonValue>[] = [];
  if (tags.has("replacement")) {
    hints.push({
      code: "review_replacements",
      severity: "warning",
      category: "replacement",
      action: "create a reviewed update plan before applying remediation",
    });
  } else if (tags.has("destructive")) {
    hints.push({
      code: "review_deletes",
      severity: "warning",
      category: "destructive",
      action: "confirm deleted remote objects before planning remediation",
    });
  }
  if (tags.has("cloudflare_dns")) {
    hints.push({
      code: "cloudflare_dns_drift",
      severity: "info",
      provider: "cloudflare",
      category: "dns",
      action: "compare zone records against the last reviewed plan",
    });
  }
  if (tags.has("cloudflare_workers")) {
    hints.push({
      code: "cloudflare_workers_drift",
      severity: "info",
      provider: "cloudflare",
      category: "compute",
      action:
        "compare Worker script and route settings against the last reviewed plan",
    });
  }
  if (tags.has("cloudflare_storage")) {
    hints.push({
      code: "cloudflare_storage_drift",
      severity: "info",
      provider: "cloudflare",
      category: "storage",
      action: "compare R2 storage settings against the last reviewed plan",
    });
  }
  if (tags.has("aws_storage")) {
    hints.push({
      code: "aws_storage_drift",
      severity: "info",
      provider: "aws",
      category: "storage",
      action: "compare bucket configuration against the last reviewed plan",
    });
  }
  if (tags.has("local_material")) {
    hints.push({
      code: "local_material_drift",
      severity: "info",
      category: "local_material",
      action: "verify generated local material is expected before replacing it",
    });
  }
  if (hints.length === 0 && Object.keys(input.providers).length > 0) {
    hints.push({
      code: "provider_drift_detected",
      severity: "info",
      category: "provider",
      providers: Object.keys(input.providers),
      action: "create a reviewed update plan to reconcile provider drift",
    });
  } else if (hints.length === 0 && Object.keys(input.actions).length > 0) {
    hints.push({
      code: "drift_detected",
      severity: "info",
      category: "generic",
      action: "create a reviewed update plan to reconcile drift",
    });
  }
  return hints;
}

function driftProviderForChange(
  change: PlanResourceChange,
): string | undefined {
  const type = change.type.trim();
  if (type.startsWith("cloudflare_")) return "cloudflare";
  if (type.startsWith("aws_")) return "aws";
  if (type.startsWith("random_")) return "random";
  if (type.startsWith("tls_")) return "tls";
  if (
    change.scope?.cloudflareAccountId !== undefined ||
    change.scope?.cloudflareZoneId !== undefined
  ) {
    return "cloudflare";
  }
  if (
    change.scope?.awsAccountId !== undefined ||
    change.scope?.awsRegion !== undefined
  ) {
    return "aws";
  }
  return undefined;
}
