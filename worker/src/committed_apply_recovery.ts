import type { TakosumiOperations } from "../../core/bootstrap.ts";
import type { RunDispatchControl } from "../../core/domains/deploy-control/mod.ts";
import type { CloudflareContainerOpenTofuRunner } from "./container_runner.ts";

type Operations = Pick<TakosumiOperations, "dispatchQueuedRun">;
const runners = new WeakMap<Operations, CloudflareContainerOpenTofuRunner>();
export function registerRunOwnerApplyReceiptReader(operations: Operations, runner: CloudflareContainerOpenTofuRunner): void {
  runners.set(operations, runner);
}
export function runOwnerApplyReceiptControl(operations: Operations, runId: string): Pick<RunDispatchControl, "committedApplyReceiptProbe"> {
  const runner = runners.get(operations);
  return runner ? { committedApplyReceiptProbe: runner.committedApplyReceiptProbe(runId) } : {};
}

/** Same private route used by the actual RunOwner, including its deadline. */
export function dispatchRunOwnerWithApplyReceipts(
  operations: Operations,
  dispatch: Parameters<Operations["dispatchQueuedRun"]>[0],
  control: RunDispatchControl = {},
): Promise<void> {
  return operations.dispatchQueuedRun(dispatch, { ...control,
    ...(dispatch.action === "apply" ? runOwnerApplyReceiptControl(operations, dispatch.runId) : {}),
  });
}
