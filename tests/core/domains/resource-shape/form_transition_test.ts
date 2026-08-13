import { expect, test } from "bun:test";
import type {
  InstalledFormReference,
  ResourceCapsuleOwner,
  TakoformResourceFormTransitionEvidence,
} from "takosumi-contract";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryResourceShapeStores,
  formatResourceShapeId,
  ResourceFormTransitionError,
  ResourceFormTransitionService,
  resourceFormTransitionDesiredSpecDigest,
  resourceFormTransitionEvidenceDigest,
  resourceFormTransitionOperationId,
  resourceFormTransitionRequestDigest,
  ResourceShapeService as OrdinaryResourceShapeService,
  StubResourceShapeAdapter,
  type ResolutionLockRecord,
  type ResourceFormTransitionHost,
  type ResourceFormTransitionHostProof,
  type ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/mod.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import FORM_TRANSITION_FIXTURE from "../../../fixtures/takoform/form-transition-rfc8785.json" with { type: "json" };

const NOW = "2026-08-13T12:00:00.000Z";
const SPACE = "workspace_transition" as SpaceId;
const RESOURCE_ID = formatResourceShapeId(
  SPACE,
  "RelationalDatabase",
  "primary",
);
const OWNER: ResourceCapsuleOwner = {
  kind: "Capsule",
  id: "capsule_yuru",
  workspaceId: SPACE,
  installingPrincipalId: "principal_installing",
};
const OLD_FORM: InstalledFormReference = {
  type: "relational_database",
  version: "2.0.0",
  schemaDigest:
    "sha256:3898f8ee507bcebd9e03e80fbc1931b67b477299b1ebe2ff395facb7acf018de",
  packageDigest:
    "sha256:dc131e4858ddedbb84d553fdf7808c55fc898a37f15d84839e414fe3ca57c910",
};
const NEW_FORM: InstalledFormReference = {
  type: "relational_database",
  version: "3.0.0",
  schemaDigest:
    "sha256:e4c7aedb5962e6b719d7afe7a8f002ceb00ae4a1c74ebfc1eff712e257bf4044",
  packageDigest:
    "sha256:599e60e4f3a5b735c58f8ff5029f72b5a25445be6f317816590eca12b44e5a31",
};
const NATIVE = {
  type: "cloudflare.d1_database",
  id: "native-db-01",
} as const;
const DESIRED_SPEC = {
  schemaUrl: "https://schema.example.invalid/db3.sql",
  schemaSha256: `sha256:${"a".repeat(64)}`,
  schemaFormat: "cloudflare-d1-migrations",
} as const;

