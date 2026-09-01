/**
 * TCS store servers the dashboard queries. An operator configures one
 * canonical discovery server at RUNTIME via `TAKOSUMI_TCS_STORE_URL` (served
 * through product discovery — see runtime-capabilities.ts), with the
 * build-time VITE_TAKOSUMI_TCS_STORE_URL kept only as the Cloud build's
 * fallback. OSS selects no hosted store implicitly; users can add additional
 * servers through localStorage.
 */
import { runtimeStoreUrl } from "./runtime-capabilities.ts";

const LS_KEY = "tcs.stores";

/**
 * Resolve the canonical store from operator configuration. Unset falls back to
 * no store; an explicitly empty value also means no default store.
 */
export function resolveDefaultStoreUrl(configured: string | undefined): string {
  return (configured ?? "").trim();
}

/**
 * Build-time fallback store. Empty means no build-time default store.
 */
export const DEFAULT_STORE_URL = resolveDefaultStoreUrl(
  import.meta.env.VITE_TAKOSUMI_TCS_STORE_URL,
);

/**
 * Canonical store for THIS deployment: the runtime-configured endpoint wins
 * over the build-time fallback. Empty means no default store.
 */
export function defaultStoreUrl(): string {
  return resolveDefaultStoreUrl(runtimeStoreUrl()) || DEFAULT_STORE_URL;
}

export interface TcsServer {
  readonly base: string;
  readonly isDefault: boolean;
}

export function normalizeBase(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.toLowerCase();
  }
}

function readUserServers(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as unknown;
    return Array.isArray(raw)
      ? (raw as string[]).filter((s) => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

function writeUserServers(servers: string[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(servers));
  } catch {
    /* ignore */
  }
}

export function getTcsServers(): TcsServer[] {
  const def = normalizeBase(defaultStoreUrl());
  const users = readUserServers()
    .map(normalizeBase)
    .filter((b) => b && (!def || b !== def));
  const seen = new Set<string>();
  const out: TcsServer[] = def ? [{ base: def, isDefault: true }] : [];
  if (def) seen.add(def);
  for (const b of users) {
    if (seen.has(b)) continue;
    seen.add(b);
    out.push({ base: b, isDefault: false });
  }
  return out;
}

/** Validate + add a user store server. Returns the normalized base, or null. */
export function addTcsServer(raw: string): string | null {
  const base = normalizeBase(raw);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const def = normalizeBase(defaultStoreUrl());
  if (def && base === def) return base;
  const users = readUserServers().map(normalizeBase);
  if (!users.includes(base)) writeUserServers([...users, base]);
  return base;
}

export function removeTcsServer(raw: string): void {
  const base = normalizeBase(raw);
  writeUserServers(
    readUserServers()
      .map(normalizeBase)
      .filter((b) => b !== base),
  );
}
