import type { IsoTimestamp, JsonObject, JsonValue } from "./types.ts";

export const NOTIFICATION_PUSHER_REGISTRATION_PATH =
  "/api/notifications/pushers" as const;

export const MATRIX_PUSH_GATEWAY_NOTIFY_PATH =
  "/_matrix/push/v1/notify" as const;

/**
 * Pushers v2 discovery, with the same authentication as registration. A 404
 * means a v1 host that accepts only `http` pushers; see
 * `parseNotificationPusherCapabilitiesResponse`.
 */
export const NOTIFICATION_PUSHER_CAPABILITIES_PATH =
  "/api/notifications/pushers/capabilities" as const;

/** The capabilities document version a pushers v2 host serves. */
export const NOTIFICATION_PUSHER_CAPABILITIES_VERSION = 2 as const;

/** The Web Push content coding (RFC 8291); never the legacy `aesgcm` draft. */
export const NOTIFICATION_WEB_PUSH_CONTENT_ENCODING = "aes128gcm" as const;

/** The `TTL` a host sends unless the product sets another (MSC4174). */
export const NOTIFICATION_WEB_PUSH_DEFAULT_TTL_SECONDS = 172_800;

/**
 * The largest plaintext that fits one aes128gcm record within the 4096 bytes a
 * push service must accept: 4096 minus the 86-byte header, the 16-byte tag
 * and one padding delimiter (RFC 8291 §4).
 */
export const MAX_NOTIFICATION_WEB_PUSH_PLAINTEXT_BYTES = 3993;

/** Activation acknowledgement for `webpush` pushers (MSC4174 `pushers/ack`). */
export const NOTIFICATION_PUSHER_ACK_PATH =
  "/api/notifications/pushers/ack" as const;

/** How long an activation `ack_token` stays valid after the host issues it. */
export const NOTIFICATION_PUSHER_ACK_TOKEN_LIFETIME_SECONDS = 5 * 60;

/** HTTP status for each ack failure, following MSC4174. */
export const NOTIFICATION_PUSHER_ACK_ERROR_STATUS: Readonly<
  Record<NotificationPusherAckErrorCode, 400 | 404>
> = Object.freeze({
  NOT_FOUND: 404,
  EXPIRED_ACTIVATION_TOKEN: 400,
  UNKNOWN_ACTIVATION_TOKEN: 400,
});

/** Maximum UTF-8 JSON size persisted for `pusher.data` after removing `url`. */
export const MAX_NOTIFICATION_PUSHER_DATA_BYTES = 2 * 1024;

const MAX_NOTIFICATION_PUSHER_DATA_DEPTH = 8;
const MAX_NOTIFICATION_PUSHER_DATA_ENTRIES = 64;
const MAX_NOTIFICATION_PUSHER_DATA_ARRAY_LENGTH = 64;
const MAX_NOTIFICATION_PUSHER_DATA_KEY_BYTES = 128;
const MAX_NOTIFICATION_PUSHER_DATA_STRING_BYTES = 1024;
const MAX_NOTIFICATION_PUSH_URL_LENGTH = 2048;
const MAX_NOTIFICATION_PUSHER_ACK_TOKEN_LENGTH = 255;
const MAX_NOTIFICATION_CAPABILITY_GATEWAY_HOSTS = 64;
const MAX_NOTIFICATION_CAPABILITY_FORMATS = 16;
const WEB_PUSH_P256DH_BYTES = 65;
const WEB_PUSH_AUTH_SECRET_BYTES = 16;
/**
 * Top-level labels that never name a public push service: loopback and mDNS
 * names, private-use and home-network suffixes, reverse-DNS, and names that
 * cannot resolve on the public Internet.
 */
const NON_PUBLIC_TOP_LEVEL_LABELS: ReadonlySet<string> = new Set([
  "arpa",
  "corp",
  "home",
  "internal",
  "intranet",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "onion",
  "private",
]);
const UTF8_ENCODER = new TextEncoder();

/**
 * `http` (v1): the host posts the Matrix envelope to the gateway at
 * `data.url`, and the gateway holds the provider credentials. `webpush`
 * (MSC4174): the host delivers to the push resource in `data.url` itself,
 * signing with its own VAPID key (RFC 8292) and encrypting to the `pushkey`
 * (p256dh) and `data.auth` with aes128gcm (RFC 8291).
 */
export type NotificationPusherKind = "http" | "webpush";
export type NotificationPushFormat = "event_id_only" | "full";
export type NotificationPushPriority = "high" | "low";

export type NotificationPusherData = JsonObject & {
  readonly url: string;
  readonly format?: NotificationPushFormat;
};

/** An `http` pusher: the v1 shape, delivered through a gateway. */
export interface NotificationPusher {
  readonly kind: "http";
  readonly app_id: string;
  readonly pushkey: string;
  readonly app_display_name?: string;
  readonly device_display_name?: string;
  readonly profile_tag?: string;
  readonly lang?: string;
  readonly data: NotificationPusherData;
}

export interface NotificationPusherSetRequest {
  readonly pusher: NotificationPusher;
  readonly product?: string;
  readonly scope?: string;
}

export interface ParsedNotificationPusherSetRequest {
  readonly pusher: NotificationPusher;
  readonly product: string | null;
  readonly scope: string | null;
  readonly gatewayUrl: string;
}

export interface NotificationPusherDeleteRequest {
  readonly app_id: string;
  readonly pushkey: string;
  readonly product?: string;
  readonly scope?: string;
}

export interface ParsedNotificationPusherDeleteRequest {
  readonly appId: string;
  readonly pushkey: string;
  readonly product: string | null;
  readonly scope: string | null;
}

export interface NotificationPusherRegistration {
  readonly id: string;
  readonly kind: "http";
  readonly app_id: string;
  readonly app_display_name?: string;
  readonly device_display_name?: string;
  readonly profile_tag?: string;
  readonly lang?: string;
  readonly data: Omit<NotificationPusherData, "url">;
  readonly gateway_url: string;
  readonly product?: string | null;
  readonly scope?: string | null;
  readonly registered_at: IsoTimestamp;
  readonly last_seen_at: IsoTimestamp;
}

export interface NotificationPusherSetResponse {
  readonly pusher: NotificationPusherRegistration;
}

export interface NotificationPusherDeleteResponse {
  readonly deleted: true;
}

export interface NotificationPushCounts {
  readonly unread?: number;
  readonly missed_calls?: number;
  readonly [key: string]: number | undefined;
}

export type NotificationPushTweaks = JsonObject;

export interface NotificationPushGatewayDevice {
  readonly app_id: string;
  readonly pushkey: string;
  readonly pushkey_ts?: number;
  readonly data: Omit<NotificationPusherData, "url">;
  readonly tweaks?: NotificationPushTweaks;
}

export interface NotificationPushGatewayNotification {
  readonly event_id?: string;
  readonly room_id?: string;
  readonly type?: string;
  readonly sender?: string;
  readonly sender_display_name?: string;
  readonly room_name?: string;
  readonly room_alias?: string;
  readonly user_is_target?: boolean;
  readonly prio?: NotificationPushPriority;
  readonly content?: JsonObject;
  readonly counts?: NotificationPushCounts;
  readonly devices: readonly NotificationPushGatewayDevice[];
}

export interface NotificationPushGatewayRequest {
  readonly notification: NotificationPushGatewayNotification;
}

export interface NotificationPushGatewayResponse {
  readonly rejected: readonly string[];
  /**
   * Optional Takos extension for partial transient failure. When present on a
   * retryable response, the host retries only these pushkeys instead of
   * redelivering devices that already succeeded.
   */
  readonly retryable?: readonly string[];
  /** Permanent delivery failures that must not be retried or deleted. */
  readonly failed?: readonly string[];
}

