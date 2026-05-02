/**
 * Minimal AWS Signature Version 4 signer over `fetch()`.
 *
 * Used by the `Direct*Lifecycle` classes in `shape-providers/<shape>/*-direct.ts`
 * so operators can call AWS REST APIs in-process without spawning a separate
 * gateway service.
 *
 * Scope kept intentionally narrow:
 *  - GET / POST / PUT / DELETE
 *  - SHA-256 of body / payload
 *  - Canonical request -> string-to-sign -> signing key (date / region / service)
 *  - Authorization header (no presigned URLs, no STS / chunk encoding)
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
 */

export interface AwsSigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface AwsSigV4Request {
  readonly method: string;
  readonly url: string | URL;
  readonly service: string;
  readonly region: string;
  readonly headers?: HeadersInit;
  readonly body?: string | Uint8Array;
  readonly now?: Date;
}

export interface AwsSigV4FetchOptions {
  readonly credentials: AwsSigV4Credentials;
  readonly fetch?: typeof fetch;
}

/**
 * Wraps fetch with SigV4 signing. Returns the raw `Response`. Caller is
 * responsible for parsing JSON / XML / text and translating HTTP status.
 */
export async function sigv4Fetch(
  request: AwsSigV4Request,
  options: AwsSigV4FetchOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL(`${request.url}`);
  const headers = new Headers(request.headers);
  const bodyBytes = request.body == null
    ? new Uint8Array(0)
    : typeof request.body === "string"
    ? new TextEncoder().encode(request.body)
    : request.body;

  const now = request.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(bodyBytes);

  headers.set("x-amz-date", amzDate);
  headers.set("x-amz-content-sha256", payloadHash);
  if (!headers.has("host")) headers.set("host", url.host);
  if (options.credentials.sessionToken) {
    headers.set("x-amz-security-token", options.credentials.sessionToken);
  }

  const canonicalQuery = canonicalQueryString(url.searchParams);
  const sortedHeaderNames = Array.from(headers.keys())
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${(headers.get(name) ?? "").trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUriPath(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope =
    `${dateStamp}/${request.region}/${request.service}/aws4_request`;

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    options.credentials.secretAccessKey,
    dateStamp,
    request.region,
    request.service,
  );
  const signature = bytesToHex(
    await hmacSha256(signingKey, new TextEncoder().encode(stringToSign)),
  );

  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );

  return fetchImpl(url, {
    method: request.method,
    headers,
    body: bodyBytes.byteLength === 0
      ? undefined
      // deno-lint-ignore no-explicit-any
      : (bodyBytes as any as BodyInit),
  });
}

function formatAmzDate(date: Date): string {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return iso; // YYYYMMDDTHHMMSSZ
}

function canonicalQueryString(params: URLSearchParams): string {
  const entries: [string, string][] = [];
  for (const [k, v] of params.entries()) entries.push([k, v]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k).replaceAll("+", "%20")}=${
          encodeURIComponent(v).replaceAll("+", "%20")
        }`,
    )
    .join("&");
}

function canonicalUriPath(path: string): string {
  if (!path) return "/";
  return path.split("/").map((seg) =>
    encodeURIComponent(seg).replaceAll("+", "%20")
  ).join("/");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", asBufferSource(data));
  return bytesToHex(new Uint8Array(buf));
}

async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    asBufferSource(data),
  );
  return new Uint8Array(sig);
}

/**
 * Workaround for the lib.dom.d.ts overloads expecting `ArrayBuffer` (not
 * `ArrayBufferLike`). Deno's TextEncoder produces `Uint8Array<ArrayBufferLike>`
 * which is structurally compatible but rejected by the strict overload.
 */
function asBufferSource(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    // deno-lint-ignore no-explicit-any
    return data.buffer as any as ArrayBuffer;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  // deno-lint-ignore no-explicit-any
  return copy.buffer as any as ArrayBuffer;
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const kDate = await hmacSha256(
    enc.encode(`AWS4${secret}`),
    enc.encode(dateStamp),
  );
  const kRegion = await hmacSha256(kDate, enc.encode(region));
  const kService = await hmacSha256(kRegion, enc.encode(service));
  return await hmacSha256(kService, enc.encode("aws4_request"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Throw a useful error message that includes status, statusText, and the
 * response body. Used by all Direct* AWS lifecycles.
 */
export async function ensureAwsResponseOk(
  response: Response,
  context: string,
): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new Error(
    `${context} failed: HTTP ${response.status} ${response.statusText}${
      text ? `: ${text}` : ""
    }`,
  );
}
