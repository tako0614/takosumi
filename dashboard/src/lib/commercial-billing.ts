/**
 * Provider-neutral client contract for an optional commercial billing
 * extension. The dashboard owns presentation; an operator extension owns
 * prices, payment-provider integration, tax policy, and billing records.
 */

export type CommercialBillingCustomerType = "individual" | "business";

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
  readonly status: string;
  readonly customerType?: CommercialBillingCustomerType;
  readonly taxJurisdiction?: string;
  readonly updatedAt?: string;
}

export interface CommercialBillingCredits {
  readonly currency: "USD";
  readonly availableUsdMicros: number;
  readonly reservedUsdMicros: number;
  readonly purchasedUsdMicros: number;
  readonly paymentMethodReady: boolean;
  readonly autoRecharge: CommercialBillingAutoRechargeSettings;
}

export interface CommercialBillingPayment {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly amountMinor?: number;
  readonly amountUsdMicros?: number;
  readonly amountRefundedMinor?: number;
  readonly receiptUrl?: string;
  readonly createdAt?: string;
  readonly paid: boolean;
  readonly refunded: boolean;
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
  const customerType =
    record?.customerType === "individual" || record?.customerType === "business"
      ? record.customerType
      : undefined;
  return {
    billingAccountId,
    status: tokenValue(record?.status) ?? "unknown",
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
  const purchasedUsdMicros = nonNegativeNumber(record?.purchasedUsdMicros);
  if (
    record?.currency !== "USD" ||
    availableUsdMicros === undefined ||
    reservedUsdMicros === undefined ||
    purchasedUsdMicros === undefined ||
    !autoRecharge
  ) {
    return undefined;
  }
  return {
    currency: "USD",
    availableUsdMicros,
    reservedUsdMicros,
    purchasedUsdMicros,
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
  return {
    id,
    status: tokenValue(record?.status) ?? "unknown",
    currency: currencyCode(record?.currency) ?? "USD",
    ...optionalNumber(record, "amountMinor"),
    ...optionalNumber(record, "amountUsdMicros"),
    ...optionalNumber(record, "amountRefundedMinor"),
    ...(safeHttpsUrl(record?.receiptUrl)
      ? { receiptUrl: safeHttpsUrl(record?.receiptUrl) }
      : {}),
    ...(isoTimestamp(record?.createdAt)
      ? { createdAt: isoTimestamp(record?.createdAt) }
      : {}),
    paid: record?.paid === true,
    refunded: record?.refunded === true,
  };
}

function optionalNumber(
  record: Readonly<Record<string, unknown>>,
  key: "amountMinor" | "amountUsdMicros" | "amountRefundedMinor",
): Partial<Record<typeof key, number>> {
  const value = nonNegativeNumber(record[key]);
  return value === undefined ? {} : { [key]: value };
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
