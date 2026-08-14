import { expect, test } from "bun:test";
import { Hono } from "hono";
import type {
  InstalledFormReference,
  ResourceCapsuleOwner,
  ResourceObject,
} from "takosumi-contract";
import { registerPortableFormHostRoutes } from "../../../core/api/form_host_routes.ts";
import type {
  ResourceFormTransitionService,
  ResourceShapeService,
} from "../../../core/domains/resource-shape/mod.ts";
import { ResourceFormTransitionError } from "../../../core/domains/resource-shape/form_transition.ts";

const OLD: InstalledFormReference = {
  type: "relational_database",
  version: "2.0.0",
  schemaDigest:
    "sha256:3898f8ee507bcebd9e03e80fbc1931b67b477299b1ebe2ff395facb7acf018de",
  packageDigest:
    "sha256:dc131e4858ddedbb84d553fdf7808c55fc898a37f15d84839e414fe3ca57c910",
};
const NEXT: InstalledFormReference = {
  type: "relational_database",
  version: "3.0.0",
  schemaDigest:
    "sha256:e4c7aedb5962e6b719d7afe7a8f002ceb00ae4a1c74ebfc1eff712e257bf4044",
  packageDigest:
    "sha256:599e60e4f3a5b735c58f8ff5029f72b5a25445be6f317816590eca12b44e5a31",
};
const OWNER: ResourceCapsuleOwner = {
  kind: "Capsule",
  id: "capsule_yuru",
  workspaceId: "workspace_yuru",
  installingPrincipalId: "principal_yuru",
};
const SPEC = {
  schemaUrl: "https://schema.example.invalid/db3.sql",
  schemaSha256: `sha256:${"a".repeat(64)}`,
  schemaFormat: "cloudflare-d1-migrations",
};
const OPERATION_ID = `formtx_${"1".repeat(64)}`;
const REQUEST_DIGEST = `sha256:${"c".repeat(64)}`;

function wireForm(identity: InstalledFormReference) {
  return {
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: "RelationalDatabase",
      definitionVersion: identity.version,
      schemaDigest: identity.schemaDigest,
    },
    packageDigest: identity.packageDigest,
  };
}

function transitionBody() {
  return {
    operationId: OPERATION_ID,
    fromForm: wireForm(OLD),
    toForm: wireForm(NEXT),
    resource: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: "RelationalDatabase",
      form: wireForm(NEXT),
      metadata: {
        name: "database",
        space: "workspace_yuru",
        resourceVersion: "4",
      },
      spec: SPEC,
    },
    expected: {
      resourceVersion: "4",
      nativeIdentity: {
        type: "cloudflare.d1_database",
        id: "d1-native-01",
      },
    },
    transitionEvidence: {
      format: "takoform.module-form-transition@v1",
      marker: "relational-database-v2-to-v3",
      digest:
        "sha256:7106e4a5ea37f0295b9406fccc8a6f5230b2ec92cb1f629b1fc243c99aeedbe7",
    },
  };
}

