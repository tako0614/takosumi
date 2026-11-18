import { CAPSULE_RUN_PAGE_MAX, getRunWithOptions, listCapsuleRuns, type Run } from "./control-api.ts";

export const APPLY_RECOVERY_RUN_LIMIT = 200;
const APPLY_RECOVERY_TIMEOUT_MS = 5_000;

type ApplyPlan = Pick<Run, "id" | "type" | "capsuleId" | "workspaceId">;

/** Read-only reconciliation of one already-requested Apply. UI ownership is
 * supplied by each caller; no mutation or result status is inferred here. */
export async function recoverApplyRun(
  plan: ApplyPlan,
  options: { readonly signal?: AbortSignal; readonly isCurrent: () => boolean },
): Promise<Run | undefined> {
  const { id: planId, capsuleId, workspaceId } = plan;
  if (!options.isCurrent() || options.signal?.aborted || !planId ||
    !capsuleId || !workspaceId ||
    (plan.type !== "plan" && plan.type !== "destroy_plan")) return;
  const type = plan.type === "plan" ? "apply" : "destroy_apply";
  const controller = new AbortController();
  let abort!: () => void;
  const stopped = new Promise<undefined>((resolve) => {
    abort = () => { controller.abort(); resolve(undefined); };
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, APPLY_RECOVERY_TIMEOUT_MS);
  const read = async () => {
    const rows: Run[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < Math.ceil(APPLY_RECOVERY_RUN_LIMIT / CAPSULE_RUN_PAGE_MAX); pageIndex++) {
      if (!options.isCurrent() || controller.signal.aborted) return;
      const page = await listCapsuleRuns(capsuleId, {
        limit: CAPSULE_RUN_PAGE_MAX,
        types: [type],
        ...(cursor ? { cursor } : {}),
        signal: controller.signal,
        isCurrent: options.isCurrent,
      });
      if (!options.isCurrent() || controller.signal.aborted || page.runs.length > CAPSULE_RUN_PAGE_MAX) return;
      rows.push(...page.runs);
      if (!page.nextCursor) {
        const matches = rows.filter((candidate) =>
          typeof candidate.id === "string" && candidate.id !== "" &&
          candidate.id !== planId && candidate.type === type &&
          candidate.workspaceId === workspaceId &&
          candidate.capsuleId === capsuleId && candidate.planRunId === planId
        );
        if (matches.length !== 1) return;
        const candidate = matches[0]!;
        // History locates a candidate only. Re-evaluate current access and
        // exact lineage before either caller leaves its unconfirmed state.
        const current = await getRunWithOptions(candidate.id, { signal: controller.signal, cache: "no-store", isCurrent: options.isCurrent });
        if (!options.isCurrent() || controller.signal.aborted) return;
        return current?.id === candidate.id && current.type === type &&
            current.workspaceId === workspaceId &&
            current.capsuleId === capsuleId && current.planRunId === planId
          ? current : undefined;
      }
      if (page.nextCursor === cursor) return;
      cursor = page.nextCursor;
    }
  };
  try {
    // The shared five-second budget covers pages and the individual read,
    // including a fetch/body that does not cooperate with AbortSignal.
    return await Promise.race([read(), stopped]);
  } catch {
    // Failed, aborted, incomplete and ambiguous reads remain unconfirmed.
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
