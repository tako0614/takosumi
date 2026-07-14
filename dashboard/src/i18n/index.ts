/**
 * Hand-rolled EN/JA i18n for the dashboard (no library dependency).
 *
 * - `ja.ts` is the master dictionary; `en.ts` is type-forced to the same key
 *   set, so the locales cannot drift (see also the parity test).
 * - `t(key, params?)` reads the reactive `locale` signal, so JSX rendered
 *   through it re-renders when the visitor switches language.
 * - Initial locale: localStorage("tg_lang") → navigator.language (ja* → ja,
 *   otherwise en). `setLocale` persists and updates `<html lang>`.
 * - Date/time formatting lives here too so every screen renders timestamps the
 *   same way for the active locale (one absolute format + one relative format —
 *   the dashboard previously had four).
 */
import { createSignal } from "solid-js";
import { ja } from "./ja.ts";
import { en } from "./en.ts";
import { dashboardProductName } from "../lib/runtime-capabilities.ts";

export type Locale = "ja" | "en";
export type MessageKey = keyof typeof ja;

const STORAGE_KEY = "tg_lang";

function detectLocale(): Locale {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "ja" || stored === "en") return stored;
  }
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.language === "string" &&
    navigator.language.toLowerCase().startsWith("ja")
  ) {
    return "ja";
  }
  return "en";
}

const [locale, setLocaleSignal] = createSignal<Locale>(detectLocale());
export { locale };

if (typeof document !== "undefined") {
  document.documentElement.lang = locale();
}

export function setLocale(next: Locale): void {
  setLocaleSignal(next);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, next);
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
}

const DICTS: Record<Locale, Record<MessageKey, string>> = { ja, en };

/** Translate a key with optional `{param}` interpolation. */
export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const raw = DICTS[locale()][key] ?? ja[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Set the document title in the canonical "<page> — product" pattern. */
export function setDocumentTitle(page: string): void {
  if (typeof document !== "undefined") {
    document.title = `${page} — ${dashboardProductName()}`;
  }
}

// --- timestamps --------------------------------------------------------------

const INTL_LOCALE: Record<Locale, string> = { ja: "ja-JP", en: "en-US" };

/** BCP-47 tag for the active locale — the single Intl mapping for view-local
 * formatters (adding a locale must not require hunting per-view copies). */
export function intlLocale(): string {
  return INTL_LOCALE[locale()];
}

/** Absolute date+time for the active locale; falls back to the raw value. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale()], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(time);
}

/** Date only (for feeds / history rows older than a week). */
export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale()], {
    dateStyle: "medium",
  }).format(time);
}

/** Relative time ("たった今" / "5m ago"), date once it is over a week old. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 45) return t("common.justNow");
  if (diffSec < 3600)
    return t("common.minutesAgo", { n: Math.round(diffSec / 60) });
  if (diffSec < 86400)
    return t("common.hoursAgo", { n: Math.round(diffSec / 3600) });
  if (diffSec < 86400 * 7)
    return t("common.daysAgo", { n: Math.round(diffSec / 86400) });
  return formatDate(iso);
}
