export const TAKOSUMI_BACKGROUND_EVENT_ABI =
  "takosumi.background-event/v1" as const;
export const TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION =
  "takosumi.background-event-authority/v1" as const;
export const TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION =
  "takosumi.background-event-result/v1" as const;
export const TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_PROP =
  "takosumiBackgroundEvent" as const;
export const TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH =
  "/.well-known/takosumi/background-events/v1/invoke" as const;

export interface BackgroundEventResourceRef {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly resourceGeneration: number;
  readonly resourceRevisionId: string;
}

export interface CapsuleHostBackgroundPrincipal {
  readonly kind: "CapsuleHostBackground";
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installingPrincipalId: string;
}

export type TakosumiBackgroundEventSource =
  | ({
      readonly kind: "Queue";
      readonly deadLetterQueue?: BackgroundEventResourceRef;
    } & BackgroundEventResourceRef)
  | ({
      readonly kind: "Schedule";
    } & BackgroundEventResourceRef);

export interface TakosumiBackgroundEventTarget extends BackgroundEventResourceRef {
  readonly kind: "HttpService";
  /** App-defined opaque handler token. The host never interprets it. */
  readonly entrypoint: string;
}

export interface TakosumiBackgroundEventRetryPolicy {
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
  readonly onExhausted: "dead_letter" | "fail";
}

export interface TakosumiBackgroundQueueMessage {
  readonly id: string;
  readonly timestamp: string;
  readonly attempts: number;
  readonly body: unknown;
}

export type TakosumiBackgroundEvent =
  | {
      readonly kind: "queue";
      readonly deliveryId: string;
      readonly occurredAt: string;
      readonly attempt: number;
      readonly source: BackgroundEventResourceRef;
      readonly messages: readonly TakosumiBackgroundQueueMessage[];
    }
  | {
      readonly kind: "schedule";
      readonly deliveryId: string;
      readonly occurredAt: string;
      readonly attempt: number;
      readonly source: BackgroundEventResourceRef;
      readonly scheduledAt: string;
      readonly cron: string;
    };

export interface TakosumiBackgroundEventEnvelope {
  readonly abi: typeof TAKOSUMI_BACKGROUND_EVENT_ABI;
  readonly activationId: string;
  readonly activationRevisionId: string;
  readonly principal: CapsuleHostBackgroundPrincipal;
  readonly source: TakosumiBackgroundEventSource;
  readonly target: TakosumiBackgroundEventTarget;
  readonly retry: TakosumiBackgroundEventRetryPolicy;
  readonly event: TakosumiBackgroundEvent;
}

/**
 * Host-authenticated execution props. A runtime must compare this object with
 * the request envelope and digest before calling its application handler.
 */
export interface TakosumiBackgroundEventAuthority {
  readonly version: typeof TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION;
  readonly activationId: string;
  readonly activationRevisionId: string;
  readonly invocationDigest: `sha256:${string}`;
  readonly principal: CapsuleHostBackgroundPrincipal;
  readonly source: TakosumiBackgroundEventSource;
  readonly target: TakosumiBackgroundEventTarget;
}

export interface TakosumiBackgroundEventAck {
  readonly version: typeof TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION;
  readonly deliveryId: string;
  readonly activationRevisionId: string;
  readonly targetResourceRevisionId: string;
  readonly outcome: "ack";
}

export function parseTakosumiBackgroundEventEnvelope(
  value: unknown,
): TakosumiBackgroundEventEnvelope {
  const envelope = exactRecord(value, [
    "abi",
    "activationId",
    "activationRevisionId",
    "principal",
    "source",
    "target",
    "retry",
    "event",
  ]);
  if (envelope.abi !== TAKOSUMI_BACKGROUND_EVENT_ABI) {
    throw new TypeError("background event ABI is invalid");
  }
  const source = backgroundSource(envelope.source);
  const target = backgroundTarget(envelope.target);
  const principal = backgroundPrincipal(envelope.principal);
  if (
    source.workspaceId !== target.workspaceId ||
    principal.workspaceId !== source.workspaceId
  ) {
    throw new TypeError("background event Workspace authority is invalid");
  }
  const retry = backgroundRetry(envelope.retry, source);
  const event = backgroundEvent(envelope.event);
  if (
    event.kind !== (source.kind === "Queue" ? "queue" : "schedule") ||
    !sameBackgroundResource(event.source, source)
  ) {
    throw new TypeError("background event source is invalid");
  }
  return {
    abi: TAKOSUMI_BACKGROUND_EVENT_ABI,
    activationId: token(envelope.activationId),
    activationRevisionId: token(envelope.activationRevisionId),
    principal,
    source,
    target,
    retry,
    event,
  };
}

