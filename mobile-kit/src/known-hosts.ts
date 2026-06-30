import type {
  HostDiscovery,
  MobileKnownHost,
  MobileProductAdapter,
  MobileSession,
  NativeBridge,
} from "./types.ts";
import { normalizeHostUrl } from "./url.ts";

const knownHostsLimit = 8;

export interface MobileKnownHostsStorageInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}

export interface RememberMobileKnownHostInput
  extends MobileKnownHostsStorageInput {
  readonly host: HostDiscovery | MobileSession | MobileKnownHost;
  readonly now?: () => Date;
}

export function mobileKnownHostsStorageKey(
  adapter: MobileProductAdapter,
): string {
  return `takosumi.mobile.${adapter.product}.known-hosts`;
}

export async function loadMobileKnownHosts(
  input: MobileKnownHostsStorageInput,
): Promise<readonly MobileKnownHost[]> {
  const store = input.nativeBridge.storage;
  if (!store) return [];
  const raw = await store.get(mobileKnownHostsStorageKey(input.adapter));
  if (!raw) return [];
  try {
    return normalizeKnownHosts(JSON.parse(raw), input.adapter);
  } catch {
    return [];
  }
}

export async function rememberMobileKnownHost(
  input: RememberMobileKnownHostInput,
): Promise<readonly MobileKnownHost[]> {
  const store = input.nativeBridge.storage;
  if (!store) return [];
  const current = await loadMobileKnownHosts(input);
  const remembered = normalizeKnownHost(input.host, input.adapter, input.now);
  const next = [
    remembered,
    ...current.filter((host) => host.hostUrl !== remembered.hostUrl),
  ].slice(0, knownHostsLimit);
  await store.set(mobileKnownHostsStorageKey(input.adapter), JSON.stringify(next));
  return next;
}

function normalizeKnownHosts(
  value: unknown,
  adapter: MobileProductAdapter,
): readonly MobileKnownHost[] {
  if (!Array.isArray(value)) return [];
  const hosts = value
    .map((host) => normalizeKnownHostOrUndefined(host, adapter))
    .filter((host): host is MobileKnownHost => Boolean(host));
  const deduped = new Map<string, MobileKnownHost>();
  for (const host of hosts) {
    if (!deduped.has(host.hostUrl)) deduped.set(host.hostUrl, host);
  }
  return [...deduped.values()]
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, knownHostsLimit);
}

function normalizeKnownHostOrUndefined(
  value: unknown,
  adapter: MobileProductAdapter,
): MobileKnownHost | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    return normalizeKnownHost(value as Partial<MobileKnownHost>, adapter);
  } catch {
    return undefined;
  }
}

function normalizeKnownHost(
  value: HostDiscovery | MobileSession | Partial<MobileKnownHost>,
  adapter: MobileProductAdapter,
  now?: () => Date,
): MobileKnownHost {
  const product = value.product ?? adapter.product;
  if (product !== adapter.product) {
    throw new Error("Known host product mismatch.");
  }
  const lastSeenAt = getOptionalString(value, "lastSeenAt");
  const label = getOptionalString(value, "label");
  return {
    hostUrl: normalizeHostUrl(value.hostUrl ?? ""),
    product: adapter.product,
    oidcIssuer:
      typeof value.oidcIssuer === "string" ? value.oidcIssuer : undefined,
    lastSeenAt: lastSeenAt ?? (now?.() ?? new Date()).toISOString(),
    label,
  };
}

function getOptionalString(
  value: object,
  key: "label" | "lastSeenAt",
): string | undefined {
  const record = value as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : undefined;
}
