/**
 * Run cost read and display-state mapping behind the pre-apply cost summary
 * (components/run/CostSummary.tsx).
 *
 * Product rule: an unknown cost is shown as unknown, never as free. A failed
 * cost read therefore stays its own state instead of collapsing into "nothing
 * to show", and an unrated showback estimate (usage measured, no price policy)
 * stays distinct from a rated zero and from a workspace whose billing does not
 * apply. Every amount is the backend's plan-time value; nothing is computed
 * here.
 */
import { locale } from "../i18n/index.ts";
import type { RunCostInfo } from "./control-api.ts";

/** One Run cost read. A failure is kept as `unavailable`, never as "no cost". */
export type RunCostRead =
  | { readonly status: "loaded"; readonly cost: RunCostInfo }
  | { readonly status: "unavailable" };

/**
 * What the cost summary can honestly say about one read:
 * - `estimated`: a price policy rated the change with a positive estimate;
 * - `unrated`: usage is measured but no price policy rates it (unknown);
 * - `rated_zero`: a price policy rated the change at zero;
 * - `not_applicable`: workspace billing is disabled, so no estimate exists;
 * - `unavailable`: the cost read failed (unknown).
 * A host's `blocked` decision and its `reasons` stay on the loaded cost,
 * orthogonal to the kind.
 */
export type RunCostDisplayState =
  | {
      readonly kind: "estimated";
      readonly cost: RunCostInfo;
      readonly estimatedUsdMicros: number;
    }
  | { readonly kind: "unrated"; readonly cost: RunCostInfo }
  | { readonly kind: "rated_zero"; readonly cost: RunCostInfo }
  | { readonly kind: "not_applicable"; readonly cost: RunCostInfo }
  | { readonly kind: "unavailable" };

/** Reads a Run's cost without letting a failure pass as "no cost". */
export async function readRunCost(
  read: () => Promise<RunCostInfo>,
): Promise<RunCostRead> {
  try {
    return { status: "loaded", cost: await read() };
  } catch {
    // Best-effort: a failed read never breaks the deploy UI, but it surfaces
    // as an unknown cost instead of disappearing.
    return { status: "unavailable" };
  }
}

export function runCostDisplayState(read: RunCostRead): RunCostDisplayState {
  if (read.status === "unavailable") return { kind: "unavailable" };
  const cost = read.cost;
  if (cost.ratingStatus === "unrated") return { kind: "unrated", cost };
  if (cost.estimatedUsdMicros > 0) {
    return {
      kind: "estimated",
      cost,
      estimatedUsdMicros: cost.estimatedUsdMicros,
    };
  }
  if (cost.ratingStatus === "rated") return { kind: "rated_zero", cost };
  return { kind: "not_applicable", cost };
}

/**
 * True when the summary has something to say. Unknown costs (`unrated`,
 * `unavailable`) always do; a rated zero or a billing-disabled workspace has
 * no line of its own and only shows a host's blocked decision.
 */
export function runCostDisplayHasContent(state: RunCostDisplayState): boolean {
  switch (state.kind) {
    case "estimated":
    case "unrated":
    case "unavailable":
      return true;
    case "rated_zero":
    case "not_applicable":
      return state.cost.blocked;
  }
}

export function formatUsdMicros(value: number): string {
  return new Intl.NumberFormat(locale() === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value % 10_000 === 0 ? 2 : 6,
  }).format(value / 1_000_000);
}