export interface NotificationPushEventInput {
  readonly id?: string;
  readonly scopeId?: string;
  readonly type?: string;
  readonly sender?: string;
  readonly senderDisplayName?: string;
  readonly scopeName?: string;
  readonly scopeAlias?: string;
  readonly userIsTarget?: boolean;
  readonly priority?: NotificationPushPriority;
  readonly content?: JsonObject;
  readonly counts?: NotificationPushCounts;
}

export interface CreateNotificationPushGatewayRequestInput {
  readonly event?: NotificationPushEventInput;
  readonly pushers: readonly NotificationPusher[];
  readonly now?: Date;
  readonly tweaks?: NotificationPushTweaks;
}

export interface NotificationPusherParseError {
  readonly code: "BAD_REQUEST";
  readonly error: string;
  readonly field?: string;
}

/**
 * Normalize a pusher gateway endpoint without widening host egress to
 * credential-bearing or cleartext remote URLs. HTTP is reserved for local
 * loopback development.
 */
export function normalizeNotificationPusherGatewayUrl(
  value: unknown,
): string | null {
  const text = parseNonEmptyString(value);
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:") {
      return url.port && url.port !== "443" ? null : url.toString();
    }
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export type NotificationPusherSetParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedNotificationPusherSetRequest;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    };

export type NotificationPusherDeleteParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedNotificationPusherDeleteRequest;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    };

export interface ParsedNotificationPushGatewayRequest {
  readonly request: NotificationPushGatewayRequest;
}

export type NotificationPushGatewayParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedNotificationPushGatewayRequest;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    };

/** `webpush` pusher data, laid out as in MSC4174. */
export type NotificationWebPushPusherData = JsonObject & {
  /** The RFC 8030 push resource (`PushSubscription.endpoint`) to POST to. */
  readonly url: string;
  /**
   * The RFC 8291 authentication secret: unpadded base64url of 16 bytes.
   * Never list or log it.
   */
  readonly auth: string;
  /** A Web Push body carries ids and counts only. */
  readonly format: "event_id_only";
  /**
   * Takos extension for key rotation: the capabilities `vapid_key_id` the
   * subscription was created with.
   */
  readonly vapid_key_id: string;
};

/** `webpush` pusher data as returned to clients: everything except `auth`. */
export type NotificationWebPushPusherPublicData = JsonObject & {
  readonly url: string;
  readonly format: "event_id_only";
  readonly vapid_key_id: string;
  readonly auth?: never;
};

/** A `webpush` pusher, delivered by the host itself. */
export interface NotificationWebPushPusher {
  readonly kind: "webpush";
  readonly app_id: string;
  /**
   * The user agent's ECDH public key (`PushSubscription.getKey("p256dh")`):
   * unpadded base64url of a 65-byte uncompressed P-256 point. Public, and
   * stable for the life of the subscription.
   */
  readonly pushkey: string;
  readonly app_display_name?: string;
  readonly device_display_name?: string;
  readonly profile_tag?: string;
  readonly lang?: string;
  readonly data: NotificationWebPushPusherData;
}

/** Any pusher a v2 host registers. */
export type NotificationPusherV2 =
  NotificationPusher | NotificationWebPushPusher;

export interface NotificationPusherSetRequestV2 {
  readonly pusher: NotificationPusherV2;
  readonly product?: string;
  readonly scope?: string;
  /**
   * Matrix `append`. Omitted or false: registering also removes the same
   * (`app_id`, `pushkey`) registered by any other account on this host, so a
   * device that switched accounts stops receiving the previous account's
   * notifications. True keeps those other registrations.
   */
  readonly append?: boolean;
}

export interface ParsedNotificationHttpPusherSetRequest extends ParsedNotificationPusherSetRequest {
  readonly kind: "http";
  readonly append: boolean;
}

export interface ParsedNotificationWebPushPusherSetRequest {
  readonly kind: "webpush";
  readonly pusher: NotificationWebPushPusher;
  readonly product: string | null;
  readonly scope: string | null;
  /** The push resource the host POSTs to; always equal to `pusher.data.url`. */
  readonly pushResourceUrl: string;
  readonly append: boolean;
}

export type ParsedNotificationPusherSetRequestV2 =
  | ParsedNotificationHttpPusherSetRequest
  | ParsedNotificationWebPushPusherSetRequest;

export interface NotificationPusherSetRequestV2Options {
  readonly product?: string;
  /**
   * The `kinds` of the capabilities document this host serves. Only listed
   * kinds register, `http` gateways must match a listed `gateway_hosts` entry,
   * and `webpush` pushers must name the listed `vapid_key_id`.
   */
  readonly kinds: NotificationPusherKindCapabilities;
  /**
   * Optional operator allowlist for `webpush` push resource hosts, as
   * `push.example.com` or `*.example.com`. Omitted: any public host.
   * `gateway_hosts` never applies to `webpush`.
   */
  readonly pushResourceHosts?: readonly string[];
}

export type NotificationPusherSetV2ParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedNotificationPusherSetRequestV2;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    };

export interface NotificationWebPushPusherRegistration {
  readonly id: string;
  readonly kind: "webpush";
  readonly app_id: string;
  readonly app_display_name?: string;
  readonly device_display_name?: string;
  readonly profile_tag?: string;
  readonly lang?: string;
  readonly data: NotificationWebPushPusherPublicData;
  /**
   * False until the client acknowledges the activation push (MSC4174). The
   * host sends nothing else to the pusher meanwhile.
   */
  readonly activated: boolean;
  readonly product?: string | null;
  readonly scope?: string | null;
  readonly registered_at: IsoTimestamp;
  readonly last_seen_at: IsoTimestamp;
}

/**
 * The body of a successful `POST /api/notifications/pushers`. A `webpush`
 * registration with `activated: false` means "set, but needs activation": the
 * host answers 201, as MSC4174 does, and has sent the activation push. Clients
 * read `activated` rather than relying on the status code.
 */
export interface NotificationPusherSetResponseV2 {
  readonly pusher:
    NotificationPusherRegistration | NotificationWebPushPusherRegistration;
}

/**
 * Entries of `GET /api/notifications/pushers`: the caller's own pushers. They
 * carry `pushkey` so a client can delete a stale device, and never `data.auth`.
 */
export interface NotificationHttpPusherListEntry extends NotificationPusherRegistration {
  readonly pushkey: string;
}

export interface NotificationWebPushPusherListEntry extends NotificationWebPushPusherRegistration {
  readonly pushkey: string;
}

export type NotificationPusherListEntry =
  NotificationHttpPusherListEntry | NotificationWebPushPusherListEntry;

export interface NotificationPusherListResponse {
  readonly pushers: readonly NotificationPusherListEntry[];
}

/** What decides whether a `webpush` registration needs (re)activation. */
export interface NotificationWebPushPusherActivationState {
  readonly data: Pick<NotificationWebPushPusherData, "url" | "auth">;
  readonly activated: boolean;
}

/**
 * The body of `POST /api/notifications/pushers/ack`, with the same
 * authentication as registration. The service worker posts the activation
 * push's plaintext unchanged. The host looks the token up among the caller's
 * pushers with this `app_id`.
 */
export interface NotificationPusherAckRequest {
  readonly app_id: string;
  /** Opaque: 1-255 of `[0-9A-Za-z._~-]`, so a hyphenated UUIDv4 fits. */
  readonly ack_token: string;
}

/** The plaintext of the activation push: what the client acknowledges. */
export type NotificationWebPushActivationMessage = NotificationPusherAckRequest;

export interface ParsedNotificationPusherAckRequest {
  readonly appId: string;
  readonly ackToken: string;
}

export type NotificationPusherAckParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedNotificationPusherAckRequest;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    };

/** A 200 ack answer is an empty object. */
export type NotificationPusherAckResponse = { readonly [key: string]: never };

/**
 * Ack failures, in the v1 error-code style (`{code, error}`). The status for
 * each is `NOTIFICATION_PUSHER_ACK_ERROR_STATUS[code]`.
 */
