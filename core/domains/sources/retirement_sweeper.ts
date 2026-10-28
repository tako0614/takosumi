import type { OpenTofuControlStore, StoredSource } from "../deploy-control/store.ts";
import type { GitInstallPlanStore, StoredGitInstallPlan } from "../install-plans/store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

export interface SourceRetirementSweepResult {
  readonly scanned: number;
  readonly attempted: number;
  readonly retired: number;
  readonly deferred: number;
  readonly failures: number;
}

export interface SourceRetirementSweepDependencies {
  readonly store: Pick<OpenTofuControlStore, "listAllSourcesPage" | "getCapsule">;
  readonly plans: Pick<GitInstallPlanStore, "get" | "hasNonterminalPlanSourceReference">;
  readonly retireOwnedSource: (sourceId: string, reason: string) => Promise<"retired" | "already_retired" | "deferred">;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, sourceId: string) => void;
}

/**
 * Daily retry owner for Sources left after a terminal app lifecycle. Reads
 * across all Workspaces, including archived ones. Candidate selection is
 * advisory: retirement itself rechecks Capsule/Run references atomically.
 */
export async function sweepRetiredSources(
  deps: SourceRetirementSweepDependencies,
  options: { readonly limit?: number } = {},
): Promise<SourceRetirementSweepResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const now = (deps.now ?? (() => new Date()))().getTime();
  let cursor: string | undefined;
  let scanned = 0;
  const candidates: { readonly source: StoredSource; readonly reason: string }[] = [];
  let attempted = 0;
  let retired = 0;
  let deferred = 0;
  let failures = 0;
  do {
    const page = await deps.store.listAllSourcesPage({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    for (const source of page.items) {
      scanned++;
      const reason = await retirementReason(source, deps, now);
      if (!reason) continue;
      candidates.push({ source, reason });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  // A deterministic daily rotation gives every stable candidate a turn even
  // when the oldest rows fail or remain deferred. At most `limit` retirement
  // calls are made on any tick.
  const start = candidates.length === 0
    ? 0
    : (Math.floor(now / DAY_MS) * limit) % candidates.length;
  for (let offset = 0; offset < Math.min(limit, candidates.length); offset++) {
    const { source, reason } = candidates[(start + offset) % candidates.length]!;
    attempted++;
    try {
      const result = await deps.retireOwnedSource(source.id, reason);
      if (result === "deferred") deferred++;
      else retired++;
    } catch (error) {
      failures++;
      deps.onError?.(error, source.id);
    }
  }
  return { scanned, attempted, retired, deferred, failures };
}

async function retirementReason(
  source: StoredSource,
  deps: SourceRetirementSweepDependencies,
  now: number,
): Promise<string | undefined> {
  const expiredBefore = new Date(now - DAY_MS).toISOString();
  if (await deps.plans.hasNonterminalPlanSourceReference(
    source.workspaceId, source.id, expiredBefore,
  )) return undefined;
  if (source.retiringAt) return "retry pending source retirement";
  if (source.ownerCapsuleId) {
    const owner = await deps.store.getCapsule(source.ownerCapsuleId);
    if (owner?.status === "destroyed") return "owner capsule destroyed";
    if (owner) return undefined;
  }
  const plan: StoredGitInstallPlan | undefined = source.createdByInstallPlanId
    ? await deps.plans.get(source.createdByInstallPlanId)
    : undefined;
  if (plan && plan.workspaceId === source.workspaceId) {
    if (plan.phase === "discarded") return "install attempt discarded";
    if (plan.phase === "failed" && plan.mode !== "attempt") {
      return "install plan failed";
    }
    if (
      plan.expiresAt &&
      Date.parse(plan.expiresAt) + DAY_MS <= now &&
      plan.phase !== "reviewable"
    ) return "install attempt expired past grace";
    // A live coordinator still owns the Source even if its Capsule is absent.
    return undefined;
  }
  if (Date.parse(source.createdAt) + DAY_MS <= now) {
    return "unowned source unreferenced past grace";
  }
  return undefined;
}
