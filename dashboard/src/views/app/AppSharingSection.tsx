import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Checkbox, FormField, Input, Select, Toast } from "../../components/ui/index.ts";
import {
  acceptAppOwnershipTransfer, cancelAppOwnershipTransfer,
  getAppMembers, inviteAppMember, removeAppMember, transferAppOwnership,
  listAppOwnershipTransfers, listIncomingOwnershipTransfers, resetAppOwnershipCache,
  type AppRole,
} from "../../lib/control-api.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { AppSection } from "./app-ui.tsx";

export default function AppSharingSection(props: {
  readonly capsuleId: string;
  readonly role: AppRole | undefined;
  readonly accountId: string | undefined;
  readonly connectionNames: readonly string[] | undefined;
  readonly onChanged: () => Promise<unknown>;
  readonly onAvailability?: (available: boolean) => void;
}) {
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const [sharing, { refetch }] = createResource(() => props.capsuleId, getAppMembers);
  const owner = () => props.role === "owner";
  const [transfers, { refetch: refetchTransfers }] = createResource(
    () => props.role ? { capsuleId: props.capsuleId, owner: owner() } : null,
    async (key) => key.owner ? await listAppOwnershipTransfers(key.capsuleId)
      : (await listIncomingOwnershipTransfers())?.filter((transfer) => transfer.capsuleId === key.capsuleId),
  );
  const [email, setEmail] = createSignal("");
  const [consent, setConsent] = createSignal(false);
  const [recipient, setRecipient] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const members = () => sharing.error ? undefined : sharing();
  const pendingTransfers = () => transfers.error ? [] : transfers() ?? [];
  createEffect(() => props.onAvailability?.(Boolean(sharing.error || members())));
  const names = () => props.connectionNames?.join("、") || t("app.sharing.noConnections");
  createEffect(() => { void names(); setConsent(false); });
  const action = async (run: () => Promise<void | false>) => {
    if (busy()) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { if (await run() !== false) setNotice(t("app.sharing.saved")); }
    catch (cause) { setError(friendlyError(cause, t).message); }
    finally { setBusy(false); }
  };
  const confirmChange = (title: string, message: string) => confirm({ title, message, confirmText: title, cancelText: t("common.cancel"), danger: true });
  return (
    <Show when={sharing.error || members()}>
      <AppSection id="sharing" title={t("app.sharing.title")} subtitle={t("app.sharing.subtitle")} testId="app-sharing">
        <Show when={sharing.error}>
          <Toast tone="error">{friendlyError(sharing.error, t).message}<Button variant="secondary" onClick={() => void refetch()}>{t("common.retry")}</Button></Toast>
        </Show>
        <Show when={members()}>{(group) => <>
          <p>{t("app.sharing.owner")}: {group().owner.displayName}</p>
          <ul class="ap-sharing-members">
            <For each={group().members}>{(member) => <li>
              <span>{member.displayName}<Show when={owner() && member.email}> ({member.email})</Show></span>
              <Show when={owner()}><Button type="button" variant="secondary" size="sm" disabled={busy()}
                aria-label={t("app.sharing.removeAria", { name: `${member.displayName} (${member.email ?? member.accountId})` })}
                onClick={() => void action(async () => {
                  if (!owner() || !await confirmChange(t("app.sharing.remove"), t("app.sharing.removeConfirm", { name: member.displayName }))) return false;
                  await removeAppMember(props.capsuleId, member.accountId); await refetch();
                })}>{t("app.sharing.remove")}</Button></Show>
            </li>}</For>
          </ul>
          <Show when={owner()}>
            <form class="ap-sharing-form" onSubmit={(event) => { event.preventDefault(); if (!consent() || !email().trim() || !owner() || props.connectionNames === undefined) return; void action(async () => {
              await inviteAppMember(props.capsuleId, email().trim(), "connections_and_code"); setEmail(""); setConsent(false); await refetch();
            }); }}>
              <FormField label={t("app.sharing.email")}><Input type="email" name="sharing-email" required value={email()} onInput={(event) => { setEmail(event.currentTarget.value); setConsent(false); }} /></FormField>
              <Checkbox name="sharing-consent" checked={consent()} onChange={(event) => setConsent(event.currentTarget.checked)} label={t("app.sharing.consent", { names: names() })} />
              <Button type="submit" variant="primary" disabled={!consent() || !email().trim() || busy() || props.connectionNames === undefined}>{t("app.sharing.invite")}</Button>
            </form>
          </Show>
          <Show when={transfers.error}>
            <Toast tone="error">{friendlyError(transfers.error, t).message}<Button variant="secondary" onClick={() => void refetchTransfers()}>{t("common.retry")}</Button></Toast>
          </Show>
          <Show when={!transfers.error && !transfers.loading && transfers() === undefined}>
            <p class="muted">{t("app.sharing.transfersUnavailable")}</p>
          </Show>
          <For each={pendingTransfers()}>{(transfer) => <div role="status">
            <p>{t(owner() ? "app.sharing.pending" : "app.sharing.incoming")}</p>
            <Show when={owner()} fallback={
              <Button type="button" variant="secondary" disabled={busy()} onClick={() => void action(async () => {
                if (!await confirmChange(t("app.sharing.acceptTransfer"), t("app.sharing.acceptConfirm"))) return false;
                await acceptAppOwnershipTransfer(transfer.transferId); resetAppOwnershipCache();
                await props.onChanged(); await refetch(); await refetchTransfers();
              })}>{t("app.sharing.acceptTransfer")}</Button>
            }>
              <Button type="button" variant="secondary" disabled={busy()} onClick={() => void action(async () => {
                if (!owner()) return false;
                await cancelAppOwnershipTransfer(transfer.transferId); await refetchTransfers();
              })}>{t("app.sharing.cancelTransfer")}</Button>
            </Show>
          </div>}</For>
          <Show when={owner() && !transfers.error && !transfers.loading && transfers() !== undefined && pendingTransfers().length === 0}>
            <form class="ap-sharing-form" onSubmit={(event) => { event.preventDefault(); if (!owner() || !recipient()) return; void action(async () => {
              if (!await confirmChange(t("app.sharing.transfer"), t("app.sharing.transferConfirm"))) return false;
              await transferAppOwnership(props.capsuleId, recipient()); await refetchTransfers();
            }); }}>
              <FormField label={t("app.sharing.transferRecipient")}><Select name="transfer-recipient" value={recipient()} onChange={(event) => setRecipient(event.currentTarget.value)}>
                <option value="">{t("app.sharing.chooseRecipient")}</option>
                <For each={group().members.filter((member) => member.status === "active")}>{(member) => <option value={member.accountId}>{member.displayName}</option>}</For>
              </Select></FormField>
              <Button type="submit" variant="secondary" disabled={!recipient() || busy()}>{t("app.sharing.transfer")}</Button>
            </form>
          </Show>
          <Show when={props.role === "member"}>
            <Button type="button" variant="secondary" disabled={busy() || !props.accountId} onClick={() => void action(async () => {
              if (!props.accountId || !await confirmChange(t("app.sharing.leave"), t("app.sharing.leaveConfirm"))) return false;
              await removeAppMember(props.capsuleId, props.accountId); resetAppOwnershipCache(); navigate("/", { replace: true });
            })}>{t("app.sharing.leave")}</Button>
          </Show>
        </>}</Show>
        <Show when={error()}>{(message) => <p class="wa-error" role="alert">{message()}</p>}</Show>
        <Show when={notice()}>{(message) => <p role="status">{message()}</p>}</Show>
      </AppSection>
    </Show>
  );
}
