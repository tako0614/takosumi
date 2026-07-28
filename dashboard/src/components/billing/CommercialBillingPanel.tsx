import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import {
  CreditCard,
  ExternalLink,
  ReceiptText,
  RefreshCw,
  WalletCards,
} from "lucide-solid";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  type Column,
  DataTable,
  FormField,
  Select,
  Skeleton,
  Toast,
} from "../ui/index.ts";
import {
  beginCommercialBillingCheckout,
  type CommercialBillingAutoRechargeSettings,
  type CommercialBillingCustomerType,
  type CommercialBillingPayment,
  loadCommercialBilling,
  openCommercialBillingPortal,
  updateCommercialBillingAutoRecharge,
} from "../../lib/commercial-billing.ts";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import {
  formatDate,
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

const PAYMENT_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  paid: "billing.commercial.payment.status.paid",
  failed: "billing.commercial.payment.status.failed",
};

export default function CommercialBillingPanel(props: Props) {
  const [snapshot, { refetch }] = createResource(
    () => ({ basePath: props.basePath, workspaceId: props.workspaceId }),
    loadCommercialBilling,
  );
  const [customerType, setCustomerType] =
    createSignal<CommercialBillingCustomerType>("individual");
  const [country, setCountry] = createSignal("");
  const [checkoutAmount, setCheckoutAmount] = createSignal<number>();
  const [portalBusy, setPortalBusy] = createSignal(false);
  const [settingsBusy, setSettingsBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  const [autoRecharge, setAutoRecharge] =
    createSignal<CommercialBillingAutoRechargeSettings>();
  const checkoutResult = initialCheckoutResult();

  createEffect(() => {
    const current = snapshot();
    const account = current?.billing.account;
    if (account?.customerType) setCustomerType(account.customerType);
    if (account?.taxJurisdiction) setCountry(account.taxJurisdiction);
    if (current?.billing.credits.autoRecharge) {
      setAutoRecharge(current.billing.credits.autoRecharge);
    }
  });

  const hasEstablishedProfile = createMemo(() =>
    Boolean(
      snapshot()?.billing.account?.customerType &&
      snapshot()?.billing.account?.taxJurisdiction,
    ),
  );
  const autoRechargeSummary = createMemo(() => {
    const settings = autoRecharge();
    if (!settings?.enabled) return t("billing.commercial.autoRecharge.off");
    return t("billing.commercial.autoRecharge.onSummary", {
      threshold: formatUsdMicros(settings.thresholdUsdMicros),
      amount: formatUsdMicros(settings.rechargeUsdMicros),
      limit: formatUsdMicros(settings.monthlyLimitUsdMicros),
    });
  });

  const paymentColumns = createMemo<
    readonly Column<CommercialBillingPayment>[]
  >(() => [
    {
      header: t("billing.commercial.payment.date"),
      cell: (payment) =>
        payment.createdAt ? formatDate(payment.createdAt) : "—",
    },
    {
      header: t("billing.commercial.payment.status"),
      cell: (payment) => (
        <Badge tone={paymentTone(payment)}>{paymentStatusLabel(payment)}</Badge>
      ),
    },
    {
      header: t("billing.commercial.payment.amount"),
      align: "right",
      cell: (payment) => formatPaymentAmount(payment),
    },
    {
      header: t("billing.commercial.payment.action"),
      align: "right",
      cell: (payment) => (
        <Show when={payment.receiptUrl} fallback="—">
          {(href) => (
            <Button
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="sm"
              icon={<ExternalLink size={14} />}
            >
              {t("billing.commercial.payment.open")}
            </Button>
          )}
        </Show>
      ),
    },
  ]);

  const beginCheckout = async (amountUsdMicros: number) => {
    if (checkoutAmount()) return;
    setCheckoutAmount(amountUsdMicros);
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
        amountUsdMicros,
        customerType: customerType(),
        country: country(),
        successUrl: successUrl.href,
        cancelUrl: cancelUrl.href,
      });
      window.location.assign(destination);
    } catch (error) {
      setActionError(friendlyError(error, t).message);
      setCheckoutAmount(undefined);
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

  const saveAutoRecharge = async () => {
    const settings = autoRecharge();
    if (!settings || settingsBusy()) return;
    setSettingsBusy(true);
    setActionError(undefined);
    try {
      const saved = await updateCommercialBillingAutoRecharge({
        basePath: props.basePath,
        workspaceId: props.workspaceId,
        ...settings,
      });
      setAutoRecharge(saved);
      await refetch();
    } catch (error) {
      setActionError(friendlyError(error, t).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const updateAutoRecharge = (
    patch: Partial<CommercialBillingAutoRechargeSettings>,
  ) => {
    const current =
      autoRecharge() ??
      snapshot()?.configuration.credits.autoRecharge.defaultSettings;
    if (current) setAutoRecharge({ ...current, ...patch });
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

            <Card class="wb-billing-wallet">
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
              <div class="wb-billing-wallet-main">
                <div class="wb-billing-balance">
                  <span class="wb-billing-kicker">
                    {t("billing.commercial.balance.available")}
                  </span>
                  <strong>
                    {formatUsdMicros(data().billing.credits.availableUsdMicros)}
                  </strong>
                  <span class="wb-billing-price">
                    {t("billing.commercial.balance.noExpiry")}
                  </span>
                </div>
                <div class="wb-billing-wallet-state">
                  <Badge
                    tone={
                      data().billing.credits.paymentMethodReady ? "ok" : "muted"
                    }
                  >
                    {data().billing.credits.paymentMethodReady
                      ? t("billing.commercial.paymentMethod.ready")
                      : t("billing.commercial.paymentMethod.missing")}
                  </Badge>
                  <span>{autoRechargeSummary()}</span>
                </div>
              </div>
              <dl class="wb-billing-stats">
                <div>
                  <dt>{t("billing.commercial.balance.purchased")}</dt>
                  <dd>
                    {formatUsdMicros(data().billing.credits.purchasedUsdMicros)}
                  </dd>
                </div>
                <div>
                  <dt>{t("billing.commercial.balance.reserved")}</dt>
                  <dd>
                    {formatUsdMicros(data().billing.credits.reservedUsdMicros)}
                  </dd>
                </div>
                <div>
                  <dt>{t("billing.commercial.autoRecharge.status")}</dt>
                  <dd>
                    {data().billing.credits.autoRecharge.enabled
                      ? t("billing.commercial.autoRecharge.on")
                      : t("billing.commercial.autoRecharge.off")}
                  </dd>
                </div>
              </dl>
            </Card>

            <Card class="wb-billing-add">
              <CardHeader
                title={t("billing.commercial.credits.title")}
                subtitle={t("billing.commercial.credits.subtitle")}
                actions={<WalletCards size={20} aria-hidden="true" />}
              />
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
                            data().configuration.countryMatrix
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
              <div
                class="wb-billing-amount-picker"
                aria-label={t("billing.commercial.credits.choose")}
              >
                <For
                  each={data().configuration.credits.purchaseOptionsUsdMicros}
                >
                  {(amount) => (
                    <Button
                      class="wb-billing-amount"
                      variant="secondary"
                      busy={checkoutAmount() === amount}
                      disabled={
                        !data().billing.configured ||
                        country() === "" ||
                        Boolean(checkoutAmount())
                      }
                      onClick={() => void beginCheckout(amount)}
                    >
                      <strong>{formatUsdMicros(amount)}</strong>
                      <span>{t("billing.commercial.credits.add")}</span>
                    </Button>
                  )}
                </For>
              </div>
              <p class="wb-billing-tax-note">
                {t("billing.commercial.credits.taxNote")}
              </p>
            </Card>

            <Card class="wb-billing-auto">
              <CardHeader
                title={t("billing.commercial.autoRecharge.title")}
                subtitle={t("billing.commercial.autoRecharge.subtitle")}
                actions={
                  <Badge
                    tone={
                      autoRecharge()?.enabled === true ? "ok" : "muted"
                    }
                  >
                    {autoRecharge()?.enabled === true
                      ? t("billing.commercial.autoRecharge.on")
                      : t("billing.commercial.autoRecharge.off")}
                  </Badge>
                }
              />
              <div class="wb-billing-auto-body">
                <Checkbox
                  label={t("billing.commercial.autoRecharge.enable")}
                  checked={autoRecharge()?.enabled ?? false}
                  disabled={!data().billing.credits.paymentMethodReady}
                  onInput={(event) =>
                    updateAutoRecharge({
                      enabled: event.currentTarget.checked,
                    })
                  }
                />
                <Show when={!data().billing.credits.paymentMethodReady}>
                  <span>
                    {t("billing.commercial.autoRecharge.requiresCard")}
                  </span>
                </Show>
                <Show when={autoRecharge()?.enabled}>
                  <div class="wb-billing-auto-summary">
                    <RefreshCw size={16} aria-hidden="true" />
                    <span>{autoRechargeSummary()}</span>
                  </div>
                  <div class="wb-billing-form-grid">
                    <FormField
                      label={t("billing.commercial.autoRecharge.threshold")}
                    >
                      <Select
                        value={autoRecharge()?.thresholdUsdMicros}
                        onInput={(event) =>
                          updateAutoRecharge({
                            thresholdUsdMicros: Number(
                              event.currentTarget.value,
                            ),
                          })
                        }
                      >
                        <For
                          each={
                            data().configuration.credits.autoRecharge
                              .thresholdOptionsUsdMicros
                          }
                        >
                          {(amount) => (
                            <option value={amount}>
                              {formatUsdMicros(amount)}
                            </option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                    <FormField
                      label={t("billing.commercial.autoRecharge.amount")}
                    >
                      <Select
                        value={autoRecharge()?.rechargeUsdMicros}
                        onInput={(event) =>
                          updateAutoRecharge({
                            rechargeUsdMicros: Number(event.currentTarget.value),
                          })
                        }
                      >
                        <For
                          each={
                            data().configuration.credits.autoRecharge
                              .rechargeOptionsUsdMicros
                          }
                        >
                          {(amount) => (
                            <option value={amount}>
                              {formatUsdMicros(amount)}
                            </option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                    <FormField
                      label={t(
                        "billing.commercial.autoRecharge.monthlyLimit",
                      )}
                    >
                      <Select
                        value={autoRecharge()?.monthlyLimitUsdMicros}
                        onInput={(event) =>
                          updateAutoRecharge({
                            monthlyLimitUsdMicros: Number(
                              event.currentTarget.value,
                            ),
                          })
                        }
                      >
                        <For
                          each={
                            data().configuration.credits.autoRecharge
                              .monthlyLimitOptionsUsdMicros
                          }
                        >
                          {(amount) => (
                            <option value={amount}>
                              {formatUsdMicros(amount)}
                            </option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                  </div>
                </Show>
                <Button
                  variant="secondary"
                  busy={settingsBusy()}
                  disabled={
                    !data().billing.account ||
                    !autoRecharge() ||
                    (autoRecharge()?.enabled === true &&
                      !data().billing.credits.paymentMethodReady)
                  }
                  onClick={() => void saveAutoRecharge()}
                >
                  {t("billing.commercial.autoRecharge.save")}
                </Button>
              </div>
            </Card>

            <Card class="wb-billing-history">
              <details>
                <summary>
                  <span>
                    <ReceiptText size={18} aria-hidden="true" />
                    <span>
                      <strong>{t("billing.commercial.payment.title")}</strong>
                      <small>
                        {t("billing.commercial.payment.count", {
                          count: data().billing.payments.length,
                        })}
                      </small>
                    </span>
                  </span>
                  <span>{t("common.details")}</span>
                </summary>
                <div class="wb-billing-history-body">
                  <p>{t("billing.commercial.payment.subtitle")}</p>
                  <DataTable
                    columns={paymentColumns()}
                    rows={data().billing.payments}
                    rowKey={(payment) => payment.id}
                    empty={t("billing.commercial.payment.empty")}
                  />
                </div>
              </details>
            </Card>
          </>
        )}
      </Show>
    </section>
  );
}

function formatPaymentAmount(payment: CommercialBillingPayment): string {
  if (payment.amountUsdMicros !== undefined) {
    return formatUsdMicros(payment.amountUsdMicros);
  }
  if (payment.amountMinor === undefined) return "—";
  try {
    const formatter = new Intl.NumberFormat(intlLocale(), {
      style: "currency",
      currency: payment.currency,
    });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(payment.amountMinor / 10 ** digits);
  } catch {
    return `${payment.currency} ${payment.amountMinor}`;
  }
}

function paymentStatusLabel(payment: CommercialBillingPayment): string {
  if (payment.refunded) return t("billing.commercial.payment.status.refunded");
  const key = PAYMENT_STATUS_KEYS[payment.status];
  return key ? t(key) : t("billing.commercial.status.unknown");
}

function paymentTone(
  payment: CommercialBillingPayment,
): "ok" | "warn" | "danger" | "muted" {
  if (payment.refunded) return "warn";
  if (payment.paid) return "ok";
  if (payment.status === "failed") return "danger";
  return "muted";
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
