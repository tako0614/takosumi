import { expect, test } from "bun:test";

import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsInstallationExportBundle,
  type AppBindingKind,
  type AppBindingMaterializationResult,
  buildInstallationExportBundle,
  createAccountsHandler as createRawAccountsHandler,
  createEphemeralAccountsHandler,
  createOpenManagedOfferingAccessPolicy,
  customOidcOAuthProvider,
  InMemorySharedCellWarmPool,
} from "./mod.ts";
import { type AccountsStore, InMemoryAccountsStore } from "./store.ts";
import { handleUserInfo } from "./oidc-routes.ts";
import {
  type InstallationRoute,
  matchDashboardInstallationRoute,
  matchInstallationRoute,
} from "./route-matchers.ts";

const textEncoder = new TextEncoder();
const testIssuer = "https://accounts.example.test";
const launchPairwiseSubjectSecret = "launch-pairwise-secret";
const testManagedOfferingOpenAccess = createOpenManagedOfferingAccessPolicy(
  {
    evidenceRef: "vault://managed-readiness/staging/rehearsal.json",
    approvalRef: "approval://managed-readiness/staging/operator-approval.json",
    publicSummary: "P0 evidence and one staged launch rehearsal passed.",
  },
  {
    ready: true,
    evidenceDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
);

type TestAccountsHandlerOptions = Parameters<
  typeof createRawAccountsHandler
>[0];

function createAccountsHandler(
  options: TestAccountsHandlerOptions = {},
) {
  const store = options.store ?? new InMemoryAccountsStore();
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    ...options,
    store,
  });
  return async (request: Request): Promise<Response> =>
    await handler(await withTestAppInstallationAuth(request, store));
}

function seedAccountSession(
  store: InMemoryAccountsStore,
  subject: TakosumiSubject = "tsub_owner",
  sessionId = `sess_${subject}`,
): string {
  const now = Date.now();
  store.saveAccount({
    subject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return sessionId;
}

function seedOwnedSpace(
  store: InMemoryAccountsStore,
  subject: TakosumiSubject = "tsub_owner",
  accountId = "acct_1",
  spaceId = "space_1",
): void {
  const now = Date.now();
  store.saveLedgerAccount({
    accountId,
    legalOwnerSubject: subject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveSpace({
    spaceId,
    accountId,
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
}

function accountSessionHeaders(sessionId: string): HeadersInit {
  return { authorization: `Bearer ${sessionId}` };
}

async function withTestAppInstallationAuth(
  request: Request,
  store: AccountsStore,
): Promise<Request> {
  if (request.headers.has("authorization")) return request;
  const subject = await appInstallationAuthSubjectForTest(request, store);
  if (!subject) return request;
  const sessionId = await seedGenericAccountSession(store, subject);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${sessionId}`);
  return new Request(request, { headers });
}

async function appInstallationAuthSubjectForTest(
  request: Request,
  store: AccountsStore,
): Promise<TakosumiSubject | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/installations" && request.method === "POST") {
    const body = await jsonRecordForTest(request.clone());
    return testSubjectValue(body?.createdBySubject);
  }
  if (
    url.pathname === "/v1/installations/import" && request.method === "POST"
  ) {
    const body = await jsonRecordForTest(request.clone());
    return testSubjectValue(body?.createdBySubject ?? body?.subject);
  }
  const route = matchInstallationRoute(url.pathname);
  if (route) {
    if (!testInstallationRouteNeedsAccountBearer(route.kind, request.method)) {
      return undefined;
    }
    const installation = await store.findAppInstallation(route.installationId);
    if (!installation) return undefined;
    // Round 2: with the createdBySubject access fallback removed, tests that
    // exercise per-installation handlers must seed the LedgerAccount as well
    // so `subjectCanAccessAccount` resolves through `legalOwnerSubject`.
    // We backfill the LedgerAccount lazily to keep existing test fixtures
    // working without rewriting every test case.
    await ensureLedgerAccountForTest(
      store,
      installation.accountId,
      installation.createdBySubject,
    );
    return installation.createdBySubject;
  }
  const dashboardRoute = matchDashboardInstallationRoute(url.pathname);
  if (dashboardRoute) {
    const installation = await store.findAppInstallation(
      dashboardRoute.installationId,
    );
    if (!installation) return undefined;
    await ensureLedgerAccountForTest(
      store,
      installation.accountId,
      installation.createdBySubject,
    );
    return installation.createdBySubject;
  }
  if (
    url.pathname === "/dashboard/installations" && request.method === "GET"
  ) {
    const spaceId = url.searchParams.get("space_id") ??
      url.searchParams.get("spaceId");
    if (!spaceId) return undefined;
    const space = await store.findSpace(spaceId);
    return space
      ? (await store.findLedgerAccount(space.accountId))?.legalOwnerSubject
      : undefined;
  }
  if (url.pathname === "/dashboard/install") {
    const spaceId = request.method === "POST"
      ? await dashboardSpaceIdForTest(request.clone())
      : url.searchParams.get("space_id") ??
        url.searchParams.get("spaceId") ??
        url.searchParams.get("space");
    if (!spaceId) return undefined;
    const space = await store.findSpace(spaceId);
    return space
      ? (await store.findLedgerAccount(space.accountId))?.legalOwnerSubject
      : undefined;
  }
}

async function dashboardSpaceIdForTest(
  request: Request,
): Promise<string | undefined> {
  try {
    const formData = await request.formData();
    const value = formData.get("space_id") ??
      formData.get("spaceId") ??
      formData.get("space");
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function testInstallationRouteNeedsAccountBearer(
  kind: InstallationRoute["kind"],
  method: string,
): boolean {
  if (kind === "billing-usage-reports") return false;
  if (kind === "installation" && method === "GET") return false;
  if (kind === "installation" && method === "DELETE") return true;
  if (kind === "status" && method === "PATCH") return true;
  if (
    method === "POST" &&
    (kind === "deployment" ||
      kind === "deployment-dry-run" ||
      kind === "rollback" ||
      kind === "materialize" ||
      kind === "export")
  ) {
    return true;
  }
  return method === "GET" &&
    (kind === "events" ||
      kind === "export-operation" ||
      kind === "export-download");
}

/**
 * Backfill a LedgerAccount with `legalOwnerSubject = subject` for the
 * given accountId, only when one is not already present. Tests created
 * before the `createdBySubject` access fallback was removed (Round 2) rely
 * on the test-helper to seed the LedgerAccount too so `subjectCanAccessAccount`
 * resolves correctly without forcing every fixture to be rewritten.
 */
async function ensureLedgerAccountForTest(
  store: AccountsStore,
  accountId: string,
  subject: TakosumiSubject,
): Promise<void> {
  const existing = await store.findLedgerAccount(accountId);
  if (existing) return;
  const now = Date.now();
  await store.saveLedgerAccount({
    accountId,
    legalOwnerSubject: subject,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedGenericAccountSession(
  store: AccountsStore,
  subject: TakosumiSubject,
): Promise<string> {
  const now = Date.now();
  if (!await store.findAccount(subject)) {
    await store.saveAccount({ subject, createdAt: now, updatedAt: now });
  }
  const sessionId = `sess_test_${subject}_${
    crypto.randomUUID().replaceAll(
      "-",
      "",
    )
  }`;
  await store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return sessionId;
}

async function jsonRecordForTest(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function testSubjectValue(value: unknown): TakosumiSubject | undefined {
  return typeof value === "string" && value.startsWith("tsub_")
    ? value as TakosumiSubject
    : undefined;
}

async function testPermissionDigest(input: {
  useEdgeKinds: readonly string[];
  permissionScopes: readonly string[];
}): Promise<string> {
  return await testSha256HexDigest({
    useEdgeKinds: [...input.useEdgeKinds].sort(),
    permissionScopes: [...input.permissionScopes].sort(),
  });
}

async function testMaterializePermissionDigest(input: {
  installationId: string;
  region: string;
  plan?: Record<string, unknown>;
  cutover?: Record<string, unknown>;
}): Promise<string> {
  return await testSha256HexDigest({
    operation: "materialize",
    installationId: input.installationId,
    mode: "dedicated",
    region: input.region,
    plan: input.plan ?? {},
    cutover: input.cutover ?? {},
  });
}

async function testRevisionPermissionDigest(input: {
  operation: "deployment" | "rollback";
  installationId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planSnapshotDigest: string;
  artifactDigest?: string | null;
  requestedBindings?: readonly Record<string, unknown>[];
  requestedGrants?: readonly Record<string, unknown>[];
}): Promise<string> {
  return await testSha256HexDigest({
    operation: input.operation,
    installationId: input.installationId,
    appId: input.appId,
    source: {
      gitUrl: input.sourceGitUrl.trim().replace(/\/+$/, "").replace(
        /\.git$/,
        "",
      ),
      ref: input.sourceRef,
      commit: input.sourceCommit,
      planSnapshotDigest: input.planSnapshotDigest,
      artifactDigest: input.artifactDigest ?? null,
    },
    requestedBindings: [...(input.requestedBindings ?? [])].sort(
      compareCanonicalJson,
    ),
    requestedGrants: [...(input.requestedGrants ?? [])].sort(
      compareCanonicalJson,
    ),
  });
}

async function testSha256HexDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson(value)),
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function compareCanonicalJson(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value ?? null);
}

test("accounts handler serves OIDC discovery", async () => {
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
  });
  const response = await handler(
    new Request(
      "https://accounts.example.test/.well-known/openid-configuration",
    ),
  );
  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.issuer).toEqual("https://accounts.example.test");
  expect(body.jwks_uri).toEqual("https://accounts.example.test/oauth/jwks");
});

test("accounts handler serves JWKS", async () => {
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    jwks: {
      keys: [{
        kty: "EC",
        crv: "P-256",
        kid: "test-key",
        use: "sig",
        alg: "ES256",
        x: "x",
        y: "y",
      }],
    },
  });
  const response = await handler(
    new Request("https://accounts.example.test/oauth/jwks"),
  );
  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.keys[0].kid).toEqual("test-key");
});

test("accounts handler does not expose a service descriptor anchor", async () => {
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
  });
  const response = await handler(
    new Request("https://accounts.example.test/v1/services"),
  );

  expect(response.status).toEqual(404);
});

test("accounts handler proxies installation dry-run to installer", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const sessionId = seedAccountSession(store, "tsub_owner");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "installer-secret",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "v1.2.3",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          planSnapshotDigest: "sha256:abc",
          changes: [],
          expected: {
            commit: "0123456789abcdef0123456789abcdef01234567",
            planSnapshotDigest: "sha256:abc",
          },
        }));
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations/dry-run", {
      method: "POST",
      headers: {
        ...accountSessionHeaders(sessionId),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: "space_1",
        source: {
          kind: "git",
          url: "https://github.com/example/hello",
          ref: "v1.2.3",
        },
      }),
    }),
  );

  expect(response.status).toEqual(200);
  expect((await response.json()).planSnapshotDigest).toEqual("sha256:abc");
  expect(proxiedRequests.length).toEqual(1);
  expect(proxiedRequests[0].url).toEqual("http://takosumi.internal:8788/v1/installations/dry-run");
  expect(proxiedRequests[0].headers.get("authorization")).toEqual("Bearer installer-secret");
  expect(await proxiedRequests[0].json()).toEqual({
    spaceId: "space_1",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "v1.2.3",
    },
  });
});

test("accounts handler applies installation through space installer when configured", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_core_apply", "acct_core_apply", "space_core");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "installer-secret",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_core_apply",
            spaceId: "space_core",
            appId: "example.hello",
            currentDeploymentId: "dep_core_apply",
            status: "ready",
            createdAt: 1,
          },
          deployment: {
            id: "dep_core_apply",
            installationId: "inst_core_apply",
            source: {
              kind: "git",
              url: "https://github.com/example/hello",
              ref: "main",
              commit: "0123456789abcdef0123456789abcdef01234567",
            },
            planSnapshotDigest: "sha256:abc",
            status: "succeeded",
            outputs: {
              components: {
                public: {
                  url: "https://hello.example.test",
                  host: "hello.example.test",
                  scheme: "https",
                  listener: "public",
                },
              },
            },
            createdAt: 1,
          },
        }, { status: 201 }));
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_core_apply",
        spaceId: "space_core",
        source: {
          kind: "git",
          url: "https://github.com/example/hello",
          ref: "main",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_core_apply",
      }),
    }),
  );

  expect(response.status).toEqual(202);
  expect(response.headers.get("location")).toEqual("/v1/installations/inst_core_apply");
  const body = await response.json();
  expect(body.installation.id).toEqual("inst_core_apply");
  expect(body.installation.status).toEqual("ready");
  expect(body.installation.app_id).toEqual("example.hello");
  expect(body.installation.launch_url).toEqual("https://hello.example.test");
  expect(body.installation.launch.url).toEqual("https://hello.example.test");
  expect(body.launch.url).toEqual("https://hello.example.test");
  expect(store.findAppInstallation("inst_core_apply")?.sourceCommit).toEqual("0123456789abcdef0123456789abcdef01234567");
  const ownerSession = seedAccountSession(
    store,
    "tsub_core_apply",
    "sess_core_apply_owner",
  );
  const detailResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_core_apply",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(detailResponse.status).toEqual(200);
  const detail = await detailResponse.json();
  expect(detail.installation.launch.activationEvidenceId).toEqual("dep_core_apply");
  expect(store.listInstallationEvents("inst_core_apply").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "installation.activated-http-domain",
    ]);
  expect(proxiedRequests.length).toEqual(1);
  expect(proxiedRequests[0].url).toEqual("http://takosumi.internal:8788/v1/installations");
  expect(proxiedRequests[0].headers.get("authorization")).toEqual("Bearer installer-secret");
  expect(await proxiedRequests[0].json()).toEqual({
    spaceId: "space_core",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "main",
    },
  });
});

test("accounts handler validates installation facade request before space installer apply", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(
    store,
    "tsub_core_preflight",
    "acct_core_preflight",
    "space_core",
  );
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "installer-secret",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({}, { status: 500 }));
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_core_preflight",
        spaceId: "space_core",
        source: {
          kind: "git",
          url: "https://github.com/example/hello",
          ref: "main",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_core_preflight",
        useEdges: [{ name: "database" }],
      }),
    }),
  );

  expect(response.status).toEqual(400);
  expect(proxiedRequests.length).toEqual(0);
});

test("accounts handler applies local source through space installer with local expected guard", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_core_local", "acct_core_local", "space_core");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "installer-secret",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_core_local",
            spaceId: "space_core",
            appId: "example.local",
            currentDeploymentId: "dep_core_local",
            status: "ready",
            createdAt: 1,
          },
          deployment: {
            id: "dep_core_local",
            installationId: "inst_core_local",
            source: {
              kind: "local",
              url: "/workspace/example-local",
            },
            planSnapshotDigest:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            status: "succeeded",
            outputs: {},
            createdAt: 1,
          },
        }, { status: 201 }));
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_core_local",
        spaceId: "space_core",
        source: {
          kind: "local",
          url: "/workspace/example-local",
          ref: "working-tree",
          commit: "working-tree",
          planSnapshotDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_core_local",
      }),
    }),
  );

  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.installation.id).toEqual("inst_core_local");
  expect(body.installation.status).toEqual("ready");
  expect(store.findAppInstallation("inst_core_local")?.sourceRef).toEqual("working-tree");
  expect(store.findAppInstallation("inst_core_local")?.sourceCommit).toEqual("working-tree");
  expect(proxiedRequests.length).toEqual(1);
  expect(await proxiedRequests[0].json()).toEqual({
    spaceId: "space_core",
    source: {
      kind: "local",
      url: "/workspace/example-local",
    },
    expected: {
      planSnapshotDigest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });
});

test("raw accounts handler requires account bearer for installation dry-run", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  seedOwnedSpace(store, "tsub_auth_owner", "acct_auth_dry_run", "space_auth");
  const ownerSession = seedAccountSession(
    store,
    "tsub_auth_owner",
    "sess_auth_dry_run_owner",
  );
  const otherSession = seedAccountSession(
    store,
    "tsub_auth_other",
    "sess_auth_dry_run_other",
  );
  await store.savePersonalAccessToken("takpat_read_dry_run", {
    tokenId: "pat_read_dry_run",
    tokenPrefix: "takpat_read_dry_run".slice(0, "takpat_".length + 8),
    subject: "tsub_auth_owner",
    name: "read",
    scopes: ["read"],
    createdAt: now,
  });
  const proxiedRequests: Request[] = [];
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "main",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          planSnapshotDigest: "sha256:abc",
          changes: [],
          expected: {
            commit: "0123456789abcdef0123456789abcdef01234567",
            planSnapshotDigest: "sha256:abc",
          },
        }));
      },
    },
  });
  const body = JSON.stringify({
    spaceId: "space_auth",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "main",
    },
  });

  const unauthenticated = await handler(
    new Request(`${testIssuer}/v1/installations/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  expect(unauthenticated.status).toEqual(401);

  const readPat = await handler(
    new Request(`${testIssuer}/v1/installations/dry-run`, {
      method: "POST",
      headers: {
        authorization: "Bearer takpat_read_dry_run",
        "content-type": "application/json",
      },
      body,
    }),
  );
  expect(readPat.status).toEqual(403);

  const crossOwner = await handler(
    new Request(`${testIssuer}/v1/installations/dry-run`, {
      method: "POST",
      headers: {
        ...accountSessionHeaders(otherSession),
        "content-type": "application/json",
      },
      body,
    }),
  );
  expect(crossOwner.status).toEqual(404);
  expect((await crossOwner.json()).error).toEqual("space_not_found");

  const owner = await handler(
    new Request(`${testIssuer}/v1/installations/dry-run`, {
      method: "POST",
      headers: {
        ...accountSessionHeaders(ownerSession),
        "content-type": "application/json",
      },
      body,
    }),
  );
  expect(owner.status).toEqual(200);
  expect((await owner.json()).planSnapshotDigest).toEqual("sha256:abc");
  expect(proxiedRequests.length).toEqual(1);
});

test("accounts dashboard renders install dry-run form", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store);
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });

  const response = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      headers: accountSessionHeaders(sessionId),
    }),
  );

  expect(response.status).toEqual(200);
  const html = await response.text();
  expect(html).toContain("Takosumi Accounts");
  expect(html).toContain("Git URL");
  expect(html).toContain("Max metered use edges");
});

test("accounts dashboard proxies Git URL installation dry-run", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "installer-secret",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "v1.2.3",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          planSnapshotDigest: "sha256:abc",
          repo: { id: "example.hello", name: "Example Hello" },
          installPlan: {
            source: {
              kind: "git",
              url: "https://github.com/example/hello",
              ref: "v1.2.3",
              commit: "0123456789abcdef0123456789abcdef01234567",
            },
            repo: { id: "example.hello", name: "Example Hello" },
            requestedBindings: [],
            resolvedBindings: [],
            publications: [],
            changes: [],
            warnings: [],
          },
          changes: [{
            op: "create",
            subject: "database",
            kind: "binding",
          }],
          expected: {
            commit: "0123456789abcdef0123456789abcdef01234567",
            planSnapshotDigest: "sha256:abc",
          },
          cost: {
            meteredBindingCount: 1,
          },
        }));
      },
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/dashboard/install?git=https%3A%2F%2Fgithub.com%2Fexample%2Fhello&ref=v1.2.3&space_id=space_1",
    ),
  );

  expect(response.status).toEqual(200);
  const html = await response.text();
  expect(html).toContain("Example Hello");
  expect(html).toContain("sha256:abc");
  expect(html).toContain("database");
  expect(html).toContain("Approve Install");
  expect(html).toContain('name="expected_commit" value="0123456789abcdef0123456789abcdef01234567"');
  expect(html).toContain('name="expected_plan_snapshot_digest" value="sha256:abc"');
  expect(html).toContain('name="cost_ack"');
  expect(proxiedRequests.length).toEqual(1);
  expect(proxiedRequests[0].url).toEqual("http://takosumi.internal:8788/v1/installations/dry-run");
  expect(proxiedRequests[0].headers.get("authorization")).toEqual("Bearer installer-secret");
  expect(await proxiedRequests[0].json()).toEqual({
    spaceId: "space_1",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "v1.2.3",
    },
  });
});

test("accounts dashboard blocks installation dry-run when budget guard is exceeded", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "v1.2.3",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          planSnapshotDigest: "sha256:abc",
          changes: [],
          expected: {
            commit: "0123456789abcdef0123456789abcdef01234567",
            planSnapshotDigest: "sha256:abc",
          },
          cost: {
            meteredBindingCount: 1,
          },
        }));
      },
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/dashboard/install?git=https%3A%2F%2Fgithub.com%2Fexample%2Fhello&ref=v1.2.3&space_id=space_1&max_metered_use_edges=0",
    ),
  );

  expect(response.status).toEqual(409);
  const html = await response.text();
  expect(html).toContain("budget_guard_exceeded");
  expect(html.includes("Approve Install")).toEqual(false);
  expect(proxiedRequests.length).toEqual(1);
});

test("accounts dashboard proxies Git URL install apply", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "install-secret",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_dash",
            accountId: "acct_space_1",
            spaceId: "space_1",
            appId: "example.hello",
            currentDeploymentId: "dep_dash",
            status: "ready",
            createdAt: 1,
          },
          deployment: {
            id: "dep_dash",
            installationId: "inst_dash",
            source: {
              kind: "git",
              url: "https://github.com/example/hello",
              ref: "v1.2.3",
              commit: "0123456789abcdef0123456789abcdef01234567",
            },
            planSnapshotDigest: "sha256:0123456789abcdef",
            status: "succeeded",
            outputs: {},
            createdAt: 1,
          },
        }, { status: 201 }));
      },
    },
  });

  const body = new URLSearchParams({
    git: "https://github.com/example/hello",
    ref: "v1.2.3",
    space_id: "space_1",
    expected_commit: "0123456789abcdef0123456789abcdef01234567",
    expected_plan_snapshot_digest: "sha256:0123456789abcdef",
    cost_ack: "true",
  });
  const response = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );

  expect(response.status).toEqual(202);
  const html = await response.text();
  expect(html).toContain("Install requested");
  expect(html).toContain("inst_dash");
  expect(html).toContain("/dashboard/installations/inst_dash");
  expect(proxiedRequests.length).toEqual(1);
  expect(proxiedRequests[0].url).toEqual("http://takosumi.internal:8788/v1/installations");
  expect(proxiedRequests[0].headers.get("authorization")).toEqual("Bearer install-secret");
  expect(await proxiedRequests[0].json()).toEqual({
    spaceId: "space_1",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "v1.2.3",
    },
    expected: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      planSnapshotDigest: "sha256:0123456789abcdef",
    },
  });
});

test("accounts dashboard blocks install apply when managed offering access is closed", async () => {
  let installApplyCalled = false;
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    managedOfferingAccess: { status: "closed" },
    installer: {
      url: "http://takosumi.internal:8788",
      fetch: () => {
        installApplyCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        git: "https://github.com/example/hello",
        ref: "v1.2.3",
      }),
    }),
  );

  expect(response.status).toEqual(503);
  expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  expect(installApplyCalled).toEqual(false);
});

