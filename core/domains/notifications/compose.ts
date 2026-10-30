/**
 * Composition of the own-notification dispatcher from the Takosumi
 * operations, an Accounts store and the operator environment.
 *
 * The recipient directory reads the app owner from app ownership (never
 * Workspace membership), the account that started a Run and the app name for
 * the text. Accounts named by an event itself (a member, a transfer
 * recipient, a revoked Connection's owner) need no lookup.
 */

import type { ActivityEvent } from "takosumi-contract/activity";
import type { NotificationDispatchStore } from "./dispatch_store.ts";
import {
  IMMEDIATE_DELIVERY_TIMEOUT_MS,
  type NotificationEventSource,
  type NotificationRecipientDirectory,
  OwnNotificationDispatcher,
} from "./dispatcher.ts";
import type { OwnNotificationContext } from "./own_notifications.ts";
import {
  NOTIFICATION_PUSH_RELAY_ORIGINS_ENV,
  parseNotificationPushRelayOrigins,
} from "./pusher_endpoint.ts";
import { instanceWebPushTopicKey } from "./web_push/topic.ts";
import { instanceVapidKeyPair, type VapidSecretEnv } from "./web_push/vapid.ts";

export interface DirectoryOperations {
  readonly appOwnership: {
    getOwnership(capsuleId: string): Promise<{ readonly ownerAccountId?: string | null } | undefined>;
  };
  readonly controller: {
    getRun(runId: string): Promise<{ readonly createdBy?: string }>;
  };
  readonly capsules: {
    getCapsule(capsuleId: string): Promise<{ readonly name: string }>;
  };
}

export type OwnNotificationOperations = DirectoryOperations & {
  readonly activity: NotificationEventSource;
};

export function notificationRecipientDirectory(
  operations: DirectoryOperations,
): NotificationRecipientDirectory {
  return {
    appOwner: async (capsuleId) =>
      (await operations.appOwnership.getOwnership(capsuleId))?.ownerAccountId ?? undefined,
    runStartedBy: (runId) =>
      orUndefinedWhenMissing(async () => (await operations.controller.getRun(runId)).createdBy),
    appName: (capsuleId) =>
      orUndefinedWhenMissing(async () => (await operations.capsules.getCapsule(capsuleId)).name),
  };
}

async function orUndefinedWhenMissing<T>(
  read: () => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if ((error as { readonly code?: unknown } | null)?.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

const DISPATCH_STORE_METHODS = [
  "getNotificationDispatchCursor",
  "compareAndSetNotificationDispatchCursor",
  "enqueueNotificationDeliveries",
  "claimNotificationDeliveries",
  "settleNotificationDelivery",
  "pruneNotificationDeliveries",
  "hasAnyNotificationPusher",
  "listNotificationPushersForSubject",
  "findNotificationPusher",
  "removeNotificationPusher",
  "recordNotificationPusherOutcome",
] as const satisfies readonly (keyof NotificationDispatchStore)[];

/**
 * The dispatcher, or undefined when the store does not keep pushers and
 * deliveries, the issuer is not a usable origin, or the relay allowlist is
 * malformed.
 */
export function createOwnNotificationDispatcher(input: {
  readonly operations: OwnNotificationOperations;
  readonly store: Partial<NotificationDispatchStore>;
  readonly env: VapidSecretEnv;
  /** The instance's public origin (its Accounts issuer). */
  readonly issuer: string | undefined;
  readonly fetch?: typeof fetch;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}): OwnNotificationDispatcher | undefined {
  const store = input.store;
  if (DISPATCH_STORE_METHODS.some((method) => typeof store[method] !== "function")) {
    return undefined;
  }
  let instanceOrigin: string;
  try {
    instanceOrigin = new URL(input.issuer ?? "").origin;
  } catch {
    return undefined;
  }
  if (instanceOrigin === "null") return undefined;
  let relayOrigins: readonly string[];
  try {
    const configured = input.env[NOTIFICATION_PUSH_RELAY_ORIGINS_ENV];
    relayOrigins = parseNotificationPushRelayOrigins(
      typeof configured === "string" ? configured : undefined,
    );
  } catch {
    return undefined;
  }
  return new OwnNotificationDispatcher({
    events: input.operations.activity,
    directory: notificationRecipientDirectory(input.operations),
    store: store as NotificationDispatchStore,
    vapid: () => instanceVapidKeyPair(input.env),
    topicKey: () => instanceWebPushTopicKey(input.env),
    instanceOrigin,
    relayOrigins,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
}

/**
 * The immediate path for one event the host just stored: enqueue and send
 * its rows, never longer than {@link IMMEDIATE_DELIVERY_TIMEOUT_MS} in total
 * (send timeouts included), never throwing. Leftovers stay leased for the
 * catch-up run.
 */
export async function deliverOwnNotificationNow(input: {
  readonly dispatcher: OwnNotificationDispatcher;
  readonly event: ActivityEvent;
  readonly context?: OwnNotificationContext;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      input.dispatcher.deliverEvent(input.event, input.context, {
        timeoutMs: IMMEDIATE_DELIVERY_TIMEOUT_MS - 2_000,
      }),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), IMMEDIATE_DELIVERY_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timed_out") {
      input.log?.("own_notification_immediate_timed_out", { eventId: input.event.id });
    } else if (outcome.enqueued > 0 || outcome.leftOver > 0) {
      input.log?.("own_notification_immediate", { eventId: input.event.id, ...outcome });
    }
  } catch (error) {
    input.log?.("own_notification_immediate_failed", {
      eventId: input.event.id,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
