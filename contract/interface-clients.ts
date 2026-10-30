/**
 * Shared consumer-profile parser for the native clients a screen declares in
 * `interface.ui.surface` `spec.document.clients` (TASK-0119, ADR 0026 in
 * takos-control). An app that also ships a native phone app names it next to
 * `display`, so Takosumi can hand the screen to that app instead of the web.
 *
 * The field is optional public metadata inside the opaque Interface
 * `document`: neither the Interface version (`"1"`) nor any repository
 * manifest version changes, and older consumers ignore it. Like
 * `parseInterfaceDisplay`, this parser never throws: an invalid value drops
 * that field, or the whole platform when the platform can no longer open the
 * app, and unknown keys and platforms are ignored and never echoed.
 *
 * Trust. Any app can write any declaration, so a declaration alone proves
 * nothing about the app it opens. A platform is `verified` only when its
 * declared identity (iOS `bundleId`, Android `package`) equals an entry of the
 * operator's trusted native clients AND every link it keeps is one of that
 * entry's link templates; the name and App Store id then come from the entry.
 * A declaration that claims a trusted identity with any other link loses that
 * link. Every other declaration is returned with `verified: false` and its
 * real destination in `target`, and may not use a scheme that a trusted client
 * owns or a link host that a trusted client owns or one below it.
 *
 * Consumer contract (dashboard, Takosumi Mobile): only a verified platform may
 * open without asking, and only a verified platform honours
 * `preferred: "native"` (which the parser returns only when at least one
 * platform is verified). An unverified platform is never opened
 * automatically; the consumer asks first and shows `target` (the Android
 * package, the custom scheme, the link host) next to the checked `name`, or
 * next to a neutral label such as "Unverified app" when `name` is absent. An
 * unverified platform is never labelled with the screen's title or any other
 * screen metadata: the title is not checked against trusted names, so it could
 * borrow one.
 *
 * Links. Templates may carry only `{origin}` (the screen URL's origin) and
 * `{url}` (the whole screen URL), at most four times in all. The parser fills
 * both URL-encoded, so every consumer receives the same ready-to-open links
 * and never substitutes anything itself. The only value a handoff link can
 * carry is that public, credential-free screen URL.
 */
import { hasCredentialQueryParams } from "./interface-display.ts";
import {
  isTakosumiReservedAppId,
  isTakosumiReservedClientName,
  isTakosumiReservedHost,
  TAKOSUMI_MOBILE_SCHEME,
} from "./native-client-identity.ts";

/** Maximum length of a native client's display name. */
export const INTERFACE_CLIENT_NAME_MAX_LENGTH = 64;
/** Maximum length of a link template, before and after filling it. */
export const INTERFACE_CLIENT_LINK_MAX_LENGTH = 2_048;
/** Maximum length of an iOS bundle id or Android applicationId. */
export const INTERFACE_CLIENT_IDENTIFIER_MAX_LENGTH = 155;
/** Maximum number of `{origin}` / `{url}` placeholders in one template. */
export const INTERFACE_CLIENT_TEMPLATE_MAX_PLACEHOLDERS = 4;

/** The platforms a screen can declare a native client for. */
export const INTERFACE_CLIENT_PLATFORMS = ["ios", "android"] as const;
export type InterfaceClientPlatform =
  (typeof INTERFACE_CLIENT_PLATFORMS)[number];

/** How a screen opens on a platform with a verified client, by default. */
export type InterfaceClientPreference = "native" | "web";

/**
 * Custom schemes an `open` template may not use. `http`/`https` links belong in
 * `universalLink` / `appLink`; the rest run script, read local data, start
 * system actions (calls, messages, settings, store installs, shortcuts), open
 * an arbitrary web page in a browser app (Chrome, Firefox, Edge, Opera, Brave,
 * DuckDuckGo, Safari and the like), or target Takosumi Mobile itself.
 * `intent:` and `android-app:` are built by the dashboard for Android, never
 * declared. This list only removes the worst schemes; trust comes from the
 * trusted native clients, not from it.
 */
export const INTERFACE_CLIENT_BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "javascript",
  "vbscript",
  "data",
  "file",
  "filesystem",
  "blob",
  "about",
  "content",
  "intent",
  "android-app",
  TAKOSUMI_MOBILE_SCHEME,
  "tel",
  "callto",
  "sms",
  "smsto",
  "mms",
  "mmsto",
  "mailto",
  "facetime",
  "facetime-audio",
  "facetime-prompt",
  "facetime-audio-prompt",
  "itms",
  "itmss",
  "itms-apps",
  "itms-appss",
  "itms-services",
  "itms-beta",
  "market",
  "app-settings",
  "app-prefs",
  "prefs",
  "shortcuts",
  "x-web-search",
  // Browser apps that open whatever web page the link names.
  "x-safari-http",
  "x-safari-https",
  "googlechrome",
  "googlechromes",
  "googlechrome-x-callback",
  "firefox",
  "firefox-focus",
  "focus",
  "microsoft-edge",
  "microsoft-edge-http",
  "microsoft-edge-https",
  "opera",
  "opera-http",
  "opera-https",
  "touch-http",
  "touch-https",
  "brave",
  "duckduckgo",
  "ddgquicklink",
  "samsunginternet",
  "yandexbrowser-open-url",
  "firefox-klar",
  "onionhttp",
  "onionhttps",
  "ws",
  "wss",
  "ftp",
]);