test("accounts handler blocks installation dry-run when managed offering access is closed", async () => {
  let dryRunCalled = false;
  const handler = createAccountsHandler({
    managedOfferingAccess: { status: "closed" },
    installer: {
      url: "http://takosumi.internal:8788",
      fetch: () => {
        dryRunCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
    },
  });

  const rawDryRunResponse = await handler(
    new Request("https://accounts.example.test/v1/installations/dry-run", {
      method: "POST",
      body: JSON.stringify({
        spaceId: "space_1",
        source: {
          kind: "git",
          url: "https://github.com/example/hello",
          ref: "v1.2.3",
        },
      }),
    }),
  );
  const dashboardDryRunResponse = await handler(
    new Request(
      "https://accounts.example.test/dashboard/install?git=https://github.com/example/hello&ref=v1.2.3&space_id=space_1",
    ),
  );

  expect(rawDryRunResponse.status).toEqual(503);
  expect((await rawDryRunResponse.json()).error).toEqual("launch_readiness_not_complete");
  expect(dashboardDryRunResponse.status).toEqual(503);
  expect((await dashboardDryRunResponse.json()).error).toEqual("launch_readiness_not_complete");
  expect(dryRunCalled).toEqual(false);
});

test("accounts handler blocks open managed offering policy without evidence metadata", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    managedOfferingAccess: { status: "open" },
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  const response = await handler(
    new Request(
      [
        "https://accounts.example.test/start",
        "?takos_url=https%3A%2F%2Ftakos.example.test",
        "&subject=tsub_owner",
        "&account_id=acct_1",
        "&space_id=space_1",
        "&installation_id=inst_takos_start",
        "&terms_version=terms-2026-05-13",
        "&terms_accepted=true",
      ].join(""),
    ),
  );

  expect(response.status).toEqual(503);
  expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  expect(store.findAccount("tsub_owner")).toEqual(undefined);
});

test("accounts handler rejects weak open managed offering policy metadata", async () => {
  for (
    const managedOfferingAccess of [
      {
        ...testManagedOfferingOpenAccess,
        evidenceRef: "evidence://todo",
      },
      {
        ...testManagedOfferingOpenAccess,
        approvalRef: testManagedOfferingOpenAccess.evidenceRef,
      },
      {
        ...testManagedOfferingOpenAccess,
        publicSummary:
          "P0 evidence and staged launch rehearsal passed for user@example.test.",
      },
      {
        ...testManagedOfferingOpenAccess,
        publicSummary:
          "P0 evidence passed but launch scope is omitted entirely.",
      },
    ]
  ) {
    const store = new InMemoryAccountsStore();
    const handler = createAccountsHandler({
      store,
      managedOfferingAccess,
      launchTokens: {
        pairwiseSubjectSecret: launchPairwiseSubjectSecret,
      },
    });

    const response = await handler(
      new Request(
        [
          "https://accounts.example.test/start",
          "?takos_url=https%3A%2F%2Ftakos.example.test",
          "&subject=tsub_owner",
          "&account_id=acct_1",
          "&space_id=space_1",
          "&installation_id=inst_takos_start",
          "&terms_version=terms-2026-05-13",
          "&terms_accepted=true",
        ].join(""),
      ),
    );

    expect(response.status).toEqual(503);
    expect((await response.json()).error).toEqual("launch_readiness_not_complete");
    expect(store.findAccount("tsub_owner")).toEqual(undefined);
  }
});

test("raw accounts handler defaults managed offering access to closed", async () => {
  const handler = createRawAccountsHandler({ issuer: testIssuer });

  for (
    const request of [
      new Request(`${testIssuer}/start`),
      new Request(`${testIssuer}/v1/installations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      new Request(`${testIssuer}/v1/billing/stripe/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    ]
  ) {
    const response = await handler(request);
    expect(response.status).toEqual(503);
    const body = await response.json();
    expect(body.error).toEqual("launch_readiness_not_complete");
    expect(body.managed_offering_access).toEqual("closed");
  }
});

test("ephemeral accounts handler defaults managed offering access to closed", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: testIssuer,
    allowEphemeralKeyOnHttpsIssuer: true,
  });
  const response = await handler(new Request(`${testIssuer}/start`));

  expect(response.status).toEqual(503);
  const body = await response.json();
  expect(body.error).toEqual("launch_readiness_not_complete");
  expect(body.managed_offering_access).toEqual("closed");
});

test("accounts handler keeps documented closed-gate exceptions reachable", async () => {
  const handler = createAccountsHandler({
    managedOfferingAccess: { status: "closed" },
  });

  for (
    const [label, request] of [
      [
        "oidc discovery",
        new Request(`${testIssuer}/.well-known/openid-configuration`),
      ],
      ["jwks", new Request(`${testIssuer}/oauth/jwks`)],
      ["userinfo", new Request(`${testIssuer}/oauth/userinfo`)],
      ["revoke", new Request(`${testIssuer}/oauth/revoke`, { method: "POST" })],
      [
        "introspect",
        new Request(`${testIssuer}/oauth/introspect`, { method: "POST" }),
      ],
      [
        "token revoke",
        new Request(`${testIssuer}/v1/account/tokens/tok_1/revoke`, {
          method: "POST",
        }),
      ],
      [
        "uninstall",
        new Request(`${testIssuer}/v1/installations/inst_1`, {
          method: "DELETE",
        }),
      ],
      [
        "failed status completion",
        new Request(`${testIssuer}/v1/installations/inst_1/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "failed" }),
        }),
      ],
      [
        "exported status completion",
        new Request(`${testIssuer}/v1/installations/inst_1/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "exported" }),
        }),
      ],
      [
        "billing usage report",
        new Request(
          `${testIssuer}/v1/installations/inst_1/billing/usage-reports`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        ),
      ],
      [
        "stripe webhook",
        new Request(`${testIssuer}/v1/billing/stripe/webhook`, {
          method: "POST",
        }),
      ],
    ] as const
  ) {
    const response = await handler(request);
    const body = await response.text();
    expect(body.includes("launch_readiness_not_complete")).toEqual(false);
  }
});

test("accounts reference operator distribution exposes Accounts, OIDC, billing, and dashboard routes", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_operator", "acct_operator", "space_operator");
  const sessionId = seedAccountSession(
    store,
    "tsub_operator",
    "sess_operator_distribution",
  );
  store.saveAccount({
    subject: "tsub_operator",
    email: "operator@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const stripeRequests: Request[] = [];
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    jwks: {
      keys: [{
        kty: "EC",
        crv: "P-256",
        kid: "operator-key",
        use: "sig",
        alg: "ES256",
        x: "x",
        y: "y",
      }],
    },
    stripeBilling: {
      secretKey: "sk_test_operator",
      webhookSecret: "whsec_operator",
      fetch: (input, init) => {
        stripeRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          id: "cs_test_operator",
          url: "https://checkout.stripe.test/cs_operator",
        }));
      },
      stripeApiBase: "https://api.stripe.test/v1",
    },
    billingRedirectAllowlist: ["https://dashboard.example.test"],
  });

  const health = await handler(new Request(`${testIssuer}/healthz`));
  const discovery = await handler(
    new Request(`${testIssuer}/.well-known/openid-configuration`),
  );
  const jwks = await handler(new Request(`${testIssuer}/oauth/jwks`));
  const session = await handler(
    new Request(`${testIssuer}/v1/account/session/me`, {
      headers: accountSessionHeaders(sessionId),
    }),
  );
  const dashboardInstall = await handler(
    new Request(`${testIssuer}/dashboard/install`, {
      headers: accountSessionHeaders(sessionId),
    }),
  );
  const dashboardInstallations = await handler(
    new Request(`${testIssuer}/dashboard/installations?space_id=space_operator`, {
      headers: accountSessionHeaders(sessionId),
    }),
  );
  const checkout = await handler(
    new Request(`${testIssuer}/v1/billing/stripe/checkout`, {
      method: "POST",
      headers: {
        ...accountSessionHeaders(sessionId),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: "tsub_operator",
        priceId: "price_operator",
        mode: "subscription",
        successUrl: "https://dashboard.example.test/billing/success",
        cancelUrl: "https://dashboard.example.test/billing/cancel",
      }),
    }),
  );

  expect(health.status).toEqual(200);
  expect((await health.json()).service).toEqual("takosumi-accounts");
  expect(discovery.status).toEqual(200);
  expect((await discovery.json()).issuer).toEqual(
    "https://accounts.example.test",
  );
  expect(jwks.status).toEqual(200);
  expect((await jwks.json()).keys[0].kid).toEqual("operator-key");
  expect(session.status).toEqual(200);
  expect((await session.json()).subject).toEqual("tsub_operator");
  expect(dashboardInstall.status).toEqual(200);
  expect(await dashboardInstall.text()).toContain("Takosumi Accounts");
  expect(dashboardInstallations.status).toEqual(200);
  expect(await dashboardInstallations.text()).toContain("Installations");
  expect(checkout.status).toEqual(200);
  expect((await checkout.json()).url).toEqual(
    "https://checkout.stripe.test/cs_operator",
  );
  expect(stripeRequests.length).toEqual(1);
  expect(stripeRequests[0].url).toEqual(
    "https://api.stripe.test/v1/checkout/sessions",
  );
});

test("accounts dashboard rechecks budget guard before install apply", async () => {
  const proxiedRequests: Request[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      fetch: (input, init) => {
        const request = new Request(input, init);
        proxiedRequests.push(request);
        if (request.url.endsWith("/v1/installations")) {
          return Promise.resolve(Response.json({ ok: true }, { status: 201 }));
        }
        return Promise.resolve(Response.json({
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "v1.2.3",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          planSnapshotDigest: "sha256:abc",
          changes: [],
          expected: {
            commit: "0123456789abcdef0123456789abcdef01234567",
            planSnapshotDigest: "sha256:abc",
          },
          cost: {
            meteredBindingCount: 1,
          },
        }));
      },
    },
  });

  const body = new URLSearchParams({
    git: "https://github.com/example/hello",
    ref: "v1.2.3",
    mode: "shared-cell",
    space_id: "space_1",
    expected_commit: "0123456789abcdef0123456789abcdef01234567",
    expected_plan_snapshot_digest: "sha256:abc",
    cost_ack: "true",
    max_metered_use_edges: "0",
  });
  const response = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );

  expect(response.status).toEqual(409);
  expect(await response.text()).toContain("budget_guard_exceeded");
  expect(proxiedRequests.length).toEqual(1);
  expect(proxiedRequests[0].url).toEqual("http://takosumi.internal:8788/v1/installations/dry-run");
});

test("accounts dashboard reports installer dry-run configuration errors", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/dashboard/install?git=https%3A%2F%2Fgithub.com%2Fexample%2Fhello&ref=v1.2.3&space_id=space_1",
    ),
  );

  expect(response.status).toEqual(503);
  expect(await response.text()).toContain("Installation dry-run is temporarily unavailable.");
});

test("accounts handler rejects installation dry-run when installer is not configured", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedSpace(store, "tsub_owner", "acct_space_1", "space_1");
  const sessionId = seedAccountSession(store, "tsub_owner");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations/dry-run", {
      method: "POST",
      headers: {
        ...accountSessionHeaders(sessionId),
        "content-type": "application/json",
      },
      body: JSON.stringify({ spaceId: "space_1" }),
    }),
  );

  expect(response.status).toEqual(503);
  const body = await response.json();
  expect(body.error).toEqual("feature_unavailable");
  expect(body.error_description).toEqual("Installation dry-run is temporarily unavailable.");
});

test("reserved OIDC endpoints return public-safe unavailable response", async () => {
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
  });
  const response = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
    }),
  );
  expect(response.status).toEqual(503);
  const body = await response.json();
  expect(body.error).toEqual("feature_unavailable");
  expect(body.error_description).toEqual("Sign-in is temporarily unavailable.");
});

test("ephemeral accounts handler completes authorization code flow", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    subject: "tsub_e2e",
    keyId: "test-key",
    clients: [{
      clientId: "takos-test",
      redirectUris: ["http://localhost:3000/callback"],
    }],
  });
  const pkceVerifier = "takosumi-pkce-verifier-authz-code-flow";
  const pkceChallenge = await s256Challenge(pkceVerifier);

  const authorizeUrl = new URL("https://accounts.example.test/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "takos-test");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:3000/callback",
  );
  authorizeUrl.searchParams.set("scope", "openid profile");
  authorizeUrl.searchParams.set("state", "state-1");
  authorizeUrl.searchParams.set("nonce", "nonce-1");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeResponse = await handler(new Request(authorizeUrl));
  expect(authorizeResponse.status).toEqual(302);
  const redirect = new URL(authorizeResponse.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toEqual("http://localhost:3000/callback");
  expect(redirect.searchParams.get("state")).toEqual("state-1");
  const code = redirect.searchParams.get("code");

  const tokenResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: "takos-test",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: pkceVerifier,
      }),
    }),
  );
  expect(tokenResponse.status).toEqual(200);
  const tokenBody = await tokenResponse.json();
  expect(tokenBody.token_type).toEqual("Bearer");
  expect(tokenBody.expires_in).toEqual(300);
  expect(String(tokenBody.id_token).split(".").length).toEqual(3);
  const idTokenClaims = JSON.parse(
    base64UrlDecodeText(String(tokenBody.id_token).split(".")[1]),
  );
  expect(idTokenClaims.nonce).toEqual("nonce-1");

  const userInfoResponse = await handler(
    new Request("https://accounts.example.test/oauth/userinfo", {
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
      },
    }),
  );
  expect(userInfoResponse.status).toEqual(200);
  const userInfo = await userInfoResponse.json();
  expect(userInfo.sub).toEqual("tsub_e2e");
  expect(userInfo.aud).toEqual("takos-test");

  const jwksResponse = await handler(
    new Request("https://accounts.example.test/oauth/jwks"),
  );
  const jwks = await jwksResponse.json();
  expect(jwks.keys[0].kid).toEqual("test-key");
  expect(jwks.keys[0].alg).toEqual("ES256");
});

test("ephemeral accounts handler rejects unregistered redirect URIs", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    clients: [{
      clientId: "takos-test",
      redirectUris: ["http://localhost:3000/callback"],
    }],
  });

  const authorizeUrl = new URL("https://accounts.example.test/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "takos-test");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:4000/callback",
  );

  const response = await handler(new Request(authorizeUrl));
  expect(response.status).toEqual(400);
  const body = await response.json();
  expect(body.error).toEqual("invalid_request");
});

test("accounts handler rejects UserInfo without a bearer token", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
  });
  const response = await handler(
    new Request("https://accounts.example.test/oauth/userinfo"),
  );
  expect(response.status).toEqual(401);
  expect(response.headers.get("www-authenticate")).toEqual('Bearer error="invalid_token"');
});

test("ephemeral accounts handler issues and accepts refresh tokens", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    clients: [{
      clientId: "takos-test",
      redirectUris: ["http://localhost:3000/callback"],
    }],
  });
  const pkceVerifier = "takosumi-pkce-verifier-refresh-flow";
  const pkceChallenge = await s256Challenge(pkceVerifier);

  const authorizeUrl = new URL("https://accounts.example.test/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "takos-test");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:3000/callback",
  );
  authorizeUrl.searchParams.set("scope", "openid offline_access");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeResponse = await handler(new Request(authorizeUrl));
  const redirect = new URL(authorizeResponse.headers.get("location") ?? "");
  const code = redirect.searchParams.get("code") ?? "";

  const tokenResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "takos-test",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: pkceVerifier,
      }),
    }),
  );
  const tokenBody = await tokenResponse.json();
  expect(typeof tokenBody.refresh_token).toEqual("string");

  const refreshResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
        client_id: "takos-test",
      }),
    }),
  );
  expect(refreshResponse.status).toEqual(200);
  const refreshBody = await refreshResponse.json();
  expect(refreshBody.token_type).toEqual("Bearer");
  expect(refreshBody.scope).toEqual("openid offline_access");
  // RFC 6749 §10.4 / OAuth 2.1 §4.3.1: refresh tokens must rotate.
  expect(refreshBody.refresh_token !== tokenBody.refresh_token).toEqual(true);

  // The newly minted access token still works for userinfo.
  const userInfoResponse = await handler(
    new Request("https://accounts.example.test/oauth/userinfo", {
      headers: {
        authorization: `Bearer ${refreshBody.access_token}`,
      },
    }),
  );
  expect(userInfoResponse.status).toEqual(200);

  // Replaying the rotated-out refresh token must cascade-revoke the chain.
  const reusedRefreshResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
        client_id: "takos-test",
      }),
    }),
  );
  expect(reusedRefreshResponse.status).toEqual(400);
  expect((await reusedRefreshResponse.json()).error).toEqual("invalid_grant");

  // The rotated-in refresh token must also be invalidated.
  const postCascadeRefreshResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshBody.refresh_token,
        client_id: "takos-test",
      }),
    }),
  );
  expect(postCascadeRefreshResponse.status).toEqual(400);

  // The cascaded access token is also revoked; userinfo must now reject.
  const cascadedUserInfoResponse = await handler(
    new Request("https://accounts.example.test/oauth/userinfo", {
      headers: {
        authorization: `Bearer ${refreshBody.access_token}`,
      },
    }),
  );
  expect(cascadedUserInfoResponse.status).toEqual(401);
});

test("ephemeral accounts handler treats concurrent refresh rotation as reuse (G6)", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    clients: [{
      clientId: "takos-test",
      redirectUris: ["http://localhost:3000/callback"],
    }],
  });
  const pkceVerifier = "takosumi-pkce-verifier-concurrent-rotation";
  const pkceChallenge = await s256Challenge(pkceVerifier);

  const authorizeUrl = new URL("https://accounts.example.test/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "takos-test");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:3000/callback",
  );
  authorizeUrl.searchParams.set("scope", "openid offline_access");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeResponse = await handler(new Request(authorizeUrl));
  const redirect = new URL(authorizeResponse.headers.get("location") ?? "");
  const code = redirect.searchParams.get("code") ?? "";

  const tokenResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "takos-test",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: pkceVerifier,
      }),
    }),
  );
  const tokenBody = await tokenResponse.json();
  const refreshToken: string = tokenBody.refresh_token;

  // Two concurrent presentations of the SAME valid refresh token. Without
  // an atomic rotation claim both would pass the read-then-write reuse
  // check and mint independent child families (double-spend). The atomic
  // addRefreshChainLink claim guarantees exactly one winner; the loser is
  // treated as reuse and rejected, and the chain is revoked.
  const mkRequest = () =>
    handler(
      new Request("https://accounts.example.test/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "takos-test",
        }),
      }),
    );
  const [first, second] = await Promise.all([mkRequest(), mkRequest()]);
  const statuses = [first.status, second.status].sort();
  // Exactly one rotation succeeds (200); the concurrent loser is rejected
  // as reuse (400). Never two 200s (which would be a double-spend).
  expect(statuses).toEqual([200, 400]);

  const okResponse = first.status === 200 ? first : second;
  const rejectedResponse = first.status === 400 ? first : second;
  await okResponse.body?.cancel();
  expect((await rejectedResponse.json()).error).toEqual("invalid_grant");
});

test("accounts handler issues and revokes personal access tokens", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_pat_owner",
    email: "owner@example.test",
    displayName: "Owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_pat_owner",
    subject: "tsub_pat_owner",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  // Round 2: register a static OIDC client so /oauth/introspect can
  // authenticate the introspection request per RFC 7662 §2.1. The
  // legacy degraded mode (no clients wired) is no longer available now
  // that mod.ts forwards the `clients` map to the introspect handler.
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    clients: [
      {
        clientId: "pat-introspector",
        clientSecret: "pat-introspector-secret",
        redirectUris: ["https://app.example.test/auth/callback"],
        tokenEndpointAuthMethod: "client_secret_post",
      },
    ],
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/account/tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer sess_pat_owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "CLI",
        scopes: ["read", "write"],
      }),
    }),
  );
  expect(createResponse.status).toEqual(201);
  const createBody = await createResponse.json();
  expect(String(createBody.token).startsWith("takpat_")).toEqual(true);
  expect(createBody.token_record.subject).toEqual("tsub_pat_owner");
  expect(createBody.token_record.scopes).toEqual(["read", "write"]);

  const listResponse = await handler(
    new Request("https://accounts.example.test/v1/account/tokens", {
      headers: {
        authorization: "Bearer sess_pat_owner",
      },
    }),
  );
  expect(listResponse.status).toEqual(200);
  const listBody = await listResponse.json();
  expect(listBody.tokens.length).toEqual(1);
  expect(listBody.tokens[0].token).toEqual(undefined);
  expect(listBody.tokens[0].name).toEqual("CLI");

  const introspectResponse = await handler(
    new Request("https://accounts.example.test/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({
        token: createBody.token,
        client_id: "pat-introspector",
        client_secret: "pat-introspector-secret",
      }),
    }),
  );
  const introspectBody = await introspectResponse.json();
  expect(introspectResponse.status).toEqual(200);
  expect(introspectBody.active).toEqual(true);
  expect(introspectBody.iss).toEqual("https://accounts.example.test");
  expect(introspectBody.sub).toEqual("tsub_pat_owner");
  expect(introspectBody.scope).toEqual("read write");

  const tokenId = createBody.token_record.id;
  const revokeResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/account/tokens/${tokenId}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer sess_pat_owner",
        },
      },
    ),
  );
  expect(revokeResponse.status).toEqual(200);
  const revokeBody = await revokeResponse.json();
  expect(typeof revokeBody.token.revoked_at).toEqual("string");

  const revokedIntrospectResponse = await handler(
    new Request("https://accounts.example.test/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({
        token: createBody.token,
        client_id: "pat-introspector",
        client_secret: "pat-introspector-secret",
      }),
    }),
  );
  expect((await revokedIntrospectResponse.json()).active).toEqual(false);
});

test("accounts handler requires session auth and valid scopes for personal access tokens", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_pat_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_pat_owner",
    subject: "tsub_pat_owner",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const handler = createAccountsHandler({ store });

  const unauthenticatedResponse = await handler(
    new Request("https://accounts.example.test/v1/account/tokens"),
  );
  expect(unauthenticatedResponse.status).toEqual(401);

  const invalidScopeResponse = await handler(
    new Request("https://accounts.example.test/v1/account/tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer sess_pat_owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "CLI",
        scopes: ["service.import@v1"],
      }),
    }),
  );
  expect(invalidScopeResponse.status).toEqual(400);
});

