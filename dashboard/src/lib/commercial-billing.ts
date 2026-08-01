/**
 * Provider-neutral client contract for an optional commercial billing
 * extension. The dashboard owns presentation; an operator extension owns
 * prices, payment-provider integration, tax policy, and billing records.
 */

export type CommercialBillingCustomerType = "individual" | "business";
export type CommercialBillingAccountStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "disabled"
  | "unknown";
export type CommercialBillingSuspensionReason =
  | "payment_disputed"
  | "payment_past_due"
  | "billing_disabled"
  | "billing_suspended";
export type CommercialBillingPaymentStatus =
  | "paid"
  | "failed"
  | "partially_refunded"
  | "refunded"
  | "disputed"
  | "unknown";

export interface CommercialBillingAutoRechargeSettings {
  readonly enabled: boolean;
  readonly thresholdUsdMicros: number;
  readonly rechargeUsdMicros: number;
  readonly monthlyLimitUsdMicros: number;
}

export interface CommercialCreditBillingConfiguration {
  readonly currency: "USD";
  readonly purchaseOptionsUsdMicros: readonly number[];
  readonly autoRecharge: {
    readonly defaultSettings: CommercialBillingAutoRechargeSettings;
    readonly thresholdOptionsUsdMicros: readonly number[];
    readonly rechargeOptionsUsdMicros: readonly number[];
    readonly monthlyLimitOptionsUsdMicros: readonly number[];
  };
}

export interface CommercialBillingConfiguration {
  readonly credits: CommercialCreditBillingConfiguration;
  readonly countryMatrix?: {
    readonly version: string;
    readonly supportedCountries: readonly string[];
  };
}

export interface CommercialBillingAccount {
  readonly billingAccountId: string;
  readonly status: CommercialBillingAccountStatus;
  /** Whether the canonical account can authorize new Cloud usage. */
  readonly usageAllowed: boolean;
  readonly suspensionReason?: CommercialBillingSuspensionReason;
  readonly customerType?: CommercialBillingCustomerType;
  readonly taxJurisdiction?: string;
  readonly updatedAt?: string;
}

export interface CommercialBillingCredits {
  readonly currency: "USD";
  /** Current credit that can be committed to new usage. */
  readonly availableUsdMicros: number;
  /** Current credit held for operations that have not settled yet. */
  readonly reservedUsdMicros: number;
  readonly paymentMethodReady: boolean;
  readonly autoRecharge: CommercialBillingAutoRechargeSettings;
}

export interface CommercialBillingPayment {
  readonly id: string;
  readonly status: CommercialBillingPaymentStatus;
  readonly currency: string;
  readonly amountMinor?: number;
  readonly amountUsdMicros?: number;
  readonly amountRefundedMinor?: number;
  readonly receiptUrl?: string;
  readonly createdAt?: string;
  readonly paid: boolean;
  readonly refunded: boolean;
  readonly disputed: boolean;
}

export type CommercialBillingTransactionStatus = "charged" | "reversed";

/** Customer-safe projection of one permanent Cloud wallet statement row. */
export interface CommercialBillingTransaction {
  readonly transactionId: string;
  readonly status: CommercialBillingTransactionStatus;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly resourceGeneration: number;
  readonly interfaceRevision: string;
  readonly pricingActivationId: string;
  readonly meterId: string;
  readonly operation: string;
  readonly quantity: string;
  readonly unit: string;
  readonly amountUsdMicros: number;
  readonly currency: string;
  readonly acceptedAt: string;
  readonly rejectedAt?: string;
}

export interface CommercialBillingTransactionPage {
  readonly items: readonly CommercialBillingTransaction[];
  readonly nextCursor?: string;
}

export interface CommercialBillingSummary {
  readonly configured: boolean;
  readonly account?: CommercialBillingAccount;
  readonly credits: CommercialBillingCredits;
  readonly payments: readonly CommercialBillingPayment[];
}

export interface CommercialBillingSnapshot {
  readonly configuration: CommercialBillingConfiguration;
  readonly billing: CommercialBillingSummary;
}