function fixture(options: {
  readonly owner?: ResourceCapsuleOwner;
  readonly result?: "committed" | "prepared" | "indeterminate" | "rejected";
  readonly readbackError?: Error;
} = {}) {
  const received: unknown[] = [];
  const canonical: ResourceObject = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "RelationalDatabase",
    form: NEXT,
    metadata: {
      name: "database",
      space: "workspace_yuru",
      generation: 5,
      owner: OWNER,
      managedBy: "takoform.form-host.v1",
    },
    spec: SPEC,
    status: {
      phase: "Ready",
      observedGeneration: 5,
      resolution: {
        selectedImplementation: "cloudflare_d1",
        target: "cloudflare-main",
        locked: true,
        portability: "portable",
      },
      outputs: { portability: "portable" },
    },
  };
  const proof = {
    operationId: OPERATION_ID,
    fromForm: OLD,
    toForm: NEXT,
    resourceGeneration: 5,
    expectedResourceRevisionId: "apply-run-old",
    observedSpecDigest: `sha256:${"b".repeat(64)}` as const,
    transitionEvidenceDigest:
      "sha256:7106e4a5ea37f0295b9406fccc8a6f5230b2ec92cb1f629b1fc243c99aeedbe7" as const,
    nativeResources: [
      {
        type: "cloudflare.d1_database",
        id: "d1-native-01",
        ownership: "resource" as const,
        form: NEXT,
      },
    ],
    committed: true as const,
  };
  const formTransition = {
    async transition(input: unknown) {
      received.push(input);
      if (options.result === "rejected") {
        return {
          status: "rejected" as const,
          operationId: OPERATION_ID,
          requestDigest: REQUEST_DIGEST,
          rejectionCode: "native_transition_rejected",
        };
      }
      if (options.result === "prepared" || options.result === "indeterminate") {
        return {
          status: options.result,
          operationId: OPERATION_ID,
          requestDigest: REQUEST_DIGEST,
          dispatchAttempted: options.result === "indeterminate",
        };
      }
      return {
        status: "committed" as const,
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        resource: {
          id: "tkrn:workspace_yuru:RelationalDatabase:database",
          spaceId: "workspace_yuru",
          kind: "RelationalDatabase",
          form: NEXT,
          name: "database",
          managedBy: "takoform.form-host.v1",
          owner: OWNER,
          spec: SPEC,
          phase: "Ready",
          generation: 5,
          observedGeneration: 5,
          outputs: { portability: "portable" },
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:01.000Z",
        },
        lock: {
          resourceId: "tkrn:workspace_yuru:RelationalDatabase:database",
          form: NEXT,
          selectedImplementation: "cloudflare_d1",
          target: "cloudflare-main",
          locked: true,
          reason: ["transition"],
          portability: "portable",
          nativeResources: proof.nativeResources,
          lockedAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:01.000Z",
        },
        proof,
      };
    },
    async readback(input: unknown) {
      received.push(input);
      if (options.readbackError) throw options.readbackError;
      if (options.result === "rejected") {
        return {
          status: "rejected" as const,
          operationId: OPERATION_ID,
          requestDigest: REQUEST_DIGEST,
          rejectionCode: "native_transition_rejected",
        };
      }
      if (options.result === "prepared" || options.result === "indeterminate") {
        return {
          status: options.result,
          operationId: OPERATION_ID,
          requestDigest: REQUEST_DIGEST,
          dispatchAttempted: options.result === "indeterminate",
        };
      }
      return {
        status: "committed" as const,
        operationId: OPERATION_ID,
        requestDigest: REQUEST_DIGEST,
        resource: {
          id: "tkrn:workspace_yuru:RelationalDatabase:database",
          spaceId: "workspace_yuru",
          kind: "RelationalDatabase",
          form: NEXT,
          name: "database",
          managedBy: "takoform.form-host.v1",
          owner: OWNER,
          spec: SPEC,
          phase: "Ready",
          generation: 5,
          observedGeneration: 5,
          outputs: { portability: "portable" },
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:01.000Z",
        },
        lock: {
          resourceId: "tkrn:workspace_yuru:RelationalDatabase:database",
          form: NEXT,
          selectedImplementation: "cloudflare_d1",
          target: "cloudflare-main",
          locked: true,
          reason: ["transition"],
          portability: "portable",
          nativeResources: proof.nativeResources,
          lockedAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:01.000Z",
        },
        proof,
      };
    },
  } as unknown as ResourceFormTransitionService;
  const service = {
    async get() {
      return { ok: true as const, value: canonical };
    },
  } as unknown as ResourceShapeService;
  const app = new Hono();
  registerPortableFormHostRoutes(app, {
    service,
    availability: {
      async listFormAvailability() {
        return { items: [] };
      },
    },
    authorize: async () => ({
      ok: true,
      actor: {
        actorAccountId: "provider-run",
        workspaceId: "workspace_yuru",
        roles: ["owner"],
        scopes: ["resources:write"],
        requestId: "request-transition",
      },
    }),
    canReadForms: () => true,
    resolveResourceCapsuleOwner: async () => options.owner,
    formTransition,
  });
  return { app, received };
}

const POST_PATH =
  "/apis/forms.takoform.com/v1alpha1/resources/RelationalDatabase/database/form-transitions?space=workspace_yuru";
const GET_PATH =
  `/apis/forms.takoform.com/v1alpha1/resources/RelationalDatabase/database/form-transitions/${OPERATION_ID}?space=workspace_yuru`;

test("discovery advertises transition only for an explicitly composed host", async () => {
  const { app } = fixture({ owner: OWNER });
  const response = await app.request("https://host.test/.well-known/takoform");
  expect(response.status).toBe(200);
  expect((await response.json()).features.resource_form_transition).toBe(true);
});

test("POST accepts only the closed exact request and returns structured proof", async () => {
  const { app, received } = fixture({ owner: OWNER });
  const response = await app.request(POST_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": OPERATION_ID,
      "if-match": '"4"',
    },
    body: JSON.stringify(transitionBody()),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.operation).toEqual({
    operationId: OPERATION_ID,
    status: "committed",
    requestDigest: REQUEST_DIGEST,
    reconcilePath: GET_PATH,
  });
  expect(body.resource.form).toEqual(wireForm(NEXT));
  expect(body.resource.metadata.resourceVersion).toBe("5");
  expect(body.transitionProof).toMatchObject({
    operationId: OPERATION_ID,
    fromForm: wireForm(OLD),
    toForm: wireForm(NEXT),
    transitionEvidenceDigest:
      transitionBody().transitionEvidence.digest,
    nativeIdentity: {
      type: "cloudflare.d1_database",
      id: "d1-native-01",
    },
    resourceVersion: "5",
    committed: true,
  });
  expect(received).toHaveLength(1);
  expect(JSON.stringify(received[0])).not.toContain("ownerId");
});

