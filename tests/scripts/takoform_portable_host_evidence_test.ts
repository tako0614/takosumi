import { expect, test } from "bun:test";

import {
  createTakoformPortableHostEvidenceAdapter,
  TAKOFORM_AUTHORIZATION_PROBE_HEADER,
  TAKOFORM_ERROR_PROBE_HEADER,
  TAKOFORM_RAW_JSON_PROBE_DUPLICATE_ERROR_CODE,
  TAKOFORM_RAW_JSON_PROBE_HEADER,
  type TakoformPortableHostEvidenceAdapterOptions,
} from "../../scripts/lib/takoform-portable-host-evidence.ts";
import { parseCanonicalJson } from "../../core/adapters/takoform/canonical_json.ts";

const API = "/apis/forms.takoform.com/v1alpha1";
const EXACT_FORM = {
  type: "object_bucket",
  version: "3.0.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
  packageDigest: `sha256:${"2".repeat(64)}`,
} as const;

function createTestAdapter(
  options: Omit<
    TakoformPortableHostEvidenceAdapterOptions,
    "authorizeBearer" | "validatePlanBinding"
  > & {
    readonly authorizeBearer?:
      TakoformPortableHostEvidenceAdapterOptions["authorizeBearer"];
    readonly validatePlanBinding?:
      TakoformPortableHostEvidenceAdapterOptions["validatePlanBinding"];
  },
): (request: Request) => Promise<Response> {
  const { authorizeBearer, validatePlanBinding, ...rest } = options;
  const fetch = createTakoformPortableHostEvidenceAdapter({
    ...rest,
    authorizeBearer:
      authorizeBearer ??
      (async () => ({ tenant: "test", principal: "primary" })),
    validatePlanBinding: validatePlanBinding ?? (async () => true),
  });
  return (request) => {
    const url = new URL(request.url);
    if (
      (url.pathname === API || url.pathname.startsWith(`${API}/`)) &&
      request.headers.get("authorization") === null
    ) {
      const headers = new Headers(request.headers);
      headers.set("authorization", "Bearer primary");
      return fetch(new Request(request, { headers }));
    }
    return fetch(request);
  };
}

test("portable host evidence adapter closes discovery to the runner origin", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json({
        api_versions: ["forms.takoform.com/v1alpha1"],
        protocols: ["forms.takoform.com/v1alpha1"],
        features: {
          service_forms: true,
          exact_form_ref: true,
          optimistic_concurrency: true,
          idempotent_lifecycle: true,
          interface_declarations: true,
          internal_extension: true,
        },
        endpoints: {
          api: "http://internal.test/apis/forms.takoform.com/v1alpha1",
          forms:
            "http://internal.test/apis/forms.takoform.com/v1alpha1/forms",
          interfaces:
            "http://internal.test/apis/forms.takoform.com/v1alpha1/interfaces",
          capabilities: "http://internal.test/api/v1/capabilities",
        },
      }),
    readResource: async () => undefined,
  });

  const response = await fetch(
    new Request("http://127.0.0.1:43210/.well-known/takoform"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    api_versions: ["forms.takoform.com/v1alpha1"],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      interface_declarations: true,
    },
    endpoints: {
      api: `http://127.0.0.1:43210${API}`,
      forms: `http://127.0.0.1:43210${API}/forms`,
      interfaces: `http://127.0.0.1:43210${API}/interfaces`,
    },
  });
});

test("portable host evidence accepts discovery without Form Definition support", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json({
        api_versions: ["forms.takoform.com/v1alpha1"],
        features: {
          service_forms: true,
          exact_form_ref: true,
          optimistic_concurrency: true,
          idempotent_lifecycle: true,
          interface_declarations: true,
        },
        endpoints: {
          api: `http://internal.test${API}`,
          forms: `http://internal.test${API}/forms`,
          interfaces: `http://internal.test${API}/interfaces`,
        },
      }),
    readResource: async () => undefined,
  });

  const response = await fetch(
    new Request("http://host.test/.well-known/takoform"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    api_versions: ["forms.takoform.com/v1alpha1"],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      interface_declarations: true,
    },
    endpoints: {
      api: `http://host.test${API}`,
      forms: `http://host.test${API}/forms`,
      interfaces: `http://host.test${API}/interfaces`,
    },
  });
});