const MAX_OPTIONS = 32;
const MAX_PAYMENTS = 100;
const MAX_TEXT_LENGTH = 1_024;

interface CommercialBillingRequest {
  readonly basePath: `/${string}`;
  readonly workspaceId: string;
}

interface CommercialBillingCheckoutRequest extends CommercialBillingRequest {
  readonly amountUsdMicros: number;
  readonly customerType: CommercialBillingCustomerType;
  readonly country: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface CommercialBillingTransactionsRequest extends CommercialBillingRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export async function loadCommercialBilling(
  input: CommercialBillingRequest,
): Promise<CommercialBillingSnapshot> {
  const workspaceQuery = workspaceSearch(input.workspaceId);
  const [configuration, summary] = await Promise.all([
    requestJson(endpoint(input.basePath, "config")),
    requestJson(
      `${endpoint(input.basePath, "summary")}?${workspaceQuery.toString()}`,
    ),
  ]);
  return {
    configuration: parseCommercialBillingConfiguration(configuration),
    billing: parseCommercialBillingSummary(summary),
  };
}

export async function loadCommercialBillingTransactions(
  input: CommercialBillingTransactionsRequest,
): Promise<CommercialBillingTransactionPage> {
  const query = workspaceSearch(input.workspaceId);
  const limit = boundedTransactionLimit(input.limit);
  query.set("limit", String(limit));
  if (input.cursor) query.set("cursor", input.cursor);
  return parseCommercialBillingTransactionPage(
    await requestJson(
      `${endpoint(input.basePath, "transactions")}?${query.toString()}`,
    ),
  );
}

export async function beginCommercialBillingCheckout(
  input: CommercialBillingCheckoutRequest,
): Promise<string> {
  const value = await requestJson(
    `${endpoint(input.basePath, "checkout")}?${workspaceSearch(input.workspaceId).toString()}`,
    {
      method: "POST",
      body: JSON.stringify({
        amountUsdMicros: input.amountUsdMicros,
        customerType: input.customerType,
        country: input.country,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      }),
    },
  );
  return commercialBillingDestination(value);
}

export async function updateCommercialBillingAutoRecharge(
  input: CommercialBillingRequest & CommercialBillingAutoRechargeSettings,
): Promise<CommercialBillingAutoRechargeSettings> {
  const value = await requestJson(
    `${endpoint(input.basePath, "auto-recharge")}?${workspaceSearch(input.workspaceId).toString()}`,
    {
      method: "PUT",
      body: JSON.stringify({
        enabled: input.enabled,
        thresholdUsdMicros: input.thresholdUsdMicros,
        rechargeUsdMicros: input.rechargeUsdMicros,
        monthlyLimitUsdMicros: input.monthlyLimitUsdMicros,
      }),
    },
  );
  const settings = parseAutoRecharge(objectValue(value)?.autoRecharge);
  if (!settings) {
    throw new Error("billing service returned invalid auto-recharge settings");
  }
  return settings;
}

export async function openCommercialBillingPortal(
  input: CommercialBillingRequest & { readonly returnUrl: string },
): Promise<string> {
  const value = await requestJson(
    `${endpoint(input.basePath, "portal")}?${workspaceSearch(input.workspaceId).toString()}`,
    {
      method: "POST",
      body: JSON.stringify({ returnUrl: input.returnUrl }),
    },
  );
  return commercialBillingDestination(value);
}

export function parseCommercialBillingConfiguration(
  value: unknown,
): CommercialBillingConfiguration {
  const record = objectValue(value);
  const credits = parseCreditConfiguration(record?.credits);
  if (!credits) throw new Error("billing credit configuration is unavailable");
  const matrix = objectValue(record?.countryMatrix);
  const version = stringValue(matrix?.version);
  const supportedCountries = Array.isArray(matrix?.supportedCountries)
    ? uniqueStrings(
        matrix.supportedCountries
          .map(stringValue)
          .filter((country): country is string => Boolean(country))
          .map((country) => country.toUpperCase())
          .filter((country) => /^[A-Z]{2}$/.test(country)),
      )
    : [];
  return {
    credits,
    ...(version ? { countryMatrix: { version, supportedCountries } } : {}),
  };
}

export function parseCommercialBillingSummary(
  value: unknown,
): CommercialBillingSummary {
  const root = objectValue(value);
  const billing = objectValue(root?.billing);
  const rawPayments = Array.isArray(billing?.payments) ? billing.payments : [];
  const account = parseAccount(billing?.account);
  const credits = parseCredits(billing?.credits);
  if (!credits) throw new Error("billing credit balance is unavailable");
  return {
    configured: billing?.configured === true,
    ...(account ? { account } : {}),
    credits,
    payments: uniqueById(
      rawPayments
        .slice(0, MAX_PAYMENTS)
        .map(parsePayment)
        .filter(
          (payment): payment is CommercialBillingPayment =>
            payment !== undefined,
        ),
    ),
  };
}

export function parseCommercialBillingTransactionPage(
  value: unknown,
): CommercialBillingTransactionPage {
  const record = objectValue(value);
  if (!record || !Array.isArray(record.items)) {
    throw new Error("billing service returned invalid usage transactions");
  }
  const items = uniqueTransactions(
    record.items
      .slice(0, 100)
      .map(parseTransaction)
      .filter(
        (transaction): transaction is CommercialBillingTransaction =>
          transaction !== undefined,
      ),
  );
  const nextCursor = cursorValue(record.nextCursor);
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function commercialBillingDestination(value: unknown): string {
  const url = stringValue(objectValue(value)?.url);
  if (!url) throw new Error("billing service did not return a destination");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("billing service returned an invalid destination");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("billing service returned an unsafe destination");
  }
  return parsed.href;
}

function parseAccount(value: unknown): CommercialBillingAccount | undefined {
  const record = objectValue(value);
  const billingAccountId = tokenValue(record?.billingAccountId);
  if (!billingAccountId) return undefined;
  const status = accountStatus(record?.status);
  const suspensionReason = billingSuspensionReason(record?.suspensionReason);
  const customerType =
    record?.customerType === "individual" || record?.customerType === "business"
      ? record.customerType
      : undefined;
  const statusAllowsUsage = status === "active" || status === "trialing";
  const projectedUsageAllowed =
    typeof record?.usageAllowed === "boolean"
      ? record.usageAllowed
      : statusAllowsUsage;
  return {
    billingAccountId,
    status,
    usageAllowed:
      projectedUsageAllowed && statusAllowsUsage && !suspensionReason,
    ...(suspensionReason ? { suspensionReason } : {}),
    ...(customerType ? { customerType } : {}),
    ...(countryCode(record?.taxJurisdiction)
      ? { taxJurisdiction: countryCode(record?.taxJurisdiction) }
      : {}),
    ...(isoTimestamp(record?.updatedAt)
      ? { updatedAt: isoTimestamp(record?.updatedAt) }
      : {}),
  };
}

function parseCreditConfiguration(
  value: unknown,
): CommercialCreditBillingConfiguration | undefined {
  const record = objectValue(value);
  const autoRecharge = objectValue(record?.autoRecharge);
  const defaultSettings = parseAutoRecharge(autoRecharge?.defaultSettings);
  const purchaseOptionsUsdMicros = numberOptions(
    record?.purchaseOptionsUsdMicros,
  );
  const thresholdOptionsUsdMicros = numberOptions(
    autoRecharge?.thresholdOptionsUsdMicros,
  );
  const rechargeOptionsUsdMicros = numberOptions(
    autoRecharge?.rechargeOptionsUsdMicros,
  );
  const monthlyLimitOptionsUsdMicros = numberOptions(
    autoRecharge?.monthlyLimitOptionsUsdMicros,
  );
  if (
    record?.currency !== "USD" ||
    !defaultSettings ||
    purchaseOptionsUsdMicros.length === 0 ||
    thresholdOptionsUsdMicros.length === 0 ||
    rechargeOptionsUsdMicros.length === 0 ||
    monthlyLimitOptionsUsdMicros.length === 0
  ) {
    return undefined;
  }
  return {
    currency: "USD",
    purchaseOptionsUsdMicros,
    autoRecharge: {
      defaultSettings,
      thresholdOptionsUsdMicros,
      rechargeOptionsUsdMicros,
      monthlyLimitOptionsUsdMicros,
    },
  };
}

function parseCredits(value: unknown): CommercialBillingCredits | undefined {
  const record = objectValue(value);
  const autoRecharge = parseAutoRecharge(record?.autoRecharge);
  const availableUsdMicros = nonNegativeNumber(record?.availableUsdMicros);
  const reservedUsdMicros = nonNegativeNumber(record?.reservedUsdMicros);
  if (
    record?.currency !== "USD" ||
    availableUsdMicros === undefined ||
    reservedUsdMicros === undefined ||
    !autoRecharge
  ) {
    return undefined;
  }
  return {
    currency: "USD",
    availableUsdMicros,
    reservedUsdMicros,
    paymentMethodReady: record.paymentMethodReady === true,
    autoRecharge,
  };
}

function parseAutoRecharge(
  value: unknown,
): CommercialBillingAutoRechargeSettings | undefined {
  const record = objectValue(value);
  const thresholdUsdMicros = nonNegativeNumber(record?.thresholdUsdMicros);
  const rechargeUsdMicros = nonNegativeNumber(record?.rechargeUsdMicros);
  const monthlyLimitUsdMicros = nonNegativeNumber(
    record?.monthlyLimitUsdMicros,
  );
  if (
    typeof record?.enabled !== "boolean" ||
    thresholdUsdMicros === undefined ||
    rechargeUsdMicros === undefined ||
    monthlyLimitUsdMicros === undefined ||
    rechargeUsdMicros === 0 ||
    monthlyLimitUsdMicros < rechargeUsdMicros
  ) {
    return undefined;
  }
  return {
    enabled: record.enabled,
    thresholdUsdMicros,
    rechargeUsdMicros,
    monthlyLimitUsdMicros,
  };
}

function parsePayment(value: unknown): CommercialBillingPayment | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const id = tokenValue(record?.id);
  if (!id) return undefined;
  const amountMinor = nonNegativeNumber(record.amountMinor);
  const amountUsdMicros = nonNegativeNumber(record.amountUsdMicros);
  const amountRefundedMinor = nonNegativeNumber(record.amountRefundedMinor);
  const disputed =
    record.disputed === true || record.status === "disputed";
  const refunded =
    record.refunded === true ||
    record.status === "refunded" ||
    (amountMinor !== undefined &&
      amountMinor > 0 &&
      amountRefundedMinor !== undefined &&
      amountRefundedMinor >= amountMinor);
  const status: CommercialBillingPaymentStatus = disputed
    ? "disputed"
    : refunded
      ? "refunded"
      : record.status === "partially_refunded" ||
          (amountRefundedMinor !== undefined && amountRefundedMinor > 0)
        ? "partially_refunded"
        : record.status === "paid" || record.paid === true
          ? "paid"
          : record.status === "failed"
            ? "failed"
            : "unknown";
  return {
    id,
    status,
    currency: currencyCode(record?.currency) ?? "USD",
    ...(amountMinor !== undefined ? { amountMinor } : {}),
    ...(amountUsdMicros !== undefined ? { amountUsdMicros } : {}),
    ...(amountRefundedMinor !== undefined ? { amountRefundedMinor } : {}),
    ...(safeHttpsUrl(record?.receiptUrl)
      ? { receiptUrl: safeHttpsUrl(record?.receiptUrl) }
      : {}),
    ...(isoTimestamp(record?.createdAt)
      ? { createdAt: isoTimestamp(record?.createdAt) }
      : {}),
    paid: record?.paid === true,
    refunded,
    disputed,
  };
}

