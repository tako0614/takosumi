import { readEnvVar } from "./read-env.ts";

/**
 * Reserved env var name that holds the HMAC-SHA256 secret used to sign
 * installation export download URLs. Operators MUST configure this in
 * production; absence at sign time forces the handler to fall back to
 * "not configured" semantics rather than emit unsigned URLs.
 */
export const EXPORT_DOWNLOAD_SECRET_ENV =
  "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET";

const EXPORT_DOWNLOAD_SIGNATURE_PARAM = "tk_sig";
const EXPORT_DOWNLOAD_EXPIRES_PARAM = "tk_exp";
const EXPORT_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

export interface ExportDownloadSigningOptions {
  /** HMAC secret (string or raw bytes). */
  readonly secret: string | Uint8Array;
  /** Override `Date.now()` for deterministic tests. */
  readonly now?: () => number;
  /** Override the 5-minute TTL. */
  readonly ttlMs?: number;
}

/**
 * Sign an installation export download URL with HMAC-SHA256.
 *
 * Adds `tk_exp` (ms-since-epoch expiry) and `tk_sig` (base64url HMAC-SHA256
 * of the URL minus `tk_sig`) query parameters. The verifier (see
 * `verifyExportDownloadUrl`) recomputes the same canonical form and uses
 * constant-time comparison.
 */
export async function signExportDownloadUrl(
  rawUrl: string,
  options: ExportDownloadSigningOptions,
): Promise<{ url: string; expiresAt: string }> {
  const url = exportDownloadUrl(rawUrl, "export download URL");
  const ttlMs = options.ttlMs ?? EXPORT_DOWNLOAD_TTL_MS;
  const expiresAtMs = (options.now?.() ?? Date.now()) + ttlMs;
  url.searchParams.delete(EXPORT_DOWNLOAD_SIGNATURE_PARAM);
  url.searchParams.set(EXPORT_DOWNLOAD_EXPIRES_PARAM, String(expiresAtMs));
  const signature = await computeExportDownloadSignature(
    url.toString(),
    options.secret,
  );
  url.searchParams.set(EXPORT_DOWNLOAD_SIGNATURE_PARAM, signature);
  return {
    url: url.toString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function exportDownloadUrl(rawUrl: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new TypeError(`${label} must not contain embedded credentials`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHttpHost(url.hostname)) return url;
  throw new TypeError(`${label} must be https:// or loopback http://`);
}

function isLoopbackHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  );
}

export type ExportDownloadVerifyResult =
  | { ok: true; expiresAtMs: number }
  | { ok: false; reason: "missing" | "expired" | "signature" };

/**
 * Verify a signed export download URL produced by `signExportDownloadUrl`.
 *
 * Returns a discriminated union rather than throwing so callers can map
 * each failure mode to the correct HTTP envelope (`400 invalid_signature`,
 * `410 expired`, etc.).
 */
export async function verifyExportDownloadUrl(
  rawUrl: string,
  options: {
    readonly secret: string | Uint8Array;
    readonly now?: () => number;
  },
): Promise<ExportDownloadVerifyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "signature" };
  }
  const presentedSignature = url.searchParams.get(
    EXPORT_DOWNLOAD_SIGNATURE_PARAM,
  );
  const expiresAtRaw = url.searchParams.get(EXPORT_DOWNLOAD_EXPIRES_PARAM);
  if (!presentedSignature || !expiresAtRaw) {
    return { ok: false, reason: "missing" };
  }
  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: "signature" };
  }
  if (expiresAtMs <= (options.now?.() ?? Date.now())) {
    return { ok: false, reason: "expired" };
  }
  url.searchParams.delete(EXPORT_DOWNLOAD_SIGNATURE_PARAM);
  const expected = await computeExportDownloadSignature(
    url.toString(),
    options.secret,
  );
  if (!constantTimeStringEqual(expected, presentedSignature)) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, expiresAtMs };
}

async function computeExportDownloadSignature(
  payload: string,
  secret: string | Uint8Array,
): Promise<string> {
  const secretBytes =
    typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  if (secretBytes.byteLength === 0) {
    throw new TypeError("export download signing secret must not be empty");
  }
  const keyMaterial = new Uint8Array(secretBytes.byteLength);
  keyMaterial.set(secretBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64UrlFromBytes(new Uint8Array(digest));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Read the export download signing secret from the operator-configured env
 * var, returning `undefined` when the var is missing or empty.
 *
 * The handler MUST treat absence as "feature unavailable" rather than
 * fall back to unsigned URLs, because the export bundle may contain
 * tenant-scoped material.
 */
export function readExportDownloadSigningSecretFromEnv(): string | undefined {
  const raw = readEnvVar(EXPORT_DOWNLOAD_SECRET_ENV);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