test("ephemeral accounts handler verifies PKCE S256 challenges", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    clients: [{
      clientId: "takos-test",
      redirectUris: ["http://localhost:3000/callback"],
    }],
  });
  const verifier = "takosumi-pkce-verifier";
  const challenge = await s256Challenge(verifier);

  const authorizeUrl = new URL("https://accounts.example.test/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "takos-test");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:3000/callback",
  );
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeResponse = await handler(new Request(authorizeUrl));
  const redirect = new URL(authorizeResponse.headers.get("location") ?? "");
  const code = redirect.searchParams.get("code") ?? "";

  const badVerifierResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "takos-test",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: "wrong",
      }),
    }),
  );
  expect(badVerifierResponse.status).toEqual(400);

  const retryResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "takos-test",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: verifier,
      }),
    }),
  );
  expect(retryResponse.status).toEqual(400);

  const secondAuthorizeResponse = await handler(new Request(authorizeUrl));
  const secondRedirect = new URL(
    secondAuthorizeResponse.headers.get("location") ?? "",
  );
  const secondCode = secondRedirect.searchParams.get("code") ?? "";
  const tokenResponse = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: secondCode,
        client_id: "takos-test",
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: verifier,
      }),
    }),
  );
  expect(tokenResponse.status).toEqual(200);
});

test("accounts handler redirects to configured upstream OAuth providers", async () => {
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      providers: [{
        providerId: "github",
        clientId: "github-client",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
      }],
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=github&state=state-1",
    ),
  );

  expect(response.status).toEqual(302);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toEqual("https://github.com/login/oauth/authorize");
  expect(redirect.searchParams.get("client_id")).toEqual("github-client");
  expect(redirect.searchParams.get("state")).toEqual("state-1");
  expect(redirect.searchParams.get("redirect_uri")).toEqual("https://accounts.example.test/v1/auth/upstream/callback");
});

test("accounts handler redirects to configured custom upstream OIDC providers", async () => {
  const provider = customOidcOAuthProvider({
    id: "keycloak",
    issuer: "https://idp.example.test/realms/takos",
    authorizationEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
    tokenEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/token",
    userInfoEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo",
  });
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      providers: [{
        providerId: "keycloak",
        clientId: "keycloak-client",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
        provider,
      }],
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=keycloak&state=state-oidc",
    ),
  );

  expect(response.status).toEqual(302);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toEqual("https://idp.example.test/realms/takos/protocol/openid-connect/auth");
  expect(redirect.searchParams.get("client_id")).toEqual("keycloak-client");
  expect(redirect.searchParams.get("state")).toEqual("state-oidc");
});

test("accounts handler rejects custom upstream provider ids without provider objects", async () => {
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      providers: [{
        providerId: "keycloak",
        clientId: "keycloak-client",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
      }],
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=keycloak&state=state-oidc",
    ),
  );
  const body = await response.json();

  expect(response.status).toEqual(400);
  expect(body.error).toEqual("unknown_provider");
});

test("accounts handler exchanges upstream OAuth codes into sessions", async () => {
  const store = new InMemoryAccountsStore();
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("code")).toEqual("code-1");
      expect(body.get("client_id")).toEqual("github-client");
      expect(body.get("client_secret")).toEqual("github-secret");
      return Response.json({ access_token: "github-token" });
    }
    if (request.url === "https://api.github.com/user") {
      expect(request.headers.get("authorization")).toEqual("Bearer github-token");
      return Response.json({
        id: 12345,
        login: "octo",
        email: "octo@example.test",
      });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const handler = createAccountsHandler({
    store,
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      sessionTtlMs: 60_000,
      fetch: fetchImpl,
      providers: [{
        providerId: "github",
        clientId: "github-client",
        clientSecret: "github-secret",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
      }],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=github&state=state-github",
    ),
  );
  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=github&code=code-1&state=state-github",
      {
        headers: { cookie: authorizeResponse.headers.get("set-cookie") ?? "" },
      },
    ),
  );
  const body = await response.json();

  expect(authorizeResponse.status).toEqual(302);
  expect(response.status).toEqual(200);
  expect(requests.length).toEqual(2);
  expect(String(body.subject).startsWith("tsub_")).toEqual(true);
  expect(body.provider_id).toEqual("github");
  // Agent 6 item 6: session_id must NOT be returned in the JSON body; the
  // server delivers it via an HttpOnly cookie. Extract the cookie from
  // the response's Set-Cookie headers and verify the persisted session
  // matches the subject.
  expect(body.session_id).toEqual(undefined);
  expect(store.findAccount(body.subject)?.email).toEqual("octo@example.test");
  const sessionCookie = extractSessionCookieForTest(response);
  expect(typeof sessionCookie).toEqual("string");
  expect(store.findAccountSession(sessionCookie!)?.subject).toEqual(body.subject);
});

function extractSessionCookieForTest(response: Response): string | null {
  const setCookieEntries = response.headers.getSetCookie?.() ?? [];
  if (setCookieEntries.length === 0) {
    const raw = response.headers.get("set-cookie");
    if (raw) setCookieEntries.push(raw);
  }
  for (const entry of setCookieEntries) {
    const firstSegment = entry.split(";")[0]?.trim() ?? "";
    if (firstSegment.startsWith("takosumi_session=")) {
      const rawValue = firstSegment.slice("takosumi_session=".length);
      if (!rawValue) return null;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return null;
      }
    }
  }
  return null;
}

test("accounts handler rejects upstream OAuth callback state mismatches", async () => {
  let upstreamFetchCalled = false;
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      fetch: () => {
        upstreamFetchCalled = true;
        return Promise.resolve(Response.json({ access_token: "github-token" }));
      },
      providers: [{
        providerId: "github",
        clientId: "github-client",
        clientSecret: "github-secret",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
      }],
    },
  });
  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=github&state=state-owner",
    ),
  );
  const stateCookie = authorizeResponse.headers.get("set-cookie") ?? "";
  expect(stateCookie).toContain("takosumi_oauth_state=state-owner");

  const mismatchResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=github&code=code-1&state=state-attacker",
      { headers: { cookie: stateCookie } },
    ),
  );
  expect(mismatchResponse.status).toEqual(400);
  expect((await mismatchResponse.json()).error).toEqual("invalid_state");
  expect(upstreamFetchCalled).toEqual(false);

  const missingCookieResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=github&code=code-1&state=state-owner",
    ),
  );
  expect(missingCookieResponse.status).toEqual(400);
  expect((await missingCookieResponse.json()).error).toEqual("invalid_state");
  expect(upstreamFetchCalled).toEqual(false);

  const missingStateResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=github&code=code-1",
      { headers: { cookie: stateCookie } },
    ),
  );
  expect(missingStateResponse.status).toEqual(400);
  expect((await missingStateResponse.json()).error).toEqual("invalid_state");
  expect(upstreamFetchCalled).toEqual(false);
});

test("accounts handler blocks upstream OAuth authorize and callback when managed offering access is closed", async () => {
  let upstreamFetchCalled = false;
  const handler = createAccountsHandler({
    managedOfferingAccess: { status: "closed" },
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      fetch: () => {
        upstreamFetchCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
      providers: [{
        providerId: "github",
        clientId: "github-client",
        clientSecret: "github-secret",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
      }],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=github&state=state-1",
    ),
  );
  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=github&code=code-1",
    ),
  );

  expect(authorizeResponse.status).toEqual(503);
  expect((await authorizeResponse.json()).error).toEqual("launch_readiness_not_complete");
  expect(response.status).toEqual(503);
  expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  expect(upstreamFetchCalled).toEqual(false);
});

test("accounts handler exchanges custom upstream OIDC codes into sessions", async () => {
  const store = new InMemoryAccountsStore();
  const provider = customOidcOAuthProvider({
    id: "keycloak",
    issuer: "https://idp.example.test/realms/takos",
    authorizationEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
    tokenEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/token",
    userInfoEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo",
  });
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (
      request.url ===
        "https://idp.example.test/realms/takos/protocol/openid-connect/token"
    ) {
      const body = new URLSearchParams(await request.text());
      expect(body.get("code")).toEqual("code-oidc");
      expect(body.get("client_id")).toEqual("keycloak-client");
      expect(body.get("client_secret")).toEqual("keycloak-secret");
      return Response.json({ access_token: "keycloak-token" });
    }
    if (
      request.url ===
        "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo"
    ) {
      expect(request.headers.get("authorization")).toEqual("Bearer keycloak-token");
      return Response.json({
        sub: "keycloak-user",
        email: "keycloak@example.test",
        name: "Keycloak User",
      });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const handler = createAccountsHandler({
    store,
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      fetch: fetchImpl,
      providers: [{
        providerId: "keycloak",
        clientId: "keycloak-client",
        clientSecret: "keycloak-secret",
        redirectUri: "https://accounts.example.test/v1/auth/upstream/callback",
        provider,
      }],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=keycloak&state=state-keycloak",
    ),
  );
  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=keycloak&code=code-oidc&state=state-keycloak",
      {
        headers: { cookie: authorizeResponse.headers.get("set-cookie") ?? "" },
      },
    ),
  );
  const body = await response.json();

  expect(authorizeResponse.status).toEqual(302);
  expect(response.status).toEqual(200);
  expect(requests.length).toEqual(2);
  expect(String(body.subject).startsWith("tsub_")).toEqual(true);
  expect(body.provider_id).toEqual("keycloak");
  expect(store.findAccount(body.subject)?.email).toEqual("keycloak@example.test");
});

test("accounts handler registers passkey credentials and authenticates assertions", async () => {
  const store = new InMemoryAccountsStore();
  // Agent 6 item 1: passkey register/complete requires an authenticated
  // session bound to the same subject. Seed one (this also creates the
  // tsub_account ledger row used by the passkey ceremony).
  const sessionId = seedAccountSession(store, "tsub_account");
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    displayName: "Example User",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const sessionAuth = { authorization: `Bearer ${sessionId}` };

  const handler = createAccountsHandler({
    store,
    passkeys: {
      rpId: "accounts.example.test",
      rpName: "Takosumi Accounts",
      origin: "https://accounts.example.test",
      sessionTtlMs: 60_000,
    },
  });

  // Agent 6 item 2 + 3: server mints the registration challenge; clients
  // can no longer supply their own.
  const registrationOptionsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/options",
      {
        method: "POST",
        headers: sessionAuth,
        body: JSON.stringify({ subject: "tsub_account" }),
      },
    ),
  );
  expect(registrationOptionsResponse.status).toEqual(200);
  const registrationOptions = await registrationOptionsResponse.json();
  expect(typeof registrationOptions.challenge).toEqual("string");
  expect((registrationOptions.challenge as string).length > 0).toEqual(true);
  expect(registrationOptions.rp.id).toEqual("accounts.example.test");
  expect(registrationOptions.user.name).toEqual("user@example.test");
  const serverRegistrationChallenge = registrationOptions.challenge as string;

  // Build the credential JWK we will register. We will re-sign assertion
  // bytes later with this same key when the authenticate flow needs to
  // match the server-issued authenticate challenge.
  const enrolled = await createSignedAssertion({
    challenge: "ignored-during-registration",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 0,
  });

  // Agent 6 item 2 + 4 (fail-closed): register/complete now REQUIRES the full
  // registration ceremony (challenge + clientDataJSON + attestationObject),
  // symmetric with authenticate/complete. A real WebAuthn client always has
  // these; build them here.
  const registrationClientDataJSON = createRegistrationClientDataJSON({
    challenge: serverRegistrationChallenge,
    origin: "https://accounts.example.test",
  });
  const registrationAttestationObject = await createNoneAttestationObject({
    rpId: "accounts.example.test",
    signCount: 0,
  });

  const registrationResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/complete",
      {
        method: "POST",
        headers: sessionAuth,
        body: JSON.stringify({
          subject: "tsub_account",
          credentialId: "credential-1",
          publicKeyJwk: enrolled.publicKeyJwk,
          signCount: 0,
          transports: ["internal"],
          challenge: serverRegistrationChallenge,
          clientDataJSON: base64UrlEncodeBytes(registrationClientDataJSON),
          attestationObject: base64UrlEncodeBytes(
            registrationAttestationObject,
          ),
        }),
      },
    ),
  );
  expect(registrationResponse.status).toEqual(200);
  expect(store.findPasskeyCredential("credential-1")?.subject).toEqual("tsub_account");

  // Agent 6 item 2: server mints the authenticate challenge too.
  const authenticationOptionsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/authenticate/options",
      {
        method: "POST",
        body: JSON.stringify({ subject: "tsub_account" }),
      },
    ),
  );
  expect(authenticationOptionsResponse.status).toEqual(200);
  const authenticationOptions = await authenticationOptionsResponse.json();
  expect(typeof authenticationOptions.challenge).toEqual("string");
  expect(authenticationOptions.allowCredentials).toEqual([{
    id: "credential-1",
    type: "public-key",
  }]);
  const serverAuthChallenge = authenticationOptions.challenge as string;

  // Re-sign with the server's challenge using the same key the
  // credential was registered with.
  const liveAssertion = await createSignedAssertionWithKey({
    challenge: serverAuthChallenge,
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 1,
    keyPair: enrolled.keyPair,
  });

  const authenticationResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/authenticate/complete",
      {
        method: "POST",
        body: JSON.stringify({
          credentialId: "credential-1",
          expectedChallenge: serverAuthChallenge,
          authenticatorData: base64UrlEncodeBytes(
            liveAssertion.authenticatorData,
          ),
          clientDataJSON: base64UrlEncodeBytes(liveAssertion.clientDataJSON),
          signature: base64UrlEncodeBytes(liveAssertion.signature),
        }),
      },
    ),
  );
  const authenticationBody = await authenticationResponse.json();
  expect(authenticationResponse.status).toEqual(200);
  expect(authenticationBody.subject).toEqual("tsub_account");
  expect(authenticationBody.credential_id).toEqual("credential-1");
  // Agent 6 item 6: session_id must NOT be returned in the JSON body.
  expect(authenticationBody.session_id).toEqual(undefined);
  const passkeySessionCookie = extractSessionCookieForTest(
    authenticationResponse,
  );
  expect(typeof passkeySessionCookie).toEqual("string");
  expect(store.findAccountSession(passkeySessionCookie!)?.subject).toEqual("tsub_account");
  expect(store.findPasskeyCredential("credential-1")?.signCount).toEqual(1);
});

test("passkey register/complete fails closed when ceremony fields are omitted", async () => {
  // Regression: register/complete previously skipped ALL challenge +
  // attestation verification when the client omitted `challenge`, binding an
  // arbitrary public key to the session subject. The fields are now mandatory.
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_account");
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    displayName: "Example User",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const sessionAuth = { authorization: `Bearer ${sessionId}` };
  const handler = createAccountsHandler({
    store,
    passkeys: {
      rpId: "accounts.example.test",
      rpName: "Takosumi Accounts",
      origin: "https://accounts.example.test",
      sessionTtlMs: 60_000,
    },
  });

  const optionsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/options",
      {
        method: "POST",
        headers: sessionAuth,
        body: JSON.stringify({ subject: "tsub_account" }),
      },
    ),
  );
  expect(optionsResponse.status).toEqual(200);
  const options = await optionsResponse.json();
  const serverChallenge = options.challenge as string;

  const enrolled = await createSignedAssertion({
    challenge: "ignored",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 0,
  });

  // Omitting challenge / clientDataJSON / attestationObject must be rejected
  // (the old fail-open path would have accepted this and bound the key).
  const missingFields = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/complete",
      {
        method: "POST",
        headers: sessionAuth,
        body: JSON.stringify({
          subject: "tsub_account",
          credentialId: "attacker-key",
          publicKeyJwk: enrolled.publicKeyJwk,
        }),
      },
    ),
  );
  expect(missingFields.status).toEqual(400);
  expect((await missingFields.json()).error).toEqual("invalid_request");
  expect(store.findPasskeyCredential("attacker-key")).toEqual(undefined);

  // Sending only the challenge (no clientDataJSON/attestationObject) is also
  // rejected — the verification block can no longer be skipped.
  const challengeOnly = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/complete",
      {
        method: "POST",
        headers: sessionAuth,
        body: JSON.stringify({
          subject: "tsub_account",
          credentialId: "attacker-key",
          publicKeyJwk: enrolled.publicKeyJwk,
          challenge: serverChallenge,
        }),
      },
    ),
  );
  expect(challengeOnly.status).toEqual(400);
  expect((await challengeOnly.json()).error).toEqual("invalid_request");
  expect(store.findPasskeyCredential("attacker-key")).toEqual(undefined);
});

test("accounts handler blocks passkey flows when managed offering access is closed", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const handler = createAccountsHandler({
    store,
    managedOfferingAccess: { status: "closed" },
    passkeys: {
      rpId: "accounts.example.test",
      rpName: "Takosumi Accounts",
      origin: "https://accounts.example.test",
      sessionTtlMs: 60_000,
    },
  });

  const requests = [
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/options",
      {
        method: "POST",
        body: JSON.stringify({
          subject: "tsub_account",
          challenge: "register-challenge",
        }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/register/complete",
      {
        method: "POST",
        body: JSON.stringify({
          subject: "tsub_account",
          credentialId: "credential-1",
          publicKeyJwk: { kty: "EC" },
          signCount: 0,
        }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/authenticate/options",
      {
        method: "POST",
        body: JSON.stringify({
          subject: "tsub_account",
          challenge: "challenge-1",
        }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/authenticate/complete",
      {
        method: "POST",
        body: JSON.stringify({ credentialId: "credential-1" }),
      },
    ),
  ];

  for (const request of requests) {
    const response = await handler(request);
    expect(response.status).toEqual(503);
    expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  }
  expect(store.findPasskeyCredential("credential-1")).toEqual(undefined);
});

test("accounts handler starts Stripe checkout sessions", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const checkoutSession = seedAccountSession(store, "tsub_account");

  let requestBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toEqual("https://api.stripe.test/v1/checkout/sessions");
    requestBody = await request.text();
    return Response.json({
      id: "cs_1",
      url: "https://checkout.stripe.test/cs_1",
    });
  };
  const handler = createAccountsHandler({
    store,
    stripeBilling: {
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      stripeApiBase: "https://api.stripe.test/v1",
      fetch: fetchImpl,
    },
    billingRedirectAllowlist: ["https://accounts.example.test"],
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: accountSessionHeaders(checkoutSession),
      body: JSON.stringify({
        subject: "tsub_account",
        priceId: "price_1",
        mode: "subscription",
        successUrl: "https://accounts.example.test/success",
        cancelUrl: "https://accounts.example.test/cancel",
        metadata: { purchase_kind: "plus_subscription" },
      }),
    }),
  );

  expect(response.status).toEqual(200);
  expect(await response.json()).toEqual({
    session_id: "cs_1",
    url: "https://checkout.stripe.test/cs_1",
  });
  const params = new URLSearchParams(requestBody);
  expect(params.get("customer_email")).toEqual("user@example.test");
  expect(params.get("metadata[takosumi_subject]")).toEqual("tsub_account");
  expect(params.get("metadata[purchase_kind]")).toEqual("plus_subscription");
});

test("accounts handler blocks Stripe checkout when managed offering access is closed", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  let checkoutCalled = false;
  const handler = createAccountsHandler({
    store,
    managedOfferingAccess: {
      status: "closed",
      evidenceRef: "vault://managed-readiness/staging/rehearsal.json",
      publicSummary: "Launch rehearsal is still blocked.",
    },
    stripeBilling: {
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      stripeApiBase: "https://api.stripe.test/v1",
      fetch: () => {
        checkoutCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/checkout", {
      method: "POST",
      body: JSON.stringify({
        subject: "tsub_account",
        priceId: "price_1",
        mode: "subscription",
        successUrl: "https://accounts.example.test/success",
        cancelUrl: "https://accounts.example.test/cancel",
      }),
    }),
  );

  expect(response.status).toEqual(503);
  expect(checkoutCalled).toEqual(false);
  expect(await response.json()).toEqual({
    error: "launch_readiness_not_complete",
    error_description:
      "Public managed Takos signup, install, and paid access are blocked until launch readiness evidence is approved",
    managed_offering_access: "closed",
  });
});

test("accounts handler receives Stripe webhooks into billing state", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const handler = createAccountsHandler({
    store,
    stripeBilling: {
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      webhookToleranceSeconds: 1_000,
    },
  });
  const payload = JSON.stringify({
    id: "evt_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_1",
        subscription: "sub_1",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_account" },
      },
    },
  });
  const signature = await stripeSignatureHeader({
    payload,
    secret: "whsec_test",
    timestamp: Math.floor(Date.now() / 1000),
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": signature,
      },
      body: payload,
    }),
  );

  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.received).toEqual(true);
  expect(body.status).toEqual("processed");
  expect(store.findBillingAccountForSubject("tsub_account")?.stripeCustomerId).toEqual("cus_1");
  expect(store.findBillingWebhookEvent("evt_checkout")?.status).toEqual("processed");
});

test("accounts handler manages AppInstallation lifecycle records", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const permissionDigest = await testPermissionDigest({
    useEdgeKinds: ["identity.oidc@v1", "install-launch-token@v1"],
    permissionScopes: ["deploy.intent.write"],
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_1",
        accountId: "acct_1",
        spaceId: "space_1",
        spaceKind: "personal",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        runtimeTarget: {
          runtimeTargetId: "rtb_1",
          targetType: "shared-cell",
          targetId: "tokyo-cell-01",
        },
        useEdges: [{
          useEdgeId: "bind_auth",
          name: "auth",
          kind: "identity.oidc@v1",
          configRef: "config://inst_1/auth",
          secretRefs: ["secret://inst_1/auth/client-secret"],
        }, {
          useEdgeId: "bind_bootstrap",
          name: "bootstrap",
          kind: "install-launch-token@v1",
          configRef: "config://inst_1/bootstrap",
          secretRefs: [],
        }],
        oidcClients: [{
          namespacePath: "identity.primary.oidc",
          issuerUrl: "https://accounts.example.test",
          redirectUris: ["http://localhost:8787/auth/oidc/callback"],
          allowedScopes: ["openid", "profile"],
          subjectMode: "pairwise",
          tokenEndpointAuthMethod: "client_secret_post",
        }],
        permissionScopes: [{
          permissionScopeId: "grant_deploy",
          capability: "deploy.intent.write",
          scope: { pathPrefix: "deployments/" },
        }],
        confirm: {
          permissionDigest,
          costAck: false,
          approvalRequired: true,
          expiresAt: "2026-05-12T00:15:00.000Z",
        },
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  expect(createResponse.headers.get("location")).toEqual("/v1/installations/inst_1");
  const created = await createResponse.json();
  expect(created.installation.status).toEqual("installing");
  expect(created.oidc_client.namespacePath).toEqual("identity.primary.oidc");
  expect(created.oidc_client.allowed_scopes).toEqual(["openid", "profile"]);
  expect(typeof created.oidc_client_secret).toEqual("string");
  // Wave 6 (Phase E SQL drift fix): `use_edges` / `permission_scopes` /
  // `runtime_target` were removed from the installation envelope. The
  // underlying in-memory ledger still tracks them so existing
  // materialize / launch token logic continues to function; we assert
  // ledger state directly instead of envelope fields.
  expect(store.findLedgerAccount("acct_1")?.legalOwnerSubject).toEqual("tsub_owner");
  expect(store.listAppBindingsForInstallation("inst_1").length).toEqual(2);
  expect(store.findOidcClientForInstallation("inst_1")?.issuerUrl).toEqual("https://accounts.example.test");
  const storedAuthBinding = store.listAppBindingsForInstallation("inst_1")
    .find((binding) => binding.name === "auth");
  expect(storedAuthBinding?.configRef ?? "").toContain("takosumi-accounts://installations/inst_1/use-edges/auth/oidc-client/");
  expect(storedAuthBinding?.secretRefs).toEqual([
    "takosumi-accounts://installations/inst_1/use-edges/auth/secrets/client-secret",
  ]);
  expect(store.listInstallationEvents("inst_1").map((event) => event.eventType)).toEqual([
      "installation.created",
      "installation.approved",
      "oidc_client.registered",
      "use_edge.materialized",
    ]);
  const ownerSession = seedAccountSession(store, "tsub_owner");

  const updateResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready", reason: "healthcheck passed" }),
      },
    ),
  );
  expect(updateResponse.status).toEqual(200);
  expect((await updateResponse.json()).installation.status).toEqual("ready");

  const inspectResponse = await handler(
    new Request("https://accounts.example.test/v1/installations/inst_1", {
      headers: accountSessionHeaders(ownerSession),
    }),
  );
  expect(inspectResponse.status).toEqual(200);
  const inspected = await inspectResponse.json();
  expect(inspected.installation.id).toEqual("inst_1");
  // Wave 6 (Phase E SQL drift fix): `inspected.runtime_target` and
  // `inspected.permission_scopes` were removed from the envelope.
  // The underlying ledger still has them; we assert via the in-memory
  // store.
  expect(store.findRuntimeBinding(
      store.findAppInstallation("inst_1")?.runtimeBindingId ?? "",
    )?.targetId).toEqual("tokyo-cell-01");
  expect(store.listAppGrantsForInstallation("inst_1").length).toEqual(1);

  const eventsResponse = await handler(
    new Request("https://accounts.example.test/v1/installations/inst_1/events"),
  );
  expect(eventsResponse.status).toEqual(200);
  const eventsBody = await eventsResponse.json();
  expect(eventsBody.hash_chain_valid).toEqual(true);
  expect(eventsBody.events.map((event: { type: string }) => event.type)).toEqual([
      "installation.created",
      "installation.approved",
      "oidc_client.registered",
      "use_edge.materialized",
      "installation.status_changed",
    ]);
});