test("portable host evidence probes are runner-only and fence validation stays canonical", async () => {
  let delegated = 0;
  const fetch = createTestAdapter({
    fetch: async (request) => {
      delegated += 1;
      if (request.headers.has("if-match")) {
        return Response.json(
          {
            error: {
              code: "invalid_argument",
              message: "If-Match exceeds the canonical Resource serial range",
            },
          },
          { status: 400 },
        );
      }
      return Response.json(
        {
          error: {
            code: "resource_version_conflict",
            message: "a canonical Resource write fence is required",
          },
        },
        { status: 412 },
      );
    },
    readResource: async () => undefined,
  });

  const probed = await fetch(
    new Request(`http://host.test${API}/resources/preview`, {
      method: "POST",
      headers: { [TAKOFORM_ERROR_PROBE_HEADER]: "backend_unavailable" },
    }),
  );
  expect(probed.status).toBe(503);
  expect(await probed.json()).toEqual({
    error: {
      code: "backend_unavailable",
      message: "portable host evidence probe requested backend_unavailable",
      requestId: "req_takoform_portable_host_evidence",
      retryable: true,
    },
  });

  for (const [probe, status, code] of [
    ["credential-revoked", 401, "unauthenticated"],
    ["permission-revoked", 403, "permission_denied"],
    ["policy-revoked", 403, "policy_denied"],
  ] as const) {
    const revoked = await fetch(
      new Request(`http://host.test${API}/resources/preview`, {
        method: "POST",
        headers: { [TAKOFORM_AUTHORIZATION_PROBE_HEADER]: probe },
      }),
    );
    expect(revoked.status).toBe(status);
    expect(await revoked.json()).toMatchObject({
      error: { code, retryable: false },
    });
  }

  const outOfRange = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket`,
      {
        method: "PUT",
        headers: { "if-match": '"9223372036854775808"' },
      },
    ),
  );
  expect(outOfRange.status).toBe(400);
  expect(await outOfRange.json()).toMatchObject({
    error: { code: "invalid_argument" },
  });

  const missingFence = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket`,
      { method: "PUT" },
    ),
  );
  expect(missingFence.status).toBe(412);
  expect(await missingFence.json()).toMatchObject({
    error: { code: "resource_version_conflict" },
  });
  expect(delegated).toBe(2);
});

test("portable host evidence authenticates before probes or state lookup", async () => {
  let delegated = 0;
  let read = 0;
  const fetch = createTakoformPortableHostEvidenceAdapter({
    authorizeBearer: async ({ token }) =>
      token === "valid"
        ? { tenant: "tenant-a", principal: "principal-a" }
        : undefined,
    fetch: async () => {
      delegated += 1;
      return new Response(null, { status: 204 });
    },
    readResource: async () => {
      read += 1;
      return undefined;
    },
    validatePlanBinding: async () => {
      throw new Error("unauthenticated request must not validate a plan");
    },
  });
  const response = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket?space=space-1`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer invalid",
          "idempotency-key": "portable-apply-create",
          "if-none-match": "*",
          [TAKOFORM_ERROR_PROBE_HEADER]: "backend_unavailable",
        },
        body: "{}",
      },
    ),
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { code: "unauthenticated" },
  });
  expect(delegated).toBe(0);
  expect(read).toBe(0);
});

test("portable host evidence emits the exact duplicate response probe as raw JSON", async () => {
  const fetch = createTestAdapter({
    fetch: async () => {
      throw new Error("raw response probe must not delegate");
    },
    readResource: async () => undefined,
  });
  const response = await fetch(
    new Request(`http://host.test${API}/resources/preview`, {
      method: "POST",
      headers: {
        [TAKOFORM_RAW_JSON_PROBE_HEADER]:
          TAKOFORM_RAW_JSON_PROBE_DUPLICATE_ERROR_CODE,
      },
    }),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());

  expect(response.status).toBe(400);
  expect(() => parseCanonicalJson(bytes)).toThrow("duplicate JSON object name");
});

