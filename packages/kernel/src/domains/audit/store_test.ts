import assert from "node:assert/strict";
import { type AuditEvent, InMemoryAuditStore } from "./mod.ts";

Deno.test("audit store appends once and queries in append order", async () => {
  const store = new InMemoryAuditStore();
  const first = event(
    "audit_1",
    "resources.bind",
    "2026-04-27T00:00:00.000Z",
    "resource_db",
  );
  const second = event(
    "audit_2",
    "runtime.observe",
    "2026-04-27T00:10:00.000Z",
    "workload_web",
  );

  await store.append(first);
  await store.append(second);
  const duplicate = await store.append({ ...first, severity: "critical" });

  assert.equal(duplicate.severity, "info");
  assert.deepEqual((await store.list()).map((item) => item.id), [
    "audit_1",
    "audit_2",
  ]);
  assert.deepEqual(
    (await store.list({
      spaceId: "space_a",
      groupId: "group_a",
      targetType: "runtime",
      since: "2026-04-27T00:05:00.000Z",
      until: "2026-04-27T00:15:00.000Z",
    })).map((item) => item.id),
    ["audit_2"],
  );
  assert.deepEqual(
    (await store.list({ type: "resources.bind" })).map((item) => item.id),
    ["audit_1"],
  );
});

function event(
  id: string,
  type: string,
  occurredAt: string,
  targetId: string,
): AuditEvent {
  return {
    id,
    eventClass: type.startsWith("resources") ? "compliance" : "security",
    type,
    severity: "info",
    spaceId: "space_a",
    groupId: "group_a",
    targetType: type.startsWith("runtime") ? "runtime" : "resource",
    targetId,
    payload: { targetId },
    occurredAt,
    requestId: `req_${id}`,
  };
}
