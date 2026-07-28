/**
 * Provider-neutral client contract for an optional commercial billing
 * extension. The dashboard owns presentation; an operator extension owns
 * prices, payment-provider integration, tax policy, and billing records.
 */

export type CommercialBillingCustomerType = "individual" | "business";

export interface CommercialBillingPlan {
  readonly id: string;
  readonly kind: string;
  readonly name: Readonly<Record<string, string>>;
  readonly priceDisplay: Readonly<Record<string, string>>;
  readonly monthlyPriceUsdMicros?: number;
}

export interface CommercialBillingCatalog {
  readonly plans: readonly CommercialBillingPlan[];
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

export interface CommercialBillingSubscription {
  readonly id: string;
  readonly status: string;
  readonly planId: string;
  readonly currentPeriodEnd?: string;
  readonly cancelAtPeriodEnd: boolean;
}

export interface CommercialBillingInvoice {
  readonly id: string;
  readonly number?: string;
  readonly status: string;
  readonly currency: string;
  readonly amountPaidMinor?: number;
  readonly amountDueMinor?: number;
  readonly totalMinor?: number;
  readonly amountPaidUsdMicros?: number;
  readonly amountDueUsdMicros?: number;
  readonly totalUsdMicros?: number;
  readonly hostedInvoiceUrl?: string;
  readonly invoicePdfUrl?: string;
  readonly createdAt?: string;
  readonly paid: boolean;
}

export interface CommercialBillingSummary {
  readonly configured: boolean;
  readonly account?: CommercialBillingAccount;
  readonly subscription?: CommercialBillingSubscription;
  readonly invoices: readonly CommercialBillingInvoice[];
}

export interface CommercialBillingSnapshot {
  readonly catalog: CommercialBillingCatalog;
  readonly billing: CommercialBillingSummary;
}

const MAX_CATALOG_PLANS = 64;
const MAX_INVOICES = 100;
const MAX_LOCALIZED_STRINGS = 16;
const MAX_TEXT_LENGTH = 1_024;

interface CommercialBillingRequest {
  readonly basePath: `/${string}`;
  readonly workspaceId: string;
}

interface CommercialBillingCheckoutRequest extends CommercialBillingRequest {
  readonly planId: string;
  readonly customerType: CommercialBillingCustomerType;
  readonly country: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export async function loadCommercialBilling(
  input: CommercialBillingRequest,
): Promise<CommercialBillingSnapshot> {
  const workspaceQuery = workspaceSearch(input.workspaceId);
  const [catalog, summary] = await Promise.all([
    requestJson(endpoint(input.basePath, "plans")),
    requestJson(
      `${endpoint(input.basePath, "summary")}?${workspaceQuery.toString()}`,
    ),
  ]);
  return {
    catalog: parseCommercialBillingCatalog(catalog),
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
        planId: input.planId,
        customerType: input.customerType,
        country: input.country,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      }),
    },
  );
  return commercialBillingDestination(value);
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

export function parseCommercialBillingCatalog(
  value: unknown,
): CommercialBillingCatalog {
  const record = objectValue(value);
  const rawPlans = Array.isArray(record?.plans) ? record.plans : [];
  const plans = uniqueById(
    rawPlans
      .slice(0, MAX_CATALOG_PLANS)
      .map(parsePlan)
      .filter((plan): plan is CommercialBillingPlan => plan !== undefined),
  );
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
    plans,
    ...(version ? { countryMatrix: { version, supportedCountries } } : {}),
  };
}

export function parseCommercialBillingSummary(
  value: unknown,
): CommercialBillingSummary {
  const root = objectValue(value);
  const billing = objectValue(root?.billing);
  const rawInvoices = Array.isArray(billing?.invoices) ? billing.invoices : [];
  const account = parseAccount(billing?.account);
  const subscription = parseSubscription(billing?.subscription);
  return {
    configured: billing?.configured === true,
    ...(account ? { account } : {}),
    ...(subscription ? { subscription } : {}),
    invoices: uniqueById(
      rawInvoices
        .slice(0, MAX_INVOICES)
        .map(parseInvoice)
        .filter(
          (invoice): invoice is CommercialBillingInvoice =>
            invoice !== undefined,
        ),
    ),
  };
}

