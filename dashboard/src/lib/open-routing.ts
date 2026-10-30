/**
 * How the dashboard opens an app's screen on this device (TASK-0119 step 4;
 * takos-control `docs/platform/takosumi-app-clients.md`, 「3. 開き方の決め方」).
 *
 * A screen may declare native phone apps (`screens[].clients` of
 * `GET /capsules/:id/app`, parsed and verified by the server against the
 * operator's trusted native clients). On a computer the screen always opens
 * in a new tab. On a phone the choice is, in order:
 *
 * 1. what this device remembered for this app's screen;
 * 2. the declaration's default (`preferred: "native"`), only for a verified
 *    client of this phone's platform;
 * 3. otherwise the web.
 *
 * A browser cannot tell whether a native app is installed, so:
 *
 * - Android: the dashboard builds an `intent:` link pinned to the client's
 *   `package`, with `S.browser_fallback_url` back to this app's chooser on
 *   the app page. A declaration never supplies `intent:` (the server refuses
 *   that scheme) and never chooses the package the link is pinned to beyond
 *   the one it declared.
 * - iPhone: a universal link is a plain link the person taps (a scripted
 *   navigation may not count as one). A custom scheme makes Safari show
 *   "address is invalid" when nothing handles it, so it opens directly only
 *   after the person chose and remembered that app; until then the chooser
 *   is shown.
 *
 * Unverified clients are never opened without asking, never a default, and
 * never remembered: the chooser shows their real destination (`target`) and
 * asks for an explicit confirmation each time.
 *
 * The links come filled in from the server (their only value is the screen's
 * public, credential-free URL or origin); this module never substitutes
 * anything into them. It re-checks them anyway, so a malformed API value can
 * not turn into a script, a credential-carrying link or an extra intent field.
 *
 * Everything here is pure; `open-choice-state.ts` binds it to the browser.
 */
import {
  hasCredentialQueryParams,
  INTERFACE_CLIENT_BLOCKED_SCHEMES,
  INTERFACE_CLIENT_LINK_MAX_LENGTH,
  INTERFACE_CLIENT_NAME_MAX_LENGTH,
} from "takosumi-contract";
import { detectPhonePlatform, type PhonePlatform } from "./phone-use.ts";

/** Where the dashboard runs: a computer, an iPhone/iPad, or an Android phone. */
export type OpenPlatform = "desktop" | PhonePlatform;

/** The parts of `navigator` platform detection reads; injected in tests. */
export interface OpenPlatformEnvironment {
  readonly userAgent?: string;
  readonly maxTouchPoints?: number;
  /** User-Agent Client Hints (`navigator.userAgentData.platform`), where the browser has them. */
  readonly clientHintPlatform?: string;
}

/**
 * The platform this page runs on. A Client Hint saying Android is enough on
 * its own; otherwise the user agent decides iPhone, iPad (whose desktop-mode
 * agent says Macintosh, told apart by touch) or Android. Anything else is a
 * computer, which keeps opening screens in a new tab.
 */
export function detectOpenPlatform(env: OpenPlatformEnvironment): OpenPlatform {
  if (env.clientHintPlatform?.trim().toLowerCase() === "android") return "android";
  return detectPhonePlatform({
    userAgent: env.userAgent ?? "",
    ...(env.maxTouchPoints !== undefined ? { maxTouchPoints: env.maxTouchPoints } : {}),
  }) ?? "desktop";
}

// --- the declared native client of one platform ------------------------------------

/** Where an unverified client's links really go, shown before it opens. */
export interface PhoneClientTarget {
  readonly package?: string;
  readonly scheme?: string;
  readonly host?: string;
}

/**
 * One platform's native client, re-checked for opening from a browser.
 * `link` is the universal link (iOS) or App Link (Android).
 */
