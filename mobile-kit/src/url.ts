import type {
  MobileHostCenterSource,
  MobileHostableProductKind,
  MobileProductKind,
  MobileSession,
  NativeBridge,
} from "./types.ts";
import { createTakosumiAppHandoffUrl } from "../../contract/app-handoff.ts";
import { requireMobileProductKey } from "./product-key.ts";

export function normalizeHostUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Host URL is required.");

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  const url = requireSecureWebUrl(withScheme, "Host URL");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function requireSecureWebUrl(input: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      `${label} must use https except for loopback development hosts.`,
    );
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function hostEndpoint(hostUrl: string, path: string): string {
  const origin = normalizeHostUrl(hostUrl);
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) {
    throw new Error("Host endpoint must stay on the connected host.");
  }
  return url.toString();
}

export function createMobileHostRouteUrl(
  session: MobileSession,
  routePath: string,
): string {
  if (!routePath.startsWith("/") || routePath.startsWith("//")) {
    throw new Error("Host route path must be an absolute same-origin path.");
  }
  const origin = normalizeHostUrl(session.hostUrl);
  const url = new URL(routePath, `${origin}/`);
  if (url.origin !== origin) {
    throw new Error("Host route path must stay on the connected host.");
  }
  return url.toString();
}

export async function openMobileHostRoute(
  nativeBridge: NativeBridge,
  session: MobileSession,
  routePath: string,
): Promise<void> {
  await nativeBridge.openExternalUrl(
    createMobileHostRouteUrl(session, routePath),
  );
}

export function createTakosumiHostCenterUrl(input: {
  readonly hostCenterUrl: string;
  readonly product: MobileHostableProductKind;
  readonly source: MobileHostCenterSource;
  readonly returnUri: string;
}): string {
  return createTakosumiAppHandoffUrl({
    baseUrl: input.hostCenterUrl,
    ...input.source,
    product: requireMobileProductKey(input.product, "Host Center product"),
    returnUri: input.returnUri,
  });
}

export function createMobileConnectUrl(input: {
  readonly scheme: string;
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly setupTicket?: string;
}): string {
  const url = new URL(`${input.scheme}://connect`);
  url.searchParams.set("host_url", normalizeHostUrl(input.hostUrl));
  url.searchParams.set("product", input.product);
  if (input.setupTicket)
    url.searchParams.set("setup_ticket", input.setupTicket);
  return url.toString();
}