test("accounts handler validates install approval confirmation", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const permissionDigest = await testPermissionDigest({
    useEdgeKinds: ["database.postgres@v1"],
    permissionScopes: ["logs.read.own"],
  });

  const costResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_confirm_cost",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "example.db",
        source: {
          gitUrl: "https://github.com/example/db",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        useEdges: [{
          name: "database",
          kind: "database.postgres@v1",
          configRef: "config://inst_confirm_cost/database",
          secretRefs: [],
        }],
        permissionScopes: [{ capability: "logs.read.own", scope: {} }],
        confirm: {
          permissionDigest,
          costAck: false,
        },
      }),
    }),
  );
  expect(costResponse.status).toEqual(400);
  expect((await costResponse.json()).error).toEqual("cost_ack_required");

  const mismatchResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_confirm_mismatch",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "example.db",
        source: {
          gitUrl: "https://github.com/example/db",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        useEdges: [{
          name: "database",
          kind: "database.postgres@v1",
          configRef: "config://inst_confirm_mismatch/database",
          secretRefs: [],
        }],
        permissionScopes: [{ capability: "logs.read.own", scope: {} }],
        confirm: {
          permissionDigest:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          costAck: true,
        },
      }),
    }),
  );
  expect(mismatchResponse.status).toEqual(409);
  expect((await mismatchResponse.json()).error).toEqual("approval_digest_mismatch");
});

test("accounts handler requires account-session ownership for installation reads", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_tenant_read",
        accountId: "acct_tenant_read",
        spaceId: "space_tenant_read",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_tenant_owner",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  const ownerSession = seedAccountSession(
    store,
    "tsub_tenant_owner",
    "sess_tenant_owner",
  );
  const otherSession = seedAccountSession(
    store,
    "tsub_tenant_other",
    "sess_tenant_other",
  );

  const unauthenticated = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_tenant_read",
    ),
  );
  expect(unauthenticated.status).toEqual(401);

  const ownerDetail = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_tenant_read",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(ownerDetail.status).toEqual(200);

  const crossDetail = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_tenant_read",
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(crossDetail.status).toEqual(404);
  expect((await crossDetail.json()).error).toEqual("installation_not_found");

  const ownerList = await handler(
    new Request(
      "https://accounts.example.test/v1/installations?space_id=space_tenant_read",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(ownerList.status).toEqual(200);
  expect((await ownerList.json()).installations.length).toEqual(1);

  const crossList = await handler(
    new Request(
      "https://accounts.example.test/v1/installations?space_id=space_tenant_read",
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(crossList.status).toEqual(404);
  expect((await crossList.json()).error).toEqual("installation_not_found");
});

test("raw accounts handler requires account bearer for installation writes", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const ownerSession = seedAccountSession(
    store,
    "tsub_auth_owner",
    "sess_auth_owner",
  );
  const otherSession = seedAccountSession(
    store,
    "tsub_auth_other",
    "sess_auth_other",
  );
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    store,
  });
  const createBody = {
    installationId: "inst_auth_write",
    accountId: "acct_auth_write",
    spaceId: "space_auth_write",
    appId: "takos.chat",
    source: {
      gitUrl: "https://github.com/takos/takos",
      ref: "v1.2.3",
      commit: "abc123",
      planSnapshotDigest: "sha256:app",
    },
    mode: "shared-cell",
    createdBySubject: "tsub_auth_owner",
  };

  const unauthenticatedCreate = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify(createBody),
    }),
  );
  expect(unauthenticatedCreate.status).toEqual(401);

  const crossCreate = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      headers: accountSessionHeaders(otherSession),
      body: JSON.stringify(createBody),
    }),
  );
  expect(crossCreate.status).toEqual(404);
  expect((await crossCreate.json()).error).toEqual("account_not_found");

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      headers: accountSessionHeaders(ownerSession),
      body: JSON.stringify(createBody),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const unauthenticatedStatus = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_auth_write/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(unauthenticatedStatus.status).toEqual(401);

  await store.savePersonalAccessToken("takpat_read_auth", {
    tokenId: "pat_read_auth",
    tokenPrefix: "takpat_read_auth".slice(0, "takpat_".length + 8),
    subject: "tsub_auth_owner",
    name: "read",
    scopes: ["read"],
    createdAt: now,
  });
  const readPatStatus = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_auth_write/status",
      {
        method: "PATCH",
        headers: { authorization: "Bearer takpat_read_auth" },
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(readPatStatus.status).toEqual(403);
  expect((await readPatStatus.json()).error).toEqual("insufficient_scope");

  await store.savePersonalAccessToken("takpat_write_auth", {
    tokenId: "pat_write_auth",
    tokenPrefix: "takpat_write_auth".slice(0, "takpat_".length + 8),
    subject: "tsub_auth_owner",
    name: "write",
    scopes: ["write"],
    createdAt: now,
  });
  const writePatStatus = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_auth_write/status",
      {
        method: "PATCH",
        headers: { authorization: "Bearer takpat_write_auth" },
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(writePatStatus.status).toEqual(200);
  expect(typeof store.findPersonalAccessToken("takpat_write_auth")?.lastUsedAt).toEqual("number");

  const crossStatus = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_auth_write/status",
      {
        method: "PATCH",
        headers: accountSessionHeaders(otherSession),
        body: JSON.stringify({ status: "suspended" }),
      },
    ),
  );
  expect(crossStatus.status).toEqual(404);
  expect((await crossStatus.json()).error).toEqual("installation_not_found");

  const unauthenticatedEvents = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_auth_write/events",
    ),
  );
  expect(unauthenticatedEvents.status).toEqual(401);

  const readPatEvents = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_auth_write/events",
      { headers: { authorization: "Bearer takpat_read_auth" } },
    ),
  );
  expect(readPatEvents.status).toEqual(200);
});

test("raw accounts dashboard requires account ownership for installation surfaces", async () => {
  const store = new InMemoryAccountsStore();
  const ownerSession = seedAccountSession(
    store,
    "tsub_dashboard_owner",
    "sess_dashboard_owner",
  );
  const otherSession = seedAccountSession(
    store,
    "tsub_dashboard_other",
    "sess_dashboard_other",
  );
  const now = Date.now();
  seedOwnedSpace(
    store,
    "tsub_dashboard_owner",
    "acct_dashboard",
    "space_dashboard",
  );
  store.saveAppInstallation({
    installationId: "inst_dashboard_owned",
    accountId: "acct_dashboard",
    spaceId: "space_dashboard",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos",
    sourceRef: "v1.2.3",
    sourceCommit: "abc123",
    planSnapshotDigest: "sha256:app",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_dashboard_owner",
    createdAt: now,
    updatedAt: now,
  });
  const proxiedRequests: Request[] = [];
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    managedOfferingAccess: testManagedOfferingOpenAccess,
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      fetch: (input, init) => {
        proxiedRequests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_dashboard_apply",
            accountId: "acct_dashboard",
            spaceId: "space_dashboard",
            appId: "takos.chat",
            currentDeploymentId: "dep_dashboard_apply",
            status: "ready",
            createdAt: 1,
          },
          deployment: {
            id: "dep_dashboard_apply",
            installationId: "inst_dashboard_apply",
            source: {
              kind: "git",
              url: "https://github.com/takos/takos",
              ref: "v1.2.3",
              commit: "abc123",
            },
            planSnapshotDigest: "sha256:app",
            status: "succeeded",
            outputs: {},
            createdAt: 1,
          },
        }, { status: 201 }));
      },
    },
  });

  const unauthenticatedDetail = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_dashboard_owned",
    ),
  );
  expect(unauthenticatedDetail.status).toEqual(401);

  const ownerDetail = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_dashboard_owned",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(ownerDetail.status).toEqual(200);

  const crossDetail = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_dashboard_owned",
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(crossDetail.status).toEqual(404);
  expect((await crossDetail.json()).error).toEqual("installation_not_found");

  const unauthenticatedList = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations?space_id=space_dashboard",
    ),
  );
  expect(unauthenticatedList.status).toEqual(401);

  const ownerList = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations?space_id=space_dashboard",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(ownerList.status).toEqual(200);

  const crossList = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations?space_id=space_dashboard",
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(crossList.status).toEqual(404);
  expect((await crossList.json()).error).toEqual("space_not_found");

  const applyBody = new URLSearchParams({
    git: "https://github.com/takos/takos",
    ref: "v1.2.3",
    mode: "shared-cell",
    space_id: "space_dashboard",
  });
  const unauthenticatedApply = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: applyBody,
    }),
  );
  expect(unauthenticatedApply.status).toEqual(401);

  const crossApply = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      method: "POST",
      headers: {
        ...accountSessionHeaders(otherSession),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: applyBody,
    }),
  );
  expect(crossApply.status).toEqual(404);
  expect((await crossApply.json()).error).toEqual("space_not_found");

  const ownerApply = await handler(
    new Request("https://accounts.example.test/dashboard/install", {
      method: "POST",
      headers: {
        ...accountSessionHeaders(ownerSession),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: applyBody,
    }),
  );
  expect(ownerApply.status).toEqual(202);
  expect(proxiedRequests.length).toEqual(1);
});

test("accounts handler rejects removed serviceId aliases in install OIDC client requests", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_oidc_alias_create",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        oidcClients: [{
          serviceId: "identity.primary.oidc",
          redirectUris: ["http://localhost:8787/auth/oidc/callback"],
        }],
      }),
    }),
  );
  const body = await response.json();

  expect(response.status).toEqual(400);
  expect(body.error).toEqual("invalid_oidc_clients");
  expect(body.error_description).toEqual("oidcClients entries use servicePath; serviceId/service_id are not accepted");
  expect(store.findAppInstallation("inst_oidc_alias_create")).toEqual(undefined);
});

test("accounts handler accepts billing usage reports with active AppGrant scope", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_usage",
    subject: "tsub_owner",
    provider: "stripe",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppInstallation({
    installationId: "inst_usage",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planSnapshotDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_usage",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppGrant({
    grantId: "grant_usage",
    installationId: "inst_usage",
    capability: "billing.usage.report",
    scope: {},
    grantedAt: now,
  });
  store.saveAccessToken("access-usage", {
    clientId: "client_usage",
    subject: "pairwise_subject",
   takosumiSubject: "tsub_owner",
    installationId: "inst_usage",
    appId: "example.app",
    spaceId: "space_1",
    role: "owner",
    scope: "openid billing.usage.report",
    expiresAt: now + 5 * 60 * 1000,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_usage/billing/usage-reports",
      {
        method: "POST",
        headers: { authorization: "Bearer access-usage" },
        body: JSON.stringify({
          reportId: "usage_report_123",
          meter: "agent.compute.seconds",
          quantity: 42,
          unit: "seconds",
          periodStart: "2026-05-13T00:00:00.000Z",
          periodEnd: "2026-05-13T01:00:00.000Z",
          idempotencyKey: "usage-window-1",
          metadata: { run_id: "run_1" },
        }),
      },
    ),
  );

  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.usage_report.id).toEqual("usage_report_123");
  expect(body.usage_report.billing_account_id).toEqual("bill_usage");
  expect(body.usage_report.status).toEqual("accepted");
  expect(store.listBillingUsageRecordsForInstallation("inst_usage").map((record) =>
      record.meter
    )).toEqual(["agent.compute.seconds"]);
  expect(store.listInstallationEvents("inst_usage").map((event) => event.eventType)).toEqual(["billing.usage_reported"]);

  const duplicate = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_usage/billing/usage-reports",
      {
        method: "POST",
        headers: { authorization: "Bearer access-usage" },
        body: JSON.stringify({
          reportId: "usage_report_123",
          meter: "agent.compute.seconds",
          quantity: 42,
          unit: "seconds",
          periodStart: "2026-05-13T00:00:00.000Z",
          periodEnd: "2026-05-13T01:00:00.000Z",
          idempotencyKey: "usage-window-1",
          metadata: { run_id: "run_1" },
        }),
      },
    ),
  );

  expect(duplicate.status).toEqual(200);
  const duplicateBody = await duplicate.json();
  expect(duplicateBody.duplicate).toEqual(true);
  expect(duplicateBody.usage_report.id).toEqual("usage_report_123");
  expect(store.listBillingUsageRecordsForInstallation("inst_usage").length).toEqual(1);
  expect(store.listInstallationEvents("inst_usage").map((event) => event.eventType)).toEqual(["billing.usage_reported"]);

  const conflictingIdempotency = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_usage/billing/usage-reports",
      {
        method: "POST",
        headers: { authorization: "Bearer access-usage" },
        body: JSON.stringify({
          reportId: "usage_report_retry",
          meter: "agent.compute.seconds",
          quantity: 99,
          unit: "seconds",
          idempotencyKey: "usage-window-1",
          metadata: { run_id: "run_1_retry" },
        }),
      },
    ),
  );

  expect(conflictingIdempotency.status).toEqual(409);
  expect((await conflictingIdempotency.json()).error).toEqual("idempotency_key_conflict");

  store.saveBillingAccount({
    billingAccountId: "bill_usage_2",
    subject: "tsub_owner",
    provider: "stripe",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppInstallation({
    installationId: "inst_usage_2",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planSnapshotDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_usage_2",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppGrant({
    grantId: "grant_usage_2",
    installationId: "inst_usage_2",
    capability: "billing.usage.report",
    scope: {},
    grantedAt: now,
  });
  store.saveAccessToken("access-usage-2", {
    clientId: "client_usage_2",
    subject: "pairwise_subject_2",
   takosumiSubject: "tsub_owner",
    installationId: "inst_usage_2",
    appId: "example.app",
    spaceId: "space_1",
    role: "owner",
    scope: "openid billing.usage.report",
    expiresAt: now + 5 * 60 * 1000,
  });
  const crossInstallationReportId = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_usage_2/billing/usage-reports",
      {
        method: "POST",
        headers: { authorization: "Bearer access-usage-2" },
        body: JSON.stringify({
          reportId: "usage_report_123",
          meter: "agent.compute.seconds",
          quantity: 1,
          unit: "seconds",
          metadata: {},
        }),
      },
    ),
  );

  expect(crossInstallationReportId.status).toEqual(409);
  expect((await crossInstallationReportId.json()).error).toEqual("usage_report_id_conflict");
});

test("accounts handler rejects billing usage reports after permission scope revoke", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const now = Date.now();
  store.saveBillingAccount({
    billingAccountId: "bill_usage",
    subject: "tsub_owner",
    provider: "stripe",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppInstallation({
    installationId: "inst_usage",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planSnapshotDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_usage",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppGrant({
    grantId: "grant_usage",
    installationId: "inst_usage",
    capability: "billing.usage.report",
    scope: {},
    grantedAt: now,
    revokedAt: now + 1,
  });
  store.saveAccessToken("access-usage", {
    clientId: "client_usage",
    subject: "pairwise_subject",
   takosumiSubject: "tsub_owner",
    installationId: "inst_usage",
    appId: "example.app",
    spaceId: "space_1",
    role: "owner",
    scope: "openid billing.usage.report",
    expiresAt: now + 5 * 60 * 1000,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_usage/billing/usage-reports",
      {
        method: "POST",
        headers: { authorization: "Bearer access-usage" },
        body: JSON.stringify({
          reportId: "usage_report_123",
          meter: "agent.compute.seconds",
          quantity: 42,
          unit: "seconds",
        }),
      },
    ),
  );

  expect(response.status).toEqual(401);
  expect((await response.json()).error).toEqual("invalid_token");
  expect(store.listBillingUsageRecordsForInstallation("inst_usage")).toEqual([]);
});

test("accounts handler auto-assigns shared-cell RuntimeBinding from warm pool", async () => {
  const store = new InMemoryAccountsStore();
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 1 },
  ]);
  const handler = createAccountsHandler({
    store,
    sharedCellRuntime: (input) => pool.allocate(input),
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_shared_auto",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );

  expect(createResponse.status).toEqual(202);
  const created = await createResponse.json();
  // Wave 6 (Phase E SQL drift fix): `runtime_target` was removed from
  // the envelope. The internal `runtime_target_id` field on
  // `installation` is still surfaced (it carries the legacy ledger
  // reference for callers that need it during the transition).
  expect(created.installation.runtime_target_id).toEqual("rtb_inst_shared_auto_shared_cell");
  expect(store.findRuntimeBinding("rtb_inst_shared_auto_shared_cell")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_shared_auto");
  expect(store.listInstallationEvents("inst_shared_auto").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "runtime_target.assigned",
    ]);

  const exhausted = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_shared_exhausted",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "def456",
          planSnapshotDigest: "sha256:app2",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(exhausted.status).toEqual(503);
  expect((await exhausted.json()).error).toEqual("shared_cell_capacity_unavailable");
});

test("accounts handler records AppInstallation deployment and rollback revisions", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_revision",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos.git",
          ref: "v1.2.3",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          planSnapshotDigest: "sha256:app-v123",
          artifactDigest: "sha256:compiled-v123",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  const readyResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(readyResponse.status).toEqual(200);

  const deploymentBindings = [{
    name: "bootstrap",
    kind: "install-launch-token@v1",
    configRef: "config://inst_revision/bootstrap",
    secretRefs: [],
  }];
  const deploymentGrants = [{
    capability: "logs.read.own",
    scope: { type: "single-installation" },
  }];
  const deploymentPermissionDigest = await testRevisionPermissionDigest({
    operation: "deployment",
    installationId: "inst_revision",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos",
    sourceRef: "v1.2.4",
    sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    planSnapshotDigest: "sha256:app-v124",
    artifactDigest: "sha256:compiled-v124",
    requestedBindings: deploymentBindings,
    requestedGrants: deploymentGrants,
  });
  const deploymentDryRunResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision/deployments/dry-run",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
            artifactDigest: "sha256:compiled-v124",
          },
          useEdges: deploymentBindings,
          permissionScopes: deploymentGrants,
        }),
      },
    ),
  );
  expect(deploymentDryRunResponse.status).toEqual(200);
  const deploymentDryRun = await deploymentDryRunResponse.json();
  expect(deploymentDryRun.operation).toEqual("deployment");
  expect(deploymentDryRun.expected.permissionDigest).toEqual(deploymentPermissionDigest);
  expect(deploymentDryRun.expected.costAckRequired).toEqual(false);
  expect(deploymentDryRun.requestedUseEdges[0].name).toEqual("bootstrap");
  expect(deploymentDryRun.requestedPermissionScopes[0].capability).toEqual("logs.read.own");
  const deploymentResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
            artifactDigest: "sha256:compiled-v124",
          },
          useEdges: deploymentBindings,
          permissionScopes: deploymentGrants,
          confirm: {
            permissionDigest: deploymentPermissionDigest,
          },
          reason: "deployment v1.2.4",
        }),
      },
    ),
  );
  expect(deploymentResponse.status).toEqual(200);
  const deployed = await deploymentResponse.json();
  expect(deployed.operation).toEqual("deployment");
  expect(deployed.installation.source.ref).toEqual("v1.2.4");
  expect(deployed.event.payload.previous.source.ref).toEqual("v1.2.3");
  expect(deployed.event.payload.next.source.ref).toEqual("v1.2.4");
  expect(deployed.event.payload.requestedUseEdges[0].name).toEqual("bootstrap");
  expect(deployed.event.payload.requestedPermissionScopes[0].capability).toEqual("logs.read.own");
  expect(store.findAppInstallation("inst_revision")?.sourceCommit).toEqual("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const rollbackPermissionDigest = await testRevisionPermissionDigest({
    operation: "rollback",
    installationId: "inst_revision",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos.git",
    sourceRef: "v1.2.3",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    planSnapshotDigest: "sha256:app-v123",
    artifactDigest: "sha256:compiled-v123",
  });
  const rollbackResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision/rollback",
      {
        method: "POST",
        body: JSON.stringify({
          to: "v1.2.3",
          source: {
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            planSnapshotDigest: "sha256:app-v123",
            artifactDigest: "sha256:compiled-v123",
          },
          confirm: {
            permissionDigest: rollbackPermissionDigest,
          },
          reason: "operator rollback",
        }),
      },
    ),
  );
  expect(rollbackResponse.status).toEqual(200);
  const rolledBack = await rollbackResponse.json();
  expect(rolledBack.operation).toEqual("rollback");
  expect(rolledBack.installation.source.ref).toEqual("v1.2.3");
  expect(rolledBack.event.payload.previous.source.ref).toEqual("v1.2.4");
  expect(rolledBack.event.payload.next.source.ref).toEqual("v1.2.3");

  const eventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision/events",
    ),
  );
  expect(eventsResponse.status).toEqual(200);
  const eventsBody = await eventsResponse.json();
  expect(eventsBody.hash_chain_valid).toEqual(true);
  expect(eventsBody.events.map((event: { type: string }) => event.type)).toEqual([
    "installation.created",
    "installation.status_changed",
    "installation.deployed",
    "installation.rolled_back",
  ]);
});

