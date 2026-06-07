/**
 * OutputSharesService unit tests (Core Specification §18).
 *
 * Covers the structural invariants the service enforces: producer belongs to
 * fromSpace, consumer Space exists, from != to, non-empty outputs, every name
 * present in the producer's latest OutputSnapshot.spaceOutputs, sensitive
 * sharing rejected, duplicate names rejected; plus the ACTIVE-on-create status,
 * the listForSpace union (granted + received), and revoke (idempotent + 404).
 */

import { expect, test } from "bun:test";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
import {
  type CreateOutputShareRequest,
  OutputSharesService,
} from "./mod.ts";

const TS = "2026-06-06T00:00:00.000Z";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function service(store: OpenTofuDeploymentStore): OutputSharesService {
  return new OutputSharesService({
    store,
    newId: deterministicIds(),
    now: () => TS,
  });
}

/**
 * Seeds a producer Installation in `fromSpace`, a consumer Space `toSpace`, and
 * a latest OutputSnapshot projecting `spaceOutputs`. Returns the producer id.
 */
async function seedProducerWithOutputs(
  store: OpenTofuDeploymentStore,
  options: {
    fromSpaceId?: string;
    toSpaceId?: string;
    spaceOutputs?: Record<string, unknown>;
    withSnapshot?: boolean;
  } = {},
): Promise<string> {
  const fromSpaceId = options.fromSpaceId ?? "space_from";
  const toSpaceId = options.toSpaceId ?? "space_to";
  await seedInstallationModel(store, {
    spaceId: fromSpaceId,
    sourceId: "src_producer",
    installConfigId: "cfg_producer",
    installationId: "inst_producer",
    name: "producer",
  });
  // Seed the consumer Space (seedInstallationModel only seeded the from Space).
  await store.putSpace({
    id: toSpaceId,
    handle: toSpaceId.replace(/_/g, "-"),
    displayName: "Consumer Space",
    type: "personal",
    ownerUserId: "user_to",
    createdAt: TS,
    updatedAt: TS,
  });
  if (options.withSnapshot !== false) {
    const snapshot: OutputSnapshot = {
      id: "out_1",
      spaceId: fromSpaceId,
      installationId: "inst_producer",
      stateGeneration: 1,
      rawOutputArtifactKey:
        "spaces/space_from/installations/inst_producer/runs/r1/outputs.raw.json.enc",
      publicOutputs: {},
      spaceOutputs: options.spaceOutputs ??
        { bucket_name: "my-bucket", region: "auto" },
      outputDigest: "sha256:out1",
      createdAt: TS,
    };
    await store.putOutputSnapshot(snapshot);
  }
  return "inst_producer";
}

function baseRequest(
  over: Partial<CreateOutputShareRequest> = {},
): CreateOutputShareRequest {
  return {
    fromSpaceId: "space_from",
    toSpaceId: "space_to",
    producerInstallationId: "inst_producer",
    outputs: [{ name: "bucket_name" }],
    ...over,
  };
}

test("createShare persists an ACTIVE cross-Space grant", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const share = await svc.createShare(baseRequest());

  expect(share.id).toEqual("oshare_0001");
  expect(share.fromSpaceId).toEqual("space_from");
  expect(share.toSpaceId).toEqual("space_to");
  expect(share.producerInstallationId).toEqual("inst_producer");
  expect(share.status).toEqual("active");
  expect(share.outputs).toEqual([{ name: "bucket_name", sensitive: false }]);
  expect(share.revokedAt).toBeUndefined();

  const persisted = await store.getOutputShare("oshare_0001");
  expect(persisted?.status).toEqual("active");
});

test("createShare carries an alias and forces sensitive false", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const share = await svc.createShare(
    baseRequest({ outputs: [{ name: "bucket_name", alias: "bucket" }] }),
  );
  expect(share.outputs).toEqual([
    { name: "bucket_name", alias: "bucket", sensitive: false },
  ]);
});

test("createShare rejects a same-Space grant invalid_argument", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(baseRequest({ toSpaceId: "space_from" })),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createShare rejects an empty outputs list invalid_argument", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(baseRequest({ outputs: [] })),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createShare rejects a sensitive entry not_implemented", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(
      baseRequest({ outputs: [{ name: "bucket_name", sensitive: true }] }),
    ),
  ).rejects.toMatchObject({ code: "not_implemented" });
});

test("createShare rejects duplicate names invalid_argument", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(
      baseRequest({ outputs: [{ name: "bucket_name" }, { name: "bucket_name" }] }),
    ),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createShare rejects a missing producer not_found", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(baseRequest({ producerInstallationId: "inst_missing" })),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("createShare rejects a producer in another Space failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  // Producer belongs to space_from; claim it under space_other.
  await expect(
    svc.createShare(baseRequest({ fromSpaceId: "space_other" })),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createShare rejects a missing consumer Space not_found", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(baseRequest({ toSpaceId: "space_nope" })),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("createShare rejects a name absent from latest spaceOutputs failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store, { spaceOutputs: { region: "auto" } });
  const svc = service(store);

  await expect(
    svc.createShare(baseRequest({ outputs: [{ name: "bucket_name" }] })),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createShare with NO output snapshot rejects every name failed_precondition", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store, { withSnapshot: false });
  const svc = service(store);

  await expect(
    svc.createShare(baseRequest()),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createShare surfaces OpenTofuControllerError instances", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);
  await expect(
    svc.createShare(baseRequest({ toSpaceId: "space_from" })),
  ).rejects.toBeInstanceOf(OpenTofuControllerError);
});

test("listForSpace unions granted + received, de-duped, oldest-first", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  // space_from grants to space_to.
  const granted = await svc.createShare(baseRequest());

  // Seed a second producer in space_to that grants BACK to space_from, so
  // space_from is both a granter and a receiver.
  await seedInstallationModel(store, {
    spaceId: "space_to",
    sourceId: "src_p2",
    installConfigId: "cfg_p2",
    installationId: "inst_producer2",
    name: "producer2",
  });
  await store.putOutputSnapshot({
    id: "out_2",
    spaceId: "space_to",
    installationId: "inst_producer2",
    stateGeneration: 1,
    rawOutputArtifactKey: "k",
    publicOutputs: {},
    spaceOutputs: { endpoint: "https://x" },
    outputDigest: "sha256:o2",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const received = await svc.createShare({
    fromSpaceId: "space_to",
    toSpaceId: "space_from",
    producerInstallationId: "inst_producer2",
    outputs: [{ name: "endpoint" }],
  });

  const forFrom = await svc.listForSpace("space_from");
  expect(forFrom.map((s) => s.id)).toEqual([granted.id, received.id]);

  // The consumer (space_to) sees both too (received `granted`, granted `received`).
  const forTo = await svc.listForSpace("space_to");
  expect(forTo.map((s) => s.id).sort()).toEqual(
    [granted.id, received.id].sort(),
  );
});

test("revokeShare moves ACTIVE -> revoked and stamps revokedAt", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const share = await svc.createShare(baseRequest());
  const revoked = await svc.revokeShare(share.id);
  expect(revoked.status).toEqual("revoked");
  expect(revoked.revokedAt).toEqual(TS);

  // Idempotent: revoking again returns the already-revoked share unchanged.
  const again = await svc.revokeShare(share.id);
  expect(again.status).toEqual("revoked");
  expect((await store.getOutputShare(share.id))?.status).toEqual("revoked");
});

test("revokeShare on a missing share is not_found", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const svc = service(store);
  await expect(svc.revokeShare("oshare_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});