export function parseTakosumiBackgroundEventAuthority(
  value: unknown,
): TakosumiBackgroundEventAuthority {
  const authority = exactRecord(value, [
    "version",
    "activationId",
    "activationRevisionId",
    "invocationDigest",
    "principal",
    "source",
    "target",
  ]);
  if (authority.version !== TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION) {
    throw new TypeError("background event authority version is invalid");
  }
  const invocationDigest = token(authority.invocationDigest);
  if (!/^sha256:[0-9a-f]{64}$/u.test(invocationDigest)) {
    throw new TypeError("background event invocation digest is invalid");
  }
  const principal = backgroundPrincipal(authority.principal);
  const source = backgroundSource(authority.source);
  const target = backgroundTarget(authority.target);
  if (
    source.workspaceId !== target.workspaceId ||
    principal.workspaceId !== source.workspaceId
  ) {
    throw new TypeError("background event authority Workspace is invalid");
  }
  return {
    version: TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION,
    activationId: token(authority.activationId),
    activationRevisionId: token(authority.activationRevisionId),
    invocationDigest: invocationDigest as `sha256:${string}`,
    principal,
    source,
    target,
  };
}

export function parseTakosumiBackgroundEventAck(
  value: unknown,
): TakosumiBackgroundEventAck {
  const ack = exactRecord(value, [
    "version",
    "deliveryId",
    "activationRevisionId",
    "targetResourceRevisionId",
    "outcome",
  ]);
  if (
    ack.version !== TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION ||
    ack.outcome !== "ack"
  ) {
    throw new TypeError("background event result is invalid");
  }
  return {
    version: TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
    deliveryId: token(ack.deliveryId),
    activationRevisionId: token(ack.activationRevisionId),
    targetResourceRevisionId: token(ack.targetResourceRevisionId),
    outcome: "ack",
  };
}

