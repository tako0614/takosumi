import assert from "node:assert/strict";
import type { AuditEvent } from "../../domains/audit/types.ts";
import { InMemoryObservabilitySink, verifyAuditHashChain } from "./mod.ts";

Deno.test("audit hash chain verifies appended events", async () => {
  const sink = new InMemoryObservabilitySink();

  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));

  assert.equal(await sink.verifyAuditChain(), true);
});

Deno.test("audit hash chain detects tampered event payload", async () => {
  const sink = new InMemoryObservabilitySink();
  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));

  const records = [...await sink.listAudit()];
  records[0] = {
    ...records[0],
    event: {
      ...records[0].event,
      payload: { action: "changed" },
    },
  };

  const result = await verifyAuditHashChain(records);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "event-hash-mismatch");
  assert.equal(result.invalidAt, 1);
});

Deno.test("audit hash chain detects broken previous hash linkage", async () => {
  const sink = new InMemoryObservabilitySink();
  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));

  const records = [...await sink.listAudit()];
  records[1] = { ...records[1], previousHash: "bad" };

  const result = await verifyAuditHashChain(records);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "previous-hash-mismatch");
  assert.equal(result.invalidAt, 2);
});

function event(id: string, occurredAt: string): AuditEvent {
  return {
    id,
    eventClass: "security",
    type: "worker.authz",
    severity: "info",
    actor: {
      actorAccountId: "acct_1",
      roles: ["owner"],
      requestId: `req_${id}`,
      sessionId: "secret_session",
    },
    spaceId: "space_a",
    groupId: "group_a",
    targetType: "worker",
    targetId: "worker_a",
    payload: { action: "allow", token: "secret_token" },
    occurredAt,
    requestId: `req_${id}`,
  };
}
