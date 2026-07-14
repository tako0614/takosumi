import type { IsoTimestamp, JsonObject, JsonValue } from "./types.ts";

export const NOTIFICATION_PUSHER_REGISTRATION_PATH =
  "/api/notifications/pushers" as const;

export const MATRIX_PUSH_GATEWAY_NOTIFY_PATH =
  "/_matrix/push/v1/notify" as const;

/** Maximum UTF-8 JSON size persisted for `pusher.data` after removing `url`. */
export const MAX_NOTIFICATION_PUSHER_DATA_BYTES = 2 * 1024;

const MAX_NOTIFICATION_PUSHER_DATA_DEPTH = 8;
const MAX_NOTIFICATION_PUSHER_DATA_ENTRIES = 64;
const MAX_NOTIFICATION_PUSHER_DATA_ARRAY_LENGTH = 64;
const MAX_NOTIFICATION_PUSHER_DATA_KEY_BYTES = 128;
const MAX_NOTIFICATION_PUSHER_DATA_STRING_BYTES = 1024;
const UTF8_ENCODER = new TextEncoder();

export type NotificationPusherKind = "http";
export type NotificationPushFormat = "event_id_only" | "full";
export type NotificationPushPriority = "high" | "low";

export type NotificationPusherData = JsonObject & {
  readonly url: string;
  readonly format?: NotificationPushFormat;
};

export interface NotificationPusher {
  readonly kind: NotificationPusherKind;
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
  readonly kind: NotificationPusherKind;
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

  const parsedPusher: NotificationPusher = {
    kind: "http",
    app_id: appId,
    pushkey,
    ...optionalPusherFields,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
