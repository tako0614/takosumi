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
  type CommercialBillingAccount,
  type CommercialBillingAutoRechargeSettings,
  type CommercialBillingConfiguration,
  type CommercialBillingCustomerType,
  type CommercialBillingPayment,
  type CommercialBillingSummary,
  type CommercialBillingTransaction,
  loadCommercialBilling,
  loadCommercialBillingTransactions,
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
import {
  billingReturnUrl,
  checkoutReturnUrl,
} from "../../lib/billing-return-url.ts";

interface Props {
  readonly basePath: `/${string}`;
  readonly workspaceId: string;
  readonly title: string;
  readonly description?: string;
}

const PAYMENT_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  paid: "billing.commercial.payment.status.paid",
  failed: "billing.commercial.payment.status.failed",
  partially_refunded: "billing.commercial.payment.status.partiallyRefunded",
  refunded: "billing.commercial.payment.status.refunded",
  disputed: "billing.commercial.payment.status.disputed",
};

const TRANSACTION_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  charged: "billing.commercial.transaction.status.charged",
  reversed: "billing.commercial.transaction.status.reversed",
};
const TRANSACTION_PAGE_LIMIT = 20;

type CompleteCommercialBillingSnapshot = {
  readonly configuration: CommercialBillingConfiguration;
  readonly billing: CommercialBillingSummary;
};