test("accounts handler brokers deployment and rollback through space installer", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAppInstallation({
    installationId: "inst_core_revision",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos.git",
    sourceRef: "v1.2.3",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    planSnapshotDigest: "sha256:app-v123",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  const upstreamCalls: Array<{
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const handler = createAccountsHandler({
    store,
    installer: {
      url: "http://takosumi.internal:8788",
      token: "installer-secret",
      fetch: (url, init) => {
        const path = new URL(String(url)).pathname;
        const requestInit = init as
          | { body?: unknown; headers?: HeadersInit }
          | undefined;
        const body = JSON.parse(String(requestInit?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        upstreamCalls.push({
          path,
          authorization: new Headers(requestInit?.headers).get(
            "authorization",
          ),
          body,
        });
        if (
          path ===
            "/v1/installations/inst_core_revision/deployments/dry-run"
        ) {
          return Promise.resolve(Response.json({
            source: {
              kind: "git",
              url: "https://github.com/takos/takos.git",
              ref: "v1.2.4",
              commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            planSnapshotDigest: "sha256:app-v124",
            changes: [],
            expected: {
              planSnapshotDigest: "sha256:app-v124",
              commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              currentDeploymentId: "dep_old",
            },
          }));
        }
        if (path === "/v1/installations/inst_core_revision/deployments") {
          return Promise.resolve(Response.json({
            deployment: {
              id: "dep_new",
              installationId: "inst_core_revision",
              source: {
                kind: "git",
                url: "https://github.com/takos/takos.git",
                ref: "v1.2.4",
                commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
              planSnapshotDigest: "sha256:app-v124",
              status: "succeeded",
              outputs: {
                components: {
                  public: {
                    url: "https://takos-new.example.test",
                    host: "takos-new.example.test",
                    scheme: "https",
                    listener: "public",
                  },
                },
              },
              createdAt: now + 1,
            },
          }, { status: 201 }));
        }
        if (path === "/v1/installations/inst_core_revision/rollback") {
          return Promise.resolve(Response.json({
            installation: {
              id: "inst_core_revision",
              spaceId: "space_1",
              appId: "takos.chat",
              currentDeploymentId: "dep_old",
              status: "ready",
              createdAt: now,
            },
            deployment: {
              id: "dep_old",
              installationId: "inst_core_revision",
              source: {
                kind: "git",
                url: "https://github.com/takos/takos.git",
                ref: "v1.2.3",
                commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
              planSnapshotDigest: "sha256:app-v123",
              status: "succeeded",
              outputs: {},
              createdAt: now,
            },
            rollback: {
              rolledBackFrom: "dep_new",
              rolledBackTo: "dep_old",
            },
          }));
        }
        return Promise.resolve(
          Response.json({ error: "unexpected_upstream_path" }, {
            status: 500,
          }),
        );
      },
    },
  });

  const dryRunResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_core_revision/deployments/dry-run",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            kind: "git",
            url: "https://github.com/takos/takos.git",
            ref: "v1.2.4",
          },
        }),
      },
    ),
  );
  expect(dryRunResponse.status).toEqual(200);
  const dryRun = await dryRunResponse.json();
  expect(dryRun.expected.currentDeploymentId).toEqual("dep_old");
  expect(dryRun.expected.commit).toEqual("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  expect(typeof dryRun.expected.permissionDigest).toEqual("string");

  const deployResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_core_revision/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            kind: "git",
            url: "https://github.com/takos/takos.git",
            ref: "v1.2.4",
          },
          expected: {
            planSnapshotDigest: "sha256:app-v124",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            currentDeploymentId: "dep_old",
          },
          confirm: {
            permissionDigest: dryRun.expected.permissionDigest,
          },
          reason: "deployment v1.2.4",
        }),
      },
    ),
  );
  expect(deployResponse.status).toEqual(200);
  const deployed = await deployResponse.json();
  expect(deployed.installation.source.ref).toEqual("v1.2.4");
  expect(deployed.event.payload.coreDeployment.id).toEqual("dep_new");
  expect(deployed.installation.launch_url).toEqual("https://takos-new.example.test");

  const rollbackResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_core_revision/rollback",
      {
        method: "POST",
        body: JSON.stringify({
          deploymentId: "dep_old",
          reason: "operator rollback",
        }),
      },
    ),
  );
  expect(rollbackResponse.status).toEqual(200);
  const rolledBack = await rollbackResponse.json();
  expect(rolledBack.installation.source.ref).toEqual("v1.2.3");
  expect(rolledBack.installation.launch_url).toEqual(null);
  expect(rolledBack.event.payload.coreDeployment.rollback.rolledBackTo).toEqual("dep_old");
  expect(upstreamCalls.map((call) => call.path)).toEqual([
    "/v1/installations/inst_core_revision/deployments/dry-run",
    "/v1/installations/inst_core_revision/deployments",
    "/v1/installations/inst_core_revision/rollback",
  ]);
  expect(upstreamCalls.map((call) => call.authorization)).toEqual([
      "Bearer installer-secret",
      "Bearer installer-secret",
      "Bearer installer-secret",
    ]);
  expect((upstreamCalls[1].body.expected as Record<string, unknown>)
      .currentDeploymentId).toEqual("dep_old");
  expect(upstreamCalls[2].body.deploymentId).toEqual("dep_old");
});

test("accounts handler rejects invalid AppInstallation revision mutations", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_revision_guard",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos.git",
          ref: "v1.2.3",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          planSnapshotDigest: "sha256:app-v123",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const pendingDeployment = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
          },
        }),
      },
    ),
  );
  expect(pendingDeployment.status).toEqual(409);
  expect((await pendingDeployment.json()).error).toEqual("state_conflict");

  const readyResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(readyResponse.status).toEqual(200);

  const missingConfirm = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
          },
        }),
      },
    ),
  );
  expect(missingConfirm.status).toEqual(400);
  expect((await missingConfirm.json()).error).toEqual("invalid_confirm");

  const digestMismatch = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
          },
          confirm: {
            permissionDigest:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        }),
      },
    ),
  );
  expect(digestMismatch.status).toEqual(409);
  expect((await digestMismatch.json()).error).toEqual("approval_digest_mismatch");

  const meteredBindings = [{
    name: "database",
    kind: "database.postgres@v1",
    configRef: "config://inst_revision_guard/database",
    secretRefs: ["secret://inst_revision_guard/database/password"],
  }];
  const meteredDigest = await testRevisionPermissionDigest({
    operation: "deployment",
    installationId: "inst_revision_guard",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos.git",
    sourceRef: "v1.2.4",
    sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    planSnapshotDigest: "sha256:app-v124",
    requestedBindings: meteredBindings,
  });
  const missingCostAck = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
          },
          useEdges: meteredBindings,
          confirm: {
            permissionDigest: meteredDigest,
          },
        }),
      },
    ),
  );
  expect(missingCostAck.status).toEqual(400);
  expect((await missingCostAck.json()).error).toEqual("cost_ack_required");

  const sourceMismatch = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/deployments",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            gitUrl: "https://github.com/example/other",
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planSnapshotDigest: "sha256:app-v124",
          },
        }),
      },
    ),
  );
  expect(sourceMismatch.status).toEqual(409);
  expect((await sourceMismatch.json()).error).toEqual("source_mismatch");

  const appMismatch = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_revision_guard/rollback",
      {
        method: "POST",
        body: JSON.stringify({
          appId: "example.other",
          to: "v1.2.2",
          source: {
            commit: "cccccccccccccccccccccccccccccccccccccccc",
            planSnapshotDigest: "sha256:app-v122",
          },
        }),
      },
    ),
  );
  expect(appMismatch.status).toEqual(409);
  expect((await appMismatch.json()).error).toEqual("app_mismatch");
});

test("accounts handler blocks AppInstallation creation when managed offering access is closed", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    managedOfferingAccess: { status: "closed" },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_blocked",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "example.app",
        source: {
          gitUrl: "https://github.com/example/app",
          ref: "main",
          commit: "abc123",
          planSnapshotDigest: "sha256:manifest",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );

  expect(response.status).toEqual(503);
  expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  expect(store.findAppInstallation("inst_blocked")).toEqual(undefined);
});

test("accounts handler blocks AppInstallation import when managed offering access is closed", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    managedOfferingAccess: { status: "closed" },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations/import", {
      method: "POST",
      body: JSON.stringify({
        bundle: { kind: "takosumi.accounts.export-bundle@v1" },
        target: { issuer: "https://accounts.target.test" },
      }),
    }),
  );

  expect(response.status).toEqual(503);
  expect((await response.json()).error).toEqual("launch_readiness_not_complete");
});

test("accounts handler blocks installation access mutations when managed offering access is closed", async () => {
  const handler = createAccountsHandler({
    managedOfferingAccess: { status: "closed" },
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  const blockedRequests = [
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/deployments",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/rollback",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/materialize",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "installing" }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/installations/inst_1/export",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_1/materialize",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_1/export",
      {
        method: "POST",
      },
    ),
  ];

  for (const request of blockedRequests) {
    const response = await handler(request);
    expect(response.status).toEqual(503);
    expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  }
});

test("accounts handler blocks core OAuth and PAT issuance when managed offering access is closed", async () => {
  const handler = createAccountsHandler({
    managedOfferingAccess: { status: "closed" },
  });

  const blockedRequests = [
    new Request(
      "https://accounts.example.test/oauth/authorize?client_id=takos&redirect_uri=https%3A%2F%2Ftakos.example.test%2Fcallback&response_type=code&scope=openid",
    ),
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "code",
      }),
    }),
    new Request("https://accounts.example.test/v1/account/tokens", {
      method: "POST",
      body: JSON.stringify({ subject: "tsub_owner", label: "operator" }),
    }),
  ];

  for (const request of blockedRequests) {
    const response = await handler(request);
    expect(response.status).toEqual(503);
    expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  }
});

test("accounts handler completes AppInstallation ready suspended exported lifecycle", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_lifecycle",
        accountId: "acct_lifecycle",
        spaceId: "space_lifecycle",
        appId: "example.lifecycle",
        source: {
          gitUrl: "https://github.com/example/lifecycle",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_lifecycle",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  expect((await createResponse.json()).installation.status).toEqual("installing");

  for (
    const [status, reason] of [
      ["ready", "healthcheck passed"],
      ["suspended", "operator pause"],
      ["exported", "self-hosted export complete"],
    ] as const
  ) {
    const response = await handler(
      new Request(
        "https://accounts.example.test/v1/installations/inst_lifecycle/status",
        {
          method: "PATCH",
          body: JSON.stringify({ status, reason }),
        },
      ),
    );
    expect(response.status).toEqual(200);
    expect((await response.json()).installation.status).toEqual(status);
  }

  const exportedToReadyResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_lifecycle/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(exportedToReadyResponse.status).toEqual(409);
  const ownerSession = seedAccountSession(store, "tsub_lifecycle");

  const inspectResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_lifecycle",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(inspectResponse.status).toEqual(200);
  expect((await inspectResponse.json()).installation.status).toEqual("exported");

  const eventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_lifecycle/events",
    ),
  );
  expect(eventsResponse.status).toEqual(200);
  const events = await eventsResponse.json();
  expect(events.hash_chain_valid).toEqual(true);
  expect(events.events.map((event: { type: string }) => event.type)).toEqual([
      "installation.created",
      "installation.status_changed",
      "installation.status_changed",
      "installation.status_changed",
      "installation.exported",
    ]);
});

test("accounts handler records uninstall for already terminal installations", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_failed_uninstall",
        accountId: "acct_failed_uninstall",
        spaceId: "space_failed_uninstall",
        appId: "example.failed-uninstall",
        source: {
          gitUrl: "https://github.com/example/failed-uninstall",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "failed",
        createdBySubject: "tsub_failed_uninstall",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const uninstallResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_failed_uninstall",
      { method: "DELETE" },
    ),
  );
  expect(uninstallResponse.status).toEqual(200);
  const body = await uninstallResponse.json();
  expect(body.installation.status).toEqual("failed");
  expect(body.status_event).toEqual(undefined);
  expect(body.event.type).toEqual("installation.uninstalled");
  expect(body.event.payload.from).toEqual("failed");
  expect(body.event.payload.to).toEqual("failed");
});

test("accounts handler accepts AppInstallation materialize requests idempotently", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_materialize_request",
        accountId: "acct_materialize",
        spaceId: "space_materialize",
        appId: "example.materialize",
        source: {
          gitUrl: "https://github.com/example/materialize",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize",
        runtimeTarget: {
          runtimeTargetId: "rtb_materialize_shared",
          targetType: "shared-cell",
          targetId:
            "shared-cell://tokyo-cell-01/namespaces/inst_materialize_request",
        },
        useEdges: [{
          useEdgeId: "bind_materialize_auth",
          name: "auth",
          kind: "identity.oidc@v1",
          configRef:
            "takosumi-installer://installable-app/example.materialize/use-edges/auth",
          secretRefs: [],
        }, {
          useEdgeId: "bind_materialize_database",
          name: "database",
          kind: "database.postgres@v1",
          configRef:
            "takosumi-installer://installable-app/example.materialize/use-edges/database",
          secretRefs: ["secret://inst_materialize_request/database/password"],
        }, {
          useEdgeId: "bind_materialize_domain",
          name: "domain",
          kind: "domain.http@v1",
          configRef:
            "takosumi-installer://installable-app/example.materialize/use-edges/domain",
          secretRefs: [],
        }],
        oidcClients: [{
          useEdge: "auth",
          namespacePath: "identity.primary.oidc",
          issuerUrl: "https://accounts.example.test",
          redirectUris: [
            "https://example.takosumi.app/auth/oidc/callback",
          ],
          allowedScopes: ["openid", "profile"],
          subjectMode: "pairwise",
        }],
      }),
    }),
  );

  const missingKeyResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: { costAck: true },
        }),
      },
    ),
  );
  expect(missingKeyResponse.status).toEqual(400);

  const missingPermissionDigestResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-missing-digest" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: { costAck: true },
        }),
      },
    ),
  );
  expect(missingPermissionDigestResponse.status).toEqual(400);
  expect((await missingPermissionDigestResponse.json()).error).toEqual("invalid_confirm");

  const mismatchedPermissionDigestResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-bad-digest" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: {
            costAck: true,
            permissionDigest:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        }),
      },
    ),
  );
  expect(mismatchedPermissionDigestResponse.status).toEqual(409);
  expect((await mismatchedPermissionDigestResponse.json()).error).toEqual("approval_digest_mismatch");

  const materializePlan = {
    compute: "small",
    database: "small",
    objectStore: "standard",
  };
  const materializeCutover = { strategy: "blue-green", drainSeconds: 30 };
  const materializePermissionDigest = await testMaterializePermissionDigest({
    installationId: "inst_materialize_request",
    region: "tokyo",
    plan: materializePlan,
    cutover: materializeCutover,
  });
  const request = new Request(
    "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
    {
      method: "POST",
      headers: { "Idempotency-Key": "idem-materialize-1" },
      body: JSON.stringify({
        mode: "dedicated",
        region: "tokyo",
        plan: materializePlan,
        cutover: materializeCutover,
        confirm: {
          costAck: true,
          permissionDigest: materializePermissionDigest,
        },
      }),
    },
  );
  const acceptedResponse = await handler(request);
  expect(acceptedResponse.status).toEqual(202);
  const accepted = await acceptedResponse.json();
  expect(accepted.operationId).toContain("op_");
  expect(accepted.installationId).toEqual("inst_materialize_request");
  expect(accepted.fromMode).toEqual("shared-cell");
  expect(accepted.toMode).toEqual("dedicated");
  expect(typeof accepted.preserveDigest).toEqual("string");
  expect(accepted.preserve.dataNamespace).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_materialize_request");
  expect(accepted.preserve.oidcClient.issuerUrl).toEqual("https://accounts.example.test");
  expect(accepted.preserve.oidcClient.redirectUris).toEqual(["https://example.takosumi.app/auth/oidc/callback"]);
  expect(accepted.preserve.useEdges.map((useEdge: { name: string }) => useEdge.name)).toEqual(["auth", "database", "domain"]);
  expect(accepted.preserve.useEdges[0].configRef).toContain("takosumi-accounts://installations/inst_materialize_request/use-edges/auth/oidc-client/");
  expect(accepted.trackingUrl).toContain("installation.materialize-requested");

  const repeatedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-1" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          plan: materializePlan,
          cutover: materializeCutover,
          confirm: {
            costAck: true,
            permissionDigest: materializePermissionDigest,
          },
        }),
      },
    ),
  );
  expect(repeatedResponse.status).toEqual(202);
  expect((await repeatedResponse.json()).operationId).toEqual(accepted.operationId);

  const bodyMismatchResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-1" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "osaka",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_materialize_request",
              region: "osaka",
            }),
          },
        }),
      },
    ),
  );
  expect(bodyMismatchResponse.status).toEqual(409);
  expect((await bodyMismatchResponse.json()).error).toEqual("idempotency_key_conflict");

  const conflictingResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-2" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_materialize_request",
              region: "tokyo",
            }),
          },
        }),
      },
    ),
  );
  expect(conflictingResponse.status).toEqual(409);
  expect(store.listInstallationEvents("inst_materialize_request").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "oidc_client.registered",
      "use_edge.materialized",
      "installation.materialize-requested",
    ]);
  expect(store.findAppInstallation("inst_materialize_request")?.mode).toEqual("shared-cell");

  const filteredEventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/events?types=installation.materialize-requested",
    ),
  );
  expect(filteredEventsResponse.status).toEqual(200);
  const filteredEvents = await filteredEventsResponse.json();
  expect(filteredEvents.hash_chain_valid).toEqual(true);
  expect(filteredEvents.events.map((event: { type: string }) => event.type)).toEqual(["installation.materialize-requested"]);
  expect(filteredEvents.events[0].payload.preserveDigest).toEqual(accepted.preserveDigest);

  const mismatchedCompleteResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ready",
          mode: "dedicated",
          operationId: accepted.operationId,
          preserveDigest: "sha256:mismatch",
          runtimeTarget: {
            runtimeTargetId: "rtb_materialize_dedicated_bad",
            targetType: "dedicated",
            targetId: "tokyo-dedicated-bad",
          },
        }),
      },
    ),
  );
  expect(mismatchedCompleteResponse.status).toEqual(409);
  expect((await mismatchedCompleteResponse.json()).error).toEqual("preservation_mismatch");

  const completeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ready",
          mode: "dedicated",
          operationId: accepted.operationId,
          preserveDigest: accepted.preserveDigest,
          reason: "dedicated runtime ready",
          runtimeTarget: {
            runtimeTargetId: "rtb_materialize_dedicated",
            targetType: "dedicated",
            targetId: "tokyo-dedicated-01",
          },
        }),
      },
    ),
  );
  expect(completeResponse.status).toEqual(200);
  const complete = await completeResponse.json();
  expect(complete.installation.mode).toEqual("dedicated");
  expect(complete.event.type).toEqual("installation.materialize-succeeded");
  expect(complete.event.payload.preserveDigest).toEqual(accepted.preserveDigest);
  expect(store.findRuntimeBinding("rtb_materialize_dedicated")?.targetId).toEqual("tokyo-dedicated-01");

  const repeatedCompleteResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ready",
          mode: "dedicated",
          operationId: accepted.operationId,
          runtimeTargetId: "rtb_materialize_dedicated",
        }),
      },
    ),
  );
  expect(repeatedCompleteResponse.status).toEqual(409);
});

test("accounts handler records AppInstallation materialize operation failures", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_materialize_failure",
        accountId: "acct_materialize_failure",
        spaceId: "space_materialize_failure",
        appId: "example.materialize-failure",
        source: {
          gitUrl: "https://github.com/example/materialize-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize_failure",
      }),
    }),
  );

  const materializeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_failure/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-failure" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_materialize_failure",
              region: "tokyo",
            }),
          },
        }),
      },
    ),
  );
  expect(materializeResponse.status).toEqual(202);
  const operationId = (await materializeResponse.json()).operationId;

  const failedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_failure/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          operation: "materialize",
          operationId,
          reason: "dedicated runtime failed",
        }),
      },
    ),
  );
  expect(failedResponse.status).toEqual(200);
  expect((await failedResponse.json()).event.type).toEqual("installation.materialize-failed");
  expect(store.listInstallationEvents("inst_materialize_failure").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "installation.materialize-requested",
      "installation.status_changed",
      "installation.materialize-failed",
    ]);
});

