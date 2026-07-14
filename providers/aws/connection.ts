/**
 * AWS STS AssumeRole connection primitives (provider-internal).
 *
 * This provider-owned module implements AWS SigV4 signing, form encoding, STS
 * response parsing, and the network-facing AssumeRole exchange. The Vault opens
 * sealed source credentials and passes only the material needed by this driver.
 *
 * The crypto/secret-opening stays in core: this module only ever sees
 * already-opened string values (the access key id / secret access key / session
 * token the caller hands in). The `fetch` and `now` seams are injected so the
 * exchange is unit-testable without real network or wall-clock. Typed failures
 * map to the Vault's stable `failed_precondition` surface.
 */

/** Injected fetch seam so the STS exchange is unit-testable without real network. */
export type AwsFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Error raised when the AssumeRole exchange (or its preconditions) fails. The
 * `code` mirrors the deploy-control error codes the vault raises so the caller
 * can translate it identically to the in-vault `ConnectionVaultError`.
 */
export class AwsConnectionError extends Error {
  readonly code: "failed_precondition";

  constructor(message: string) {
    super(message);
    this.name = "AwsConnectionError";
    this.code = "failed_precondition";
  }
}

/** Source credentials + role context for one AssumeRole exchange. */
export interface AssumeAwsRoleInput {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly roleArn: string;
  readonly externalId?: string;
  readonly region: string;
  readonly sessionName: string;
}

/** Temporary credentials minted by a successful AssumeRole exchange. */
export interface AssumedAwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

/**
 * Perform an AWS STS `AssumeRole` exchange and return the minted temporary
 * credentials. Extracted verbatim from the vault's `#assumeAwsRole`.
 *
 * @param input source long-lived credentials + role/session/region context.
 * @param deps injected `fetch` / `now` seams (default to the global `fetch` and
 *   `new Date()` so production callers need not wire them).
 */
export async function assumeAwsRole(
  input: AssumeAwsRoleInput,
  deps: { readonly fetch?: AwsFetch; readonly now?: () => Date } = {},
): Promise<AssumedAwsCredentials> {
  const doFetch: AwsFetch =
    deps.fetch ?? ((target, init) => fetch(target, init));
  const nowFn = deps.now ?? (() => new Date());

  const payload = formEncode({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: input.roleArn,
    RoleSessionName: input.sessionName,
    DurationSeconds: "3600",
    ...(input.externalId ? { ExternalId: input.externalId } : {}),
  });
  const host = `sts.${input.region}.amazonaws.com`;
  const url = `https://${host}/`;
  const now = nowFn();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host,
    "x-amz-date": amzDate,
    ...(input.sessionToken
      ? { "x-amz-security-token": input.sessionToken }
      : {}),
  };
  const authorization = await awsSigV4Authorization({
    method: "POST",
    path: "/",
    query: "",
    headers,
    payload,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    dateStamp,
    region: input.region,
    service: "sts",
  });
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        ...headers,
        authorization,
      },
      body: payload,
    });
  } catch (error) {
    throw new AwsConnectionError(
      `aws sts AssumeRole request failed: ${errorMessage(error)}`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new AwsConnectionError(
      `aws sts AssumeRole returned http ${response.status}: ${awsXmlTag(text, "Code") ?? "unknown_error"}`,
    );
  }
  const credentials = {
    accessKeyId: awsXmlTag(text, "AccessKeyId"),
    secretAccessKey: awsXmlTag(text, "SecretAccessKey"),
    sessionToken: awsXmlTag(text, "SessionToken"),
    expiration: awsXmlTag(text, "Expiration"),
  };
  if (
    !credentials.accessKeyId ||
    !credentials.secretAccessKey ||
    !credentials.sessionToken ||
    !credentials.expiration
  ) {
    throw new AwsConnectionError(
      "aws sts AssumeRole response did not include complete temporary credentials",
    );
  }
  const expirationMs = Date.parse(credentials.expiration);
  if (!Number.isFinite(expirationMs)) {
    throw new AwsConnectionError(
      "aws sts AssumeRole response included an invalid Expiration",
    );
  }
  const ttlSeconds = Math.floor((expirationMs - now.getTime()) / 1000);
  if (ttlSeconds <= 0) {
    throw new AwsConnectionError(
      "aws sts AssumeRole response returned already-expired credentials",
    );
  }
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiresAt: new Date(expirationMs).toISOString(),
    ttlSeconds,
  };
}

/**
 * Deterministic STS `RoleSessionName` for a connection id. Extracted verbatim
 * from the vault's `awsRoleSessionName`: sanitize to the STS-allowed character
 * class, cap the suffix at 32 chars, and the whole name at 64.
 */
export function awsRoleSessionName(connectionId: string): string {
  const suffix = connectionId.replace(/[^A-Za-z0-9+=,.@-]/g, "-").slice(0, 32);
  return `takosumi-${suffix}`.slice(0, 64);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formEncode(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

async function awsSigV4Authorization(input: {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}): Promise<string> {
  const canonicalHeaderEntries = Object.entries(input.headers)
    .map(
      ([name, value]) =>
        [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(";");
  const canonicalHeaders = canonicalHeaderEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const payloadHash = await sha256Hex(input.payload);
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const amzDate = input.headers["x-amz-date"] ?? input.headers["X-Amz-Date"];
  if (!amzDate) {
    throw new AwsConnectionError("aws sts signing requires x-amz-date");
  }
  const credentialScope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await awsSigV4SigningKey(
    input.secretAccessKey,
    input.dateStamp,
    input.region,
    input.service,
  );
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  return [
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
}

async function awsSigV4SigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(utf8(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

async function hmacSha256(
  keyBytes: Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBufferFromBytes(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, arrayBufferFromBytes(utf8(data))),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBufferFromBytes(utf8(value)),
  );
  return bytesToHex(new Uint8Array(digest));
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(bytes);
  return buffer;
}

function awsXmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
