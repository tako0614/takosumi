import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import {
  getCapsule, getInstallConfig, listRuns, type Capsule, type InstallConfig,
} from "../../lib/control-api.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { createLastGoodValue } from "../../lib/resource-read.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { Button, Spinner } from "../../components/ui/index.ts";
import { t } from "../../i18n/index.ts";
import { capsuleInstallState, latestInstallRun, type InstallUiState } from "./install-lifecycle.ts";
import InstallExecution from "./InstallExecution.tsx";
import AppManagePage from "../app/AppManagePage.tsx";

/**
 * Server-backed restoration of an install attempt. A URL never authorizes
 * approval or Apply. Once the app is installed (or its uninstall is
 * scheduled) this shows the same app page the app has everywhere else.
 */
export default function InstallLifecycle(props: {
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly onIdentity: (capsule: Capsule, config: InstallConfig) => void;
  readonly onState: (state: InstallUiState) => void;
  readonly onLaunch?: (url: string | undefined) => void;
  readonly onChooseAnother: () => void;
  /** The install finished in this page view, not restored from a reload. */
  readonly justInstalled?: boolean;
}) {
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const key = () => JSON.stringify([props.workspaceId, props.capsuleId]);
  const [data, { refetch, mutate }] = createResource(key, async (identity) => {
    const [workspace, id] = JSON.parse(identity) as [string, string];
    const capsule = await getCapsule(id);
    if (capsule.id !== id || capsule.workspaceId !== workspace) throw new Error(t("installStore.recoveryUnverified"));
    const [config, runs] = await Promise.all([
      getInstallConfig(capsule.installConfigId),
      capsule.currentStateVersionId ? Promise.resolve([]) : listRuns(workspace, 100),
    ]);
    if (config.id !== capsule.installConfigId || (config.workspaceId && config.workspaceId !== workspace)) throw new Error(t("installStore.recoveryUnverified"));
    return { capsule, config, run: latestInstallRun(capsule, runs) };
  });
  const latest = createLastGoodValue(data, (value) => value.capsule.id === props.capsuleId && value.capsule.workspaceId === props.workspaceId);
  const [executionState, setExecutionState] = createSignal<InstallUiState>();
  createEffect(() => { key(); setExecutionState(undefined); });
  const state = (): InstallUiState => {
    const value = latest();
    if (!value) return "configuring";
    const actual = capsuleInstallState(value.capsule, value.run);
    return actual === "installing" || actual === "failed" ? executionState() ?? actual : actual;
  };
  createEffect(() => {
    const value = latest();
    if (value) props.onIdentity(value.capsule, value.config);
    props.onState(state());
  });
  // The app handoff needs the launch URL; the app page renders its own Open.
  const [surfaces] = createResource(
    () => state() === "installed" && props.onLaunch ? key() : false,
    async (identity) => ({ identity, values: await listAuthorizedUiSurfaces(props.workspaceId, { capsuleId: props.capsuleId }) }),
  );
  const launchUrl = () => state() !== "installed" || data.error || surfaces.error || latest()?.capsule.status === "disabled" || surfaces.latest?.identity !== key()
    ? undefined : surfaces.latest?.values[0]?.url;
  createEffect(() => props.onLaunch?.(launchUrl()));
  const clearCaches = () => {
    clearCapsuleListCache(props.workspaceId);
    clearCurrentStateVersionCache(props.workspaceId);
    clearDashboardOverviewCache(props.workspaceId);
  };
  // An unfinished install keeps its state current; the app page keeps itself
  // current once the app is installed.
  let reading = false;
  createEffect(() => {
    const identity = key();
    const current = state();
    if (current === "not-installed" || current === "installed" || current === "uninstalling") return;
    const timer = setInterval(async () => {
      if (reading || data.loading || !latest() || document.hidden) return;
      reading = true;
      try {
        const capsule = await getCapsule(props.capsuleId);
        if (!disposed && identity === key() && capsule.id === props.capsuleId && capsule.workspaceId === props.workspaceId) mutate((value) => value ? { ...value, capsule } : value);
      } catch { /* Preserve last good state; explicit refresh reports errors. */ }
      finally { reading = false; }
    }, 30_000);
    onCleanup(() => clearInterval(timer));
  });
  const managed = () => state() === "installed" || state() === "uninstalling";
  return <section class="iv-lifecycle" classList={{ "iv-workbench": !managed() }} data-testid="install-lifecycle" data-install-state={state()}>
    <Show when={data.loading && !latest()}><div role="status"><Spinner size={24} /><p>{t("common.loading")}</p></div></Show>
    <Show when={data.error}>
      <p role="alert">{friendlyError(data.error, t).message}</p>
      <div class="iv-action-row">
        <Button type="button" variant="secondary" onClick={() => void refetch()}>{t("common.retry")}</Button>
        <Button type="button" variant="ghost" onClick={props.onChooseAnother}>{t("installStore.chooseAnother")}</Button>
        <Button variant="ghost" href="/">{t("installStore.viewApps")}</Button>
      </div>
    </Show>
    <Show when={latest()}>{(value) => <>
      <Show when={managed()}>
        <AppManagePage capsuleId={props.capsuleId} principalId={props.principalId} justInstalled={props.justInstalled} />
      </Show>
      <Show when={state() === "not-installed"}><h2>{t("installStore.uninstalled")}</h2><Button type="button" variant="secondary" onClick={props.onChooseAnother}>{t("installStore.chooseAnother")}</Button></Show>
      <Show when={!managed() && state() !== "not-installed"}>
        <Show when={value().run} fallback={<p>{t("installStore.recoveryUnverifiedHint")}</p>}>{(run) =>
          <InstallExecution planRunId={run().planRunId ?? run().id} initialRunId={run().id} capsuleId={props.capsuleId}
            onState={setExecutionState} onDone={() => { clearCaches(); void refetch(); }} />
        }</Show>
        <Button variant="ghost" href={`/workloads/${encodeURIComponent(props.capsuleId)}`}>{t("installStore.manageApp")}</Button>
      </Show>
    </>}</Show>
  </section>;
}
