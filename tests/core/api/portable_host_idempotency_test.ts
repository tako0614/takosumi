import { expect, test } from "bun:test";
import type { ActorContext } from "takosumi-contract";
import {
  InMemoryPortableHostIdempotencyLedger,
  PortableHostIdempotencyCoordinator,
  PortableHostIdempotencyError,
  type PortableHostIdempotencyLedger,
  type PortableHostIdempotencyRecord,
  type PortableHostIdempotencyReservedRecord,
  type PortableHostIdempotencySucceededRecord,
} from "../../../core/api/portable_host_idempotency.ts";

const BODY = new TextEncoder().encode('{"kind":"ObjectBucket"}');

test("portable host idempotency fails closed without an authenticated tenant", async () => {
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );

  await expect(
    coordinator.reserve(
      requestFor({
        actor: {
          actorAccountId: "account_one",
          roles: [],
          requestId: "request_one",
        },
      }),
    ),
  ).rejects.toMatchObject({
    name: PortableHostIdempotencyError.name,
    code: "invalid_scope",
  });
});

test("portable host idempotency stores and replays the exact success wire response", async () => {
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
    { reservationIdFactory: () => "reservation_one" },
  );
  const request = requestFor();
  const reserved = await coordinator.reserve(request);
  expect(reserved.kind).toBe("execute");
  if (reserved.kind !== "execute") throw new Error("expected reservation");

  const responseBody = new TextEncoder().encode('{"resourceVersion":"7"}');
  const response = {
    status: 200,
    statusText: "OK",
    headers: [
      ["content-type", "application/json"],
      ["etag", '"7"'],
      ["idempotency-key", "portable-request-one"],
      ["set-cookie", "first=one"],
      ["set-cookie", "second=two"],
    ] as const,
    body: responseBody,
  };
  const stored = await coordinator.storeSuccess(
    reserved.reservation,
    response,
  );
  expect(stored).toEqual(response);

  responseBody.fill(0);
  const lookup = await coordinator.lookup(request);
  expect(lookup).toEqual({
    kind: "replay",
    response: {
      ...response,
      body: new TextEncoder().encode('{"resourceVersion":"7"}'),
    },
  });
  if (lookup.kind !== "replay") throw new Error("expected replay");
  lookup.response.body.fill(1);

  const reservedAgain = await coordinator.reserve(request);
  expect(reservedAgain).toEqual({
    kind: "replay",
    response: {
      ...response,
      body: new TextEncoder().encode('{"resourceVersion":"7"}'),
    },
  });
});

test("portable host idempotency quarantines only an exact malformed success replay", async () => {
  let reservationSequence = 0;
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
    {
      reservationIdFactory: () =>
        `reservation_${(reservationSequence += 1)}`,
    },
  );
  const request = requestFor();
  const first = await coordinator.reserve(request);
  expect(first.kind).toBe("execute");
  if (first.kind !== "execute") throw new Error("expected reservation");

  const malformed = {
    ...successResponse(),
    body: new TextEncoder().encode('{"kind":"EdgeWorker"}'),
  };
  await coordinator.storeSuccess(first.reservation, malformed);

  expect(
    await coordinator.quarantineReplay(
      request,
      malformed,
      (response) => !JSON.parse(new TextDecoder().decode(response.body)).status,
    ),
  ).toEqual({ kind: "quarantined" });
  expect(await coordinator.reserve(request)).toMatchObject({
    kind: "execute",
    reservation: { reservationId: "reservation_2" },
  });

  const validRequest = requestFor({ idempotencyKey: "portable-valid-replay" });
  const valid = await coordinator.reserve(validRequest);
  if (valid.kind !== "execute") throw new Error("expected valid reservation");
  const validResponse = {
    ...successResponse(),
    body: new TextEncoder().encode('{"status":{"observed":{"ready":true}}}'),
  };
  await coordinator.storeSuccess(valid.reservation, validResponse);
  expect(
    await coordinator.quarantineReplay(
      validRequest,
      validResponse,
      (response) => !JSON.parse(new TextDecoder().decode(response.body)).status,
    ),
  ).toEqual({ kind: "valid" });
  expect(await coordinator.reserve(validRequest)).toEqual({
    kind: "replay",
    response: validResponse,
  });
});

