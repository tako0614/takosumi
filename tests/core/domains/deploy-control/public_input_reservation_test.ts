import { expect, test } from "bun:test";

import type {
  ApplyRun,
  Capsule,
  InstallConfig,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import {
  assertCredentialRecipeDriverPublicInputRequest,
  assertCredentialRecipeDriverPublicInputs,
  type CredentialRecipeDriverPublicInputOwner,
} from "takosumi-contract/credential-recipe-host";
import type { JsonValue } from "takosumi-contract";
import type {
  CapsuleProviderBindingMintEntry,
  PublicInputReservationDriverPort,
} from "../../../../core/adapters/vault/mod.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  createPublicInputReservationLifecycle,
  decodePublicInputReservationLifecycle,
  publicInputReservationCleanupProjection,
  publicEndpointPreflightProjection,
  publicInputClientIdempotencyKey,
  PublicInputReservationService,
  type PreparedPublicInputReservation,
  type PublicInputReservationApplyGuard,
  type PublicInputReservationLifecycle,
  type PublicInputReservationReceipt,
} from "../../../../core/domains/deploy-control/public_input_reservation.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const WORKSPACE_ID = "workspace_endpoint";
const CAPSULE_ID = "capsule_endpoint";
const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const OWNER: CredentialRecipeDriverPublicInputOwner = Object.freeze({
  providerSource: PROVIDER_SOURCE,
  connectionId: "conn_endpointOwner01",
  recipeId: "takoserver-endpoint",
  authMode: "broker",
  runCredentialSettings: Object.freeze({ requiredAvailableMinor: 2400 }),
});
const BINDINGS: readonly CapsuleProviderBindingMintEntry[] = Object.freeze([
  Object.freeze({
    provider: PROVIDER_SOURCE,
    connectionId: OWNER.connectionId,
    runCredentialSettings: OWNER.runCredentialSettings,
  }),
]);

function installConfig(overrides: Partial<InstallConfig> = {}): InstallConfig {
  return {
    id: "config_endpoint",
    workspaceId: WORKSPACE_ID,
    name: "Endpoint app",
    sourceSelector: { url: "https://example.test/app.git", path: "." },
    modulePath: ".",
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snapshot_endpoint_v1",
      repositoryInstallUxDigest: `sha256:${"e".repeat(64)}`,
      repositoryManifestApiVersion: "takosumi.com/v2.4",
      repositoryHttpEndpointUrlVariable: "app_url",
      repositoryHttpEndpointSubdomainVariable: "project_name",
    },
    installExperience: {
      repositoryInstallUx: { status: "accepted" },
      userVariableNames: ["display_name"],
      projections: [{
        kind: "public_endpoint",
        variables: { url: "app_url", subdomain: "project_name" },
      }],
    },
    variableMapping: {},
    variablePresentation: [{ name: "display_name", label: "Display name" }],
    outputAllowlist: {},
    policy: { allowedProviders: ["*"] },
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function endpointAbsentConfig(id = "config_without_endpoint"): InstallConfig {
  return installConfig({
    id,
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snapshot_without_endpoint",
      repositoryInstallUxDigest: `sha256:${"d".repeat(64)}`,
      repositoryManifestApiVersion: "takosumi.com/v2.4",
    },
    installExperience: {
      repositoryInstallUx: { status: "accepted" },
      userVariableNames: ["display_name"],
      projections: [],
    },
  });
}