export interface PhoneClient {
  readonly platform: PhonePlatform;
  /** True only when the server verified it AND named the trusted client. */
  readonly verified: boolean;
  /** The trusted client a remembered "native" choice is bound to. */
  readonly trustedClientId?: string;
  /** Verified: the trusted name. Unverified: the checked declared name, if any. */
  readonly name?: string;
  readonly target: PhoneClientTarget;
  readonly open?: string;
  readonly link?: string;
  /** Android: the only app the links can reach. */
  readonly package?: string;
  readonly storeUrl?: string;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u;
const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const TRUSTED_CLIENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
/** Printable ASCII without space or the characters never valid in a URL. */
const LINK_TEXT = /^[\x21-\x7e]+$/u;
const LINK_FORBIDDEN = /["<>\\^`|{}]/u;
const STORE_HOSTS: ReadonlySet<string> = new Set([
  "apps.apple.com",
  "testflight.apple.com",
  "play.google.com",
  "f-droid.org",
]);

/**
 * The native client a screen declares for `platform`, or undefined on a
 * computer, without a declaration, or when nothing in it can be opened.
 */
export function phoneClient(clients: unknown, platform: OpenPlatform): PhoneClient | undefined {
  if (platform === "desktop" || !isRecord(clients)) return undefined;
  const value = clients[platform];
  if (!isRecord(value)) return undefined;
  const packageName = platform === "android" ? androidPackage(value.package) : undefined;
  if (platform === "android" && !packageName) return undefined;
  const open = customSchemeLink(value.open);
  const link = httpsLink(platform === "ios" ? value.universalLink : value.appLink);
  if (!open && !link) return undefined;
  const trustedClientId = typeof value.trustedClientId === "string" &&
      TRUSTED_CLIENT_ID_PATTERN.test(value.trustedClientId)
    ? value.trustedClientId
    : undefined;
  const verified = value.verified === true && trustedClientId !== undefined;
  const name = clientName(value.name);
  const storeUrl = storeLink(value.storeUrl);
  return {
    platform,
    verified,
    ...(verified ? { trustedClientId } : {}),
    ...(name !== undefined ? { name } : {}),
    // Derived from the links that are opened, not copied from the API, so
    // what the person confirms is exactly where the link goes.
    target: {
      ...(packageName ? { package: packageName } : {}),
      ...(open ? { scheme: open.slice(0, open.indexOf(":")) } : {}),
      ...(link ? { host: new URL(link).hostname } : {}),
    },
    ...(open ? { open } : {}),
    ...(link ? { link } : {}),
    ...(packageName ? { package: packageName } : {}),
    ...(storeUrl ? { storeUrl } : {}),
  };
}

/** Every declared platform's client, for listing them on a computer. */
export function declaredPhoneClients(clients: unknown): readonly PhoneClient[] {
  return (["ios", "android"] as const)
    .map((platform) => phoneClient(clients, platform))
    .filter((client): client is PhoneClient => client !== undefined);
}

/** Whether the declaration asks for its native app by default. */
export function prefersNative(clients: unknown): boolean {
  return isRecord(clients) && clients.preferred === "native";
}

function androidPackage(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 155 && ANDROID_PACKAGE_PATTERN.test(value)
    ? value
    : undefined;
}

function clientName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  // The server already checked the name; refuse control and format
  // characters again so a malformed value cannot reorder the label.
  return name && name.length <= INTERFACE_CLIENT_NAME_MAX_LENGTH && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
    ? name
    : undefined;
}

function linkText(value: unknown): string | undefined {
  return typeof value === "string" &&
      value.length <= INTERFACE_CLIENT_LINK_MAX_LENGTH &&
      LINK_TEXT.test(value) &&
      !LINK_FORBIDDEN.test(value)
    ? value
    : undefined;
}

/**
 * A custom-scheme link: an allowed scheme, no fragment (the Android link
 * appends `#Intent;…;end`), no user info, no credential-named parameter.
 */
function customSchemeLink(value: unknown): string | undefined {
  const text = linkText(value);
  if (!text) return undefined;
  const colon = text.indexOf(":");
  const scheme = colon < 0 ? "" : text.slice(0, colon);
  if (!SCHEME_PATTERN.test(scheme) || INTERFACE_CLIENT_BLOCKED_SCHEMES.has(scheme)) return undefined;
  if (text.length === colon + 1 || text.includes("#")) return undefined;
  const url = parsedUrl(text);
  if (!url || url.protocol !== `${scheme}:` || url.username || url.password) return undefined;
  if (hasCredentialQueryParams(url.searchParams)) return undefined;
  return text;
}

/**
 * A universal link / App Link: https on the default port of a named host,
 * no user info and no credential-named parameter in the query or after `#`.
 */
function httpsLink(value: unknown): string | undefined {
  const text = linkText(value);
  if (!text || !text.startsWith("https://")) return undefined;
  const url = parsedUrl(text);
  if (!url || url.protocol !== "https:" || url.port !== "" || url.username || url.password) return undefined;
  if (!HOST_PATTERN.test(url.hostname) || !url.hostname.includes(".")) return undefined;
  if (hasCredentialQueryParams(url.searchParams)) return undefined;
  if (url.hash && hasCredentialQueryParams(new URLSearchParams(url.hash.slice(1)))) return undefined;
  return text;
}

function storeLink(value: unknown): string | undefined {
  const text = linkText(value);
  if (!text || !text.startsWith("https://")) return undefined;
  const url = parsedUrl(text);
  return url && url.protocol === "https:" && url.port === "" && !url.username && !url.password &&
      !url.hash && STORE_HOSTS.has(url.hostname)
    ? text
    : undefined;
}

// --- the link that hands the screen to the native app ------------------------------

/**
 * The Android link to `client`: an `intent:` link pinned to its package, from
 * its custom-scheme link (or, without one, its App Link), with Chrome's
 * `S.browser_fallback_url` set to `fallbackUrl` (an absolute http(s) URL of
 * the app's chooser) for when the app is missing.
 *
 * ```text
 * intent://connect?host_url=…#Intent;scheme=yurucommu;package=com.yurucommu;S.browser_fallback_url=…;end
 * ```
 */
export function androidIntentUrl(client: PhoneClient, fallbackUrl: string): string | undefined {
  if (client.platform !== "android" || !client.package || !ANDROID_PACKAGE_PATTERN.test(client.package)) {
    return undefined;
  }
  const fallback = parsedUrl(fallbackUrl);
  if (!fallback || (fallback.protocol !== "https:" && fallback.protocol !== "http:")) return undefined;
  if (fallback.username || fallback.password) return undefined;
  const source = client.open ?? client.link;
  if (!source) return undefined;
  const colon = source.indexOf(":");
  const scheme = source.slice(0, colon);
  const data = source.slice(colon + 1);
  // `#Intent;` must be the link's only fragment marker, so the extras are
  // exactly the ones written here. An App Link may keep one fragment of its
  // own (Android reads the last `#`), without a `;` that could look like an
  // extra.
  const hash = data.indexOf("#");
  if (hash >= 0 && (scheme !== "https" || data.includes("#", hash + 1) || data.includes(";", hash))) {
    return undefined;
  }
  return `intent:${data}#Intent;scheme=${scheme};package=${client.package};` +
    `S.browser_fallback_url=${encodeURIComponent(fallback.href)};end`;
}

/**
 * The iPhone link to `client`: its universal link, or its custom-scheme link
 * when `allowScheme` (the person chose this app, now or remembered).
 */
export function iosNativeHref(client: PhoneClient, allowScheme: boolean): string | undefined {
  if (client.platform !== "ios") return undefined;
  if (client.link) return client.link;
  return allowScheme ? client.open : undefined;
}

/**
 * The link that opens `client` once the person has chosen it: Android's
 * `intent:` link, or iPhone's universal link or custom scheme.
 */
export function chosenNativeHref(client: PhoneClient, fallbackUrl: string | undefined): string | undefined {
  if (client.platform === "android") {
    return fallbackUrl === undefined ? undefined : androidIntentUrl(client, fallbackUrl);
  }
  return iosNativeHref(client, true);
}

// --- what this device remembered ---------------------------------------------------

/**
 * A remembered choice for one app's screen on this device. "native" is bound
 * to the verified trusted client it was chosen for and to where its link went
 * then (Android package, scheme, link host), so a declaration that later names
 * another app, loses its verification, or now opens somewhere else (an
 * operator changed the trusted entry) is asked about again.
 */
export type RememberedOpenChoice =
  | { readonly choice: "web" }
  | {
    readonly choice: "native";
    readonly platform: PhonePlatform;
    readonly trustedClientId: string;
    readonly target: PhoneClientTarget;
  };

/** The browser storage a choice is kept in (`localStorage`); injected in tests. */
export interface OpenChoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = "takosumi.openChoice.v1";
/** The key `openChoiceStorageWorks` writes and removes; never a choice. */
const PROBE_KEY = `${STORAGE_PREFIX}:probe`;

/**
 * Whether a `storage` event (another tab's write) can change a remembered
 * choice: a cleared storage (`key === null`) or a choice key. The probe key
 * and every other key are ignored, so tabs never wake each other for writes
 * that remember nothing.
 */
export function isOpenChoiceStorageKey(key: string | null): boolean {
  return key === null || (key.startsWith(`${STORAGE_PREFIX}:`) && key !== PROBE_KEY);
}

/**
 * The storage key of one app's screen. `localStorage` is per origin, so the
 * key is already per Takosumi instance; the app (Capsule) and the screen
 * (Interface) complete it. Nothing is sent to the server.
 */
export function openChoiceStorageKey(capsuleId: string, interfaceId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(capsuleId)}:${encodeURIComponent(interfaceId)}`;
}

/**
 * The choice to remember for `choice`, or undefined when it may not be
 * remembered: "native" only for a verified client (an unverified one is
 * confirmed every time), and nothing on a computer.
 */
export function rememberableChoice(
  choice: "web" | "native",
  client: PhoneClient | undefined,
  platform: OpenPlatform,
): RememberedOpenChoice | undefined {
  if (platform === "desktop") return undefined;
  if (choice === "web") return { choice: "web" };
  if (!client || client.platform !== platform || !client.verified || !client.trustedClientId) return undefined;
  return { choice: "native", platform, trustedClientId: client.trustedClientId, target: client.target };
}

/**
 * Whether a remembered "native" choice still names `client`: the same
 * platform, the same verified trusted client, and the same destination.
 */
export function rememberedNativeMatches(
  remembered: RememberedOpenChoice | undefined,
  client: PhoneClient | undefined,
): boolean {
  return remembered?.choice === "native" &&
    client !== undefined &&
    client.verified &&
    remembered.platform === client.platform &&
    remembered.trustedClientId === client.trustedClientId &&
    remembered.target.package === client.target.package &&
    remembered.target.scheme === client.target.scheme &&
    remembered.target.host === client.target.host;
}

/** A remembered destination: only the known fields, each well formed, at least one. */
function rememberedTarget(value: unknown, platform: PhonePlatform): PhoneClientTarget | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "package" && key !== "scheme" && key !== "host")) {
    return undefined;
  }
  const { package: packageName, scheme, host } = value;
  if (packageName !== undefined && (typeof packageName !== "string" || !ANDROID_PACKAGE_PATTERN.test(packageName))) {
    return undefined;
  }
  if (scheme !== undefined && (typeof scheme !== "string" || !SCHEME_PATTERN.test(scheme))) return undefined;
  if (host !== undefined && (typeof host !== "string" || !HOST_PATTERN.test(host))) return undefined;
  if (scheme === undefined && host === undefined) return undefined;
  // Android links are always pinned to a package; iOS has none.
  if ((platform === "android") !== (packageName !== undefined)) return undefined;
  return {
    ...(packageName !== undefined ? { package: packageName } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

/** The remembered choice, or undefined when none is kept or storage fails. */
export function readOpenChoice(
  storage: OpenChoiceStorage | undefined,
  capsuleId: string,
  interfaceId: string,
): RememberedOpenChoice | undefined {
  if (!storage) return undefined;
  let raw: string | null;
  try {
    raw = storage.getItem(openChoiceStorageKey(capsuleId, interfaceId));
  } catch {
    return undefined;
  }
  if (raw === null || raw.length > 1024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.choice === "web") return { choice: "web" };
  if (
    value.choice === "native" &&
    (value.platform === "ios" || value.platform === "android") &&
    typeof value.trustedClientId === "string" &&
    TRUSTED_CLIENT_ID_PATTERN.test(value.trustedClientId)
  ) {
    const target = rememberedTarget(value.target, value.platform);
    if (!target) return undefined;
    return { choice: "native", platform: value.platform, trustedClientId: value.trustedClientId, target };
  }
  return undefined;
}

/** Keep `choice`; false when the browser refuses (private mode, quota, policy). */
export function writeOpenChoice(
  storage: OpenChoiceStorage | undefined,
  capsuleId: string,
  interfaceId: string,
  choice: RememberedOpenChoice,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(openChoiceStorageKey(capsuleId, interfaceId), JSON.stringify(choice));
    return true;
  } catch {
    return false;
  }
}

/** Forget the choice; false when the browser refuses. */
export function forgetOpenChoice(
  storage: OpenChoiceStorage | undefined,
  capsuleId: string,
  interfaceId: string,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(openChoiceStorageKey(capsuleId, interfaceId));
    return true;
  } catch {
    return false;
  }
}

/** Whether `storage` accepts a write now (a probe written and removed). */
export function openChoiceStorageWorks(storage: OpenChoiceStorage | undefined): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROBE_KEY, "1");
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

// --- the chooser on the app page ---------------------------------------------------

/** The query that opens an app page at one screen's chooser. */
export const OPEN_CHOOSER_PARAM = "open";
/** Set when Chrome came back through `S.browser_fallback_url`: the app did not open. */
export const OPEN_CHOOSER_MISSING_PARAM = "missing";
const INTERFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

/**
 * The app page at the chooser of one screen (`/apps/:id?open=<interface>#phone`).
 * `missing` marks a return from Android's fallback: the app did not open.
 */
export function appOpenChooserPath(
  capsuleId: string,
  interfaceId: string,
  options: { readonly missing?: boolean } = {},
): string {
  const params = new URLSearchParams({ [OPEN_CHOOSER_PARAM]: interfaceId });
  if (options.missing) params.set(OPEN_CHOOSER_MISSING_PARAM, "1");
  return `/apps/${encodeURIComponent(capsuleId)}?${params.toString()}#phone`;
}

/** The screen and fallback mark an app page URL's query names, if any. */
export function parseOpenChooserQuery(search: string): {
  readonly interfaceId?: string;
  readonly missing: boolean;
} {
  const params = new URLSearchParams(search);
  const interfaceId = params.get(OPEN_CHOOSER_PARAM) ?? "";
  return {
    ...(INTERFACE_ID_PATTERN.test(interfaceId) ? { interfaceId } : {}),
    missing: params.get(OPEN_CHOOSER_MISSING_PARAM) === "1",
  };
}

// --- deciding how one tap opens a screen -------------------------------------------

/**
 * What one Open (a Home tile, the app page's Open) does:
 * - `web`: the screen URL, in a new tab;
 * - `native`: hand it to the native app, in a link the person taps;
 * - `choose`: the app page's chooser for this screen.
 */
export type OpenRoute =
  | { readonly kind: "web"; readonly href: string }
  | { readonly kind: "native"; readonly href: string; readonly client: PhoneClient }
  | { readonly kind: "choose"; readonly href: string };

export interface OpenRouteInput {
  readonly platform: OpenPlatform;
  /** The screen's checked launch URL. */
  readonly url: string;
  /** The screen's `clients` as the API returned them. */
  readonly clients?: unknown;
  readonly remembered?: RememberedOpenChoice;
  /** The chooser for this screen; without one, everything falls back to the web. */
  readonly chooserHref?: string;
  /** Android's `S.browser_fallback_url`: the absolute chooser URL, marked missing. */
  readonly fallbackUrl?: string;
}

/** Decide how one tap opens a screen on this device. */
export function resolveOpenRoute(input: OpenRouteInput): OpenRoute {
  const web: OpenRoute = { kind: "web", href: input.url };
  if (input.platform === "desktop" || input.chooserHref === undefined) return web;
  const client = phoneClient(input.clients, input.platform);
  if (!client) return web;
  const choose: OpenRoute = { kind: "choose", href: input.chooserHref };
  const remembered = input.remembered;
  if (remembered?.choice === "web") return web;
  // An unverified client is never a default and never remembered; the
  // chooser asks before opening it.
  if (!client.verified) return web;
  if (rememberedNativeMatches(remembered, client)) {
    const href = chosenNativeHref(client, input.fallbackUrl);
    return href ? { kind: "native", href, client } : choose;
  }
  if (!prefersNative(input.clients)) return web;
  if (client.platform === "android") {
    const href = input.fallbackUrl === undefined ? undefined : androidIntentUrl(client, input.fallbackUrl);
    return href ? { kind: "native", href, client } : choose;
  }
  // iPhone: a universal link falls back to the publisher's page by itself;
  // a custom scheme alone waits until the person chose it in the chooser.
  const href = iosNativeHref(client, false);
  return href ? { kind: "native", href, client } : choose;
}

/**
 * The destination that names an unverified client without a checked name:
 * its Android package, else its link host, else its scheme.
 */
export function clientTargetLabel(client: PhoneClient): string {
  return client.target.package ?? client.target.host ?? `${client.target.scheme ?? ""}:`;
}

/** The store a store link goes to, for its label. */
export function storeKind(storeUrl: string): "appStore" | "testFlight" | "googlePlay" | "fDroid" | undefined {
  const url = parsedUrl(storeUrl);
  switch (url?.hostname) {
    case "apps.apple.com":
      return "appStore";
    case "testflight.apple.com":
      return "testFlight";
    case "play.google.com":
      return "googlePlay";
    case "f-droid.org":
      return "fDroid";
    default:
      return undefined;
  }
}

/** A store link as shown before following it: host and path, no query noise. */
export function storeDestination(storeUrl: string): string | undefined {
  const url = parsedUrl(storeUrl);
  if (!url) return undefined;
  const id = url.hostname === "play.google.com" ? url.searchParams.get("id") : null;
  return `${url.hostname}${url.pathname}${id ? `?id=${id}` : ""}`;
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