test("portable host evidence adapter closes Interface queries and wire shape", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json({
        interfaces: [
          {
            name: "object.storage",
            version: "1",
            resource: { kind: "ObjectBucket", name: "object-bucket" },
            document: { operations: ["delete", "get", "list", "put"] },
            documentSchema: { type: "object" },
            inputs: [],
            values: {
              resource: "ObjectBucket/object-bucket",
              name: "object-bucket",
            },
            resourceVersion: "1",
            form: EXACT_FORM,
          },
        ],
      }),
    readResource: async () => undefined,
  });

  const unknown = await fetch(
    new Request(`http://host.test${API}/interfaces?space=space-1&unknown=1`),
  );
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({
    error: { code: "invalid_argument" },
  });

  const boundaryWhitespace = await fetch(
    new Request(`http://host.test${API}/interfaces?space=+space-1`),
  );
  expect(boundaryWhitespace.status).toBe(400);
  expect(await boundaryWhitespace.json()).toMatchObject({
    error: { code: "invalid_argument" },
  });

  const response = await fetch(
    new Request(`http://host.test${API}/interfaces?space=space-1`),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    interfaces: [
      {
        name: "object.storage",
        version: "1",
        resource: { kind: "ObjectBucket", name: "object-bucket" },
        document: { operations: ["delete", "get", "list", "put"] },
        values: {
          resource: "ObjectBucket/object-bucket",
          name: "object-bucket",
        },
        form: {
          formRef: {
            apiVersion: "forms.takoform.com/v1alpha1",
            kind: "ObjectBucket",
            definitionVersion: "3.0.0",
            schemaDigest: EXACT_FORM.schemaDigest,
          },
          packageDigest: EXACT_FORM.packageDigest,
        },
      },
    ],
  });
});

test("portable host evidence projects canonical Resource outputs without authority fields", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json(
        {
          apiVersion: "forms.takoform.com/v1alpha1",
          kind: "ObjectBucket",
          form: {
            formRef: {
              apiVersion: "forms.takoform.com/v1alpha1",
              kind: "ObjectBucket",
              definitionVersion: "3.0.0",
              schemaDigest: EXACT_FORM.schemaDigest,
            },
            packageDigest: EXACT_FORM.packageDigest,
          },
          metadata: {
            name: "object-bucket",
            space: "space-1",
            resourceVersion: "2",
          },
          spec: {
            accessProtocols: ["s3_api"],
            name: "object-bucket",
            storageClass: "standard",
            versioning: true,
          },
          status: {
            phase: "Ready",
            observedGeneration: 2,
            portability: "portable",
          },
          id: "tkrn:space-1:ObjectBucket:object-bucket",
        },
        { headers: { etag: '"2"' } },
      ),
    readResource: async () => ({
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "ObjectBucket",
      form: EXACT_FORM,
      metadata: {
        name: "object-bucket",
        space: "space-1",
        generation: 2,
      },
      spec: {},
      status: {
        phase: "Ready",
        observedGeneration: 2,
        outputs: {
          generation: 2,
          id: "ObjectBucket/object-bucket",
          kind: "ObjectBucket",
          name: "object-bucket",
          portability: "portable",
        },
      },
    }),
  });

  const response = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket?space=space-1`,
    ),
  );
  expect(response.headers.get("etag")).toBe('"2"');
  expect(await response.json()).toMatchObject({
    status: {
      observed: {
        driftedFields: [],
        generation: 2,
        id: "ObjectBucket/object-bucket",
        imported: false,
        portability: "portable",
        ready: true,
      },
      output: {
        generation: 2,
        id: "ObjectBucket/object-bucket",
        kind: "ObjectBucket",
        name: "object-bucket",
        portability: "portable",
      },
    },
  });
});

test("portable host evidence recomputes the portable preview spec digest", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json({
        resource: {
          apiVersion: "forms.takoform.com/v1alpha1",
          kind: "ObjectBucket",
          form: {
            formRef: {
              apiVersion: "forms.takoform.com/v1alpha1",
              kind: "ObjectBucket",
              definitionVersion: "3.0.0",
              schemaDigest: EXACT_FORM.schemaDigest,
            },
            packageDigest: EXACT_FORM.packageDigest,
          },
          metadata: {
            name: "object-bucket",
            space: "space-1",
          },
          spec: { name: "object-bucket" },
        },
        review: {
          planDigest: `sha256:${"3".repeat(64)}`,
          specDigest: `sha256:${"4".repeat(64)}`,
        },
      }),
    readResource: async () => undefined,
  });

  const response = await fetch(
    new Request(`http://host.test${API}/resources/preview`, {
      method: "POST",
    }),
  );
  expect(await response.json()).toMatchObject({
    review: {
      planDigest: `sha256:${"3".repeat(64)}`,
      specDigest:
        "sha256:6e1e8988460394ad2f09d31b0a129ba5c2a4102b6c5ac808a82ad0007c741c04",
    },
  });
});

