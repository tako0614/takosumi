/**
 * `/api/v1/account/notification-pushers`: the devices (Takosumi Mobile) that
 * receive this instance's own notifications as standard Web Push through a
 * push relay. Design: takos-control `docs/platform/takosumi-app-clients.md`
 * (「Takosumi自身の通知」) and ADR 0026.
 *
 * - GET: the account's pushers and the instance's VAPID public key.
 * - POST: register or update one `webpush` pusher, identified by
 *   (account, `app_id`, `pushkey`).
 * - DELETE `/{id}`: remove one of the account's pushers.
 *
 * Registration needs a secret-store passphrase (the VAPID key), at least one
 * relay origin in `TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS`, and an https
 * Accounts issuer; GET reports which one is missing.
 *
 * Any account credential with `capsules:read` (session, PAT `read`, OAuth
 * access token) may use it. A pusher receives notifications about every app
 * of the account, so a credential fenced to some apps or to a Workspace is
 * refused. A host that authenticates accounts another way (the shared-account
 * profile's product host) passes its own `authenticate`.
 */

import {
  TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH,
  type TakosumiAccountsNotificationPusher,
  type TakosumiAccountsNotificationPusherList,
  type TakosumiAccountsNotificationPusherResponse,
  type TakosumiAccountsWebPushUnavailableReason,
} from "@takosjp/takosumi-accounts-contract";
import {
  checkPusherEndpoint,
  NOTIFICATION_PUSH_RELAY_ORIGINS_ENV,
  parseNotificationPushRelayOrigins,
} from "../../../core/domains/notifications/pusher_endpoint.ts";
import { base64UrlDecode } from "../../../core/domains/notifications/web_push/bytes.ts";
import { isP256PublicPoint } from "../../../core/domains/notifications/web_push/p256.ts";
import {
  instanceVapidKeyPair,
  normalizeVapidSubject,
  type VapidSecretEnv,
} from "../../../core/domains/notifications/web_push/vapid.ts";
import { requireAccountsBearer } from "./account-session.ts";
import {
  errorJson,
  isRecord,
  json,
  methodNotAllowed,
  readJsonObject,
  withPrivateNoStoreHeaders,
} from "./http-helpers.ts";
import {
  NOTIFICATION_PUSHER_ID_PATTERN,
  notificationPusherId,
  type NotificationPusherRecord,
  type NotificationPusherStore,
} from "./notification-pushers-store.ts";
import type { AccountsStore } from "./store.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

/** Who may use the pusher routes, as the host authenticated the request. */
export type NotificationPusherAuthentication =
  | {
    readonly ok: true;
    readonly subject: TakosumiSubject;
    /** Set when the credential is fenced to some apps (refused here). */
    readonly appIds?: readonly string[];
    /** Set when the credential is fenced to one Workspace (refused here). */
    readonly workspaceId?: string;
  }
  | { readonly ok: false; readonly response: Response };

export type NotificationPusherAuthenticator = (
  request: Request,
  store: AccountsStore,
) => Promise<NotificationPusherAuthentication>;

/** The Accounts credentials: session, PAT or OAuth access token with `read`. */
export const accountsNotificationPusherAuthenticator: NotificationPusherAuthenticator =
  async (request, store) => {
    const auth = await requireAccountsBearer({ request, store, scope: "read" });
    if (!auth.ok) return auth;
    return {
      ok: true,
      subject: auth.auth.subject,
      ...(auth.auth.appIds !== undefined ? { appIds: auth.auth.appIds } : {}),
      ...(auth.auth.workspaceId !== undefined ? { workspaceId: auth.auth.workspaceId } : {}),
    };
  };

export interface NotificationPusherRouteOptions {
  /** base64url VAPID public key, or null without a secret-store passphrase. */
  readonly webPushPublicKey: () => Promise<string | null>;
  /** Push relay origins a pusher endpoint may use; empty: none configured. */
  readonly relayOrigins: readonly string[];
  /**
   * Whether the instance origin (its Accounts issuer) can be the VAPID `sub`:
   * https, or http on loopback for development.
   */
  readonly instanceOriginUsable: boolean;
}

