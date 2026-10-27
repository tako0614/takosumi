/**
 * Presentation helpers for a plan's public resource changes (Run
 * `planResources`), shared by the Run review and any screen that lists the
 * same rows through components/run/PlanResourceList.tsx.
 *
 * Every row is classified once into an action kind; the badge tone, the
 * localized label and the optional by-action ordering all derive from it.
 */
import { t } from "../i18n/index.ts";
import type { Tone } from "../components/ui/Badge.tsx";
import type { RunPlanResource } from "./control-api.ts";

/** Rows shown before the list asks to expand. */
export const PLAN_RESOURCE_REVIEW_LIMIT = 25;

/** `replace` is a delete + create pair, in either order. */
export type PlanResourceActionKind =
  | "create"
  | "update"
  | "replace"
  | "delete"
  | "other";

/** Order used when a list groups rows by action. */
const ACTION_ORDER: readonly PlanResourceActionKind[] = [
  "create",
  "update",
  "replace",
  "delete",
  "other",
];

export function isActionablePlanResource(resource: RunPlanResource): boolean {
  return resource.actions.some((action) => action !== "no-op");
}

export function planResourceActionKind(
  resource: RunPlanResource,
): PlanResourceActionKind {
  const actions = resource.actions;
  if (actions.includes("delete") && actions.includes("create")) {
    return "replace";
  }
  if (actions.includes("delete")) return "delete";
  if (actions.includes("update")) return "update";
  if (actions.includes("create")) return "create";
  return "other";
}

export function planResourceTone(resource: RunPlanResource): Tone {
  switch (planResourceActionKind(resource)) {
    case "replace":
    case "delete":
      return "danger";
    case "update":
      return "warn";
    case "create":
      return "ok";
    case "other":
      return "muted";
  }
}

export function planResourceActionLabel(resource: RunPlanResource): string {
  switch (planResourceActionKind(resource)) {
    case "replace":
      return t("run.resources.actionReplace");
    case "delete":
      return t("run.resources.actionDelete");
    case "update":
      return t("run.resources.actionUpdate");
    case "create":
      return t("run.resources.actionCreate");
    case "other":
      return resource.actions.join(" / ") || t("common.unknown");
  }
}

export function planResourceScopeLabel(
  scope: RunPlanResource["scope"] | undefined,
): string | undefined {
  if (!scope) return undefined;
  const parts = Object.entries(scope.facts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, value]) => `${dimension}: ${String(value)}`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

/**
 * The name the app's definition gives one resource: the last address segment
 * (`cloudflare_d1_database.cache` → `cache`, `module.db.aws_db_instance.main[0]`
 * → `main[0]`). It tells two resources of the same kind apart.
 */
export function planResourceName(resource: Pick<RunPlanResource, "address" | "type">): string | undefined {
  const address = resource.address.trim();
  const typeAt = address.lastIndexOf(`${resource.type}.`);
  const name = typeAt >= 0
    ? address.slice(typeAt + resource.type.length + 1)
    : address.split(".").at(-1);
  return name && name !== resource.type ? name : undefined;
}

export function planResourceDisplayLabel(resource: RunPlanResource): string {
  const tail = resource.type.trim().split(".").at(-1) ?? resource.type;
  const words = tail
    .split("_")
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return resource.type || resource.address;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The actionable rows (no-op rows dropped), optionally ordered create →
 * update → replace → delete. Array sort is stable, so plan order holds within
 * each action.
 */
export function reviewablePlanResources(
  resources: readonly RunPlanResource[],
  options: { readonly sortByAction?: boolean } = {},
): readonly RunPlanResource[] {
  const actionable = resources.filter(isActionablePlanResource);
  if (!options.sortByAction) return actionable;
  const rank = (resource: RunPlanResource) =>
    ACTION_ORDER.indexOf(planResourceActionKind(resource));
  return actionable.sort((left, right) => rank(left) - rank(right));
}
