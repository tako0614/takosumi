import type { FetchLike, MobileSession } from "./types.ts";
import {
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  parseNotificationPusherDeleteRequest,
  parseNotificationPusherSetRequest,
  type NotificationPusher,
} from "../../contract/notification-pushers.ts";
import { hostEndpoint } from "./url.ts";

export { NOTIFICATION_PUSHER_REGISTRATION_PATH };

export interface MobileApiClient {
  readonly session: MobileSession;
  readonly json: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

export class MobileApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`Mobile API request failed: ${status} ${path}`);
    this.name = "MobileApiError";
    this.status = status;
    this.path = path;
  }
}

export interface MobileHostNotificationPusherRegistrationInput {
  readonly session: MobileSession;
  readonly pusher: NotificationPusher;
  readonly scope?: string;
  readonly path?: string;
  readonly fetch?: FetchLike;
}

export interface MobileHostNotificationPusherUnregistrationInput {
  readonly session: MobileSession;
  readonly appId: string;
  readonly pushkey: string;
  readonly scope?: string;
  readonly path?: string;
  readonly fetch?: FetchLike;
}

export function createMobileApiClient(input: {
  readonly session: MobileSession;
  readonly fetch?: FetchLike;
}): MobileApiClient {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    session: input.session,
    async json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await fetcher(
        hostEndpoint(input.session.hostUrl, path),
        {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `${input.session.tokenType} ${input.session.accessToken}`,
            ...init.headers,
          },
        },
      );
      if (!response.ok) {
        throw new MobileApiError(response.status, path);
      }
      return (await response.json()) as T;
    },
  };
}

export async function registerNotificationPusherWithHost(
  input: MobileHostNotificationPusherRegistrationInput,
): Promise<void> {
  const parsed = parseNotificationPusherSetRequest(
    {
      product: input.session.product,
      scope: input.scope,
      pusher: input.pusher,
    },
    { product: input.session.product },
  );
  if (!parsed.ok) throw invalidPusherError(parsed.error);

  const client = createMobileApiClient({
    session: input.session,
    fetch: input.fetch,
  });
  await client.json(
    input.path ?? resolveNotificationPusherEndpoint(input.session),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: input.session.product,
        ...(parsed.value.scope ? { scope: parsed.value.scope } : {}),
        pusher: parsed.value.pusher,
      }),
    },
  );
}

export async function unregisterNotificationPusherWithHost(
  input: MobileHostNotificationPusherUnregistrationInput,
): Promise<void> {
  const parsed = parseNotificationPusherDeleteRequest(
    {
      product: input.session.product,
      scope: input.scope,
      app_id: input.appId,
      pushkey: input.pushkey,
    },
    { product: input.session.product },
  );
  if (!parsed.ok) throw invalidPusherError(parsed.error);

  const client = createMobileApiClient({
    session: input.session,
    fetch: input.fetch,
  });
  await client.json(
    input.path ?? resolveNotificationPusherEndpoint(input.session),
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: input.session.product,
        ...(parsed.value.scope ? { scope: parsed.value.scope } : {}),
        app_id: parsed.value.appId,
        pushkey: parsed.value.pushkey,
      }),
    },
  );
}

export function resolveNotificationPusherEndpoint(
  session: Pick<MobileSession, "productEndpoints">,
): string {
  const endpoint = session.productEndpoints?.notificationPushers?.trim();
  return endpoint || NOTIFICATION_PUSHER_REGISTRATION_PATH;
}

function invalidPusherError(input: {
  readonly error: string;
  readonly field?: string;
}): Error {
  const field = input.field ? ` (${input.field})` : "";
  return new Error(`Notification pusher is invalid${field}: ${input.error}`);
}