export async function takosumiBackgroundEventEnvelopeDigest(
  envelope: TakosumiBackgroundEventEnvelope,
): Promise<`sha256:${string}`> {
  const canonical = stableJson(parseTakosumiBackgroundEventEnvelope(envelope));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function backgroundPrincipal(value: unknown): CapsuleHostBackgroundPrincipal {
  const principal = exactRecord(value, [
    "kind",
    "workspaceId",
    "capsuleId",
    "installingPrincipalId",
  ]);
  if (principal.kind !== "CapsuleHostBackground") {
    throw new TypeError("background principal kind is invalid");
  }
  return {
    kind: "CapsuleHostBackground",
    workspaceId: token(principal.workspaceId),
    capsuleId: token(principal.capsuleId),
    installingPrincipalId: token(principal.installingPrincipalId),
  };
}

function backgroundSource(value: unknown): TakosumiBackgroundEventSource {
  const candidate = record(value);
  if (candidate.kind === "Queue") {
    const source = exactRecord(value, [
      "kind",
      "workspaceId",
      "resourceId",
      "resourceGeneration",
      "resourceRevisionId",
      ...(candidate.deadLetterQueue === undefined ? [] : ["deadLetterQueue"]),
    ]);
    const resource = backgroundResource(source, "Queue");
    const deadLetterQueue =
      source.deadLetterQueue === undefined
        ? undefined
        : backgroundResource(source.deadLetterQueue, "Queue");
    if (deadLetterQueue?.resourceId === resource.resourceId) {
      throw new TypeError("background Queue cannot be its own dead letter");
    }
    return {
      ...resource,
      kind: "Queue",
      ...(deadLetterQueue ? { deadLetterQueue } : {}),
    };
  }
  const source = exactRecord(value, [
    "kind",
    "workspaceId",
    "resourceId",
    "resourceGeneration",
    "resourceRevisionId",
  ]);
  if (source.kind !== "Schedule") {
    throw new TypeError("background source kind is invalid");
  }
  return {
    ...backgroundResource(source, "Schedule"),
    kind: "Schedule",
  };
}

function backgroundTarget(value: unknown): TakosumiBackgroundEventTarget {
  const target = exactRecord(value, [
    "kind",
    "workspaceId",
    "resourceId",
    "resourceGeneration",
    "resourceRevisionId",
    "entrypoint",
  ]);
  if (target.kind !== "HttpService") {
    throw new TypeError("background target kind is invalid");
  }
  return {
    ...backgroundResource(target, "HttpService"),
    kind: "HttpService",
    entrypoint: token(target.entrypoint),
  };
}

function backgroundResource(
  value: unknown,
  expectedKind?: string,
): BackgroundEventResourceRef {
  const resource = record(value);
  const workspaceId = token(resource.workspaceId);
  const resourceId = token(resource.resourceId);
  const match = /^tkrn:([^:]+):([^:]+):(.+)$/u.exec(resourceId);
  if (
    !match ||
    match[1] !== workspaceId ||
    (expectedKind !== undefined && match[2] !== expectedKind)
  ) {
    throw new TypeError("background Resource id is invalid");
  }
  const resourceGeneration = positiveInteger(resource.resourceGeneration);
  return {
    workspaceId,
    resourceId,
    resourceGeneration,
    resourceRevisionId: token(resource.resourceRevisionId),
  };
}

function backgroundRetry(
  value: unknown,
  source: TakosumiBackgroundEventSource,
): TakosumiBackgroundEventRetryPolicy {
  const retry = exactRecord(value, [
    "maxAttempts",
    "retryDelaySeconds",
    "onExhausted",
  ]);
  const maxAttempts = positiveInteger(retry.maxAttempts);
  const retryDelaySeconds = nonNegativeInteger(retry.retryDelaySeconds);
  if (
    maxAttempts > 100 ||
    retryDelaySeconds > 86_400 ||
    (retry.onExhausted !== "dead_letter" && retry.onExhausted !== "fail") ||
    (retry.onExhausted === "dead_letter" &&
      (source.kind !== "Queue" || !source.deadLetterQueue))
  ) {
    throw new TypeError("background retry policy is invalid");
  }
  return {
    maxAttempts,
    retryDelaySeconds,
    onExhausted: retry.onExhausted,
  };
}

function backgroundEvent(value: unknown): TakosumiBackgroundEvent {
  const candidate = record(value);
  if (candidate.kind === "queue") {
    const event = exactRecord(value, [
      "kind",
      "deliveryId",
      "occurredAt",
      "attempt",
      "source",
      "messages",
    ]);
    if (
      !Array.isArray(event.messages) ||
      event.messages.length < 1 ||
      event.messages.length > 100
    ) {
      throw new TypeError("background Queue batch size is invalid");
    }
    return {
      kind: "queue",
      deliveryId: token(event.deliveryId),
      occurredAt: canonicalTime(event.occurredAt),
      attempt: boundedAttempt(event.attempt),
      source: backgroundResource(event.source),
      messages: event.messages.map((message) => {
        const item = exactRecord(message, [
          "id",
          "timestamp",
          "attempts",
          "body",
        ]);
        stableJson(item.body);
        return {
          id: token(item.id),
          timestamp: canonicalTime(item.timestamp),
          attempts: boundedAttempt(item.attempts),
          body: item.body,
        };
      }),
    };
  }
  const event = exactRecord(value, [
    "kind",
    "deliveryId",
    "occurredAt",
    "attempt",
    "source",
    "scheduledAt",
    "cron",
  ]);
  if (event.kind !== "schedule") {
    throw new TypeError("background event kind is invalid");
  }
  return {
    kind: "schedule",
    deliveryId: token(event.deliveryId),
    occurredAt: canonicalTime(event.occurredAt),
    attempt: boundedAttempt(event.attempt),
    source: backgroundResource(event.source),
    scheduledAt: canonicalTime(event.scheduledAt),
    cron: token(event.cron),
  };
}

function sameBackgroundResource(
  left: BackgroundEventResourceRef,
  right: BackgroundEventResourceRef,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.resourceId === right.resourceId &&
    left.resourceGeneration === right.resourceGeneration &&
    left.resourceRevisionId === right.resourceRevisionId
  );
}

function boundedAttempt(value: unknown): number {
  const attempt = positiveInteger(value);
  if (attempt > 101) throw new TypeError("background attempt is invalid");
  return attempt;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError("positive integer is required");
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("non-negative integer is required");
  }
  return Number(value);
}

function canonicalTime(value: unknown): string {
  const tokenValue = token(value);
  const parsed = new Date(tokenValue);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString() !== tokenValue
  ) {
    throw new TypeError("canonical UTC timestamp is required");
  }
  return tokenValue;
}

function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("background event token is invalid");
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const candidate = record(value);
  if (Object.keys(candidate).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError("background event object keys are invalid");
  }
  return candidate;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("background event object is invalid");
  }
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined)
      throw new TypeError("value is not JSON serializable");
    return json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
