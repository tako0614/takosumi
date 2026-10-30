/**
 * Declarative Web Push message (WebKit, Safari 18.4+): JSON a user agent can
 * show without running a Service Worker; Takosumi Mobile shows the same fields
 * natively after decrypting.
 *
 * {"web_push": 8030, "notification": {"title", "navigate", ...}}
 */

import { utf8 } from "./bytes.ts";

const DECLARATIVE_WEB_PUSH_MAGIC = 8030;
/**
 * Plaintext budget. The relay accepts 2,800 bytes after encryption (which adds
 * 103 bytes) so it fits an APNs/FCM payload once base64url-encoded.
 */
export const MAX_DECLARATIVE_WEB_PUSH_BYTES = 2048;

export interface DeclarativeWebPushMessage {
  readonly web_push: typeof DECLARATIVE_WEB_PUSH_MAGIC;
  readonly notification: {
    readonly title: string;
    readonly navigate: string;
    readonly body?: string;
    readonly lang?: string;
    readonly tag?: string;
  };
}

export interface DeclarativeWebPushInput {
  /** The instance origin; `navigate` must stay on it. */
  readonly origin: string;
  readonly title: string;
  /** Absolute URL or a path resolved against `origin`. */
  readonly navigate: string;
  readonly body?: string;
  readonly lang?: string;
  readonly tag?: string;
  readonly maxBytes?: number;
}

/**
 * Build the message and its UTF-8 JSON. `navigate` falls back to the origin
 * root if it would leave the origin; the body (then the title) is shortened
 * until the plaintext fits `maxBytes`.
 */
export function buildDeclarativeWebPushMessage(input: DeclarativeWebPushInput): {
  readonly message: DeclarativeWebPushMessage;
  readonly json: string;
} {
  const origin = new URL(input.origin).origin;
  const maxBytes = input.maxBytes ?? MAX_DECLARATIVE_WEB_PUSH_BYTES;
  const navigate = sameOriginUrl(input.navigate, origin);
  const lang = normalizeLanguageTag(input.lang);
  const tag = input.tag?.trim().slice(0, 64) || undefined;
  let title = singleLine(input.title) || new URL(origin).hostname;
  let body = input.body ? singleLine(input.body) || undefined : undefined;
  for (;;) {
    const message: DeclarativeWebPushMessage = {
      web_push: DECLARATIVE_WEB_PUSH_MAGIC,
      notification: {
        title,
        navigate,
        ...(body ? { body } : {}),
        ...(lang ? { lang } : {}),
        ...(tag ? { tag } : {}),
      },
    };
    const json = JSON.stringify(message);
    const size = utf8(json).byteLength;
    if (size <= maxBytes) return { message, json };
    const excess = size - maxBytes;
    if (body) {
      body = shorten(body, excess);
    } else if ([...title].length > 1) {
      title = shorten(title, excess) ?? [...title][0]!;
    } else {
      throw new Error("declarative web push message cannot fit the size limit");
    }
  }
}

function sameOriginUrl(value: string, origin: string): string {
  try {
    const url = new URL(value, `${origin}/`);
    if (url.origin === origin && !url.username && !url.password) return url.href;
  } catch {
    // fall through
  }
  return `${origin}/`;
}

function normalizeLanguageTag(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(text)
    ? text
    : undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Drop at least `excessBytes` from the end (whole code points) and add an ellipsis. */
function shorten(value: string, excessBytes: number): string | undefined {
  const codePoints = [...value];
  let removed = 0;
  while (codePoints.length > 0 && removed < excessBytes + 3) {
    removed += utf8(codePoints.pop()!).byteLength;
  }
  const kept = codePoints.join("").trimEnd();
  return kept ? `${kept}…` : undefined;
}
