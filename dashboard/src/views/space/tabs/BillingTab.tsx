/**
 * Workspace settings — billing / usage. The Takosumi Cloud billing surface:
 *   - plan / credit-pack cards from the operator catalog
 *     (`GET /api/v1/billing/plans`) → Stripe Checkout by `planId`
 *   - balance + billing-mode explanation
 *   - Stripe customer portal (payment methods / invoices)
 *   - usage events as folded support history
 *
 * The old debug controls (billing-mode select, free top-up input,
 * paste-a-price-ID checkout) are gone: billing mode is operator-selected and
 * credits enter through paid checkout only.
 */
import "../../../styles/wave-b.css";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { ExternalLink } from "lucide-solid";
import { isTakosumiCloudRuntime } from "../../../lib/deployment-brand.ts";
import { setCurrentSpaceId } from "../../../lib/space-state.ts";
import {
  getSpaceBilling,
  listBillingPlans,
  listSpaceUsage,
  type PublicBillingPlan,
  type UsageEvent,
} from "../../../lib/control-api.ts";
import { rpc } from "../../account/lib/api.ts";
import { consumeBillingReturnSearch } from "../../account/lib/billing-return.ts";
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
  const cloudBilling = createMemo(() => isTakosumiCloudRuntime());
  const [plans] = createResource(
    () => (cloudBilling() ? "cloud" : undefined),
    listBillingPlans,
  );
  const [usage] = createResource(() => props.spaceId, listSpaceUsage);

  const mode = createMemo(() => billing()?.settings?.mode);
  const balance = createMemo(() => billing()?.balance);
  const subscriptions = createMemo(() =>
    (plans() ?? []).filter((plan) => plan.kind === "subscription"),
  );
  const packs = createMemo(() =>
    (plans() ?? []).filter((plan) => plan.kind === "pack"),
  );
  const hasBillingCatalog = createMemo(() => (plans()?.length ?? 0) > 0);
  const canStartCheckout = createMemo(
    () => cloudBilling() && mode() !== undefined && mode() !== "disabled",
  );
  const canOpenPortal = createMemo(
    () => cloudBilling() && canStartCheckout() && hasBillingCatalog(),
  );
  const billingSubtitle = createMemo(() => {
    if (billing.loading) return t("billing.loading");
    if (billing.error)
      return t("billing.error", { message: errorMessage(billing.error) });
    const currentMode = mode() ?? "disabled";
    return t(MODE_KEY[currentMode] ?? "billing.mode.disabled");
  });
  const availableLabel = createMemo(() =>
    cloudBilling()
      ? t("billing.balance.available")
      : t("billing.quota.available"),
  );
  const reservedLabel = createMemo(() =>
    cloudBilling()
      ? t("billing.balance.reserved")
      : t("billing.quota.reserved"),
  );

  // One-time checkout-result banner (the Stripe redirect lands back here with
  // ?checkout=success|cancelled). Read once, then strip from the URL.
  const [checkoutNotice, setCheckoutNotice] = createSignal<
    "success" | "cancelled" | null
  >(null);
  if (typeof window !== "undefined") {
    const billingReturn = consumeBillingReturnSearch(window.location.search);
    if (billingReturn.spaceId) {
      setCurrentSpaceId(billingReturn.spaceId);
    }
    if (billingReturn.checkoutNotice) {
      setCheckoutNotice(billingReturn.checkoutNotice);
    }
    if (billingReturn.changed) {
      window.history.replaceState(
        {},
        "",
        window.location.pathname +
          (billingReturn.nextSearch ? `?${billingReturn.nextSearch}` : ""),
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

  const usageColumns = createMemo<readonly Column<UsageEvent>[]>(() => {
    const columns: Column<UsageEvent>[] = [
      {
        header: t("billing.usage.kind"),
        cell: (e) => usageKindLabel(e.kind),
      },
      {
        header: t("billing.usage.quantity"),
        cell: (e) => formatBillingNumber(e.quantity),
      },
    ];
    if (cloudBilling()) {
      columns.push({
        header: t("billing.usage.credits"),
        cell: (e) => formatBillingNumber(e.credits),
      });
    }
    columns.push({
      header: t("billing.usage.created"),
      cell: (e) => formatDateTime(e.createdAt),
    });
    return columns;
  });

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
        disabled={checkoutBusyId() !== null || !canStartCheckout()}
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
          title={
            cloudBilling()
              ? t("billing.balance.title")
              : t("billing.quota.title")
          }
          subtitle={billingSubtitle()}
        />
        <Switch>
          <Match when={billing.loading}>
            <p class="muted">{t("billing.loading")}</p>
          </Match>
          <Match when={billing.error}>
            {(error) => (
              <Toast tone="error">
                {t("billing.error", { message: errorMessage(error()) })}
              </Toast>
            )}
          </Match>
          <Match when={billing()}>
            <KVList
              items={[
                {
                  label: availableLabel(),
                  value: formatBillingNumber(balance()?.availableCredits ?? 0),
                },
              ]}
            />
            <Show when={(balance()?.reservedCredits ?? 0) > 0}>
              <details class="wb-disclosure av-billing-ledger">
                <summary>{t("billing.pendingUse.title")}</summary>
                <KVList
                  items={[
                    {
                      label: reservedLabel(),
                      value: formatBillingNumber(
                        balance()?.reservedCredits ?? 0,
                      ),
                    },
                  ]}
                />
              </details>
            </Show>
            <Show when={canOpenPortal()}>
              <div class="wc-form-actions">
                <Button
                  variant="secondary"
                  type="button"
                  busy={portalBusy()}
                  onClick={() => void openPortal()}
                  icon={<ExternalLink size={16} />}
                >
                  {portalBusy()
                    ? t("billing.portalOpening")
                    : t("billing.portal")}
                </Button>
              </div>
            </Show>
          </Match>
        </Switch>
        <Show when={portalError()}>
          {(m) => <Toast tone="error">{m()}</Toast>}
        </Show>
      </Card>

      <Show when={cloudBilling()}>
        <Card>
          <CardHeader title={t("billing.plans.title")} />
          <Switch>
            <Match when={plans.loading}>
              <p class="muted">{t("billing.plans.loading")}</p>
            </Match>
            <Match when={plans.error}>
              {(error) => (
                <Toast tone="error">
                  {t("billing.plans.error", {
                    message: errorMessage(error()),
                  })}
                </Toast>
              )}
            </Match>
            <Match when={plans()}>
              <Show
                when={hasBillingCatalog()}
                fallback={<p class="muted">{t("billing.plans.none")}</p>}
              >
                <Show
                  when={canStartCheckout()}
                  fallback={
                    <p class="av-plan-policy av-plan-policy-disabled">
                      {t("billing.plans.disabled")}
                    </p>
                  }
                >
                  <p class="muted av-plan-policy">
                    {t("billing.plans.nonRefundable")}
                  </p>
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
              </Show>
            </Match>
          </Switch>
          <Show when={checkoutError()}>
            {(m) => <Toast tone="error">{m()}</Toast>}
          </Show>
        </Card>
      </Show>

      <Card>
        <details class="wb-disclosure av-billing-ledger">
          <summary>{t("billing.ledger.title")}</summary>
          <div class="wc-stack-sm">
            <section>
              <h3 class="tg-card-title">{t("billing.usage.title")}</h3>
              <Switch>
                <Match when={usage.loading}>
                  <p class="muted">{t("billing.usage.loading")}</p>
                </Match>
                <Match when={usage.error}>
                  {(error) => (
                    <Toast tone="error">
                      {t("billing.usage.error", {
                        message: errorMessage(error()),
                      })}
                    </Toast>
                  )}
                </Match>
                <Match when={usage()}>
                  {(rows) => (
                    <Show
                      when={rows().length > 0}
                      fallback={<p class="muted">{t("billing.usage.empty")}</p>}
                    >
                      <DataTable
                        columns={usageColumns()}
                        rows={rows()}
                        rowKey={(_e, i) => i}
                      />
                    </Show>
                  )}
                </Match>
              </Switch>
            </section>
          </div>
        </details>
      </Card>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return t("billing.error.unknown");
}

function usageKindLabel(kind: string): string {
  switch (kind) {
    case "runner_minute":
      return t("billing.usage.kind.runnerMinute");
    case "operation":
      return t("billing.usage.kind.operation");
    case "gateway_compute":
      return t("billing.usage.kind.compute");
    case "gateway_storage_gb_hour":
      return t("billing.usage.kind.storage");
    default:
      return kind
        .replace(/[._-]+/g, " ")
        .split(" ")
        .map((word) => word.trim())
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
  }
}

function formatBillingNumber(value: number): string {
  return new Intl.NumberFormat(locale() === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: 3,
  }).format(value);
}