/**
 * The composition's options from its environment and Accounts issuer: the
 * VAPID key derived from the secret-store passphrase and the relay allowlist.
 * Throws on a malformed `TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS`.
 */
export function notificationPusherRouteOptionsFromEnv(
  env: VapidSecretEnv,
  issuer: string | undefined,
): NotificationPusherRouteOptions {
  const configured = env[NOTIFICATION_PUSH_RELAY_ORIGINS_ENV];
  const relayOrigins = parseNotificationPushRelayOrigins(
    typeof configured === "string" ? configured : undefined,
  );
  let instanceOriginUsable = false;
  try {
    normalizeVapidSubject(issuer ?? "");
    instanceOriginUsable = true;
  } catch {
    instanceOriginUsable = false;
  }
  return {
    relayOrigins,
    instanceOriginUsable,
    webPushPublicKey: async () =>
      (await instanceVapidKeyPair(env))?.publicKeyBase64Url ?? null,
  };
}

/** Whether this instance can send Web Push, and the key when it can. */
async function webPushAvailability(
  options: NotificationPusherRouteOptions | undefined,
): Promise<
  | { readonly publicKey: string; readonly reason: null }
  | { readonly publicKey: null; readonly reason: TakosumiAccountsWebPushUnavailableReason }
> {
  const publicKey = options ? await options.webPushPublicKey() : null;
  if (!options || !publicKey) return { publicKey: null, reason: "secret_not_configured" };
  if (options.relayOrigins.length === 0) return { publicKey: null, reason: "relay_not_configured" };
  if (!options.instanceOriginUsable) return { publicKey: null, reason: "issuer_not_https" };
  return { publicKey, reason: null };
}

export interface NotificationPusherRateLimiter {
  consume(request: Request): Response | undefined;
}

type RateLimiter = NotificationPusherRateLimiter;

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/;
const MAX_LANG_LENGTH = 35;
const MAX_DEVICE_DISPLAY_NAME_LENGTH = 128;
const REGISTRATION_KEYS = new Set([
  "kind",
  "app_id",
  "pushkey",
  "data",
  "device_display_name",
  "lang",
]);
const DATA_KEYS = new Set(["url", "auth"]);

/** Undefined when the path is not a notification-pusher route. */
export async function handleNotificationPusherRequest(input: {
  readonly request: Request;
  readonly url: URL;
  readonly store: AccountsStore;
  readonly options: NotificationPusherRouteOptions | undefined;
  readonly limiter: RateLimiter;
  /** Accounts credentials when omitted. */
  readonly authenticate?: NotificationPusherAuthenticator;
}): Promise<Response | undefined> {
  const route = matchNotificationPusherRoute(input.url.pathname);
  if (!route) return undefined;
  const allowed = route.kind === "collection" ? "GET, POST" : "DELETE";
  const method = input.request.method;
  if (
    !(route.kind === "collection" && (method === "GET" || method === "POST")) &&
    !(route.kind === "item" && method === "DELETE")
  ) {
    return methodNotAllowed(allowed);
  }
  if (method !== "GET") {
    const limited = input.limiter.consume(input.request);
    if (limited) return limited;
  }
  const auth = await (input.authenticate ?? accountsNotificationPusherAuthenticator)(
    input.request,
    input.store,
  );
  if (!auth.ok) return auth.response;
  if (auth.appIds !== undefined || auth.workspaceId !== undefined) {
    return errorJson(
      "account_wide_credential_required",
      "Notification pushers need a credential that is not limited to some apps or a Workspace.",
      403,
      input.request,
    );
  }
  const pushers = notificationPusherStore(input.store);
  if (!pushers) {
    return errorJson(
      "notification_pushers_unavailable",
      "This instance cannot store notification pushers.",
      503,
      input.request,
    );
  }
  const subject = auth.subject;
  let response: Response;
  if (route.kind === "item") {
    const deleted = NOTIFICATION_PUSHER_ID_PATTERN.test(route.pusherId) &&
      (await pushers.deleteNotificationPusher({
        subject,
        pusherId: route.pusherId,
      }));
    response = deleted
      ? new Response(null, { status: 204 })
      : errorJson("not_found", "notification pusher not found", 404, input.request);
  } else if (method === "GET") {
    const records = await pushers.listNotificationPushersForSubject(subject);
    const availability = await webPushAvailability(input.options);
    const body: TakosumiAccountsNotificationPusherList = {
      pushers: records.map(notificationPusherWire),
      web_push_public_key: availability.publicKey,
      web_push_unavailable_reason: availability.reason,
    };
    response = json(body);
  } else {
    response = await registerNotificationPusher({
      request: input.request,
      subject,
      pushers,
      options: input.options,
    });
  }
  return withPrivateNoStoreHeaders(response);
}

