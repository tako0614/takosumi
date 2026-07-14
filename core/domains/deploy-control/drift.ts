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
    const provider = change.providerSource?.trim();
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
    for (const tag of driftSemanticTags(actionKey)) {
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
  actionKey: string,
): string[] {
  const tags: string[] = [];
  if (actionKey.includes("delete")) tags.push("destructive");
  if (actionKey === "delete+create" || actionKey === "create+delete") {
    tags.push("replacement");
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