function resource(): ResourceShapeRecord {
  return {
    id: RESOURCE_ID,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    form: OLD_FORM,
    name: "primary",
    managedBy: "takoform.form-host.v1",
    owner: OWNER,
    spec: { secretLikeValue: "MUST-NOT-ENTER-TRANSITION-EVIDENCE" },
    phase: "Ready",
    generation: 7,
    observedGeneration: 7,
    outputs: { credential: "MUST-NOT-ENTER-TRANSITION-EVIDENCE" },
    lastOperationRunId: "apply_run_old",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function lock(): ResolutionLockRecord {
  return {
    resourceId: RESOURCE_ID,
    form: OLD_FORM,
    selectedImplementation: "cloudflare_d1",
    targetPool: "default",
    target: "cloudflare-main",
    locked: true,
    reason: ["selected"],
    portability: "portable",
    nativeResources: [
      { ...NATIVE, ownership: "resource", form: OLD_FORM },
    ],
    lockedAt: NOW,
    updatedAt: NOW,
  };
}

class Host implements ResourceFormTransitionHost {
  readonly dispatchCalls: unknown[] = [];
  readonly readbackCalls: unknown[] = [];
  dispatchResult:
    | {
        readonly status: "committed";
        readonly proof: ResourceFormTransitionHostProof;
        readonly observedSpec: Record<string, string>;
      }
    | { readonly status: "rejected"; readonly code: string }
    | Error;
  readbackResult:
    | {
        readonly status: "committed";
        readonly proof: ResourceFormTransitionHostProof;
        readonly observedSpec: Record<string, string>;
      }
    | { readonly status: "absent" }
    | { readonly status: "rejected"; readonly code: string }
    | Error = { status: "absent" };
  dispatchHook?: () => void | Promise<void>;

  constructor(
    proof: ResourceFormTransitionHostProof,
    observedSpec: Record<string, string>,
  ) {
    this.dispatchResult = { status: "committed", proof, observedSpec };
  }

  async dispatch(input: unknown) {
    this.dispatchCalls.push(input);
    await this.dispatchHook?.();
    if (this.dispatchResult instanceof Error) throw this.dispatchResult;
    return this.dispatchResult;
  }

  async readback(input: unknown) {
    this.readbackCalls.push(input);
    if (this.readbackResult instanceof Error) throw this.readbackResult;
    return this.readbackResult;
  }
}

async function fixture(options: {
  readonly installed?: readonly InstalledFormReference[];
  readonly allowed?: boolean;
  readonly operationStore?: InMemoryOpenTofuControlStore;
  readonly onAuthorize?: (input: {
    readonly stores: ReturnType<typeof createInMemoryResourceShapeStores>;
  }) => void | Promise<void>;
  readonly schemaError?: string;
} = {}) {
  const stores = createInMemoryResourceShapeStores();
  await stores.resources.upsert(resource());
  await stores.locks.put(lock());
  const persisted = await stores.resources.get(RESOURCE_ID);
  if (!persisted || persisted.revision === undefined) {
    throw new Error("missing seeded revision");
  }
  const operationStore =
    options.operationStore ?? new InMemoryOpenTofuControlStore();
  const desiredSpec = DESIRED_SPEC;
  const operationId = await operationIdFor(desiredSpec);
  const proof: ResourceFormTransitionHostProof = {
    operationId,
    fromForm: OLD_FORM,
    toForm: NEW_FORM,
    resourceGeneration: persisted.generation + 1,
    expectedResourceRevisionId: persisted.lastOperationRunId!,
    observedSpecDigest: await resourceFormTransitionDesiredSpecDigest(
      desiredSpec,
    ),
    transitionEvidenceDigest: await resourceFormTransitionEvidenceDigest({
      marker: "relational-database-v2-to-v3",
      fromForm: OLD_FORM,
      toForm: NEW_FORM,
    }),
    nativeResources: [
      { ...NATIVE, ownership: "resource", form: NEW_FORM },
    ],
    committed: true,
  };
  const host = new Host(proof, desiredSpec);
  const installed = options.installed ?? [OLD_FORM, NEW_FORM];
  const service = new ResourceFormTransitionService({
    stores,
    operations: operationStore,
    forms: {
      async getRetainedIdentity(identity) {
        if (
          installed.some(
            (candidate) =>
              JSON.stringify(candidate) === JSON.stringify(identity),
          )
        ) {
          return {};
        }
        throw new Error("not installed");
      },
      async validateDesiredState() {
        return options.schemaError;
      },
    },
    evidence: {
      async authorize(input) {
        await options.onAuthorize?.({ stores });
        return (
          options.allowed !== false &&
          input.transitionEvidence.marker ===
            "relational-database-v2-to-v3"
        );
      },
    },
    host,
    now: () => NOW,
  });
  return {
    stores,
    operationStore,
    host,
    service,
    proof,
    persisted,
    desiredSpec,
  };
}

async function evidence(
  marker = "relational-database-v2-to-v3",
): Promise<TakoformResourceFormTransitionEvidence> {
  return {
    format: "takoform.module-form-transition@v1",
    marker,
    digest: await resourceFormTransitionEvidenceDigest({
      marker,
      fromForm: OLD_FORM,
      toForm: NEW_FORM,
    }),
  };
}

async function request(
  desiredSpec: Readonly<Record<string, string>> = DESIRED_SPEC,
) {
  const transitionEvidence = await evidence();
  return {
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase" as const,
    name: "primary",
    actorId: "provider-run",
    owner: OWNER,
    operationId: await operationIdFor(desiredSpec, transitionEvidence),
    fromForm: OLD_FORM,
    toForm: NEW_FORM,
    desiredSpec,
    expected: {
      resourceVersion: "7",
      nativeIdentity: NATIVE,
    },
    transitionEvidence,
  };
}

async function operationIdFor(
  desiredSpec: Readonly<Record<string, string>>,
  suppliedEvidence?: TakoformResourceFormTransitionEvidence,
): Promise<string> {
  const transitionEvidence = suppliedEvidence ?? (await evidence());
  return await resourceFormTransitionOperationId({
    space: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    fromForm: OLD_FORM,
    toForm: NEW_FORM,
    desiredSpecDigest: await resourceFormTransitionDesiredSpecDigest(
      desiredSpec,
    ),
    expected: { resourceVersion: "7", nativeIdentity: NATIVE },
    transitionEvidence,
  });
}

async function expectCode(
  action: Promise<unknown>,
  code: ResourceFormTransitionError["code"],
) {
  try {
    await action;
    throw new Error("expected ResourceFormTransitionError");
  } catch (error) {
    expect(error).toBeInstanceOf(ResourceFormTransitionError);
    expect((error as ResourceFormTransitionError).code).toBe(code);
  }
}

test("missing/unknown evidence and an uninstalled exact pair fail before host dispatch", async () => {
  const unknown = await fixture({ allowed: false });
  await expectCode(
    unknown.service.transition(await request()),
    "transition_not_allowed",
  );
  expect(unknown.host.dispatchCalls).toHaveLength(0);

  const uninstalled = await fixture({ installed: [OLD_FORM] });
  await expectCode(
    uninstalled.service.transition(await request()),
    "form_not_retained",
  );
  expect(uninstalled.host.dispatchCalls).toHaveLength(0);

  const missingMarker = await fixture();
  await expectCode(
    missingMarker.service.transition({
      ...(await request()),
      transitionEvidence: {
        ...(await evidence()),
        marker: "",
      },
    }),
    "invalid_request",
  );
  expect(missingMarker.host.dispatchCalls).toHaveLength(0);

  const arbitraryOperation = await fixture();
  await expectCode(
    arbitraryOperation.service.transition({
      ...(await request()),
      operationId: `formtx_${"f".repeat(64)}`,
    }),
    "invalid_request",
  );
  expect(arbitraryOperation.host.dispatchCalls).toHaveLength(0);
});

test("definite host rejection leaves Resource, lock, and native evidence entirely old", async () => {
  const { service, host, stores, proof } = await fixture();
  host.dispatchResult = { status: "rejected", code: "pair_rejected" };
  const result = await service.transition(await request());
  expect(result).toMatchObject({
    status: "rejected",
    operationId: proof.operationId,
  });
  expect((await stores.resources.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
  const retainedLock = await stores.locks.get(RESOURCE_ID);
  expect(retainedLock?.form).toEqual(OLD_FORM);
  expect(retainedLock?.nativeResources?.[0]).toEqual({
    ...NATIVE,
    ownership: "resource",
    form: OLD_FORM,
  });
  expect((await stores.resources.get(RESOURCE_ID))?.pendingOperation).toBeUndefined();

  const reviewed = await request({
    ...DESIRED_SPEC,
    schemaFormat: "cloudflare-d1-migrations-reviewed-v2",
  });
  host.dispatchResult = { status: "committed", proof: {
    ...proof,
    operationId: reviewed.operationId,
    observedSpecDigest: await resourceFormTransitionDesiredSpecDigest(
      reviewed.desiredSpec,
    ),
  }, observedSpec: reviewed.desiredSpec };
  expect((await service.transition(reviewed)).status).toBe("committed");
  expect(host.dispatchCalls).toHaveLength(2);
});

test("durable rejection receipt repairs a crashed claim release without redispatch", async () => {
  const { service, host, stores } = await fixture();
  host.dispatchResult = { status: "rejected", code: "migration_rejected" };
  const compareAndSet = stores.resources.compareAndSet.bind(stores.resources);
  let refuseRelease = true;
  stores.resources.compareAndSet = async (candidate, expected) => {
    if (refuseRelease && candidate.pendingOperation === undefined) {
      const current = await stores.resources.get(candidate.id);
      if (!current) return { status: "not_found" as const };
      return { status: "conflict" as const, record: current };
    }
    return await compareAndSet(candidate, expected);
  };

  const transition = await request();
  expect(await service.transition(transition)).toMatchObject({
    status: "indeterminate",
    dispatchAttempted: true,
  });
  expect(host.dispatchCalls).toHaveLength(1);
  expect((await stores.resources.get(RESOURCE_ID))?.pendingOperation).toMatchObject({
    operation: "form_transition",
    operationKey: transition.operationId,
  });

  refuseRelease = false;
  expect(await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: transition.operationId,
  })).toMatchObject({
    status: "rejected",
    rejectionCode: "migration_rejected",
  });
  expect((await stores.resources.get(RESOURCE_ID))?.pendingOperation).toBeUndefined();
  expect((await stores.resources.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
  expect((await stores.locks.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
  expect(host.dispatchCalls).toHaveLength(1);
  expect(host.readbackCalls).toHaveLength(0);
});

test("definite rejection releases its claim and stays failed after a reviewed replacement", async () => {
  const { service, host, proof } = await fixture();
  host.dispatchResult = { status: "rejected", code: "migration_rejected" };
  const first = await request();
  expect(await service.transition(first)).toMatchObject({
    status: "rejected",
    operationId: first.operationId,
    rejectionCode: "migration_rejected",
  });

  const replacementSpec = {
    ...DESIRED_SPEC,
    schemaFormat: "cloudflare-d1-migrations-reviewed-v2",
  };
  const replacement = await request(replacementSpec);
  host.dispatchResult = {
    status: "committed",
    observedSpec: replacementSpec,
    proof: {
      ...proof,
      operationId: replacement.operationId,
      observedSpecDigest:
        await resourceFormTransitionDesiredSpecDigest(replacementSpec),
    },
  };
  expect(await service.transition(replacement)).toMatchObject({
    status: "committed",
    operationId: replacement.operationId,
    resource: { generation: 8 },
  });

  expect(
    await service.readback({
      workspaceId: SPACE,
      spaceId: SPACE,
      kind: "RelationalDatabase",
      name: "primary",
      owner: OWNER,
      operationId: first.operationId,
    }),
  ).toMatchObject({
    status: "rejected",
    operationId: first.operationId,
    rejectionCode: "migration_rejected",
  });
  expect(host.dispatchCalls).toHaveLength(2);
  expect(host.readbackCalls).toHaveLength(0);
});

test("host rejection receipts normalize unbounded or secret-bearing codes", async () => {
  const { service, host, operationStore } = await fixture();
  host.dispatchResult = {
    status: "rejected",
    code: "migration_rejected\ncredential=must-not-leak",
  };
  expect(await service.transition(await request())).toMatchObject({
    status: "rejected",
    rejectionCode: "host_rejected",
  });
  expect(
    JSON.stringify(await operationStore.listRunsByWorkspace(SPACE)),
  ).not.toContain("must-not-leak");
});

test("lost acknowledgement is indeterminate; committed readback repairs the canonical aggregate", async () => {
  const { service, host, stores, proof } = await fixture();
  host.dispatchResult = new Error("transport lost after write");
  host.readbackResult = {
    status: "committed",
    proof,
    observedSpec: {
      schemaUrl: "https://schema.example.invalid/db3.sql",
      schemaSha256: `sha256:${"a".repeat(64)}`,
      schemaFormat: "cloudflare-d1-migrations",
    },
  };

  expect(await service.transition(await request())).toMatchObject({
    status: "indeterminate",
    dispatchAttempted: true,
  });
  expect((await stores.resources.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
  expect((await stores.resources.get(RESOURCE_ID))?.pendingOperation).toMatchObject({
    operation: "form_transition",
    operationKey: proof.operationId,
  });

  const repaired = await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: proof.operationId,
  });
  expect(repaired.status).toBe("committed");
  const repairedResource = await stores.resources.get(RESOURCE_ID);
  expect(repairedResource?.form).toEqual(NEW_FORM);
  expect(repairedResource?.generation).toBe(8);
  expect(repairedResource?.observedGeneration).toBe(8);
  expect(repaired.proof?.resourceGeneration).toBe(8);
  expect(repairedResource?.pendingOperation).toBeUndefined();
  expect(await stores.getResourceIdentityFence(RESOURCE_ID)).toMatchObject({
    resourceId: RESOURCE_ID,
    lastGeneration: 8,
    fenceRevision: 1,
  });
  const repairedLock = await stores.locks.get(RESOURCE_ID);
  expect(repairedLock?.form).toEqual(NEW_FORM);
  expect(repairedLock?.nativeResources?.[0]?.form).toEqual(NEW_FORM);
  expect(repairedLock?.nativeResources?.[0]?.id).toBe(NATIVE.id);
  expect(host.dispatchCalls).toHaveLength(1);
  expect(host.readbackCalls).toHaveLength(1);
});

test("lost acknowledgement with absent host ledger stays indeterminate without redispatch", async () => {
  const { service, host, stores, proof } = await fixture();
  host.dispatchResult = new Error("timeout");
  host.readbackResult = { status: "absent" };
  await service.transition(await request());
  const result = await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: proof.operationId,
  });
  expect(result.status).toBe("indeterminate");
  expect(host.dispatchCalls).toHaveLength(1);
  expect((await stores.resources.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
});

test("native identity or canonical revision/lock drift aborts before host dispatch", async () => {
  const { service, host } = await fixture();
  await expectCode(
    service.transition({
      ...(await request()),
      expected: {
        resourceVersion: "7",
        nativeIdentity: { ...NATIVE, id: "wrong-native-id" },
      },
    }),
    "native_identity_conflict",
  );
  expect(host.dispatchCalls).toHaveLength(0);

  const revisionDrift = await fixture({
    async onAuthorize({ stores }) {
      const current = await stores.resources.get(RESOURCE_ID);
      if (!current) throw new Error("missing Resource");
      await stores.resources.upsert({
        ...current,
        labels: { concurrent: "revision" },
      });
    },
  });
  await expectCode(
    revisionDrift.service.transition(await request()),
    "canonical_conflict",
  );
  expect(revisionDrift.host.dispatchCalls).toHaveLength(0);

  const lockDrift = await fixture({
    async onAuthorize({ stores }) {
      const current = await stores.locks.get(RESOURCE_ID);
      if (!current) throw new Error("missing lock");
      await stores.locks.put({
        ...current,
        reason: [...current.reason, "concurrent-lock-change"],
      });
    },
  });
  await expectCode(
    lockDrift.service.transition(await request()),
    "canonical_conflict",
  );
  expect(lockDrift.host.dispatchCalls).toHaveLength(0);
});

test("invalid new-Form desired spec fails before host dispatch", async () => {
  const { service, host } = await fixture({
    schemaError: "schema rejected a provider-only field",
  });
  await expectCode(service.transition(await request()), "invalid_request");
  expect(host.dispatchCalls).toHaveLength(0);

  const secretLike = await fixture();
  await expectCode(
    secretLike.service.transition(
      await request({
        ...DESIRED_SPEC,
        databasePassword: "must-never-enter-a-Resource",
      }),
    ),
    "invalid_request",
  );
  expect(secretLike.host.dispatchCalls).toHaveLength(0);
});

test("same operation and body are idempotent and never redispatch", async () => {
  const { service, host } = await fixture();
  expect((await service.transition(await request())).status).toBe("committed");
  expect((await service.transition(await request())).status).toBe("committed");
  expect((await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: (await request()).operationId,
  })).resource?.generation).toBe(8);
  expect(host.dispatchCalls).toHaveLength(1);
});

test("terminal readback returns the same N+1 receipt after a later normal generation", async () => {
  const { service, host, stores, proof } = await fixture();
  const exact = await request();
  expect((await service.transition(exact)).resource?.generation).toBe(8);

  const [current, currentLock, currentFence] = await Promise.all([
    stores.resources.get(RESOURCE_ID),
    stores.locks.get(RESOURCE_ID),
    stores.getResourceIdentityFence(RESOURCE_ID),
  ]);
  if (!current || !currentLock || !currentFence) {
    throw new Error("committed transition aggregate is incomplete");
  }
  const laterAt = "2026-08-13T12:00:01.000Z";
  expect(await stores.replaceResourceAggregate({
    record: {
      ...current,
      spec: { ...DESIRED_SPEC, schemaFormat: "later-normal-update" },
      generation: 9,
      observedGeneration: 9,
      updatedAt: laterAt,
      lastOperationRunId: "later-normal-apply",
    },
    lock: { ...currentLock, updatedAt: laterAt },
    expectedResource: {
      generation: current.generation,
      phase: current.phase,
      updatedAt: current.updatedAt,
      revision: current.revision,
    },
    expectedLock: currentLock,
    identityFenceAdvance: { expected: currentFence },
  })).toMatchObject({ status: "replaced" });

  host.readbackResult = {
    status: "committed",
    proof,
    observedSpec: DESIRED_SPEC,
  };
  const receipt = await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: exact.operationId,
  });
  expect(receipt).toMatchObject({
    status: "committed",
    resource: {
      generation: 8,
      observedGeneration: 8,
      spec: DESIRED_SPEC,
    },
    proof: { resourceGeneration: 8 },
  });
  expect(host.readbackCalls).toHaveLength(1);
  expect((await stores.resources.get(RESOURCE_ID))?.generation).toBe(9);
});

test("prepared and dispatch-attempted ledgers never blindly dispatch on replay", async () => {
  const prepared = await fixture();
  const preparedRequest = await request();
  prepared.host.dispatchHook = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const first = prepared.service.transition(preparedRequest);
  await Promise.resolve();
  const replay = await prepared.service.transition(preparedRequest);
  expect(["prepared", "indeterminate"]).toContain(replay.status);
  await first;
  expect(prepared.host.dispatchCalls).toHaveLength(1);

  const lost = await fixture();
  lost.host.dispatchResult = new Error("lost acknowledgement");
  expect((await lost.service.transition(await request())).status).toBe(
    "indeterminate",
  );
  const replayAfterLoss = await lost.service.transition(await request());
  expect(replayAfterLoss.status).toBe("indeterminate");
  expect(replayAfterLoss.dispatchAttempted).toBe(true);
  expect(lost.host.dispatchCalls).toHaveLength(1);
});

test("an exact prepared operation resumes through one dispatch-fence CAS", async () => {
  const { service, host, operationStore } = await fixture();
  const transitionRun =
    operationStore.transitionResourceOperationRun.bind(operationStore);
  let simulateCrashBeforeDispatchFence = true;
  operationStore.transitionResourceOperationRun = async (input) => {
    if (
      simulateCrashBeforeDispatchFence &&
      input.run.resourceFormTransitionDispatch !== undefined
    ) {
      return {
        won: false,
        run: await operationStore.getResourceOperationRun(input.id),
      };
    }
    return await transitionRun(input);
  };

  const exact = await request();
  expect(await service.transition(exact)).toMatchObject({
    status: "prepared",
    dispatchAttempted: false,
  });
  expect(host.dispatchCalls).toHaveLength(0);

  expect(await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: exact.operationId,
  })).toMatchObject({
    status: "prepared",
    dispatchAttempted: false,
  });
  expect(host.readbackCalls).toHaveLength(0);

  simulateCrashBeforeDispatchFence = false;
  expect((await service.transition(exact)).status).toBe("committed");
  expect(host.dispatchCalls).toHaveLength(1);
  expect((await service.transition(exact)).status).toBe("committed");
  expect(host.dispatchCalls).toHaveLength(1);
});