export type NotificationPusherAckErrorCode =
  "NOT_FOUND" | "EXPIRED_ACTIVATION_TOKEN" | "UNKNOWN_ACTIVATION_TOKEN";

export interface NotificationPusherAckError {
  readonly code: NotificationPusherAckErrorCode;
  readonly error: string;
}

/**
 * The plaintext a host encrypts for one activated `webpush` pusher: the same
 * body it would post to a gateway for that pusher alone. A service worker can
 * read it with `parseNotificationPushGatewayRequest`.
 */
export type NotificationWebPushPayload = NotificationPushGatewayRequest;

export interface CreateNotificationWebPushPayloadInput {
  readonly event?: NotificationPushEventInput;
  readonly pusher: NotificationWebPushPusher;
  readonly now?: Date;
  readonly tweaks?: NotificationPushTweaks;
}

export interface NotificationHttpPusherCapability {
  /**
   * Gateway hosts the host delivers to, as `push.example.com` or
   * `*.example.com` (subdomains only). Omitted: any gateway host that passes
   * the host's egress checks.
   */
  readonly gateway_hosts?: readonly string[];
}

export interface NotificationWebPushPusherCapability {
  /**
   * The host's VAPID public key, a base64url uncompressed P-256 point. Clients
   * subscribe with it as `applicationServerKey`.
   */
  readonly vapid_public_key: string;
  /** Stable id of that key. It changes when the key changes. */
  readonly vapid_key_id: string;
  readonly content_encoding: typeof NOTIFICATION_WEB_PUSH_CONTENT_ENCODING;
}

/** A kind is listed only while the host can deliver it. */
export interface NotificationPusherKindCapabilities {
  readonly http?: NotificationHttpPusherCapability;
  readonly webpush?: NotificationWebPushPusherCapability;
}

/** The body of `GET /api/notifications/pushers/capabilities`. */
export interface NotificationPusherCapabilities {
  readonly version: typeof NOTIFICATION_PUSHER_CAPABILITIES_VERSION;
  readonly formats: readonly NotificationPushFormat[];
  readonly kinds: NotificationPusherKindCapabilities;
}

export interface ParsedNotificationPusherCapabilities {
  /** 2 or later from a v2 host; 1 when a 404 identified a v1 host. */
  readonly version: number;
  /** The advertised formats this contract knows; unknown ones are dropped. */
  readonly formats: readonly NotificationPushFormat[];
  /** The kinds this contract knows and the client can use; see the parser. */
  readonly kinds: NotificationPusherKindCapabilities;
}

export type NotificationPusherCapabilitiesParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedNotificationPusherCapabilities;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    };

/**
 * What a host does with one pusher after one delivery attempt. The last three
 * are the v1 gateway response channels (`NotificationPushGatewayResponse`):
 * `rejected` deletes the registration, `retryable` retries it, and `failed`
 * keeps it without retrying.
 */
export type NotificationPushDeliveryOutcome =
  "delivered" | "rejected" | "retryable" | "failed";

export type NotificationWebPushServiceResponse =
  | {
      readonly status: number;
      /** The raw `Retry-After` response header, if any. */
      readonly retryAfter?: string | null;
    }
  | {
      /** No HTTP response: the request timed out or the connection failed. */
      readonly transportError: "timeout" | "network";
    };

export interface NotificationWebPushDeliveryClassification {
  readonly outcome: NotificationPushDeliveryOutcome;
  /**
   * Seconds to wait before the retry, from a valid `Retry-After`. Present only
   * on `retryable`. The host still applies its own ceiling and the message TTL.
   */
  readonly retryAfterSeconds?: number;
}

/**
 * The capabilities to assume when the capabilities path answers 404: a v1
 * host that accepts `http` pushers in either format, through any gateway that
 * passes its egress checks.
 */
export const NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES: ParsedNotificationPusherCapabilities =
  Object.freeze({
    version: 1,
    formats: Object.freeze(["event_id_only", "full"] as const),
    kinds: Object.freeze({ http: Object.freeze({}) }),
  });

export function createNotificationPusherId(
  pusher: Pick<NotificationPusher, "app_id" | "pushkey">,
): string {
  return `${pusher.app_id}\0${pusher.pushkey}`;
}

export function parseNotificationPusherSetRequest(
  body: unknown,
  options: { readonly product?: string } = {},
): NotificationPusherSetParseResult {
  if (!isRecord(body)) return badSetRequest("body must be an object");
  const product = parseOptionalShortIdentifier(body.product);
  if (product === undefined) {
    return badSetRequest("product is invalid", "product");
  }
  if (options.product && product !== options.product) {
    return badSetRequest(`product must be ${options.product}`, "product");
  }

  const scope = parseOptionalShortIdentifier(body.scope);
  if (scope === undefined) return badSetRequest("scope is invalid", "scope");

  const pusher = parseNotificationPusher(body.pusher);
  if (!pusher.ok) return pusher;

  return {
    ok: true,
    value: {
      pusher: pusher.value.pusher,
      product,
      scope,
      gatewayUrl: pusher.value.gatewayUrl,
    },
  };
}

export function parseNotificationPusherDeleteRequest(
  body: unknown,
  options: { readonly product?: string } = {},
): NotificationPusherDeleteParseResult {
  if (!isRecord(body)) return badDeleteRequest("body must be an object");
  const appId = parseAppId(body.app_id);
  if (!appId) return badDeleteRequest("app_id is invalid", "app_id");
  const pushkey = parsePushkey(body.pushkey);
  if (!pushkey) return badDeleteRequest("pushkey is invalid", "pushkey");

  const product = parseOptionalShortIdentifier(body.product);
  if (product === undefined) {
    return badDeleteRequest("product is invalid", "product");
  }
  if (options.product && product !== options.product) {
    return badDeleteRequest(`product must be ${options.product}`, "product");
  }

  const scope = parseOptionalShortIdentifier(body.scope);
  if (scope === undefined) return badDeleteRequest("scope is invalid", "scope");

  return {
    ok: true,
    value: { appId, pushkey, product, scope },
  };
}

export function createNotificationPushGatewayRequest(
  input: CreateNotificationPushGatewayRequestInput,
): NotificationPushGatewayRequest {
  const event = input.event;
  const pushkeyTs = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const devices = input.pushers.map((pusher) => ({
    app_id: pusher.app_id,
    pushkey: pusher.pushkey,
    pushkey_ts: pushkeyTs,
    data: withoutUrl(pusher.data),
    tweaks: input.tweaks,
  }));

  const eventIdOnly = input.pushers.every(
    (pusher) => pusher.data.format === "event_id_only",
  );

  const notification: NotificationPushGatewayNotification = {
    event_id: event?.id,
    room_id: event?.scopeId,
    counts: normalizeCounts(event?.counts),
    devices,
  };

  if (!eventIdOnly) {
    Object.assign(notification, {
      type: event?.type,
      sender: event?.sender,
      sender_display_name: event?.senderDisplayName,
      room_name: event?.scopeName,
      room_alias: event?.scopeAlias,
      user_is_target: event?.userIsTarget,
      prio: event?.priority,
      content: event?.content,
    });
  }

  return { notification: stripUndefinedNotification(notification) };
}

export function parseNotificationPushGatewayRequest(
  body: unknown,
  options: { readonly maxDevices?: number } = {},
): NotificationPushGatewayParseResult {
  if (!isRecord(body)) return badGatewayRequest("body must be an object");
  const notification = parseGatewayNotification(
    body.notification,
    options.maxDevices ?? 100,
  );
  if (!notification.ok) return notification;
  return {
    ok: true,
    value: {
      request: {
        notification: notification.value,
      },
    },
  };
}

