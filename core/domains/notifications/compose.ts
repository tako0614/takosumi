/**
 * Composition of the own-notification dispatcher from the Takosumi
 * operations, an Accounts store and the operator environment.
 *
 * The recipient directory reads the app owner from app ownership (never
 * Workspace membership), the account that started a Run and the app name for
 * the text. Accounts named by an event itself (a member, a transfer
 * recipient, a revoked Connection's owner) need no lookup.
 */

import type { NotificationDispatchStore } from "./dispatch_store.ts";
import {
  type NotificationEventSource,
  type NotificationRecipientDirectory,
  OwnNotificationDispatcher,
} from "./dispatcher.ts";
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