test("portable host evidence maps an exact valid stale fence to precondition failure", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "invalid_argument",
            message:
              "metadata.resourceVersion does not match the HTTP precondition",
          },
        },
        { status: 400 },
      ),
    readResource: async () => undefined,
  });

  const response = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket?space=space-1`,
      {
        method: "PUT",
        headers: { "if-match": '"9223372036854775807"' },
      },
    ),
  );
  expect(response.status).toBe(412);
  expect(await response.json()).toMatchObject({
    error: { code: "resource_version_conflict", retryable: false },
  });
});

test("portable host evidence maps a reviewed plan substitution to invalid argument", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "unavailable",
            hostCode: "deployment_plan_changed",
            message: "portable form operation was rejected",
          },
        },
        { status: 503 },
      ),
    readResource: async () => undefined,
  });

  const response = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket`,
      {
        method: "PUT",
        headers: { "if-none-match": "*" },
      },
    ),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: "invalid_argument",
      hostCode: "deployment_plan_changed",
      retryable: false,
    },
  });
});

test("portable host evidence maps a missing portable Connection target", async () => {
  const fetch = createTestAdapter({
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "unavailable",
            hostCode: "connection_not_found",
            message: "portable form operation was rejected",
          },
        },
        { status: 503 },
      ),
    readResource: async () => undefined,
  });
  const response = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectLifecycleRule/rule`,
      {
        method: "PUT",
        headers: { "if-none-match": "*" },
      },
    ),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: { code: "resource_not_found", hostCode: "connection_not_found" },
  });
});

test("portable host evidence instruments the exact reviewed plan without mutation", async () => {
  const planDigest = `sha256:${"3".repeat(64)}`;
  const resource = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    form: {
      formRef: {
        apiVersion: "forms.takoform.com/v1alpha1",
        kind: "ObjectBucket",
        definitionVersion: "3.0.0",
        schemaDigest: EXACT_FORM.schemaDigest,
      },
      packageDigest: EXACT_FORM.packageDigest,
    },
    metadata: {
      name: "object-bucket",
      space: "space-1",
    },
    spec: { name: "object-bucket" },
  };
  const delegated: string[] = [];
  const validatedApiVersions: string[] = [];
  const fetch = createTestAdapter({
    fetch: async (request) => {
      delegated.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "POST") {
        return Response.json({
          resource,
          review: {
            planDigest,
            specDigest: `sha256:${"4".repeat(64)}`,
          },
        });
      }
      return Response.json({ forms: [] });
    },
    readResource: async () => undefined,
    validatePlanBinding: async ({ authorization, resource, planDigest: seen }) => {
      expect(authorization).toBe("Bearer primary");
      expect(seen).toBe(planDigest);
      const apiVersion =
        typeof resource.apiVersion === "string" ? resource.apiVersion : "";
      validatedApiVersions.push(apiVersion);
      return apiVersion === "forms.takoform.com/v1alpha1";
    },
  });
  await fetch(
    new Request(`http://host.test${API}/resources/preview`, {
      method: "POST",
      headers: { authorization: "Bearer primary" },
      body: JSON.stringify(resource),
    }),
  );

  const rejected = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket?space=space-1`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer primary",
          "if-none-match": "*",
          "Takoform-Conformance-Probe-Plan-Binding": "resource.apiVersion",
        },
        body: JSON.stringify({
          ...resource,
          apiVersion: "forms.takoform.com/v0",
          review: { planDigest },
        }),
      },
    ),
  );
  expect(rejected.status).toBe(400);
  expect(
    rejected.headers.get("Takoform-Conformance-Probe-Plan-Binding-Result"),
  ).toBe("rejected");

  const accepted = await fetch(
    new Request(
      `http://host.test${API}/resources/ObjectBucket/object-bucket?space=space-1`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer primary",
          "if-none-match": "*",
          "Takoform-Conformance-Probe-Plan-Binding": "resource.apiVersion",
        },
        body: JSON.stringify({
          ...resource,
          review: { planDigest },
        }),
      },
    ),
  );
  expect(accepted.status).toBe(204);
  expect(
    accepted.headers.get("Takoform-Conformance-Probe-Plan-Binding-Result"),
  ).toBe("accepted-no-mutation");
  expect(delegated).toEqual([
    `POST ${API}/resources/preview`,
    `GET ${API}/forms`,
    `GET ${API}/forms`,
  ]);
  expect(validatedApiVersions).toEqual([
    "forms.takoform.com/v0",
    "forms.takoform.com/v1alpha1",
  ]);
});