// --- trusted native clients --------------------------------------------------------

/** The iOS app of a trusted native client. */
export interface TrustedNativeClientIos {
  readonly bundleId: string;
  /** The App Store id; the only one a verified iOS client links to. */
  readonly appStoreId?: string;
  /** Whether a TestFlight `storeUrl` is accepted for this app. */
  readonly testFlight: boolean;
  /** Custom schemes this app owns. No other declaration may use them. */
  readonly schemes: readonly string[];
  /** Universal link hosts this app owns. No other declaration may use them. */
  readonly universalLinkHosts: readonly string[];
  /** The exact `open` / `universalLink` templates a declaration may use. */
  readonly templates: readonly string[];
}

/** The Android app of a trusted native client. */
export interface TrustedNativeClientAndroid {
  readonly package: string;
  /** Custom schemes this app owns. No other declaration may use them. */
  readonly schemes: readonly string[];
  /** App Link hosts this app owns. No other declaration may use them. */
  readonly appLinkHosts: readonly string[];
  /** The exact `open` / `appLink` templates a declaration may use. */
  readonly templates: readonly string[];
}

/** One operator-trusted native client (an app and its phone builds). */
export interface TrustedNativeClient {
  /** A stable token, returned as `trustedClientId`. */
  readonly id: string;
  /** The name shown for a verified client. */
  readonly name: string;
  readonly ios?: TrustedNativeClientIos;
  readonly android?: TrustedNativeClientAndroid;
  /**
   * Set only by Takosumi, never by the operator list: the entry verifies
   * nothing, but unverified declarations still may not use its name, schemes
   * or link hosts. See `RESERVED_DEFAULT_NATIVE_CLIENTS`.
   */
  readonly reservedOnly?: true;
}

const TRUSTED_CLIENT_MAX_ENTRIES = 32;
const TRUSTED_CLIENT_MAX_LIST = 16;
const TRUSTED_CLIENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

/**
 * Why a trusted native client list was refused. `path` names only the entry
 * index and field (`list`, `[0].name`, `[1].android.templates`), never a
 * value, so hosts can log it; the message may quote the value.
 */
export class TrustedNativeClientsError extends TypeError {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`trusted native clients: ${path} ${problem}`);
    this.name = "TrustedNativeClientsError";
    this.path = path;
  }
}

/**
 * Strictly parse a trusted native client list (the operator setting).
 * Unknown keys, invalid or reserved identities, schemes, hosts or templates,
 * and an identity, scheme or host claimed by two entries all throw a
 * `TrustedNativeClientsError`, so a misconfigured list is never partly
 * trusted. The Accounts host then verifies nothing and keeps the built-in
 * clients reserved (`RESERVED_DEFAULT_NATIVE_CLIENTS`); it keeps serving.
 */
export function parseTrustedNativeClients(
  value: unknown,
): readonly TrustedNativeClient[] {
  if (!Array.isArray(value) || value.length > TRUSTED_CLIENT_MAX_ENTRIES) {
    throw new TrustedNativeClientsError(
      "list",
      `must be a JSON array of at most ${TRUSTED_CLIENT_MAX_ENTRIES} entries`,
    );
  }
  const ids = new Set<string>();
  const claimed = new Map<string, string>();
  const claim = (key: string, path: string): void => {
    const previous = claimed.get(key);
    if (previous !== undefined && previous !== path.split(".")[0]) {
      throw new TrustedNativeClientsError(path, `is already claimed by ${previous}`);
    }
    claimed.set(key, path.split(".")[0]!);
  };
  const entries = value.map((raw, index): TrustedNativeClient => {
    const path = `[${index}]`;
    const entry = exactRecord(raw, path, ["id", "name", "ios", "android"]);
    const id = entry.id;
    if (typeof id !== "string" || !TRUSTED_CLIENT_ID_PATTERN.test(id)) {
      throw new TrustedNativeClientsError(`${path}.id`, "must be a lowercase token");
    }
    if (ids.has(id)) throw new TrustedNativeClientsError(`${path}.id`, "is a duplicate");
    ids.add(id);
    const name = clientName(entry.name, []);
    if (name === undefined) {
      throw new TrustedNativeClientsError(`${path}.name`, "must be a plain, non-reserved name");
    }
    if (entry.ios === undefined && entry.android === undefined) {
      throw new TrustedNativeClientsError(path, "must declare ios or android");
    }
    const ios = entry.ios === undefined
      ? undefined
      : parseTrustedIos(entry.ios, `${path}.ios`, (key, at) => claim(key, at));
    const android = entry.android === undefined
      ? undefined
      : parseTrustedAndroid(entry.android, `${path}.android`, (key, at) => claim(key, at));
    return Object.freeze({
      id,
      name,
      ...(ios ? { ios } : {}),
      ...(android ? { android } : {}),
    });
  });
  return Object.freeze(entries);
}

