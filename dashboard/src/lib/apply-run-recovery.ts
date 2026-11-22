import { getRunWithOptions, listPlanApplyRuns, type ApplyReviewRun, type Run } from "./control-api.ts";

const APPLY_RECOVERY_TIMEOUT_MS = 5_000;

/** Read-only reconciliation of one already-requested Apply. UI ownership is
 * supplied by each caller; no mutation or result status is inferred here. */
export async function recoverApplyRun(
  plan: ApplyReviewRun,
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
    const matches = await listPlanApplyRuns(plan, {
      signal: controller.signal,
      isCurrent: options.isCurrent,
    });
    if (!options.isCurrent() || controller.signal.aborted || matches.length !== 1) return;
    const candidate = matches[0]!;
    // History locates a candidate only. Re-evaluate current access and
    // exact lineage before either caller leaves its unconfirmed state.
    const current = await getRunWithOptions(candidate.id, { signal: controller.signal, cache: "no-store", isCurrent: options.isCurrent });
    if (!options.isCurrent() || controller.signal.aborted) return;
    return current?.id === candidate.id && current.type === type &&
        current.workspaceId === workspaceId && current.capsuleId === capsuleId && current.planRunId === planId
      ? current : undefined;
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
