import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { CreditCard, ExternalLink, ReceiptText } from "lucide-solid";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  type Column,
  DataTable,
  FormField,
  Select,
  Skeleton,
  Toast,
} from "../ui/index.ts";
import {
  beginCommercialBillingCheckout,
  type CommercialBillingCustomerType,
  type CommercialBillingInvoice,
  type CommercialBillingPlan,
  type CommercialBillingSubscription,
  loadCommercialBilling,
  localizedCommercialBillingText,
  openCommercialBillingPortal,
} from "../../lib/commercial-billing.ts";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import {
  formatDate,
  formatDateTime,
  intlLocale,
  type MessageKey,
  t,
} from "../../i18n/index.ts";
import { friendlyError } from "../../lib/error-copy.ts";

interface Props {
  readonly basePath: `/${string}`;
  readonly workspaceId: string;
  readonly title: string;
  readonly description?: string;
}

const SUBSCRIPTION_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  active: "billing.commercial.subscription.status.active",
  trialing: "billing.commercial.subscription.status.trialing",
  past_due: "billing.commercial.subscription.status.past_due",
  unpaid: "billing.commercial.subscription.status.unpaid",
  incomplete: "billing.commercial.subscription.status.incomplete",
  incomplete_expired:
    "billing.commercial.subscription.status.incomplete_expired",
  canceled: "billing.commercial.subscription.status.canceled",
  paused: "billing.commercial.subscription.status.paused",
};

const INVOICE_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  paid: "billing.commercial.invoice.status.paid",
  open: "billing.commercial.invoice.status.open",
  draft: "billing.commercial.invoice.status.draft",
  uncollectible: "billing.commercial.invoice.status.uncollectible",
  void: "billing.commercial.invoice.status.void",
};