test("accounts handler runs configured materialize worker and swaps runtime binding", async () => {
  const store = new InMemoryAccountsStore();
  const captured: {
    operationId?: string;
    dataNamespace?: unknown;
    bindingNames?: readonly unknown[];
    oidcIssuer?: unknown;
  } = {};
  const handler = createAccountsHandler({
    store,
    materializeWorker: (input) => {
      const preserveBindings = Array.isArray(input.preserve.useEdges)
        ? input.preserve.useEdges as readonly Record<string, unknown>[]
        : [];
      const preserveOidc = typeof input.preserve.oidcClient === "object" &&
          input.preserve.oidcClient !== null
        ? input.preserve.oidcClient as { readonly issuerUrl?: unknown }
        : undefined;
      const preserveRuntime = typeof input.preserve.runtimeTarget ===
            "object" &&
          input.preserve.runtimeTarget !== null
        ? input.preserve.runtimeTarget as { readonly targetId?: unknown }
        : undefined;
      captured.operationId = input.operationId;
      captured.dataNamespace = input.preserve.dataNamespace;
      captured.bindingNames = preserveBindings.map((binding) => binding.name);
      captured.oidcIssuer = preserveOidc?.issuerUrl;
      return {
        preserveDigest: input.preserveDigest,
        reason: "dedicated worker copied namespace and cut over",
        runtimeTarget: {
          runtimeTargetId: "rtb_materialize_worker_dedicated",
          targetType: "dedicated",
          targetId: "dedicated://tokyo/inst_materialize_worker",
        },
        continuity: {
          sourceDataNamespace: typeof input.preserve.dataNamespace === "string"
            ? input.preserve.dataNamespace
            : null,
          oidcClient: preserveOidc
            ? { ...preserveOidc } as Record<string, unknown>
            : null,
          preservedUseEdges: preserveBindings.map((binding) => ({
            name: String(binding.name ?? ""),
            kind: String(binding.kind ?? "") as AppBindingKind,
            configRef: String(binding.configRef ?? ""),
            secretRefs: Array.isArray(binding.secretRefs)
              ? binding.secretRefs.filter((entry): entry is string =>
                typeof entry === "string"
              )
              : [],
          })),
          cutover: {
            fromTargetId: typeof preserveRuntime?.targetId === "string"
              ? preserveRuntime.targetId
              : null,
            toTargetId: "dedicated://tokyo/inst_materialize_worker",
            ready: true,
            strategy: "blue-green",
          },
        },
      };
    },
  });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_materialize_worker",
        accountId: "acct_materialize_worker",
        spaceId: "space_materialize_worker",
        appId: "example.materialize-worker",
        source: {
          gitUrl: "https://github.com/example/materialize-worker",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize_worker",
        runtimeTarget: {
          runtimeTargetId: "rtb_materialize_worker_shared",
          targetType: "shared-cell",
          targetId:
            "shared-cell://tokyo-cell-01/namespaces/inst_materialize_worker",
        },
        useEdges: [{
          useEdgeId: "bind_materialize_worker_auth",
          name: "auth",
          kind: "identity.oidc@v1",
          configRef:
            "takosumi-installer://installable-app/example.materialize-worker/use-edges/auth",
          secretRefs: [],
        }, {
          useEdgeId: "bind_materialize_worker_domain",
          name: "domain",
          kind: "domain.http@v1",
          configRef:
            "takosumi-installer://installable-app/example.materialize-worker/use-edges/domain",
          secretRefs: [],
        }],
        oidcClients: [{
          useEdge: "auth",
          namespacePath: "identity.primary.oidc",
          issuerUrl: "https://accounts.example.test",
          redirectUris: [
            "https://materialize-worker.example.test/auth/oidc/callback",
          ],
          allowedScopes: ["openid", "profile"],
          subjectMode: "pairwise",
        }],
      }),
    }),
  );

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_worker/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-worker" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          plan: { compute: "small" },
          cutover: { strategy: "blue-green" },
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_materialize_worker",
              region: "tokyo",
              plan: { compute: "small" },
              cutover: { strategy: "blue-green" },
            }),
          },
        }),
      },
    ),
  );
  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.status).toEqual("ready");
  expect(body.installation.mode).toEqual("dedicated");
  expect(body.installation.status).toEqual("ready");
  expect(body.runtime_target.target_id).toEqual("dedicated://tokyo/inst_materialize_worker");
  expect(body.event.type).toEqual("installation.materialize-succeeded");
  expect(body.event.payload.preserveDigest).toEqual(body.preserveDigest);
  expect(captured.operationId).toEqual(body.operationId);
  expect(captured.dataNamespace).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_materialize_worker");
  expect(captured.oidcIssuer).toEqual("https://accounts.example.test");
  expect(captured.bindingNames).toEqual(["auth", "domain"]);
  expect(store.findAppInstallation("inst_materialize_worker")?.runtimeBindingId).toEqual("rtb_materialize_worker_dedicated");
  expect(store.findRuntimeBinding("rtb_materialize_worker_dedicated")?.targetType).toEqual("dedicated");
});

test("accounts handler rejects materialize worker continuity mismatch before cutover", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    materializeWorker: (input) => ({
      preserveDigest: input.preserveDigest,
      runtimeTarget: {
        runtimeTargetId: "rtb_materialize_mismatch_dedicated",
        targetType: "dedicated",
        targetId: "dedicated://tokyo/inst_materialize_mismatch",
      },
      continuity: {
        sourceDataNamespace: "shared-cell://wrong/namespaces/other",
        oidcClient: null,
        preservedUseEdges: [],
        cutover: {
          fromTargetId: "shared-cell://wrong/namespaces/other",
          toTargetId: "dedicated://tokyo/inst_materialize_mismatch",
          ready: true,
        },
      },
    }),
  });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_materialize_mismatch",
        accountId: "acct_materialize_mismatch",
        spaceId: "space_materialize_mismatch",
        appId: "example.materialize-mismatch",
        source: {
          gitUrl: "https://github.com/example/materialize-mismatch",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize_mismatch",
        runtimeTarget: {
          runtimeTargetId: "rtb_materialize_mismatch_shared",
          targetType: "shared-cell",
          targetId:
            "shared-cell://tokyo-cell-01/namespaces/inst_materialize_mismatch",
        },
      }),
    }),
  );

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_mismatch/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-mismatch" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          plan: { compute: "small" },
          cutover: { strategy: "blue-green" },
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_materialize_mismatch",
              region: "tokyo",
              plan: { compute: "small" },
              cutover: { strategy: "blue-green" },
            }),
          },
        }),
      },
    ),
  );
  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.status).toEqual("failed");
  expect(body.error).toEqual("materialize worker continuity sourceDataNamespace mismatch");
  expect(store.findAppInstallation("inst_materialize_mismatch")?.mode).toEqual("shared-cell");
  expect(store.findAppInstallation("inst_materialize_mismatch")?.runtimeBindingId).toEqual("rtb_materialize_mismatch_shared");
});

test("accounts handler keeps shared-cell runtime ready when materialize worker fails", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    materializeWorker: () => {
      throw new Error("copy failed");
    },
  });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_materialize_worker_failure",
        accountId: "acct_materialize_worker_failure",
        spaceId: "space_materialize_worker_failure",
        appId: "example.materialize-worker-failure",
        source: {
          gitUrl: "https://github.com/example/materialize-worker-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize_worker_failure",
        runtimeTarget: {
          runtimeTargetId: "rtb_materialize_worker_failure_shared",
          targetType: "shared-cell",
          targetId:
            "shared-cell://tokyo-cell-01/namespaces/inst_materialize_worker_failure",
        },
      }),
    }),
  );

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_materialize_worker_failure/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-worker-failure" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          plan: { compute: "small" },
          cutover: { strategy: "blue-green" },
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_materialize_worker_failure",
              region: "tokyo",
              plan: { compute: "small" },
              cutover: { strategy: "blue-green" },
            }),
          },
        }),
      },
    ),
  );
  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.status).toEqual("failed");
  expect(body.error).toEqual("copy failed");
  expect(body.event.type).toEqual("installation.materialize-failed");
  expect(store.findAppInstallation("inst_materialize_worker_failure")?.mode).toEqual("shared-cell");
  expect(store.findAppInstallation("inst_materialize_worker_failure")?.status).toEqual("ready");
  expect(store.findAppInstallation("inst_materialize_worker_failure")
      ?.runtimeBindingId).toEqual("rtb_materialize_worker_failure_shared");
});

test("accounts handler rejects operation completion without request event", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_missing_operation",
        accountId: "acct_missing_operation",
        spaceId: "space_missing_operation",
        appId: "example.missing-operation",
        source: {
          gitUrl: "https://github.com/example/missing-operation",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_missing_operation",
      }),
    }),
  );

  const exportedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_missing_operation/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "exported",
          operationId: "op_missing_export",
        }),
      },
    ),
  );
  expect(exportedResponse.status).toEqual(409);
  expect((await exportedResponse.json()).error).toEqual("operation_not_found");
  expect(store.findAppInstallation("inst_missing_operation")?.status).toEqual("ready");

  const failedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_missing_operation/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          operation: "export",
          operationId: "op_missing_export",
        }),
      },
    ),
  );
  expect(failedResponse.status).toEqual(409);
  expect((await failedResponse.json()).error).toEqual("operation_not_found");
  expect(store.findAppInstallation("inst_missing_operation")?.status).toEqual("ready");
});

test("accounts handler accepts AppInstallation export requests and exposes pending operation", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    exportDownloadSigningSecret: "test-export-download-secret",
  });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_export_request",
        accountId: "acct_export",
        spaceId: "space_export",
        appId: "example.export",
        source: {
          gitUrl: "https://github.com/example/export",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_export",
      }),
    }),
  );

  const acceptedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_request/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-1" },
        body: JSON.stringify({
          includeData: true,
          format: "bundle",
          encryption: {
            method: "age",
            recipients: ["age1takosumiexportrecipient"],
          },
          scope: {
            data: ["postgres", "blobs"],
            secrets: "templates-only",
          },
        }),
      },
    ),
  );
  expect(acceptedResponse.status).toEqual(202);
  const accepted = await acceptedResponse.json();
  expect(accepted.operationId).toContain("op_");
  expect(accepted.status).toEqual("preparing");
  expect(accepted.downloadUrl).toEqual(null);
  expect(acceptedResponse.headers.get("location") ?? "").toContain(`/v1/installations/inst_export_request/exports/${accepted.operationId}`);

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_request/exports/${accepted.operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  expect((await operationResponse.json()).operationId).toEqual(accepted.operationId);

  const pendingDownloadResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_request/exports/${accepted.operationId}/download`,
    ),
  );
  expect(pendingDownloadResponse.status).toEqual(409);
  expect((await pendingDownloadResponse.json()).error).toEqual("export_not_ready");

  const repeatedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_request/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-1" },
        body: JSON.stringify({
          includeData: true,
          format: "bundle",
          encryption: {
            method: "age",
            recipients: ["age1takosumiexportrecipient"],
          },
          scope: {
            data: ["postgres", "blobs"],
            secrets: "templates-only",
          },
        }),
      },
    ),
  );
  expect(repeatedResponse.status).toEqual(202);
  expect((await repeatedResponse.json()).operationId).toEqual(accepted.operationId);

  const bodyMismatchResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_request/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-1" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
        }),
      },
    ),
  );
  expect(bodyMismatchResponse.status).toEqual(409);
  expect((await bodyMismatchResponse.json()).error).toEqual("idempotency_key_conflict");

  const exportedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "exported",
          reason: "bundle ready",
          operationId: accepted.operationId,
          downloadUrl: "https://downloads.example.test/export.tar.zst",
          downloadExpiresAt: "2999-05-10T00:00:00.000Z",
        }),
      },
    ),
  );
  expect(exportedResponse.status).toEqual(200);
  expect((await exportedResponse.json()).event.type).toEqual("installation.exported");

  const completedOperationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_request/exports/${accepted.operationId}`,
    ),
  );
  expect(completedOperationResponse.status).toEqual(200);
  const completedOperation = await completedOperationResponse.json();
  expect(completedOperation.status).toEqual("exported");
  expect(completedOperation.downloadUrl).toEqual("https://downloads.example.test/export.tar.zst");

  const downloadResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_request/exports/${accepted.operationId}/download`,
    ),
  );
  // The handler now resigns the redirect target with HMAC-SHA256 against the
  // operator-supplied secret (Round 2 fix). The recorded `downloadUrl` is
  // preserved as the origin, but `tk_sig` / `tk_exp` are appended.
  expect(downloadResponse.status).toEqual(302);
  const downloadLocation = downloadResponse.headers.get("location") ?? "";
  expect(downloadLocation).toContain("https://downloads.example.test/export.tar.zst");
  expect(downloadLocation).toContain("tk_sig=");
  expect(downloadLocation).toContain("tk_exp=");

  const repeatedExportedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "exported",
          operationId: accepted.operationId,
        }),
      },
    ),
  );
  expect(repeatedExportedResponse.status).toEqual(409);
  expect((await repeatedExportedResponse.json()).error).toEqual("operation_already_closed");

  expect(store.listInstallationEvents("inst_export_request").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "installation.export-requested",
      "installation.status_changed",
      "installation.exported",
    ]);
});

test("accounts handler runs configured export worker and closes operation", async () => {
  const store = new InMemoryAccountsStore();
  const captured: {
    operationId?: string;
    requestIncludeData?: boolean;
    bundleKind?: string;
    sourceCommit?: string;
    useEdgeNames?: readonly string[];
    permissionScopeIds?: readonly string[];
    eventTypes?: readonly string[];
  } = {};
  const handler = createAccountsHandler({
    store,
    exportDownloadSigningSecret: "test-export-worker-secret",
    exportWorker: (input) => {
      captured.operationId = input.operationId;
      captured.requestIncludeData = input.request.includeData;
      captured.bundleKind = input.bundle.kind;
      captured.sourceCommit = input.bundle.source.commit;
      captured.useEdgeNames = input.bundle.useEdges.map((useEdge) =>
        useEdge.name
      );
      captured.permissionScopeIds = input.bundle.permissionScopes.map((scope) =>
        scope.permissionScopeId
      );
      captured.eventTypes = input.bundle.events.map((event) => event.type);
      return {
        downloadUrl:
          `https://downloads.example.test/${input.operationId}/takos-export.tar.zst`,
        downloadExpiresAt: "2999-05-10T00:00:00.000Z",
      };
    },
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_export_worker",
        accountId: "acct_export_worker",
        spaceId: "space_export_worker",
        appId: "example.export-worker",
        source: {
          gitUrl: "https://github.com/example/export-worker",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_export_worker",
        runtimeTarget: {
          runtimeTargetId: "rtb_export_worker",
          targetType: "dedicated",
          targetId: "dedicated-worker-1",
        },
        useEdges: [{
          useEdgeId: "bind_export_auth",
          name: "auth",
          kind: "identity.oidc@v1",
          configRef: "config://export/auth",
          secretRefs: ["secret://export/auth"],
        }],
        oidcClients: [{
          namespacePath: "identity.primary.oidc",
          issuerUrl: "https://accounts.example.test",
          redirectUris: ["https://app.example.test/auth/callback"],
          allowedScopes: ["openid", "profile"],
          subjectMode: "pairwise",
          tokenEndpointAuthMethod: "client_secret_post",
        }],
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_worker/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-worker" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: { secrets: "templates-only" },
        }),
      },
    ),
  );
  expect(exportResponse.status).toEqual(202);
  const exported = await exportResponse.json();
  expect(exported.status).toEqual("exported");
  expect(exported.downloadExpiresAt).toEqual("2999-05-10T00:00:00.000Z");
  expect(exported.downloadUrl).toContain("/takos-export.tar.zst");
  expect(exported.event.type).toEqual("installation.exported");
  expect(captured.operationId).toEqual(exported.operationId);
  expect(captured.requestIncludeData).toEqual(false);
  expect(captured.bundleKind).toEqual("takosumi.accounts.installation-export-bundle@v1");
  expect(captured.sourceCommit).toEqual("0123456789abcdef0123456789abcdef01234567");
  expect(captured.useEdgeNames).toEqual(["auth"]);
  expect(captured.permissionScopeIds).toEqual([]);
  expect(captured.eventTypes).toEqual([
    "installation.created",
    "oidc_client.registered",
    "use_edge.materialized",
    "installation.export-requested",
  ]);
  expect(store.findAppInstallation("inst_export_worker")?.status).toEqual("exported");

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_worker/exports/${exported.operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  expect((await operationResponse.json()).status).toEqual("exported");

  const repeatedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_worker/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-worker" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: { secrets: "templates-only" },
        }),
      },
    ),
  );
  expect(repeatedResponse.status).toEqual(202);
  expect((await repeatedResponse.json()).status).toEqual("exported");

  const downloadResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_worker/exports/${exported.operationId}/download`,
    ),
  );
  // Round 2: download endpoint signs the redirect target with HMAC. The
  // recorded download URL is preserved as the redirect origin and
  // `tk_sig` / `tk_exp` are appended.
  expect(downloadResponse.status).toEqual(302);
  const workerDownloadLocation = downloadResponse.headers.get("location") ?? "";
  expect(workerDownloadLocation).toContain("/takos-export.tar.zst");
  expect(workerDownloadLocation).toContain("tk_sig=");
  expect(workerDownloadLocation).toContain("tk_exp=");
});

test("accounts handler records configured export worker failures", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    exportWorker: () => {
      throw new Error("archive upload failed");
    },
  });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_export_worker_failure",
        accountId: "acct_export_worker_failure",
        spaceId: "space_export_worker_failure",
        appId: "example.export-worker-failure",
        source: {
          gitUrl: "https://github.com/example/export-worker-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_export_worker_failure",
      }),
    }),
  );

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_worker_failure/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-worker-failure" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
        }),
      },
    ),
  );
  expect(exportResponse.status).toEqual(202);
  const body = await exportResponse.json();
  expect(body.status).toEqual("failed");
  expect(body.error).toEqual("archive upload failed");
  expect(body.event.type).toEqual("installation.export-failed");
  expect(store.findAppInstallation("inst_export_worker_failure")?.status).toEqual("failed");

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_worker_failure/exports/${body.operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  expect((await operationResponse.json()).status).toEqual("failed");
});

test("accounts handler imports export bundle with target OIDC issuer", async () => {
  const store = new InMemoryAccountsStore();
  const restoredData: {
    installationId: string;
    manifestKind?: string;
    path: string;
    text: string;
  }[] = [];
  const handler = createAccountsHandler({
    issuer: "https://accounts.target.test",
    store,
    importDataRestorer: (input) => {
      restoredData.push({
        installationId: input.installation.installationId,
        manifestKind: input.dataManifest?.kind,
        path: input.entries[0].path,
        text: new TextDecoder().decode(input.entries[0].content),
      });
      return {
        restoredEntries: input.entries.map((entry) => entry.path),
        evidence: { provider: "test-restorer" },
      };
    },
  });
  const bundle = buildInstallationExportBundle({
    exportedAt: "2026-05-09T00:00:00.000Z",
    installation: {
      installationId: "inst_source",
      accountId: "acct_source",
      spaceId: "space_source",
      appId: "takos.chat",
      sourceGitUrl: "https://github.com/takos/takos",
      sourceRef: "v1.2.3",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      planSnapshotDigest: "sha256:app",
      artifactDigest: "sha256:compiled",
      mode: "dedicated",
      status: "ready",
      createdBySubject: "tsub_source",
      createdAt: 1778284800000,
      updatedAt: 1778284800000,
    },
    oidcClient: {
      clientId: "toc_source",
      installationId: "inst_source",
      namespacePath: "identity.primary.oidc",
      issuerUrl: "https://accounts.source.test",
      redirectUris: ["https://takos.example.test/auth/oidc/callback"],
      allowedScopes: ["openid", "profile"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "client_secret_post",
      createdAt: 1778284800000,
      updatedAt: 1778284800000,
    },
    bindings: [{
      bindingId: "bind_auth",
      installationId: "inst_source",
      name: "auth",
      kind: "identity.oidc@v1",
      configRef:
        "https://accounts.source.test/v1/installations/inst_source/use-edges/auth/oidc-client/toc_source",
      secretRefs: [
        "https://accounts.source.test/v1/installations/inst_source/use-edges/auth/secrets/client-secret",
      ],
      createdAt: 1778284800000,
      updatedAt: 1778284800000,
    }],
    grants: [{
      grantId: "grant_threads",
      installationId: "inst_source",
      capability: "threads:read",
      scope: {},
      grantedAt: 1778284800000,
    }, {
      grantId: "grant_logs",
      installationId: "inst_source",
      capability: "logs.read.own",
      scope: {},
      grantedAt: 1778284800000,
      revokedAt: 1778284860000,
    }],
  });

  const response = await handler(
    new Request("https://accounts.target.test/v1/installations/import", {
      method: "POST",
      body: JSON.stringify({
        bundle,
        targetIssuer: "https://accounts.target.test",
        targetAccountId: "acct_target",
        targetSpaceId: "space_target",
        targetInstallationId: "inst_target",
        createdBySubject: "tsub_target",
      }),
    }),
  );
  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.installation.id).toEqual("inst_target");
  expect(body.installation.mode).toEqual("self-hosted");
  expect(body.installation.status).toEqual("installing");
  expect(body.oidc_client.issuer_url).toEqual("https://accounts.target.test");
  expect(body.import_plan.source_issuer).toEqual("https://accounts.source.test");
  expect(body.import_plan.target_issuer).toEqual("https://accounts.target.test");
  // Wave 6 (Phase E SQL drift fix): `permission_scopes` / `use_edges`
  // were removed from the envelope. Inspect the in-memory ledger
  // directly.
  expect(store.listAppGrantsForInstallation("inst_target").map((g) => g.grantId)).toEqual(["grant_threads"]);
  const targetAuthBinding = store
    .listAppBindingsForInstallation("inst_target")
    .find((b) => b.name === "auth");
  expect(targetAuthBinding?.configRef ?? "").toContain("takosumi-accounts://installations/inst_target/use-edges/auth/oidc-client/");
  expect(JSON.stringify(body.installation).includes("https://accounts.source.test")).toEqual(false);
  expect(store.listInstallationEvents("inst_target").map((event) => event.eventType)).toEqual([
      "installation.created",
      "oidc_client.registered",
      "use_edge.materialized",
      "installation.import-planned",
    ]);
  expect(restoredData.length).toEqual(0);

  const dataResponse = await handler(
    new Request("https://accounts.target.test/v1/installations/import", {
      method: "POST",
      body: JSON.stringify({
        bundle,
        targetIssuer: "https://accounts.target.test",
        targetAccountId: "acct_target",
        targetSpaceId: "space_target",
        targetInstallationId: "inst_target_data",
        createdBySubject: "tsub_target",
        data: {
          manifest: {
            kind: "takosumi.accounts.installation-export-data-manifest@v1",
            version: "v1",
            files: [{
              path: "takos-export/data/postgres/dump.sql",
              mediaType: "application/sql",
              byteLength: 10,
              contentDigest:
                "sha256:4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c",
            }],
          },
          entries: [{
            path: "takos-export/data/postgres/dump.sql",
            mediaType: "application/sql",
            byteLength: 10,
            contentDigest:
              "sha256:4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c",
            contentBase64: btoa("select 1;\n"),
          }],
        },
      }),
    }),
  );
  expect(dataResponse.status).toEqual(202);
  const dataBody = await dataResponse.json();
  expect(dataBody.installation.id).toEqual("inst_target_data");
  expect(dataBody.data_restore).toEqual({
    status: "restored",
    entries: ["takos-export/data/postgres/dump.sql"],
    evidence: { provider: "test-restorer" },
  });
  expect(restoredData).toEqual([{
    installationId: "inst_target_data",
    manifestKind: "takosumi.accounts.installation-export-data-manifest@v1",
    path: "takos-export/data/postgres/dump.sql",
    text: "select 1;\n",
  }]);
  expect(store.listInstallationEvents("inst_target_data").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "oidc_client.registered",
      "use_edge.materialized",
      "installation.import-planned",
      "installation.import-data-restored",
    ]);
});

test("accounts handler moves AppInstallation through materialize export import lifecycle", async () => {
  const sourceStore = new InMemoryAccountsStore();
  let exportedBundle: AccountsInstallationExportBundle | undefined;
  const sourceHandler = createAccountsHandler({
    issuer: "https://accounts.source.test",
    store: sourceStore,
    materializeWorker: (input) => {
      const preserveBindings = Array.isArray(input.preserve.useEdges)
        ? input.preserve.useEdges.filter((binding): binding is Record<
          string,
          unknown
        > => typeof binding === "object" && binding !== null)
        : [];
      const preserveOidc = typeof input.preserve.oidcClient === "object" &&
          input.preserve.oidcClient !== null
        ? input.preserve.oidcClient as Record<string, unknown>
        : null;
      const preserveRuntime = typeof input.preserve.runtimeTarget ===
            "object" &&
          input.preserve.runtimeTarget !== null
        ? input.preserve.runtimeTarget as { readonly targetId?: unknown }
        : undefined;
      const targetId = "dedicated://tokyo/inst_lifecycle";
      return {
        preserveDigest: input.preserveDigest,
        reason: "dedicated runtime copied shared-cell namespace",
        runtimeTarget: {
          runtimeTargetId: "rtb_lifecycle_dedicated",
          targetType: "dedicated",
          targetId,
        },
        continuity: {
          sourceDataNamespace: typeof input.preserve.dataNamespace === "string"
            ? input.preserve.dataNamespace
            : null,
          oidcClient: preserveOidc ? { ...preserveOidc } : null,
          preservedUseEdges: preserveBindings.map((binding) => ({
            name: String(binding.name ?? ""),
            kind: String(binding.kind ?? "") as AppBindingKind,
            configRef: String(binding.configRef ?? ""),
            secretRefs: Array.isArray(binding.secretRefs)
              ? binding.secretRefs.filter((entry): entry is string =>
                typeof entry === "string"
              )
              : [],
          })),
          cutover: {
            fromTargetId: typeof preserveRuntime?.targetId === "string"
              ? preserveRuntime.targetId
              : null,
            toTargetId: targetId,
            ready: true,
            strategy: "blue-green",
          },
        },
      };
    },
    exportWorker: (input) => {
      exportedBundle = input.bundle;
      return {
        downloadUrl:
          `https://downloads.source.test/${input.operationId}/takos-export.tar.zst`,
        downloadExpiresAt: "2999-05-10T00:00:00.000Z",
      };
    },
  });

  const createResponse = await sourceHandler(
    new Request("https://accounts.source.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_lifecycle",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_source",
        runtimeTarget: {
          runtimeTargetId: "rtb_lifecycle_shared",
          targetType: "shared-cell",
          targetId: "shared-cell://tokyo-cell-01/namespaces/inst_lifecycle",
        },
        useEdges: [{
          useEdgeId: "bind_lifecycle_auth",
          name: "auth",
          kind: "identity.oidc@v1",
          configRef:
            "takosumi-installer://installable-app/takos.chat/use-edges/auth",
          secretRefs: [],
        }],
        oidcClients: [{
          useEdge: "auth",
          namespacePath: "identity.primary.oidc",
          issuerUrl: "https://accounts.source.test",
          redirectUris: ["https://takos.example.test/auth/oidc/callback"],
          allowedScopes: ["openid", "profile"],
          subjectMode: "pairwise",
          tokenEndpointAuthMethod: "client_secret_post",
        }],
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const materializeResponse = await sourceHandler(
    new Request(
      "https://accounts.source.test/v1/installations/inst_lifecycle/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-lifecycle-materialize" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          plan: { compute: "small", database: "small" },
          cutover: { strategy: "blue-green", drainSeconds: 30 },
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              installationId: "inst_lifecycle",
              region: "tokyo",
              plan: { compute: "small", database: "small" },
              cutover: { strategy: "blue-green", drainSeconds: 30 },
            }),
          },
        }),
      },
    ),
  );
  expect(materializeResponse.status).toEqual(202);
  const materialized = await materializeResponse.json();
  expect(materialized.status).toEqual("ready");
  expect(materialized.installation.mode).toEqual("dedicated");
  expect(materialized.installation.status).toEqual("ready");
  // Wave 6 (Phase E SQL drift fix): `runtime_target` was removed from
  // the envelope. The materialize route still emits the runtime binding
  // in its private `runtime_target` field (= not part of envelope), so
  // this test asserts via the in-memory ledger.
  const lifecycleRtb = sourceStore
    .findAppInstallation("inst_lifecycle")?.runtimeBindingId;
  expect(sourceStore.findRuntimeBinding(lifecycleRtb ?? "")?.targetType).toEqual("dedicated");
  expect(sourceStore.findRuntimeBinding(lifecycleRtb ?? "")?.targetId).toEqual("dedicated://tokyo/inst_lifecycle");
  expect(materialized.event.type).toEqual("installation.materialize-succeeded");
  expect(sourceStore.findAppInstallation("inst_lifecycle")?.mode).toEqual("dedicated");

  const exportResponse = await sourceHandler(
    new Request(
      "https://accounts.source.test/v1/installations/inst_lifecycle/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-lifecycle-export" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: { secrets: "templates-only" },
        }),
      },
    ),
  );
  expect(exportResponse.status).toEqual(202);
  const exported = await exportResponse.json();
  expect(exported.status).toEqual("exported");
  expect(exported.event.type).toEqual("installation.exported");
  expect(exported.downloadUrl).toContain("/takos-export.tar.zst");
  if (!exportedBundle) {
    throw new Error("expected export worker to receive installation bundle");
  }
  expect(exportedBundle.installation.mode).toEqual("dedicated");
  expect(exportedBundle.runtimeTarget?.targetType).toEqual("dedicated");
  expect(exportedBundle.oidcClient?.issuerUrl).toEqual("https://accounts.source.test");
  expect(exportedBundle.permissionScopes.map((scope) => scope.permissionScopeId)).toEqual([]);
  expect(exportedBundle.events.map((event) => event.type)).toEqual([
      "installation.created",
      "oidc_client.registered",
      "use_edge.materialized",
      "installation.materialize-requested",
      "installation.materialize-succeeded",
      "installation.export-requested",
    ]);
  expect(sourceStore.findAppInstallation("inst_lifecycle")?.status).toEqual("exported");

  const targetStore = new InMemoryAccountsStore();
  const targetHandler = createAccountsHandler({
    issuer: "https://accounts.target.test",
    store: targetStore,
  });
  const importResponse = await targetHandler(
    new Request("https://accounts.target.test/v1/installations/import", {
      method: "POST",
      body: JSON.stringify({
        bundle: exportedBundle,
        targetIssuer: "https://accounts.target.test",
        targetAccountId: "acct_target",
        targetSpaceId: "space_target",
        targetInstallationId: "inst_lifecycle_imported",
        createdBySubject: "tsub_target",
      }),
    }),
  );
  expect(importResponse.status).toEqual(202);
  const imported = await importResponse.json();
  expect(imported.installation.id).toEqual("inst_lifecycle_imported");
  expect(imported.installation.mode).toEqual("self-hosted");
  expect(imported.installation.status).toEqual("installing");
  expect(imported.oidc_client.namespacePath).toEqual("identity.primary.oidc");
  expect(imported.oidc_client.issuer_url).toEqual("https://accounts.target.test");
  expect(imported.import_plan.source_issuer).toEqual("https://accounts.source.test");
  expect(imported.import_plan.target_issuer).toEqual("https://accounts.target.test");
  // Wave 6 (Phase E SQL drift fix): `permission_scopes` / `use_edges`
  // were removed from the envelope. Assert via the in-memory ledger.
  expect(targetStore.listAppGrantsForInstallation("inst_lifecycle_imported").length).toEqual(0);
  const importedAuthBinding = targetStore
    .listAppBindingsForInstallation("inst_lifecycle_imported")
    .find((b) => b.name === "auth");
  expect(importedAuthBinding?.configRef ?? "").toContain("takosumi-accounts://installations/inst_lifecycle_imported/use-edges/auth/oidc-client/");
  expect(targetStore.findOidcClientForInstallation("inst_lifecycle_imported")
      ?.issuerUrl).toEqual("https://accounts.target.test");
  expect(JSON.stringify(imported.installation).includes(
      "https://accounts.source.test",
    )).toEqual(false);
  expect(targetStore.listInstallationEvents("inst_lifecycle_imported").map((
      event,
    ) => event.eventType)).toEqual([
      "installation.created",
      "oidc_client.registered",
      "use_edge.materialized",
      "installation.import-planned",
    ]);
});