/**
 * Accept a Web Push push resource (`data.url`) like a v1 gateway URL, but
 * stricter: HTTPS on the default port, no credentials or fragment, at most
 * 2048 characters, and a public DNS name. IP literals in any spelling,
 * single-label names, and loopback, mDNS, private-use and reverse-DNS names
 * are refused, and there is no loopback exception. Returns the WHATWG
 * serialization, as the v1 gateway normalizer does.
 *
 * This is a lexical check. A host that can reach private networks must still
 * refuse private addresses when it connects (Cloudflare Workers cannot reach
 * them), must not follow redirects, and may apply an operator allowlist on top.
 */
export function normalizeNotificationWebPushUrl(value: unknown): string | null {
  const text = parseNonEmptyString(value);
  if (
    !text ||
    text.length > MAX_NOTIFICATION_PUSH_URL_LENGTH ||
    text.includes("#")
  ) {
    return null;
  }
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.href.length > MAX_NOTIFICATION_PUSH_URL_LENGTH ||
      !isPublicDnsHostname(url.hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Parse a pushers v2 registration of any kind this host advertises. The `http`
 * branch normalizes exactly as `parseNotificationPusherSetRequest` does. That
 * v1 parser is unchanged and still accepts only `http`.
 */
export function parseNotificationPusherSetRequestV2(
  body: unknown,
  options: NotificationPusherSetRequestV2Options,
): NotificationPusherSetV2ParseResult {
  if (!isRecord(body)) return badSetRequest("body must be an object");
  const product = parseOptionalShortIdentifier(body.product);
  if (product === undefined) {
    return badSetRequest("product is invalid", "product");
  }
  if (options.product && product !== options.product) {
    return badSetRequest(`product must be ${options.product}`, "product");
  }

  const scope = parseOptionalShortIdentifier(body.scope);
  if (scope === undefined) return badSetRequest("scope is invalid", "scope");

  const append = parseOptionalBoolean(body.append);
  if (append === undefined) {
    return badSetRequest("append must be a boolean", "append");
  }

  if (!isRecord(body.pusher)) return badSetRequest("pusher must be an object");
  const kind = body.pusher.kind;
  if (kind !== "http" && kind !== "webpush") {
    return badSetRequest("pusher.kind must be http or webpush", "pusher.kind");
  }

  if (kind === "webpush") {
    const capability = options.kinds.webpush;
    if (!capability) return unavailablePusherKind(kind);
    const pusher = parseNotificationWebPushPusher(
      body.pusher,
      capability.vapid_key_id,
    );
    if (!pusher.ok) return pusher;
    const pushResourceUrl = pusher.value.data.url;
    if (
      options.pushResourceHosts !== undefined &&
      !gatewayHostListed(
        new URL(pushResourceUrl).hostname,
        options.pushResourceHosts,
      )
    ) {
      return badSetRequest(
        "pusher.data.url is not an allowed push service host",
        "pusher.data.url",
      );
    }
    return {
      ok: true,
      value: {
        kind,
        pusher: pusher.value,
        product,
        scope,
        pushResourceUrl,
        append: append ?? false,
      },
    };
  }

  const capability = options.kinds.http;
  if (!capability) return unavailablePusherKind(kind);
  const pusher = parseNotificationPusher(body.pusher);
  if (!pusher.ok) return pusher;
  const gatewayHosts = capability.gateway_hosts;
  if (
    gatewayHosts !== undefined &&
    !gatewayHostListed(new URL(pusher.value.gatewayUrl).hostname, gatewayHosts)
  ) {
    return badSetRequest(
      "pusher.data.url is not an allowed gateway host",
      "pusher.data.url",
    );
  }
  return {
    ok: true,
    value: {
      kind,
      pusher: pusher.value.pusher,
      product,
      scope,
      gatewayUrl: pusher.value.gatewayUrl,
      append: append ?? false,
    },
  };
}

/** Drop `auth` before a `webpush` pusher's data leaves the host. */
export function toNotificationWebPushPusherPublicData(
  data: NotificationWebPushPusherData,
): NotificationWebPushPusherPublicData {
  const publicData: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== "auth") defineJsonProperty(publicData, key, value);
  }
  return publicData as NotificationWebPushPusherPublicData;
}

/**
 * MSC4174: a registration needs activation when it creates the pusher, changes
 * `data.url` or `data.auth`, or repeats one that was never activated (the host
 * then issues a fresh `ack_token`). `previous` is the stored pusher with the
 * same (`app_id`, `pushkey`) for this account, if any. Both sides must come
 * from the parser, which canonicalizes `url` and requires canonical `auth`.
 */
export function notificationWebPushPusherNeedsActivation(
  previous: NotificationWebPushPusherActivationState | null | undefined,
  next: Pick<NotificationWebPushPusher, "data">,
): boolean {
  return (
    !previous ||
    !previous.activated ||
    previous.data.url !== next.data.url ||
    previous.data.auth !== next.data.auth
  );
}

/**
 * Parse an activation acknowledgement, which is also the plaintext of the
 * activation push. The host answers `{}` on success, or an
 * `NotificationPusherAckError` with `NOTIFICATION_PUSHER_ACK_ERROR_STATUS`.
 */
export function parseNotificationPusherAckRequest(
  body: unknown,
): NotificationPusherAckParseResult {
  if (!isRecord(body)) return badAckRequest("body must be an object");
  const appId = parseAppId(body.app_id);
  if (!appId) return badAckRequest("app_id is invalid", "app_id");
  const ackToken = parseAckToken(body.ack_token);
  if (!ackToken) return badAckRequest("ack_token is invalid", "ack_token");
  return { ok: true, value: { appId, ackToken } };
}

/**
 * Build the plaintext for one activated `webpush` pusher by reusing the v1
 * gateway envelope: `webpush` is always `event_id_only`, so only `event_id`,
 * `room_id`, `counts` and the one device are filled, and the device's `data`
 * carries the public fields without `url` (as on the v1 wire) or `auth`. The
 * sender encrypts the JSON and must keep it within
 * `MAX_NOTIFICATION_WEB_PUSH_PLAINTEXT_BYTES`.
 */
export function createNotificationWebPushPayload(
  input: CreateNotificationWebPushPayloadInput,
): NotificationWebPushPayload {
  const gatewayPusher: NotificationPusher = {
    kind: "http",
    app_id: input.pusher.app_id,
    pushkey: input.pusher.pushkey,
    data: toNotificationWebPushPusherPublicData(input.pusher.data),
  };
  return createNotificationPushGatewayRequest({
    event: input.event,
    pushers: [gatewayPusher],
    now: input.now,
    tweaks: input.tweaks,
  });
}

/**
 * Parse a capabilities document. It must be a version 2 or later object with
 * `formats` and `kinds`. To stay forward compatible, unknown formats and kinds
 * are ignored, and so is a known kind this contract cannot use (malformed, or
 * a content encoding other than aes128gcm): the client then treats that kind
 * as unavailable instead of failing the whole document.
 */
export function parseNotificationPusherCapabilities(
  body: unknown,
): NotificationPusherCapabilitiesParseResult {
  if (!isRecord(body)) return badCapabilities("capabilities must be an object");
  const version = body.version;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < NOTIFICATION_PUSHER_CAPABILITIES_VERSION
  ) {
    return badCapabilities("capabilities.version is invalid", "version");
  }

  const rawFormats = body.formats;
  if (
    !Array.isArray(rawFormats) ||
    rawFormats.length > MAX_NOTIFICATION_CAPABILITY_FORMATS ||
    !rawFormats.every((format) => typeof format === "string")
  ) {
    return badCapabilities("capabilities.formats is invalid", "formats");
  }
  const formats: NotificationPushFormat[] = [];
  for (const format of ["event_id_only", "full"] as const) {
    if (rawFormats.includes(format)) formats.push(format);
  }

  const rawKinds = body.kinds;
  if (!isRecord(rawKinds)) {
    return badCapabilities("capabilities.kinds is invalid", "kinds");
  }
  const kinds: {
    http?: NotificationHttpPusherCapability;
    webpush?: NotificationWebPushPusherCapability;
  } = {};
  const http = parseHttpPusherCapability(readOwnProperty(rawKinds, "http"));
  if (http) kinds.http = http;
  const webpush = parseWebPushPusherCapability(
    readOwnProperty(rawKinds, "webpush"),
  );
  if (webpush) kinds.webpush = webpush;

  return { ok: true, value: { version, formats, kinds } };
}