test("portable host evidence delegates the external Idempotency-Key unchanged", async () => {
  const delegatedKeys: string[] = [];
  const fetch = createTestAdapter({
    fetch: async (request) => {
      delegatedKeys.push(request.headers.get("idempotency-key") ?? "");
      return new Response(null, { status: 204 });
    },
    readResource: async (space) => ({
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "ObjectBucket",
      metadata: {
        name: "object-bucket",
        space,
        generation: 1,
      },
      spec: {},
    }),
  });
  const invoke = (token: string, space: string) =>
    fetch(
      new Request(
        `http://host.test${API}/resources/ObjectBucket/object-bucket?space=${space}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": "same-external-key",
            "if-match": '"1"',
          },
        },
      ),
    );

  await invoke("primary", "space-1");
  await invoke("primary", "space-1");
  await invoke("alternate", "space-1");
  await invoke("primary", "space-2");

  expect(delegatedKeys[0]).toBe(delegatedKeys[1]);
  expect(delegatedKeys).toEqual(Array(4).fill("same-external-key"));
});

test("portable host evidence does not synthesize cross-principal replay outcomes", async () => {
  let delegated = 0;
  const fetch = createTestAdapter({
    fetch: async () => {
      delegated += 1;
      return new Response(null, { status: 204 });
    },
    readResource: async () => {
      throw new Error("adapter must not consult Resource state for replay");
    },
  });
  const invoke = (token: string) =>
    fetch(
      new Request(
        `http://host.test${API}/resources/ObjectBucket/object-bucket`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": "portable-apply-create",
            "if-none-match": "*",
          },
          body: JSON.stringify({
            apiVersion: "forms.takoform.com/v1alpha1",
            kind: "ObjectBucket",
            metadata: { name: "object-bucket", space: "space-1" },
            spec: { name: "object-bucket" },
            review: { planDigest: `sha256:${"3".repeat(64)}` },
          }),
        },
      ),
    );

  expect((await invoke("primary")).status).toBe(204);
  expect((await invoke("primary")).status).toBe(204);
  expect((await invoke("alternate")).status).toBe(204);
  expect(delegated).toBe(3);
});

test("portable host evidence source forbids lifecycle compensation", async () => {
  const adapterSource = await Bun.file(
    new URL(
      "../../scripts/lib/takoform-portable-host-evidence.ts",
      import.meta.url,
    ),
  ).text();
  const compositionSource = await Bun.file(
    new URL("../../scripts/standard-form-host-report.ts", import.meta.url),
  ).text();

  for (const forbidden of [
    "successfulIdempotencyFingerprints",
    "syntheticReplayResponses",
    "reviewedPlans",
    "updateExistingImport",
    "scopeRunnerIdempotencyKey",
    "portableApplyPlanMismatch",
    "runnerRequestFingerprint",
    "nativeId",
  ]) {
    expect(adapterSource).not.toContain(forbidden);
  }
  expect(adapterSource).toContain("readonly validatePlanBinding:");
  expect(compositionSource).toContain(
    "service.validateDeploymentReview(request,",
  );
});
