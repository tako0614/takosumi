import { expect, test } from "bun:test";
import {
  PortableHostIdempotencyCoordinator,
  PortableHostIdempotencyError,
} from "../../../core/api/portable_host_idempotency.ts";
import { D1PortableHostIdempotencyLedger } from "../../../worker/src/d1_portable_host_idempotency.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const BODY = new TextEncoder().encode('{"kind":"EdgeWorker"}');

test("D1 portable host idempotency survives service reconstruction and replays exact bytes", async () => {
  const db = new SqliteFakeD1();
  const first = new PortableHostIdempotencyCoordinator(
    new D1PortableHostIdempotencyLedger(db),
    { reservationIdFactory: () => "reservation_one" },
  );
  const request = requestFor();
  const reserved = await first.reserve(request);
  expect(reserved.kind).toBe("execute");
  if (reserved.kind !== "execute") throw new Error("expected reservation");

  const response = {
    status: 201,
    statusText: "Created",
    headers: [
      ["content-type", "application/json"],
      ["set-cookie", "first=one"],
      ["set-cookie", "second=two"],
    ] as const,
    body: new Uint8Array([0, 1, 2, 127, 128, 255]),
  };
  await first.storeSuccess(reserved.reservation, response);

  const reconstructed = new PortableHostIdempotencyCoordinator(
    new D1PortableHostIdempotencyLedger(db),
  );
  expect(await reconstructed.lookup(request)).toEqual({
    kind: "replay",
    response,
  });
  expect(await reconstructed.reserve(request)).toEqual({
    kind: "replay",
    response,
  });
});

test("D1 portable host idempotency preserves exact-scope conflict and compare-and-delete semantics", async () => {
  const db = new SqliteFakeD1();
  const coordinator = new PortableHostIdempotencyCoordinator(
    new D1PortableHostIdempotencyLedger(db),
    { reservationIdFactory: () => "reservation_one" },
  );
  const reserved = await coordinator.reserve(requestFor());
  if (reserved.kind !== "execute") throw new Error("expected reservation");

  await expect(
    coordinator.reserve(
      requestFor({
        body: new TextEncoder().encode('{"kind":"ObjectBucket"}'),
      }),
    ),
  ).rejects.toBeInstanceOf(PortableHostIdempotencyError);
  await expect(
    coordinator.release({
      ...reserved.reservation,
      reservationId: "substituted",
    }),
  ).rejects.toMatchObject({ code: "reservation_conflict" });
  expect((await coordinator.lookup(requestFor())).kind).toBe("in_progress");

  expect(await coordinator.release(reserved.reservation)).toEqual({
    kind: "released",
  });
  expect((await coordinator.lookup(requestFor())).kind).toBe("miss");
});

function requestFor(
  overrides: Partial<{
    readonly body: Uint8Array;
    readonly idempotencyKey: string;
  }> = {},
) {
  return {
    actor: {
      actorAccountId: "account_one",
      workspaceId: "workspace_one",
      roles: [],
      requestId: "request_one",
    },
    space: "workspace_one",
    idempotencyKey: "portable-request-one",
    method: "PUT",
    requestTarget:
      "/apis/forms.takoform.com/v1alpha1/resources/EdgeWorker/yurucommu",
    ifNoneMatch: "*",
    body: BODY,
    ...overrides,
  };
}