/**
 * Interpret the response to `GET /api/notifications/pushers/capabilities`:
 * 200 parses the body, and 404 identifies a v1 host
 * (`NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES`). Any other status is an error,
 * not a v1 host.
 */
export function parseNotificationPusherCapabilitiesResponse(
  status: number,
  body?: unknown,
): NotificationPusherCapabilitiesParseResult {
  if (status === 404) {
    return { ok: true, value: NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES };
  }
  if (status !== 200) {
    return badCapabilities(
      `capabilities request returned status ${status}`,
      "status",
    );
  }
  return parseNotificationPusherCapabilities(body);
}

/**
 * Map one Web Push service response (RFC 8030) onto the v1 outcome channels.
 * 2xx is delivered (RFC 8030 answers 201, or 202 when a receipt was
 * requested). 404 and 410 mean the subscription is gone: rejected. A timeout,
 * a failed connection, 408, 429 and 5xx are retryable, honouring
 * `Retry-After`. Everything else is failed (kept, not retried), including
 * redirects, which the host must not follow, and 413.
 *
 * 403 is failed on purpose, unlike MSC4174, which deletes the pusher. A 403
 * usually means the VAPID signature does not match the subscription, so a
 * host-side signing bug would delete every pusher at once. Activation already
 * catches a real key mismatch when the pusher is registered.
 */
export function classifyNotificationWebPushResponse(
  response: NotificationWebPushServiceResponse,
  options: { readonly now?: Date } = {},
): NotificationWebPushDeliveryClassification {
  if ("transportError" in response) return { outcome: "retryable" };
  const status = response.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return { outcome: "failed" };
  }
  if (status >= 200 && status < 300) return { outcome: "delivered" };
  if (status === 404 || status === 410) return { outcome: "rejected" };
  if (status === 408 || status === 429 || status >= 500) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.retryAfter,
      options.now ?? new Date(),
    );
    return retryAfterSeconds === undefined
      ? { outcome: "retryable" }
      : { outcome: "retryable", retryAfterSeconds };
  }
  return { outcome: "failed" };
}

function parseNotificationPusher(value: unknown):
  | {
      readonly ok: true;
      readonly value: {
        readonly pusher: NotificationPusher;
        readonly gatewayUrl: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    } {
  if (!isRecord(value)) return badSetRequest("pusher must be an object");
  if (value.kind !== "http") {
    return badSetRequest("pusher.kind must be http", "pusher.kind");
  }
  const appId = parseAppId(value.app_id);
  if (!appId) return badSetRequest("pusher.app_id is invalid", "pusher.app_id");
  const pushkey = parsePushkey(value.pushkey);
  if (!pushkey) {
    return badSetRequest("pusher.pushkey is invalid", "pusher.pushkey");
  }
  const data = parsePusherData(value.data);
  if (!data) return badSetRequest("pusher.data is invalid", "pusher.data");
  const optionalPusherFields = parseOptionalPusherFields(value);
  if (!optionalPusherFields.ok) return optionalPusherFields;

  const parsedPusher: NotificationPusher = {
    kind: "http",
    app_id: appId,
    pushkey,
    ...optionalPusherFields.value,
    data,
  };

  return {
    ok: true,
    value: {
      pusher: parsedPusher,
      gatewayUrl: data.url,
    },
  };
}

function parseNotificationWebPushPusher(
  value: Record<string, unknown>,
  vapidKeyId: string,
):
  | {
      readonly ok: true;
      readonly value: NotificationWebPushPusher;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    } {
  const appId = parseAppId(value.app_id);
  if (!appId) return badSetRequest("pusher.app_id is invalid", "pusher.app_id");
  // The pushkey is also the registration's identity, so only the canonical
  // spelling is accepted: a padded copy would be a second pusher.
  const pushkey = parseCanonicalBase64UrlBytes(value.pushkey, isP256PublicKey);
  if (!pushkey) {
    return badSetRequest(
      "pusher.pushkey must be the p256dh key: unpadded base64url of an uncompressed P-256 point",
      "pusher.pushkey",
    );
  }
  const data = parseWebPushPusherData(value.data, vapidKeyId);
  if (!data.ok) return data;
  const optionalPusherFields = parseOptionalPusherFields(value);
  if (!optionalPusherFields.ok) return optionalPusherFields;

  return {
    ok: true,
    value: {
      kind: "webpush",
      app_id: appId,
      pushkey,
      ...optionalPusherFields.value,
      data: data.value,
    },
  };
}

function parseOptionalPusherFields(value: Record<string, unknown>):
  | {
      readonly ok: true;
      readonly value: {
        readonly app_display_name?: string;
        readonly device_display_name?: string;
        readonly profile_tag?: string;
        readonly lang?: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    } {
  const appDisplayName = parseOptionalDisplayText(value.app_display_name);
  if (appDisplayName === undefined) {
    return badSetRequest(
      "pusher.app_display_name is invalid",
      "pusher.app_display_name",
    );
  }
  const deviceDisplayName = parseOptionalDisplayText(value.device_display_name);
  if (deviceDisplayName === undefined) {
    return badSetRequest(
      "pusher.device_display_name is invalid",
      "pusher.device_display_name",
    );
  }
  const profileTag = parseOptionalShortIdentifier(value.profile_tag);
  if (profileTag === undefined) {
    return badSetRequest("pusher.profile_tag is invalid", "pusher.profile_tag");
  }
  const lang = parseOptionalLang(value.lang);
  if (lang === undefined) {
    return badSetRequest("pusher.lang is invalid", "pusher.lang");
  }

  const optionalPusherFields: {
    app_display_name?: string;
    device_display_name?: string;
    profile_tag?: string;
    lang?: string;
  } = {};
  if (typeof appDisplayName === "string") {
    optionalPusherFields.app_display_name = appDisplayName;
  }
  if (typeof deviceDisplayName === "string") {
    optionalPusherFields.device_display_name = deviceDisplayName;
  }
  if (typeof profileTag === "string") {
    optionalPusherFields.profile_tag = profileTag;
  }
  if (typeof lang === "string") {
    optionalPusherFields.lang = lang;
  }
  return { ok: true, value: optionalPusherFields };
}

function parsePusherData(value: unknown): NotificationPusherData | null {
  const entries = readStrictJsonObjectEntries(value);
  if (!entries) return null;

  let rawUrl: unknown;
  let hasUrl = false;
  let rawFormat: unknown;
  const extraData: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    if (key === "url") {
      hasUrl = true;
      rawUrl = nested;
      continue;
    }
    if (key === "format") {
      rawFormat = nested;
      continue;
    }
    defineJsonProperty(extraData, key, nested);
  }

  if (!hasUrl) return null;
  const url = parseHttpUrl(rawUrl);
  if (!url) return null;
  const format =
    rawFormat == null
      ? undefined
      : rawFormat === "event_id_only" || rawFormat === "full"
        ? rawFormat
        : null;
  if (format === null) return null;

  if (format !== undefined) {
    defineJsonProperty(extraData, "format", format);
  }
  const data = parseBoundedPusherDataObject(extraData);
  if (!data) return null;

  const { format: _format, ...rest } = data;
  return format === undefined ? { ...rest, url } : { ...rest, url, format };
}

function withoutUrl(
  data: NotificationPusherData,
): Omit<NotificationPusherData, "url"> {
  const { url: _url, ...rest } = data;
  return rest;
}

function parseWebPushPusherData(
  value: unknown,
  vapidKeyId: string,
):
  | {
      readonly ok: true;
      readonly value: NotificationWebPushPusherData;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    } {
  const entries = readStrictJsonObjectEntries(value);
  if (!entries) return badSetRequest("pusher.data is invalid", "pusher.data");

  let rawUrl: unknown;
  let rawAuth: unknown;
  let rawFormat: unknown;
  let rawVapidKeyId: unknown;
  const extraData: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    if (key === "url") {
      rawUrl = nested;
      continue;
    }
    if (key === "auth") {
      rawAuth = nested;
      continue;
    }
    if (key === "format") {
      rawFormat = nested;
      continue;
    }
    if (key === "vapid_key_id") {
      rawVapidKeyId = nested;
      continue;
    }
    if (key === "keys") {
      // `PushSubscription.toJSON()` nests both keys here; MSC4174 does not.
      return badSetRequest(
        "pusher.data.keys is not used: send p256dh as pushkey and auth as data.auth",
        "pusher.data.keys",
      );
    }
    defineJsonProperty(extraData, key, nested);
  }

  const url = normalizeNotificationWebPushUrl(rawUrl);
  if (!url) {
    return badSetRequest(
      "pusher.data.url must be a public HTTPS push service URL",
      "pusher.data.url",
    );
  }
  const auth = parseCanonicalBase64UrlBytes(rawAuth, isWebPushAuthSecret);
  if (!auth) {
    return badSetRequest(
      "pusher.data.auth must be unpadded base64url of 16 bytes",
      "pusher.data.auth",
    );
  }
  if (rawFormat != null && rawFormat !== "event_id_only") {
    return badSetRequest(
      "pusher.data.format must be event_id_only for webpush pushers",
      "pusher.data.format",
    );
  }
  const parsedVapidKeyId = parseVapidKeyId(rawVapidKeyId);
  if (!parsedVapidKeyId) {
    return badSetRequest(
      "pusher.data.vapid_key_id is invalid",
      "pusher.data.vapid_key_id",
    );
  }
  if (parsedVapidKeyId !== vapidKeyId) {
    // The subscription was made with another VAPID key, so this host's
    // signature would not match it. The client re-subscribes instead.
    return badSetRequest(
      "pusher.data.vapid_key_id is not this host's current VAPID key",
      "pusher.data.vapid_key_id",
    );
  }

  // As in v1, the size budget covers the data without `url`.
  defineJsonProperty(extraData, "auth", auth);
  defineJsonProperty(extraData, "format", "event_id_only");
  defineJsonProperty(extraData, "vapid_key_id", parsedVapidKeyId);
  const data = parseBoundedPusherDataObject(extraData);
  if (!data) return badSetRequest("pusher.data is invalid", "pusher.data");
  defineJsonProperty(data, "url", url);
  return { ok: true, value: data as NotificationWebPushPusherData };
}