test("operation id and request digest are fixed cross-language canonical fixtures", async () => {
  const fixtureFromForm = OLD_FORM;
  const fixtureToForm = NEW_FORM;
  const fixtureSpec = FORM_TRANSITION_FIXTURE.desiredSpec;
  const fixtureExpected = FORM_TRANSITION_FIXTURE.expected;
  const fixtureEvidence =
    FORM_TRANSITION_FIXTURE.transitionEvidence as TakoformResourceFormTransitionEvidence;
  expect(FORM_TRANSITION_FIXTURE.format).toBe(
    "takoform.form-transition-rfc8785-fixture@v1",
  );
  expect(FORM_TRANSITION_FIXTURE.fromForm.formRef.definitionVersion).toBe(
    fixtureFromForm.version,
  );
  expect(FORM_TRANSITION_FIXTURE.toForm.formRef.definitionVersion).toBe(
    fixtureToForm.version,
  );
  expect(fixtureEvidence).toEqual(await evidence());
  const desiredSpecDigest = await resourceFormTransitionDesiredSpecDigest(
    fixtureSpec,
  );
  expect(desiredSpecDigest).toBe(FORM_TRANSITION_FIXTURE.desiredSpecDigest);
  const operationId = await resourceFormTransitionOperationId({
    space: FORM_TRANSITION_FIXTURE.resource.space,
    kind: FORM_TRANSITION_FIXTURE.resource.kind,
    name: FORM_TRANSITION_FIXTURE.resource.name,
    fromForm: fixtureFromForm,
    toForm: fixtureToForm,
    desiredSpecDigest,
    expected: fixtureExpected,
    transitionEvidence: fixtureEvidence,
  });
  expect(operationId).toBe(FORM_TRANSITION_FIXTURE.operationId);
  expect(
    await resourceFormTransitionRequestDigest({
      operationId,
      fromForm: fixtureFromForm,
      toForm: fixtureToForm,
      desiredSpecDigest,
      expected: fixtureExpected,
      transitionEvidence: fixtureEvidence,
    }),
  ).toBe(FORM_TRANSITION_FIXTURE.requestDigest);
});

