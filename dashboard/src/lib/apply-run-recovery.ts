import { CAPSULE_RUN_PAGE_MAX, listCapsuleRuns, type Run } from "./control-api.ts";

export const APPLY_RECOVERY_RUN_LIMIT = 200;
const APPLY_RECOVERY_TIMEOUT_MS = 5_000;

type ApplyPlan = Pick<Run, "id" | "type" | "capsuleId" | "workspaceId">;

/** Read-only reconciliation of one already-requested Apply. UI ownership is
 * supplied by each caller; no mutation or result status is inferred here. */
export async function recoverApplyRun(
  plan: ApplyPlan,
  options: { readonly signal?: AbortSignal; readonly isCurrent: () => boolean },
): Promise<Run | undefined> {
  if (!options.isCurrent() || options.signal?.aborted || !plan.id ||
    !plan.capsuleId || !plan.workspaceId ||
    (plan.type !== "plan" && plan.type !== "destroy_plan")) return;
  const type = plan.type === "plan" ? "apply" : "destroy_apply";
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, APPLY_RECOVERY_TIMEOUT_MS);
  try {
    const rows: Run[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < Math.ceil(APPLY_RECOVERY_RUN_LIMIT / CAPSULE_RUN_PAGE_MAX); pageIndex++) {
      if (!options.isCurrent() || controller.signal.aborted) return;
      const page = await listCapsuleRuns(plan.capsuleId, {
        limit: CAPSULE_RUN_PAGE_MAX,
        types: [type],
        ...(cursor ? { cursor } : {}),
        signal: controller.signal,
      });
      if (!options.isCurrent() || controller.signal.aborted || page.runs.length > CAPSULE_RUN_PAGE_MAX) return;
      rows.push(...page.runs);
      if (!page.nextCursor) {
        const matches = rows.filter((candidate) =>
          typeof candidate.id === "string" && candidate.id !== "" &&
          candidate.id !== plan.id && candidate.type === type &&
          candidate.workspaceId === plan.workspaceId &&
          candidate.capsuleId === plan.capsuleId && candidate.planRunId === plan.id
        );
        return matches.length === 1 ? matches[0] : undefined;
      }
      if (page.nextCursor === cursor) return;
      cursor = page.nextCursor;
    }
  } catch {
    // Failed, aborted, incomplete and ambiguous reads remain unconfirmed.
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