function parseTrustedIos(
  raw: unknown,
  path: string,
  claim: (key: string, path: string) => void,
): TrustedNativeClientIos {
  const record = exactRecord(raw, path, [
    "bundleId",
    "appStoreId",
    "testFlight",
    "schemes",
    "universalLinkHosts",
    "templates",
  ]);
  const bundleId = reverseDnsIdentifier(record.bundleId, BUNDLE_ID_PATTERN);
  if (!bundleId) {
    throw new TrustedNativeClientsError(`${path}.bundleId`, "must be a non-reserved reverse-DNS id");
  }
  claim(`ios-id:${bundleId.toLowerCase()}`, `${path}.bundleId`);
  const appStoreId = record.appStoreId === undefined
    ? undefined
    : appStoreIdentifier(record.appStoreId);
  if (record.appStoreId !== undefined && appStoreId === undefined) {
    throw new TrustedNativeClientsError(`${path}.appStoreId`, "must be 1-12 digits");
  }
  if (record.testFlight !== undefined && typeof record.testFlight !== "boolean") {
    throw new TrustedNativeClientsError(`${path}.testFlight`, "must be a boolean");
  }
  const { schemes, hosts, templates } = parseTrustedLinks(
    record,
    path,
    "universalLinkHosts",
    claim,
  );
  return Object.freeze({
    bundleId,
    ...(appStoreId !== undefined ? { appStoreId } : {}),
    testFlight: record.testFlight === true,
    schemes,
    universalLinkHosts: hosts,
    templates,
  });
}

function parseTrustedAndroid(
  raw: unknown,
  path: string,
  claim: (key: string, path: string) => void,
): TrustedNativeClientAndroid {
  const record = exactRecord(raw, path, [
    "package",
    "schemes",
    "appLinkHosts",
    "templates",
  ]);
  const packageName = reverseDnsIdentifier(record.package, ANDROID_PACKAGE_PATTERN);
  if (!packageName) {
    throw new TrustedNativeClientsError(`${path}.package`, "must be a non-reserved applicationId");
  }
  claim(`android-id:${packageName.toLowerCase()}`, `${path}.package`);
  const { schemes, hosts, templates } = parseTrustedLinks(
    record,
    path,
    "appLinkHosts",
    claim,
  );
  return Object.freeze({
    package: packageName,
    schemes,
    appLinkHosts: hosts,
    templates,
  });
}

function parseTrustedLinks(
  record: Record<string, unknown>,
  path: string,
  hostKey: "universalLinkHosts" | "appLinkHosts",
  claim: (key: string, path: string) => void,
): {
  readonly schemes: readonly string[];
  readonly hosts: readonly string[];
  readonly templates: readonly string[];
} {
  const platform = path.endsWith(".ios") ? "ios" : "android";
  const schemes = stringList(record.schemes, `${path}.schemes`, true);
  for (const scheme of schemes) {
    if (!SCHEME_PATTERN.test(scheme) || INTERFACE_CLIENT_BLOCKED_SCHEMES.has(scheme)) {
      throw new TrustedNativeClientsError(`${path}.schemes`, `has an invalid or blocked scheme ${scheme}`);
    }
    claim(`${platform}-scheme:${scheme}`, `${path}.schemes`);
  }
  const hosts = stringList(record[hostKey], `${path}.${hostKey}`, true).map((host) =>
    host.toLowerCase()
  );
  for (const host of hosts) {
    if (!isDomainName(host) || isTakosumiReservedHost(host)) {
      throw new TrustedNativeClientsError(`${path}.${hostKey}`, `has an invalid or reserved host ${host}`);
    }
    claim(`${platform}-host:${host}`, `${path}.${hostKey}`);
  }
  const templates = stringList(record.templates, `${path}.templates`, false);
  const check: TemplateCheck = { values: SAMPLE_VALUES, reservedHosts: [] };
  const canonical = templates.map((template) => {
    const link = linkKind(template) === "https"
      ? publisherLink(template, check)
      : customSchemeLink(template, check);
    const owner = templateDestination(template);
    if (
      !link ||
      !placeholderNames(template).includes("origin") ||
      owner === undefined ||
      (owner.kind === "scheme" ? !schemes.includes(owner.value) : !hosts.includes(owner.value))
    ) {
      throw new TrustedNativeClientsError(
        `${path}.templates`,
        `has a template that is invalid, lacks {origin}, or uses a scheme or host not listed: ${template}`,
      );
    }
    return canonicalTemplate(template)!;
  });
  if (new Set(canonical).size !== canonical.length) {
    throw new TrustedNativeClientsError(`${path}.templates`, "has duplicates");
  }
  return {
    schemes: Object.freeze(schemes),
    hosts: Object.freeze(hosts),
    templates: Object.freeze(canonical),
  };
}

// --- parsed declaration ---------------------------------------------------------------

/**
 * Where a platform's links really go. Consumers show it whenever they ask
 * before opening an unverified client.
 */
export interface InterfaceClientTarget {
  /** Android: the only app that can receive the links. */
  readonly package?: string;
  /** The custom scheme of `open`. On iOS any installed app may claim it. */
  readonly scheme?: string;
  /** The host of the universal link / App Link. */
  readonly host?: string;
}

