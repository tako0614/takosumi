/**
 * Workspace settings — billing / usage. The Takosumi Cloud billing surface:
 *   - subscription plan cards from the operator catalog
 *     (`GET /api/v1/billing/plans`) → Stripe Checkout by `planId`
 *   - spend guard + billing-mode explanation
 *   - Stripe customer portal (payment methods / invoices / cancellation)
 *   - usage events as folded support history
 *
 * The old debug controls (billing-mode select, free top-up input,
 * paste-a-price-ID checkout) are gone: billing mode and plan allowance are
 * operator-selected and not exposed as a customer-facing quota grant.
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
import {
  formatBillingNumber,
  formatUsdMicros,
  usageUsdMicros,
} from "../../../lib/billing-format.ts";
import { isTakosumiCloudRuntime } from "../../../lib/deployment-brand.ts";
import { setCurrentWorkspaceId } from "../../../lib/workspace-state.ts";
import {
  getWorkspaceBilling,
  listBillingPlans,
  listWorkspaceUsagePage,
  type CreditBalance,
  type PublicBillingPlan,
  type UsageEvent,
  type WorkspaceBilling,
} from "../../../lib/control-api.ts";
import { rpc } from "../../account/lib/api.ts";
import type {
  StripeBillingInvoice,
  StripeBillingSummary,
} from "../../account/lib/billing.ts";
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

const USAGE_LEDGER_PAGE_SIZE = 25;

export default function BillingTab(props: { readonly workspaceId: string }) {
  const [billing, { refetch: refetchBilling }] = createResource(
    () => props.workspaceId,
    getWorkspaceBilling,
  );
  const cloudBilling = createMemo(() => isTakosumiCloudRuntime());
  const [plans, { refetch: refetchPlans }] = createResource(
    () => (cloudBilling() ? "cloud" : undefined),
    listBillingPlans,
  );
  const [stripeBilling, { refetch: refetchStripe }] = createResource(
    () => (cloudBilling() ? "cloud" : undefined),
    () => rpc.billing.summary(),
  );
  const [usageRequested, setUsageRequested] = createSignal(false);
  const [usagePage, { refetch: refetchUsage }] = createResource(
    () => (usageRequested() ? props.workspaceId : undefined),
    (workspaceId) =>
      listWorkspaceUsagePage(workspaceId, { limit: USAGE_LEDGER_PAGE_SIZE }),
  );

  // Errored-resource accessors THROW when read, so every derived value must
  // short-circuit on `.error` before calling `billing()` / `plans()` /
  // `stripeBilling()` — otherwise a failed fetch crashes the whole tab.
  const mode = createMemo(() =>
    billing.error ? undefined : billing()?.settings?.mode,
  );
  const balance = createMemo(() =>
    billing.error ? undefined : billing()?.balance,
  );
  const subscriptions = createMemo(() =>
    (plans.error ? [] : (plans() ?? [])).filter(
      (plan) => plan.kind === "subscription",
    ),
  );
  const currentSubscription = createMemo(() =>
    subscriptionView(
      stripeBilling.error ? undefined : stripeBilling(),
      billing.error ? undefined : billing(),
    ),
  );
  const hasBillingCatalog = createMemo(() => subscriptions().length > 0);
  const canStartCheckout = createMemo(
    () => cloudBilling() && hasBillingCatalog(),
  );
  const canOpenPortal = createMemo(
    () =>
      cloudBilling() &&
      ((!stripeBilling.error && stripeBilling()?.configured === true) ||
        currentSubscription() !== null ||
        (mode() !== undefined && mode() !== "disabled")),
  );
  const billingSubtitle = createMemo(() => {
    if (billing.loading) return t("billing.loading");
    // The full error (with a retry) is rendered once in the card body below;
    // the subtitle stays a neutral status label so the same message is not
    // duplicated in the header and the body.
    if (billing.error) return t("billing.status.unavailable");
    const currentMode = mode() ?? "disabled";
    if (cloudBilling() && balanceAvailableUsdMicros(balance()) > 0) {
      return t("billing.mode.cloudCredits");
    }
    if (cloudBilling() && currentMode === "disabled" && hasBillingCatalog()) {
      return t("billing.mode.checkoutOpen");
    }
    return t(MODE_KEY[currentMode] ?? "billing.mode.disabled");
  });
  const reservedLabel = createMemo(() =>
    cloudBilling()
      ? t("billing.balance.reserved")
      : t("billing.quota.reserved"),
  );
  const cloudSpendStatus = createMemo(() => {
    const currentMode = mode() ?? "disabled";
    // Only an enforcing mode actually blocks apply on a depleted balance;
    // showback/disabled never gate, so "setup required" would be misleading.
    if (
      currentMode === "enforce" &&
      balanceAvailableUsdMicros(balance()) <= 0
    ) {
      return t("billing.balance.actionRequired");
    }
    return t("billing.balance.ready");
  });
  // Self-host quota: the capacity figure only means something when the
  // operator meters (showback) or gates (enforce) usage. Under `disabled`,
  // a "$0.00 available capacity" row reads as alarming nonsense, so it is
  // not rendered at all — the card subtitle already says billing is off.
  const quotaMeaningful = createMemo(() => {
    const currentMode = mode();
    return currentMode === "showback" || currentMode === "enforce";
  });

  // One-time checkout-result banner (the Stripe redirect lands back here with
  // ?checkout=success|cancelled). Read once, then strip from the URL.
  const [checkoutNotice, setCheckoutNotice] = createSignal<
    "success" | "cancelled" | null
  >(null);
  if (typeof window !== "undefined") {
    const billingReturn = consumeBillingReturnSearch(window.location.search);
    if (billingReturn.workspaceId) {
      setCurrentWorkspaceId(billingReturn.workspaceId);
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
    if (!session) {
      // An expired session must not degrade to a button that does nothing.
      setCheckoutError(t("billing.sessionExpired"));
      return;
    }
    setCheckoutBusyId(plan.id);
    setCheckoutError(null);
    try {
      const result = await rpc.billing.checkout({
        subject: session.subject,
        planId: plan.id,
        workspaceId: props.workspaceId,
      });
      if (result.url) {
        location.assign(result.url);
      } else {
        setCheckoutError(t("billing.checkout.noUrl"));
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
    if (!session) {
      // Same as checkout: session expiry gets a visible, localized error.
      setPortalError(t("billing.sessionExpired"));
      return;
    }
    setPortalBusy(true);
    setPortalError(null);
    try {
      const result = await rpc.billing.portal({ subject: session.subject });
      if (result.url) {
        location.assign(result.url);
      } else {
        setPortalError(t("billing.portal.noUrl"));
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

  // The Stripe customer portal is the recovery path (update card, resume/cancel
  // a subscription). It must be reachable whenever billing is configured — not
  // only when a current subscription exists — else a past_due/canceled account
  // with no active sub has no way in.
  const portalAction = () => (
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
            : t("billing.subscription.manage")}
        </Button>
      </div>
      <p class="muted">{t("billing.subscription.manageHint")}</p>
      {/* The portal error belongs beside its trigger button (in the
          subscription card), not stranded in the balance card above. */}
      <Show when={portalError()}>
        {(m) => <Toast tone="error">{m()}</Toast>}
      </Show>
    </Show>
  );

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
        cell: (e) => formatUsdMicros(usageUsdMicros(e)),
      });
    }
    columns.push({
      header: t("billing.usage.created"),
      cell: (e) => formatDateTime(e.createdAt),
    });
    return columns;
  });
  const invoiceColumns = createMemo<readonly Column<StripeBillingInvoice>[]>(
    () => [
      {
        header: t("billing.invoices.date"),
        cell: (invoice) =>
          invoice.createdAt ? formatDateTime(invoice.createdAt) : "-",
      },
      {
        header: t("billing.invoices.status"),
        cell: (invoice) => invoiceStatusLabel(invoice.status),
      },
      {
        header: t("billing.invoices.amount"),
        align: "right",
        cell: (invoice) => invoiceAmount(invoice),
      },
      {
        header: t("billing.invoices.invoice"),
        align: "right",
        cell: (invoice) =>
          invoice.hostedInvoiceUrl ? (
            <a
              class="tg-link"
              href={invoice.hostedInvoiceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("billing.invoices.open")}
            </a>
          ) : (
            "-"
          ),
      },
    ],
  );

  const planCard = (plan: PublicBillingPlan) => (
    <li class="av-plan-card">
      <div class="av-plan-text">
        <span class="av-plan-name">{planDisplayName(plan)}</span>
        <span class="av-plan-price">{plan.priceDisplay[locale()]}</span>
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
          : t("billing.plans.subscribe")}
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
              : t("billing.usageQuotaTitle")
          }
          subtitle={billingSubtitle()}
        />
        <Switch>
          <Match when={billing.loading}>
            <p class="muted">{t("billing.loading")}</p>
          </Match>
          <Match when={billing.error}>
            {(error) => (
              <ErrorRetry
                message={t("billing.error", { message: errorMessage(error()) })}
                onRetry={() => void refetchBilling()}
              />
            )}
          </Match>
          <Match when={billing()}>
            <Show
              when={cloudBilling() || quotaMeaningful()}
              fallback={<p class="muted">{t("billing.quota.disabledHint")}</p>}
            >
              <KVList
                items={
                  cloudBilling()
                    ? [
                        {
                          label: t("billing.balance.availableUsd"),
                          value: formatUsdMicros(
                            balanceAvailableUsdMicros(balance()),
                          ),
                        },
                        {
                          label: t("billing.balance.status"),
                          value: cloudSpendStatus(),
                        },
                      ]
                    : [
                        {
                          label: t("billing.quota.available"),
                          value: formatUsdMicros(
                            balanceAvailableUsdMicros(balance()),
                          ),
                        },
                      ]
                }
              />
            </Show>
            <Show when={balanceReservedUsdMicros(balance()) > 0}>
              <details class="wb-disclosure av-billing-ledger">
                <summary>{t("billing.pendingUse.title")}</summary>
                <KVList
                  items={[
                    {
                      label: reservedLabel(),
                      value: formatUsdMicros(
                        balanceReservedUsdMicros(balance()),
                      ),
                    },
                  ]}
                />
              </details>
            </Show>
          </Match>
        </Switch>
      </Card>

      <Show when={cloudBilling()}>
        <Card>
          <CardHeader
            title={t("billing.subscription.title")}
            subtitle={t("billing.subscription.subtitle")}
          />
          <Switch>
            <Match when={billing.loading || stripeBilling.loading}>
              <p class="muted">{t("billing.subscription.loading")}</p>
            </Match>
            <Match when={billing.error}>
              {(error) => (
                <Toast tone="error">
                  {t("billing.error", { message: errorMessage(error()) })}
                </Toast>
              )}
            </Match>
            <Match when={stripeBilling.error && !currentSubscription()}>
              <ErrorRetry
                message={t("billing.subscription.error", {
                  message: errorMessage(stripeBilling.error),
                })}
                onRetry={() => void refetchStripe()}
              />
            </Match>
            <Match when={currentSubscription()}>
              {(subscription) => (
                <div class="wc-stack-sm">
                  <KVList
                    items={[
                      {
                        label: t("billing.subscription.plan"),
                        value: subscription().plan,
                      },
                      {
                        label: t("billing.subscription.status"),
                        value: subscription().cancelAtPeriodEnd
                          ? t("billing.subscription.status.cancelAtPeriodEnd")
                          : subscriptionStatusLabel(subscription().status),
                      },
                      {
                        label: subscription().cancelAtPeriodEnd
                          ? t("billing.subscription.endsOn")
                          : t("billing.subscription.nextBilling"),
                        value: subscription().currentPeriodEnd
                          ? formatDateTime(subscription().currentPeriodEnd!)
                          : "-",
                      },
                    ]}
                  />
                  <Show when={subscription().cancelAtPeriodEnd}>
                    <Toast tone="neutral">
                      {t("billing.subscription.cancelNotice")}
                    </Toast>
                  </Show>
                  {portalAction()}
                </div>
              )}
            </Match>
            <Match when={!currentSubscription()}>
              <p class="muted">{t("billing.subscription.empty")}</p>
              {portalAction()}
            </Match>
          </Switch>
        </Card>
      </Show>

      <Show when={cloudBilling()}>
        <Card>
          <CardHeader title={t("billing.plans.title")} />
          <p class="muted av-plan-policy">{t("billing.plans.nonRefundable")}</p>
          <nav
            class="av-billing-policy-links"
            aria-label={t("billing.policies.aria")}
          >
            <a href="/legal/refund-policy">{t("billing.policies.refund")}</a>
            <a href="/legal/cancellation-policy">
              {t("billing.policies.cancellation")}
            </a>
            <a href="/legal/terms-of-service">{t("billing.policies.terms")}</a>
            <a href="/legal/privacy-policy">{t("billing.policies.privacy")}</a>
            <a href="/support">{t("billing.policies.support")}</a>
          </nav>
          <Switch>
            <Match when={plans.loading}>
              <p class="muted">{t("billing.plans.loading")}</p>
            </Match>
            <Match when={plans.error}>
              {(error) => (
                <ErrorRetry
                  message={t("billing.plans.error", {
                    message: errorMessage(error()),
                  })}
                  onRetry={() => void refetchPlans()}
                />
              )}
            </Match>
            <Match when={plans()}>
              <Show
                when={hasBillingCatalog()}
                fallback={<p class="muted">{t("billing.plans.none")}</p>}
              >
                <ul class="av-plan-list">
                  <For each={subscriptions()}>{planCard}</For>
                </ul>
              </Show>
            </Match>
          </Switch>
          <Show when={checkoutError()}>
            {(m) => <Toast tone="error">{m()}</Toast>}
          </Show>
        </Card>
      </Show>

      <Show when={cloudBilling()}>
        <Card>
          <CardHeader
            title={t("billing.invoices.title")}
            subtitle={t("billing.invoices.subtitle")}
          />
          <Switch>
            <Match when={stripeBilling.loading}>
              <p class="muted">{t("billing.invoices.loading")}</p>
            </Match>
            <Match when={stripeBilling.error}>
              {(error) => (
                <ErrorRetry
                  message={t("billing.invoices.error", {
                    message: errorMessage(error()),
                  })}
                  onRetry={() => void refetchStripe()}
                />
              )}
            </Match>
            <Match when={stripeBilling()}>
              {(summary) => (
                <Show
                  when={summary().invoices.length > 0}
                  fallback={<p class="muted">{t("billing.invoices.empty")}</p>}
                >
                  <DataTable
                    columns={invoiceColumns()}
                    rows={summary().invoices}
                    rowKey={(invoice) => invoice.id}
                  />
                </Show>
              )}
            </Match>
          </Switch>
        </Card>
      </Show>

      <Card>
        <details
          class="wb-disclosure av-billing-ledger"
          onToggle={(event) => {
            if (event.currentTarget.open) setUsageRequested(true);
          }}
        >
          <summary>{t("billing.ledger.title")}</summary>
          <div class="wc-stack-sm">
            <section>
              <h2 class="tg-card-title">{t("billing.usage.title")}</h2>
              <Switch>
                <Match when={!usageRequested()}>
                  <p class="muted">{t("billing.usage.openHint")}</p>
                </Match>
                <Match when={usagePage.loading}>
                  <p class="muted">{t("billing.usage.loading")}</p>
                </Match>
                <Match when={usagePage.error}>
                  {(error) => (
                    <ErrorRetry
                      message={t("billing.usage.error", {
                        message: errorMessage(error()),
                      })}
                      onRetry={() => void refetchUsage()}
                    />
                  )}
                </Match>
                <Match when={usagePage()}>
                  {(page) => (
                    <Show
                      when={page().usageEvents.length > 0}
                      fallback={<p class="muted">{t("billing.usage.empty")}</p>}
                    >
                      <DataTable
                        columns={usageColumns()}
                        rows={page().usageEvents}
                        rowKey={(_e, i) => i}
                      />
                      <Show when={page().nextCursor}>
                        <p class="muted">{t("billing.usage.moreAvailable")}</p>
                      </Show>
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

function ErrorRetry(props: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div class="wc-stack-sm">
      <Toast tone="error">{props.message}</Toast>
      <div class="wc-form-actions">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={props.onRetry}
        >
          {t("common.retry")}
        </Button>
      </div>
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

function balanceAvailableUsdMicros(balance: CreditBalance | undefined): number {
  return (
    balance?.availableUsdMicros ??
    Math.round((balance?.availableCredits ?? 0) * 1_000_000)
  );
}

function balanceReservedUsdMicros(balance: CreditBalance | undefined): number {
  return (
    balance?.reservedUsdMicros ??
    Math.round((balance?.reservedCredits ?? 0) * 1_000_000)
  );
}

function planDisplayName(plan: PublicBillingPlan): string {
  return plan.name[locale()];
}

interface SubscriptionView {
  readonly plan: string;
  readonly status: string;
  readonly currentPeriodEnd?: string;
  /** Pending cancellation: still active, but will not renew at period end. */
  readonly cancelAtPeriodEnd?: boolean;
}

function subscriptionView(
  stripeSummary: StripeBillingSummary | undefined,
  workspaceBilling: WorkspaceBilling | undefined,
): SubscriptionView | null {
  const stripeSubscription = stripeSummary?.subscription;
  if (stripeSubscription) {
    return {
      plan: stripeSubscription.planCode ?? workspaceBilling?.plan?.name ?? "-",
      status:
        stripeSubscription.status ??
        workspaceBilling?.subscription?.status ??
        "-",
      cancelAtPeriodEnd: stripeSubscription.cancelAtPeriodEnd === true,
      ...(stripeSubscription.currentPeriodEnd
        ? { currentPeriodEnd: stripeSubscription.currentPeriodEnd }
        : workspaceBilling?.subscription?.currentPeriodEnd
          ? { currentPeriodEnd: workspaceBilling.subscription.currentPeriodEnd }
          : {}),
    };
  }
  const subscription = workspaceBilling?.subscription;
  if (!subscription) return null;
  return {
    plan: workspaceBilling?.plan?.name ?? subscription.planId,
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

function subscriptionStatusLabel(status: string): string {
  const key = `billing.subscription.status.${status}` as MessageKey;
  return t(key) === key ? status : t(key);
}

function invoiceStatusLabel(status: string): string {
  const key = `billing.invoices.status.${status}` as MessageKey;
  return t(key) === key ? status : t(key);
}

function invoiceAmount(invoice: StripeBillingInvoice): string {
  if (invoice.totalUsdMicros !== undefined) {
    return formatUsdMicros(invoice.totalUsdMicros);
  }
  // totalMinor is in the currency's minor unit. The divisor is NOT always 100:
  // zero-decimal currencies (JPY, KRW, …) use 1, three-decimal (BHD, …) 1000.
  // Let Intl derive the fraction digits and format the symbol.
  try {
    const fmt = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: invoice.currency.toUpperCase(),
    });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(invoice.totalMinor / 10 ** digits);
  } catch {
    return `${formatBillingNumber(invoice.totalMinor / 100)} ${invoice.currency}`;
  }
}
