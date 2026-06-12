/**
 * Space settings — お支払い. The user-facing billing surface:
 * balance, billing-mode explanation, usage / reservation history, and the
 * Stripe customer portal. (The old debug controls — billing-mode select, free
 * top-up input, paste-a-price-ID checkout — are gone: per spec §32 the billing
 * mode is operator-selected and credits enter through paid checkout only.)
 *
 * Plan / credit-pack purchase cards are added by the billing milestone on top
 * of the operator-configured plan catalog (`GET /api/v1/billing/plans`).
 */
import { createMemo, createResource, createSignal, Show } from "solid-js";
import { ExternalLink } from "lucide-solid";
import {
  type CreditReservation,
  getSpaceBilling,
  listSpaceCreditReservations,
  listSpaceUsage,
  type UsageEvent,
} from "../../../lib/control-api.ts";
import { rpc } from "../../account/lib/api.ts";
import { readSession } from "../../account/lib/session.ts";
import { formatDateTime, type MessageKey, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  type Column,
  DataTable,
  KVList,
  Toast,
} from "../../../components/ui/index.ts";

const MODE_KEY: Record<string, MessageKey> = {
  disabled: "billing.mode.disabled",
  showback: "billing.mode.showback",
  enforce: "billing.mode.enforce",
};

export default function BillingTab(props: { readonly spaceId: string }) {
  const [billing] = createResource(() => props.spaceId, getSpaceBilling);
  const [usage] = createResource(() => props.spaceId, listSpaceUsage);
  const [reservations] = createResource(
    () => props.spaceId,
    listSpaceCreditReservations,
  );

  const mode = createMemo(
    () => billing()?.settings?.mode ?? "disabled",
  );
  const balance = createMemo(() => billing()?.balance);

  const [portalBusy, setPortalBusy] = createSignal(false);
  const [portalError, setPortalError] = createSignal<string | null>(null);

  const openPortal = async () => {
    const session = readSession();
    if (!session) return;
    setPortalBusy(true);
    setPortalError(null);
    try {
      const result = await rpc.billing.portal({ subject: session.subject });
      if (result.url) {
        location.assign(result.url);
      } else {
        setPortalError(t("billing.checkout.failed", { message: "no url" }));
      }
    } catch (err) {
      setPortalError(
        t("billing.checkout.failed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setPortalBusy(false);
    }
  };

  const reservationColumns: readonly Column<CreditReservation>[] = [
    {
      header: t("members.col.status"),
      cell: (r) => <code class="wc-code">{r.status}</code>,
    },
    { header: t("billing.usage.credits"), cell: (r) => r.estimatedCredits },
    {
      header: "Run",
      cell: (r) => <code class="wc-code">{r.runId}</code>,
    },
    {
      header: t("billing.reservations.expires"),
      cell: (r) => formatDateTime(r.expiresAt),
    },
  ];

  const usageColumns: readonly Column<UsageEvent>[] = [
    {
      header: t("billing.usage.kind"),
      cell: (e) => <code class="wc-code">{e.kind}</code>,
    },
    { header: t("billing.usage.quantity"), cell: (e) => e.quantity },
    { header: t("billing.usage.credits"), cell: (e) => e.credits },
    {
      header: "Run",
      cell: (e) => (
        <Show when={e.runId} fallback={<span class="muted">—</span>}>
          {(runId) => <code class="wc-code">{runId()}</code>}
        </Show>
      ),
    },
    {
      header: t("billing.usage.created"),
      cell: (e) => formatDateTime(e.createdAt),
    },
  ];

  return (
    <div class="wc-stack">
      <Card>
        <CardHeader
          title={t("billing.balance.title")}
          subtitle={t(MODE_KEY[mode()] ?? "billing.mode.disabled")}
        />
        <KVList
          items={[
            {
              label: t("billing.balance.available"),
              value: balance()?.availableCredits ?? 0,
            },
            {
              label: t("billing.balance.reserved"),
              value: balance()?.reservedCredits ?? 0,
            },
          ]}
        />
        <div class="wc-form-actions">
          <Button
            variant="secondary"
            type="button"
            busy={portalBusy()}
            onClick={() => void openPortal()}
            icon={<ExternalLink size={16} />}
          >
            {portalBusy() ? t("billing.portalOpening") : t("billing.portal")}
          </Button>
        </div>
        <Show when={portalError()}>
          {(m) => <Toast tone="error">{m()}</Toast>}
        </Show>
      </Card>

      <Card>
        <CardHeader title={t("billing.reservations.title")} />
        <Show
          when={(reservations() ?? []).length > 0}
          fallback={<p class="muted">{t("billing.reservations.empty")}</p>}
        >
          <DataTable
            columns={reservationColumns}
            rows={reservations() ?? []}
            rowKey={(r) => r.runId}
          />
        </Show>
      </Card>

      <Card>
        <CardHeader title={t("billing.usage.title")} />
        <Show
          when={(usage() ?? []).length > 0}
          fallback={<p class="muted">{t("billing.usage.empty")}</p>}
        >
          <DataTable
            columns={usageColumns}
            rows={usage() ?? []}
            rowKey={(_e, i) => i}
          />
        </Show>
      </Card>
    </div>
  );
}
