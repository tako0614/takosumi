import { expect, test } from "bun:test";

import {
  parseTakosumiBackgroundEventAck,
  parseTakosumiBackgroundEventAuthority,
  parseTakosumiBackgroundEventEnvelope,
  TAKOSUMI_BACKGROUND_EVENT_ABI,
  TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION,
  TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
  takosumiBackgroundEventEnvelopeDigest,
  type TakosumiBackgroundEventEnvelope,
} from "../../contract/background-events.ts";

function queueEnvelope(): TakosumiBackgroundEventEnvelope {
  const source = {
    kind: "Queue" as const,
    workspaceId: "ws1",
    resourceId: "tkrn:ws1:Queue:notifications",
    resourceGeneration: 3,
    resourceRevisionId: "queue_revision_3",
    deadLetterQueue: {
      workspaceId: "ws1",
      resourceId: "tkrn:ws1:Queue:notifications-dlq",
      resourceGeneration: 2,
      resourceRevisionId: "dlq_revision_2",
    },
  };
  return {
    abi: TAKOSUMI_BACKGROUND_EVENT_ABI,
    activationId: "activation_1",
    activationRevisionId: "activation_revision_4",
    principal: {
      kind: "CapsuleHostBackground",
      workspaceId: "ws1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "principal_installer",
    },
    source,
    target: {
      kind: "EdgeWorker",
      workspaceId: "ws1",
      resourceId: "tkrn:ws1:EdgeWorker:yurucommu",
      resourceGeneration: 5,
      resourceRevisionId: "service_revision_5",
      entrypoint: "push_notification",
    },
    retry: {
      maxAttempts: 5,
      retryDelaySeconds: 15,
      onExhausted: "dead_letter",
    },
    event: {
      kind: "queue",
      deliveryId: "delivery_1",
      occurredAt: "2026-07-29T00:00:00.000Z",
      attempt: 1,
      source,
      messages: [
        {
          id: "message_1",
          timestamp: "2026-07-29T00:00:00.000Z",
          attempts: 1,
          body: { notificationId: "notification_1" },
        },
      ],
    },
  };
}

test("background-event ABI is provider-neutral and has a deterministic digest", async () => {
  const envelope = parseTakosumiBackgroundEventEnvelope(queueEnvelope());
  expect(envelope.source).not.toHaveProperty("nativeId");
  expect(envelope.target).not.toHaveProperty("nativeId");
  expect(await takosumiBackgroundEventEnvelopeDigest(envelope)).toBe(
    await takosumiBackgroundEventEnvelopeDigest(
      JSON.parse(JSON.stringify(envelope)),
    ),
  );
});

test("background-event authority and ack are exact, versioned contracts", async () => {
  const envelope = queueEnvelope();
  const digest = await takosumiBackgroundEventEnvelopeDigest(envelope);
  expect(
    parseTakosumiBackgroundEventAuthority({
      version: TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION,
      activationId: envelope.activationId,
      activationRevisionId: envelope.activationRevisionId,
      invocationDigest: digest,
      principal: envelope.principal,
      source: envelope.source,
      target: envelope.target,
    }).invocationDigest,
  ).toBe(digest);
  expect(
    parseTakosumiBackgroundEventAck({
      version: TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION,
      deliveryId: "delivery_1",
      activationRevisionId: "activation_revision_4",
      targetResourceRevisionId: "service_revision_5",
      outcome: "ack",
    }).outcome,
  ).toBe("ack");
});

test("background-event ABI rejects revision drift, provider ids, and invalid DLQ policy", () => {
  const drifted = structuredClone(queueEnvelope());
  const driftedRecord = drifted as unknown as {
    event: { source: Record<string, unknown> };
  };
  driftedRecord.event.source = {
    ...driftedRecord.event.source,
    resourceRevisionId: "queue_revision_old",
  };
  expect(() => parseTakosumiBackgroundEventEnvelope(drifted)).toThrow(
    "background event source is invalid",
  );

  const providerIdentity = structuredClone(queueEnvelope()) as unknown as {
    source: Record<string, unknown>;
  };
  providerIdentity.source.nativeId = "cloudflare-queue-id";
  expect(() => parseTakosumiBackgroundEventEnvelope(providerIdentity)).toThrow(
    "background event object keys are invalid",
  );

  const noDlq = structuredClone(queueEnvelope());
  delete noDlq.source.deadLetterQueue;
  expect(() => parseTakosumiBackgroundEventEnvelope(noDlq)).toThrow(
    "background retry policy is invalid",
  );
});
