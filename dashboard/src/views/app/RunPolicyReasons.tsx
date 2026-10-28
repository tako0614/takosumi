/**
 * The structured policy reasons of one Run, read from the Run itself. Used
 * where the app page names a Run without carrying it (a policy-blocked
 * problem, an open review). While the Run is still planning it is read again
 * until its policy decision exists.
 */
import { createEffect, createResource, type JSX, onCleanup, Show } from "solid-js";
import { getRun } from "../../lib/control-api.ts";
import { createLastGoodValue } from "../../lib/resource-read.ts";
import PolicyReasonList from "../../components/run/PolicyReasonList.tsx";
import { t } from "../../i18n/index.ts";

const PLANNING_REREAD_MS = 4_000;

export default function RunPolicyReasons(props: {
  readonly runId: string;
  readonly capsuleId: string;
  /** Say so when the reasons could not be read (a problem card needs them). */
  readonly reportLoadFailure?: boolean;
}): JSX.Element {
  const [run, { refetch }] = createResource(
    () => props.runId,
    async (id) => {
      const value = await getRun(id);
      if (value.id !== id || value.capsuleId !== props.capsuleId) {
        throw new Error(t("installStore.recoveryUnverified"));
      }
      return value;
    },
  );
  const latest = createLastGoodValue(run, (value) => value.id === props.runId);
  createEffect(() => {
    const value = latest();
    if (!value || (value.status !== "queued" && value.status !== "running")) return;
    const timer = setTimeout(() => {
      if (!run.loading) void refetch();
    }, PLANNING_REREAD_MS);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <>
      <PolicyReasonList reasons={latest()?.policyReasons ?? []} />
      <Show when={props.reportLoadFailure && run.error && !latest()}>
        <p class="ap-muted" role="status">{t("app.problem.reasonsLoadFailed")}</p>
      </Show>
    </>
  );
}
