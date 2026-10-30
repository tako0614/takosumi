import { expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import {
  ownNotificationLanguage,
  planOwnNotification,
  renderOwnNotification,
} from "../../../../core/domains/notifications/own_notifications.ts";
import {
  buildDeclarativeWebPushMessage,
  MAX_DECLARATIVE_WEB_PUSH_BYTES,
} from "../../../../core/domains/notifications/web_push/payload.ts";
import {
  computeWebPushTopic,
  deriveWebPushTopicKey,
} from "../../../../core/domains/notifications/web_push/topic.ts";

const AT = "2026-10-30T12:00:00.000Z";

function event(over: Partial<ActivityEvent> & Pick<ActivityEvent, "action">): ActivityEvent {
  return {
    id: "act_1",
    workspaceId: "workspace_1",
    targetType: "run",
    targetId: "run_1",
    metadata: {},
    createdAt: AT,
    ...over,
  } as ActivityEvent;
}

test("each notified kind has its recipients, link, TTL and urgency", () => {
  expect(planOwnNotification(event({ action: "run.approval_required", runId: "run_1", metadata: { capsuleId: "cap_1", operation: "destroy" } })))
    .toMatchObject({ recipients: [{ kind: "app_owner", capsuleId: "cap_1" }], navigatePath: "/runs/run_1", ttlSeconds: 86_400, urgency: "high", group: "run:run_1" });
  expect(planOwnNotification(event({ action: "run.failed", metadata: { capsuleId: "cap_1", phase: "apply" } })))
    .toMatchObject({
      recipients: [{ kind: "run_starter", runId: "run_1" }, { kind: "app_owner", capsuleId: "cap_1" }],
      ttlSeconds: 259_200,
      urgency: "normal",
    });
  expect(planOwnNotification(event({ action: "run.applied", metadata: { capsuleId: "cap_1", operation: "create" } })))
    .toMatchObject({ recipients: [{ kind: "run_starter", runId: "run_1" }], navigatePath: "/apps/cap_1" });
  expect(planOwnNotification(event({ action: "run.applied", metadata: { capsuleId: "cap_1", operation: "update" } }))).toBeUndefined();
  expect(planOwnNotification(event({ action: "run.applied", metadata: { capsuleId: "cap_1" } }))).toBeUndefined();
  for (const action of [
    "capsule.drift_detected",
    "capsule.auto_update_failed",
    "capsule.auto_update_apply_failed",
    "capsule.uninstall_blocked",
    "interface_materialization.dead_lettered",
  ]) {
    expect(planOwnNotification(event({ action, targetType: "capsule", targetId: "cap_9", metadata: {} })))
      .toMatchObject({ recipients: [{ kind: "app_owner", capsuleId: "cap_9" }], navigatePath: "/apps/cap_9#attention" });
  }
  expect(planOwnNotification(event({ action: "connection.revoked", targetType: "connection", targetId: "conn_1" })))
    .toMatchObject({ recipients: [{ kind: "connection_owner", connectionId: "conn_1" }], navigatePath: "/connections" });
  expect(planOwnNotification(event({ action: "interface_link.approval_requested", targetType: "interface_link", targetId: "ifl_1", metadata: { providerCapsuleId: "cap_p", consumerCapsuleId: "cap_c" } })))
    .toMatchObject({ recipients: [{ kind: "app_owner", capsuleId: "cap_p" }], consumerCapsuleId: "cap_c", navigatePath: "/apps/cap_p#links", ttlSeconds: 86_400, urgency: "high" });
  for (const action of ["run.plan_created", "run.approved", "interface_link.approved", "capsule.created", "scheduled.source_poll.started"]) {
    expect(planOwnNotification(event({ action, metadata: { capsuleId: "cap_1" } }))).toBeUndefined();
  }
});

test("texts use the device language, the app name and no error detail", () => {
  const plan = planOwnNotification(event({ action: "run.failed", metadata: { capsuleId: "cap_1", phase: "apply", errorCode: "secret_token_leak" } }))!;
  expect(renderOwnNotification(plan, { app: "yurucommu" }, "ja")).toEqual({ title: "Runが失敗しました", body: "yurucommu の適用が失敗しました" });
  expect(renderOwnNotification(plan, {}, "en")).toEqual({ title: "A Run failed", body: "The apply of an app failed" });
  const destroy = planOwnNotification(event({ action: "run.approval_required", metadata: { capsuleId: "cap_1", operation: "destroy" } }))!;
  expect(renderOwnNotification(destroy, { app: "yurucommu" }, "en").body).toBe("Removing yurucommu needs your approval");
  expect(ownNotificationLanguage("ja-JP")).toBe("ja");
  expect(ownNotificationLanguage("JA")).toBe("ja");
  expect(ownNotificationLanguage("jv")).toBe("en");
  expect(ownNotificationLanguage("en-US")).toBe("en");
});

test("the payload stays on the instance origin and within 2,048 bytes", () => {
  const long = buildDeclarativeWebPushMessage({
    origin: "https://takosumi.example.test",
    title: "承認を待っています",
    body: "とても長いアプリ名".repeat(400),
    navigate: "https://elsewhere.example.test/runs/1",
    lang: "ja-JP",
    tag: "run:run_1",
  });
  expect(new TextEncoder().encode(long.json).byteLength).toBeLessThanOrEqual(MAX_DECLARATIVE_WEB_PUSH_BYTES);
  expect(long.message.notification.navigate).toBe("https://takosumi.example.test/");
  expect(long.message.notification.body?.endsWith("…")).toBe(true);
  const ok = buildDeclarativeWebPushMessage({ origin: "https://takosumi.example.test/x", title: "t", navigate: "/runs/1" });
  expect(ok.message).toEqual({ web_push: 8030, notification: { title: "t", navigate: "https://takosumi.example.test/runs/1" } });
});

test("topics are keyed per pusher and group and fit RFC 8030", async () => {
  const key = await deriveWebPushTopicKey(new TextEncoder().encode("fixture-only-secret-store-passphrase-0123456789"));
  const topic = await computeWebPushTopic(key, "npsh_a", "run:run_1");
  expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(await computeWebPushTopic(key, "npsh_a", "run:run_1")).toBe(topic);
  expect(await computeWebPushTopic(key, "npsh_b", "run:run_1")).not.toBe(topic);
  expect(await computeWebPushTopic(key, "npsh_a", "run:run_2")).not.toBe(topic);
});
