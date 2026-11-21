import { createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { DestroyProviderConnectionReplacement } from "takosumi-contract";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { Button, FormField, Select } from "../../components/ui/index.ts";
import { t } from "../../i18n/index.ts";
import { providerName } from "../../lib/app-page.ts";
import { getCapsuleProviderBindingSet, listProviderConnectionsWithSignal, type CapsuleAppView } from "../../lib/control-api.ts";
import { providerConnectionDisplayName } from "../../lib/provider-connections.ts";
import { appUninstallRecoveryConnections } from "../../lib/capsule-uninstall.ts";

export default function AppUninstallConnectionRecovery(props: {
  readonly app: Pick<CapsuleAppView, "capsuleId" | "workspaceId" | "problems" | "latestRun" | "uninstall">;
  readonly mode: "unavailable" | "failed" | "refused";
  readonly disabled: boolean;
  readonly onReview: (replacements: readonly DestroyProviderConnectionReplacement[]) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const capsuleId = createMemo(() => props.app.capsuleId);
  const workspaceId = createMemo(() => props.app.workspaceId);
  const bindingRunId = createMemo(() => props.mode === "unavailable" ? undefined : props.app.latestRun?.id);
  const request = createMemo(() => open() ? {
    capsuleId: capsuleId(), workspaceId: workspaceId(), bindingRunId: bindingRunId(),
  } : false);
  const reads = new AbortController();
  onCleanup(() => reads.abort());
  const [inventory, { refetch }] = createResource(request, async (target) => {
    const isCurrent = () => !reads.signal.aborted && request() === target;
    const [connections, bindingSet] = await Promise.all([
      listProviderConnectionsWithSignal(target.workspaceId, reads.signal, { isCurrent }),
      target.bindingRunId
        ? getCapsuleProviderBindingSet(target.capsuleId, { signal: reads.signal, isCurrent })
        : undefined,
    ]);
    if (bindingSet && (bindingSet.capsuleId !== target.capsuleId || bindingSet.workspaceId !== target.workspaceId)) {
      throw new Error("Provider bindings do not match this app.");
    }
    const verified = connections.filter((connection) =>
      connection.scope !== "operator" && connection.status === "verified" &&
      (connection.expiresAt === undefined || Date.parse(connection.expiresAt) > Date.now()));
    return { verified, connections, bindings: bindingSet?.bindings ?? [] };
  });
  const available = () => inventory.state === "ready" ? inventory() : undefined;
  const options = (provider: string, originalConnectionId: string) =>
    (available()?.verified ?? []).filter((connection) =>
      connection.id !== originalConnectionId && sameProviderSource(provider, connection.providerSource));
  const rows = createMemo(() => {
    if (props.mode === "unavailable") {
      return appUninstallRecoveryConnections(props.app).map(({ connectionId, provider }) => ({
        connectionId, provider, label: providerName(provider),
      }));
    }
    const current = available();
    if (!current) return [];
    const originals = new Map(current.connections.map((connection) => [connection.id, connection]));
    const rows = new Map<string, { connectionId: string; provider: string; label: string }>();
    for (const { connectionId, provider } of current.bindings) {
      if (props.app.uninstall.recoveryConnectionIds !== undefined &&
        !props.app.uninstall.recoveryConnectionIds.includes(connectionId)) continue;
      const original = originals.get(connectionId);
      if ((original && (original.scope === "operator" || !sameProviderSource(provider, original.providerSource))) ||
        options(provider, connectionId).length === 0) continue;
      rows.set(connectionId, {
        connectionId,
        provider,
        label: `${providerName(provider)} · ${original ? providerConnectionDisplayName(original) : connectionId}`,
      });
    }
    return [...rows.values()];
  });
  const [selection, setSelection] = createSignal<ReadonlyMap<string, string>>(new Map());
  const replacements = createMemo(() => {
    const selected = rows().flatMap(({ connectionId, provider }) => {
      const replacementConnectionId = selection().get(connectionId);
      return replacementConnectionId && options(provider, connectionId).some((connection) => connection.id === replacementConnectionId)
        ? [{ connectionId, replacementConnectionId }] : [];
    });
    return selected.length > 0 && (props.mode !== "unavailable" || selected.length === rows().length)
      ? selected : undefined;
  });

  return (
    <Show when={open()} fallback={
      <Button variant="secondary" type="button" disabled={props.disabled} onClick={() => setOpen(true)}>
        {t("app.uninstall.chooseReplacement")}
      </Button>
    }>
      <div class="wa-stack">
        <Switch>
          <Match when={inventory.loading}><p role="status">{t("common.loading")}</p></Match>
          <Match when={inventory.error}>
            <p role="alert">{t("app.uninstall.replacementLoadFailed")}</p>
            <Button variant="secondary" type="button" onClick={() => void refetch()}>{t("common.retry")}</Button>
          </Match>
          <Match when={inventory.state === "ready" && (rows().length === 0 || rows().some(({ provider, connectionId }) => options(provider, connectionId).length === 0))}>
            <p>{t("app.uninstall.noReplacement")}</p>
          </Match>
          <Match when={inventory.state === "ready"}>
            <p>{t("app.uninstall.replacementHint")}</p>
            <For each={rows()}>{({ connectionId, provider, label }) => (
              <FormField label={label}>
                <Select value={selection().get(connectionId) ?? ""} disabled={props.disabled} onChange={(event) =>
                  setSelection(new Map(selection()).set(connectionId, event.currentTarget.value))}>
                  <option value="">{t(props.mode !== "unavailable" && rows().length > 1
                    ? "app.uninstall.keepConnection"
                    : "app.uninstall.replacementPlaceholder")}</option>
                  <For each={options(provider, connectionId)}>{(connection) => (
                    <option value={connection.id}>
                      {providerConnectionDisplayName(connection)}
                    </option>
                  )}</For>
                </Select>
              </FormField>
            )}</For>
            <Button variant="primary" type="button" disabled={props.disabled || !replacements()} onClick={() => {
              const selected = replacements();
              if (selected && !props.disabled) props.onReview(selected);
            }}>
              {t("app.uninstall.replacementReview")}
            </Button>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}