test("accounts handler records AppInstallation export operation failures", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_export_failure",
        accountId: "acct_export_failure",
        spaceId: "space_export_failure",
        appId: "example.export-failure",
        source: {
          gitUrl: "https://github.com/example/export-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_export_failure",
      }),
    }),
  );

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_failure/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-failure" },
        body: JSON.stringify({
          includeData: true,
          format: "bundle",
          encryption: { method: "none" },
        }),
      },
    ),
  );
  expect(exportResponse.status).toEqual(202);
  const operationId = (await exportResponse.json()).operationId;

  const failedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_export_failure/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          operation: "export",
          operationId,
          reason: "bundle writer failed",
        }),
      },
    ),
  );
  expect(failedResponse.status).toEqual(200);
  expect((await failedResponse.json()).event.type).toEqual("installation.export-failed");

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_export_failure/exports/${operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  const operation = await operationResponse.json();
  expect(operation.status).toEqual("failed");
  expect(operation.error).toEqual("bundle writer failed");
});

test("accounts dashboard requests materialize and export operations", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  await createReadyLaunchInstallation(handler, "inst_dashboard_materialize");
  await createReadyLaunchInstallation(handler, "inst_dashboard_export");

  const materializeResponse = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_dashboard_materialize/materialize",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          region: "tokyo",
          cost_ack: "true",
        }),
      },
    ),
  );
  expect(materializeResponse.status).toEqual(303);
  expect(materializeResponse.headers.get("location")).toEqual("/dashboard/installations/inst_dashboard_materialize");
  expect(store.listInstallationEvents("inst_dashboard_materialize").some((event) =>
      event.eventType === "installation.materialize-requested"
    )).toEqual(true);
  const materializeRequest = store.listInstallationEvents(
    "inst_dashboard_materialize",
  ).find((event) => event.eventType === "installation.materialize-requested");
  const materializeOperationId = String(
    materializeRequest?.payload.operationId ?? "",
  );
  expect(materializeOperationId.length > 0).toEqual(true);
  const materializeHtml = await dashboardHtml(
    handler,
    "inst_dashboard_materialize",
  );
  expect(materializeHtml).toContain(materializeOperationId);
  expect(materializeHtml).toContain("preparing");

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_dashboard_export/export",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          include_data: "true",
          encryption_method: "none",
        }),
      },
    ),
  );
  expect(exportResponse.status).toEqual(303);
  expect(exportResponse.headers.get("location")).toEqual("/dashboard/installations/inst_dashboard_export");
  expect(store.listInstallationEvents("inst_dashboard_export").some((event) =>
      event.eventType === "installation.export-requested"
    )).toEqual(true);
  const exportRequest = store.listInstallationEvents("inst_dashboard_export")
    .find((event) => event.eventType === "installation.export-requested");
  const exportOperationId = String(exportRequest?.payload.operationId ?? "");
  expect(exportOperationId.length > 0).toEqual(true);
  const exportDetailHtml = await dashboardHtml(
    handler,
    "inst_dashboard_export",
  );
  expect(exportDetailHtml).toContain(exportOperationId);
  expect(exportDetailHtml).toContain("preparing");

  const completedStore = new InMemoryAccountsStore();
  const completedHandler = createAccountsHandler({
    store: completedStore,
    exportWorker: () => ({
      downloadUrl: "https://downloads.example.test/takos-export.tar.zst",
      downloadExpiresAt: "2999-05-10T00:00:00.000Z",
    }),
  });
  await createReadyLaunchInstallation(
    completedHandler,
    "inst_dashboard_export_done",
  );
  const completedExportResponse = await completedHandler(
    new Request(
      "https://accounts.example.test/dashboard/installations/inst_dashboard_export_done/export",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          encryption_method: "none",
        }),
      },
    ),
  );
  expect(completedExportResponse.status).toEqual(303);
  const completedHtml = await dashboardHtml(
    completedHandler,
    "inst_dashboard_export_done",
  );
  expect(completedHtml).toContain("exported");
  expect(completedHtml).toContain("https://downloads.example.test/takos-export.tar.zst");
  expect(completedHtml).toContain("Download");
});

test("accounts handler materializes launch token binding config", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_launch_binding",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        useEdges: [{
          useEdgeId: "bind_bootstrap",
          name: "bootstrap",
          kind: "install-launch-token@v1",
          configRef:
            "takosumi-installer://installable-app/takos.chat/use-edges/bootstrap/sha256:pending",
          secretRefs: [],
        }],
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  const created = await createResponse.json();
  void created;
  // Wave 6 (Phase E SQL drift fix): `use_edges` was removed from the
  // envelope. The materialize route still saves the binding in the
  // ledger so we assert via the in-memory store.
  const launchBinding = store
    .listAppBindingsForInstallation("inst_launch_binding")
    .find((b) => b.name === "bootstrap");
  expect(launchBinding?.configRef).toEqual([
      "takosumi-accounts://installations/inst_launch_binding",
      "use-edges/bootstrap/launch-token",
    ].join("/"));
  expect(launchBinding?.secretRefs).toEqual([]);
  expect(store.listInstallationEvents("inst_launch_binding").map((event) =>
      event.eventType
    )).toEqual(["installation.created", "use_edge.materialized"]);
});

test("accounts handler connects shared-cell runtime binding to launch token bootstrap", async () => {
  const store = new InMemoryAccountsStore();
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 1 },
  ]);
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    sharedCellRuntime: (input) => pool.allocate(input),
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_shared_launch",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
        useEdges: [{
          name: "bootstrap",
          kind: "install-launch-token@v1",
          configRef:
            "takosumi-installer://installable-app/takos.chat/use-edges/bootstrap/sha256:pending",
          secretRefs: [],
        }],
      }),
    }),
  );

  expect(createResponse.status).toEqual(202);
  const created = await createResponse.json();
  void created;
  // Wave 6 (Phase E SQL drift fix): `runtime_target` / `use_edges`
  // were removed from the envelope; assert via the in-memory ledger.
  expect(store.findRuntimeBinding("rtb_inst_shared_launch_shared_cell")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_shared_launch");
  const sharedLaunchBinding = store
    .listAppBindingsForInstallation("inst_shared_launch")
    .find((b) => b.name === "bootstrap");
  expect(sharedLaunchBinding?.configRef).toEqual([
      "takosumi-accounts://installations/inst_shared_launch",
      "use-edges/bootstrap/launch-token",
    ].join("/"));
  expect(store.listInstallationEvents("inst_shared_launch").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "runtime_target.assigned",
      "use_edge.materialized",
    ]);
});

test("accounts handler Use Takos start creates product launch without Git install apply", async () => {
  const store = new InMemoryAccountsStore();
  const startSession = seedAccountSession(store, "tsub_owner");
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 1 },
  ]);
  let installApplyCalled = false;
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    sharedCellRuntime: (input) => pool.allocate(input),
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
    installer: {
      url: "http://takosumi-installer.internal:8788",
      fetch: () => {
        installApplyCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
    },
  });

  const response = await handler(
    new Request(
      [
        "https://accounts.example.test/start",
        "?takos_url=https%3A%2F%2Ftakos.example.test",
        "&subject=tsub_owner",
        "&account_id=acct_1",
        "&space_id=space_1",
        "&installation_id=inst_takos_start",
        "&terms_version=terms-2026-05-13",
        "&terms_accepted=true",
      ].join(""),
      { headers: accountSessionHeaders(startSession) },
    ),
  );

  expect(response.status).toEqual(303);
  expect(installApplyCalled).toEqual(false);
  const location = response.headers.get("location") ?? "";
  expect(location).toContain("https://takos.example.test/_takosumi/launch");
  const launchUrl = new URL(location);
  expect(launchUrl.searchParams.get("return_to")).toEqual("/spaces/space_1/threads");
  const token = launchUrl.searchParams.get("launch_token");
  expect(typeof token).toEqual("string");
  const account = store.findAccount("tsub_owner");
  expect(account?.subject).toEqual("tsub_owner");
  expect(account?.termsVersion).toEqual("terms-2026-05-13");
  expect(account?.termsAcceptedSource).toEqual("use-takos-start");
  expect(typeof account?.termsAcceptedAt).toEqual("number");
  expect(store.findLedgerAccount("acct_1")?.legalOwnerSubject).toEqual("tsub_owner");
  expect(store.findSpace("space_1")?.accountId).toEqual("acct_1");
  const installation = store.findAppInstallation("inst_takos_start");
  expect(installation?.appId).toEqual("takos.chat");
  expect(installation?.sourceGitUrl).toEqual("takos-product://managed/takos");
  expect(installation?.mode).toEqual("shared-cell");
  expect(installation?.status).toEqual("ready");
  expect(store.findRuntimeBinding("rtb_inst_takos_start_shared_cell")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_takos_start");
  expect(store.listAppBindingsForInstallation("inst_takos_start")[0]?.configRef).toEqual("takosumi-accounts://installations/inst_takos_start/use-edges/bootstrap/launch-token");
  expect(store.listInstallationEvents("inst_takos_start").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "runtime_target.assigned",
      "use_edge.materialized",
      "installation.launch_token_issued",
    ]);
});

test("accounts handler blocks Use Takos start when managed offering access is closed", async () => {
  const store = new InMemoryAccountsStore();
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 1 },
  ]);
  const handler = createAccountsHandler({
    store,
    managedOfferingAccess: {
      status: "closed",
      evidenceRef: "vault://managed-readiness/staging/rehearsal.json",
      publicSummary: "Launch rehearsal is still blocked.",
    },
    sharedCellRuntime: (input) => pool.allocate(input),
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  for (const path of ["/start", "/dashboard/use-takos"]) {
    const response = await handler(
      new Request(
        [
          `https://accounts.example.test${path}`,
          "?takos_url=https%3A%2F%2Ftakos.example.test",
          "&subject=tsub_owner",
          "&account_id=acct_1",
          "&space_id=space_1",
          "&installation_id=inst_takos_start",
          "&terms_version=terms-2026-05-13",
          "&terms_accepted=true",
        ].join(""),
      ),
    );

    expect(response.status).toEqual(503);
    expect((await response.json()).error).toEqual("launch_readiness_not_complete");
  }

  expect(store.findAccount("tsub_owner")).toEqual(undefined);
  expect(store.findAppInstallation("inst_takos_start")).toEqual(undefined);
});

test("accounts handler Use Takos start validates redirect and existing installation ownership", async () => {
  const store = new InMemoryAccountsStore();
  const startSession = seedAccountSession(store, "tsub_owner");
  const startHeaders = accountSessionHeaders(startSession);
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  const unauthenticated = await handler(
    new Request(
      "https://accounts.example.test/start?subject=tsub_owner&takos_url=https%3A%2F%2Ftakos.example.test",
    ),
  );
  expect(unauthenticated.status).toEqual(401);

  const missingRedirect = await handler(
    new Request("https://accounts.example.test/start?subject=tsub_owner", {
      headers: startHeaders,
    }),
  );
  expect(missingRedirect.status).toEqual(400);
  expect((await missingRedirect.json()).error).toEqual("invalid_request");

  const missingTerms = await handler(
    new Request(
      [
        "https://accounts.example.test/start",
        "?takos_url=https%3A%2F%2Ftakos.example.test",
        "&subject=tsub_owner",
        "&account_id=acct_1",
        "&space_id=space_1",
        "&installation_id=inst_missing_terms",
      ].join(""),
      { headers: startHeaders },
    ),
  );
  expect(missingTerms.status).toEqual(400);
  expect((await missingTerms.json()).error).toEqual("invalid_request");

  const notAcceptedTerms = await handler(
    new Request(
      [
        "https://accounts.example.test/start",
        "?takos_url=https%3A%2F%2Ftakos.example.test",
        "&subject=tsub_owner",
        "&account_id=acct_1",
        "&space_id=space_1",
        "&installation_id=inst_terms_not_accepted",
        "&terms_version=terms-2026-05-13",
      ].join(""),
      { headers: startHeaders },
    ),
  );
  expect(notAcceptedTerms.status).toEqual(400);
  expect((await notAcceptedTerms.json()).error).toEqual("terms_acceptance_required");

  const missingRuntime = await handler(
    new Request(
      [
        "https://accounts.example.test/start",
        "?takos_url=https%3A%2F%2Ftakos.example.test",
        "&subject=tsub_owner",
        "&account_id=acct_1",
        "&space_id=space_1",
        "&installation_id=inst_no_runtime",
        "&terms_version=terms-2026-05-13",
        "&terms_accepted=true",
      ].join(""),
      { headers: startHeaders },
    ),
  );
  expect(missingRuntime.status).toEqual(503);
  expect((await missingRuntime.json()).error).toEqual("feature_unavailable");

  const otherSession = seedAccountSession(store, "tsub_other");
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      headers: accountSessionHeaders(otherSession),
      body: JSON.stringify({
        installationId: "inst_conflict",
        accountId: "acct_other",
        spaceId: "space_other",
        appId: "takos.chat",
        source: {
          gitUrl: "takos-product://managed/takos",
          ref: "managed",
          commit: "managed-prebuilt",
          planSnapshotDigest: "sha256:takos-product-managed",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_other",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const conflict = await handler(
    new Request(
      [
        "https://accounts.example.test/start",
        "?takos_url=https%3A%2F%2Ftakos.example.test",
        "&subject=tsub_owner",
        "&account_id=acct_1",
        "&space_id=space_1",
        "&installation_id=inst_conflict",
        "&terms_version=terms-2026-05-13",
        "&terms_accepted=true",
      ].join(""),
      { headers: startHeaders },
    ),
  );
  expect(conflict.status).toEqual(409);
  expect((await conflict.json()).error).toEqual("use_takos_installation_mismatch");
});

test("accounts handler isolates shared-cell namespaces and launch tokens", async () => {
  const store = new InMemoryAccountsStore();
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 2 },
  ]);
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    sharedCellRuntime: (input) => pool.allocate(input),
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });
  async function createSharedInstall(installationId: string): Promise<unknown> {
    const response = await handler(
      new Request("https://accounts.example.test/v1/installations", {
        method: "POST",
        body: JSON.stringify({
          installationId,
          accountId: "acct_1",
          spaceId: "space_1",
          appId: "takos.chat",
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.3",
            commit: "abc123",
            planSnapshotDigest: "sha256:app",
          },
          mode: "shared-cell",
          status: "ready",
          createdBySubject: "tsub_owner",
          useEdges: [{
            name: "bootstrap",
            kind: "install-launch-token@v1",
            configRef:
              "takosumi-installer://installable-app/takos.chat/use-edges/bootstrap/sha256:pending",
            secretRefs: [],
          }],
        }),
      }),
    );
    expect(response.status).toEqual(202);
    return await response.json();
  }

  void await createSharedInstall("inst_shared_a");
  void await createSharedInstall("inst_shared_b");
  // Wave 6 (Phase E SQL drift fix): `runtime_target` was removed from
  // the envelope; assert via the in-memory ledger.
  const sharedABinding = store
    .findAppInstallation("inst_shared_a")?.runtimeBindingId;
  const sharedBBinding = store
    .findAppInstallation("inst_shared_b")?.runtimeBindingId;
  expect(store.findRuntimeBinding(sharedABinding ?? "")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_shared_a");
  expect(store.findRuntimeBinding(sharedBBinding ?? "")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_shared_b");
  expect(pool.availableSlots()).toEqual([{
    cellId: "tokyo-cell-01",
    capacity: 0,
  }]);
  expect(store.listInstallationEvents("inst_shared_b").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "runtime_target.assigned",
      "use_edge.materialized",
    ]);
});