/** Base64url of a 65-byte uncompressed P-256 point, canonicalized, or null. */
function parseUncompressedP256PublicKey(value: unknown): string | null {
  const bytes = decodeBase64Url(value);
  return bytes && isP256PublicKey(bytes) ? encodeBase64Url(bytes) : null;
}

/**
 * `value` itself when it is the canonical spelling (unpadded, unused bits
 * zero) of bytes that `accept` allows, else null.
 */
function parseCanonicalBase64UrlBytes(
  value: unknown,
  accept: (bytes: Uint8Array) => boolean,
): string | null {
  if (typeof value !== "string") return null;
  const bytes = decodeBase64Url(value);
  return bytes && accept(bytes) && encodeBase64Url(bytes) === value
    ? value
    : null;
}

function isP256PublicKey(bytes: Uint8Array): boolean {
  return bytes.length === WEB_PUSH_P256DH_BYTES && bytes[0] === 0x04;
}

function isWebPushAuthSecret(bytes: Uint8Array): boolean {
  return bytes.length === WEB_PUSH_AUTH_SECRET_BYTES;
}

function parseVapidKeyId(value: unknown): string | null {
  return parseOptionalShortIdentifier(value) ?? null;
}

/** The Matrix opaque identifier grammar, bounded to 255 characters. */
function parseAckToken(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= MAX_NOTIFICATION_PUSHER_ACK_TOKEN_LENGTH &&
    /^[0-9A-Za-z._~-]+$/u.test(value)
    ? value
    : null;
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_BASE64URL_TEXT_LENGTH = 256;

/**
 * Decode base64url (RFC 4648 §5), with or without correct `=` padding. The
 * standard alphabet's `+` and `/`, whitespace and misplaced padding are
 * refused. Parsing does not depend on the runtime's `atob`.
 */
function decodeBase64Url(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > MAX_BASE64URL_TEXT_LENGTH) {
    return null;
  }
  const unpadded = value.replace(/={1,2}$/u, "");
  if (unpadded !== value && value.length % 4 !== 0) return null;
  if (unpadded.length % 4 === 1) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of unpadded) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const chunk =
      (bytes[index] << 16) |
      ((remaining > 1 ? bytes[index + 1] : 0) << 8) |
      (remaining > 2 ? bytes[index + 2] : 0);
    text += BASE64URL_ALPHABET[(chunk >> 18) & 0x3f];
    text += BASE64URL_ALPHABET[(chunk >> 12) & 0x3f];
    if (remaining > 1) text += BASE64URL_ALPHABET[(chunk >> 6) & 0x3f];
    if (remaining > 2) text += BASE64URL_ALPHABET[chunk & 0x3f];
  }
  return text;
}

function normalizeCounts(
  counts: NotificationPushCounts | undefined,
): NotificationPushCounts | undefined {
  if (!counts) return undefined;
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      next[key] = value;
    }
  }
  return Object.keys(next).length ? next : undefined;
}