test("portable host idempotency rejects request substitution within one scoped key", async () => {
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  expect((await coordinator.reserve(requestFor())).kind).toBe("execute");

  const changedBody = new Uint8Array(BODY);
  changedBody[changedBody.byteLength - 2] ^= 1;
  const substitutions = [
    requestFor({ method: "POST" }),
    requestFor({
      requestTarget:
        "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/other",
    }),
    requestFor({ ifMatch: '"4"' }),
    requestFor({ ifNoneMatch: "" }),
    requestFor({ body: changedBody }),
  ];
  for (const substituted of substitutions) {
    await expect(coordinator.reserve(substituted)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  }
});

test("portable host idempotency isolates the same external key by tenant, principal, and Space", async () => {
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  const base = await coordinator.reserve(requestFor());
  expect(base.kind).toBe("execute");

  const otherTenant = await coordinator.reserve(
    requestFor({ actor: actorFor("workspace_two") }),
  );
  const otherPrincipal = await coordinator.reserve(
    requestFor({ actor: actorFor("workspace_one", "account_two") }),
  );
  const otherSpace = await coordinator.reserve(
    requestFor({ space: "space_two" }),
  );
  expect([
    otherTenant.kind,
    otherPrincipal.kind,
    otherSpace.kind,
  ]).toEqual(["execute", "execute", "execute"]);

  expect((await coordinator.reserve(requestFor())).kind).toBe("in_progress");
});

test("portable host idempotency releases a failed reservation so the exact request can retry", async () => {
  let reservationSequence = 0;
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
    {
      reservationIdFactory: () =>
        `reservation_${(reservationSequence += 1)}`,
    },
  );
  const first = await coordinator.reserve(requestFor());
  expect(first.kind).toBe("execute");
  if (first.kind !== "execute") throw new Error("expected reservation");

  expect(await coordinator.release(first.reservation)).toEqual({
    kind: "released",
  });
  const retry = await coordinator.reserve(requestFor());
  expect(retry).toMatchObject({
    kind: "execute",
    reservation: { reservationId: "reservation_2" },
  });
});

test("portable host idempotency release cannot delete a changed or succeeded reservation", async () => {
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
    { reservationIdFactory: () => "reservation_one" },
  );
  const first = await coordinator.reserve(requestFor());
  expect(first.kind).toBe("execute");
  if (first.kind !== "execute") throw new Error("expected reservation");

  await expect(
    coordinator.release({
      ...first.reservation,
      reservationId: "substituted_reservation",
    }),
  ).rejects.toMatchObject({ code: "reservation_conflict" });
  await expect(
    coordinator.release({
      ...first.reservation,
      fingerprint: {
        ...first.reservation.fingerprint,
        method: "POST",
      },
    }),
  ).rejects.toMatchObject({ code: "reservation_conflict" });
  expect((await coordinator.lookup(requestFor())).kind).toBe("in_progress");

  await coordinator.storeSuccess(first.reservation, successResponse());
  await expect(coordinator.release(first.reservation)).rejects.toMatchObject({
    code: "reservation_conflict",
  });
  expect((await coordinator.lookup(requestFor())).kind).toBe("replay");
});

