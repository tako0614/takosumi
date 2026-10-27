import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { ExternalLink, PlugZap } from "lucide-solid";
import {
  cancelCapsuleUninstall, deleteCapsule, getCapsule, getInstallConfig,
  getWorkspaceGraph, listRuns, type Capsule, type InstallConfig,
} from "../../lib/control-api.ts";
import {
  capsuleUninstallBanner, capsuleUninstallDependencyWarning,
  uninstallCancellable, uninstallDependencyReadWarning,
} from "../../lib/capsule-uninstall.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { createLastGoodValue } from "../../lib/resource-read.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { Button, Spinner } from "../../components/ui/index.ts";
import { t } from "../../i18n/index.ts";
import { capsuleInstallState, latestInstallRun, type InstallUiState } from "./install-lifecycle.ts";
import InstallExecution from "./InstallExecution.tsx";

/** Server-backed restoration. A URL never authorizes approval or Apply. */
export default function InstallLifecycle(props: {
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly onIdentity: (capsule: Capsule, config: InstallConfig) => void;
  readonly onState: (state: InstallUiState) => void;
  readonly onLaunch?: (url: string | undefined) => void;
  readonly connectionsOpen?: boolean;
  readonly onConnect: () => void;
  readonly onChooseAnother: () => void;
}) {
  const { confirm } = useConfirmDialog();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const key = () => JSON.stringify([props.workspaceId, props.capsuleId]);
  const [data, { refetch, mutate }] = createResource(key, async (identity) => {
    const [workspace, id] = JSON.parse(identity) as [string, string];
    const capsule = await getCapsule(id);
    if (capsule.id !== id || capsule.workspaceId !== workspace) throw new Error(t("installStore.recoveryUnverified"));
    const [config, runs] = await Promise.all([
      getInstallConfig(capsule.installConfigId),
      capsule.currentStateVersionId && capsule.status !== "error" ? Promise.resolve([])
        : capsule.currentStateVersionId ? listRuns(workspace, 100).catch(() => []) : listRuns(workspace, 100),
    ]);
    if (config.id !== capsule.installConfigId || (config.workspaceId && config.workspaceId !== workspace)) throw new Error(t("installStore.recoveryUnverified"));
    return { capsule, config, run: latestInstallRun(capsule, runs) };
  });
  const latest = createLastGoodValue(data, (value) => value.capsule.id === props.capsuleId && value.capsule.workspaceId === props.workspaceId);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [executionState, setExecutionState] = createSignal<InstallUiState>();
  createEffect(() => { key(); setExecutionState(undefined); setError(undefined); setBusy(false); });
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
  const [surfaces, { refetch: refetchSurfaces }] = createResource(
    () => state() === "installed" ? key() : false,
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
  let reading = false;
  createEffect(() => {
    const identity = key();
    if (state() === "not-installed") return;
    const timer = setInterval(async () => {
      if (reading || data.loading || !latest() || document.hidden) return;
      reading = true;
      try {
        const capsule = await getCapsule(props.capsuleId);
        if (!disposed && identity === key() && capsule.id === props.capsuleId && capsule.workspaceId === props.workspaceId) mutate((value) => value ? { ...value, capsule } : value);
      } catch { /* Preserve last good state; explicit refresh reports errors. */ }
      finally { reading = false; }
    }, state() === "uninstalling" ? 5_000 : 30_000);
    onCleanup(() => clearInterval(timer));
  });
  const uninstall = async () => {
    const value = latest();
    if (!value || busy()) return;
    const identity = key();
    setBusy(true); setError(undefined);
    try {
      let warning: string | undefined;
      try {
        const graph = await getWorkspaceGraph(props.workspaceId);
        const names = new Map(graph.nodes.map((node) => [node.capsuleId, node.name]));
        warning = capsuleUninstallDependencyWarning(value.capsule.name, graph.edges
          .filter((edge) => edge.producerCapsuleId === value.capsule.id)
          .map((edge) => names.get(edge.consumerCapsuleId) ?? edge.consumerCapsuleId));
      } catch { warning = uninstallDependencyReadWarning("failed"); }
      if (disposed || identity !== key()) return;
      const accepted = await confirm({
        title: t("app.uninstall.confirmTitle"),
        message: [t("app.uninstall.confirmMessage", { name: value.capsule.name }), warning].filter(Boolean).join("\n\n"),
        confirmText: t("app.uninstall.cta"), cancelText: t("common.cancel"), danger: true,
      });
      if (!accepted || disposed || identity !== key()) return;
      await deleteCapsule(value.capsule.id);
      if (!disposed && identity === key()) { clearCaches(); await refetch(); }
    } catch (cause) { if (!disposed && identity === key()) setError(friendlyError(cause, t).message); }
    finally { if (!disposed && identity === key()) setBusy(false); }
  };
  const undoUninstall = async () => {
    if (busy() || !latest() || !uninstallCancellable(latest()!.capsule)) return;
    const identity = key(); setBusy(true); setError(undefined);
    try { await cancelCapsuleUninstall(props.capsuleId); if (!disposed && identity === key()) { clearCaches(); await refetch(); } }
    catch (cause) { if (!disposed && identity === key()) setError(friendlyError(cause, t).message); }
    finally { if (!disposed && identity === key()) setBusy(false); }
  };
  return <section class="iv-workbench iv-lifecycle" data-testid="install-lifecycle" data-install-state={state()}>
    <Show when={data.loading && !latest()}><div role="status"><Spinner size={24} /><p>{t("common.loading")}</p></div></Show>
    <Show when={data.error || error()}>
      <p role="alert">{error() ?? friendlyError(data.error, t).message}</p>
      <div class="iv-action-row">
        <Button type="button" variant="secondary" onClick={() => void refetch()}>{t("common.retry")}</Button>
        <Button type="button" variant="ghost" onClick={props.onChooseAnother}>{t("installStore.chooseAnother")}</Button>
        <Button variant="ghost" href="/workloads">{t("installStore.viewApps")}</Button>
      </div>
    </Show>
    <Show when={latest()}>{(value) => <>
      <Show when={state() === "installed"}>
        <h2>{value().capsule.status === "error" || value().capsule.status === "disabled" ? t("installStore.needsAttentionTitle") : t("installStore.doneTitle")}</h2>
        <Show when={value().capsule.status === "error" || value().capsule.status === "disabled"}><p role="alert">{t("installStore.installedNeedsAttention")}</p></Show>
        <Show when={value().capsule.status === "error" && value().run}>{(run) =>
          <InstallExecution planRunId={run().planRunId ?? run().id} initialRunId={run().id} capsuleId={props.capsuleId}
            onDone={() => { clearCaches(); void refetch().then(() => refetchSurfaces()); }} />
        }</Show>
        <div class="iv-action-row">
          <Show when={launchUrl()}>{(url) => <Button variant="primary" size="lg" href={url()} target="_blank" rel="noopener noreferrer" icon={<ExternalLink size={18} />}>{t("installStore.open")}</Button>}</Show>
          <Button type="button" variant="secondary" icon={<PlugZap size={16} />} aria-expanded={props.connectionsOpen} aria-controls="install-connections-panel" onClick={props.onConnect}>{t("installStore.manageConnections")}</Button>
          <Button variant="ghost" href={`/workloads/${encodeURIComponent(props.capsuleId)}`}>{t("installStore.manageApp")}</Button>
        </div>
        <Show when={!launchUrl()}>
          <p class="iv-muted" role={surfaces.error ? "alert" : "status"}>{surfaces.loading ? t("common.loading") : surfaces.error ? t("installStore.launchNotReady") : t("installStore.noLaunchUrl")}</p>
          <Button type="button" variant="ghost" busy={surfaces.loading} onClick={() => void refetchSurfaces()}>{t("installStore.refreshLaunch")}</Button>
        </Show>
        <Button type="button" variant="ghost" class="iv-uninstall" busy={busy()} onClick={() => void uninstall()}>{t("installStore.uninstall")}</Button>
      </Show>
      <Show when={state() === "uninstalling"}>
        <h2>{t("installStore.uninstalling")}</h2>
        <p role={value().capsule.status === "error" ? "alert" : "status"}>{capsuleUninstallBanner(value().capsule)}</p>
        <Show when={uninstallCancellable(value().capsule)}><Button type="button" variant="secondary" busy={busy()} onClick={() => void undoUninstall()}>{t("app.uninstall.cancel")}</Button></Show>
        <Button variant="ghost" href={`/workloads/${encodeURIComponent(props.capsuleId)}`}>{t("installStore.manageApp")}</Button>
      </Show>
      <Show when={state() === "not-installed"}><h2>{t("installStore.uninstalled")}</h2><Button type="button" variant="secondary" onClick={props.onChooseAnother}>{t("installStore.chooseAnother")}</Button></Show>
      <Show when={state() !== "installed" && state() !== "uninstalling" && state() !== "not-installed"}>
        <Show when={value().run} fallback={<p>{t("installStore.recoveryUnverifiedHint")}</p>}>{(run) =>
          <InstallExecution planRunId={run().planRunId ?? run().id} initialRunId={run().id} capsuleId={props.capsuleId}
            onState={setExecutionState} onDone={() => { clearCaches(); void refetch(); }} />
        }</Show>
        <Button variant="ghost" href={`/workloads/${encodeURIComponent(props.capsuleId)}`}>{t("installStore.manageApp")}</Button>
      </Show>
    </>}</Show>
  </section>;
}