test("accounts handler isolates per-installation data oidc grants and billing", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveBillingAccount({
    billingAccountId: "billing_inst_a",
    subject: "tsub_billing_a",
    provider: "stripe",
    stripeCustomerId: "cus_inst_a",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  store.saveBillingAccount({
    billingAccountId: "billing_inst_b",
    subject: "tsub_billing_b",
    provider: "stripe",
    stripeCustomerId: "cus_inst_b",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const pool = new InMemorySharedCellWarmPool([
    { cellId: "tokyo-cell-01", capacity: 2 },
  ]);
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    sharedCellRuntime: (input) => pool.allocate(input),
    bindingMaterializer: (
      { installation, binding },
    ): AppBindingMaterializationResult | undefined => {
      if (binding.kind === "database.postgres@v1") {
        return {
          configRef:
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/postgres/main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/secrets/password`,
          ],
          env: {
            DATABASE_URL:
              `postgres://takos:secret@db.example.test/${installation.installationId}`,
          },
        };
      }
      if (binding.kind === "object-store.s3-compatible@v1") {
        return {
          configRef:
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/object-store/main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/secrets/access-key`,
          ],
          env: {
            BLOB_BUCKET: `${installation.installationId}-objects`,
          },
        };
      }
      return undefined;
    },
  });

  async function createIsolatedInstall(input: {
    installationId: string;
    billingAccountId: string;
    permissionScopeId: string;
  }): Promise<{
    installation: { billing_account_id: string };
    runtime_target: { target_id: string };
    use_edges: readonly { name: string; config_ref: string }[];
    use_edge_env: Record<string, string>;
    oidc_client: { client_id: string; redirect_uris: readonly string[] };
    permission_scopes: readonly {
      id: string;
      installation_id: string;
      capability: string;
      scope: { installationId?: string };
      granted_at: string;
      revoked_at: string | null;
    }[];
  }> {
    const response = await handler(
      new Request("https://accounts.example.test/v1/installations", {
        method: "POST",
        body: JSON.stringify({
          installationId: input.installationId,
          accountId: "acct_1",
          spaceId: "space_1",
          billingAccountId: input.billingAccountId,
          appId: "takos.chat",
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.3",
            commit: "abc123",
            planSnapshotDigest: "sha256:app",
          },
          mode: "shared-cell",
          status: "ready",
          createdBySubject: "tsub_owner",
          useEdges: [{
            name: "auth",
            kind: "identity.oidc@v1",
            configRef:
              `takosumi-installer://installable-app/takos.chat/use-edges/auth/${input.installationId}`,
            secretRefs: [],
          }, {
            name: "database",
            kind: "database.postgres@v1",
            configRef:
              `takosumi-installer://installable-app/takos.chat/use-edges/database/${input.installationId}`,
            secretRefs: [],
          }, {
            name: "blob",
            kind: "object-store.s3-compatible@v1",
            configRef:
              `takosumi-installer://installable-app/takos.chat/use-edges/blob/${input.installationId}`,
            secretRefs: [],
          }],
          oidcClients: [{
            useEdge: "auth",
            namespacePath: "identity.primary.oidc",
            redirectUris: [
              `https://${input.installationId}.example.test/auth/oidc/callback`,
            ],
            allowedScopes: ["openid", "profile"],
            subjectMode: "pairwise",
          }],
          permissionScopes: [{
            permissionScopeId: input.permissionScopeId,
            capability: "files:read",
            scope: { installationId: input.installationId },
          }],
        }),
      }),
    );
    expect(response.status).toEqual(202);
    return await response.json();
  }

  const first = await createIsolatedInstall({
    installationId: "inst_iso_a",
    billingAccountId: "billing_inst_a",
    permissionScopeId: "grant_inst_a_files",
  });
  const second = await createIsolatedInstall({
    installationId: "inst_iso_b",
    billingAccountId: "billing_inst_b",
    permissionScopeId: "grant_inst_b_files",
  });

  expect(first.installation.billing_account_id).toEqual("billing_inst_a");
  expect(second.installation.billing_account_id).toEqual("billing_inst_b");
  expect(store.findAppInstallation("inst_iso_a")?.billingAccountId).toEqual("billing_inst_a");
  expect(store.findAppInstallation("inst_iso_b")?.billingAccountId).toEqual("billing_inst_b");
  expect(store.findBillingAccount("billing_inst_a")?.stripeCustomerId).toEqual("cus_inst_a");
  expect(store.findBillingAccount("billing_inst_b")?.stripeCustomerId).toEqual("cus_inst_b");
  expect(store.findBillingAccountByStripeCustomerId("cus_inst_a")
      ?.billingAccountId).toEqual("billing_inst_a");
  expect(store.findBillingAccountByStripeCustomerId("cus_inst_b")
      ?.billingAccountId).toEqual("billing_inst_b");
  // Wave 6 (Phase E SQL drift fix): `runtime_target` / `use_edges` /
  // `permission_scopes` were removed from the envelope. Per-isolation
  // assertions move to the in-memory ledger.
  const isoARtb = store
    .findAppInstallation("inst_iso_a")?.runtimeBindingId;
  const isoBRtb = store
    .findAppInstallation("inst_iso_b")?.runtimeBindingId;
  expect(store.findRuntimeBinding(isoARtb ?? "")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_iso_a");
  expect(store.findRuntimeBinding(isoBRtb ?? "")?.targetId).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_iso_b");
  expect(first.oidc_client.client_id === second.oidc_client.client_id).toEqual(false);
  expect(first.oidc_client.redirect_uris).toEqual([
    "https://inst_iso_a.example.test/auth/oidc/callback",
  ]);
  expect(second.oidc_client.redirect_uris).toEqual([
    "https://inst_iso_b.example.test/auth/oidc/callback",
  ]);
  const isoADbBinding = store
    .listAppBindingsForInstallation("inst_iso_a")
    .find((b) => b.name === "database");
  const isoBDbBinding = store
    .listAppBindingsForInstallation("inst_iso_b")
    .find((b) => b.name === "database");
  expect(isoADbBinding?.configRef).toEqual("takosumi-accounts://installations/inst_iso_a/use-edges/database/postgres/main");
  expect(isoBDbBinding?.configRef).toEqual("takosumi-accounts://installations/inst_iso_b/use-edges/database/postgres/main");
  const isoABlobBinding = store
    .listAppBindingsForInstallation("inst_iso_a")
    .find((b) => b.name === "blob");
  const isoBBlobBinding = store
    .listAppBindingsForInstallation("inst_iso_b")
    .find((b) => b.name === "blob");
  expect(isoABlobBinding?.configRef).toEqual("takosumi-accounts://installations/inst_iso_a/use-edges/blob/object-store/main");
  expect(isoBBlobBinding?.configRef).toEqual("takosumi-accounts://installations/inst_iso_b/use-edges/blob/object-store/main");
  expect(first.use_edge_env.BLOB_BUCKET).toEqual("inst_iso_a-objects");
  expect(second.use_edge_env.BLOB_BUCKET).toEqual("inst_iso_b-objects");
  const isoAGrant = store
    .listAppGrantsForInstallation("inst_iso_a")
    .find((g) => g.grantId === "grant_inst_a_files");
  expect(isoAGrant?.installationId).toEqual("inst_iso_a");
  expect(isoAGrant?.capability).toEqual("files:read");
  expect(isoAGrant?.scope).toEqual({ installationId: "inst_iso_a" });
  expect(isoAGrant?.revokedAt).toEqual(undefined);
  expect(store.listAppGrantsForInstallation("inst_iso_b")[0]?.installationId).toEqual("inst_iso_b");
  expect(store.listAppGrantsForInstallation("inst_iso_a").map((grant) =>
      grant.grantId
    )).toEqual(["grant_inst_a_files"]);
  expect(store.listAppGrantsForInstallation("inst_iso_b").map((grant) =>
      grant.grantId
    )).toEqual(["grant_inst_b_files"]);
});

test("accounts handler materializes configured provider bindings", async () => {
  const store = new InMemoryAccountsStore();
  const seenDeclarations: Record<string, unknown>[] = [];
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    bindingMaterializer: (
      { installation, binding, declaration },
    ): AppBindingMaterializationResult | undefined => {
      seenDeclarations.push({ name: binding.name, declaration });
      if (binding.kind === "database.postgres@v1") {
        return {
          configRef:
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/postgres/db-main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/secrets/password`,
          ],
          env: {
            DATABASE_URL:
              "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
          },
        };
      }
      if (binding.kind === "object-store.s3-compatible@v1") {
        return {
          configRef:
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/object-store/blob-main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.installationId}/use-edges/${binding.name}/secrets/secret-key`,
          ],
          env: {
            BLOB_ENDPOINT: "https://objects.example.test",
            BLOB_BUCKET: "inst-materialized",
            BLOB_ACCESS_KEY: "access-key",
            BLOB_SECRET_KEY: "secret-key",
          },
        };
      }
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_materialized",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        useEdges: [{
          name: "db",
          kind: "database.postgres@v1",
          configRef:
            "takosumi-installer://installable-app/takos.chat/use-edges/db/sha256:pending",
          declaration: {
            type: "database.postgres@v1",
            required: true,
            plan: "small",
          },
        }, {
          name: "blob",
          kind: "object-store.s3-compatible@v1",
          configRef:
            "takosumi-installer://installable-app/takos.chat/use-edges/blob/sha256:pending",
          declaration: {
            type: "object-store.s3-compatible@v1",
            required: true,
            plan: "standard",
          },
        }],
      }),
    }),
  );

  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.use_edge_env).toEqual({
    DATABASE_URL:
      "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
    BLOB_ENDPOINT: "https://objects.example.test",
    BLOB_BUCKET: "inst-materialized",
    BLOB_ACCESS_KEY: "access-key",
    BLOB_SECRET_KEY: "secret-key",
  });
  // Wave 6 (Phase E SQL drift fix): `use_edges` was removed from the
  // envelope; assert via the in-memory ledger.
  expect(store
      .listAppBindingsForInstallation("inst_materialized")
      .map((b) => b.configRef)).toEqual([
      "takosumi-accounts://installations/inst_materialized/use-edges/db/postgres/db-main",
      "takosumi-accounts://installations/inst_materialized/use-edges/blob/object-store/blob-main",
    ]);
  expect(store.listInstallationEvents("inst_materialized").map((event) =>
      event.eventType
    )).toEqual([
      "installation.created",
      "use_edge.materialized",
      "use_edge.materialized",
    ]);
  expect(seenDeclarations.map((entry) => entry.declaration)).toEqual([
    { type: "database.postgres@v1", required: true, plan: "small" },
    { type: "object-store.s3-compatible@v1", required: true, plan: "standard" },
  ]);
});

test("accounts handler rejects AppBinding records outside the catalog contract", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_bad",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        useEdges: [{
          name: "bootstrap",
          kind: "install-launch-token@v1",
          configRef: "config://inst_bad/bootstrap",
          secretRefs: ["secret://inst_bad/bootstrap/private-key"],
        }],
      }),
    }),
  );

  expect(response.status).toEqual(422);
  expect((await response.json()).error).toEqual("invalid_use_edges");
});

test("accounts handler rejects AppGrant records outside the catalog contract", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_bad_grant",
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        permissionScopes: [{
          permissionScopeId: "grant_unsafe",
          capability: "unsafe.scope",
          scope: {},
        }],
      }),
    }),
  );

  expect(response.status).toEqual(422);
  expect((await response.json()).error).toEqual("invalid_permission_scopes");
});

test("accounts handler emits baseline browser security headers", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/healthz"),
  );

  expect(response.status).toEqual(200);
  expect(response.headers.get("x-content-type-options")).toEqual("nosniff");
  expect(response.headers.get("x-frame-options")).toEqual("DENY");
  expect(response.headers.get("referrer-policy")).toEqual("strict-origin-when-cross-origin");
  // HTTPS issuer in test fixtures => HSTS is emitted.
  expect(response.headers.get("strict-transport-security") ?? "").toContain("max-age=31536000");
  expect(response.headers.get("strict-transport-security") ?? "").toContain("includeSubDomains");
});

test("accounts handler omits HSTS for non-HTTPS issuers", async () => {
  const handler = createRawAccountsHandler({
    issuer: "http://localhost:8787",
    managedOfferingAccess: testManagedOfferingOpenAccess,
  });
  const response = await handler(
    new Request("http://localhost:8787/healthz"),
  );

  expect(response.status).toEqual(200);
  expect(response.headers.get("strict-transport-security")).toEqual(null);
  expect(response.headers.get("x-content-type-options")).toEqual("nosniff");
});

test("accounts handler paginates AppInstallation list via cursor and limit", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: "acct_page",
    legalOwnerSubject: "tsub_page_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveSpace({
    spaceId: "space_page",
    accountId: "acct_page",
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
  const session = seedAccountSession(store, "tsub_page_owner");
  for (let i = 0; i < 5; i += 1) {
    store.saveAppInstallation({
      installationId: `inst_page_${i}`,
      accountId: "acct_page",
      spaceId: "space_page",
      appId: `example.page-${i}`,
      sourceGitUrl: `https://github.com/example/page-${i}`,
      sourceRef: "v1.0.0",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      planSnapshotDigest: "sha256:app",
      mode: "shared-cell",
      status: "ready",
      createdBySubject: "tsub_page_owner",
      createdAt: now + i,
      updatedAt: now + i,
    });
  }
  const handler = createAccountsHandler({ store });
  const firstPage = await handler(
    new Request(
      "https://accounts.example.test/v1/installations?space_id=space_page&limit=2",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(firstPage.status).toEqual(200);
  const firstBody = await firstPage.json();
  expect(firstBody.installations.length).toEqual(2);
  expect(typeof firstBody.next_cursor).toEqual("string");

  const secondPage = await handler(
    new Request(
      `https://accounts.example.test/v1/installations?space_id=space_page&limit=2&cursor=${
        encodeURIComponent(firstBody.next_cursor)
      }`,
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(secondPage.status).toEqual(200);
  const secondBody = await secondPage.json();
  expect(secondBody.installations.length).toEqual(2);
  // The serialized envelope exposes `id` (not `installationId`) for the
  // legacy wire shape (see `serializeAppInstallation`).
  expect(secondBody.installations[0].id).toEqual("inst_page_2");

  const malformedCursor = await handler(
    new Request(
      "https://accounts.example.test/v1/installations?space_id=space_page&cursor=%21%21%21",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(malformedCursor.status).toEqual(400);

  const overlimit = await handler(
    new Request(
      "https://accounts.example.test/v1/installations?space_id=space_page&limit=-3",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(overlimit.status).toEqual(400);
});

test("accounts handler signs export download redirects", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    exportDownloadSigningSecret: "f6-test-signing-secret",
    exportWorker: () => ({
      downloadUrl: "https://downloads.example.test/signed/takos-export.tar.zst",
      downloadExpiresAt: "2999-05-10T00:00:00.000Z",
    }),
  });
  await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId: "inst_signed_download",
        accountId: "acct_signed_download",
        spaceId: "space_signed_download",
        appId: "example.signed",
        source: {
          gitUrl: "https://github.com/example/signed",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_signed_download_owner",
      }),
    }),
  );
  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/installations/inst_signed_download/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-signed-export" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: {},
        }),
      },
    ),
  );
  expect(exportResponse.status).toEqual(202);
  const exported = await exportResponse.json();

  const downloadResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_signed_download/exports/${exported.operationId}/download`,
    ),
  );
  expect(downloadResponse.status).toEqual(302);
  const location = downloadResponse.headers.get("location") ?? "";
  expect(location).toContain("tk_sig=");
  expect(location).toContain("tk_exp=");
  // Operator must explicitly configure the signing secret; absence forces
  // 503 so an unsigned redirect to tenant-scoped data is never emitted.
  const noSecretHandler = createAccountsHandler({
    store,
    exportWorker: () => ({
      downloadUrl: "https://downloads.example.test/signed/takos-export.tar.zst",
      downloadExpiresAt: "2999-05-10T00:00:00.000Z",
    }),
  });
  const noSecretDownload = await noSecretHandler(
    new Request(
      `https://accounts.example.test/v1/installations/inst_signed_download/exports/${exported.operationId}/download`,
    ),
  );
  expect(noSecretDownload.status).toEqual(503);
});

test("accounts handler rate-limits OIDC authorize bursts per IP", async () => {
  const issuer = "https://accounts.example.test";
  const handler = createAccountsHandler({
    issuer,
    oidcFlow: {
      subject: "tsub_rate_limit",
      pairwiseSubjectSecret: "rl-secret",
      issueIdToken: () => Promise.resolve("dev"),
    },
    clients: [
      {
        clientId: "rate-limit-client",
        redirectUris: ["https://app.example.test/callback"],
      },
    ],
  });
  // 60/min is the documented authorize budget. Issue 61 from the same IP.
  let limited: Response | undefined;
  for (let i = 0; i < 62; i += 1) {
    const response = await handler(
      new Request(
        `${issuer}/oauth/authorize?response_type=code&client_id=rate-limit-client&redirect_uri=${
          encodeURIComponent("https://app.example.test/callback")
        }&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ&code_challenge_method=S256&scope=openid&state=rl-${i}`,
        {
          headers: { "cf-connecting-ip": "203.0.113.5" },
        },
      ),
    );
    if (response.status === 429) {
      limited = response;
      break;
    }
  }
  expect(limited?.status).toEqual(429);
  expect(typeof limited?.headers.get("retry-after")).toEqual("string");
});

async function createReadyLaunchInstallation(
  handler: (request: Request) => Promise<Response>,
  installationId: string,
): Promise<void> {
  const response = await handler(
    new Request("https://accounts.example.test/v1/installations", {
      method: "POST",
      body: JSON.stringify({
        installationId,
        accountId: "acct_1",
        spaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planSnapshotDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(response.status).toEqual(202);
}

async function dashboardHtml(
  handler: (request: Request) => Promise<Response>,
  installationId: string,
): Promise<string> {
  const response = await handler(
    new Request(
      `https://accounts.example.test/dashboard/installations/${installationId}`,
    ),
  );
  expect(response.status).toEqual(200);
  return await response.text();
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function stripeSignatureHeader(input: {
  payload: string;
  secret: string;
  timestamp: number;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        textEncoder.encode(`${input.timestamp}.${input.payload}`),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${input.timestamp},v1=${signature}`;
}

interface SignedPasskeyAssertionInput {
  challenge: string;
  origin: string;
  rpId: string;
  signCount: number;
}

interface SignedPasskeyAssertion {
  publicKeyJwk: JsonWebKey;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  keyPair: CryptoKeyPair;
}

async function createSignedAssertion(
  input: SignedPasskeyAssertionInput,
): Promise<SignedPasskeyAssertion> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return await createSignedAssertionWithKey({ ...input, keyPair });
}

async function createSignedAssertionWithKey(
  input: SignedPasskeyAssertionInput & { keyPair: CryptoKeyPair },
): Promise<SignedPasskeyAssertion> {
  const publicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    input.keyPair.publicKey,
  );
  const clientDataJSON = textEncoder.encode(JSON.stringify({
    type: "webauthn.get",
    challenge: input.challenge,
    origin: input.origin,
  }));
  const authenticatorData = await createAuthenticatorData({
    rpId: input.rpId,
    flags: 0x01,
    signCount: input.signCount,
  });
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientDataJSON),
  );
  const signedData = concatBytes(authenticatorData, clientDataHash);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      input.keyPair.privateKey,
      signedData,
    ),
  );

  return {
    publicKeyJwk,
    authenticatorData,
    clientDataJSON,
    signature,
    keyPair: input.keyPair,
  };
}

async function createAuthenticatorData(input: {
  rpId: string;
  flags: number;
  signCount: number;
}): Promise<Uint8Array> {
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", textEncoder.encode(input.rpId)),
    ),
    0,
  );
  authenticatorData[32] = input.flags;
  authenticatorData[33] = (input.signCount >>> 24) & 0xff;
  authenticatorData[34] = (input.signCount >>> 16) & 0xff;
  authenticatorData[35] = (input.signCount >>> 8) & 0xff;
  authenticatorData[36] = input.signCount & 0xff;
  return authenticatorData;
}

function concatBytes(
  first: Uint8Array,
  second: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(first.byteLength + second.byteLength);
  output.set(first, 0);
  output.set(second, first.byteLength);
  return output;
}

// Build the `webauthn.create` clientDataJSON the browser produces during
// registration (mirrors createSignedAssertion's `webauthn.get` data).
function createRegistrationClientDataJSON(input: {
  challenge: string;
  origin: string;
}): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    type: "webauthn.create",
    challenge: input.challenge,
    origin: input.origin,
  }));
}

// Build a minimal CBOR `none`-attestation attestationObject:
// `{ "fmt": "none", "authData": <bytes>, "attStmt": {} }`. authData binds to
// rpId with the user-present flag so the server's rpIdHash/UP checks pass.
async function createNoneAttestationObject(input: {
  rpId: string;
  signCount: number;
}): Promise<Uint8Array> {
  const authData = await createAuthenticatorData({
    rpId: input.rpId,
    flags: 0x01,
    signCount: input.signCount,
  });
  const cborTstr = (value: string): Uint8Array => {
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength > 23) throw new Error("test tstr too long");
    return concatBytes(new Uint8Array([0x60 | bytes.byteLength]), bytes);
  };
  // map(3)
  const header = new Uint8Array([0xa3]);
  // "fmt": "none"
  const fmt = concatBytes(cborTstr("fmt"), cborTstr("none"));
  // "authData": bstr(authData) — authData is 37 bytes, needs uint8 length.
  const authDataKey = cborTstr("authData");
  const bstrHeader = new Uint8Array([0x58, authData.byteLength]);
  const authDataValue = concatBytes(bstrHeader, authData);
  // "attStmt": {} (empty map)
  const attStmt = concatBytes(cborTstr("attStmt"), new Uint8Array([0xa0]));
  return concatBytes(
    concatBytes(
      concatBytes(header, fmt),
      concatBytes(authDataKey, authDataValue),
    ),
    attStmt,
  );
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function base64UrlDecodeText(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function base64UrlDecodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

test("handleUserInfo emits a flat space_memberships claim from the token's space", async () => {
  // Regression guard for the bundled-app integration break: bundled apps
  // (takos-docs / takos-slide / takos-excel) read a flat `space_memberships`
  // claim for membership checks. UserInfo must expose it derived from the
  // token's accessible space, while keeping `takosumi.space_id` for
  // backward compatibility.
  const store = new InMemoryAccountsStore();
  const accessToken = "access-membership-1";
  await store.saveAccessToken(accessToken, {
    clientId: "takos-docs",
    scope: "openid profile",
    subject: "tsub_membership",
    installationId: "inst-membership",
    appId: "takos-docs",
    spaceId: "space-membership",
    role: "member",
    expiresAt: Date.now() + 60_000,
  });

  const response = await handleUserInfo({
    request: new Request("https://accounts.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    store,
  });
  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.sub).toEqual("tsub_membership");
  expect(body.space_memberships).toEqual(["space-membership"]);
  // Backward compat: the nested claim is still present.
  expect(body.takosumi.space_id).toEqual("space-membership");
  expect(body.takosumi.installation_id).toEqual("inst-membership");
});
