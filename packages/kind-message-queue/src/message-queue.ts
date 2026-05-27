import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  optionalNonEmptyString,
  optionalNonNegativeInteger,
  rejectUnknownFields,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
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
    optionalAbsoluteUriWithoutPassword(value.url, "$.url", issues);
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

function optionalAbsoluteUriWithoutPassword(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be an absolute URI" });
    return;
  }
  try {
    const url = new URL(value);
    if (url.password) {
      issues.push({ path, message: "must not contain an embedded password" });
    }
  } catch {
    issues.push({ path, message: "must be an absolute URI" });
  }
}