function parseGatewayNotification(
  value: unknown,
  maxDevices: number,
):
  | {
      readonly ok: true;
      readonly value: NotificationPushGatewayNotification;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    } {
  if (!isRecord(value)) {
    return badGatewayRequest("notification must be an object", "notification");
  }
  const deviceLimit =
    Number.isInteger(maxDevices) && maxDevices > 0 ? maxDevices : 100;
  if (!Array.isArray(value.devices)) {
    return badGatewayRequest(
      "notification.devices must be an array",
      "notification.devices",
    );
  }
  if (value.devices.length === 0 || value.devices.length > deviceLimit) {
    return badGatewayRequest(
      `notification.devices must contain 1-${deviceLimit} devices`,
      "notification.devices",
    );
  }

  const devices: NotificationPushGatewayDevice[] = [];
  for (let index = 0; index < value.devices.length; index += 1) {
    const parsed = parseGatewayDevice(value.devices[index], index);
    if (!parsed.ok) return parsed;
    devices.push(parsed.value);
  }

  const counts = parseGatewayCounts(value.counts);
  if (counts === undefined) {
    return badGatewayRequest(
      "notification.counts is invalid",
      "notification.counts",
    );
  }
  const content = parseOptionalJsonObject(value.content);
  if (content === undefined) {
    return badGatewayRequest(
      "notification.content is invalid",
      "notification.content",
    );
  }
  const priority = parseOptionalPriority(value.prio);
  if (priority === undefined) {
    return badGatewayRequest(
      "notification.prio is invalid",
      "notification.prio",
    );
  }
  const userIsTarget = parseOptionalBoolean(value.user_is_target);
  if (userIsTarget === undefined) {
    return badGatewayRequest(
      "notification.user_is_target is invalid",
      "notification.user_is_target",
    );
  }

  const optionalFields: {
    event_id?: string;
    room_id?: string;
    type?: string;
    sender?: string;
    sender_display_name?: string;
    room_name?: string;
    room_alias?: string;
    user_is_target?: boolean;
    prio?: NotificationPushPriority;
    content?: JsonObject;
    counts?: NotificationPushCounts;
  } = {};
  const eventId = parseOptionalGatewayText(value.event_id, 256);
  if (eventId === undefined) {
    return badGatewayRequest(
      "notification.event_id is invalid",
      "notification.event_id",
    );
  }
  if (typeof eventId === "string") optionalFields.event_id = eventId;

  const roomId = parseOptionalGatewayText(value.room_id, 256);
  if (roomId === undefined) {
    return badGatewayRequest(
      "notification.room_id is invalid",
      "notification.room_id",
    );
  }
  if (typeof roomId === "string") optionalFields.room_id = roomId;

  const type = parseOptionalGatewayText(value.type, 128);
  if (type === undefined) {
    return badGatewayRequest(
      "notification.type is invalid",
      "notification.type",
    );
  }
  if (typeof type === "string") optionalFields.type = type;

  const sender = parseOptionalGatewayText(value.sender, 256);
  if (sender === undefined) {
    return badGatewayRequest(
      "notification.sender is invalid",
      "notification.sender",
    );
  }
  if (typeof sender === "string") optionalFields.sender = sender;

  const senderDisplayName = parseOptionalGatewayText(
    value.sender_display_name,
    128,
  );
  if (senderDisplayName === undefined) {
    return badGatewayRequest(
      "notification.sender_display_name is invalid",
      "notification.sender_display_name",
    );
  }
  if (typeof senderDisplayName === "string") {
    optionalFields.sender_display_name = senderDisplayName;
  }

  const roomName = parseOptionalGatewayText(value.room_name, 128);
  if (roomName === undefined) {
    return badGatewayRequest(
      "notification.room_name is invalid",
      "notification.room_name",
    );
  }
  if (typeof roomName === "string") optionalFields.room_name = roomName;

  const roomAlias = parseOptionalGatewayText(value.room_alias, 256);
  if (roomAlias === undefined) {
    return badGatewayRequest(
      "notification.room_alias is invalid",
      "notification.room_alias",
    );
  }
  if (typeof roomAlias === "string") optionalFields.room_alias = roomAlias;
  if (typeof userIsTarget === "boolean") {
    optionalFields.user_is_target = userIsTarget;
  }
  if (typeof priority === "string") optionalFields.prio = priority;
  if (content) optionalFields.content = content;
  if (counts) optionalFields.counts = counts;

  return {
    ok: true,
    value: {
      ...optionalFields,
      devices,
    },
  };
}

function parseGatewayDevice(
  value: unknown,
  index: number,
):
  | {
      readonly ok: true;
      readonly value: NotificationPushGatewayDevice;
    }
  | {
      readonly ok: false;
      readonly error: NotificationPusherParseError;
    } {
  const baseField = `notification.devices.${index}`;
  if (!isRecord(value)) {
    return badGatewayRequest("device must be an object", baseField);
  }
  const appId = parseAppId(value.app_id);
  if (!appId) {
    return badGatewayRequest("device.app_id is invalid", `${baseField}.app_id`);
  }
  const pushkey = parsePushkey(value.pushkey);
  if (!pushkey) {
    return badGatewayRequest(
      "device.pushkey is invalid",
      `${baseField}.pushkey`,
    );
  }
  const data = parseGatewayDeviceData(value.data);
  if (!data) {
    return badGatewayRequest("device.data is invalid", `${baseField}.data`);
  }
  const pushkeyTs = parseOptionalInteger(value.pushkey_ts);
  if (pushkeyTs === undefined) {
    return badGatewayRequest(
      "device.pushkey_ts is invalid",
      `${baseField}.pushkey_ts`,
    );
  }
  const tweaks = parseOptionalJsonObject(value.tweaks);
  if (tweaks === undefined) {
    return badGatewayRequest("device.tweaks is invalid", `${baseField}.tweaks`);
  }

  const device: NotificationPushGatewayDevice = {
    app_id: appId,
    pushkey,
    data,
  };
  if (typeof pushkeyTs === "number") {
    (device as { pushkey_ts?: number }).pushkey_ts = pushkeyTs;
  }
  if (tweaks) {
    (device as { tweaks?: NotificationPushTweaks }).tweaks = tweaks;
  }
  return { ok: true, value: device };
}

function parseGatewayDeviceData(
  value: unknown,
): Omit<NotificationPusherData, "url"> | null {
  const data = parseBoundedPusherDataObject(value);
  if (!data || Object.prototype.hasOwnProperty.call(data, "url")) return null;
  if (
    data.format !== undefined &&
    data.format !== "event_id_only" &&
    data.format !== "full"
  ) {
    return null;
  }
  return data as Omit<NotificationPusherData, "url">;
}

function parseGatewayCounts(
  value: unknown,
): NotificationPushCounts | null | undefined {
  if (value == null) return null;
  if (!isRecord(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested !== "number" || !Number.isInteger(nested) || nested < 0) {
      return undefined;
    }
    counts[key] = nested;
  }
  return counts;
}

function parseOptionalJsonObject(
  value: unknown,
): JsonObject | null | undefined {
  if (value == null) return null;
  if (!isRecord(value) || !isJsonValue(value)) return undefined;
  return value;
}

function parseOptionalBoolean(value: unknown): boolean | null | undefined {
  if (value == null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function parseOptionalPriority(
  value: unknown,
): NotificationPushPriority | null | undefined {
  if (value == null) return null;
  return value === "high" || value === "low" ? value : undefined;
}

function parseOptionalInteger(value: unknown): number | null | undefined {
  if (value == null) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function parseOptionalGatewayText(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value == null) return null;
  const text = parseNonEmptyString(value);
  if (!text || text.length > maxLength) return undefined;
  return text;
}

function parseAppId(value: unknown): string | null {
  const text = parseNonEmptyString(value);
  if (!text || text.length > 64) return null;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(text) ? text : null;
}

function parsePushkey(value: unknown): string | null {
  const text = parseNonEmptyString(value);
  if (!text || new TextEncoder().encode(text).byteLength > 512) return null;
  return text;
}

function parseOptionalDisplayText(value: unknown): string | null | undefined {
  if (value == null) return null;
  const text = parseNonEmptyString(value);
  if (!text || text.length > 128) return undefined;
  return text;
}

function parseOptionalLang(value: unknown): string | null | undefined {
  if (value == null) return null;
  const text = parseNonEmptyString(value);
  if (!text || text.length > 32) return undefined;
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text) ? text : undefined;
}

function parseOptionalShortIdentifier(
  value: unknown,
): string | null | undefined {
  if (value == null) return null;
  const text = parseNonEmptyString(value);
  if (!text || text.length > 64) return undefined;
  return /^[a-z0-9._:-]+$/i.test(text) ? text : undefined;
}

function parseHttpUrl(value: unknown): string | null {
  return normalizeNotificationPusherGatewayUrl(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

/**
 * A multi-label DNS name with a public top-level label. Expects a WHATWG URL
 * hostname, which is already lowercase and punycode, writes IPv6 in brackets,
 * and rewrites every IPv4 spelling (`0x7f.1`, `2130706433`) as dotted decimal.
 * An all-numeric last label is therefore always an IPv4 literal.
 */
function isPublicDnsHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  if (
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    return false;
  }
  const topLevel = labels[labels.length - 1];
  return !/^\d+$/u.test(topLevel) && !NON_PUBLIC_TOP_LEVEL_LABELS.has(topLevel);
}

/** `push.example.com` or `*.example.com`, lowercased; null when malformed. */
function parseGatewayHostPattern(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const pattern = value.trim().toLowerCase();
  const hostname = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  if (!hostname || hostname.length > 253) return null;
  return hostname
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    ? pattern
    : null;
}

function gatewayHostListed(
  hostname: string,
  gatewayHosts: readonly string[],
): boolean {
  const normalized = hostname.toLowerCase();
  return gatewayHosts.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith("*.")
      ? normalized.endsWith(pattern.slice(1))
      : normalized === pattern;
  });
}

