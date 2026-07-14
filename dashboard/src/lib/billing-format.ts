import { locale } from "../i18n/index.ts";
import type { UsageEvent } from "./control-api.ts";

export function formatBillingNumber(value: number): string {
  return new Intl.NumberFormat(locale() === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: 3,
  }).format(value);
}

export function formatUsdMicros(value: number): string {
  return new Intl.NumberFormat(locale() === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value % 10_000 === 0 ? 2 : 6,
  }).format(value / 1_000_000);
}

export function usageUsdMicros(event: Pick<UsageEvent, "usdMicros">): number {
  return event.usdMicros;
}
