/**
 * Optional TCS store servers the dashboard queries in addition to the official
 * starter catalog. Do not hard-code a placeholder public store: a missing DNS
 * record makes production look broken. Operators can enable a canonical store
 * with VITE_TAKOSUMI_TCS_STORE_URL; local dev can still add stores through
 * localStorage.
 */
const LS_KEY = "tcs.stores";

/** Optional canonical Takosumi store. Empty means official catalog only. */
export const DEFAULT_STORE_URL = (
  import.meta.env.VITE_TAKOSUMI_TCS_STORE_URL ?? ""
).trim();

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
  const def = normalizeBase(DEFAULT_STORE_URL);
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
  const def = normalizeBase(DEFAULT_STORE_URL);
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
