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
 * Link templates may carry only `{origin}` (the screen URL's origin) and
 * `{url}` (the whole screen URL). The parser fills both URL-encoded, so every
 * consumer (the app view API, the dashboard, Takosumi Mobile) receives the
 * same ready-to-open links and never substitutes anything itself. The only
 * value a handoff link can carry is that public, credential-free screen URL;
 * tokens, sessions and account ids never reach it.
 */
import { hasCredentialQueryParams } from "./interface-display.ts";

/** Maximum length of a native client's display name. */
export const INTERFACE_CLIENT_NAME_MAX_LENGTH = 64;
/** Maximum length of a link template, before and after filling it. */
export const INTERFACE_CLIENT_LINK_MAX_LENGTH = 2_048;
/** Maximum length of an iOS bundle id or Android applicationId. */
export const INTERFACE_CLIENT_IDENTIFIER_MAX_LENGTH = 155;

/** The platforms a screen can declare a native client for. */
export const INTERFACE_CLIENT_PLATFORMS = ["ios", "android"] as const;
export type InterfaceClientPlatform =
  (typeof INTERFACE_CLIENT_PLATFORMS)[number];

/** How a screen opens on a platform with a declared client, by default. */
export type InterfaceClientPreference = "native" | "web";

/**
 * Custom schemes an `open` template may not use. `http`/`https` links belong in
 * `universalLink` / `appLink`; the rest run script, read local data, start
 * system actions (calls, messages, settings, store installs, shortcuts), or
 * target Takosumi Mobile itself (`takosumi`). `intent:` and `android-app:` are
 * built by the dashboard for Android, never declared.
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
  "takosumi",
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
  "ws",
  "wss",
  "ftp",
]);

/** Store link hosts accepted in `ios.storeUrl`. */
export const INTERFACE_CLIENT_IOS_STORE_HOSTS: ReadonlySet<string> = new Set([
  "apps.apple.com",
  "testflight.apple.com",
]);
/** Store link hosts accepted in `android.storeUrl`. */
export const INTERFACE_CLIENT_ANDROID_STORE_HOSTS: ReadonlySet<string> =
  new Set(["play.google.com", "f-droid.org"]);

/** A validated iOS client. Links are filled in, ready to open. */
export interface InterfaceIosClient {
  /** The app name for the choice screen; consumers fall back to the screen title. */
  readonly name?: string;
  /** The App Store id (digits). */
  readonly appStoreId?: string;
  readonly bundleId?: string;
  /** The custom-scheme link with `{origin}` / `{url}` filled in. */
  readonly open?: string;
  /** The publisher-domain https universal link, filled in. */
  readonly universalLink?: string;
  /**
   * Where to install the app: the declared `storeUrl` (App Store or
   * TestFlight), else `https://apps.apple.com/app/id<appStoreId>`.
   */
  readonly storeUrl?: string;
}

/** A validated Android client. Links are filled in, ready to open. */
export interface InterfaceAndroidClient {
  /** The app name for the choice screen; consumers fall back to the screen title. */
  readonly name?: string;
  /** The applicationId. Openers pin the target app to it. */
  readonly package: string;
  /** The custom-scheme link with `{origin}` / `{url}` filled in. */
  readonly open?: string;
  /** The publisher-domain https App Link, filled in. */
  readonly appLink?: string;
  /**
   * Where to install the app: the declared `storeUrl` (Google Play or
   * F-Droid), else the Google Play page of `package`.
   */
  readonly storeUrl: string;
}

/** The validated `document.clients` of one screen. */
export interface InterfaceClients {
  /**
   * The default on a platform listed here: `"native"` unless the declaration
   * says `"web"`. A platform that is not listed has no native choice.
   */
  readonly preferred: InterfaceClientPreference;
  readonly ios?: InterfaceIosClient;
  readonly android?: InterfaceAndroidClient;
}

export interface ParseInterfaceClientsOptions {
  /** The screen's checked launch URL; `{origin}` and `{url}` come from it. */
  readonly surfaceUrl: string;
  /**
   * The Takosumi origin that renders the choice (dashboard / accounts). A
   * universal link or App Link there would be a session-credentialed
   * same-origin navigation the viewer never approved, so it is dropped.
   */
  readonly viewerOrigin?: string;
}

interface TemplateValues {
  readonly origin: string;
  readonly url: string;
}

interface ParseContext {
  readonly values: TemplateValues;
  readonly viewerOrigin?: string;
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
  const viewerOrigin = normalizedOrigin(options.viewerOrigin);
  const context: ParseContext = {
    values,
    ...(viewerOrigin ? { viewerOrigin } : {}),
  };
  const ios = parseIosClient(value.ios, context);
  const android = parseAndroidClient(value.android, context);
  if (!ios && !android) return undefined;
  return {
    preferred: value.preferred === "web" ? "web" : "native",
    ...(ios ? { ios } : {}),
    ...(android ? { android } : {}),
  };
}

function parseIosClient(
  value: unknown,
  context: ParseContext,
): InterfaceIosClient | undefined {
  if (!isRecord(value)) return undefined;
  const open = customSchemeLink(value.open, context);
  const universalLink = publisherLink(value.universalLink, context);
  // A platform that cannot open the app is not declared at all.
  if (!open && !universalLink) return undefined;
  const name = clientName(value.name);
  const appStoreId = appStoreIdentifier(value.appStoreId);
  const bundleId = reverseDnsIdentifier(value.bundleId, BUNDLE_ID_PATTERN);
  const storeUrl =
    storeLink(value.storeUrl, INTERFACE_CLIENT_IOS_STORE_HOSTS) ??
    (appStoreId ? `https://apps.apple.com/app/id${appStoreId}` : undefined);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(appStoreId !== undefined ? { appStoreId } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(universalLink !== undefined ? { universalLink } : {}),
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
  const packageName = reverseDnsIdentifier(
    value.package,
    ANDROID_PACKAGE_PATTERN,
  );
  if (!packageName) return undefined;
  const open = customSchemeLink(value.open, context);
  const appLink = publisherLink(value.appLink, context);
  if (!open && !appLink) return undefined;
  const name = clientName(value.name);
  const storeUrl =
    storeLink(value.storeUrl, INTERFACE_CLIENT_ANDROID_STORE_HOSTS) ??
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`;
  return {
    ...(name !== undefined ? { name } : {}),
    package: packageName,
    ...(open !== undefined ? { open } : {}),
    ...(appLink !== undefined ? { appLink } : {}),
    storeUrl,
  };
}

// --- links -----------------------------------------------------------------------

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u;
const PLACEHOLDER_PATTERN = /\{(origin|url)\}/gu;
/** Printable ASCII without space. */
const LINK_CHARACTERS = /^[\x21-\x7e]+$/u;
/** Printable characters that are never valid in a URL. */
const LINK_FORBIDDEN_CHARACTERS = /["<>\\^`|]/u;

/**
 * A custom-scheme `open` template. The scheme is lowercase and not blocked;
 * the link has no userinfo, no credential-named query parameter and no
 * fragment (the Android dashboard appends `#Intent;...;end` after it, so a
 * declared fragment could add intent extras).
 */
function customSchemeLink(
  value: unknown,
  context: ParseContext,
): string | undefined {
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
  const filled = parsedLink(fill(template, context.values));
  if (!filled || filled.protocol !== `${scheme}:` || filled.hash) {
    return undefined;
  }
  return withinLinkLimit(filled.href);
}

/**
 * A `universalLink` / `appLink` template: https on the default port of a
 * named publisher domain that the placeholders cannot change, without
 * userinfo or credential-named parameters, and not on Takosumi's own origin.
 */
function publisherLink(
  value: unknown,
  context: ParseContext,
): string | undefined {
  const template = linkTemplate(value);
  // A fixed, non-empty host right after `https://`.
  if (!template || !/^https:\/\/[^/?#]/u.test(template)) return undefined;
  if (placeholderBeforePath(template.slice("https:".length))) return undefined;
  const sample = parsedLink(fill(template, SAMPLE_VALUES));
  if (!sample || !isPublisherHttpsUrl(sample)) return undefined;
  if (hasCredentialParameters(sample)) return undefined;
  const filled = parsedLink(fill(template, context.values));
  if (
    !filled ||
    !isPublisherHttpsUrl(filled) ||
    filled.origin !== sample.origin ||
    filled.origin === context.viewerOrigin
  ) {
    return undefined;
  }
  return withinLinkLimit(filled.href);
}

/** An App Store / Play / TestFlight / F-Droid https link. Not a template. */
function storeLink(
  value: unknown,
  hosts: ReadonlySet<string>,
): string | undefined {
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
    !hosts.has(url.hostname) ||
    hasCredentialParameters(url)
  ) {
    return undefined;
  }
  return withinLinkLimit(url.href);
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
  return /[{}]/u.test(value.replace(PLACEHOLDER_PATTERN, ""))
    ? undefined
    : value;
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
  return /^[a-z0-9.-]+$/u.test(hostname) && !hostname.endsWith(".");
}

/** Credential-named parameters in the query or in a `#name=value` fragment. */
function hasCredentialParameters(url: URL): boolean {
  return (
    hasCredentialQueryParams(url.searchParams) ||
    hasCredentialQueryParams(new URLSearchParams(url.hash.slice(1)))
  );
}

function withinLinkLimit(link: string): string | undefined {
  return link.length <= INTERFACE_CLIENT_LINK_MAX_LENGTH ? link : undefined;
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
/** Control characters and bidirectional overrides that could disguise a name. */
const NAME_FORBIDDEN_CHARACTERS =
  /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

function clientName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (
    !name ||
    [...name].length > INTERFACE_CLIENT_NAME_MAX_LENGTH ||
    NAME_FORBIDDEN_CHARACTERS.test(name)
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

function reverseDnsIdentifier(
  value: unknown,
  pattern: RegExp,
): string | undefined {
  return typeof value === "string" &&
    value.length <= INTERFACE_CLIENT_IDENTIFIER_MAX_LENGTH &&
    pattern.test(value)
    ? value
    : undefined;
}

// --- helpers ---------------------------------------------------------------------

function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = parsedLink(value);
  return url && url.origin !== "null" ? url.origin : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
