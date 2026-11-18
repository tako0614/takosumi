import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import type { DestroyProviderConnectionReplacement } from "takosumi-contract";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { Button, FormField, Select } from "../../components/ui/index.ts";
import { t } from "../../i18n/index.ts";
import { providerName } from "../../lib/app-page.ts";
import { listProviderConnections, type CapsuleAppView } from "../../lib/control-api.ts";
import { providerConnectionDisplayName } from "../../lib/provider-connections.ts";

export default function AppUninstallConnectionRecovery(props: {
  readonly app: Pick<CapsuleAppView, "workspaceId" | "problems">;
  readonly disabled: boolean;
  readonly onReview: (replacements: readonly DestroyProviderConnectionReplacement[]) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [choices, { refetch }] = createResource(
    () => open() ? { workspaceId: props.app.workspaceId } : false,
    ({ workspaceId }) => listProviderConnections(workspaceId),
  );
  const rows = createMemo(() => {
    const missing = new Map<string, string>();
    for (const problem of props.app.problems) {
      if (problem.code === "connection_unavailable" && problem.connectionStatus === "missing" &&
        problem.connectionId && problem.provider) {
        missing.set(problem.connectionId, problem.provider);
      }
    }
    return [...missing].map(([connectionId, provider]) => ({ connectionId, provider }));
  });
  const [selection, setSelection] = createSignal<ReadonlyMap<string, string>>(new Map());
  const options = (provider: string) => (choices.state === "ready" ? choices() ?? [] : []).filter((connection) =>
    connection.scope !== "operator" && connection.status === "verified" &&
    (connection.expiresAt === undefined || Date.parse(connection.expiresAt) > Date.now()) &&
    sameProviderSource(provider, connection.providerSource));
  const replacements = createMemo(() => {
    const selected = rows().flatMap(({ connectionId, provider }) => {
      const replacementConnectionId = selection().get(connectionId);
      return replacementConnectionId && options(provider).some((connection) => connection.id === replacementConnectionId)
        ? [{ connectionId, replacementConnectionId }] : [];
    });
    return selected.length > 0 && selected.length === rows().length &&
      new Set(selected.map(({ replacementConnectionId }) => replacementConnectionId)).size === selected.length
      ? selected : undefined;
  });

  return (
    <Show when={rows().length > 0}>
      <Show when={open()} fallback={
        <Button variant="secondary" type="button" disabled={props.disabled} onClick={() => setOpen(true)}>
          {t("app.uninstall.chooseReplacement")}
        </Button>
      }>
        <div class="wa-stack">
          <Switch>
            <Match when={choices.loading}><p role="status">{t("common.loading")}</p></Match>
            <Match when={choices.error}>
              <p role="alert">{t("app.uninstall.replacementLoadFailed")}</p>
              <Button variant="secondary" type="button" onClick={() => void refetch()}>{t("common.retry")}</Button>
            </Match>
            <Match when={rows().some(({ provider }) => options(provider).length === 0)}>
              <p>{t("app.uninstall.noReplacement")}</p>
            </Match>
            <Match when={choices.state === "ready"}>
              <p>{t("app.uninstall.replacementHint")}</p>
              <For each={rows()}>{({ connectionId, provider }) => (
                <FormField label={providerName(provider)}>
                  <Select value={selection().get(connectionId) ?? ""} disabled={props.disabled} onChange={(event) =>
                    setSelection(new Map(selection()).set(connectionId, event.currentTarget.value))}>
                    <option value="">{t("app.uninstall.replacementPlaceholder")}</option>
                    <For each={options(provider)}>{(connection) => (
                      <option value={connection.id} disabled={[...selection()].some(([id, selected]) => id !== connectionId && selected === connection.id)}>
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
    </Show>
  );
}
