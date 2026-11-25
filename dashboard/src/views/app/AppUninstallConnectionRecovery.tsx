import { batch, createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { DestroyProviderConnectionReplacement, ProviderConnection } from "takosumi-contract";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { Button, FormField, Select } from "../../components/ui/index.ts";
import { t } from "../../i18n/index.ts";
import { uninstallConnectionsHref } from "../../lib/app-links.ts";
import { providerName } from "../../lib/app-page.ts";
import { getCapsuleProviderBindingSet, listProviderConnectionsWithSignal, type CapsuleAppView } from "../../lib/control-api.ts";
import { providerConnectionDisplayName } from "../../lib/provider-connections.ts";
import { appUninstallRecoveryConnections, isUninstallReplacementReady } from "../../lib/capsule-uninstall.ts";
import { verifiedCloudflareAccountId } from "../../../../providers/cloudflare/settings.ts";

function replacementConnectionLabel(connection: ProviderConnection, original: boolean, now?: number): string {
  const displayName = providerConnectionDisplayName(connection);
  const name = original ? t("app.uninstall.replacementOriginalConnection", { name: displayName }) : displayName;
  if (!isUninstallReplacementReady(connection, now)) {
    return t("app.uninstall.replacementNeedsVerification", { name });
  }
  const accountId = verifiedCloudflareAccountId(connection);
  return accountId ? t("app.uninstall.replacementCloudflareAccount", { name, accountId }) : name;
}

function verifiedReplacementConnections(connections: readonly ProviderConnection[], now = Date.now()) {
  return connections.filter((connection) =>
    connection.scope !== "operator" && connection.status === "verified" &&
    (connection.expiresAt === undefined || Date.parse(connection.expiresAt) > now));
}

export default function AppUninstallConnectionRecovery(props: {
  readonly app: Pick<CapsuleAppView, "capsuleId" | "workspaceId" | "problems" | "latestRun" | "uninstall">;
  readonly mode: "unavailable" | "failed" | "refused" | "before_approval";
  readonly disabled: boolean;
  readonly onCheckingChange?: (checking: boolean) => void;
  readonly onReview: (replacements: readonly DestroyProviderConnectionReplacement[]) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const failedDestroyApply = () => props.mode === "failed" &&
    props.app.latestRun?.type === "destroy_apply" &&
    props.app.latestRun.status === "failed" && props.app.latestRun.errorCode === "apply_failed";
  const replacementHint = () => t(failedDestroyApply()
    ? "app.uninstall.replacementPermissionsHint"
    : "app.uninstall.replacementHint");
  const capsuleId = createMemo(() => props.app.capsuleId);
  const workspaceId = createMemo(() => props.app.workspaceId);
  const bindingRunId = createMemo(() => props.mode === "unavailable" ? undefined : props.app.latestRun?.id);
  const request = createMemo(() => open() ? {
    capsuleId: capsuleId(), workspaceId: workspaceId(), bindingRunId: bindingRunId(),
  } : false);
  const reads = new AbortController();
  onCleanup(() => reads.abort());
  const [inventory, { refetch, mutate }] = createResource(request, async (target) => {
    const isCurrent = () => !reads.signal.aborted && request() === target;
    const [connections, bindingSet] = await Promise.all([
      listProviderConnectionsWithSignal(target.workspaceId, reads.signal, { cache: "no-store", isCurrent }),
      target.bindingRunId
        ? getCapsuleProviderBindingSet(target.capsuleId, { signal: reads.signal, isCurrent })
        : undefined,
    ]);
    if (bindingSet && (bindingSet.capsuleId !== target.capsuleId || bindingSet.workspaceId !== target.workspaceId)) {
      throw new Error("Provider bindings do not match this app.");
    }
    return { verified: verifiedReplacementConnections(connections), connections, bindings: bindingSet?.bindings ?? [] };
  });
  const available = () => inventory.state === "ready" ? inventory() : undefined;
  const unavailableIds = createMemo(() => new Set(props.mode === "unavailable"
    ? [] : props.app.uninstall.unavailableRecoveryConnectionIds ?? []));
  const restorableOriginalIds = createMemo(() => new Set(props.app.uninstall.restorableOriginalConnectionIds));
  const options = (provider: string, originalConnectionId: string) =>
    (available()?.verified ?? []).filter((connection) =>
      (connection.id !== originalConnectionId || restorableOriginalIds().has(originalConnectionId)) &&
      sameProviderSource(provider, connection.providerSource));
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
      if (original && (original.scope === "operator" || !sameProviderSource(provider, original.providerSource))) continue;
      if (options(provider, connectionId).length === 0 && !unavailableIds().has(connectionId)) continue;
      rows.set(connectionId, {
        connectionId,
        provider,
        label: `${providerName(provider)} · ${original ? providerConnectionDisplayName(original) : connectionId}`,
      });
    }
    return [...rows.values()];
  });
  const [selection, setSelection] = createSignal<ReadonlyMap<string, string>>(new Map());
  createEffect(() => {
    const visible = rows();
    // A fresh app view can withdraw an entire row. Its hidden selection must
    // not block another review or leave only part of the old selection.
    setSelection((chosen) => [...chosen].some(([id, key]) =>
      key && !visible.some(({ connectionId }) => connectionId === id)) ? new Map() : chosen);
  });
  const [checkedAt, setCheckedAt] = createSignal<number>();
  const replacements = createMemo(() => {
    const chosen = selection();
    const selectedCount = [...chosen.values()].filter(Boolean).length;
    const selected = rows().flatMap(({ connectionId, provider }) => {
      const replacement = options(provider, connectionId).find((connection) =>
        connection.id === chosen.get(connectionId) && isUninstallReplacementReady(connection, checkedAt()));
      return replacement ? [{ connectionId, replacement }] : [];
    });
    return selected.length > 0 && selected.length === selectedCount &&
      (props.mode !== "unavailable" || selected.length === rows().length) &&
      [...unavailableIds()].every((connectionId) => selected.some((row) => row.connectionId === connectionId))
      ? selected : undefined;
  });
  const [checking, setChecking] = createSignal(false);
  onCleanup(() => {
    if (checking()) props.onCheckingChange?.(false);
  });
  const [reviewNotice, setReviewNotice] = createSignal<
    "app.uninstall.replacementLoadFailed" | "app.uninstall.replacementSelectionChanged"
  >();
  const refreshConnections = () => {
    if (props.disabled || checking() || inventory.loading) return;
    batch(() => {
      setSelection(new Map());
      setCheckedAt(undefined);
      setReviewNotice(undefined);
    });
    void refetch();
  };
  const review = async () => {
    const selected = replacements();
    const initial = available();
    const target = request();
    if (!selected || !initial || !target || props.disabled || checking()) return;
    setReviewNotice(undefined);
    const now = Date.now();
    if (selected.some(({ replacement }) => !isUninstallReplacementReady(replacement, now))) {
      // The picker may have stayed open past expiry. Require a fresh selection
      // of the whole review instead of submitting only the remaining keys.
      batch(() => {
        setCheckedAt(now);
        setSelection(new Map());
      });
      return;
    }
    const chosen = selection();
    const mode = props.mode;
    const run = props.app.latestRun;
    const isCurrent = () => !reads.signal.aborted && !props.disabled && request() === target &&
      props.mode === mode && props.app.latestRun?.id === run?.id &&
      props.app.latestRun?.status === run?.status && available() === initial && selection() === chosen;
    setChecking(true);
    props.onCheckingChange?.(true);
    let connections: readonly ProviderConnection[];
    try {
      connections = await listProviderConnectionsWithSignal(target.workspaceId, reads.signal, { cache: "no-store", isCurrent });
    } catch {
      if (isCurrent()) setReviewNotice("app.uninstall.replacementLoadFailed");
      return;
    } finally {
      if (!reads.signal.aborted) {
        setChecking(false);
        props.onCheckingChange?.(false);
      }
    }
    if (!isCurrent()) return;

    // Keep the logical bindings and recheck the selected keys against the current inventory.
    const checked = Date.now();
    batch(() => {
      mutate({ ...initial, connections, verified: verifiedReplacementConnections(connections, checked) });
      setCheckedAt(checked);
      const current = replacements();
      const unchanged = current?.length === selected.length && current.every(({ connectionId, replacement }) =>
        selected.some((previous) => previous.connectionId === connectionId &&
          previous.replacement.id === replacement.id &&
          verifiedCloudflareAccountId(previous.replacement) === verifiedCloudflareAccountId(replacement)));
      if (!unchanged) {
        setSelection(new Map());
        setReviewNotice("app.uninstall.replacementSelectionChanged");
        return;
      }
      props.onReview(current.map(({ connectionId, replacement }) => ({
        connectionId, replacementConnectionId: replacement.id,
      })));
    });
  };

  return (
    <Show when={open()} fallback={
      <>
        <Show when={failedDestroyApply()}><p>{replacementHint()}</p></Show>
        <Button variant="secondary" type="button" disabled={props.disabled} onClick={() => setOpen(true)}>
          {t("app.uninstall.chooseReplacement")}
        </Button>
      </>
    }>
      <div class="wa-stack">
        <Show when={reviewNotice()}>{(message) => <p role="alert">{t(message())}</p>}</Show>
        <Switch>
          <Match when={inventory.loading}><p role="status">{t("common.loading")}</p></Match>
          <Match when={inventory.error}>
            <p role="alert">{t("app.uninstall.replacementLoadFailed")}</p>
            <Button variant="secondary" type="button" onClick={() => void refetch()}>{t("common.retry")}</Button>
          </Match>
          <Match when={inventory.state === "ready" && (rows().length === 0 ||
            (props.mode === "unavailable" && rows().some(({ provider, connectionId }) => options(provider, connectionId).length === 0)))}>
            <p>{t("app.uninstall.noReplacement")}</p>
          </Match>
          <Match when={inventory.state === "ready"}>
            <p>{replacementHint()}</p>
            <For each={rows()}>{({ connectionId, provider, label }) => (
              <Show when={options(provider, connectionId).length > 0} fallback={
                <FormField label={label} as="group"><p>{t("app.uninstall.noReplacement")}</p></FormField>
              }>
                <FormField label={label}>
                  <Select value={selection().get(connectionId) ?? ""} disabled={props.disabled || checking()} onChange={(event) =>
                    setSelection(new Map(selection()).set(connectionId, event.currentTarget.value))}>
                    <option value="">{t(props.mode !== "unavailable" && !unavailableIds().has(connectionId) && rows().length > 1
                      ? "app.uninstall.keepConnection"
                      : "app.uninstall.replacementPlaceholder")}</option>
                    <For each={options(provider, connectionId)}>{(connection) => (
                      <option value={connection.id} disabled={!isUninstallReplacementReady(connection, checkedAt())}>
                        {replacementConnectionLabel(connection, connection.id === connectionId, checkedAt())}
                      </option>
                    )}</For>
                  </Select>
                </FormField>
              </Show>
            )}</For>
            <Button variant="primary" type="button" busy={checking()} disabled={props.disabled || !replacements()} onClick={review}>
              {t("app.uninstall.replacementReview")}
            </Button>
          </Match>
        </Switch>
        <Show when={available()}>
          <Button variant="secondary" type="button" disabled={props.disabled || checking()} onClick={refreshConnections}>
            {t("app.uninstall.refreshConnections")}
          </Button>
          <Button variant="secondary" href={uninstallConnectionsHref(capsuleId())} disabled={props.disabled}>
            {t("app.uninstall.viewConnections")}
          </Button>
        </Show>
      </div>
    </Show>
  );
}