function parseTransaction(
  value: unknown,
): CommercialBillingTransaction | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const transactionId = tokenValue(record.transactionId);
  const status =
    record.status === "charged" || record.status === "reversed"
      ? record.status
      : undefined;
  const workspaceId = tokenValue(record.workspaceId);
  const resourceId = tokenValue(record.resourceId);
  const resourceGeneration = positiveNumber(record.resourceGeneration);
  const interfaceRevision = stringValue(record.interfaceRevision);
  const pricingActivationId = tokenValue(record.pricingActivationId);
  const meterId = stringValue(record.meterId);
  const operation = stringValue(record.operation);
  const quantity =
    typeof record.quantity === "string" &&
    /^(?:0|[1-9][0-9]*)$/.test(record.quantity)
      ? record.quantity
      : undefined;
  const unit = stringValue(record.unit);
  const amountUsdMicros = nonNegativeNumber(record.amountUsdMicros);
  const currency = currencyCode(record.currency);
  const acceptedAt = isoTimestamp(record.acceptedAt);
  const rejectedAt = isoTimestamp(record.rejectedAt);
  if (
    !transactionId ||
    !status ||
    !workspaceId ||
    !resourceId ||
    resourceGeneration === undefined ||
    !interfaceRevision ||
    !pricingActivationId ||
    !meterId ||
    !operation ||
    quantity === undefined ||
    !unit ||
    amountUsdMicros === undefined ||
    !currency ||
    !acceptedAt ||
    (status === "reversed" && !rejectedAt)
  ) {
    return undefined;
  }
  return {
    transactionId,
    status,
    workspaceId,
    resourceId,
    resourceGeneration,
    interfaceRevision,
    pricingActivationId,
    meterId,
    operation,
    quantity,
    unit,
    amountUsdMicros,
    currency,
    acceptedAt,
    ...(rejectedAt ? { rejectedAt } : {}),
  };
}