type NotificationPusherRoute =
  | { readonly kind: "collection" }
  | { readonly kind: "item"; readonly pusherId: string };

function matchNotificationPusherRoute(
  pathname: string,
): NotificationPusherRoute | undefined {
  if (pathname === TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH) {
    return { kind: "collection" };
  }
  const prefix = `${TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest === "" || rest.includes("/")) return undefined;
  return { kind: "item", pusherId: rest };
}

function notificationPusherStore(
  store: AccountsStore,
): NotificationPusherStore | undefined {
  if (
    !store.saveNotificationPusher ||
    !store.listNotificationPushersForSubject ||
    !store.findNotificationPusher ||
    !store.deleteNotificationPusher ||
    !store.removeNotificationPusher ||
    !store.recordNotificationPusherOutcome
  ) {
    return undefined;
  }
  return store as AccountsStore & NotificationPusherStore;
}

async function registerNotificationPusher(input: {
  readonly request: Request;
  readonly subject: NotificationPusherRecord["subject"];
  readonly pushers: NotificationPusherStore;
  readonly options: NotificationPusherRouteOptions | undefined;
}): Promise<Response> {
  const availability = await webPushAvailability(input.options);
  if (availability.reason === "secret_not_configured" || !input.options) {
    return errorJson(
      "web_push_unavailable",
      "This instance cannot send Web Push: no secret-store passphrase is configured.",
      503,
      input.request,
    );
  }
  if (availability.reason === "relay_not_configured") {
    return errorJson(
      "notification_relay_not_configured",
      "The operator has not configured a push relay (TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS), so this instance accepts no notification devices.",
      409,
      input.request,
    );
  }
  if (availability.reason === "issuer_not_https") {
    return errorJson(
      "notification_issuer_not_https",
      "This instance's Accounts issuer is not an https origin, so it cannot sign Web Push.",
      409,
      input.request,
    );
  }
  const body = await readJsonObject(input.request);
  if (!body) return invalid(input.request, "request body must be a JSON object");
  const unknownKey = Object.keys(body).find((key) => !REGISTRATION_KEYS.has(key));
  if (unknownKey !== undefined) {
    return invalid(input.request, `unknown field: ${unknownKey}`);
  }
  if (body.kind !== "webpush") {
    return errorJson(
      "unsupported_pusher_kind",
      "kind must be \"webpush\"",
      400,
      input.request,
    );
  }
  const appId = body.app_id;
  if (typeof appId !== "string" || !APP_ID_PATTERN.test(appId)) {
    return invalid(input.request, "app_id must be 1-64 characters of [A-Za-z0-9._-]");
  }
  const pushkey = body.pushkey;
  const pushkeyBytes = typeof pushkey === "string" ? base64UrlDecode(pushkey) : null;
  if (
    typeof pushkey !== "string" ||
    !pushkeyBytes ||
    !(await isP256PublicPoint(pushkeyBytes))
  ) {
    return invalid(
      input.request,
      "pushkey must be an uncompressed P-256 public key in unpadded base64url",
    );
  }
  const data = body.data;
  if (!isRecord(data)) return invalid(input.request, "data must be an object");
  const unknownDataKey = Object.keys(data).find((key) => !DATA_KEYS.has(key));
  if (unknownDataKey !== undefined) {
    return invalid(input.request, `unknown field: data.${unknownDataKey}`);
  }
  if (typeof data.url !== "string") {
    return invalid(input.request, "data.url must be a string");
  }
  const endpoint = checkPusherEndpoint(data.url, input.options.relayOrigins);
  if (!endpoint.ok) {
    return errorJson(
      "invalid_pusher_endpoint",
      "data.url must be an https URL on port 443 without userinfo, at most 1024 characters, on an allowed push relay",
      400,
      input.request,
      {},
      { reason: endpoint.problem },
    );
  }
  const authSecret = data.auth;
  const authBytes = typeof authSecret === "string" ? base64UrlDecode(authSecret) : null;
  if (typeof authSecret !== "string" || !authBytes || authBytes.byteLength !== 16) {
    return invalid(input.request, "data.auth must be 16 bytes in unpadded base64url");
  }
  const deviceDisplayName = typeof body.device_display_name === "string"
    ? body.device_display_name.trim()
    : undefined;
  if (
    !deviceDisplayName ||
    [...deviceDisplayName].length > MAX_DEVICE_DISPLAY_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(deviceDisplayName)
  ) {
    return invalid(
      input.request,
      `device_display_name must be 1-${MAX_DEVICE_DISPLAY_NAME_LENGTH} characters without control characters`,
    );
  }
  const lang = body.lang;
  if (
    typeof lang !== "string" ||
    lang.length > MAX_LANG_LENGTH ||
    !LANG_PATTERN.test(lang)
  ) {
    return invalid(input.request, "lang must be a language tag such as ja-JP");
  }

  const now = Date.now();
  const saved = await input.pushers.saveNotificationPusher({
    pusherId: await notificationPusherId({
      subject: input.subject,
      appId,
      pushkey,
    }),
    subject: input.subject,
    kind: "webpush",
    appId,
    pushkey,
    endpoint: endpoint.endpoint,
    auth: authSecret,
    deviceDisplayName,
    lang,
    createdAt: now,
    updatedAt: now,
  });
  if (saved.status === "limit_reached") {
    return errorJson(
      "notification_pusher_limit_reached",
      "This account already has the maximum number of notification pushers. Remove one first.",
      409,
      input.request,
    );
  }
  const response: TakosumiAccountsNotificationPusherResponse = {
    pusher: notificationPusherWire(saved.record),
  };
  return json(response, saved.status === "created" ? 201 : 200);
}

function notificationPusherWire(
  record: NotificationPusherRecord,
): TakosumiAccountsNotificationPusher {
  const failing = record.lastFailureAt !== undefined &&
    (record.lastSuccessAt === undefined ||
      record.lastFailureAt > record.lastSuccessAt);
  return {
    id: record.pusherId,
    kind: record.kind,
    app_id: record.appId,
    pushkey: record.pushkey,
    data: { url: record.endpoint },
    device_display_name: record.deviceDisplayName,
    lang: record.lang,
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
    last_success_at: record.lastSuccessAt !== undefined
      ? new Date(record.lastSuccessAt).toISOString()
      : null,
    last_failure_at: record.lastFailureAt !== undefined
      ? new Date(record.lastFailureAt).toISOString()
      : null,
    last_failure_status: record.lastFailureAt !== undefined
      ? record.lastFailureStatus ?? null
      : null,
    failing,
  };
}

function invalid(request: Request, message: string): Response {
  return errorJson("invalid_request", message, 400, request);
}
