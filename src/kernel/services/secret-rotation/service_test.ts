import assert from "node:assert/strict";
import { MemoryEncryptedSecretStore } from "../../adapters/secret-store/mod.ts";
import { InMemoryObservabilitySink } from "../observability/mod.ts";
import { SecretRotationService } from "./mod.ts";

Deno.test("checkRotation emits notices for due / expired secrets", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => "v1",
  });
  await store.putSecret({
    name: "PLATFORM_PRIVATE_KEY",
    value: "sk-fake",
    cloudPartition: "cloudflare",
    rotationPolicy: { intervalDays: 30, gracePeriodDays: 7 },
  });
  const observability = new InMemoryObservabilitySink();
  const service = new SecretRotationService({
    store,
    clock: () => now,
    observability,
  });

  // active — no notice.
  let report = await service.checkRotation();
  assert.equal(report.notices.length, 0);

  // due — past 30 days.
  now = new Date("2026-02-05T00:00:00.000Z");
  report = await service.checkRotation();
  assert.equal(report.notices.length, 1);
  assert.equal(report.notices[0].reason, "due");
  assert.equal(report.notices[0].cloudPartition, "cloudflare");

  // expired — past grace period.
  now = new Date("2026-02-15T00:00:00.000Z");
  report = await service.checkRotation();
  assert.equal(report.notices[0].reason, "expired");

  // Audit log captured 2 events (the active call generated nothing).
  const audit = await observability.listAudit();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].event.type, "secret.rotation.notice");
  assert.equal(audit[1].event.severity, "critical");
});

Deno.test("rotateSecret writes a new version and emits audit event", async () => {
  let counter = 0;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => `v${++counter}`,
  });
  await store.putSecret({
    name: "PLATFORM_PRIVATE_KEY",
    value: "old",
    cloudPartition: "aws",
    rotationPolicy: { intervalDays: 30, gracePeriodDays: 7 },
  });
  const observability = new InMemoryObservabilitySink();
  const service = new SecretRotationService({
    store,
    clock: () => now,
    observability,
  });
  now = new Date("2026-02-15T00:00:00.000Z");
  const result = await service.rotateSecret({
    name: "PLATFORM_PRIVATE_KEY",
    newValue: "new",
    reason: "scheduled",
    actor: "operator-1",
  });
  assert.equal(result.previous?.version, "secret_version_v1");
  assert.equal(result.current.version, "secret_version_v2");
  assert.equal(result.current.cloudPartition, "aws");
  // Policy carried over.
  assert.equal(result.current.rotationPolicy?.intervalDays, 30);
  // Latest reads new value.
  const latest = await store.latestSecret("PLATFORM_PRIVATE_KEY");
  assert.equal(latest?.version, "secret_version_v2");
  assert.equal(await store.getSecret(latest!), "new");

  // Audit log records actor + reason.
  const audit = await observability.listAudit();
  const rotationEvent = audit.find((e) =>
    e.event.type === "secret.rotation.executed"
  );
  assert.ok(rotationEvent, "rotation audit event missing");
  const payload = rotationEvent.event.payload as Record<string, unknown>;
  assert.equal(payload.reason, "scheduled");
  assert.equal(payload.previousVersion, "secret_version_v1");
  assert.equal(rotationEvent.event.actor?.actorAccountId, "operator-1");
});

Deno.test("checkRotation withGc deletes superseded versions", async () => {
  let counter = 0;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => `v${++counter}`,
    versionRetention: { keepLatest: 1, accessedWithinDays: 1 },
  });
  // 3 versions of a secret.
  for (let i = 0; i < 3; i++) {
    now = new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    await store.putSecret({ name: "API_TOKEN", value: `v-${i}` });
  }
  const service = new SecretRotationService({
    store,
    clock: () => now,
  });
  now = new Date("2026-04-01T00:00:00.000Z");
  const report = await service.checkRotation({ withGc: true });
  assert.ok(report.gc);
  assert.equal(report.gc!.retained, 1);
  assert.equal(report.gc!.deleted.length, 2);
});

Deno.test("rotateSecret on a missing secret creates the first version", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => "v1",
  });
  const service = new SecretRotationService({
    store,
    clock: () => now,
    defaultPolicy: { intervalDays: 60, gracePeriodDays: 14 },
  });
  const result = await service.rotateSecret({
    name: "NEW_SECRET",
    newValue: "first",
    cloudPartition: "gcp",
  });
  assert.equal(result.previous, undefined);
  assert.equal(result.current.cloudPartition, "gcp");
  assert.equal(result.current.rotationPolicy?.intervalDays, 60);
});
