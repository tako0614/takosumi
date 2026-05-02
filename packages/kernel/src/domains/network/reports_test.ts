import assert from "node:assert/strict";
import { buildEgressReport, summarizeEgress } from "./mod.ts";

Deno.test("network egress reports summarize decisions and byte totals", () => {
  const entries = [{
    sourceIdentityId: "identity_web",
    sourceComponentName: "web",
    destinationHost: "api.example.test",
    port: 443,
    protocol: "https",
    decision: "allowed" as const,
    bytesSent: 120,
    bytesReceived: 2048,
    observedAt: "2026-04-27T00:01:00.000Z",
  }, {
    sourceComponentName: "worker",
    destinationCidr: "203.0.113.0/24",
    decision: "denied" as const,
    bytesSent: 64,
    observedAt: "2026-04-27T00:02:00.000Z",
  }, {
    sourceComponentName: "cron",
    destinationHost: "unknown.example.test",
    decision: "unknown" as const,
    bytesReceived: 8,
    observedAt: "2026-04-27T00:03:00.000Z",
  }];

  assert.deepEqual(summarizeEgress(entries), {
    allowedCount: 1,
    deniedCount: 1,
    unknownCount: 1,
    bytesSent: 184,
    bytesReceived: 2056,
  });

  const report = buildEgressReport({
    id: "egress_1",
    spaceId: "space_a",
    groupId: "group_a",
    activationId: "activation_1",
    windowStart: "2026-04-27T00:00:00.000Z",
    windowEnd: "2026-04-27T01:00:00.000Z",
    generatedAt: "2026-04-27T01:00:01.000Z",
    entries,
  });

  assert.equal(report.generatedAt, "2026-04-27T01:00:01.000Z");
  assert.deepEqual(report.summary, summarizeEgress(entries));
});