function accountStatus(value: unknown): CommercialBillingAccountStatus {
  return value === "active" ||
    value === "trialing" ||
    value === "past_due" ||
    value === "disabled"
    ? value
    : "unknown";
}

function billingSuspensionReason(
  value: unknown,
): CommercialBillingSuspensionReason | undefined {
  return value === "payment_disputed" ||
    value === "payment_past_due" ||
    value === "billing_disabled" ||
    value === "billing_suspended"
    ? value
    : undefined;
}

async function requestJson(
  url: string,
  init: Omit<RequestInit, "credentials" | "headers"> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = objectValue(objectValue(value)?.error);
    throw new Error(
      stringValue(error?.message) ??
        `billing request failed (${response.status})`,
    );
  }
  return value;
}

function endpoint(basePath: `/${string}`, action: string): string {
  const normalized = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${normalized}/${action}`;
}

function workspaceSearch(workspaceId: string): URLSearchParams {
  return new URLSearchParams({ workspaceId });
}

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" || normalized.length > MAX_TEXT_LENGTH
    ? undefined
    : normalized;
}

function tokenValue(value: unknown): string | undefined {
  const token = stringValue(value);
  return token && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(token)
    ? token
    : undefined;
}

function countryCode(value: unknown): string | undefined {
  const country = stringValue(value)?.toUpperCase();
  return country && /^[A-Z]{2}$/u.test(country) ? country : undefined;
}

function currencyCode(value: unknown): string | undefined {
  const currency = stringValue(value)?.toUpperCase();
  return currency && /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const timestamp = stringValue(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp))
    ? timestamp
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function boundedTransactionLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 25;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function cursorValue(value: unknown): string | undefined {
  const cursor = stringValue(value);
  return cursor && cursor.length <= 2_048 ? cursor : undefined;
}

function numberOptions(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .slice(0, MAX_OPTIONS)
        .map(nonNegativeNumber)
        .filter((entry): entry is number => entry !== undefined && entry > 0),
    ),
  ].sort((left, right) => left - right);
}

function safeHttpsUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function uniqueTransactions(
  values: readonly CommercialBillingTransaction[],
): readonly CommercialBillingTransaction[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.transactionId)) return false;
    seen.add(value.transactionId);
    return true;
  });
}
