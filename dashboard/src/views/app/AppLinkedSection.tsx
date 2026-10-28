import { createSignal, For, Show } from "solid-js";
import type { CapsuleAppLink, CapsuleAppView } from "takosumi-contract";
import AppFace from "../../components/AppFace.tsx";
import { Button, Select, Spinner } from "../../components/ui/index.ts";
import { locale, t, type MessageKey } from "../../i18n/index.ts";
import { appPageHref } from "../../lib/app-links.ts";
import { getInterfaceLinkCandidates, revokeInterfaceLink, setInterfaceLink, type InterfaceLinkCandidate } from "../../lib/control-api.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { AppSection } from "./app-ui.tsx";

const STATE_LABELS: Record<CapsuleAppLink["state"], MessageKey> = {
  unset: "app.links.unset", pending_approval: "app.links.pending_approval",
  active: "app.links.active", declined: "app.links.declined", revoked: "app.links.revoked",
};
const HEALTH_LABELS: Record<Exclude<CapsuleAppLink["health"], "ok">, MessageKey> = {
  reapproval_required: "app.links.reapproval_required",
  provider_not_ready: "app.links.provider_not_ready",
  provider_uninstall_scheduled: "app.links.provider_uninstall_scheduled",
  provider_removed: "app.links.provider_removed",
};

