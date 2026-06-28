/**
 * OutputSharesService unit tests (Core Specification §18).
 *
 * Covers the structural invariants the service enforces: producer belongs to
 * fromSpace, consumer Space exists, from != to, non-empty outputs, every name
 * present in the producer's latest OutputSnapshot.spaceOutputs, sensitive
 * sharing requiring explicit policy, duplicate names rejected; plus the
 * pending -> active lifecycle, the listForSpace union (granted + received), and
 * revoke (idempotent + 404).
 */

import { expect, test } from "bun:test";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import {
  type CreateOutputShareRequest,
  OutputSharesService,
  type SensitiveOutputResolver,
} from "../../../../core/domains/output-shares/mod.ts";
import type { ActivityRecorder, RecordActivityInput } from "../../../../core/domains/activity/mod.ts";

const TS = "2026-06-06T00:00:00.000Z";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sensitiveResolver(
  values: Record<string, unknown> = { admin_token: "super-secret-token" },
): SensitiveOutputResolver {
  return {
    resolve: (input) => {
      const value = values[input.outputName];
      if (value === undefined) return Promise.resolve(undefined);
      return Promise.resolve({ value: value as never, sensitive: true });
    },
  };
}

function service(
  store: OpenTofuDeploymentStore,
  options: {
    readonly sensitiveOutputResolver?: SensitiveOutputResolver;
    readonly activity?: ActivityRecorder;
  } = {},
): OutputSharesService {
  return new OutputSharesService({
    store,
    newId: deterministicIds(),
    now: () => TS,
    ...(options.sensitiveOutputResolver
      ? { sensitiveOutputResolver: options.sensitiveOutputResolver }
      : {}),
    ...(options.activity ? { activity: options.activity } : {}),
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

test("createShare persists a PENDING cross-Space grant", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const share = await svc.createShare(baseRequest());

  expect(share.id).toEqual("oshare_0001");
  expect(share.fromSpaceId).toEqual("space_from");
  expect(share.toSpaceId).toEqual("space_to");
  expect(share.producerInstallationId).toEqual("inst_producer");
  expect(share.status).toEqual("pending");
  expect(share.outputs).toEqual([{ name: "bucket_name", sensitive: false }]);
  expect(share.acceptedAt).toBeUndefined();
  expect(share.revokedAt).toBeUndefined();

  const persisted = await store.getOutputShare("oshare_0001");
  expect(persisted?.status).toEqual("pending");
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

test("createShare rejects a sensitive entry without explicit policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  await expect(
    svc.createShare(
      baseRequest({ outputs: [{ name: "bucket_name", sensitive: true }] }),
    ),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createShare rejects a sensitive entry without a resolver even with policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store, { spaceOutputs: { bucket_name: "my-bucket" } });
  const svc = service(store);

  await expect(
    svc.createShare(
      baseRequest({
        outputs: [{ name: "admin_token", sensitive: true }],
        sensitivePolicy: { allow: true, reason: "approved by both spaces" },
      }),
    ),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createShare records a sensitive entry only with explicit policy and resolver", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store, { spaceOutputs: { bucket_name: "my-bucket" } });
  const svc = service(store, { sensitiveOutputResolver: sensitiveResolver() });

  const share = await svc.createShare(
    baseRequest({
      outputs: [{ name: "admin_token", sensitive: true }],
      sensitivePolicy: { allow: true, reason: "approved by both spaces" },
    }),
  );

  expect(share.status).toEqual("pending");
  expect(share.outputs).toEqual([{ name: "admin_token", sensitive: true }]);
});

test("createShare requires a reason for sensitive output policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store, { sensitiveOutputResolver: sensitiveResolver() });

  await expect(
    svc.createShare(
      baseRequest({
        outputs: [{ name: "admin_token", sensitive: true }],
        sensitivePolicy: { allow: true },
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createShare rejects a sensitive name absent from raw resolver", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store, {
    sensitiveOutputResolver: sensitiveResolver({ other_token: "secret" }),
  });

  await expect(
    svc.createShare(
      baseRequest({
        outputs: [{ name: "admin_token", sensitive: true }],
        sensitivePolicy: { allow: true, reason: "approved by both spaces" },
      }),
    ),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createShare activity records names only for sensitive outputs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const events: RecordActivityInput[] = [];
  const svc = service(store, {
    sensitiveOutputResolver: sensitiveResolver(),
    activity: {
      record: (event) => {
        events.push(event);
        return Promise.resolve(undefined);
      },
    },
  });

  await svc.createShare(
    baseRequest({
      outputs: [{ name: "admin_token", sensitive: true }],
      sensitivePolicy: { allow: true, reason: "super-secret-token approved" },
    }),
  );

  const serialized = JSON.stringify(events);
  expect(serialized).toContain("admin_token");
  expect(serialized).not.toContain("super-secret-token");
});

test("createShare never persists the sensitive value in the at-rest output_shares record", async () => {
  // Audit guard (medium / security): a cross-Space sensitive OutputShare must
  // not leave its plaintext value at rest. The service resolves the sensitive
  // value ONLY to verify presence; the persisted OutputShare record (the
  // `output_shares.record_json` payload) and the listed grants must carry
  // names / aliases / flags only. This locks the redaction invariant for the
  // OutputShare ledger row specifically (the producer's raw value stays in the
  // encrypted raw-output artifact, never copied into the grant).
  const SENSITIVE = "super-secret-token-value-do-not-leak";
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store, { spaceOutputs: { bucket_name: "my-bucket" } });
  const svc = service(store, {
    sensitiveOutputResolver: sensitiveResolver({ admin_token: SENSITIVE }),
  });

  const share = await svc.createShare(
    baseRequest({
      outputs: [{ name: "admin_token", alias: "token", sensitive: true }],
      sensitivePolicy: { allow: true, reason: "approved by both spaces" },
    }),
  );

  // The returned grant carries only the name / alias / sensitive flag.
  expect(share.outputs).toEqual([
    { name: "admin_token", alias: "token", sensitive: true },
  ]);

  // The AT-REST record (what the D1 store serializes into output_shares
  // record_json) must not contain the resolved sensitive value anywhere.
  const persisted = await store.getOutputShare(share.id);
  expect(persisted).toBeDefined();
  expect(JSON.stringify(persisted)).not.toContain(SENSITIVE);

  // Structural guarantee (not just a substring scan): each persisted entry
  // carries ONLY name / alias / sensitive / optional type — there is no
  // value-bearing key on the grant for a secret to hide in. This is WHY the
  // output_shares row needs no separate at-rest encryption (names-only), and
  // why the real sealing obligation lives on the dependency_snapshots path.
  for (const entry of persisted!.outputs) {
    expect(Object.keys(entry).sort()).toEqual(["name", "alias", "sensitive"].sort());
    expect("value" in entry).toBe(false);
  }

  // Neither does the list projection consumed by the dashboard / API.
  const listed = await svc.listForSpace("space_from");
  expect(JSON.stringify(listed)).not.toContain(SENSITIVE);
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

test("approveShare moves pending -> active and stamps acceptedAt", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const share = await svc.createShare(baseRequest());
  const active = await svc.approveShare(share.id);
  expect(active.status).toEqual("active");
  expect(active.acceptedAt).toEqual(TS);

  const again = await svc.approveShare(share.id);
  expect(again.status).toEqual("active");
  expect((await store.getOutputShare(share.id))?.acceptedAt).toEqual(TS);
});

test("approveShare rejects revoked and missing shares", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const share = await svc.createShare(baseRequest());
  const revoked = await svc.revokeShare(share.id);
  expect(revoked.status).toEqual("revoked");
  await expect(svc.approveShare(share.id)).rejects.toMatchObject({
    code: "failed_precondition",
  });
  await expect(svc.approveShare("oshare_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("revokeShare moves pending or active -> revoked and stamps revokedAt", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedProducerWithOutputs(store);
  const svc = service(store);

  const pending = await svc.createShare(baseRequest());
  const revokedPending = await svc.revokeShare(pending.id);
  expect(revokedPending.status).toEqual("revoked");
  expect(revokedPending.revokedAt).toEqual(TS);

  const activeShare = await svc.createShare(baseRequest({ outputs: [{ name: "region" }] }));
  await svc.approveShare(activeShare.id);
  const revoked = await svc.revokeShare(activeShare.id);
  expect(revoked.status).toEqual("revoked");
  expect(revoked.revokedAt).toEqual(TS);

  // Idempotent: revoking again returns the already-revoked share unchanged.
  const again = await svc.revokeShare(activeShare.id);
  expect(again.status).toEqual("revoked");
  expect((await store.getOutputShare(activeShare.id))?.status).toEqual("revoked");
});

test("revokeShare on a missing share is not_found", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const svc = service(store);
  await expect(svc.revokeShare("oshare_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});
