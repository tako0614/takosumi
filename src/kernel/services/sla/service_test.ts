import assert from "node:assert/strict";
import { MemoryNotificationSink } from "../../adapters/notification/mod.ts";
import { InMemoryOutboxStore } from "../../shared/events.ts";
import { InMemoryObservabilitySink } from "../observability/mod.ts";
import {
  InMemorySlaObservationStateStore,
  SlaBreachDetectionService,
  slaObservationStateKey,
} from "./mod.ts";
import type { SlaThreshold } from "./mod.ts";

const latencyThreshold: SlaThreshold = {
  id: "sla-threshold:latency-p95",
  dimension: "apply-latency-p95",
  comparator: "gt",
  value: 5,
  scope: "space",
  targetId: "space:one",
  windowSeconds: 300,
  breachConsecutiveWindows: 2,
  recoveryConsecutiveWindows: 2,
};

Deno.test("SLA detection emits no event when no threshold matches", async () => {
  const service = new SlaBreachDetectionService();

  const result = await service.observe({
    dimension: "apply-latency-p95",
    observation: 9,
    spaceId: "space:one",
    observedAt: "2026-05-07T00:00:00.000Z",
  });

  assert.equal(result.evaluations.length, 0);
  assert.equal(result.events.length, 0);
});

Deno.test(
  "SLA detection publishes warning, breach, recovering, and recovered events",
  async () => {
    const states = new InMemorySlaObservationStateStore();
    const observability = new InMemoryObservabilitySink();
    const outbox = new InMemoryOutboxStore();
    const notifications = new MemoryNotificationSink({
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      idGenerator: () => "notice-1",
    });
    const service = new SlaBreachDetectionService({
      thresholds: [latencyThreshold],
      states,
      observability,
      outbox,
      notifications,
    });

    const warning = await service.observe({
      dimension: "apply-latency-p95",
      observation: 6,
      spaceId: "space:one",
      observedAt: "2026-05-07T00:00:00.000Z",
      windowStart: "2026-05-06T23:55:00.000Z",
      windowEnd: "2026-05-07T00:00:00.000Z",
    });
    assert.deepEqual(
      warning.events.map((event) => event.type),
      ["sla-warning-raised"],
    );
    assert.equal(warning.evaluations[0].state.state, "warning");

    const breach = await service.observe({
      dimension: "apply-latency-p95",
      observation: 7,
      spaceId: "space:one",
      observedAt: "2026-05-07T00:01:00.000Z",
    });
    assert.deepEqual(
      breach.events.map((event) => event.type),
      ["sla-breach-detected"],
    );
    assert.equal(breach.evaluations[0].state.state, "breached");
    assert.equal(breach.events[0].payload.previousState, "warning");

    const recovering = await service.observe({
      dimension: "apply-latency-p95",
      observation: 2,
      spaceId: "space:one",
      observedAt: "2026-05-07T00:02:00.000Z",
    });
    assert.deepEqual(
      recovering.events.map((event) => event.type),
      ["sla-recovering"],
    );
    assert.equal(recovering.evaluations[0].state.state, "recovering");

    const recovered = await service.observe({
      dimension: "apply-latency-p95",
      observation: 1,
      spaceId: "space:one",
      observedAt: "2026-05-07T00:03:00.000Z",
    });
    assert.deepEqual(
      recovered.events.map((event) => event.type),
      ["sla-recovered"],
    );
    assert.equal(recovered.evaluations[0].state.state, "ok");
    assert.equal(recovered.events[0].payload.breachDurationSeconds, 120);

    const audit = await observability.listAudit();
    assert.deepEqual(
      audit.map((record) => record.event.type),
      [
        "sla-warning-raised",
        "sla-breach-detected",
        "sla-recovering",
        "sla-recovered",
      ],
    );
    assert.equal(audit[1].event.spaceId, "space:one");
    assert.equal(audit[1].event.payload.thresholdId, latencyThreshold.id);

    const notificationsList = await notifications.list();
    assert.equal(notificationsList.length, 1);
    assert.equal(notificationsList[0].type, "sla-breach-detected");
    assert.equal(notificationsList[0].severity, "warning");
    assert.equal(
      notificationsList[0].metadata.thresholdId,
      latencyThreshold.id,
    );

    const pending = await outbox.listPending();
    assert.deepEqual(
      pending.map((event) => event.type),
      [
        "sla-warning-raised",
        "sla-breach-detected",
        "sla-recovering",
        "sla-recovered",
      ],
    );
  },
);

Deno.test(
  "SLA detection keeps wildcard space thresholds independent by target",
  async () => {
    const threshold: SlaThreshold = {
      ...latencyThreshold,
      id: "sla-threshold:latency-any-space",
      targetId: undefined,
      breachConsecutiveWindows: 1,
    };
    const states = new InMemorySlaObservationStateStore();
    const service = new SlaBreachDetectionService({
      thresholds: [threshold],
      states,
    });

    const one = await service.observe({
      dimension: "apply-latency-p95",
      observation: 6,
      spaceId: "space:one",
      observedAt: "2026-05-07T00:00:00.000Z",
    });
    const two = await service.observe({
      dimension: "apply-latency-p95",
      observation: 1,
      spaceId: "space:two",
      observedAt: "2026-05-07T00:00:30.000Z",
    });

    assert.equal(one.events[0].type, "sla-breach-detected");
    assert.equal(one.evaluations[0].state.targetId, "space:one");
    assert.equal(two.events.length, 0);
    assert.equal(two.evaluations[0].state.state, "ok");

    const stateOne = await states.get(slaObservationStateKey(threshold, {
      scope: "space",
      targetId: "space:one",
    }));
    const stateTwo = await states.get(slaObservationStateKey(threshold, {
      scope: "space",
      targetId: "space:two",
    }));
    assert.equal(stateOne?.state, "breached");
    assert.equal(stateTwo?.state, "ok");
  },
);