interface InterfaceClientBase {
  /**
   * True only when the identity and every kept link match a trusted native
   * client. Never open an unverified client without asking and showing
   * `target`.
   */
  readonly verified: boolean;
  /** The trusted native client's `id`, when verified. */
  readonly trustedClientId?: string;
  readonly target: InterfaceClientTarget;
  /**
   * Verified: the trusted client's name, always present. Unverified: the
   * declared name when it passes the checks (ASCII after removing accents
   * with NFKD, or Japanese without Latin letters, that does not imitate
   * Takosumi or a trusted client, in Latin or in kana), else absent. Consumers
   * never fall back to the screen title or other screen metadata for an
   * unverified platform: without `name` they show a neutral label (such as
   * "Unverified app") with `target`.
   */
  readonly name?: string;
  /** The custom-scheme link with `{origin}` / `{url}` filled in. */
  readonly open?: string;
}

/** A validated iOS client. Links are filled in, ready to open. */
export interface InterfaceIosClient extends InterfaceClientBase {
  /** Verified: the trusted entry's App Store id. Unverified: the declared one. */
  readonly appStoreId?: string;
  readonly bundleId?: string;
  /** The publisher-domain https universal link, filled in. */
  readonly universalLink?: string;
  /**
   * Where to install the app: a declared App Store link for `appStoreId` (or a
   * TestFlight link, for a trusted client that allows it), else
   * `https://apps.apple.com/app/id<appStoreId>`.
   */
  readonly storeUrl?: string;
}

/** A validated Android client. Links are filled in, ready to open. */
export interface InterfaceAndroidClient extends InterfaceClientBase {
  /** The applicationId. Openers pin the target app to it. */
  readonly package: string;
  /** The publisher-domain https App Link, filled in. */
  readonly appLink?: string;
  /**
   * Where to install the app: a declared Google Play or F-Droid page of
   * `package`, else its Google Play page.
   */
  readonly storeUrl: string;
}

/** The validated `document.clients` of one screen. */
export interface InterfaceClients {
  /**
   * The default on a phone. `"native"` only when the declaration does not say
   * `"web"` and at least one platform's client is verified; otherwise `"web"`,
   * so a declaration without a verified client never claims a native default.
   * Even `"native"` applies only on a platform whose client is verified; an
   * unverified client is never a default and always asks first.
   */
  readonly preferred: InterfaceClientPreference;
  readonly ios?: InterfaceIosClient;
  readonly android?: InterfaceAndroidClient;
}

export interface ParseInterfaceClientsOptions {
  /** The screen's checked launch URL; `{origin}` and `{url}` come from it. */
  readonly surfaceUrl: string;
  /**
   * The Takosumi origin that renders the choice (dashboard / accounts). Its
   * host is refused in universal links and App Links: a link there would be a
   * session-credentialed same-origin navigation the viewer never approved.
   */
  readonly viewerOrigin?: string;
  /** More Takosumi-owned hosts to refuse, such as the configured issuer's. */
  readonly reservedHosts?: readonly string[];
  /**
   * The operator's trusted native clients; the built-in list when omitted.
   * Entries marked `reservedOnly` verify nothing but stay reserved.
   */
  readonly trustedClients?: readonly TrustedNativeClient[];
}

interface TemplateValues {
  readonly origin: string;
  readonly url: string;
}

interface TemplateCheck {
  readonly values: TemplateValues;
  readonly reservedHosts: readonly string[];
}

interface ParseContext extends TemplateCheck {
  readonly trusted: readonly TrustedNativeClient[];
  /**
   * Schemes and link hosts owned by trusted clients on either platform. An
   * unverified link may not use an owned scheme, an owned host, or a host
   * below one.
   */
  readonly ownedSchemes: ReadonlySet<string>;
  readonly ownedHosts: readonly string[];
  /** Names an unverified client may not imitate. */
  readonly trustedNames: readonly string[];
}

/**
 * Parse a `document.clients` value against the screen it belongs to. Returns
 * `undefined` when nothing usable is declared.
 */
export function parseInterfaceClients(
  value: unknown,
  options: ParseInterfaceClientsOptions,
): InterfaceClients | undefined {
  if (!isRecord(value)) return undefined;
  const values = surfaceTemplateValues(options.surfaceUrl);
  if (!values) return undefined;
  const viewer = parsedLink(options.viewerOrigin ?? "");
  const reservedHosts = [
    ...(viewer && viewer.origin !== "null" ? [viewer.hostname] : []),
    ...(options.reservedHosts ?? []),
  ];
  const trusted = options.trustedClients ?? DEFAULT_TRUSTED_NATIVE_CLIENTS;
  const context: ParseContext = {
    values,
    reservedHosts,
    trusted,
    trustedNames: trusted.map((entry) => entry.name),
    ownedSchemes: new Set(trusted.flatMap((entry) => [
      ...(entry.ios?.schemes ?? []),
      ...(entry.android?.schemes ?? []),
    ])),
    ownedHosts: [...new Set(trusted.flatMap((entry) => [
      ...(entry.ios?.universalLinkHosts ?? []),
      ...(entry.android?.appLinkHosts ?? []),
    ]))],
  };
  const ios = parseIosClient(value.ios, context);
  const android = parseAndroidClient(value.android, context);
  if (!ios && !android) return undefined;
  // Without a verified client there is nothing to open by default.
  const anyVerified = ios?.verified === true || android?.verified === true;
  return {
    preferred: anyVerified && value.preferred !== "web" ? "native" : "web",
    ...(ios ? { ios } : {}),
    ...(android ? { android } : {}),
  };
}

