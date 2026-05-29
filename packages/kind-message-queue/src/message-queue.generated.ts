// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface MessageQueueSpec {
  /** Queue name. */
  readonly name: string;
  /** Dead-letter queue name for messages that exceed maxRetries. An opaque queue name; same-AppSpec wiring to another message-queue component is expressed at the AppSpec level via connect/listen rather than inside this spec. */
  readonly deadLetterQueue?: string;
  /** Default delivery delay in seconds. */
  readonly deliveryDelay?: number;
  /** Maximum delivery attempts before a message is routed to the dead-letter queue. */
  readonly maxRetries?: number;
}

export interface MessageQueueOutputs {
  /** Implementation-scoped queue identifier. */
  readonly queueId: string;
  /** Queue name. */
  readonly name: string;
  /** Queue endpoint URL if available. */
  readonly url?: string;
  /** Secret reference for producer credentials. */
  readonly producerTokenSecretRef?: string;
  /** Secret reference for consumer credentials. */
  readonly consumerTokenSecretRef?: string;
}

export type MessageQueueCapabilityTerm =
  | "queue-produce"
  | "queue-consume";

export type MessageQueueOutputFieldName =
  | "queueId"
  | "name"
  | "url"
  | "producerTokenSecretRef"
  | "consumerTokenSecretRef";

export type MessageQueueOutputSlotName =
  | "producer"
  | "consumer";

export type MessageQueueOutputSlotContract = "event-channel";

export interface MessageQueueOutputSlotDescriptor {
  readonly name: MessageQueueOutputSlotName;
  readonly contract: MessageQueueOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface MessageQueueListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const MESSAGE_QUEUE_CAPABILITY_TERMS:
  readonly MessageQueueCapabilityTerm[] = [
    "queue-produce",
    "queue-consume",
  ];

export const MESSAGE_QUEUE_OUTPUT_FIELDS:
  readonly MessageQueueOutputFieldName[] = [
    "queueId",
    "name",
    "url",
    "producerTokenSecretRef",
    "consumerTokenSecretRef",
  ];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const MESSAGE_QUEUE_ALIASES: readonly string[] = [
  "message-queue",
  "queue",
];

export const MESSAGE_QUEUE_OUTPUT_SLOTS: readonly MessageQueueOutputSlotName[] =
  [
    "producer",
    "consumer",
  ];

export const MESSAGE_QUEUE_OUTPUT_SLOT_DESCRIPTORS:
  readonly MessageQueueOutputSlotDescriptor[] = [
    {
      name: "producer",
      contract: "event-channel",
      exampleMaterialMapping: {
        "channel": "$outputs.queueId",
        "protocol": "queue",
        "queue": "$outputs.name",
        "endpoint": "$outputs.url",
        "producerCredentialRef": {
          "secretRef": "$outputs.producerTokenSecretRef",
        },
      },
    },
    {
      name: "consumer",
      contract: "event-channel",
      exampleMaterialMapping: {
        "channel": "$outputs.queueId",
        "protocol": "queue",
        "queue": "$outputs.name",
        "endpoint": "$outputs.url",
        "consumerCredentialRef": {
          "secretRef": "$outputs.consumerTokenSecretRef",
        },
      },
    },
  ];

export const MESSAGE_QUEUE_LISTEN_SLOTS:
  readonly MessageQueueListenSlotDescriptor[] = [];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const MESSAGE_QUEUE_KIND_SHAPE_ID = "message-queue";
/** @deprecated Use MESSAGE_QUEUE_KIND_URI for AppSpec kind identity, or MESSAGE_QUEUE_KIND_SHAPE_ID for legacy Shape.id. */
export const MESSAGE_QUEUE_KIND_ID = MESSAGE_QUEUE_KIND_SHAPE_ID;
export const MESSAGE_QUEUE_KIND_NAME = "message-queue";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const MESSAGE_QUEUE_KIND_URI =
  "https://takosumi.com/kinds/v1/message-queue";
export const MESSAGE_QUEUE_KIND_VERSION = "v1";
export const MESSAGE_QUEUE_DESCRIPTION =
  "Message queue for asynchronous producer and consumer workloads.";
