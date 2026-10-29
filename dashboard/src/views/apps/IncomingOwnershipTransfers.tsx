import { createResource, createSignal, For, Show } from "solid-js";
import { Button, Toast } from "../../components/ui/index.ts";
import { acceptAppOwnershipTransfer, listIncomingOwnershipTransfers, resetAppOwnershipCache } from "../../lib/control-api.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { t } from "../../i18n/index.ts";

/** Recipients can discover and accept a transfer without already being a member. */
export default function IncomingOwnershipTransfers(props: { readonly onChanged: () => Promise<unknown>; readonly appNames?: ReadonlyMap<string, string> }) {
  const [transfers, { refetch }] = createResource(() => listIncomingOwnershipTransfers());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const { confirm } = useConfirmDialog();
  return <>
    <Show when={transfers.error || error()}>
      <Toast tone="error">{error() ?? friendlyError(transfers.error, t).message}
        <Button variant="secondary" onClick={() => void refetch()}>{t("common.retry")}</Button>
      </Toast>
    </Show>
    <Show when={!transfers.error && (transfers.latest?.length ?? 0) > 0}>
      <section aria-label={t("app.sharing.incomingApp")}>
        <h2>{t("app.sharing.incomingApp")}</h2>
        <For each={transfers.latest}>{(transfer) => <div class="acct-row tg-card">
          <p>{t("app.sharing.incoming")}</p>
          <p>{props.appNames?.get(transfer.capsuleId) ?? transfer.capsuleId}</p>
          <Button variant="secondary" disabled={busy()} onClick={async () => {
            if (busy() || !await confirm({ title: t("app.sharing.acceptTransfer"), message: `${props.appNames?.get(transfer.capsuleId) ?? transfer.capsuleId}: ${t("app.sharing.acceptConfirm")}`,
              confirmText: t("app.sharing.acceptTransfer"), cancelText: t("common.cancel"), danger: true })) return;
            setBusy(true); setError(undefined);
            try {
              await acceptAppOwnershipTransfer(transfer.transferId); resetAppOwnershipCache();
              await refetch(); await props.onChanged();
            } catch (cause) { setError(friendlyError(cause, t).message); }
            finally { setBusy(false); }
          }}>{t("app.sharing.acceptTransfer")}</Button>
        </div>}</For>
      </section>
    </Show>
  </>;
}
