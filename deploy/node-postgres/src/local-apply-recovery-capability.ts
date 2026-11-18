/** Host-internal receipt capability; keeps Runner implementation out of the service image. */
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import type { DispatchStateScope } from "@takosumi/internal/deploy-control-api";

type Recovery = (
  input: { readonly runId: string; readonly stateScope: DispatchStateScope },
  consume: () => Promise<void>,
) => Promise<boolean>;
const committedRecoveries = new WeakMap<OpenTofuRunner, Recovery>();

/** Called only by the concrete local adapter with its encrypted store/ALS closure. */
export function registerCommittedLocalApplyRecovery(runner: OpenTofuRunner, recover: Recovery): void {
  committedRecoveries.set(runner, recover);
}

export async function withCommittedLocalApplyRecovery(
  runner: OpenTofuRunner | undefined,
  input: Parameters<Recovery>[0],
  consume: () => Promise<void>,
): Promise<boolean> {
  const recover = runner && committedRecoveries.get(runner);
  return recover ? await recover(input, consume) : false;
}