function parseHttpPusherCapability(
  value: unknown,
): NotificationHttpPusherCapability | null {
  if (!isRecord(value)) return null;
  const rawGatewayHosts = readOwnProperty(value, "gateway_hosts");
  if (rawGatewayHosts == null) return {};
  if (
    !Array.isArray(rawGatewayHosts) ||
    rawGatewayHosts.length > MAX_NOTIFICATION_CAPABILITY_GATEWAY_HOSTS
  ) {
    return null;
  }
  const gatewayHosts: string[] = [];
  for (const entry of rawGatewayHosts) {
    const pattern = parseGatewayHostPattern(entry);
    if (!pattern) return null;
    if (!gatewayHosts.includes(pattern)) gatewayHosts.push(pattern);
  }
  return { gateway_hosts: gatewayHosts };
}

function parseWebPushPusherCapability(
  value: unknown,
): NotificationWebPushPusherCapability | null {
  if (!isRecord(value)) return null;
  const vapidPublicKey = parseUncompressedP256PublicKey(
    readOwnProperty(value, "vapid_public_key"),
  );
  const vapidKeyId = parseVapidKeyId(readOwnProperty(value, "vapid_key_id"));
  if (
    !vapidPublicKey ||
    !vapidKeyId ||
    readOwnProperty(value, "content_encoding") !==
      NOTIFICATION_WEB_PUSH_CONTENT_ENCODING
  ) {
    return null;
  }
  return {
    vapid_public_key: vapidPublicKey,
    vapid_key_id: vapidKeyId,
    content_encoding: NOTIFICATION_WEB_PUSH_CONTENT_ENCODING,
  };
}

/**
 * `Retry-After` as delay-seconds or an IMF-fixdate (RFC 9110 §10.2.3), in
 * whole seconds from `now`. A date in the past is 0; anything else is
 * undefined. The date is parsed here because `Date.parse` accepts different
 * strings on different runtimes.
 */
function parseRetryAfterSeconds(
  value: string | null | undefined,
  now: Date,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d{1,10}$/u.test(text)) return Number(text);
  const match =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(
      text,
    );
  if (!match) return undefined;
  const [, day, monthName, year, hour, minute, second] = match;
  const month = IMF_FIXDATE_MONTHS.indexOf(monthName);
  const time = Date.UTC(
    Number(year),
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    return undefined;
  }
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return undefined;
  return Math.max(0, Math.ceil((time - nowTime) / 1000));
}

const IMF_FIXDATE_MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function readOwnProperty(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value == null) return true;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

type BoundedJsonParseResult =
  { readonly ok: true; readonly value: JsonValue } | { readonly ok: false };

function parseBoundedPusherDataObject(value: unknown): JsonObject | null {
  const parsed = cloneBoundedJsonValue(
    value,
    0,
    { entries: 0 },
    new WeakSet<object>(),
  );
  if (!parsed.ok || !isRecord(parsed.value)) return null;

  const serialized = JSON.stringify(parsed.value);
  if (
    UTF8_ENCODER.encode(serialized).byteLength >
    MAX_NOTIFICATION_PUSHER_DATA_BYTES
  ) {
    return null;
  }
  return parsed.value;
}

function cloneBoundedJsonValue(
  value: unknown,
  depth: number,
  budget: { entries: number },
  ancestors: WeakSet<object>,
): BoundedJsonParseResult {
  if (value === null || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === "string") {
    return UTF8_ENCODER.encode(value).byteLength <=
      MAX_NOTIFICATION_PUSHER_DATA_STRING_BYTES
      ? { ok: true, value }
      : { ok: false };
  }
  if (!value || typeof value !== "object") return { ok: false };
  if (depth > MAX_NOTIFICATION_PUSHER_DATA_DEPTH || ancestors.has(value)) {
    return { ok: false };
  }

  if (Array.isArray(value)) {
    const entries = readStrictJsonArrayEntries(value);
    if (
      !entries ||
      entries.length > MAX_NOTIFICATION_PUSHER_DATA_ARRAY_LENGTH
    ) {
      return { ok: false };
    }
    budget.entries += entries.length;
    if (budget.entries > MAX_NOTIFICATION_PUSHER_DATA_ENTRIES) {
      return { ok: false };
    }

    ancestors.add(value);
    const clone: JsonValue[] = [];
    for (const nested of entries) {
      const parsed = cloneBoundedJsonValue(
        nested,
        depth + 1,
        budget,
        ancestors,
      );
      if (!parsed.ok) {
        ancestors.delete(value);
        return parsed;
      }
      clone.push(parsed.value);
    }
    ancestors.delete(value);
    return { ok: true, value: clone };
  }

  const entries = readStrictJsonObjectEntries(value);
  if (!entries) return { ok: false };
  budget.entries += entries.length;
  if (budget.entries > MAX_NOTIFICATION_PUSHER_DATA_ENTRIES) {
    return { ok: false };
  }

  ancestors.add(value);
  const clone: Record<string, JsonValue> = {};
  for (const [key, nested] of entries) {
    if (
      UTF8_ENCODER.encode(key).byteLength >
      MAX_NOTIFICATION_PUSHER_DATA_KEY_BYTES
    ) {
      ancestors.delete(value);
      return { ok: false };
    }
    const parsed = cloneBoundedJsonValue(nested, depth + 1, budget, ancestors);
    if (!parsed.ok) {
      ancestors.delete(value);
      return parsed;
    }
    defineJsonProperty(clone, key, parsed.value);
  }
  ancestors.delete(value);
  return { ok: true, value: clone };
}

function readStrictJsonObjectEntries(
  value: unknown,
): readonly (readonly [string, unknown])[] | null {
  if (!isRecord(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const keys = Reflect.ownKeys(value);
    // Registration data may additionally contain the separately stored `url`
    // and an omitted nullish `format`, hence the two-entry parsing allowance.
    if (keys.length > MAX_NOTIFICATION_PUSHER_DATA_ENTRIES + 2) return null;
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function readStrictJsonArrayEntries(
  value: unknown[],
): readonly unknown[] | null {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) return null;

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return null;
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_NOTIFICATION_PUSHER_DATA_ARRAY_LENGTH
    ) {
      return null;
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return null;

    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
}

function defineJsonProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function stripUndefinedNotification(
  value: NotificationPushGatewayNotification,
): NotificationPushGatewayNotification {
  const next: Partial<NotificationPushGatewayNotification> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested !== undefined) {
      (next as Record<string, unknown>)[key] = nested;
    }
  }
  return next as NotificationPushGatewayNotification;
}

function badSetRequest(
  error: string,
  field?: string,
): { readonly ok: false; readonly error: NotificationPusherParseError } {
  return { ok: false, error: { code: "BAD_REQUEST", error, field } };
}

function badDeleteRequest(
  error: string,
  field?: string,
): { readonly ok: false; readonly error: NotificationPusherParseError } {
  return { ok: false, error: { code: "BAD_REQUEST", error, field } };
}

function badGatewayRequest(
  error: string,
  field?: string,
): { readonly ok: false; readonly error: NotificationPusherParseError } {
  return { ok: false, error: { code: "BAD_REQUEST", error, field } };
}

function unavailablePusherKind(kind: NotificationPusherKind): {
  readonly ok: false;
  readonly error: NotificationPusherParseError;
} {
  return badSetRequest(
    `pusher.kind ${kind} is not available on this host`,
    "pusher.kind",
  );
}

function badAckRequest(
  error: string,
  field?: string,
): { readonly ok: false; readonly error: NotificationPusherParseError } {
  return { ok: false, error: { code: "BAD_REQUEST", error, field } };
}

function badCapabilities(
  error: string,
  field?: string,
): { readonly ok: false; readonly error: NotificationPusherParseError } {
  return { ok: false, error: { code: "BAD_REQUEST", error, field } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
