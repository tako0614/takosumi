export * from "./src/message-queue.ts";
export * from "./src/message-queue.generated.ts";

import { MessageQueueKind } from "./src/message-queue.ts";
import {
  MESSAGE_QUEUE_KIND_NAME,
  MESSAGE_QUEUE_KIND_URI,
} from "./src/message-queue.generated.ts";

export const KIND_NAME = MESSAGE_QUEUE_KIND_NAME;
export const KIND_URI = MESSAGE_QUEUE_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
  "queue": KIND_URI,
});
export const KIND_DESCRIPTOR = MessageQueueKind;