test("host proof with native-id drift cannot mutate canonical old evidence", async () => {
  const { service, host, stores, proof } = await fixture();
  host.dispatchResult = {
    status: "committed",
    observedSpec: {
      schemaUrl: "https://schema.example.invalid/db3.sql",
      schemaSha256: `sha256:${"a".repeat(64)}`,
      schemaFormat: "cloudflare-d1-migrations",
    },
    proof: {
      ...proof,
      nativeResources: proof.nativeResources.map((native) => ({
        ...native,
        id: "replacement-native-id",
      })),
    },
  };
  await expectCode(service.transition(await request()), "canonical_conflict");
  expect((await stores.resources.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
  expect((await stores.locks.get(RESOURCE_ID))?.nativeResources?.[0]?.id).toBe(
    NATIVE.id,
  );
});

test("host commit followed by canonical CAS drift stays indeterminate for exact readback", async () => {
  const { service, host, stores, proof } = await fixture();
  host.dispatchHook = async () => {
    const current = await stores.resources.get(RESOURCE_ID);
    if (!current) throw new Error("missing Resource");
    await stores.resources.upsert({
      ...current,
      labels: { concurrent: "after-host-dispatch" },
    });
  };
  host.readbackResult = {
    status: "committed",
    proof,
    observedSpec: {
      schemaUrl: "https://schema.example.invalid/db3.sql",
      schemaSha256: `sha256:${"a".repeat(64)}`,
      schemaFormat: "cloudflare-d1-migrations",
    },
  };
  expect((await service.transition(await request())).status).toBe(
    "indeterminate",
  );
  expect(
    (
      await service.readback({
        workspaceId: SPACE,
        spaceId: SPACE,
        kind: "RelationalDatabase",
        name: "primary",
        owner: OWNER,
        operationId: proof.operationId,
      })
    ).status,
  ).toBe("indeterminate");
  expect(host.dispatchCalls).toHaveLength(1);
  expect((await stores.resources.get(RESOURCE_ID))?.form).toEqual(OLD_FORM);
});

test("same snapshot admits one operation and conflicts a concurrent different operation", async () => {
  const { service, host } = await fixture();
  const firstRequest = await request();
  const secondRequest = await request({
    ...DESIRED_SPEC,
    schemaFormat: "cloudflare-d1-migrations-v2",
  });
  const first = service.transition(firstRequest);
  const second = service.transition(secondRequest);
  const results = await Promise.allSettled([first, second]);
  expect(host.dispatchCalls).toHaveLength(1);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status).toBe("rejected");
  if (rejected?.status === "rejected") {
    expect(rejected.reason).toBeInstanceOf(ResourceFormTransitionError);
    expect(["operation_conflict", "canonical_conflict"]).toContain(
      (rejected.reason as ResourceFormTransitionError).code,
    );
  }
});

test("a claimed transition fences a concurrent ordinary Resource apply", async () => {
  const { service, host, stores } = await fixture();
  let ordinaryResult: Awaited<ReturnType<OrdinaryResourceShapeService["apply"]>> | undefined;
  host.dispatchHook = async () => {
    const ordinary = new OrdinaryResourceShapeService({
      stores,
      adapter: new StubResourceShapeAdapter(),
      now: () => NOW,
    });
    ordinaryResult = await ordinary.apply(
      {
        actor: {
          actorAccountId: OWNER.installingPrincipalId,
          roles: ["operator"],
          requestId: "ordinary-apply-race",
          workspaceId: SPACE,
        },
        space: SPACE,
        kind: "RelationalDatabase",
        form: OLD_FORM,
        name: "primary",
        expectedGeneration: 7,
        spec: { replacement: "must-not-apply" },
        managedBy: "takoform.form-host.v1",
        owner: OWNER,
      },
      { planDigest: `sha256:${"f".repeat(64)}` },
    );
  };

  expect((await service.transition(await request())).status).toBe("committed");
  expect(ordinaryResult).toMatchObject({
    ok: false,
    error: { code: "reconcile_conflict" },
  });
  expect((await stores.resources.get(RESOURCE_ID))?.generation).toBe(8);
  expect((await stores.resources.get(RESOURCE_ID))?.spec).toEqual(DESIRED_SPEC);
  expect(host.dispatchCalls).toHaveLength(1);
});

test("a committed proof fences normal apply until its terminal Run is repaired", async () => {
  const { service, host, stores, operationStore } = await fixture();
  const transitionRun =
    operationStore.transitionResourceOperationRun.bind(operationStore);
  let loseTerminalReceipt = true;
  operationStore.transitionResourceOperationRun = async (input) => {
    if (loseTerminalReceipt && input.run.status === "succeeded") {
      return {
        won: false,
        run: await operationStore.getResourceOperationRun(input.id),
      };
    }
    return await transitionRun(input);
  };

  const exact = await request();
  expect(await service.transition(exact)).toMatchObject({
    status: "indeterminate",
    dispatchAttempted: true,
  });
  expect(await stores.resources.get(RESOURCE_ID)).toMatchObject({
    generation: 8,
    lastOperationRunId: `resource-form-transition:${exact.operationId}`,
  });
  expect((await stores.resources.get(RESOURCE_ID))?.pendingOperation).toBeUndefined();
  const proven = await operationStore.getResourceOperationRun(
    `resource-form-transition:${exact.operationId}`,
  );
  expect(proven).toMatchObject({
    status: "running",
    resourceOperationResult: {
      backendOperationId: exact.operationId,
      outputs: { resourceGeneration: 8 },
    },
  });

  const ordinary = new OrdinaryResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    operationRuns: operationStore,
    now: () => NOW,
  });
  const ordinaryRequest = {
    actor: {
      actorAccountId: OWNER.installingPrincipalId,
      roles: ["operator" as const],
      requestId: "ordinary-after-transition-proof",
      workspaceId: SPACE,
    },
    space: SPACE,
    kind: "RelationalDatabase" as const,
    form: NEW_FORM,
    name: "primary",
    expectedGeneration: 8,
    spec: DESIRED_SPEC,
    managedBy: "takoform.form-host.v1" as const,
    owner: OWNER,
  };
  expect(await ordinary.preview(ordinaryRequest)).toMatchObject({
    ok: false,
    error: { code: "reconcile_conflict" },
  });

  loseTerminalReceipt = false;
  host.readbackResult = new Error("host must not be needed after canonical N+1");
  expect(await service.readback({
    workspaceId: SPACE,
    spaceId: SPACE,
    kind: "RelationalDatabase",
    name: "primary",
    owner: OWNER,
    operationId: exact.operationId,
  })).toMatchObject({
    status: "committed",
    resource: { generation: 8 },
  });
  expect(host.readbackCalls).toHaveLength(0);
  expect(await operationStore.getResourceOperationRun(
    `resource-form-transition:${exact.operationId}`,
  )).toMatchObject({ status: "succeeded" });

  const afterRepair = await ordinary.preview(ordinaryRequest);
  if (!afterRepair.ok) {
    expect(afterRepair.error.code).not.toBe("reconcile_conflict");
  }
});

test("transition ledger and terminal proof remain value-free", async () => {
  const { service, operationStore } = await fixture();
  await service.transition(await request());
  const runs = await operationStore.listRunsByWorkspace(SPACE);
  const serialized = JSON.stringify(runs);
  expect(serialized).not.toContain("MUST-NOT-ENTER-TRANSITION-EVIDENCE");
  expect(serialized).not.toContain("credential");
});
