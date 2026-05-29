import type { Shape } from "takosumi-contract/reference/shape";
import {
  optionalNonEmptyString,
  optionalNonNegativeInteger,
  optionalPasswordlessAbsoluteUri,
  rejectUnknownFields,
  requireNonEmptyString,
  requireRoot,
} from "takosumi-contract/reference/shape-validators";
import {
  MESSAGE_QUEUE_CAPABILITY_TERMS,
  MESSAGE_QUEUE_DESCRIPTION,
  MESSAGE_QUEUE_KIND_SHAPE_ID,
  MESSAGE_QUEUE_KIND_VERSION,
  MESSAGE_QUEUE_OUTPUT_FIELDS,
  type MessageQueueCapabilityTerm,
  type MessageQueueOutputs,
  type MessageQueueSpec,
} from "./message-queue.generated.ts";

export type {
  MessageQueueCapabilityTerm,
  MessageQueueOutputs,
  MessageQueueSpec,
};

/**
 * `message-queue@v1` component kind descriptor. An implementation binding
 * materializes the queue and publishes its event-channel material.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-message-queue/spec/kind.jsonld` via `message-queue.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const MessageQueueKind: Shape<
  MessageQueueSpec,
  MessageQueueOutputs,
  MessageQueueCapabilityTerm
> = {
  id: MESSAGE_QUEUE_KIND_SHAPE_ID,
  version: MESSAGE_QUEUE_KIND_VERSION,
  description: MESSAGE_QUEUE_DESCRIPTION,
  capabilityTerms: MESSAGE_QUEUE_CAPABILITY_TERMS,
  outputFields: MESSAGE_QUEUE_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      ["name", "deliveryDelay"],
      issues,
    );
    requireNonEmptyString(value.name, "$.name", issues);
    optionalNonNegativeInteger(value.deliveryDelay, "$.deliveryDelay", issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      [
        "queueId",
        "name",
        "url",
        "producerTokenSecretRef",
        "consumerTokenSecretRef",
      ],
      issues,
    );
    requireNonEmptyString(value.queueId, "$.queueId", issues);
    requireNonEmptyString(value.name, "$.name", issues);
    optionalPasswordlessAbsoluteUri(value.url, "$.url", issues);
    optionalNonEmptyString(
      value.producerTokenSecretRef,
      "$.producerTokenSecretRef",
      issues,
    );
    optionalNonEmptyString(
      value.consumerTokenSecretRef,
      "$.consumerTokenSecretRef",
      issues,
    );
  },
};
