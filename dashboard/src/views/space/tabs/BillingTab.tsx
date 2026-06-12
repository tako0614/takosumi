/**
 * Space settings — お支払い. The real user-facing billing surface (spec §32):
 *   - plan / credit-pack cards from the operator catalog
 *     (`GET /api/v1/billing/plans`) → Stripe Checkout by `planId`
 *   - balance + billing-mode explanation
 *   - Stripe customer portal (payment methods / invoices)
 *   - usage events + credit reservations (read-only history)
 *
 * The old debug controls (billing-mode select, free top-up input,
 * paste-a-price-ID checkout) are gone: billing mode is operator-selected and
 * credits enter through paid checkout only.
 */
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { ExternalLink } from "lucide-solid";
import {
  type CreditReservation,
  getSpaceBilling,
  listBillingPlans,
  listSpaceCreditReservations,
  listSpaceUsage,
  type PublicBillingPlan,
  type UsageEvent,
} from "../../../lib/control-api.ts";
import { rpc } from "../../account/lib/api.ts";
import { readSession } from "../../account/lib/session.ts";
import {
  formatDateTime,
  locale,
  type MessageKey,
  t,
} from "../../../i18n/index.ts";
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
  const [plans] = createResource(listBillingPlans);
  const [usage] = createResource(() => props.spaceId, listSpaceUsage);
  const [reservations] = createResource(
    () => props.spaceId,
    listSpaceCreditReservations,
  );

  const mode = createMemo(() => billing()?.settings?.mode ?? "disabled");
  const balance = createMemo(() => billing()?.balance);
  const subscriptions = createMemo(() =>
    (plans() ?? []).filter((plan) => plan.kind === "subscription"),
  );
  const packs = createMemo(() =>
    (plans() ?? []).filter((plan) => plan.kind === "pack"),
  );

  // One-time checkout-result banner (the Stripe redirect lands back here with
  // ?checkout=success|cancelled). Read once, then strip from the URL.
  const [checkoutNotice, setCheckoutNotice] = createSignal<
    "success" | "cancelled" | null
  >(null);
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("checkout");
    if (result === "success" || result === "cancelled") {
      setCheckoutNotice(result);
    }
    if (params.has("checkout") || params.has("portal")) {
      params.delete("checkout");
      params.delete("portal");
      const next = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (next ? `?${next}` : ""),
      );
    }
  }

  const [checkoutBusyId, setCheckoutBusyId] = createSignal<string | null>(null);
  const [checkoutError, setCheckoutError] = createSignal<string | null>(null);

  const startCheckout = async (plan: PublicBillingPlan) => {
    const session = readSession();
    if (!session) return;
    setCheckoutBusyId(plan.id);
    setCheckoutError(null);
    try {
      const result = await rpc.billing.checkout({
        subject: session.subject,
        planId: plan.id,
        spaceId: props.spaceId,
      });
      if (result.url) {
        location.assign(result.url);
      } else {
        setCheckoutError(t("billing.checkout.failed", { message: "no url" }));
      }
    } catch (err) {
      setCheckoutError(
        t("billing.checkout.failed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setCheckoutBusyId(null);
    }
  };

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

  const planCard = (plan: PublicBillingPlan) => (
    <li class="av-plan-card">
      <div class="av-plan-text">
        <span class="av-plan-name">{plan.name[locale()]}</span>
        <span class="av-plan-price">{plan.priceDisplay[locale()]}</span>
        <span class="av-plan-credits">
          {plan.kind === "subscription"
            ? t("billing.plans.perMonth", { n: plan.credits })
            : t("billing.packs.credits", { n: plan.credits })}
        </span>
      </div>
      <Button
        variant="primary"
        size="sm"
        type="button"
        busy={checkoutBusyId() === plan.id}
        disabled={checkoutBusyId() !== null}
        onClick={() => void startCheckout(plan)}
      >
        {checkoutBusyId() === plan.id
          ? t("billing.checkout.starting")
          : plan.kind === "subscription"
            ? t("billing.plans.subscribe")
            : t("billing.packs.buy")}
      </Button>
    </li>
  );

  return (
    <div class="wc-stack">
      <Show when={checkoutNotice()}>
        {(notice) => (
          <Toast tone={notice() === "success" ? "success" : "error"}>
            {notice() === "success"
              ? t("billing.checkout.success")
              : t("billing.checkout.cancelled")}
          </Toast>
        )}
      </Show>

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
        <CardHeader title={t("billing.plans.title")} />
        <Show
          when={(plans() ?? []).length > 0}
          fallback={<p class="muted">{t("billing.plans.none")}</p>}
        >
          <Show when={subscriptions().length > 0}>
            <ul class="av-plan-list">
              <For each={subscriptions()}>{planCard}</For>
            </ul>
          </Show>
          <Show when={packs().length > 0}>
            <h3 class="tg-card-title av-plan-section">
              {t("billing.packs.title")}
            </h3>
            <ul class="av-plan-list">
              <For each={packs()}>{planCard}</For>
            </ul>
          </Show>
        </Show>
        <Show when={checkoutError()}>
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