export function localizedCommercialBillingText(
  values: Readonly<Record<string, string>>,
  locale: string,
  fallback: string,
): string {
  const language = locale.split("-")[0];
  return (
    stringValue(values[locale]) ??
    (language ? stringValue(values[language]) : undefined) ??
    stringValue(values.en) ??
    Object.values(values).map(stringValue).find(Boolean) ??
    fallback
  );
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

function parsePlan(value: unknown): CommercialBillingPlan | undefined {
  const record = objectValue(value);
  const id = tokenValue(record?.id);
  if (!id) return undefined;
  const kind = tokenValue(record?.kind) ?? "subscription";
  return {
    id,
    kind,
    name: localizedStrings(record?.name, id),
    priceDisplay: localizedStrings(record?.priceDisplay),
    ...(safeNumber(record?.monthlyPriceUsdMicros) !== undefined
      ? { monthlyPriceUsdMicros: safeNumber(record?.monthlyPriceUsdMicros) }
      : {}),
  };
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

function parseSubscription(
  value: unknown,
): CommercialBillingSubscription | undefined {
  const record = objectValue(value);
  const id = tokenValue(record?.id);
  const planId = tokenValue(record?.planId);
  if (!id || !planId) return undefined;
  return {
    id,
    status: tokenValue(record?.status) ?? "unknown",
    planId,
    ...(isoTimestamp(record?.currentPeriodEnd)
      ? { currentPeriodEnd: isoTimestamp(record?.currentPeriodEnd) }
      : {}),
    cancelAtPeriodEnd: record?.cancelAtPeriodEnd === true,
  };
}

function parseInvoice(value: unknown): CommercialBillingInvoice | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const id = tokenValue(record?.id);
  if (!id) return undefined;
  return {
    id,
    ...(stringValue(record?.number)
      ? { number: stringValue(record?.number) }
      : {}),
    status: tokenValue(record?.status) ?? "unknown",
    currency: currencyCode(record?.currency) ?? "USD",
    ...optionalNumber(record, "amountPaidMinor"),
    ...optionalNumber(record, "amountDueMinor"),
    ...optionalNumber(record, "totalMinor"),
    ...optionalNumber(record, "amountPaidUsdMicros"),
    ...optionalNumber(record, "amountDueUsdMicros"),
    ...optionalNumber(record, "totalUsdMicros"),
    ...(safeHttpsUrl(record?.hostedInvoiceUrl)
      ? { hostedInvoiceUrl: safeHttpsUrl(record?.hostedInvoiceUrl) }
      : {}),
    ...(safeHttpsUrl(record?.invoicePdfUrl)
      ? { invoicePdfUrl: safeHttpsUrl(record?.invoicePdfUrl) }
      : {}),
    ...(isoTimestamp(record?.createdAt)
      ? { createdAt: isoTimestamp(record?.createdAt) }
      : {}),
    paid: record?.paid === true,
  };
}

function optionalNumber(
  record: Readonly<Record<string, unknown>>,
  key:
    | "amountPaidMinor"
    | "amountDueMinor"
    | "totalMinor"
    | "amountPaidUsdMicros"
    | "amountDueUsdMicros"
    | "totalUsdMicros",
): Partial<Record<typeof key, number>> {
  const value = safeNumber(record[key]);
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

function localizedStrings(
  value: unknown,
  fallback?: string,
): Readonly<Record<string, string>> {
  const record = objectValue(value);
  const result: Record<string, string> = {};
  for (const [locale, text] of Object.entries(record ?? {}).slice(
    0,
    MAX_LOCALIZED_STRINGS,
  )) {
    if (!/^[A-Za-z0-9-]{2,35}$/u.test(locale)) continue;
    const normalized = stringValue(text);
    if (normalized) result[locale] = normalized;
  }
  if (Object.keys(result).length === 0 && fallback) result.en = fallback;
  return result;
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

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
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
