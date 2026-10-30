/**
 * One Web Push request (RFC 8030 §5) with VAPID (RFC 8292) and aes128gcm
 * (RFC 8291), and the classification of the push service's answer.
 */

import { toArrayBuffer, utf8 } from "./bytes.ts";
import { encryptWebPushPayload } from "./encrypt.ts";
import { vapidAuthorization, type VapidKeyPair } from "./vapid.ts";

const MAX_WEB_PUSH_TTL_SECONDS = 28 * 24 * 60 * 60;
const DEFAULT_WEB_PUSH_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SECONDS = 12 * 60 * 60;

export type WebPushUrgency = "very-low" | "low" | "normal" | "high";

export interface WebPushTarget {
  /** Push resource URL: the pusher's `data.url`. */
  readonly endpoint: string;
  /** The pusher's `pushkey`: the device's uncompressed P-256 point. */
  readonly p256dh: Uint8Array;
  /** The pusher's `data.auth`, 16 bytes. */
  readonly auth: Uint8Array;
}

export interface WebPushMessage {
  readonly payload: Uint8Array | string;
  readonly ttlSeconds: number;
  readonly urgency?: WebPushUrgency;
  /** Replaces an undelivered message with the same topic (1-32 base64url). */
  readonly topic?: string;
}

export interface WebPushSendContext {
  readonly vapid: VapidKeyPair;
  /** VAPID `sub`: the instance origin. */
  readonly subject: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * - delivered: 2xx.
 * - gone: 404 or 410. The subscription no longer exists; the pusher is deleted.
 * - retry: timeout, network error, 408, 429 or 5xx. Send again later, no
 *   sooner than `retryAfterSeconds` (from `Retry-After`, 0 when absent).
 * - failed: 3xx and every other 4xx, 403 and 413 included. Kept, not retried.
 *   A 403 usually means the instance's own VAPID key or signature is wrong
 *   (for example after the passphrase rotated); deleting on it would erase
 *   every pusher at once.
 */
export type WebPushOutcome =
  | { readonly kind: "delivered"; readonly status: number }
  | { readonly kind: "gone"; readonly status: number }
  | {
      readonly kind: "retry";
      readonly status: number | null;
      readonly retryAfterSeconds: number;
      readonly error: string;
    }
  | {
      readonly kind: "failed";
      readonly status: number | null;
      readonly error: string;
    };

export function classifyWebPushResponse(
  status: number,
  retryAfter: string | null,
  nowMs: number = Date.now(),
): WebPushOutcome {
  if (status >= 200 && status < 300) return { kind: "delivered", status };
  if (status === 404 || status === 410) return { kind: "gone", status };
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    return {
      kind: "retry",
      status,
      retryAfterSeconds: parseRetryAfter(retryAfter, nowMs),
      error: `push service HTTP ${status}`,
    };
  }
  // 3xx (redirects are never followed; an opaque redirect reports 0), and
  // every other 4xx including 401, 403 and 413.
  return {
    kind: "failed",
    status: status || null,
    error: `push service HTTP ${status}`,
  };
}

export async function sendWebPush(
  target: WebPushTarget,
  message: WebPushMessage,
  context: WebPushSendContext,
): Promise<WebPushOutcome> {
  const now = context.now ?? Date.now;
  let headers: Headers;
  let body: Uint8Array;
  try {
    const payload =
      typeof message.payload === "string"
        ? utf8(message.payload)
        : message.payload;
    body = await encryptWebPushPayload({
      plaintext: payload,
      userAgentPublicKey: target.p256dh,
      authSecret: target.auth,
    });
    headers = new Headers({
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(normalizeTtl(message.ttlSeconds)),
      Authorization: await vapidAuthorization(
        context.vapid,
        { endpoint: target.endpoint, subject: context.subject },
        now(),
      ),
    });
    if (message.urgency) headers.set("Urgency", message.urgency);
    if (message.topic !== undefined) {
      if (!isValidWebPushTopic(message.topic)) {
        throw new Error("Topic must be 1-32 base64url characters");
      }
      headers.set("Topic", message.topic);
    }
  } catch (error) {
    // A message that cannot even be built will not succeed on a retry.
    return {
      kind: "failed",
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    context.timeoutMs ?? DEFAULT_WEB_PUSH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await (context.fetch ?? fetch)(target.endpoint, {
      method: "POST",
      headers,
      body: toArrayBuffer(body),
      // Never follow: a 3xx is a permanent failure.
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    return {
      kind: "retry",
      status: null,
      retryAfterSeconds: 0,
      error:
        error instanceof Error && error.name === "AbortError"
          ? "push service timed out"
          : "push service unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
  // The body is never used; release the connection.
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
  return classifyWebPushResponse(
    response.type === "opaqueredirect" ? 0 : response.status,
    response.headers.get("Retry-After"),
    now(),
  );
}

export function isValidWebPushTopic(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

function normalizeTtl(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_WEB_PUSH_TTL_SECONDS, Math.floor(value)));
}

function parseRetryAfter(value: string | null, nowMs: number): number {
  if (!value) return 0;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    return Math.min(MAX_RETRY_AFTER_SECONDS, Number(text));
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(0, Math.ceil((timestamp - nowMs) / 1000)),
  );
}