function parseIosClient(
  value: unknown,
  context: ParseContext,
): InterfaceIosClient | undefined {
  if (!isRecord(value)) return undefined;
  const bundleId = reverseDnsIdentifier(value.bundleId, BUNDLE_ID_PATTERN);
  // Takosumi's own identity refuses the whole platform.
  if (bundleId === undefined && value.bundleId !== undefined &&
    typeof value.bundleId === "string" && isTakosumiReservedAppId(value.bundleId)) {
    return undefined;
  }
  const entry = bundleId === undefined
    ? undefined
    : context.trusted.find((candidate) =>
      candidate.reservedOnly !== true &&
      candidate.ios?.bundleId.toLowerCase() === bundleId.toLowerCase()
    );
  if (entry?.ios) {
    const trustedIos = entry.ios;
    const open = trustedLink(value.open, "scheme", trustedIos.templates, context);
    const universalLink = trustedLink(value.universalLink, "https", trustedIos.templates, context);
    // A trusted identity with someone else's links is not that app.
    if (!open && !universalLink) return undefined;
    const storeUrl = appStoreLink(value.storeUrl, trustedIos.appStoreId, trustedIos.testFlight);
    return {
      verified: true,
      trustedClientId: entry.id,
      target: linkTarget(open, universalLink),
      name: entry.name,
      ...(trustedIos.appStoreId !== undefined ? { appStoreId: trustedIos.appStoreId } : {}),
      bundleId: trustedIos.bundleId,
      ...(open ? { open: open.href } : {}),
      ...(universalLink ? { universalLink: universalLink.href } : {}),
      ...(storeUrl !== undefined ? { storeUrl } : {}),
    };
  }
  const open = untrustedLink(value.open, "scheme", context);
  const universalLink = untrustedLink(value.universalLink, "https", context);
  if (!open && !universalLink) return undefined;
  const name = clientName(value.name, context.trustedNames);
  const appStoreId = appStoreIdentifier(value.appStoreId);
  const storeUrl = appStoreLink(value.storeUrl, appStoreId, false);
  return {
    verified: false,
    target: linkTarget(open, universalLink),
    ...(name !== undefined ? { name } : {}),
    ...(appStoreId !== undefined ? { appStoreId } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    ...(open ? { open: open.href } : {}),
    ...(universalLink ? { universalLink: universalLink.href } : {}),
    ...(storeUrl !== undefined ? { storeUrl } : {}),
  };
}

function parseAndroidClient(
  value: unknown,
  context: ParseContext,
): InterfaceAndroidClient | undefined {
  if (!isRecord(value)) return undefined;
  // The package pins which app receives the link; without it a custom scheme
  // could reach any app that claims the same scheme.
  const packageName = reverseDnsIdentifier(value.package, ANDROID_PACKAGE_PATTERN);
  if (!packageName) return undefined;
  const entry = context.trusted.find((candidate) =>
    candidate.reservedOnly !== true &&
    candidate.android?.package.toLowerCase() === packageName.toLowerCase()
  );
  if (entry?.android) {
    const trustedAndroid = entry.android;
    const open = trustedLink(value.open, "scheme", trustedAndroid.templates, context);
    const appLink = trustedLink(value.appLink, "https", trustedAndroid.templates, context);
    if (!open && !appLink) return undefined;
    return {
      verified: true,
      trustedClientId: entry.id,
      target: { package: trustedAndroid.package, ...linkTarget(open, appLink) },
      name: entry.name,
      package: trustedAndroid.package,
      ...(open ? { open: open.href } : {}),
      ...(appLink ? { appLink: appLink.href } : {}),
      storeUrl: androidStoreLink(value.storeUrl, trustedAndroid.package),
    };
  }
  const open = untrustedLink(value.open, "scheme", context);
  const appLink = untrustedLink(value.appLink, "https", context);
  if (!open && !appLink) return undefined;
  const name = clientName(value.name, context.trustedNames);
  return {
    verified: false,
    target: { package: packageName, ...linkTarget(open, appLink) },
    ...(name !== undefined ? { name } : {}),
    package: packageName,
    ...(open ? { open: open.href } : {}),
    ...(appLink ? { appLink: appLink.href } : {}),
    storeUrl: androidStoreLink(value.storeUrl, packageName),
  };
}

function linkTarget(
  open: URL | undefined,
  link: URL | undefined,
): InterfaceClientTarget {
  return {
    ...(open ? { scheme: open.protocol.slice(0, -1) } : {}),
    ...(link ? { host: link.hostname } : {}),
  };
}

/** A declared link of a verified identity: exactly one of its templates. */
function trustedLink(
  value: unknown,
  kind: "scheme" | "https",
  templates: readonly string[],
  context: ParseContext,
): URL | undefined {
  if (typeof value !== "string" || linkKind(value) !== kind) return undefined;
  const canonical = canonicalTemplate(value);
  if (canonical === undefined || !templates.includes(canonical)) return undefined;
  return kind === "https"
    ? publisherLink(canonical, context)
    : customSchemeLink(canonical, context);
}

/**
 * A declared link of an unverified identity: never a trusted client's scheme,
 * nor a trusted client's link host or a host below it (`evil.open.example`
 * under `open.example`), which a consumer could read as that client's.
 */
function untrustedLink(
  value: unknown,
  kind: "scheme" | "https",
  context: ParseContext,
): URL | undefined {
  if (typeof value !== "string" || linkKind(value) !== kind) return undefined;
  const link = kind === "https"
    ? publisherLink(value, context)
    : customSchemeLink(value, context);
  if (!link) return undefined;
  const owned = kind === "https"
    ? context.ownedHosts.some((host) =>
      link.hostname === host || link.hostname.endsWith(`.${host}`)
    )
    : context.ownedSchemes.has(link.protocol.slice(0, -1));
  return owned ? undefined : link;
}

// --- links -----------------------------------------------------------------------

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u;
const PLACEHOLDER_PATTERN = /\{(origin|url)\}/gu;
/** Printable ASCII without space. */
const LINK_CHARACTERS = /^[\x21-\x7e]+$/u;
/** Printable characters that are never valid in a URL. */
const LINK_FORBIDDEN_CHARACTERS = /["<>\\^`|]/u;

function linkKind(template: string): "scheme" | "https" {
  return template.startsWith("https:") ? "https" : "scheme";
}

/**
 * A custom-scheme `open` template. The scheme is lowercase and not blocked;
 * the link has no userinfo, no credential-named query parameter and no
 * fragment (the Android dashboard appends `#Intent;...;end` after it, so a
 * declared fragment could add intent extras).
 */
function customSchemeLink(
  value: unknown,
  check: TemplateCheck,
): URL | undefined {
  const template = linkTemplate(value);
  if (!template) return undefined;
  const colon = template.indexOf(":");
  if (colon < 0) return undefined;
  const scheme = template.slice(0, colon);
  if (!SCHEME_PATTERN.test(scheme)) return undefined;
  if (INTERFACE_CLIENT_BLOCKED_SCHEMES.has(scheme)) return undefined;
  const rest = template.slice(colon + 1);
  if (!rest || rest.includes("#")) return undefined;
  if (placeholderBeforePath(rest)) return undefined;
  const sample = parsedLink(fill(template, SAMPLE_VALUES));
  if (!sample || sample.protocol !== `${scheme}:`) return undefined;
  if (sample.username || sample.password) return undefined;
  if (hasCredentialQueryParams(sample.searchParams)) return undefined;
  const filledText = boundedFill(template, check.values);
  const filled = filledText === undefined ? undefined : parsedLink(filledText);
  if (!filled || filled.protocol !== `${scheme}:` || filled.hash) {
    return undefined;
  }
  return withinLinkLimit(filled);
}

/**
 * A `universalLink` / `appLink` template: https on the default port of a
 * named publisher domain that the placeholders cannot change, without
 * userinfo or credential-named parameters, and never on a Takosumi-owned host.
 */
function publisherLink(
  value: unknown,
  check: TemplateCheck,
): URL | undefined {
  const template = linkTemplate(value);
  // A fixed, non-empty host right after `https://`.
  if (!template || !/^https:\/\/[^/?#]/u.test(template)) return undefined;
  if (placeholderBeforePath(template.slice("https:".length))) return undefined;
  const sample = parsedLink(fill(template, SAMPLE_VALUES));
  if (!sample || !isPublisherHttpsUrl(sample)) return undefined;
  if (hasCredentialParameters(sample)) return undefined;
  if (isTakosumiReservedHost(sample.hostname, check.reservedHosts)) return undefined;
  const filledText = boundedFill(template, check.values);
  const filled = filledText === undefined ? undefined : parsedLink(filledText);
  if (!filled || !isPublisherHttpsUrl(filled) || filled.origin !== sample.origin) {
    return undefined;
  }
  return withinLinkLimit(filled);
}

/**
 * An App Store or TestFlight link bound to the declared identity: an
 * `apps.apple.com` app page of exactly `appStoreId`, or a TestFlight join link
 * only for a trusted client that allows it. Otherwise the App Store page of
 * `appStoreId`, if any.
 */
function appStoreLink(
  value: unknown,
  appStoreId: string | undefined,
  testFlight: boolean,
): string | undefined {
  const fallback = appStoreId === undefined
    ? undefined
    : `https://apps.apple.com/app/id${appStoreId}`;
  const url = storeLink(value);
  if (!url) return fallback;
  if (url.hostname === "apps.apple.com") {
    const match = /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id([0-9]{1,12})\/?$/u.exec(url.pathname);
    return match && appStoreId !== undefined && match[1] === appStoreId
      ? withinLinkLimit(url)?.href ?? fallback
      : fallback;
  }
  if (url.hostname === "testflight.apple.com" && testFlight) {
    return /^\/join\/[A-Za-z0-9]{1,32}\/?$/u.test(url.pathname) && !url.search
      ? withinLinkLimit(url)?.href ?? fallback
      : fallback;
  }
  return fallback;
}

/**
 * A Google Play or F-Droid page of exactly `packageName`, else its Google
 * Play page.
 */
function androidStoreLink(value: unknown, packageName: string): string {
  const fallback =
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`;
  const url = storeLink(value);
  if (!url) return fallback;
  if (url.hostname === "play.google.com") {
    const ids = url.searchParams.getAll("id");
    return url.pathname === "/store/apps/details" && ids.length === 1 &&
        ids[0] === packageName
      ? withinLinkLimit(url)?.href ?? fallback
      : fallback;
  }
  if (url.hostname === "f-droid.org") {
    const match = /^\/(?:[a-z]{2}(?:[-_][A-Za-z]{2,4})?\/)?packages\/([^/]+)\/?$/u.exec(url.pathname);
    return match && match[1] === packageName && !url.search
      ? withinLinkLimit(url)?.href ?? fallback
      : fallback;
  }
  return fallback;
}

const STORE_HOSTS: ReadonlySet<string> = new Set([
  "apps.apple.com",
  "testflight.apple.com",
  "play.google.com",
  "f-droid.org",
]);

/** An https link on a known store host. Not a template. */
function storeLink(value: unknown): URL | undefined {
  if (
    typeof value !== "string" ||
    value.length > INTERFACE_CLIENT_LINK_MAX_LENGTH ||
    !LINK_CHARACTERS.test(value) ||
    LINK_FORBIDDEN_CHARACTERS.test(value) ||
    /[{}]/u.test(value) ||
    !value.startsWith("https://")
  ) {
    return undefined;
  }
  const url = parsedLink(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.hash ||
    !STORE_HOSTS.has(url.hostname) ||
    hasCredentialParameters(url)
  ) {
    return undefined;
  }
  return url;
}

function linkTemplate(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > INTERFACE_CLIENT_LINK_MAX_LENGTH ||
    !LINK_CHARACTERS.test(value) ||
    LINK_FORBIDDEN_CHARACTERS.test(value)
  ) {
    return undefined;
  }
  // Only `{origin}` and `{url}`; any other brace, nested or stray, refuses.
  if (/[{}]/u.test(value.replace(PLACEHOLDER_PATTERN, ""))) return undefined;
  return placeholderNames(value).length <= INTERFACE_CLIENT_TEMPLATE_MAX_PLACEHOLDERS
    ? value
    : undefined;
}

function placeholderNames(template: string): readonly string[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!);
}

/**
 * The comparable form of a template: lowercase scheme, and for https a
 * lowercase host without the default port. Placeholders stay as written.
 */
function canonicalTemplate(template: string): string | undefined {
  if (!linkTemplate(template)) return undefined;
  if (linkKind(template) === "https") {
    if (!/^https:\/\/[^/?#]/u.test(template)) return undefined;
    const afterSlashes = template.slice("https://".length);
    const end = afterSlashes.search(/[/?#]/u);
    const authority = end < 0 ? afterSlashes : afterSlashes.slice(0, end);
    const rest = end < 0 ? "" : afterSlashes.slice(end);
    return `https://${authority.toLowerCase().replace(/:443$/u, "")}${rest}`;
  }
  const colon = template.indexOf(":");
  return colon < 0
    ? undefined
    : `${template.slice(0, colon).toLowerCase()}${template.slice(colon)}`;
}

/** The scheme or https host a template opens, before any placeholder. */
function templateDestination(
  template: string,
): { readonly kind: "scheme" | "host"; readonly value: string } | undefined {
  if (linkKind(template) === "https") {
    const url = parsedLink(fill(template, SAMPLE_VALUES));
    return url ? { kind: "host", value: url.hostname } : undefined;
  }
  const colon = template.indexOf(":");
  return colon < 0 ? undefined : { kind: "scheme", value: template.slice(0, colon) };
}

/**
 * True when a placeholder (or userinfo) sits in the authority of
 * `//authority/path`, where the instance URL would choose the host. `rest`
 * starts right after `scheme:`.
 */
function placeholderBeforePath(rest: string): boolean {
  if (!rest.startsWith("//")) return false;
  const afterSlashes = rest.slice(2);
  const authorityEnd = afterSlashes.search(/[/?#]/u);
  const authority =
    authorityEnd < 0 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
  return /[{}@]/u.test(authority);
}

const SAMPLE_VALUES: TemplateValues = {
  origin: "https://takosumi-client-check.example",
  url: "https://takosumi-client-check.example/",
};

function fill(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, name: string) =>
    encodeURIComponent(name === "origin" ? values.origin : values.url),
  );
}

/**
 * Fill a template only when the result fits the link limit, computing the
 * length from the placeholder count before building any string.
 */
function boundedFill(template: string, values: TemplateValues): string | undefined {
  const origin = encodeURIComponent(values.origin).length;
  const url = encodeURIComponent(values.url).length;
  let length = template.length;
  for (const name of placeholderNames(template)) {
    length += name === "origin" ? origin - "{origin}".length : url - "{url}".length;
  }
  return length <= INTERFACE_CLIENT_LINK_MAX_LENGTH
    ? fill(template, values)
    : undefined;
}

function parsedLink(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isPublisherHttpsUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    !url.username &&
    !url.password &&
    isDomainName(url.hostname)
  );
}

/** A named domain with a dot; IP literals and single labels never host app links. */
function isDomainName(hostname: string): boolean {
  if (!hostname.includes(".") || hostname.startsWith("[")) return false;
  if (/^[0-9.]+$/u.test(hostname)) return false;
  return /^[a-z0-9.-]+$/u.test(hostname) && !hostname.endsWith(".") &&
    !hostname.startsWith(".") && !hostname.includes("..");
}

/** Credential-named parameters in the query or in a `#name=value` fragment. */
function hasCredentialParameters(url: URL): boolean {
  return (
    hasCredentialQueryParams(url.searchParams) ||
    hasCredentialQueryParams(new URLSearchParams(url.hash.slice(1)))
  );
}

function withinLinkLimit(link: URL): URL | undefined {
  return link.href.length <= INTERFACE_CLIENT_LINK_MAX_LENGTH ? link : undefined;
}

function surfaceTemplateValues(surfaceUrl: string): TemplateValues | undefined {
  const url = parsedLink(surfaceUrl);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  return { origin: url.origin, url: url.href };
}

// --- identifiers -----------------------------------------------------------------

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const ANDROID_PACKAGE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
/**
 * Control and format characters (bidirectional overrides, zero-width joiners
 * and the like), and line or paragraph separators, could disguise a name.
 */
const NAME_FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A plain display name that does not imitate Takosumi or one of
 * `protectedNames` (the trusted clients' names). Only text that is ASCII
 * after removing accents (NFKD), or Japanese without Latin letters, passes;
 * other scripts, undecomposable letters, symbols, emoji, uncomposed
 * combining marks, and Latin mixed with kana or kanji are refused by
 * `isTakosumiReservedClientName`.
 */
function clientName(
  value: unknown,
  protectedNames: readonly string[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (
    !name ||
    [...name].length > INTERFACE_CLIENT_NAME_MAX_LENGTH ||
    NAME_FORBIDDEN_CHARACTERS.test(name) ||
    isTakosumiReservedClientName(name, protectedNames)
  ) {
    return undefined;
  }
  return name;
}

function appStoreIdentifier(value: unknown): string | undefined {
  const text =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : value;
  return typeof text === "string" && /^[0-9]{1,12}$/u.test(text)
    ? text
    : undefined;
}

/** A reverse-DNS id outside Takosumi's own namespace. */
function reverseDnsIdentifier(
  value: unknown,
  pattern: RegExp,
): string | undefined {
  return typeof value === "string" &&
    value.length <= INTERFACE_CLIENT_IDENTIFIER_MAX_LENGTH &&
    pattern.test(value) &&
    !isTakosumiReservedAppId(value)
    ? value
    : undefined;
}

// --- helpers ---------------------------------------------------------------------

function exactRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TrustedNativeClientsError(path, "must be an object");
  }
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) {
    throw new TrustedNativeClientsError(path, `has an unknown field ${unknown.slice(0, 64)}`);
  }
  return value;
}

function stringList(
  value: unknown,
  path: string,
  allowEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > TRUSTED_CLIENT_MAX_LIST ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new TrustedNativeClientsError(
      path,
      `must be an array of ${allowEmpty ? "0" : "1"}-${TRUSTED_CLIENT_MAX_LIST} strings`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new TrustedNativeClientsError(path, "has duplicates");
  }
  return [...(value as string[])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// --- defaults ----------------------------------------------------------------------

/**
 * The first-party clients from the TASK-0119 design, trusted unless the
 * operator replaces the list. Their iOS bundle id and Android applicationId
 * are each repository's Tauri `identifier`; none has App Store ids or
 * universal links yet.
 */
export const DEFAULT_TRUSTED_NATIVE_CLIENTS: readonly TrustedNativeClient[] =
  parseTrustedNativeClients([
    defaultClient("yurucommu-mobile", "Yurucommu", "com.yurucommu", "yurucommu", "yurucommu"),
    defaultClient("yurumeet-mobile", "Yurumeet", "com.yurumeet", "yurume", "yurumeet"),
    defaultClient("takos-mobile", "Takos", "jp.takos.mobile", "takos", "takos"),
  ]);

/**
 * The built-in clients as reserved-only entries, for a malformed operator
 * list: nothing is verified, but unverified declarations still may not use
 * the Yurucommu, Yurumeet or Takos names, schemes or link hosts.
 */
export const RESERVED_DEFAULT_NATIVE_CLIENTS: readonly TrustedNativeClient[] =
  Object.freeze(
    DEFAULT_TRUSTED_NATIVE_CLIENTS.map((entry) =>
      Object.freeze({ ...entry, reservedOnly: true as const })
    ),
  );

function defaultClient(
  id: string,
  name: string,
  identifier: string,
  scheme: string,
  product: string,
): Record<string, unknown> {
  const templates = [
    `${scheme}://connect?host_url={origin}`,
    `${scheme}://connect?host_url={origin}&product=${product}`,
  ];
  return {
    id,
    name,
    ios: {
      bundleId: identifier,
      schemes: [scheme],
      universalLinkHosts: [],
      templates,
    },
    android: {
      package: identifier,
      schemes: [scheme],
      appLinkHosts: [],
      templates,
    },
  };
}