/** Links are the server's pinned relationships, including requirements left for later. */
export default function AppLinkedSection(props: {
  readonly app: CapsuleAppView;
  readonly onChanged: () => Promise<unknown> | void;
}) {
  const { confirm } = useConfirmDialog();
  const [editing, setEditing] = createSignal<string>();
  const [candidates, setCandidates] = createSignal<readonly InterfaceLinkCandidate[]>([]);
  const [generation, setGeneration] = createSignal(0);
  const [choice, setChoice] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const refresh = async () => {
    try { await props.onChanged(); } catch { setError(t("app.links.unreadable")); }
  };
  const rowKey = (row: CapsuleAppLink) => `${row.consumerCapsuleId}:${row.requirementKey}`;
  const name = (row: CapsuleAppLink) => row.otherApp?.displayName?.[locale()] || row.otherApp?.name || row.requirementKey;
  const accessibleName = (row: CapsuleAppLink, incoming: boolean, index: number) =>
    `${row.otherApp ? name(row) : t("app.links.title")} · ${t(incoming ? "app.links.usedBy" : "app.links.uses")} ${index + 1}`;
  const startChoosing = async (row: CapsuleAppLink) => {
    if (busy() || loading()) return;
    setEditing(rowKey(row));
    setCandidates([]);
    setChoice("");
    setError(undefined);
    setLoading(true);
    try {
      const result = await getInterfaceLinkCandidates(row.consumerCapsuleId, row.requirementKey);
      setCandidates(result.candidates);
      setGeneration(result.generation);
      setChoice(result.candidates.some((candidate) => candidate.interfaceId === row.providerInterfaceId)
        ? row.providerInterfaceId! : result.candidates.length === 1 ? result.candidates[0]!.interfaceId : "");
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setLoading(false);
    }
  };
  const save = async (row: CapsuleAppLink) => {
    if (busy() || loading() || !choice()) return;
    setBusy(true);
    setError(undefined);
    try {
      await setInterfaceLink(row.consumerCapsuleId, row.requirementKey, {
        interfaceId: choice(), expectedGeneration: generation(),
      });
      setEditing(undefined);
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
      // Refresh the guarded generation before a retry can make another change.
      setEditing(undefined);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (row: CapsuleAppLink) => {
    if (busy() || !(await confirm({
      title: t("app.links.revokeTitle"),
      message: props.app.capsuleId === row.consumerCapsuleId
        ? t("app.links.revokeHint")
        : t("app.links.revokeProviderHint", { name: name(row) }),
      confirmText: t("app.links.revoke"), cancelText: t("common.cancel"), danger: true,
    }))) return;
    setBusy(true);
    setError(undefined);
    try {
      await revokeInterfaceLink(row.consumerCapsuleId, row.requirementKey, row.generation);
      setEditing(undefined);
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const rows = (values: readonly CapsuleAppLink[], incoming: boolean) => (
    <ul class="ap-list">
      <For each={values}>{(row, index) => (
        <li class="ap-list-row" data-testid={incoming ? "app-link-used-by" : "app-link-use"} data-requirement={row.requirementKey}>
          <AppFace name={name(row)} iconUrl={row.otherApp?.iconUrl} class="ap-linked-face" />
          <div class="ap-list-main">
            <Show when={row.otherApp} fallback={<strong>{row.requirementKey}</strong>}>
              {(app) => <a href={appPageHref(app().capsuleId)}>{name(row)}</a>}
            </Show>
            <span class="ap-detail">{row.interfaceType} · {row.interfaceVersion}</span>
            <Show when={row.permissions.length > 0}><span class="ap-detail">{row.permissions.join(", ")}</span></Show>
            <span>{t(STATE_LABELS[row.state])}</span>
            <Show when={row.state === "active" && row.health !== "ok"}>
              <p class="wa-error">{t(HEALTH_LABELS[row.health as Exclude<typeof row.health, "ok">])}</p>
            </Show>
          </div>
          <Show when={row.canManage}>
            <div class="ap-row-actions">
              <Show when={!incoming}>
                <Button type="button" variant="secondary" aria-label={t(row.state === "active" ? "app.links.changeNamed" : "app.links.chooseNamed", { name: accessibleName(row, false, index()) })} disabled={busy() || loading()} onClick={() => void startChoosing(row)}>
                  {t(row.state === "active" ? "app.links.change" : "app.links.choose")}
                </Button>
              </Show>
              <Show when={row.state === "active" || row.state === "pending_approval"}>
                <Button type="button" variant="ghost" aria-label={t("app.links.revokeNamed", { name: accessibleName(row, incoming, index()) })} disabled={busy()} onClick={() => void revoke(row)}>{t("app.links.revoke")}</Button>
              </Show>
            </div>
          </Show>
          <Show when={editing() === rowKey(row)}>
            <div class="ap-linked-choice" data-testid="app-link-choice">
              <Show when={!loading()} fallback={<Spinner size={18} />}>
                <Show when={candidates().length > 0} fallback={<p>{t("app.links.noCandidates")}</p>}>
                  <Select aria-label={t("app.links.selectNamed", { name: accessibleName(row, false, index()) })} value={choice()} disabled={busy()} onChange={(event) => setChoice(event.currentTarget.value)}>
                    <option value="" disabled>{t("installStore.interfaces.choose")}</option>
                    <For each={candidates()}>{(candidate) => <option value={candidate.interfaceId}>{candidate.providerCapsuleName} · {candidate.interfaceName}</option>}</For>
                  </Select>
                  <Button type="button" variant="primary" busy={busy()} disabled={!choice() || busy()} onClick={() => void save(row)}>{t("app.links.save")}</Button>
                </Show>
              </Show>
              <Button type="button" variant="ghost" disabled={busy()} onClick={() => setEditing(undefined)}>{t("common.cancel")}</Button>
            </div>
          </Show>
        </li>
      )}</For>
    </ul>
  );
  return (
    <AppSection id="links" title={t("app.links.title")} testId="app-linked">
      <Show when={!props.app.incomplete?.includes("links")} fallback={<p class="wa-error" role="status">{t("app.links.unreadable")}</p>}>
        <Show when={(props.app.links?.uses.length ?? 0) + (props.app.links?.usedBy.length ?? 0) > 0} fallback={<p class="ap-detail">{t("app.links.empty")}</p>}>
          <Show when={props.app.links?.uses.length}><h3>{t("app.links.uses")}</h3>{rows(props.app.links.uses, false)}</Show>
          <Show when={props.app.links?.usedBy.length}><h3>{t("app.links.usedBy")}</h3>{rows(props.app.links.usedBy, true)}</Show>
        </Show>
      </Show>
      <Show when={error()}>{(message) => <p class="wa-error" role="alert">{message()}</p>}</Show>
    </AppSection>
  );
}