export default function CommercialBillingPanel(props: Props) {
  const [snapshot, { refetch }] = createResource(
    () => ({ basePath: props.basePath, workspaceId: props.workspaceId }),
    loadCommercialBilling,
  );
  const [transactionDetailsOpen, setTransactionDetailsOpen] =
    createSignal(false);
  const [transactionPage, { refetch: refetchTransactions }] = createResource(
    () =>
      transactionDetailsOpen()
        ? { basePath: props.basePath, workspaceId: props.workspaceId }
        : undefined,
    ({ basePath, workspaceId }) =>
      loadCommercialBillingTransactions({
        basePath,
        workspaceId,
        limit: TRANSACTION_PAGE_LIMIT,
      }),
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
  const [transactionItems, setTransactionItems] = createSignal<
    readonly CommercialBillingTransaction[]
  >([]);
  const [transactionNextCursor, setTransactionNextCursor] =
    createSignal<string>();
  const [transactionError, setTransactionError] = createSignal<unknown>();
  const [transactionLoadMoreBusy, setTransactionLoadMoreBusy] =
    createSignal(false);
  const checkoutResult = initialCheckoutResult();

  // SolidJS throws when an errored resource accessor is read. Keep those
  // failures local to this panel so the surrounding workspace settings remain
  // usable and the error toast below can preserve the HTTP evidence.
  const snapshotValue = createMemo(() => {
    if (snapshot.error) return undefined;
    return snapshot();
  });
  const completeSnapshot = createMemo<
    CompleteCommercialBillingSnapshot | undefined
  >(() => {
    const current = snapshotValue();
    return current?.configuration && current.billing
      ? {
          configuration: current.configuration,
          billing: current.billing,
        }
      : undefined;
  });
  const configurationOnly = createMemo(() => {
    const current = snapshotValue();
    return current?.configuration && !current.billing
      ? current.configuration
      : undefined;
  });
  const transactionPageValue = createMemo(() => {
    if (transactionPage.error) return undefined;
    return transactionPage();
  });

  createEffect(() => {
    const current = snapshotValue();
    const account = current?.billing?.account;
    if (account?.customerType) setCustomerType(account.customerType);
    if (account?.taxJurisdiction) setCountry(account.taxJurisdiction);
    if (current?.billing?.credits.autoRecharge) {
      setAutoRecharge(current.billing.credits.autoRecharge);
    }
  });

  createEffect(() => {
    const error = transactionPage.error;
    const page = transactionPageValue();
    if (error) {
      setTransactionError(error);
      return;
    }
    if (page) {
      setTransactionItems(page.items);
      setTransactionNextCursor(page.nextCursor);
      setTransactionError(undefined);
    }
  });

  const hasEstablishedProfile = createMemo(() => {
    const current = snapshotValue();
    return Boolean(
      current?.billing?.account?.customerType &&
        current?.billing?.account?.taxJurisdiction,
    );
  });
  const autoRechargeSummary = createMemo(() => {
    const settings = autoRecharge();
    if (!settings?.enabled) return t("billing.commercial.autoRecharge.off");
    return t("billing.commercial.autoRecharge.onSummary", {
      threshold: formatUsdMicros(settings.thresholdUsdMicros),
      amount: formatUsdMicros(settings.rechargeUsdMicros),
      limit: formatUsdMicros(settings.monthlyLimitUsdMicros),
    });
  });
  const serverAutoRecharge = createMemo(
    () => completeSnapshot()?.billing.credits.autoRecharge,
  );
  const lowCredit = createMemo(() => {
    const current = completeSnapshot();
    const settings = serverAutoRecharge();
    if (
      !current?.billing.configured ||
      current.billing.account?.usageAllowed === false ||
      !settings
    ) {
      return false;
    }
    return current.billing.credits.availableUsdMicros <= settings.thresholdUsdMicros;
  });
  const lowCreditMessage = createMemo(() => {
    return serverAutoRecharge()?.enabled === true
      ? t("billing.commercial.lowCredit.autoRecharge")
      : t("billing.commercial.lowCredit.manual");
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

  const transactionColumns = createMemo<
    readonly Column<CommercialBillingTransaction>[]
  >(() => [
    {
      header: t("billing.commercial.transaction.time"),
      cell: (transaction) => formatDate(transaction.acceptedAt),
    },
    {
      header: t("billing.commercial.transaction.status"),
      cell: (transaction) => (
        <Badge tone={transactionTone(transaction)}>
          {transactionStatusLabel(transaction)}
        </Badge>
      ),
    },
    {
      header: t("billing.commercial.transaction.resource"),
      cell: (transaction) => (
        <span>
          {transaction.resourceId}
          <small>{transaction.workspaceId}</small>
        </span>
      ),
    },
    {
      header: t("billing.commercial.transaction.operation"),
      cell: (transaction) => (
        <span>
          {transaction.operation}
          <small>{transaction.meterId}</small>
        </span>
      ),
    },
    {
      header: t("billing.commercial.transaction.quantity"),
      cell: (transaction) => `${transaction.quantity} ${transaction.unit}`,
    },
    {
      header: t("billing.commercial.transaction.amount"),
      align: "right",
      cell: (transaction) => formatTransactionAmount(transaction),
    },
  ]);

  const beginCheckout = async (amountUsdMicros: number) => {
    if (checkoutAmount()) return;
    setCheckoutAmount(amountUsdMicros);
    setActionError(undefined);
    try {
      const origin = window.location.origin;
      const destination = await beginCommercialBillingCheckout({
        basePath: props.basePath,
        workspaceId: props.workspaceId,
        amountUsdMicros,
        customerType: customerType(),
        country: country(),
        successUrl: checkoutReturnUrl(props.workspaceId, "success", origin)
          .href,
        cancelUrl: checkoutReturnUrl(props.workspaceId, "cancelled", origin)
          .href,
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
        returnUrl: billingReturnUrl(props.workspaceId, window.location.origin)
          .href,
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
      snapshotValue()?.configuration?.credits.autoRecharge.defaultSettings;
    if (current) setAutoRecharge({ ...current, ...patch });
  };

  const loadMoreTransactions = async () => {
    const cursor = transactionNextCursor();
    if (!cursor || transactionLoadMoreBusy()) return;
    setTransactionLoadMoreBusy(true);
    setTransactionError(undefined);
    try {
      const page = await loadCommercialBillingTransactions({
        basePath: props.basePath,
        workspaceId: props.workspaceId,
        limit: TRANSACTION_PAGE_LIMIT,
        cursor,
      });
      setTransactionItems((current) => [...current, ...page.items]);
      setTransactionNextCursor(page.nextCursor);
    } catch (error) {
      setTransactionError(error);
    } finally {
      setTransactionLoadMoreBusy(false);
    }
  };

  const handleTransactionToggle = (event: Event) => {
    const details = event.currentTarget as HTMLDetailsElement | null;
    if (details?.open) setTransactionDetailsOpen(true);
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
      <Show when={snapshotValue()?.errors?.configuration}>
        {(error) => (
          <Toast tone="error">
            {t("billing.commercial.loadError", {
              message: friendlyError(error(), t).message,
            })}
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          </Toast>
        )}
      </Show>
      <Show when={snapshotValue()?.errors?.summary}>
        {(error) => (
          <Toast tone="error">
            {t("billing.commercial.loadError", {
              message: friendlyError(error(), t).message,
            })}
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          </Toast>
        )}
      </Show>
      <Show when={snapshot.loading}>
        <Card class="wb-billing-loading">
          <Skeleton variant="row" count={2} />
          <Skeleton variant="card" />
        </Card>
      </Show>

      <Show when={configurationOnly()}>
        {(configuration) => (
          <Card class="wb-billing-add">
            <CardHeader
              title={props.title}
              subtitle={
                props.description ?? t("billing.commercial.description")
              }
            />
            <div class="wb-billing-amount-picker" aria-disabled="true">
              <For each={configuration().credits.purchaseOptionsUsdMicros}>
                {(amount) => (
                  <Button
                    class="wb-billing-amount"
                    variant="secondary"
                    disabled
                  >
                    <strong>{formatUsdMicros(amount)}</strong>
                    <span>{t("billing.commercial.credits.add")}</span>
                  </Button>
                )}
              </For>
            </div>
          </Card>
        )}
      </Show>

      <Show when={completeSnapshot()}>
        {(data) => (
          <>
            <Show when={!data().billing.configured}>
              <Toast tone="neutral">
                {t("billing.commercial.unavailable")}
              </Toast>
            </Show>
            <Show when={data().billing.account}>
              {(account) => (
                <Show when={!account().usageAllowed}>
                  <Toast tone="error">
                    <span>{billingAccountBlockingMessage(account())}</span>
                    <Button
                      variant="primary"
                      size="sm"
                      busy={portalBusy()}
                      icon={<CreditCard size={16} />}
                      onClick={() => void openPortal()}
                    >
                      {t("billing.commercial.manage")}
                    </Button>
                  </Toast>
                </Show>
              )}
            </Show>
            <Show when={lowCredit()}>
              <Toast tone="neutral">
                {lowCreditMessage()}
              </Toast>
            </Show>

            <Card class="wb-billing-wallet">
              <CardHeader
                title={props.title}
                subtitle={
                  props.description ?? t("billing.commercial.description")
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
                  <Show when={data().billing.account}>
                    {(account) => (
                      <Badge tone={account().usageAllowed ? "ok" : "danger"}>
                        {billingAccountStatusLabel(account())}
                      </Badge>
                    )}
                  </Show>
                </div>
              </div>
              <dl class="wb-billing-stats">
                <div>
                  <dt>{t("billing.commercial.balance.reserved")}</dt>
                  <dd>
                    {formatUsdMicros(data().billing.credits.reservedUsdMicros)}
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
                        name="billingCustomerType"
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
                        name="billingCountry"
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
                      variant="primary"
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
              <details class="wb-billing-auto-disclosure">
                <summary>
                  <span>
                    <RefreshCw size={18} aria-hidden="true" />
                    <span>
                      <strong>{t("billing.commercial.autoRecharge.title")}</strong>
                      <small>
                        {t("billing.commercial.autoRecharge.subtitle")}
                      </small>
                    </span>
                  </span>
                  <Badge
                    tone={autoRecharge()?.enabled === true ? "ok" : "muted"}
                  >
                    {autoRecharge()?.enabled === true
                      ? t("billing.commercial.autoRecharge.on")
                      : t("billing.commercial.autoRecharge.off")}
                  </Badge>
                </summary>
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
                              <option
                                value={amount}
                                selected={
                                  autoRecharge()?.thresholdUsdMicros === amount
                                }
                              >
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
                              rechargeUsdMicros: Number(
                                event.currentTarget.value,
                              ),
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
                              <option
                                value={amount}
                                selected={
                                  autoRecharge()?.rechargeUsdMicros === amount
                                }
                              >
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
                              <option
                                value={amount}
                                selected={
                                  autoRecharge()?.monthlyLimitUsdMicros === amount
                                }
                              >
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
              </details>
            </Card>

            <Card class="wb-billing-history">
              <details
                class="wb-billing-disclosure"
                onToggle={handleTransactionToggle}
              >
                <summary>
                  <span>
                    <ReceiptText size={18} aria-hidden="true" />
                    <span>
                      <strong>{t("billing.commercial.transaction.title")}</strong>
                      <small>
                        {t("billing.commercial.transaction.subtitle")}
                      </small>
                    </span>
                  </span>
                  <span>{t("common.details")}</span>
                </summary>
                <Show when={transactionDetailsOpen()}>
                  <div class="wb-billing-history-body">
                    <DataTable
                      columns={transactionColumns()}
                      rows={transactionItems()}
                      loading={transactionPage.loading}
                      error={
                        transactionError()
                          ? t("billing.commercial.transaction.error", {
                              message: friendlyError(transactionError(), t)
                                .message,
                            })
                          : undefined
                      }
                      rowKey={(transaction) => transaction.transactionId}
                      empty={t("billing.commercial.transaction.empty")}
                    />
                    <Show when={transactionError()}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void refetchTransactions()}
                      >
                        {t("common.retry")}
                      </Button>
                    </Show>
                    <Show
                      when={
                        transactionNextCursor() &&
                        !transactionPage.loading &&
                        !transactionError()
                      }
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        busy={transactionLoadMoreBusy()}
                        onClick={() => void loadMoreTransactions()}
                      >
                        {t("billing.commercial.transaction.more")}
                      </Button>
                    </Show>
                  </div>
                </Show>
              </details>
            </Card>

            <Card class="wb-billing-history">
              <details class="wb-billing-disclosure">
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
                  <div class="wb-billing-payment-actions">
                    <Badge
                      tone={
                        data().billing.credits.paymentMethodReady
                          ? "ok"
                          : "muted"
                      }
                    >
                      {data().billing.credits.paymentMethodReady
                        ? t("billing.commercial.paymentMethod.ready")
                        : t("billing.commercial.paymentMethod.missing")}
                    </Badge>
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
                  </div>
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
  const key = PAYMENT_STATUS_KEYS[payment.status];
  return key ? t(key) : t("billing.commercial.status.unknown");
}

function paymentTone(
  payment: CommercialBillingPayment,
): "ok" | "warn" | "danger" | "muted" {
  if (payment.status === "disputed" || payment.status === "failed")
    return "danger";
  if (
    payment.status === "refunded" ||
    payment.status === "partially_refunded"
  )
    return "warn";
  if (payment.paid) return "ok";
  return "muted";
}

function formatTransactionAmount(
  transaction: CommercialBillingTransaction,
): string {
  try {
    return new Intl.NumberFormat(intlLocale(), {
      style: "currency",
      currency: transaction.currency,
      currencyDisplay: "code",
    }).format(transaction.amountUsdMicros / 1_000_000);
  } catch {
    return `${transaction.currency} ${transaction.amountUsdMicros}`;
  }
}

function transactionStatusLabel(
  transaction: CommercialBillingTransaction,
): string {
  const key = TRANSACTION_STATUS_KEYS[transaction.status];
  return key ? t(key) : t("billing.commercial.status.unknown");
}

function transactionTone(
  transaction: CommercialBillingTransaction,
): "ok" | "warn" | "danger" | "muted" {
  return transaction.status === "reversed" ? "warn" : "ok";
}

function billingAccountStatusLabel(account: CommercialBillingAccount): string {
  const key: MessageKey =
    account.status === "active"
      ? "billing.commercial.account.status.active"
      : account.status === "trialing"
        ? "billing.commercial.account.status.trialing"
        : account.status === "past_due"
          ? "billing.commercial.account.status.pastDue"
          : account.status === "disabled"
            ? "billing.commercial.account.status.disabled"
            : "billing.commercial.status.unknown";
  return t(key);
}

function billingAccountBlockingMessage(
  account: CommercialBillingAccount,
): string {
  const key: MessageKey =
    account.suspensionReason === "payment_disputed"
      ? "billing.commercial.account.blocked.paymentDisputed"
      : account.suspensionReason === "payment_past_due"
        ? "billing.commercial.account.blocked.paymentPastDue"
        : account.suspensionReason === "billing_disabled"
          ? "billing.commercial.account.blocked.disabled"
          : "billing.commercial.account.blocked.suspended";
  return t(key);
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

function initialCheckoutResult(): "success" | "cancelled" | undefined {
  if (typeof window === "undefined") return undefined;
  const result = new URLSearchParams(window.location.search).get("checkout");
  return result === "success" || result === "cancelled" ? result : undefined;
}