function capsule(installConfigId = "config_endpoint"): Capsule {
  return {
    id: CAPSULE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: "project_endpoint",
    name: "Endpoint app",
    slug: "endpoint-app",
    sourceId: "source_endpoint",
    installConfigId,
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function planRun(overrides: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_endpoint",
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    capsuleExecutionAuthorityEpoch: 1,
    source: {
      kind: "git",
      url: "https://example.test/app.git",
      ref: "main",
      modulePath: ".",
    },
    sourceSnapshotId: "snapshot_endpoint_v1",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    operation: "create",
    runnerProfileId: "opentofu-default",
    capsuleContext: {
      workspaceId: WORKSPACE_ID,
      capsuleId: CAPSULE_ID,
      environment: "production",
    },
    variablesDigest: `sha256:${"b".repeat(64)}`,
    requiredProviders: [PROVIDER_SOURCE],
    status: "running",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: `sha256:${"c".repeat(64)}`,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function applyRun(id: string, status: ApplyRun["status"]): ApplyRun {
  return {
    id,
    planRunId: "plan_endpoint",
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status,
    expected: {
      planRunId: "plan_endpoint",
      capsuleId: CAPSULE_ID,
      runnerProfileId: "opentofu-default",
      sourceDigest: `sha256:${"a".repeat(64)}`,
      variablesDigest: `sha256:${"b".repeat(64)}`,
      policyDecisionDigest: `sha256:${"c".repeat(64)}`,
      planDigest: `sha256:${"d".repeat(64)}`,
      planArtifactDigest: `sha256:${"d".repeat(64)}`,
    },
    stateBackend: { kind: "managed", ref: "state" },
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 100,
    finishedAt: 100,
  };
}

const BASE_VARIABLES: Readonly<Record<string, JsonValue>> = Object.freeze({
  display_name: "Young Tree",
  project_name: "young-tree",
});

function reservationNonce(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

async function retiredReceipt(
  base: PublicInputReservationReceipt,
  sequence: number,
): Promise<PublicInputReservationReceipt> {
  const reservationLifecycleNonce = reservationNonce(1_000 + sequence);
  const requestedSubdomain = `retired-${sequence}`;
  const { digest: _digest, ...baseCore } = base;
  void _digest;
  const core = {
    ...baseCore,
    reservationLifecycleNonce,
    clientIdempotencyKey: await publicInputClientIdempotencyKey({
      capsuleId: base.capsuleId,
      targetVariable: base.targetVariable,
      subdomainVariable: base.subdomainVariable,
      requestedSubdomain,
      reservationLifecycleNonce,
    }),
    requestedSubdomain,
    reservationRef: `reservation/provider-owned/retired-${sequence}`,
    httpEndpointUrl: `https://retired-${sequence}.example.test`,
  } as const;
  return {
    ...core,
    digest: await stableJsonDigest(core),
  };
}

class RecordingDriver implements PublicInputReservationDriverPort {
  readonly calls: Array<{
    readonly kind: "select" | "resolve" | "release";
    readonly request?: unknown;
  }> = [];
  endpoint = "https://young-tree.example.test";
  reservationRef = "reservation/provider-owned/young-tree";
  readonly reservationUrls = new Map<string, string>();
  failNextResolve = false;
  failSelect = false;
  blockResolve?: Promise<void>;
  beforeResolve?: () => Promise<void>;

  selectPublicInputReservationOwner(
    _workspaceId: string,
    _entries: readonly CapsuleProviderBindingMintEntry[],
  ): Promise<CredentialRecipeDriverPublicInputOwner> {
    this.calls.push({ kind: "select" });
    if (this.failSelect) {
      throw new Error("stored owner is no longer present in current bindings");
    }
    return Promise.resolve(OWNER);
  }

  async resolvePublicInputReservation(
    _workspaceId: string,
    _owner: CredentialRecipeDriverPublicInputOwner,
    request: unknown,
  ) {
    this.calls.push({ kind: "resolve", request });
    await this.beforeResolve?.();
    await this.blockResolve;
    if (this.failNextResolve) {
      this.failNextResolve = false;
      throw new Error("simulated provider acknowledgement loss");
    }
    const exact = assertCredentialRecipeDriverPublicInputRequest(request);
    const requestedRef = exact.httpEndpointUrl.reservationRef;
    if (!requestedRef) {
      this.reservationUrls.set(this.reservationRef, this.endpoint);
    }
    const reservationRef = requestedRef ?? this.reservationRef;
    return {
      httpEndpointUrl: reservationRef === this.reservationRef
        ? this.endpoint
        : this.reservationUrls.get(reservationRef) ?? this.endpoint,
      reservationRef,
    };
  }

  releasePublicInputReservation(
    _workspaceId: string,
    _owner: CredentialRecipeDriverPublicInputOwner,
    request: unknown,
  ) {
    this.calls.push({ kind: "release", request });
    const exact = assertCredentialRecipeDriverPublicInputRequest(request, {
      requireReservationRef: true,
    });
    return Promise.resolve({
      status: "released" as const,
      reservationRef: exact.httpEndpointUrl.reservationRef!,
    });
  }
}

async function seededService(driver = new RecordingDriver()) {
  const store = new InMemoryOpenTofuControlStore();
  const config = installConfig();
  await store.putInstallConfig(config);
  await store.putCapsule(capsule(config.id));
  let nonceCalls = 0;
  let now = 100;
  return {
    store,
    driver,
    get nonceCalls() {
      return nonceCalls;
    },
    setNow(value: number) {
      now = value;
    },
    service: new PublicInputReservationService({
      store,
      driver,
      now: () => now,
      newReservationLifecycleNonce: () => reservationNonce(++nonceCalls),
    }),
  };
}

async function resetToUnboundLegacyIntent(
  seeded: Awaited<ReturnType<typeof seededService>>,
): Promise<PublicInputReservationLifecycle> {
  seeded.driver.failNextResolve = true;
  await expect(seeded.service.preparePlan({
    planRun: planRun({ id: "plan_legacy_writer" }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("trusted provider reservation read failed");
  const written = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  const intent = written?.candidate?.reservation;
  if (!written || intent?.kind !== "takosumi.public-input-reservation-intent@v1") {
    throw new Error("expected durable v1 intent fixture");
  }
  expect(await seeded.store.deleteCapsulePublicInputReservationRecord({
    capsuleId: CAPSULE_ID,
    expectedRecordDigest: written.digest,
  })).toBe(true);
  const legacy = await decodePublicInputReservationLifecycle(intent);
  expect(await seeded.store.adoptCapsulePublicInputReservationRecord({
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    installConfigId: "config_endpoint",
    capsuleExecutionAuthorityEpoch: 1,
    record: legacy,
  })).toMatchObject({ status: "stored" });
  seeded.driver.calls.length = 0;
  return legacy;
}

function countLifecycleWrites(store: InMemoryOpenTofuControlStore): () => number {
  let writes = 0;
  const adopt = store.adoptCapsulePublicInputReservationRecord.bind(store);
  store.adoptCapsulePublicInputReservationRecord = async (input) => {
    writes += 1;
    return await adopt(input);
  };
  const replace = store.replaceCapsulePublicInputReservationRecord.bind(store);
  store.replaceCapsulePublicInputReservationRecord = async (input) => {
    writes += 1;
    return await replace(input);
  };
  const settle = store.settleCapsulePublicInputReservationLifecycle.bind(store);
  store.settleCapsulePublicInputReservationLifecycle = async (input) => {
    writes += 1;
    return await settle(input);
  };
  const remove = store.deleteCapsulePublicInputReservationRecord.bind(store);
  store.deleteCapsulePublicInputReservationRecord = async (input) => {
    writes += 1;
    return await remove(input);
  };
  return () => writes;
}

async function guardFor(
  service: PublicInputReservationService,
  prepared: PreparedPublicInputReservation,
  run: PlanRun,
): Promise<PublicInputReservationApplyGuard> {
  const guard = await service.revalidate({
    planRun: run,
    providerBindings: BINDINGS,
    variables: prepared.variables,
    expected: prepared.decision,
  });
  if (!guard) throw new Error("expected reservation guard");
  return guard;
}

async function settleTransition(
  store: InMemoryOpenTofuControlStore,
  transition: Awaited<
    ReturnType<PublicInputReservationService["transitionForApply"]>
  >,
): Promise<PublicInputReservationLifecycle> {
  if (!transition?.lifecycle) throw new Error("expected lifecycle transition");
  expect(await store.settleCapsulePublicInputReservationLifecycle({
    capsuleId: transition.capsuleId,
    expectedRecordDigest: transition.expectedLifecycleDigest,
    record: transition.lifecycle,
  })).toBe(true);
  return transition.lifecycle;
}

async function promotePrepared(input: {
  readonly store: InMemoryOpenTofuControlStore;
  readonly service: PublicInputReservationService;
  readonly prepared: PreparedPublicInputReservation;
  readonly run: PlanRun;
  readonly applyRunId?: string;
}): Promise<PublicInputReservationLifecycle> {
  return await settleTransition(
    input.store,
    await input.service.transitionForApply({
      guard: await guardFor(input.service, input.prepared, input.run),
      outcome: "applied",
      cleanupRunId: input.applyRunId ?? "apply_endpoint",
      now: 100,
    }),
  );
}

test("trusted recipe public inputs and requests reject arbitrary keys", () => {
  expect(assertCredentialRecipeDriverPublicInputs({
    httpEndpointUrl: "https://young-tree.example.test",
    reservationRef: "opaque/provider/ref",
  })).toEqual({
    httpEndpointUrl: "https://young-tree.example.test",
    reservationRef: "opaque/provider/ref",
  });
  expect(() => assertCredentialRecipeDriverPublicInputs({
    httpEndpointUrl: "https://young-tree.example.test",
    reservationRef: "opaque/provider/ref",
    TF_VAR_app_url: "https://attacker.example.test",
  } as never)).toThrow("unknown fields");
  expect(() => assertCredentialRecipeDriverPublicInputRequest({
    httpEndpointUrl: {
      clientIdempotencyKey: `endpoint_request_${"a".repeat(64)}`,
      requestedSubdomain: "young-tree",
      workerName: "guessed-worker",
    },
  } as never)).toThrow("unknown fields");
});

test("intent is durable before provider effect and only the compiled URL target is overlaid", async () => {
  const { store, driver, service } = await seededService();
  let observedBeforeEffect: PublicInputReservationLifecycle | undefined;
  driver.beforeResolve = async () => {
    observedBeforeEffect = await store.getCapsulePublicInputReservationRecord(
      CAPSULE_ID,
    );
  };
  const prepared = await service.preparePlan({
    planRun: planRun(),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(observedBeforeEffect?.candidate?.reservation?.kind).toBe(
    "takosumi.public-input-reservation-intent@v1",
  );
  expect(prepared.variables).toEqual({
    ...BASE_VARIABLES,
    app_url: "https://young-tree.example.test",
  });
  expect(prepared.decision?.receipt).toMatchObject({
    reservationRef: "reservation/provider-owned/young-tree",
    targetVariable: "app_url",
    subdomainVariable: "project_name",
    requestedSubdomain: "young-tree",
    sourceSnapshotId: "snapshot_endpoint_v1",
    repositoryInstallUxDigest: `sha256:${"e".repeat(64)}`,
    reservationLifecycleNonce: reservationNonce(1),
    owner: OWNER,
  });
  const request = driver.calls.find(({ kind }) => kind === "resolve")?.request;
  expect(request).toEqual({
    httpEndpointUrl: {
      clientIdempotencyKey:
        prepared.decision?.receipt?.clientIdempotencyKey,
      requestedSubdomain: "young-tree",
    },
  });
  expect(JSON.stringify(request)).not.toContain(reservationNonce(1));
  expect(JSON.stringify(prepared)).not.toContain("TF_VAR_");
  expect(JSON.stringify(prepared)).not.toContain("runner_secret");
});

test("ack loss replays one durable key and concurrent adopters cause one provider effect", async () => {
  const seeded = await seededService();
  seeded.driver.failNextResolve = true;
  const run = planRun();
  await expect(seeded.service.preparePlan({
    planRun: run,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("trusted provider reservation read failed");
  const afterLoss = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  expect(afterLoss?.candidate?.reservation?.kind).toBe(
    "takosumi.public-input-reservation-intent@v1",
  );
  expect(afterLoss?.candidate?.effectClaim).toBeUndefined();

  let unblock!: () => void;
  seeded.driver.blockResolve = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const winner = seeded.service.preparePlan({
    planRun: run,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await Promise.resolve();
  await expect(seeded.service.preparePlan({
    planRun: run,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("provider effect is already in progress");
  unblock();
  const prepared = await winner;
  const keys = seeded.driver.calls
    .filter(({ kind }) => kind === "resolve")
    .map(({ request }) =>
      assertCredentialRecipeDriverPublicInputRequest(request)
        .httpEndpointUrl.clientIdempotencyKey
    );
  expect(new Set(keys).size).toBe(1);
  expect(keys).toHaveLength(2);
  expect(prepared.decision?.receipt?.clientIdempotencyKey).toBe(keys[0]);
  expect(seeded.nonceCalls).toBe(1);
});

test("an exact Plan retry adopts a bare v1 intent and replays its provider key", async () => {
  const seeded = await seededService();
  const legacy = await resetToUnboundLegacyIntent(seeded);
  const legacyKey = legacy.candidate?.reservation?.clientIdempotencyKey;
  const retryRun = planRun({ id: "plan_legacy_exact_retry", updatedAt: 200 });

  const prepared = await seeded.service.preparePlan({
    planRun: retryRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });

  expect(prepared.decision?.receipt?.clientIdempotencyKey).toBe(legacyKey);
  expect(seeded.nonceCalls).toBe(1);
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "select",
    "resolve",
  ]);
  const request = assertCredentialRecipeDriverPublicInputRequest(
    seeded.driver.calls[1]?.request,
  );
  expect(request.httpEndpointUrl.clientIdempotencyKey).toBe(legacyKey);
  expect(
    (await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
      ?.candidate?.planRunId,
  ).toBe(retryRun.id);
});

test("an ambiguous bare v1 intent is durably repaired by positive readback before release", async () => {
  const seeded = await seededService();
  const legacy = await resetToUnboundLegacyIntent(seeded);
  const legacyKey = legacy.candidate?.reservation?.clientIdempotencyKey;
  const repairRun = planRun({ id: "plan_legacy_repair", updatedAt: 300 });

  await expect(seeded.service.preparePlan({
    planRun: repairRun,
    providerBindings: BINDINGS,
    variables: { ...BASE_VARIABLES, project_name: "replacement-tree" },
  })).rejects.toThrow("legacy endpoint reservation repair was scheduled");

  const bound = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  expect(bound?.candidate?.planRunId).toBe(repairRun.id);
  expect(publicInputReservationCleanupProjection(bound!)).toEqual({
    runId: repairRun.id,
    enqueuedAt: repairRun.updatedAt,
  });
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual(["select"]);

  await seeded.store.putPlanRun({
    ...repairRun,
    status: "failed",
    finishedAt: 301,
    updatedAt: 301,
  });
  seeded.driver.calls.length = 0;
  seeded.driver.failNextResolve = true;
  await expect(seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: repairRun.id,
  })).rejects.toThrow("trusted provider reservation read failed");
  expect(
    (await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
      ?.candidate?.reservation?.kind,
  ).toBe("takosumi.public-input-reservation-intent@v1");

  await seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: repairRun.id,
  });
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toBeUndefined();
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "resolve",
    "resolve",
    "release",
  ]);
  const readback = assertCredentialRecipeDriverPublicInputRequest(
    seeded.driver.calls[1]?.request,
  );
  const release = assertCredentialRecipeDriverPublicInputRequest(
    seeded.driver.calls[2]?.request,
    { requireReservationRef: true },
  );
  expect(readback.httpEndpointUrl.clientIdempotencyKey).toBe(legacyKey);
  expect(release.httpEndpointUrl.clientIdempotencyKey).toBe(legacyKey);
});

test("an unowned bare v1 intent is bound for repair even when current owner selection fails", async () => {
  const seeded = await seededService();
  await resetToUnboundLegacyIntent(seeded);
  seeded.driver.failSelect = true;
  const repairRun = planRun({ id: "plan_legacy_unowned_repair", updatedAt: 350 });

  await expect(seeded.service.preparePlan({
    planRun: repairRun,
    providerBindings: [],
    variables: BASE_VARIABLES,
  })).rejects.toThrow("legacy endpoint reservation repair was scheduled");
  expect(
    (await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
      ?.candidate?.planRunId,
  ).toBe(repairRun.id);
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual(["select"]);

  await seeded.store.putPlanRun({
    ...repairRun,
    status: "failed",
    finishedAt: 351,
    updatedAt: 351,
  });
  seeded.driver.calls.length = 0;
  await seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: repairRun.id,
  });
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "resolve",
    "release",
  ]);
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toBeUndefined();
});

test("Destroy claims and repairs an unbound v1 intent after current source removal", async () => {
  const seeded = await seededService();
  await resetToUnboundLegacyIntent(seeded);
  await seeded.store.putCapsule(capsule("config_removed_before_destroy"));
  const destroyRun = planRun({
    id: "plan_destroy_legacy_repair",
    operation: "destroy",
    updatedAt: 400,
  });

  await expect(seeded.service.preparePlan({
    planRun: destroyRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("repair was scheduled; retry Destroy after cleanup");
  expect(
    (await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
      ?.candidate?.planRunId,
  ).toBe(destroyRun.id);

  await seeded.store.putPlanRun({
    ...destroyRun,
    status: "failed",
    finishedAt: 401,
    updatedAt: 401,
  });
  await seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: destroyRun.id,
  });
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toBeUndefined();
  await expect(seeded.service.preparePlan({
    planRun: planRun({
      id: "plan_destroy_after_legacy_repair",
      operation: "destroy",
      updatedAt: 500,
    }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).resolves.toEqual({ variables: BASE_VARIABLES });
});

test("intent and receipt CAS retries retain one nonce and one provider effect", async () => {
  const seeded = await seededService();
  const replace = seeded.store.replaceCapsulePublicInputReservationRecord
    .bind(seeded.store);
  let loseIntentCas = true;
  let loseReceiptCas = true;
  seeded.store.replaceCapsulePublicInputReservationRecord = async (input) => {
    const kind = input.record.candidate?.reservation?.kind;
    if (
      (kind === "takosumi.public-input-reservation-intent@v1" &&
        loseIntentCas) ||
      (kind === "takosumi.public-input-reservation-receipt@v1" &&
        loseReceiptCas)
    ) {
      if (kind === "takosumi.public-input-reservation-intent@v1") {
        loseIntentCas = false;
      } else {
        loseReceiptCas = false;
      }
      return {
        status: "record_changed" as const,
        record: await seeded.store.getCapsulePublicInputReservationRecord(
          CAPSULE_ID,
        ),
      };
    }
    return await replace(input);
  };

  const prepared = await seeded.service.preparePlan({
    planRun: planRun({ id: "plan_cas_retry" }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(loseIntentCas).toBe(false);
  expect(loseReceiptCas).toBe(false);
  expect(seeded.nonceCalls).toBe(1);
  expect(seeded.driver.calls.filter(({ kind }) => kind === "resolve"))
    .toHaveLength(1);
  expect(prepared.decision?.receipt?.reservationLifecycleNonce).toBe(
    reservationNonce(1),
  );
});

test("a second Plan cannot adopt or release another applyable candidate", async () => {
  const seeded = await seededService();
  const firstRun = planRun({ id: "plan_candidate_owner" });
  await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const before = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  seeded.driver.calls.length = 0;
  await expect(seeded.service.preparePlan({
    planRun: planRun({ id: "plan_candidate_loser" }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("another Plan still owns a staged endpoint reservation");
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual(["select"]);
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toEqual(before);
  expect(before?.candidate?.planRunId).toBe(firstRun.id);
});

test("A to B Plan stages B without releasing applied A", async () => {
  const seeded = await seededService();
  const firstRun = planRun();
  const first = await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const appliedA = await promotePrepared({
    ...seeded,
    prepared: first,
    run: firstRun,
  });
  seeded.driver.calls.length = 0;
  seeded.driver.endpoint = "https://new-tree.example.test";
  seeded.driver.reservationRef = "reservation/provider-owned/new-tree";
  const replacementRun = planRun({ id: "plan_replacement" });
  const replacement = await seeded.service.preparePlan({
    planRun: replacementRun,
    providerBindings: BINDINGS,
    variables: { ...BASE_VARIABLES, project_name: "new-tree" },
  });
  const staged = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "select",
    "resolve",
  ]);
  expect(staged?.applied?.digest).toBe(appliedA.applied?.digest);
  expect(staged?.candidate?.planRunId).toBe(replacementRun.id);
  expect(staged?.candidate?.reservation?.kind).toBe(
    "takosumi.public-input-reservation-receipt@v1",
  );
  expect(replacement.decision?.receipt?.reservationRef).toBe(
    "reservation/provider-owned/new-tree",
  );
});

test("A to B failed Plan releases B only", async () => {
  const seeded = await seededService();
  const firstRun = planRun();
  const first = await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const firstLifecycle = await promotePrepared({
    ...seeded,
    prepared: first,
    run: firstRun,
  });
  seeded.driver.endpoint = "https://b.example.test";
  seeded.driver.reservationRef = "reservation/provider-owned/b";
  const failedPlan = planRun({ id: "plan_b_failed" });
  await seeded.service.preparePlan({
    planRun: failedPlan,
    providerBindings: BINDINGS,
    variables: { ...BASE_VARIABLES, project_name: "b" },
  });
  await seeded.store.putPlanRun({
    ...failedPlan,
    status: "failed",
    finishedAt: 200,
    updatedAt: 200,
  });
  seeded.driver.calls.length = 0;
  await seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: failedPlan.id,
  });
  const afterFailure = await seeded.store
    .getCapsulePublicInputReservationRecord(CAPSULE_ID);
  expect(afterFailure?.applied?.digest).toBe(firstLifecycle.applied?.digest);
  expect(afterFailure?.candidate).toBeUndefined();
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual(["release"]);
});

test("A to B successful Apply promotes B and retires A with typed retry", async () => {
  const seeded = await seededService();
  const firstRun = planRun();
  const first = await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const initial = await promotePrepared({ ...seeded, prepared: first, run: firstRun });
  seeded.driver.endpoint = "https://b.example.test";
  seeded.driver.reservationRef = "reservation/provider-owned/b";
  const runB = planRun({ id: "plan_b_success" });
  const plannedB = await seeded.service.preparePlan({
    planRun: runB,
    providerBindings: BINDINGS,
    variables: { ...BASE_VARIABLES, project_name: "b" },
  });
  const promoted = await settleTransition(
    seeded.store,
    await seeded.service.transitionForApply({
      guard: await guardFor(seeded.service, plannedB, runB),
      outcome: "applied",
      cleanupRunId: "apply_b_success",
      now: 300,
    }),
  );
  expect(promoted.applied?.reservationRef).toBe("reservation/provider-owned/b");
  expect(promoted.retiring[0]?.receipt.digest).toBe(initial.applied?.digest);
  await seeded.store.putApplyRun(applyRun("apply_b_success", "succeeded"));
  const settle = seeded.store.settleCapsulePublicInputReservationLifecycle
    .bind(seeded.store);
  let simulateCrashBeforeSettlement = true;
  seeded.store.settleCapsulePublicInputReservationLifecycle = async (input) => {
    if (simulateCrashBeforeSettlement) {
      simulateCrashBeforeSettlement = false;
      return false;
    }
    return await settle(input);
  };
  seeded.driver.calls.length = 0;
  await seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: "apply_b_success",
  });
  const settled = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  expect(settled?.applied?.reservationRef).toBe("reservation/provider-owned/b");
  expect(settled?.retiring).toEqual([]);
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "release",
    "release",
  ]);
  expect(seeded.driver.calls[0]?.request).toEqual(
    seeded.driver.calls[1]?.request,
  );
});

test("provider-failed B retains A and retires only staged B", async () => {
  const seeded = await seededService();
  const firstRun = planRun();
  const first = await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const applied = await promotePrepared({ ...seeded, prepared: first, run: firstRun });
  seeded.driver.endpoint = "https://b.example.test";
  seeded.driver.reservationRef = "reservation/provider-owned/b";
  const runB = planRun({ id: "plan_b_provider_failed" });
  const plannedB = await seeded.service.preparePlan({
    planRun: runB,
    providerBindings: BINDINGS,
    variables: { ...BASE_VARIABLES, project_name: "b" },
  });
  const failed = await settleTransition(
    seeded.store,
    await seeded.service.transitionForApply({
      guard: await guardFor(seeded.service, plannedB, runB),
      outcome: "provider_failed",
      cleanupRunId: "apply_b_provider_failed",
      now: 400,
    }),
  );
  expect(failed.applied?.digest).toBe(applied.applied?.digest);
  expect(failed.candidate).toBeUndefined();
  expect(failed.retiring[0]?.receipt.reservationRef).toBe(
    "reservation/provider-owned/b",
  );
});

test("A to B Apply fails before provider read or dispatch when 64 retirements are pending", async () => {
  const seeded = await seededService();
  const firstRun = planRun();
  const first = await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await promotePrepared({ ...seeded, prepared: first, run: firstRun });
  seeded.driver.endpoint = "https://capacity-b.example.test";
  seeded.driver.reservationRef = "reservation/provider-owned/capacity-b";
  const replacementRun = planRun({ id: "plan_capacity_b" });
  const replacement = await seeded.service.preparePlan({
    planRun: replacementRun,
    providerBindings: BINDINGS,
    variables: { ...BASE_VARIABLES, project_name: "capacity-b" },
  });
  const staged = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  const oldReceipts = await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      retiredReceipt(staged!.applied!, index)
    ),
  );
  const full = await createPublicInputReservationLifecycle({
    applied: staged!.applied,
    candidate: staged!.candidate,
    retiring: oldReceipts.map((receipt, index) => ({
      cleanupRunId: `apply_retirement_${index}`,
      enqueuedAt: 1_000 + index,
      receipt,
    })),
  });
  await expect(createPublicInputReservationLifecycle({
    applied: staged!.applied,
    candidate: staged!.candidate,
    retiring: [
      ...full.retiring,
      {
        cleanupRunId: "apply_retirement_65",
        enqueuedAt: 2_000,
        receipt: await retiredReceipt(staged!.applied!, 65),
      },
    ],
  })).rejects.toThrow("lifecycle is invalid");
  expect(await seeded.store.settleCapsulePublicInputReservationLifecycle({
    capsuleId: CAPSULE_ID,
    expectedRecordDigest: staged!.digest,
    record: full,
  })).toBe(true);

  seeded.driver.calls.length = 0;
  await expect(guardFor(seeded.service, replacement, replacementRun))
    .rejects.toThrow("retirement queue is full");
  expect(seeded.driver.calls).toEqual([]);
  expect(publicInputReservationCleanupProjection(full)?.runId).toBe(
    "apply_retirement_0",
  );

  await Promise.all([
    seeded.store.putApplyRun(applyRun("apply_retirement_0", "succeeded")),
    seeded.store.putApplyRun(applyRun("apply_retirement_1", "succeeded")),
  ]);
  await Promise.all([
    seeded.service.cleanupForRun({
      capsuleId: CAPSULE_ID,
      runId: "apply_retirement_0",
    }),
    seeded.service.cleanupForRun({
      capsuleId: CAPSULE_ID,
      runId: "apply_retirement_1",
    }),
  ]);
  expect(
    (await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
      ?.retiring,
  ).toHaveLength(62);
  await expect(guardFor(seeded.service, replacement, replacementRun))
    .resolves.toBeDefined();
});

test("A to absent and Destroy also fence a 65th retirement before provider read", async () => {
  for (const operation of ["absent", "destroy"] as const) {
    const seeded = await seededService();
    const firstRun = planRun({ id: `plan_capacity_${operation}_seed` });
    const first = await seeded.service.preparePlan({
      planRun: firstRun,
      providerBindings: BINDINGS,
      variables: BASE_VARIABLES,
    });
    const applied = await promotePrepared({
      ...seeded,
      prepared: first,
      run: firstRun,
    });
    const oldReceipts = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        retiredReceipt(applied.applied!, index)
      ),
    );
    const full = await createPublicInputReservationLifecycle({
      applied: applied.applied,
      retiring: oldReceipts.map((receipt, index) => ({
        cleanupRunId: `apply_${operation}_retirement_${index}`,
        enqueuedAt: 2_000 + index,
        receipt,
      })),
    });
    expect(await seeded.store.settleCapsulePublicInputReservationLifecycle({
      capsuleId: CAPSULE_ID,
      expectedRecordDigest: applied.digest,
      record: full,
    })).toBe(true);
    let decisionRun: PlanRun;
    if (operation === "absent") {
      const absent = endpointAbsentConfig(`config_capacity_${operation}`);
      await seeded.store.putInstallConfig(absent);
      await seeded.store.putCapsule(capsule(absent.id));
      decisionRun = planRun({
        id: `plan_capacity_${operation}`,
        sourceSnapshotId: "snapshot_without_endpoint",
        operation: "update",
      });
    } else {
      decisionRun = planRun({
        id: `plan_capacity_${operation}`,
        operation: "destroy",
      });
    }
    const decision = await seeded.service.preparePlan({
      planRun: decisionRun,
      providerBindings: BINDINGS,
      variables: BASE_VARIABLES,
    });
    seeded.driver.calls.length = 0;
    await expect(guardFor(seeded.service, decision, decisionRun))
      .rejects.toThrow("retirement queue is full");
    expect(seeded.driver.calls, operation).toEqual([]);
  }
});

test("A to absent failed Apply keeps A while successful Apply retires A", async () => {
  const seeded = await seededService();
  const initialRun = planRun();
  const initial = await seeded.service.preparePlan({
    planRun: initialRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const applied = await promotePrepared({
    ...seeded,
    prepared: initial,
    run: initialRun,
  });
  const absent = endpointAbsentConfig();
  await seeded.store.putInstallConfig(absent);
  await seeded.store.putCapsule(capsule(absent.id));
  const absentRun = planRun({
    id: "plan_absent",
    sourceSnapshotId: "snapshot_without_endpoint",
    operation: "update",
  });
  const decision = await seeded.service.preparePlan({
    planRun: absentRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(decision.decision?.operation).toBe("absent");
  const guard = await guardFor(seeded.service, decision, absentRun);
  expect(await seeded.service.transitionForApply({
    guard,
    outcome: "provider_failed",
    cleanupRunId: "apply_absent_failed",
    now: 500,
  })).toBeUndefined();
  expect((await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    ?.applied?.digest).toBe(applied.applied?.digest);
  const succeeded = await settleTransition(
    seeded.store,
    await seeded.service.transitionForApply({
      guard,
      outcome: "applied",
      cleanupRunId: "apply_absent_success",
      now: 501,
    }),
  );
  expect(succeeded.applied).toBeUndefined();
  expect(succeeded.retiring[0]?.receipt.digest).toBe(applied.applied?.digest);
});

test("same target re-adoption reuses provider identity and updates provenance on Apply", async () => {
  const seeded = await seededService();
  const originalRun = planRun();
  const original = await seeded.service.preparePlan({
    planRun: originalRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await promotePrepared({ ...seeded, prepared: original, run: originalRun });
  const replacement = installConfig({
    id: "config_endpoint_readopted",
    internal: {
      ...installConfig().internal,
      sourceSnapshotId: "snapshot_endpoint_v2",
      repositoryInstallUxDigest: `sha256:${"f".repeat(64)}`,
    },
  });
  await seeded.store.putInstallConfig(replacement);
  await seeded.store.putCapsule(capsule(replacement.id));
  seeded.driver.calls.length = 0;
  const readoptRun = planRun({
    id: "plan_readopted",
    sourceSnapshotId: "snapshot_endpoint_v2",
  });
  const readopted = await seeded.service.preparePlan({
    planRun: readoptRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "select",
    "resolve",
  ]);
  expect(readopted.decision).toMatchObject({ source: "applied" });
  expect(readopted.decision?.receipt).toMatchObject({
    clientIdempotencyKey: original.decision?.receipt?.clientIdempotencyKey,
    reservationLifecycleNonce:
      original.decision?.receipt?.reservationLifecycleNonce,
    reservationRef: original.decision?.receipt?.reservationRef,
    installConfigId: replacement.id,
    sourceSnapshotId: "snapshot_endpoint_v2",
    repositoryInstallUxDigest: `sha256:${"f".repeat(64)}`,
  });
  const promoted = await promotePrepared({
    ...seeded,
    prepared: readopted,
    run: readoptRun,
    applyRunId: "apply_readopted",
  });
  expect(promoted.applied?.installConfigId).toBe(replacement.id);
  expect(promoted.retiring).toEqual([]);
  expect(seeded.nonceCalls).toBe(1);
});

test("drift check is lookup-only with a receipt and zero-write/effect without one", async () => {
  const seeded = await seededService();
  const originalRun = planRun();
  const original = await seeded.service.preparePlan({
    planRun: originalRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await promotePrepared({ ...seeded, prepared: original, run: originalRun });
  const before = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  const observedWrites = countLifecycleWrites(seeded.store);
  seeded.driver.calls.length = 0;
  const drift = await seeded.service.preparePlan({
    planRun: planRun({ id: "drift_with_receipt", driftCheck: true }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(drift.variables.app_url).toBe("https://young-tree.example.test");
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "select",
    "resolve",
  ]);
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toEqual(before);
  expect(observedWrites()).toBe(0);
  seeded.driver.endpoint = "https://drifted.example.test";
  seeded.driver.calls.length = 0;
  await expect(seeded.service.preparePlan({
    planRun: planRun({ id: "drift_mismatch", driftCheck: true }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("endpoint reservation changed since Apply");
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "select",
    "resolve",
  ]);
  expect(observedWrites()).toBe(0);
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toEqual(before);

  const empty = await seededService(new RecordingDriver());
  const observedEmptyWrites = countLifecycleWrites(empty.store);
  await expect(empty.service.preparePlan({
    planRun: planRun({ id: "drift_without_receipt", driftCheck: true }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).rejects.toThrow("requires a durable applied endpoint receipt");
  expect(empty.driver.calls).toEqual([]);
  expect(await empty.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toBeUndefined();
  expect(empty.nonceCalls).toBe(0);
  expect(observedEmptyWrites()).toBe(0);
});

test("Destroy uses durable applied authority after current InstallConfig removal", async () => {
  const seeded = await seededService();
  const originalRun = planRun();
  const original = await seeded.service.preparePlan({
    planRun: originalRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const applied = await promotePrepared({
    ...seeded,
    prepared: original,
    run: originalRun,
  });
  await seeded.store.putCapsule(capsule("config_removed"));
  seeded.driver.calls.length = 0;
  const destroyRun = planRun({
    id: "plan_destroy_source_removed",
    operation: "destroy",
  });
  const destroy = await seeded.service.preparePlan({
    planRun: destroyRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(destroy.decision).toMatchObject({
    operation: "destroy",
    installConfigId: "config_removed",
    expectedAppliedReceiptDigest: applied.applied?.digest,
  });
  expect(destroy.variables.app_url).toBe(
    applied.applied?.httpEndpointUrl,
  );
  expect(seeded.driver.calls.map(({ kind }) => kind)).toEqual([
    "select",
    "resolve",
  ]);
  const retired = await settleTransition(
    seeded.store,
    await seeded.service.transitionForApply({
      guard: await guardFor(seeded.service, destroy, destroyRun),
      outcome: "applied",
      cleanupRunId: "apply_destroy_source_removed",
      now: 600,
    }),
  );
  expect(retired.applied).toBeUndefined();
  expect(retired.retiring[0]?.receipt.digest).toBe(applied.applied?.digest);
});

test("typed Destroy release removes the lifecycle so a later Plan gets a new key", async () => {
  const seeded = await seededService();
  const firstRun = planRun();
  const first = await seeded.service.preparePlan({
    planRun: firstRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await promotePrepared({ ...seeded, prepared: first, run: firstRun });
  const destroyRun = planRun({ id: "plan_destroy_then_replan", operation: "destroy" });
  const destroy = await seeded.service.preparePlan({
    planRun: destroyRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await settleTransition(
    seeded.store,
    await seeded.service.transitionForApply({
      guard: await guardFor(seeded.service, destroy, destroyRun),
      outcome: "applied",
      cleanupRunId: "apply_destroy_then_replan",
      now: 700,
    }),
  );
  await seeded.store.putApplyRun(
    applyRun("apply_destroy_then_replan", "succeeded"),
  );
  await seeded.service.cleanupForRun({
    capsuleId: CAPSULE_ID,
    runId: "apply_destroy_then_replan",
  });
  expect(await seeded.store.getCapsulePublicInputReservationRecord(CAPSULE_ID))
    .toBeUndefined();

  const next = await seeded.service.preparePlan({
    planRun: planRun({ id: "plan_after_destroy_release" }),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  expect(next.decision?.receipt?.clientIdempotencyKey).not.toBe(
    first.decision?.receipt?.clientIdempotencyKey,
  );
  expect(next.decision?.receipt?.reservationLifecycleNonce).toBe(
    reservationNonce(2),
  );
  expect(seeded.nonceCalls).toBe(2);
});

test("v1 bare receipt decodes as applied and client keys hide Capsule ids", async () => {
  const seeded = await seededService();
  const prepared = await seeded.service.preparePlan({
    planRun: planRun(),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  const receipt = prepared.decision!.receipt!;
  const decoded = await decodePublicInputReservationLifecycle(receipt);
  expect(decoded.applied).toEqual(receipt);
  expect(decoded.candidate).toBeUndefined();
  const first = await publicInputClientIdempotencyKey({
    capsuleId: CAPSULE_ID,
    targetVariable: "app_url",
    subdomainVariable: "project_name",
    requestedSubdomain: "young-tree",
    reservationLifecycleNonce: reservationNonce(41),
  });
  expect(first).not.toContain(CAPSULE_ID);
  expect(await publicInputClientIdempotencyKey({
    capsuleId: CAPSULE_ID,
    targetVariable: "app_url",
    subdomainVariable: "project_name",
    requestedSubdomain: "young-tree",
    reservationLifecycleNonce: reservationNonce(42),
  })).not.toBe(first);
});

test("Apply revalidation fences provider drift, lifecycle deletion, and digest", async () => {
  const seeded = await seededService();
  const run = planRun();
  const prepared = await seeded.service.preparePlan({
    planRun: run,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await expect(guardFor(seeded.service, prepared, run)).resolves.toBeDefined();
  const originalVariablesDigest = await stableJsonDigest(prepared.variables);
  seeded.driver.endpoint = "https://changed.example.test";
  await expect(guardFor(seeded.service, prepared, run)).rejects.toThrow(
    "changed since Plan",
  );
  expect(await stableJsonDigest({
    ...prepared.variables,
    app_url: seeded.driver.endpoint,
  })).not.toBe(originalVariablesDigest);
  const lifecycle = await seeded.store.getCapsulePublicInputReservationRecord(
    CAPSULE_ID,
  );
  expect(await seeded.store.deleteCapsulePublicInputReservationRecord({
    capsuleId: CAPSULE_ID,
    expectedRecordDigest: lifecycle!.digest,
  })).toBe(true);
  await expect(guardFor(seeded.service, prepared, run)).rejects.toThrow(
    "durable endpoint lifecycle is missing",
  );
});

test("Apply rejects effective projection patches and absent-to-present config drift", async () => {
  const seeded = await seededService();
  const run = planRun();
  const prepared = await seeded.service.preparePlan({
    planRun: run,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await seeded.store.putInstallConfig(installConfig({
    installExperience: {
      ...installConfig().installExperience,
      projections: [{
        kind: "public_endpoint",
        variables: { url: "operator_url", subdomain: "project_name" },
      }],
    },
  }));
  await expect(guardFor(seeded.service, prepared, run)).rejects.toThrow(
    "compiled endpoint provenance changed since Plan",
  );

  await seeded.store.putInstallConfig(installConfig());
  await promotePrepared({ ...seeded, prepared, run });
  const absent = endpointAbsentConfig();
  await seeded.store.putInstallConfig(absent);
  await seeded.store.putCapsule(capsule(absent.id));
  const absentRun = planRun({
    id: "plan_absent_then_patched",
    sourceSnapshotId: "snapshot_without_endpoint",
    operation: "update",
  });
  const absentDecision = await seeded.service.preparePlan({
    planRun: absentRun,
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  });
  await seeded.store.putInstallConfig(installConfig({
    id: absent.id,
    internal: {
      ...installConfig().internal,
      sourceSnapshotId: "snapshot_without_endpoint",
    },
  }));
  await expect(
    guardFor(seeded.service, absentDecision, absentRun),
  ).rejects.toThrow("compiled endpoint requirement changed since Plan");
});

test("mutable projection drift is ineligible while legacy manifests remain unchanged", async () => {
  const base = installConfig();
  expect(publicEndpointPreflightProjection(base)).toEqual({
    targetVariable: "app_url",
    subdomainVariable: "project_name",
  });
  expect(publicEndpointPreflightProjection({
    ...base,
    installExperience: {
      ...base.installExperience,
      projections: [{
        kind: "public_endpoint",
        variables: { url: "operator_url", subdomain: "project_name" },
      }],
    },
  })).toBeUndefined();
  const driver = new RecordingDriver();
  const store = new InMemoryOpenTofuControlStore();
  const legacy = installConfig({
    id: "config_legacy",
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snapshot_legacy",
      repositoryInstallUxDigest: `sha256:${"d".repeat(64)}`,
      repositoryManifestApiVersion: "takosumi.com/v2.3",
    },
    installExperience: undefined,
  });
  await store.putInstallConfig(legacy);
  await store.putCapsule(capsule(legacy.id));
  const service = new PublicInputReservationService({ store, driver });
  await expect(service.preparePlan({
    planRun: planRun(),
    providerBindings: BINDINGS,
    variables: BASE_VARIABLES,
  })).resolves.toEqual({ variables: BASE_VARIABLES });
  expect(driver.calls).toEqual([]);
});