export default function CommercialBillingPanel(props: Props) {
  const [snapshot, { refetch }] = createResource(
    () => ({ basePath: props.basePath, workspaceId: props.workspaceId }),
    loadCommercialBilling,
  );
  const [customerType, setCustomerType] =
    createSignal<CommercialBillingCustomerType>("individual");
  const [country, setCountry] = createSignal("");
  const [checkoutPlanId, setCheckoutPlanId] = createSignal<string>();
  const [portalBusy, setPortalBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  const checkoutResult = initialCheckoutResult();

  createEffect(() => {
    const account = snapshot()?.billing.account;
    if (account?.customerType) setCustomerType(account.customerType);
    if (account?.taxJurisdiction) setCountry(account.taxJurisdiction);
  });

  const subscription = createMemo(() => snapshot()?.billing.subscription);
  const currentPlan = createMemo(() => {
    const current = subscription();
    return snapshot()?.catalog.plans.find(
      (plan) => plan.id === current?.planId,
    );
  });
  const hasEstablishedProfile = createMemo(() =>
    Boolean(
      snapshot()?.billing.account?.customerType &&
      snapshot()?.billing.account?.taxJurisdiction,
    ),
  );

  const invoiceColumns = createMemo<
    readonly Column<CommercialBillingInvoice>[]
  >(() => [
    {
      header: t("billing.commercial.invoice.date"),
      cell: (invoice) =>
        invoice.createdAt ? formatDate(invoice.createdAt) : "—",
    },
    {
      header: t("billing.commercial.invoice.number"),
      cell: (invoice) => invoice.number ?? invoice.id,
    },
    {
      header: t("billing.commercial.invoice.status"),
      cell: (invoice) => (
        <Badge tone={invoiceTone(invoice.status)}>
          {billingStatusLabel("invoice", invoice.status)}
        </Badge>
      ),
    },
    {
      header: t("billing.commercial.invoice.total"),
      align: "right",
      cell: (invoice) => formatInvoiceTotal(invoice),
    },
    {
      header: t("billing.commercial.invoice.action"),
      align: "right",
      cell: (invoice) => (
        <Show
          when={invoice.hostedInvoiceUrl ?? invoice.invoicePdfUrl}
          fallback="—"
        >
          {(href) => (
            <Button
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="sm"
              icon={<ExternalLink size={14} />}
            >
              {t("billing.commercial.invoice.open")}
            </Button>
          )}
        </Show>
      ),
    },
  ]);

  const beginCheckout = async (plan: CommercialBillingPlan) => {
    if (checkoutPlanId()) return;
    setCheckoutPlanId(plan.id);
    setActionError(undefined);
    try {
      const returnUrl = billingReturnUrl(props.workspaceId);
      const successUrl = new URL(returnUrl);
      successUrl.searchParams.set("checkout", "success");
      const cancelUrl = new URL(returnUrl);
      cancelUrl.searchParams.set("checkout", "cancelled");
      const destination = await beginCommercialBillingCheckout({
        basePath: props.basePath,
        workspaceId: props.workspaceId,
        planId: plan.id,
        customerType: customerType(),
        country: country(),
        successUrl: successUrl.href,
        cancelUrl: cancelUrl.href,
      });
      window.location.assign(destination);
    } catch (error) {
      setActionError(friendlyError(error, t).message);
      setCheckoutPlanId(undefined);
    }
  };

  const openPortal = async () => {
    if (portalBusy()) return;
    setPortalBusy(true);
    setActionError(undefined);
    try {
      const destination = await openCommercialBillingPortal({
        basePath: props.basePath,
        workspaceId: props.workspaceId,
        returnUrl: billingReturnUrl(props.workspaceId).href,
      });
      window.location.assign(destination);
    } catch (error) {
      setActionError(friendlyError(error, t).message);
      setPortalBusy(false);
    }
  };

  return (
    <section class="wb-billing-native" aria-label={props.title}>
      <Show when={checkoutResult === "success"}>
        <Toast tone="success">{t("billing.commercial.checkout.success")}</Toast>
      </Show>
      <Show when={checkoutResult === "cancelled"}>
        <Toast tone="neutral">
          {t("billing.commercial.checkout.cancelled")}
        </Toast>
      </Show>
      <Show when={actionError()}>
        {(message) => (
          <Toast tone="error">
            {t("billing.commercial.actionError", { message: message() })}
          </Toast>
        )}
      </Show>
      <Show when={snapshot.error}>
        <Toast tone="error">
          {t("billing.commercial.loadError", {
            message: friendlyError(snapshot.error, t).message,
          })}
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        </Toast>
      </Show>
      <Show when={snapshot.loading}>
        <Card class="wb-billing-loading">
          <Skeleton variant="row" count={2} />
          <Skeleton variant="card" />
        </Card>
      </Show>

      <Show when={snapshot()}>
        {(data) => (
          <>
            <Show when={!data().billing.configured}>
              <Toast tone="neutral">
                {t("billing.commercial.unavailable")}
              </Toast>
            </Show>

            <Card class="wb-billing-overview">
              <CardHeader
                title={props.title}
                subtitle={
                  props.description ?? t("billing.commercial.description")
                }
                actions={
                  <Show when={data().billing.account}>
                    <Button
                      variant="secondary"
                      busy={portalBusy()}
                      icon={<CreditCard size={16} />}
                      onClick={() => void openPortal()}
                    >
                      {t("billing.commercial.manage")}
                    </Button>
                  </Show>
                }
              />
              <div class="wb-billing-current">
                <div class="wb-billing-current-copy">
                  <span class="wb-billing-kicker">
                    {t("billing.commercial.currentPlan")}
                  </span>
                  <strong>
                    {currentPlan()
                      ? planName(currentPlan()!)
                      : (subscription()?.planId ??
                        t("billing.commercial.noPlan"))}
                  </strong>
                  <Show when={currentPlan()}>
                    {(plan) => (
                      <span class="wb-billing-price">{planPrice(plan())}</span>
                    )}
                  </Show>
                </div>
                <Show
                  when={subscription()}
                  fallback={
                    <Badge tone="muted">
                      {t("billing.commercial.status.none")}
                    </Badge>
                  }
                >
                  {(current) => (
                    <Badge tone={subscriptionTone(current().status)}>
                      {billingStatusLabel("subscription", current().status)}
                    </Badge>
                  )}
                </Show>
              </div>
              <Show when={subscription()}>
                {(current) => (
                  <CardSection>
                    <dl class="wb-billing-meta">
                      <Show when={current().currentPeriodEnd}>
                        {(date) => (
                          <div>
                            <dt>
                              {current().cancelAtPeriodEnd
                                ? t("billing.commercial.endsAt")
                                : t("billing.commercial.renewsAt")}
                            </dt>
                            <dd>{formatDateTime(date())}</dd>
                          </div>
                        )}
                      </Show>
                      <Show when={data().billing.account?.customerType}>
                        {(type) => (
                          <div>
                            <dt>
                              {t("billing.commercial.customerType.label")}
                            </dt>
                            <dd>{customerTypeLabel(type())}</dd>
                          </div>
                        )}
                      </Show>
                      <Show when={data().billing.account?.taxJurisdiction}>
                        {(jurisdiction) => (
                          <div>
                            <dt>{t("billing.commercial.country.label")}</dt>
                            <dd>{countryLabel(jurisdiction())}</dd>
                          </div>
                        )}
                      </Show>
                    </dl>
                  </CardSection>
                )}
              </Show>
            </Card>

            <Card>
              <CardHeader
                title={t("billing.commercial.plans.title")}
                subtitle={t("billing.commercial.plans.subtitle")}
              />
              <Show
                when={data().catalog.plans.length > 0}
                fallback={
                  <p class="wb-billing-empty">
                    {t("billing.commercial.plans.empty")}
                  </p>
                }
              >
                <Show when={!hasEstablishedProfile()}>
                  <div class="wb-billing-profile">
                    <div class="wb-billing-profile-heading">
                      <strong>{t("billing.commercial.profile.title")}</strong>
                      <span>{t("billing.commercial.profile.hint")}</span>
                    </div>
                    <div class="wb-billing-form-grid">
                      <FormField
                        label={t("billing.commercial.customerType.label")}
                      >
                        <Select
                          value={customerType()}
                          onInput={(event) =>
                            setCustomerType(
                              event.currentTarget
                                .value as CommercialBillingCustomerType,
                            )
                          }
                        >
                          <option value="individual">
                            {t("billing.commercial.customerType.individual")}
                          </option>
                          <option value="business">
                            {t("billing.commercial.customerType.business")}
                          </option>
                        </Select>
                      </FormField>
                      <FormField
                        label={t("billing.commercial.country.label")}
                        required
                      >
                        <Select
                          value={country()}
                          onInput={(event) =>
                            setCountry(event.currentTarget.value)
                          }
                        >
                          <option value="">
                            {t("billing.commercial.country.select")}
                          </option>
                          <For
                            each={
                              data().catalog.countryMatrix
                                ?.supportedCountries ?? []
                            }
                          >
                            {(code) => (
                              <option value={code}>{countryLabel(code)}</option>
                            )}
                          </For>
                        </Select>
                      </FormField>
                    </div>
                  </div>
                </Show>

                <div class="wb-billing-plan-grid">
                  <For each={data().catalog.plans}>
                    {(plan) => {
                      const current = () =>
                        Boolean(
                          subscription()?.planId === plan.id &&
                          subscriptionIsCurrent(subscription()),
                        );
                      return (
                        <article
                          class={`wb-billing-plan ${current() ? "is-current" : ""}`}
                        >
                          <div class="wb-billing-plan-heading">
                            <div>
                              <h3>{planName(plan)}</h3>
                              <p>{planPrice(plan)}</p>
                            </div>
                            <Show when={current()}>
                              <Badge tone="ok">
                                {t("billing.commercial.plans.current")}
                              </Badge>
                            </Show>
                          </div>
                          <p class="wb-billing-plan-note">
                            {t("billing.commercial.plans.paygNote")}
                          </p>
                          <Show
                            when={!current()}
                            fallback={
                              <span class="wb-billing-current-note">
                                {t(
                                  "billing.commercial.plans.currentDescription",
                                )}
                              </span>
                            }
                          >
                            <Button
                              variant="primary"
                              busy={checkoutPlanId() === plan.id}
                              disabled={
                                !data().billing.configured ||
                                country() === "" ||
                                Boolean(checkoutPlanId())
                              }
                              onClick={() => void beginCheckout(plan)}
                            >
                              {t("billing.commercial.plans.start")}
                            </Button>
                          </Show>
                        </article>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Card>

            <Card>
              <CardHeader
                title={t("billing.commercial.invoice.title")}
                subtitle={t("billing.commercial.invoice.subtitle")}
                actions={<ReceiptText size={20} aria-hidden="true" />}
              />
              <DataTable
                columns={invoiceColumns()}
                rows={data().billing.invoices}
                rowKey={(invoice) => invoice.id}
                empty={t("billing.commercial.invoice.empty")}
              />
            </Card>
          </>
        )}
      </Show>
    </section>
  );
}

function planName(plan: CommercialBillingPlan): string {
  return localizedCommercialBillingText(plan.name, intlLocale(), plan.id);
}

function planPrice(plan: CommercialBillingPlan): string {
  const display = localizedCommercialBillingText(
    plan.priceDisplay,
    intlLocale(),
    "",
  );
  if (display) return display;
  return plan.monthlyPriceUsdMicros !== undefined
    ? formatUsdMicros(plan.monthlyPriceUsdMicros)
    : "—";
}

function formatInvoiceTotal(invoice: CommercialBillingInvoice): string {
  if (invoice.totalUsdMicros !== undefined) {
    return formatUsdMicros(invoice.totalUsdMicros);
  }
  if (invoice.totalMinor === undefined) return "—";
  try {
    const formatter = new Intl.NumberFormat(intlLocale(), {
      style: "currency",
      currency: invoice.currency,
    });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(invoice.totalMinor / 10 ** digits);
  } catch {
    return `${invoice.currency} ${invoice.totalMinor}`;
  }
}

function customerTypeLabel(type: string): string {
  return type === "business"
    ? t("billing.commercial.customerType.business")
    : t("billing.commercial.customerType.individual");
}

function countryLabel(country: string): string {
  try {
    return (
      new Intl.DisplayNames([intlLocale()], { type: "region" }).of(country) ??
      country
    );
  } catch {
    return country;
  }
}

function billingStatusLabel(
  family: "subscription" | "invoice",
  status: string,
): string {
  const key =
    family === "subscription"
      ? SUBSCRIPTION_STATUS_KEYS[status]
      : INVOICE_STATUS_KEYS[status];
  return key ? t(key) : t("billing.commercial.status.unknown");
}

function subscriptionTone(
  status: string,
): "ok" | "warn" | "danger" | "info" | "muted" {
  if (status === "active" || status === "trialing") return "ok";
  if (status === "past_due" || status === "unpaid" || status === "incomplete")
    return "warn";
  if (status === "canceled" || status === "incomplete_expired") return "danger";
  if (status === "paused") return "info";
  return "muted";
}

function invoiceTone(
  status: string,
): "ok" | "warn" | "danger" | "info" | "muted" {
  if (status === "paid") return "ok";
  if (status === "open") return "warn";
  if (status === "uncollectible") return "danger";
  if (status === "draft") return "info";
  return "muted";
}

function subscriptionIsCurrent(
  subscription: CommercialBillingSubscription | undefined,
): boolean {
  return Boolean(
    subscription &&
    subscription.status !== "canceled" &&
    subscription.status !== "incomplete_expired",
  );
}

function billingReturnUrl(workspaceId: string): URL {
  const url = new URL("/settings/billing", window.location.origin);
  url.searchParams.set("workspaceId", workspaceId);
  return url;
}

function initialCheckoutResult(): "success" | "cancelled" | undefined {
  if (typeof window === "undefined") return undefined;
  const result = new URLSearchParams(window.location.search).get("checkout");
  return result === "success" || result === "cancelled" ? result : undefined;
}