test("GET performs exact operation readback without accepting desired state", async () => {
  const { app, received } = fixture({ owner: OWNER });
  const response = await app.request(GET_PATH);
  expect(response.status).toBe(200);
  expect((await response.json()).operation.status).toBe("committed");
  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({
    workspaceId: OWNER.workspaceId,
    spaceId: OWNER.workspaceId,
    kind: "RelationalDatabase",
    name: "database",
    owner: OWNER,
    operationId: OPERATION_ID,
  });
});

test("GET exposes the finite preflight states and only exact absent permits POST", async () => {
  for (const status of ["prepared", "indeterminate"] as const) {
    const { app } = fixture({ owner: OWNER, result: status });
    const response = await app.request(GET_PATH);
    expect(response.status).toBe(202);
    expect((await response.json()).operation).toEqual({
      operationId: OPERATION_ID,
      status,
      requestDigest: REQUEST_DIGEST,
      reconcilePath: GET_PATH,
      dispatchAttempted: status === "indeterminate",
    });
  }

  const rejected = fixture({ owner: OWNER, result: "rejected" });
  const failed = await rejected.app.request(GET_PATH);
  expect(failed.status).toBe(409);
  expect((await failed.json()).error).toMatchObject({
    code: "form_identity_conflict",
    hostCode: "native_transition_rejected",
    retryable: false,
    details: {
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      status: "failed",
      failureCode: "native_transition_rejected",
    },
  });

  const absent = fixture({
    owner: OWNER,
    readbackError: new ResourceFormTransitionError(
      "operation_not_found",
      "operation absent",
    ),
  });
  const notFound = await absent.app.request(GET_PATH);
  expect(notFound.status).toBe(404);
  expect((await notFound.json()).error).toMatchObject({
    code: "resource_not_found",
    hostCode: "form_transition_operation_not_found",
    retryable: false,
  });
});

test("missing marker, widened body/query, idempotency mismatch, and missing owner fail before domain", async () => {
  const invalidCases = [
    {
      body: { ...transitionBody(), unexpected: true },
      path: POST_PATH,
      key: OPERATION_ID,
    },
    {
      body: {
        ...transitionBody(),
        transitionEvidence: {
          format: "takoform.module-form-transition@v1",
          digest: transitionBody().transitionEvidence.digest,
        },
      },
      path: POST_PATH,
      key: OPERATION_ID,
    },
    {
      body: (() => {
        const { expected: _expected, ...body } = transitionBody();
        return body;
      })(),
      path: POST_PATH,
      key: OPERATION_ID,
    },
    {
      body: {
        ...transitionBody(),
        expected: { nativeIdentity: transitionBody().expected.nativeIdentity },
      },
      path: POST_PATH,
      key: OPERATION_ID,
    },
    {
      body: {
        ...transitionBody(),
        resource: {
          ...transitionBody().resource,
          metadata: {
            name: transitionBody().resource.metadata.name,
            space: transitionBody().resource.metadata.space,
          },
        },
      },
      path: POST_PATH,
      key: OPERATION_ID,
    },
    {
      body: transitionBody(),
      path: `${POST_PATH}&force=true`,
      key: OPERATION_ID,
    },
    {
      body: transitionBody(),
      path: POST_PATH,
      key: `formtx_${"2".repeat(64)}`,
    },
  ];
  for (const candidate of invalidCases) {
    const { app, received } = fixture({ owner: OWNER });
    const response = await app.request(candidate.path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": candidate.key,
        "if-match": '"4"',
      },
      body: JSON.stringify(candidate.body),
    });
    expect(response.status).toBe(400);
    expect(received).toHaveLength(0);
  }

  for (const ifMatch of [undefined, '"3"'] as const) {
    const { app, received } = fixture({ owner: OWNER });
    const headers = new Headers({
      "content-type": "application/json",
      "idempotency-key": OPERATION_ID,
    });
    if (ifMatch !== undefined) headers.set("if-match", ifMatch);
    const response = await app.request(POST_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify(transitionBody()),
    });
    expect(response.status).toBe(412);
    expect(received).toHaveLength(0);
  }

  const ownerless = fixture();
  const response = await ownerless.app.request(POST_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": OPERATION_ID,
      "if-match": '"4"',
    },
    body: JSON.stringify(transitionBody()),
  });
  expect(response.status).toBe(403);
  expect(ownerless.received).toHaveLength(0);
});