test("portable host idempotency fails closed on corrupt durable success records", async () => {
  for (const corruptOn of ["reserve", "lookup", "store"] as const) {
    const ledger = new CorruptingSuccessLedger();
    const coordinator = new PortableHostIdempotencyCoordinator(ledger);
    if (corruptOn === "reserve") {
      ledger.corruptOn = corruptOn;
      await expect(coordinator.reserve(requestFor())).rejects.toMatchObject({
        code: "ledger_invariant_violation",
      });
      continue;
    }

    const reserved = await coordinator.reserve(requestFor());
    if (reserved.kind !== "execute") throw new Error("expected reservation");
    ledger.corruptOn = corruptOn;
    const operation =
      corruptOn === "lookup"
        ? coordinator.lookup(requestFor())
        : coordinator.storeSuccess(
            reserved.reservation,
            successResponse(),
          );
    await expect(operation).rejects.toMatchObject({
      code: "ledger_invariant_violation",
    });
  }
});

test("portable host idempotency rejects success headers that HTTP cannot replay", async () => {
  const coordinator = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  const reserved = await coordinator.reserve(requestFor());
  if (reserved.kind !== "execute") throw new Error("expected reservation");

  for (const headers of [
    [["bad header", "value"]],
    [["bad:name", "value"]],
    [["x-bad", "nul\u0000value"]],
  ]) {
    await expect(
      coordinator.storeSuccess(reserved.reservation, {
        ...successResponse(),
        headers,
      }),
    ).rejects.toMatchObject({ code: "invalid_success_response" });
  }

  await coordinator.storeSuccess(reserved.reservation, successResponse());
  expect((await coordinator.lookup(requestFor())).kind).toBe("replay");
});

class CorruptingSuccessLedger implements PortableHostIdempotencyLedger {
  readonly inner = new InMemoryPortableHostIdempotencyLedger();
  corruptOn: "reserve" | "lookup" | "store" | undefined;

  async lookup(scope: Parameters<PortableHostIdempotencyLedger["lookup"]>[0]) {
    const record = await this.inner.lookup(scope);
    return this.corruptOn === "lookup" && record
      ? corruptSuccess(record)
      : record;
  }

  async reserve(candidate: PortableHostIdempotencyReservedRecord) {
    const result = await this.inner.reserve(candidate);
    return this.corruptOn === "reserve"
      ? { kind: "existing" as const, record: corruptSuccess(candidate) }
      : result;
  }

  async storeSuccess(candidate: PortableHostIdempotencySucceededRecord) {
    const result = await this.inner.storeSuccess(candidate);
    return this.corruptOn === "store" && result.kind !== "conflict"
      ? { ...result, record: corruptSuccess(result.record) }
      : result;
  }

  release(
    reservation: Parameters<PortableHostIdempotencyLedger["release"]>[0],
  ) {
    return this.inner.release(reservation);
  }
}

function corruptSuccess(
  record: PortableHostIdempotencyRecord,
): PortableHostIdempotencySucceededRecord {
  return {
    scope: { ...record.scope },
    fingerprint: {
      ...record.fingerprint,
      body: { ...record.fingerprint.body },
    },
    reservationId: record.reservationId,
    state: "succeeded",
    response: {
      status: 500,
      statusText: "Internal Server Error",
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode('{"error":"must not replay"}'),
    },
  };
}

function actorFor(
  workspaceId: string,
  actorAccountId = "account_one",
): ActorContext {
  return {
    actorAccountId,
    workspaceId,
    roles: [],
    requestId: "request_one",
  };
}

function successResponse() {
  return {
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]] as const,
    body: new TextEncoder().encode('{"ok":true}'),
  };
}

function requestFor(
  overrides: Partial<{
    actor: ActorContext;
    space: string;
    idempotencyKey: string;
    method: string;
    requestTarget: string;
    ifMatch: string;
    ifNoneMatch: string;
    body: Uint8Array;
  }> = {},
) {
  return {
    actor: actorFor("workspace_one"),
    space: "space_one",
    idempotencyKey: "portable-request-one",
    method: "PUT",
    requestTarget:
      "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets",
    ifNoneMatch: "*",
    body: BODY,
    ...overrides,
  };
}
