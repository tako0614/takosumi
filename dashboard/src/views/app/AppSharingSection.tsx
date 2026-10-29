import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Checkbox, FormField, Input, Select, Toast } from "../../components/ui/index.ts";
import {
  acceptAppOwnershipTransfer, cancelAppOwnershipTransfer,
  getAppMembers, inviteAppMember, removeAppMember, transferAppOwnership,
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
  const [email, setEmail] = createSignal("");
  const [consent, setConsent] = createSignal(false);
  const [recipient, setRecipient] = createSignal("");
  const [transfer, setTransfer] = createSignal<string>();
  const [transferId, setTransferId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const owner = () => props.role === "owner";
  const members = () => sharing.error ? undefined : sharing();
  createEffect(() => props.onAvailability?.(Boolean(sharing.error || members())));
  const names = () => props.connectionNames?.join("、") || t("app.sharing.noConnections");
  createEffect(() => { void names(); setConsent(false); });
  const action = async (run: () => Promise<void | false>) => {
    if (busy()) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { if (await run() !== false) setNotice(t("app.sharing.saved")); }
    catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally { setBusy(false); }
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
              <Show when={owner()}><Button type="button" variant="secondary" size="sm" disabled={busy()} onClick={() => void action(async () => {
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
            <Show when={!transfer()} fallback={<div role="status">
              <p>{t("app.sharing.pending", { id: transfer()! })}</p>
              <Button type="button" variant="secondary" disabled={busy()} onClick={() => void action(async () => {
                if (!owner()) return; await cancelAppOwnershipTransfer(transfer()!); setTransfer(undefined);
              })}>{t("app.sharing.cancelTransfer")}</Button>
            </div>}>
              <form class="ap-sharing-form" onSubmit={(event) => { event.preventDefault(); if (!owner() || !recipient()) return; void action(async () => {
                if (!await confirmChange(t("app.sharing.transfer"), t("app.sharing.transferConfirm"))) return false;
                const result = await transferAppOwnership(props.capsuleId, recipient()); setTransfer(result.transferId);
              }); }}>
                <FormField label={t("app.sharing.transferRecipient")}><Select name="transfer-recipient" value={recipient()} onChange={(event) => setRecipient(event.currentTarget.value)}>
                  <option value="">{t("app.sharing.chooseRecipient")}</option>
                  <For each={group().members.filter((member) => member.status === "active")}>{(member) => <option value={member.accountId}>{member.displayName}</option>}</For>
                </Select></FormField>
                <Button type="submit" variant="secondary" disabled={!recipient() || busy()}>{t("app.sharing.transfer")}</Button>
              </form>
            </Show>
          </Show>
          <Show when={props.role === "member"}>
            <Button type="button" variant="secondary" disabled={busy() || !props.accountId} onClick={() => void action(async () => {
              if (!props.accountId || !await confirmChange(t("app.sharing.leave"), t("app.sharing.leaveConfirm"))) return false;
              await removeAppMember(props.capsuleId, props.accountId); navigate("/", { replace: true });
            })}>{t("app.sharing.leave")}</Button>
            <form class="ap-sharing-form" onSubmit={(event) => { event.preventDefault(); if (!transferId().trim()) return; void action(async () => {
              if (!await confirmChange(t("app.sharing.acceptTransfer"), t("app.sharing.acceptConfirm"))) return false;
              await acceptAppOwnershipTransfer(transferId().trim()); setTransferId(""); await props.onChanged(); await refetch();
            }); }}>
              <FormField label={t("app.sharing.transferId")}><Input name="ownership-transfer-id" value={transferId()} onInput={(event) => setTransferId(event.currentTarget.value)} /></FormField>
              <Button type="submit" variant="secondary" disabled={!transferId().trim() || busy()}>{t("app.sharing.acceptTransfer")}</Button>
            </form>
          </Show>
        </>}</Show>
        <Show when={error()}>{(message) => <p class="wa-error" role="alert">{message()}</p>}</Show>
        <Show when={notice()}>{(message) => <p role="status">{message()}</p>}</Show>
      </AppSection>
    </Show>
  );
}
