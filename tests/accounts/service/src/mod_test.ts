import { expect, test } from "bun:test";

import {
  TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH,
  type TakosumiSubject,
  takosumiAccountsCapsuleBillingUsageReportsPath,
  takosumiAccountsCapsuleRevisionPlanRunsPath,
  takosumiAccountsCapsuleEventsPath,
  takosumiAccountsCapsulePath,
  takosumiAccountsCapsuleServiceRotateTokenPath,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_PROVIDER_COMPAT_CLOUDFLARE_WORKERS,
  takosumiAccountsPrivacyRequestCompletePath,
  takosumiAccountsPrivacyRequestPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsCapsuleExportBundle,
  type ServiceBindingMaterialKind,
  type ServiceBindingMaterializationResult,
  createAccountsHandler as createRawAccountsHandler,
  createEphemeralAccountsHandler,
  createOpenPlatformAccessPolicy,
  customOidcOAuthProvider,
  type DeployControlOperations,
  InMemorySharedCellWarmPool,
  TAKOSUMI_ACCOUNTS_BILLING_SMOKE_TOKEN_HEADER,
  TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER,
  TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER,
} from "../../../../accounts/service/src/mod.ts";
import {
  installationEnvelope,
  isMeteredBindingKind,
} from "../../../../accounts/service/src/installation-helpers.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-routes.ts";
import { appendLedgerEvent } from "../../../../accounts/service/src/installation-ledger-events.ts";
import { serviceGrantMaterialRecordsFromValue } from "../../../../accounts/service/src/installation-lifecycle-shared.ts";
import type {
  ApplyRunResponse,
  GetCapsuleResponse,
  ListDeploymentsResponse,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";
import {
  type AccountsStore,
  InMemoryAccountsStore,
} from "../../../../accounts/service/src/store.ts";
import { rejectDisallowedPresentedSession } from "../../../../accounts/service/src/login-email-allowlist.ts";
import { handleUserInfo } from "../../../../accounts/service/src/oidc-routes.ts";
import {
  type CapsuleRoute,
  matchCapsuleRoute,
} from "../../../../accounts/service/src/route-matchers.ts";

const textEncoder = new TextEncoder();
const testIssuer = "https://accounts.example.test";
const launchPairwiseSubjectSecret = "launch-pairwise-secret";
const testPlatformReadinessOpenAccess = createOpenPlatformAccessPolicy(
  {
    evidenceRef: "vault://platform-readiness/staging/rehearsal.json",
    approvalRef: "approval://platform-readiness/staging/operator-approval.json",
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

function createAccountsHandler(options: TestAccountsHandlerOptions = {}) {
  const store = options.store ?? new InMemoryAccountsStore();
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    platformAccess: testPlatformReadinessOpenAccess,
    ...options,
    store,
  });
  return async (request: Request): Promise<Response> => {
    const seeded = await maybeSeedLegacyProjectionFixtureForTest({
      request,
      store,
      options,
    });
    if (seeded) return seeded;
    return await handler(await withTestAppCapsuleAuth(request, store));
  };
}

/**
 * In-process deploy-control `operations` stub for the installation facade tests.
 * The account-plane deploy-control facade dispatches through this typed facade
 * (the HTTP `fetch` seam was removed); each test overrides only the methods its
 * flow reaches. Unspecified methods reject so an unexpected dispatch fails loud.
 */
function deployControlOperationsStub(
  overrides: Partial<DeployControlOperations> = {},
): DeployControlOperations {
  const reject = (name: string) => () =>
    Promise.reject(new Error(`unexpected deploy-control ${name} call`));
  return {
    createPlanRun: reject(
      "createPlanRun",
    ) as DeployControlOperations["createPlanRun"],
    getPlanRun: reject("getPlanRun") as DeployControlOperations["getPlanRun"],
    createApplyRun: reject(
      "createApplyRun",
    ) as DeployControlOperations["createApplyRun"],
    getCapsule: reject("getCapsule") as DeployControlOperations["getCapsule"],
    listDeployments: reject(
      "listDeployments",
    ) as DeployControlOperations["listDeployments"],
    ...overrides,
  };
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

function seedOwnedWorkspace(
  store: InMemoryAccountsStore,
  subject: TakosumiSubject = "tsub_owner",
  accountId = "acct_1",
  workspaceId = "space_1",
): void {
  const now = Date.now();
  store.saveLedgerAccount({
    accountId,
    legalOwnerSubject: subject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveWorkspace({
    workspaceId,
    accountId,
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
}

function accountSessionHeaders(sessionId: string): HeadersInit {
  return { authorization: `Bearer ${sessionId}` };
}

async function stripeSignature(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

function billingCheckoutOperations(
  subject: TakosumiSubject = "tsub_owner",
): ControlPlaneOperations {
  return {
    spaces: {
      getWorkspace: async (id: string) => ({
        id,
        handle: "owner",
        displayName: "Owner",
        type: "personal" as const,
        ownerUserId: subject,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  } as unknown as ControlPlaneOperations;
}

test("accounts handler emits dashboard Server-Timing without identity material", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_owner");
  const handler = createAccountsHandler({
    store,
    controlPlaneOperations: {} as ControlPlaneOperations,
  });

  const response = await handler(
    new Request(
      `${testIssuer}/api/v1/dashboard/bootstrap?includeWorkspaces=false`,
      { headers: accountSessionHeaders(sessionId) },
    ),
  );

  expect(response.status).toEqual(200);
  const timing = response.headers.get("server-timing") ?? "";
  expect(timing).toContain("tk_allowlist;dur=");
  expect(timing).toContain("tk_control_total;dur=");
  expect(timing).toContain("tk_control_auth;dur=");
  expect(timing).toContain("tk_control_dispatch;dur=");
  expect(timing).toContain("tk_dashboard;dur=");
  expect(timing).not.toContain("sess_");
  expect(timing).not.toContain("tsub_owner");
});

async function withTestAppCapsuleAuth(
  request: Request,
  store: AccountsStore,
): Promise<Request> {
  if (request.headers.has("authorization")) return request;
  const subject = await appCapsuleAuthSubjectForTest(request, store);
  if (!subject) return request;
  const sessionId = await seedGenericAccountSession(store, subject);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${sessionId}`);
  return new Request(request, { headers });
}

async function appCapsuleAuthSubjectForTest(
  request: Request,
  store: AccountsStore,
): Promise<TakosumiSubject | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/capsule-projections" && request.method === "POST") {
    const body = await jsonRecordForTest(request.clone());
    return testSubjectValue(body?.createdBySubject);
  }
  const route = matchCapsuleRoute(url.pathname);
  if (route) {
    if (!testCapsuleRouteNeedsAccountBearer(route.kind, request.method)) {
      return undefined;
    }
    const installation = await store.findAppCapsule(route.capsuleId);
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
}

function testCapsuleRouteNeedsAccountBearer(
  kind: CapsuleRoute["kind"],
  method: string,
): boolean {
  if (kind === "billing-usage-reports") return false;
  if (kind === "capsule" && method === "GET") return false;
  if (kind === "capsule" && method === "DELETE") return true;
  if (kind === "status" && method === "PATCH") return true;
  if (
    method === "POST" &&
    (kind === "revision" ||
      kind === "revision-plan-run" ||
      kind === "rollback" ||
      kind === "materialize" ||
      kind === "service-rotate-token" ||
      kind === "export")
  ) {
    return true;
  }
  return (
    method === "GET" &&
    (kind === "events" ||
      kind === "services" ||
      kind === "export-operation" ||
      kind === "export-download")
  );
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
  if (!(await store.findAccount(subject))) {
    await store.saveAccount({ subject, createdAt: now, updatedAt: now });
  }
  const sessionId = `sess_test_${subject}_${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
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
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function maybeSeedLegacyProjectionFixtureForTest(input: {
  request: Request;
  store: AccountsStore;
  options: TestAccountsHandlerOptions;
}): Promise<Response | undefined> {
  const url = new URL(input.request.url);
  if (
    url.pathname !== "/v1/capsule-projections" ||
    input.request.method !== "POST"
  ) {
    return undefined;
  }
  const body = await jsonRecordForTest(input.request.clone());
  if (!body) return undefined;
  const capsuleId = testStringValue(body.capsuleId);
  if (
    !capsuleId ||
    body.expected !== undefined ||
    body.planRunId !== undefined ||
    body.plan_run_id !== undefined
  ) {
    return undefined;
  }

  const source = testRecordValue(body.source) ?? {};
  const accountId = testStringValue(body.accountId);
  const workspaceId = testStringValue(body.workspaceId);
  const appId = testStringValue(body.appId);
  const sourceGitUrl =
    testStringValue(source.gitUrl) ?? testStringValue(source.url);
  const sourceRef = testStringValue(source.ref);
  const sourceCommit = testStringValue(source.commit);
  const planDigest =
    testStringValue(source.planDigest) ?? testStringValue(body.planDigest);
  const artifactDigest =
    testStringValue(source.artifactDigest) ??
    testStringValue(body.artifactDigest);
  const mode = testCapsuleModeValue(body.mode);
  const status = testCapsuleStatusValue(body.status) ?? "installing";
  const createdBySubject = testSubjectValue(body.createdBySubject);
  if (
    !accountId ||
    !workspaceId ||
    !appId ||
    !sourceGitUrl ||
    !sourceRef ||
    !sourceCommit ||
    !planDigest ||
    !mode ||
    !createdBySubject
  ) {
    return testErrorJson(
      "invalid_request",
      "legacy projection fixture is incomplete",
      400,
    );
  }

  const now = Date.now();
  const bindings = testServiceBindingMaterialRecordsFromValue({
    value: body.serviceBindings,
    capsuleId,
    now,
  });
  if (bindings instanceof Response) return bindings;
  const grants = testServiceGrantMaterialRecordsFromValue({
    value: body.serviceGrants,
    capsuleId,
    now,
  });
  if (grants instanceof Response) return grants;
  const confirm = await testConfirmFromValue({
    value: body.confirm,
    bindings,
    grants,
  });
  if (confirm instanceof Response) return confirm;
  const oidcClient = await testOidcClientFromValue({
    value: body.oidcClients ?? body.oidcClient,
    capsuleId,
    issuer: testStringValue(input.options.issuer) ?? testIssuer,
    bindings,
    now,
  });
  if (oidcClient instanceof Response) return oidcClient;

  let runtimeBinding = testRuntimeBindingFromValue({
    value: body.runtimeTarget,
    capsuleId,
    mode,
    now,
  });
  let runtimeBindingAutoAssigned = false;
  if (
    !runtimeBinding &&
    mode === "shared-cell" &&
    input.options.sharedCellRuntime
  ) {
    runtimeBinding = await input.options.sharedCellRuntime({
      capsuleId,
      accountId,
      workspaceId,
      appId,
      createdBySubject,
      now,
    });
    if (!runtimeBinding) {
      return testErrorJson(
        "shared_cell_capacity_unavailable",
        "shared-cell install requires an available warm runtime slot",
        503,
      );
    }
    runtimeBindingAutoAssigned = true;
  }

  const installation = {
    capsuleId,
    accountId,
    workspaceId,
    appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    planDigest,
    artifactDigest,
    mode,
    runtimeBindingId:
      runtimeBinding?.runtimeBindingId ?? testStringValue(body.runtimeTargetId),
    billingAccountId:
      testStringValue(body.billingAccountId) ??
      testStringValue(body.billing_account_id),
    status,
    createdBySubject,
    createdAt: now,
    updatedAt: now,
  };

  let materializedBindings = bindings;
  const materializedEvents: typeof bindings = [];
  const materializedEnv: Record<string, string> = {};
  if (oidcClient) {
    materializedBindings = materializedBindings.map((binding) => {
      if (binding.name !== oidcClient.binding) return binding;
      const updated = {
        ...binding,
        configRef: testBindingRef(
          capsuleId,
          binding.name,
          "oidc-client",
          oidcClient.client.clientId,
        ),
        secretRefs: [],
        updatedAt: now,
      };
      materializedEvents.push(updated);
      return updated;
    });
  }
  if (input.options.launchTokens) {
    materializedBindings = materializedBindings.map((binding) => {
      if (binding.kind !== "auth.bootstrap_token") return binding;
      const updated = {
        ...binding,
        configRef: testBindingRef(capsuleId, binding.name, "launch-token"),
        secretRefs: [],
        updatedAt: now,
      };
      materializedEvents.push(updated);
      return updated;
    });
  }
  if (input.options.bindingMaterializer) {
    const declarations = testBindingDeclarations(body.serviceBindings);
    const nextBindings = [];
    for (const binding of materializedBindings) {
      const materialized = await input.options.bindingMaterializer({
        installation,
        binding,
        declaration: declarations.get(binding.name),
        issuer: testStringValue(input.options.issuer) ?? testIssuer,
      });
      if (materialized) {
        for (const [key, value] of Object.entries(materialized.env ?? {})) {
          const issue = testPublicServiceBindingEnvIssue(key, value);
          if (issue) {
            return testErrorJson(
              "invalid_binding_materialization",
              `binding ${binding.name} env ${key} ${issue}`,
              422,
            );
          }
        }
        const updated = {
          ...binding,
          configRef: materialized.configRef,
          secretRefs: materialized.secretRefs ?? [],
          updatedAt: now,
        };
        nextBindings.push(updated);
        materializedEvents.push(updated);
        Object.assign(materializedEnv, materialized.env ?? {});
      } else {
        nextBindings.push(binding);
      }
    }
    materializedBindings = nextBindings;
  }

  await ensureLedgerAccountForTest(input.store, accountId, createdBySubject);
  if (!(await input.store.findWorkspace(workspaceId))) {
    await input.store.saveWorkspace({
      workspaceId,
      accountId,
      kind: testWorkspaceKindValue(body.spaceKind) ?? "personal",
      displayName: testStringValue(body.spaceDisplayName),
      createdAt: now,
      updatedAt: now,
    });
  }
  await input.store.saveAppCapsule(installation);
  if (runtimeBinding) await input.store.saveRuntimeBinding(runtimeBinding);
  for (const binding of materializedBindings) {
    await input.store.saveServiceBindingMaterial(binding);
  }
  for (const grant of grants) {
    await input.store.saveServiceGrantMaterial(grant);
  }
  if (oidcClient) await input.store.saveOidcClient(oidcClient.client);

  await appendLedgerEvent(input.store, {
    capsuleId,
    eventType: "installation.created",
    payload: { appId, accountId, workspaceId, mode, status },
    now,
  });
  if (confirm) {
    await appendLedgerEvent(input.store, {
      capsuleId,
      eventType: "installation.approved",
      payload: confirm,
      now,
    });
  }
  if (oidcClient) {
    await appendLedgerEvent(input.store, {
      capsuleId,
      eventType: "oidc_client.registered",
      payload: {
        clientId: oidcClient.client.clientId,
        servicePath: oidcClient.client.namespacePath,
        namespacePath: oidcClient.client.namespacePath,
        issuerUrl: oidcClient.client.issuerUrl,
        redirectUris: oidcClient.client.redirectUris,
        allowedScopes: oidcClient.client.allowedScopes,
        subjectMode: oidcClient.client.subjectMode,
        tokenEndpointAuthMethod: oidcClient.client.tokenEndpointAuthMethod,
      },
      now,
    });
  }
  if (runtimeBindingAutoAssigned && runtimeBinding) {
    await appendLedgerEvent(input.store, {
      capsuleId,
      eventType: "runtime_target.assigned",
      payload: {
        runtimeTargetId: runtimeBinding.runtimeBindingId,
        mode: runtimeBinding.mode,
        targetType: runtimeBinding.targetType,
        targetId: runtimeBinding.targetId,
      },
      now,
    });
  }
  for (const binding of materializedEvents) {
    await appendLedgerEvent(input.store, {
      capsuleId,
      eventType: "service_binding.materialized",
      payload: {
        serviceBinding: binding.name,
        kind: binding.kind,
        configRef: binding.configRef,
        secretRefs: binding.secretRefs,
      },
      now,
    });
  }

  const envelope = installationEnvelope({
    installation,
    bindings: materializedBindings,
    grants,
    runtimeBinding,
    oidcClient: oidcClient?.client,
    eventsUrl: `/v1/capsule-projections/${capsuleId}/events`,
  });
  return testJson(
    {
      ...envelope,
      ...(Object.keys(materializedEnv).length > 0
        ? { service_binding_env: materializedEnv }
        : {}),
    },
    202,
    { location: `/v1/capsule-projections/${capsuleId}` },
  );
}

function testPublicServiceBindingEnvIssue(
  name: string,
  value: string,
): string | undefined {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    return "must be an uppercase environment variable name";
  }
  const normalized = name.toUpperCase();
  if (
    /(^|_)(SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|APIKEY|API_KEY|ACCESSKEY|ACCESS_KEY|PRIVATEKEY|PRIVATE_KEY|CLIENT_SECRET|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN|BEARER_TOKEN)(_|$)/.test(
      normalized,
    ) ||
    ["DATABASE_URL", "DB_URL", "DSN", "CONNECTION_STRING"].includes(
      normalized,
    ) ||
    ["_DATABASE_URL", "_DB_URL", "_DSN", "_CONNECTION_STRING"].some((suffix) =>
      normalized.endsWith(suffix),
    )
  ) {
    return "may carry secret material; use secretRefs";
  }
  const trimmed = value.trim();
  if (
    /\b(?:Bearer|Basic|Digest|Token)\s+[-._~+/=a-zA-Z0-9]+|\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)=/i.test(
      trimmed,
    )
  ) {
    return "value may carry secret material; use secretRefs";
  }
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      return "value may carry secret material; use secretRefs";
    }
  } catch {
    // Not a URL.
  }
  return undefined;
}

function testRecordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function testStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function testCapsuleModeValue(
  value: unknown,
): "shared-cell" | "dedicated" | "self-hosted" | undefined {
  return value === "shared-cell" ||
    value === "dedicated" ||
    value === "self-hosted"
    ? value
    : undefined;
}

function testCapsuleStatusValue(
  value: unknown,
): "installing" | "ready" | "failed" | "suspended" | "exported" | undefined {
  return value === "installing" ||
    value === "ready" ||
    value === "failed" ||
    value === "suspended" ||
    value === "exported"
    ? value
    : undefined;
}

function testWorkspaceKindValue(
  value: unknown,
): "personal" | "team" | "org" | undefined {
  return value === "personal" || value === "team" || value === "org"
    ? value
    : undefined;
}

const testServiceBindingMaterialKinds = new Set<string>([
  "identity.oidc",
  "storage.sql",
  "storage.object",
  "protocol.http.api",
  "auth.bootstrap_token",
]);

function testServiceBindingMaterialRecordsFromValue(input: {
  value: unknown;
  capsuleId: string;
  now: number;
}):
  | readonly {
      bindingId: string;
      capsuleId: string;
      name: string;
      kind: ServiceBindingMaterialKind;
      configRef: string;
      secretRefs: readonly string[];
      createdAt: number;
      updatedAt: number;
    }[]
  | Response {
  if (input.value === undefined) return [];
  if (!Array.isArray(input.value)) {
    return testErrorJson(
      "invalid_service_bindings",
      "serviceBindings must be an array",
      422,
    );
  }
  const bindings = [];
  for (const [index, entry] of input.value.entries()) {
    const record = testRecordValue(entry);
    const name = testStringValue(record?.name);
    const kind = testStringValue(record?.kind);
    if (record?.secretRefs !== undefined || record?.secret_refs !== undefined) {
      return testErrorJson(
        "invalid_service_bindings",
        "serviceBindings secretRefs must not appear in request bodies",
        422,
      );
    }
    if (
      !record ||
      !name ||
      !kind ||
      !testServiceBindingMaterialKinds.has(kind)
    ) {
      return testErrorJson(
        "invalid_service_bindings",
        "serviceBindings entries are invalid",
        422,
      );
    }
    bindings.push({
      bindingId:
        testStringValue(record.serviceBindingId) ??
        testStringValue(record.bindingId) ??
        `bind_${input.capsuleId}_${index}`,
      capsuleId: input.capsuleId,
      name,
      kind: kind as ServiceBindingMaterialKind,
      configRef:
        testStringValue(record.configRef) ??
        `config://${input.capsuleId}/${name}`,
      secretRefs: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  return bindings;
}

const testServiceGrantMaterialCapabilities = new Set<string>([
  "app.profile.write",
  "app.memory.write",
  "deploy.intent.write",
  "logs.read.own",
  "billing.usage.report",
  "spaces:read",
  "spaces:write",
  "files:read",
  "files:write",
  "memories:read",
  "memories:write",
  "threads:read",
  "threads:write",
  "runs:read",
  "runs:write",
  "agents:execute",
  "repos:read",
  "repos:write",
  "mcp:invoke",
  "events:subscribe",
]);

function testServiceGrantMaterialRecordsFromValue(input: {
  value: unknown;
  capsuleId: string;
  now: number;
}):
  | readonly {
      grantId: string;
      capsuleId: string;
      capability: string;
      scope: Record<string, unknown>;
      grantedAt: number;
      revokedAt?: number;
    }[]
  | Response {
  if (input.value === undefined) return [];
  if (!Array.isArray(input.value)) {
    return testErrorJson(
      "invalid_service_grants",
      "serviceGrants must be an array",
      422,
    );
  }
  const grants = [];
  for (const [index, entry] of input.value.entries()) {
    const record = testRecordValue(entry);
    const capability = testStringValue(record?.capability);
    if (
      !record ||
      !capability ||
      !testServiceGrantMaterialCapabilities.has(capability)
    ) {
      return testErrorJson(
        "invalid_service_grants",
        "serviceGrants entries are invalid",
        422,
      );
    }
    grants.push({
      grantId:
        testStringValue(record.serviceGrantId) ??
        testStringValue(record.grantId) ??
        `grant_${input.capsuleId}_${index}`,
      capsuleId: input.capsuleId,
      capability,
      scope: testRecordValue(record.scope) ?? {},
      grantedAt: input.now,
    });
  }
  return grants;
}

async function testConfirmFromValue(input: {
  value: unknown;
  bindings: readonly { kind: ServiceBindingMaterialKind }[];
  grants: readonly { capability: string }[];
}): Promise<Response | Record<string, unknown> | undefined> {
  if (input.value === undefined) return undefined;
  const confirm = testRecordValue(input.value);
  if (!confirm) {
    return testErrorJson("invalid_confirm", "confirm is invalid", 400);
  }
  if (
    input.bindings.some((binding) => isMeteredBindingKind(binding.kind)) &&
    confirm.costAck !== true
  ) {
    return testErrorJson(
      "cost_ack_required",
      "metered service bindings require confirm.costAck=true",
      400,
    );
  }
  const permissionDigest = testStringValue(confirm.permissionDigest);
  if (permissionDigest) {
    const expectedPermissionDigest = await testPermissionDigest({
      serviceBindingKinds: input.bindings.map((binding) => binding.kind),
      serviceGrants: input.grants.map((grant) => grant.capability),
    });
    if (permissionDigest !== expectedPermissionDigest) {
      return testErrorJson(
        "approval_digest_mismatch",
        "permission digest does not match requested service bindings and service grants",
        409,
        { expected_permission_digest: expectedPermissionDigest },
      );
    }
  }
  return {
    ...(permissionDigest ? { permissionDigest } : {}),
    costAck: confirm.costAck === true,
    ...(typeof confirm.approvalRequired === "boolean"
      ? { approvalRequired: confirm.approvalRequired }
      : {}),
    ...(testStringValue(confirm.expiresAt)
      ? { expiresAt: testStringValue(confirm.expiresAt) }
      : {}),
  };
}

async function testOidcClientFromValue(input: {
  value: unknown;
  capsuleId: string;
  issuer: string;
  bindings: readonly { name: string; kind: ServiceBindingMaterialKind }[];
  now: number;
}): Promise<
  | {
      binding: string;
      client: {
        clientId: string;
        capsuleId: string;
        namespacePath: string;
        issuerUrl: string;
        redirectUris: readonly string[];
        allowedScopes: readonly string[];
        subjectMode: "pairwise";
        tokenEndpointAuthMethod: "none";
        clientSecretHash?: string;
        createdAt: number;
        updatedAt: number;
      };
    }
  | Response
  | undefined
> {
  if (input.value === undefined) return undefined;
  const value = Array.isArray(input.value)
    ? input.value.length === 1
      ? testRecordValue(input.value[0])
      : undefined
    : testRecordValue(input.value);
  if (!value) {
    return testErrorJson(
      "invalid_oidc_clients",
      "oidcClients must contain exactly one client object",
      400,
    );
  }
  if (value.serviceId !== undefined || value.service_id !== undefined) {
    return testErrorJson(
      "invalid_oidc_clients",
      "oidcClients entries use servicePath; serviceId/service_id are not accepted",
      400,
    );
  }
  const redirectUris = Array.isArray(value.redirectUris)
    ? value.redirectUris.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  const binding = testStringValue(value.serviceBinding) ?? "auth";
  const bindingRecord = input.bindings.find((entry) => entry.name === binding);
  if (!bindingRecord || bindingRecord.kind !== "identity.oidc") {
    return testErrorJson(
      "invalid_oidc_clients",
      "oidcClients[].serviceBinding must reference an identity.oidc service binding",
      422,
    );
  }
  const allowedScopes = Array.isArray(value.allowedScopes)
    ? value.allowedScopes.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : ["openid"];
  const tokenEndpointAuthMethod =
    value.tokenEndpointAuthMethod === "none" ||
    value.tokenEndpointAuthMethod === undefined
      ? "none"
      : undefined;
  if (!tokenEndpointAuthMethod) {
    return testErrorJson(
      "invalid_oidc_clients",
      "installation OIDC clients are public PKCE clients; tokenEndpointAuthMethod must be none",
      400,
    );
  }
  if (
    !redirectUris ||
    redirectUris.length === 0 ||
    !allowedScopes.includes("openid") ||
    (value.subjectMode !== undefined && value.subjectMode !== "pairwise")
  ) {
    return testErrorJson(
      "invalid_oidc_clients",
      "oidcClients entries require redirectUris, allowedScopes containing openid, and subjectMode pairwise",
      400,
    );
  }
  return {
    binding,
    client: {
      clientId: testStringValue(value.clientId) ?? `toc_${crypto.randomUUID()}`,
      capsuleId: input.capsuleId,
      namespacePath:
        testStringValue(value.servicePath) ??
        testStringValue(value.service_path) ??
        testStringValue(value.namespacePath) ??
        testStringValue(value.namespace_path) ??
        "takosumi.identity.oidc",
      issuerUrl: testStringValue(value.issuerUrl) ?? input.issuer,
      redirectUris,
      allowedScopes,
      subjectMode: "pairwise",
      tokenEndpointAuthMethod,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

function testRuntimeBindingFromValue(input: {
  value: unknown;
  capsuleId: string;
  mode: "shared-cell" | "dedicated" | "self-hosted";
  now: number;
}):
  | {
      runtimeBindingId: string;
      capsuleId: string;
      mode: "shared-cell" | "dedicated" | "self-hosted";
      targetType: "shared-cell" | "dedicated" | "self-hosted";
      targetId: string;
      createdAt: number;
      updatedAt: number;
    }
  | undefined {
  const value = testRecordValue(input.value);
  if (!value) return undefined;
  const targetType = value.targetType;
  if (
    targetType !== "shared-cell" &&
    targetType !== "dedicated" &&
    targetType !== "self-hosted"
  ) {
    return undefined;
  }
  const targetId = testStringValue(value.targetId);
  if (!targetId) return undefined;
  return {
    runtimeBindingId:
      testStringValue(value.runtimeTargetId) ??
      testStringValue(value.runtimeBindingId) ??
      `rtb_${input.capsuleId}`,
    capsuleId: input.capsuleId,
    mode: input.mode,
    targetType,
    targetId,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function testBindingDeclarations(
  value: unknown,
): Map<string, Record<string, unknown>> {
  const declarations = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return declarations;
  for (const entry of value) {
    const record = testRecordValue(entry);
    const name = testStringValue(record?.name);
    const declaration = testRecordValue(record?.declaration);
    if (name && declaration) declarations.set(name, declaration);
  }
  return declarations;
}

function testBindingRef(
  capsuleId: string,
  binding: string,
  ...segments: string[]
): string {
  const tail = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `takosumi-accounts://installations/${encodeURIComponent(
    capsuleId,
  )}/service-bindings/${encodeURIComponent(binding)}/${tail}`;
}

function testJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function testErrorJson(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return testJson({ error: { code, message, ...(details ?? {}) } }, status);
}

function testSubjectValue(value: unknown): TakosumiSubject | undefined {
  return typeof value === "string" && value.startsWith("tsub_")
    ? (value as TakosumiSubject)
    : undefined;
}

async function testPermissionDigest(input: {
  serviceBindingKinds: readonly string[];
  serviceGrants: readonly string[];
}): Promise<string> {
  return await testSha256HexDigest({
    serviceBindingKinds: [...input.serviceBindingKinds].sort(),
    serviceGrants: [...input.serviceGrants].sort(),
  });
}

async function testMaterializePermissionDigest(input: {
  capsuleId: string;
  region: string;
  plan?: Record<string, unknown>;
  cutover?: Record<string, unknown>;
}): Promise<string> {
  return await testSha256HexDigest({
    operation: "materialize",
    capsuleId: input.capsuleId,
    mode: "dedicated",
    region: input.region,
    plan: input.plan ?? {},
    cutover: input.cutover ?? {},
  });
}

async function testRevisionPermissionDigest(input: {
  operation: "revision" | "rollback";
  capsuleId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planDigest: string;
  artifactDigest?: string | null;
  requestedBindings?: readonly Record<string, unknown>[];
  requestedGrants?: readonly Record<string, unknown>[];
}): Promise<string> {
  return await testSha256HexDigest({
    operation: input.operation,
    capsuleId: input.capsuleId,
    appId: input.appId,
    source: {
      gitUrl: input.sourceGitUrl
        .trim()
        .replace(/\/+$/, "")
        .replace(/\.git$/, ""),
      ref: input.sourceRef,
      commit: input.sourceCommit,
      planDigest: input.planDigest,
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
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
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
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
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
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          kid: "test-key",
          use: "sig",
          alg: "ES256",
          x: "x",
          y: "y",
        },
      ],
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

test("accounts handler deletes existing sessions outside the pre-GA email allowlist", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_blocked",
    email: "blocked@example.test",
    emailVerified: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAccountSession({
    sessionId: "sess_blocked",
    subject: "tsub_blocked",
    createdAt: 1000,
    expiresAt: Date.now() + 60_000,
  });
  const handler = createAccountsHandler({
    store,
    loginEmailAllowlist: { emails: ["shoutatomiyama0614@gmail.com"] },
  });

  const response = await handler(
    new Request(`${testIssuer}/v1/account/session/me`, {
      headers: { authorization: "Bearer sess_blocked" },
    }),
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error.code).toEqual("login_not_allowed");
  expect(store.findAccountSession("sess_blocked")).toEqual(undefined);
  expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
});

test("accounts handler reuses session and account reads within a request", async () => {
  class CountingAccountsStore extends InMemoryAccountsStore {
    sessionReads = 0;
    accountReads = 0;

    override findAccountSession(sessionId: string) {
      this.sessionReads += 1;
      return super.findAccountSession(sessionId);
    }

    override findAccount(subject: TakosumiSubject) {
      this.accountReads += 1;
      return super.findAccount(subject);
    }
  }

  const store = new CountingAccountsStore();
  store.saveAccount({
    subject: "tsub_allowed",
    email: "allowed@example.test",
    emailVerified: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAccountSession({
    sessionId: "sess_allowed",
    subject: "tsub_allowed",
    createdAt: 1000,
    expiresAt: Date.now() + 60_000,
  });
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    platformAccess: testPlatformReadinessOpenAccess,
    store,
    loginEmailAllowlist: {
      emails: ["allowed@example.test"],
      requireVerifiedEmail: true,
    },
  });

  const response = await handler(
    new Request(`${testIssuer}/v1/account/session/me`, {
      headers: { authorization: "Bearer sess_allowed" },
    }),
  );

  expect(response.status).toEqual(200);
  expect((await response.json()).subject).toEqual("tsub_allowed");
  expect(store.sessionReads).toEqual(1);
  expect(store.accountReads).toEqual(1);
});

test("pre-GA email allowlist shares concurrent checks for the same allowed session", async () => {
  class CountingAccountsStore extends InMemoryAccountsStore {
    sessionReads = 0;
    accountReads = 0;

    override findAccountSession(sessionId: string) {
      this.sessionReads += 1;
      return super.findAccountSession(sessionId);
    }

    override findAccount(subject: TakosumiSubject) {
      this.accountReads += 1;
      return super.findAccount(subject);
    }
  }

  const store = new CountingAccountsStore();
  store.saveAccount({
    subject: "tsub_parallel_allowed",
    email: "allowed-parallel@example.test",
    emailVerified: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAccountSession({
    sessionId: "sess_parallel_allowed",
    subject: "tsub_parallel_allowed",
    createdAt: 1000,
    expiresAt: Date.now() + 60_000,
  });

  const request = new Request(`${testIssuer}/api/v1/workspaces`, {
    headers: { authorization: "Bearer sess_parallel_allowed" },
  });
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      rejectDisallowedPresentedSession({
        request,
        store,
        sessionId: "sess_parallel_allowed",
        allowlist: {
          emails: ["allowed-parallel@example.test"],
          requireVerifiedEmail: true,
        },
        secureCookie: true,
      }),
    ),
  );

  expect(results).toEqual([undefined, undefined, undefined]);
  expect(store.sessionReads).toEqual(1);
  expect(store.accountReads).toEqual(1);
});

test("accounts handler proxies installation PlanRun to deployControl", async () => {
  const createPlanRunCalls: unknown[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(store, "tsub_owner", "acct_space_1", "space_1");
  const sessionId = seedAccountSession(store, "tsub_owner");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    // The in-process deploy-control transport: the facade dispatches through the
    // typed `operations` facade (no HTTP seam, no Bearer handshake).
    deployControl: {
      operations: deployControlOperationsStub({
        createPlanRun: (request) => {
          createPlanRunCalls.push(request);
          return Promise.resolve({
            planRun: {
              id: "plan_core_apply",
              workspaceId: "space_core",
              source: {
                kind: "git",
                url: "https://github.com/example/hello",
                ref: "main",
              },
              operation: "create",
              runnerProfileId: "cloudflare-default",
              sourceDigest: "sha256:source-core-apply",
              variablesDigest: "sha256:variables-core-apply",
              policyDecisionDigest: "sha256:policy-core-apply",
              planDigest: "sha256:abc",
              planArtifact: {
                kind: "runner-local",
                ref: "runner-local://plan_core_apply/tfplan",
                digest: "sha256:abc",
              },
              sourceCommit: "0123456789abcdef0123456789abcdef01234567",
              status: "succeeded",
              requiredProviders: [],
              policy: { status: "passed", reasons: [], checkedAt: 1 },
              createdAt: 1,
              updatedAt: 1,
              finishedAt: 1,
            },
          } as unknown as PlanRunResponse);
        },
      }),
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/plan-runs",
      {
        method: "POST",
        headers: {
          ...accountSessionHeaders(sessionId),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: "space_1",
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "v1.2.3",
          },
        }),
      },
    ),
  );

  // The in-process create-PlanRun dispatch returns the canonical 201 create
  // status (the former HTTP-mock returned an arbitrary 200; the shipped platform
  // worker always injects `operations`, so 201 is the production status).
  expect(response.status).toEqual(201);
  expect((await response.json()).planDigest).toEqual("sha256:abc");
  // The facade calls the typed createPlanRun with the normalized request body.
  expect(createPlanRunCalls.length).toEqual(1);
  expect(createPlanRunCalls[0]).toEqual({
    workspaceId: "space_1",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "v1.2.3",
    },
    operation: "create",
  });
});

test("accounts handler applies installation through space deployControl when configured", async () => {
  const getPlanRunCalls: string[] = [];
  const createApplyRunCalls: unknown[] = [];
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(store, "tsub_core_apply", "acct_core_apply", "space_core");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getPlanRun: (id) => {
          getPlanRunCalls.push(id);
          return Promise.resolve({
            planRun: {
              id: "plan_core_apply",
              workspaceId: "space_core",
              source: {
                kind: "git",
                url: "https://github.com/example/hello",
                ref: "main",
              },
              operation: "create",
              runnerProfileId: "cloudflare-default",
              sourceDigest: "sha256:source-core-apply",
              variablesDigest: "sha256:variables-core-apply",
              policyDecisionDigest: "sha256:policy-core-apply",
              planDigest: "sha256:abc",
              planArtifact: {
                kind: "runner-local",
                ref: "runner-local://plan_core_apply/tfplan",
                digest: "sha256:abc",
              },
              sourceCommit: "0123456789abcdef0123456789abcdef01234567",
              status: "succeeded",
              requiredProviders: [],
              policy: { status: "passed", reasons: [], checkedAt: 1 },
              createdAt: 1,
              updatedAt: 1,
              finishedAt: 1,
            },
          } as unknown as PlanRunResponse);
        },
        createApplyRun: (request) => {
          createApplyRunCalls.push(request);
          return Promise.resolve({
            installation: {
              id: "inst_core_apply",
              workspaceId: "space_core",
              appId: "example.hello",
              currentDeploymentId: "dep_core_apply",
              status: "ready",
              createdAt: 1,
            },
            deployment: {
              id: "dep_core_apply",
              capsuleId: "inst_core_apply",
              source: {
                kind: "git",
                url: "https://github.com/example/hello",
                ref: "main",
                commit: "0123456789abcdef0123456789abcdef01234567",
              },
              planDigest: "sha256:abc",
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
          } as unknown as ApplyRunResponse);
        },
      }),
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_core_apply",
        workspaceId: "space_core",
        planRunId: "plan_core_apply",
        planArtifactDigest: "sha256:abc",
        expected: {
          planRunId: "plan_core_apply",
          runnerProfileId: "cloudflare-default",
          sourceDigest: "sha256:source-core-apply",
          variablesDigest: "sha256:variables-core-apply",
          policyDecisionDigest: "sha256:policy-core-apply",
          planDigest: "sha256:abc",
          planArtifactDigest: "sha256:abc",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        },
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
  expect(response.headers.get("location")).toEqual(
    "/v1/capsule-projections/inst_core_apply",
  );
  const body = await response.json();
  expect(body.installation.id).toEqual("inst_core_apply");
  expect(body.installation.status).toEqual("ready");
  expect(body.installation.capsule_id).toEqual("example.hello");
  expect("app_id" in body.installation).toEqual(false);
  expect(body.installation.launch_url).toEqual("https://hello.example.test");
  expect(body.installation.launch.url).toEqual("https://hello.example.test");
  expect(body.launch.url).toEqual("https://hello.example.test");
  expect(store.findAppCapsule("inst_core_apply")?.sourceCommit).toEqual(
    "0123456789abcdef0123456789abcdef01234567",
  );
  const ownerSession = seedAccountSession(
    store,
    "tsub_core_apply",
    "sess_core_apply_owner",
  );
  const detailResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_core_apply",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(detailResponse.status).toEqual(200);
  const detail = await detailResponse.json();
  expect(detail.installation.launch.activationEvidenceId).toEqual(
    "dep_core_apply",
  );
  expect(
    store.listCapsuleEvents("inst_core_apply").map((event) => event.eventType),
  ).toEqual(["installation.created", "installation.activated-http-domain"]);
  // The facade reviews the reviewed PlanRun then applies it through the typed
  // operations facade (the in-process transport — no HTTP seam).
  expect(getPlanRunCalls).toEqual(["plan_core_apply"]);
  expect(createApplyRunCalls.length).toEqual(1);
  expect((createApplyRunCalls[0] as { planRunId?: string }).planRunId).toEqual(
    "plan_core_apply",
  );
});

test("accounts handler projects space-direct apply responses without deployment source fields", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(
    store,
    "tsub_space_direct",
    "acct_space_direct",
    "space_core",
  );
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getPlanRun: (id) => {
          expect(id).toEqual("plan_space_direct");
          return Promise.resolve({
            planRun: {
              id: "plan_space_direct",
              workspaceId: "space_core",
              source: {
                kind: "git",
                url: "https://github.com/example/space-direct",
                ref: "main",
              },
              operation: "create",
              runnerProfileId: "cloudflare-default",
              sourceDigest: "sha256:source-space-direct",
              variablesDigest: "sha256:variables-space-direct",
              policyDecisionDigest: "sha256:policy-space-direct",
              planDigest: "sha256:space-direct",
              planArtifact: {
                kind: "runner-local",
                ref: "runner-local://plan_space_direct/tfplan",
                digest: "sha256:space-direct",
              },
              sourceCommit: "0123456789abcdef0123456789abcdef01234567",
              status: "succeeded",
              requiredProviders: [],
              policy: { status: "passed", reasons: [], checkedAt: 1 },
              createdAt: 1,
              updatedAt: 1,
              finishedAt: 1,
            },
          } as unknown as PlanRunResponse);
        },
        createApplyRun: (request) =>
          Promise.resolve({
            applyRun: {
              id: "apply_space_direct",
              planRunId: "plan_space_direct",
              workspaceId: "space_core",
              capsuleId: "inst_space_direct",
              deploymentId: "dep_space_direct",
              operation: "create",
              runnerProfileId: "cloudflare-default",
              status: "succeeded",
              expected: request.expected,
              auditEvents: [],
              createdAt: 2,
              updatedAt: 2,
            },
            installation: {
              id: "inst_space_direct",
              workspaceId: "space_core",
              name: "space direct",
              slug: "space-direct",
              status: "active",
              createdAt: "2026-06-25T00:00:00.000Z",
              updatedAt: "2026-06-25T00:00:01.000Z",
              environment: "production",
              installConfigId: "cfg-default-opentofu-capsule",
              currentDeploymentId: "dep_space_direct",
              currentStateGeneration: 1,
            },
            deployment: {
              id: "dep_space_direct",
              capsuleId: "inst_space_direct",
              status: "active",
              outputsPublic: {
                url: "https://space-direct.example.test",
              },
              createdAt: "2026-06-25T00:00:01.000Z",
            },
          } as unknown as ApplyRunResponse),
      }),
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_space_direct",
        workspaceId: "space_core",
        appId: "example.space-direct",
        status: "installing",
        planRunId: "plan_space_direct",
        expected: {
          planRunId: "plan_space_direct",
          runnerProfileId: "cloudflare-default",
          sourceDigest: "sha256:source-space-direct",
          variablesDigest: "sha256:variables-space-direct",
          policyDecisionDigest: "sha256:policy-space-direct",
          planDigest: "sha256:space-direct",
          planArtifactDigest: "sha256:space-direct",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        },
        source: {
          kind: "git",
          url: "https://github.com/example/space-direct",
          ref: "main",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_space_direct",
      }),
    }),
  );

  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.installation.id).toEqual("inst_space_direct");
  expect(body.installation.status).toEqual("ready");
  expect(body.installation.capsule_id).toEqual("example.space-direct");
  expect(body.installation.launch_url).toEqual(
    "https://space-direct.example.test",
  );
  const stored = store.findAppCapsule("inst_space_direct");
  expect(stored?.sourceGitUrl).toEqual(
    "https://github.com/example/space-direct",
  );
  expect(stored?.sourceCommit).toEqual(
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(stored?.planDigest).toEqual("sha256:space-direct");
});

test("accounts handler reads current deployment outputs for existing Capsule projection details", async () => {
  const store = new InMemoryAccountsStore();
  const session = seedAccountSession(store, "tsub_projection_owner");
  seedOwnedWorkspace(
    store,
    "tsub_projection_owner",
    "acct_projection",
    "space_projection",
  );
  const now = Date.now();
  await store.saveAppCapsule({
    capsuleId: "inst_projection",
    accountId: "acct_projection",
    workspaceId: "space_projection",
    appId: "example.projection",
    sourceGitUrl: "https://github.com/example/projection.git",
    sourceRef: "main",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    planDigest: "sha256:projection",
    artifactDigest: "sha256:projection",
    mode: "self-hosted",
    status: "ready",
    createdBySubject: "tsub_projection_owner",
    createdAt: now,
    updatedAt: now,
  });
  let getCapsuleCalled = false;
  let listDeploymentsCalled = false;
  const handler = createAccountsHandler({
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getCapsule: (id) => {
          getCapsuleCalled = true;
          if (id !== "inst_projection") {
            throw new Error(`unexpected capsule id ${id}`);
          }
          return Promise.resolve({
            capsule: {
              id: "inst_projection",
              workspaceId: "space_projection",
              name: "projection",
              slug: "projection",
              status: "active",
              environment: "production",
              installConfigId: "cfg_projection",
              currentStateVersionId: "dep_projection",
              currentStateGeneration: 1,
              createdAt: "2026-07-07T00:00:00.000Z",
              updatedAt: "2026-07-07T00:00:01.000Z",
            },
          } as unknown as GetCapsuleResponse);
        },
        listDeployments: (id) => {
          listDeploymentsCalled = true;
          if (id !== "inst_projection") {
            throw new Error(`unexpected deployments capsule id ${id}`);
          }
          return Promise.resolve({
            deployments: [
              {
                id: "dep_projection",
                capsuleId: "inst_projection",
                status: "active",
                outputsPublic: {
                  url: "https://projection.example.test",
                  app_deployment: {
                    name: "projection",
                    publish: [
                      {
                        name: "launcher",
                        type: "interface.ui.surface",
                        display: { title: "Projection" },
                      },
                    ],
                  },
                },
                createdAt: "2026-07-07T00:00:01.000Z",
              },
            ],
          } as unknown as Awaited<
            ReturnType<DeployControlOperations["listDeployments"]>
          >);
        },
      }),
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_projection",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(getCapsuleCalled).toEqual(true);
  expect(listDeploymentsCalled).toEqual(true);
  expect(body.installation.launch_url).toEqual(
    "https://projection.example.test",
  );
  expect(body.installation.launch.url).toEqual(
    "https://projection.example.test",
  );
  expect(body.installation.deployment_outputs).toEqual([
    {
      name: "url",
      kind: "url",
      value: "https://projection.example.test",
      sensitive: false,
    },
    {
      name: "app_deployment",
      kind: "app_deployment",
      value: {
        name: "projection",
        publish: [
          {
            name: "launcher",
            type: "interface.ui.surface",
            display: { title: "Projection" },
          },
        ],
      },
      sensitive: false,
    },
  ]);
});

test("accounts handler returns Capsule details when deployment projection stalls", async () => {
  const store = new InMemoryAccountsStore();
  const session = seedAccountSession(store, "tsub_projection_timeout_owner");
  seedOwnedWorkspace(
    store,
    "tsub_projection_timeout_owner",
    "acct_projection_timeout",
    "space_projection_timeout",
  );
  const now = Date.now();
  await store.saveAppCapsule({
    capsuleId: "inst_projection_timeout",
    accountId: "acct_projection_timeout",
    workspaceId: "space_projection_timeout",
    appId: "example.projection-timeout",
    sourceGitUrl: "https://github.com/example/projection-timeout.git",
    sourceRef: "main",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    planDigest: "sha256:projection-timeout",
    artifactDigest: "sha256:projection-timeout",
    mode: "self-hosted",
    status: "ready",
    createdBySubject: "tsub_projection_timeout_owner",
    createdAt: now,
    updatedAt: now,
  });
  let getCapsuleCalled = false;
  let listDeploymentsCalled = false;
  const handler = createAccountsHandler({
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getCapsule: (id) => {
          getCapsuleCalled = true;
          if (id !== "inst_projection_timeout") {
            throw new Error(`unexpected capsule id ${id}`);
          }
          return new Promise<GetCapsuleResponse>(() => {});
        },
        listDeployments: (id) => {
          listDeploymentsCalled = true;
          throw new Error(`unexpected deployments capsule id ${id}`);
        },
      }),
    },
  });

  const startedAt = Date.now();
  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_projection_timeout",
      { headers: accountSessionHeaders(session) },
    ),
  );

  expect(Date.now() - startedAt).toBeLessThan(2_500);
  expect(response.status).toEqual(200);
  expect(getCapsuleCalled).toEqual(true);
  expect(listDeploymentsCalled).toEqual(false);
  const body = await response.json();
  expect(body.installation.id).toEqual("inst_projection_timeout");
  expect(body.installation.launch_url).toEqual(null);
  expect(body.installation.deployment_outputs).toEqual([]);
});

test("accounts handler projects Capsule services from current deployment outputs", async () => {
  const store = new InMemoryAccountsStore();
  const session = seedAccountSession(store, "tsub_projection_services_owner");
  seedOwnedWorkspace(
    store,
    "tsub_projection_services_owner",
    "acct_projection_services",
    "space_projection_services",
  );
  const now = Date.now();
  await store.saveAppCapsule({
    capsuleId: "inst_projection_services",
    accountId: "acct_projection_services",
    workspaceId: "space_projection_services",
    appId: "example.projection-services",
    sourceGitUrl: "https://github.com/example/projection-services.git",
    sourceRef: "main",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    planDigest: "sha256:projection-services",
    artifactDigest: "sha256:projection-services",
    mode: "self-hosted",
    status: "ready",
    createdBySubject: "tsub_projection_services_owner",
    createdAt: now,
    updatedAt: now,
  });
  let getCapsuleCalled = false;
  let listDeploymentsCalled = false;
  const handler = createAccountsHandler({
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getCapsule: (id) => {
          getCapsuleCalled = true;
          if (id !== "inst_projection_services") {
            throw new Error(`unexpected capsule id ${id}`);
          }
          return Promise.resolve({
            capsule: {
              id: "inst_projection_services",
              workspaceId: "space_projection_services",
              name: "projection-services",
              slug: "projection-services",
              status: "active",
              environment: "production",
              installConfigId: "cfg_projection_services",
              currentStateVersionId: "dep_projection_services",
              currentStateGeneration: 1,
              createdAt: "2026-07-07T00:00:00.000Z",
              updatedAt: "2026-07-07T00:00:01.000Z",
            },
          } as unknown as GetCapsuleResponse);
        },
        listDeployments: (id) => {
          listDeploymentsCalled = true;
          if (id !== "inst_projection_services") {
            throw new Error(`unexpected deployments capsule id ${id}`);
          }
          return Promise.resolve({
            deployments: [
              {
                id: "dep_projection_services",
                capsuleId: "inst_projection_services",
                status: "active",
                outputsPublic: {
                  url: "https://projection-services.example.test",
                  service_exports: {
                    api: "https://projection-services.example.test/api",
                  },
                },
                createdAt: "2026-07-07T00:00:01.000Z",
              },
            ],
          } as unknown as Awaited<
            ReturnType<DeployControlOperations["listDeployments"]>
          >);
        },
      }),
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_projection_services/services",
      { headers: accountSessionHeaders(session) },
    ),
  );

  expect(response.status).toEqual(200);
  expect(getCapsuleCalled).toEqual(true);
  expect(listDeploymentsCalled).toEqual(true);
  const body = await response.json();
  expect(body.services).toContainEqual({
    id: "url",
    capability: "deployment.outputs",
    status: "ready",
    endpoint: "https://projection-services.example.test",
    secret_configured: false,
    token_expires_at: null,
  });
  expect(body.services).toContainEqual({
    id: "service_exports",
    capability: "deployment.outputs",
    status: "not_configured",
    endpoint: null,
    secret_configured: false,
    token_expires_at: null,
  });
});

test("accounts handler validates installation facade request before space deployControl apply", async () => {
  let dispatched = false;
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(
    store,
    "tsub_core_preflight",
    "acct_core_preflight",
    "space_core",
  );
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    deployControl: {
      // Any dispatch through the in-process facade flips the flag; the request
      // must be rejected (400) by request validation BEFORE the facade runs.
      operations: deployControlOperationsStub({
        getPlanRun: () => {
          dispatched = true;
          return Promise.reject(new Error("should not dispatch"));
        },
        createApplyRun: () => {
          dispatched = true;
          return Promise.reject(new Error("should not dispatch"));
        },
      }),
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_core_preflight",
        workspaceId: "space_core",
        source: {
          kind: "git",
          url: "https://github.com/example/hello",
          ref: "main",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_core_preflight",
        serviceBindings: [{ name: "database" }],
      }),
    }),
  );

  expect(response.status).toEqual(400);
  expect(dispatched).toEqual(false);
});

test("accounts handler applies local source through space deployControl with local expected guard", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(store, "tsub_core_local", "acct_core_local", "space_core");
  const getPlanRunCalls: string[] = [];
  const createApplyRunCalls: unknown[] = [];
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getPlanRun: (id) => {
          getPlanRunCalls.push(id);
          return Promise.resolve({
            planRun: {
              id: "plan_core_local",
              workspaceId: "space_core",
              source: {
                kind: "local",
                path: "/workspace/example-local",
              },
              operation: "create",
              runnerProfileId: "cloudflare-default",
              sourceDigest: "sha256:source-core-local",
              variablesDigest: "sha256:variables-core-local",
              policyDecisionDigest: "sha256:policy-core-local",
              planDigest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              planArtifact: {
                kind: "runner-local",
                ref: "runner-local://plan_core_local/tfplan",
                digest:
                  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
              sourceCommit: "working-tree",
              status: "succeeded",
              requiredProviders: [],
              policy: { status: "passed", reasons: [], checkedAt: 1 },
              createdAt: 1,
              updatedAt: 1,
              finishedAt: 1,
            },
          } as unknown as PlanRunResponse);
        },
        createApplyRun: (request) => {
          createApplyRunCalls.push(request);
          return Promise.resolve({
            installation: {
              id: "inst_core_local",
              workspaceId: "space_core",
              appId: "example.local",
              currentDeploymentId: "dep_core_local",
              status: "ready",
              createdAt: 1,
            },
            deployment: {
              id: "dep_core_local",
              capsuleId: "inst_core_local",
              source: {
                kind: "local",
                url: "/workspace/example-local",
              },
              sourceCommit: "working-tree",
              planDigest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              status: "succeeded",
              outputs: {},
              createdAt: 1,
            },
          } as unknown as ApplyRunResponse);
        },
      }),
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acct_core_local",
        workspaceId: "space_core",
        planRunId: "plan_core_local",
        planArtifactDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        expected: {
          planRunId: "plan_core_local",
          runnerProfileId: "cloudflare-default",
          sourceDigest: "sha256:source-core-local",
          variablesDigest: "sha256:variables-core-local",
          policyDecisionDigest: "sha256:policy-core-local",
          planDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          planArtifactDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sourceCommit: "working-tree",
        },
        source: {
          kind: "local",
          url: "/workspace/example-local",
          ref: "working-tree",
          commit: "working-tree",
          planDigest:
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
  expect(store.findAppCapsule("inst_core_local")?.sourceRef).toEqual("local");
  expect(store.findAppCapsule("inst_core_local")?.sourceCommit).toEqual(
    "working-tree",
  );
  expect(getPlanRunCalls).toEqual(["plan_core_local"]);
  expect(createApplyRunCalls.length).toEqual(1);
  expect((createApplyRunCalls[0] as { planRunId?: string }).planRunId).toEqual(
    "plan_core_local",
  );
});

test("raw accounts handler requires account bearer for installation PlanRun", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  seedOwnedWorkspace(
    store,
    "tsub_auth_owner",
    "acct_auth_dry_run",
    "space_auth",
  );
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
  let createPlanRunCount = 0;
  const handler = createRawAccountsHandler({
    issuer: testIssuer,
    platformAccess: testPlatformReadinessOpenAccess,
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        createPlanRun: (request) => {
          createPlanRunCount += 1;
          return Promise.resolve({
            planRun: {
              id: "plan_dashboard_apply",
              workspaceId: request.workspaceId,
              source: {
                kind: "git",
                url: "https://github.com/example/hello",
                ref: "main",
              },
              operation: "create",
              runnerProfileId: "cloudflare-default",
              sourceDigest: "sha256:source-dashboard-apply",
              variablesDigest: "sha256:variables-dashboard-apply",
              policyDecisionDigest: "sha256:policy-dashboard-apply",
              planDigest: "sha256:abc",
              planArtifact: {
                kind: "runner-local",
                ref: "runner-local://plan_dashboard_apply/tfplan",
                digest: "sha256:abc",
              },
              sourceCommit: "0123456789abcdef0123456789abcdef01234567",
              status: "succeeded",
              requiredProviders: [],
              policy: { status: "passed", reasons: [], checkedAt: 1 },
              createdAt: 1,
              updatedAt: 1,
              finishedAt: 1,
            },
          } as unknown as PlanRunResponse);
        },
      }),
    },
  });
  const body = JSON.stringify({
    workspaceId: "space_auth",
    source: {
      kind: "git",
      url: "https://github.com/example/hello",
      ref: "main",
    },
  });

  const unauthenticated = await handler(
    new Request(`${testIssuer}/v1/capsule-projections/plan-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  expect(unauthenticated.status).toEqual(401);

  const readPat = await handler(
    new Request(`${testIssuer}/v1/capsule-projections/plan-runs`, {
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
    new Request(`${testIssuer}/v1/capsule-projections/plan-runs`, {
      method: "POST",
      headers: {
        ...accountSessionHeaders(otherSession),
        "content-type": "application/json",
      },
      body,
    }),
  );
  expect(crossOwner.status).toEqual(404);
  expect((await crossOwner.json()).error.code).toEqual("space_not_found");

  const owner = await handler(
    new Request(`${testIssuer}/v1/capsule-projections/plan-runs`, {
      method: "POST",
      headers: {
        ...accountSessionHeaders(ownerSession),
        "content-type": "application/json",
      },
      body,
    }),
  );
  // 201: in-process create-PlanRun returns the canonical create status (the
  // shipped platform worker always injects the typed `operations` facade).
  expect(owner.status).toEqual(201);
  expect((await owner.json()).planDigest).toEqual("sha256:abc");
  expect(createPlanRunCount).toEqual(1);

  // New-user external prefill flow: a write-scoped owner can PlanRun a space
  // that does NOT exist yet (it is created later at install time with this
  // workspaceId). Previously this 404'd after `/install?git=...` sent cold visitors
  // through sign-in and into `/new`.
  const freshWorkspace = await handler(
    new Request(`${testIssuer}/v1/capsule-projections/plan-runs`, {
      method: "POST",
      headers: {
        ...accountSessionHeaders(ownerSession),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "space_not_created_yet",
        source: {
          kind: "git",
          url: "https://github.com/example/hello",
          ref: "main",
        },
      }),
    }),
  );
  expect(freshWorkspace.status).toEqual(201);
});

test("accounts handler does not launch-gate installation PlanRun when platform readiness access is closed", async () => {
  // PlanRun is generic-platform surface: the platform-readiness gate no longer
  // applies. An unauthenticated request proceeds to normal auth enforcement
  // (401), and the deploy-control facade is never reached without a session.
  let planRunCalled = false;
  const handler = createAccountsHandler({
    platformAccess: { status: "closed" },
    deployControl: {
      url: "http://takosumi.internal:8788",
      fetch: () => {
        planRunCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
    },
  });

  const rawPlanRunResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/plan-runs",
      {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "space_1",
          source: {
            kind: "git",
            url: "https://github.com/example/hello",
            ref: "v1.2.3",
          },
        }),
      },
    ),
  );

  expect(rawPlanRunResponse.status).toEqual(401);
  expect((await rawPlanRunResponse.json()).error).toEqual("invalid_token");
  expect(planRunCalled).toEqual(false);
});

test("accounts handler blocks open platform readiness policy without evidence metadata", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "open" },
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/materialize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    ),
  );

  expect(response.status).toEqual(503);
  expect((await response.json()).error.code).toEqual(
    "launch_readiness_not_complete",
  );
  expect(store.findAccount("tsub_owner")).toEqual(undefined);
});

test("accounts handler rejects weak open platform readiness policy metadata", async () => {
  for (const platformAccess of [
    {
      ...testPlatformReadinessOpenAccess,
      evidenceRef: "evidence://todo",
    },
    {
      ...testPlatformReadinessOpenAccess,
      approvalRef: testPlatformReadinessOpenAccess.evidenceRef,
    },
    {
      ...testPlatformReadinessOpenAccess,
      publicSummary:
        "P0 evidence and staged launch rehearsal passed for user@example.test.",
    },
    {
      ...testPlatformReadinessOpenAccess,
      publicSummary: "P0 evidence passed but launch scope is omitted entirely.",
    },
  ]) {
    const store = new InMemoryAccountsStore();
    const handler = createAccountsHandler({
      store,
      platformAccess,
      launchTokens: {
        pairwiseSubjectSecret: launchPairwiseSubjectSecret,
      },
    });

    const response = await handler(
      new Request(
        "https://accounts.example.test/v1/capsule-projections/inst_1/materialize",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );

    expect(response.status).toEqual(503);
    expect((await response.json()).error.code).toEqual(
      "launch_readiness_not_complete",
    );
    expect(store.findAccount("tsub_owner")).toEqual(undefined);
  }
});

test("raw accounts handler defaults platform readiness access to closed", async () => {
  const handler = createRawAccountsHandler({ issuer: testIssuer });

  // The platform readiness materialize surface defaults to the launch-gated
  // 503 when no policy is supplied.
  const response = await handler(
    new Request(`${testIssuer}/v1/capsule-projections/inst_1/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toEqual(503);
  const body = await response.json();
  expect(body.error.code).toEqual("launch_readiness_not_complete");
  expect(body.platform_access).toEqual("closed");

  // The generic platform (e.g. installation create) is NOT launch-gated even
  // with the default-closed policy: it proceeds to normal request validation
  // (an empty body is rejected for missing ownership fields, not launch-gated).
  const installResponse = await handler(
    new Request(`${testIssuer}/v1/capsule-projections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(installResponse.status).toEqual(400);
  expect((await installResponse.json()).error.code).toEqual("missing_field");
});

test("ephemeral accounts handler defaults platform readiness access to closed", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: testIssuer,
    allowEphemeralKeyOnHttpsIssuer: true,
  });
  const response = await handler(
    new Request(`${testIssuer}/v1/capsule-projections/inst_1/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );

  expect(response.status).toEqual(503);
  const body = await response.json();
  expect(body.error.code).toEqual("launch_readiness_not_complete");
  expect(body.platform_access).toEqual("closed");
});

test("accounts handler keeps documented closed-gate exceptions reachable", async () => {
  const handler = createAccountsHandler({
    platformAccess: { status: "closed" },
  });

  for (const [label, request] of [
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
      new Request(`${testIssuer}/v1/capsule-projections/inst_1`, {
        method: "DELETE",
      }),
    ],
    [
      "failed status completion",
      new Request(`${testIssuer}/v1/capsule-projections/inst_1/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed" }),
      }),
    ],
    [
      "exported status completion",
      new Request(`${testIssuer}/v1/capsule-projections/inst_1/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "exported" }),
      }),
    ],
    [
      "billing usage report",
      new Request(
        `${testIssuer}/v1/capsule-projections/inst_1/billing/usage-reports`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    ],
  ] as const) {
    const response = await handler(request);
    const body = await response.text();
    expect(body.includes("launch_readiness_not_complete")).toEqual(false);
  }
});

test("accounts reference operator distribution exposes Accounts and OIDC routes", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(store, "tsub_operator", "acct_operator", "space_operator");
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
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    jwks: {
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          kid: "operator-key",
          use: "sig",
          alg: "ES256",
          x: "x",
          y: "y",
        },
      ],
    },
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
});

test("accounts handler rejects installation PlanRun when deployControl is not configured", async () => {
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(store, "tsub_owner", "acct_space_1", "space_1");
  const sessionId = seedAccountSession(store, "tsub_owner");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/plan-runs",
      {
        method: "POST",
        headers: {
          ...accountSessionHeaders(sessionId),
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId: "space_1" }),
      },
    ),
  );

  expect(response.status).toEqual(503);
  const body = await response.json();
  expect(body.error.code).toEqual("feature_unavailable");
  expect(body.error.message).toEqual(
    "Capsule PlanRun is temporarily unavailable.",
  );
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
  expect(body.error.code).toEqual("feature_unavailable");
  expect(body.error.message).toEqual("Sign-in is temporarily unavailable.");
});

test("ephemeral accounts handler completes authorization code flow", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_e2e");
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    platformAccess: testPlatformReadinessOpenAccess,
    store,
    subject: "tsub_flow_seed",
    keyId: "test-key",
    clients: [
      {
        clientId: "takos-test",
        redirectUris: ["http://localhost:3000/callback"],
      },
    ],
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

  const noSessionResponse = await handler(new Request(authorizeUrl));
  expect(noSessionResponse.status).toEqual(302);
  const signInRedirect = new URL(
    noSessionResponse.headers.get("location") ?? "",
  );
  expect(signInRedirect.origin + signInRedirect.pathname).toEqual(
    "https://accounts.example.test/sign-in",
  );
  expect(signInRedirect.searchParams.get("return")).toEqual(
    `${authorizeUrl.pathname}${authorizeUrl.search}`,
  );

  const authorizeResponse = await handler(
    new Request(authorizeUrl, { headers: accountSessionHeaders(sessionId) }),
  );
  expect(authorizeResponse.status).toEqual(302);
  const redirect = new URL(authorizeResponse.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toEqual(
    "http://localhost:3000/callback",
  );
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
    platformAccess: testPlatformReadinessOpenAccess,
    clients: [
      {
        clientId: "takos-test",
        redirectUris: ["http://localhost:3000/callback"],
      },
    ],
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

test("non-OIDC account-plane errors use the canonical {error:{code,message,requestId}} envelope", async () => {
  const handler = createAccountsHandler();

  // A generic non-OIDC error path (unknown route -> 404) returns the canonical
  // envelope: error is an object with code, message, and requestId.
  const notFound = await handler(
    new Request("https://accounts.example.test/v1/does-not-exist"),
  );
  expect(notFound.status).toEqual(404);
  const body = (await notFound.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  expect(typeof body.error).toEqual("object");
  expect(body.error.code).toEqual("not_found");
  expect(typeof body.error.message).toEqual("string");
  expect(typeof body.error.requestId).toEqual("string");
  expect(body.error.requestId.length).toBeGreaterThan(0);

  // An inbound x-request-id (well-shaped UUID) is echoed into the envelope.
  const correlationId = "123e4567-e89b-42d3-a456-426614174000";
  const withCorrelation = await handler(
    new Request("https://accounts.example.test/v1/does-not-exist", {
      headers: { "x-request-id": correlationId },
    }),
  );
  const correlated = (await withCorrelation.json()) as {
    error: { requestId: string };
  };
  expect(correlated.error.requestId).toEqual(correlationId);
});

test("OIDC/OAuth errors keep the RFC 6749 {error,error_description} shape", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    platformAccess: testPlatformReadinessOpenAccess,
    clients: [
      {
        clientId: "takos-test",
        redirectUris: ["http://localhost:3000/callback"],
      },
    ],
  });

  // RFC 6749 authorize error: `error` is a bare string, NOT the canonical
  // {code,message,requestId} envelope.
  const authorizeUrl = new URL("https://accounts.example.test/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "takos-test");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:4000/callback",
  );
  const authorize = await handler(new Request(authorizeUrl));
  expect(authorize.status).toEqual(400);
  const authorizeBody = (await authorize.json()) as {
    error: unknown;
  };
  expect(typeof authorizeBody.error).toEqual("string");
  expect(authorizeBody.error).toEqual("invalid_request");

  // RFC 6749 token error: bare `error` string + `error_description`.
  const token = await handler(
    new Request("https://accounts.example.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    }),
  );
  const tokenBody = (await token.json()) as {
    error: unknown;
  };
  expect(typeof tokenBody.error).toEqual("string");
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
  expect(response.headers.get("www-authenticate")).toEqual(
    'Bearer error="invalid_token"',
  );
});

test("ephemeral accounts handler issues and accepts refresh tokens", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_refresh");
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    platformAccess: testPlatformReadinessOpenAccess,
    store,
    clients: [
      {
        clientId: "takos-test",
        redirectUris: ["http://localhost:3000/callback"],
      },
    ],
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

  const authorizeResponse = await handler(
    new Request(authorizeUrl, { headers: accountSessionHeaders(sessionId) }),
  );
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
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_refresh_concurrent");
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    platformAccess: testPlatformReadinessOpenAccess,
    store,
    clients: [
      {
        clientId: "takos-test",
        redirectUris: ["http://localhost:3000/callback"],
      },
    ],
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

  const authorizeResponse = await handler(
    new Request(authorizeUrl, { headers: accountSessionHeaders(sessionId) }),
  );
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
  store.saveLedgerAccount({
    accountId: "acct_pat_owner",
    legalOwnerSubject: "tsub_pat_owner",
    billingAccountId: "bill_pat_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveWorkspace({
    workspaceId: "space_pat_owner",
    accountId: "acct_pat_owner",
    kind: "personal",
    displayName: "PAT owner workspace",
    createdAt: now,
    updatedAt: now,
  });
  // Round 2: register a static OIDC client so /oauth/introspect can
  // authenticate the introspection request per RFC 7662 §2.1. The
  // degraded mode (no clients wired) is no longer available now
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
        workspace_id: "space_pat_owner",
      }),
    }),
  );
  expect(createResponse.status).toEqual(201);
  const createBody = await createResponse.json();
  expect(String(createBody.token).startsWith("takpat_")).toEqual(true);
  expect(createBody.token_record.subject).toEqual("tsub_pat_owner");
  expect(createBody.token_record.scopes).toEqual(["read", "write"]);
  expect(createBody.token_record.workspace_id).toEqual("space_pat_owner");

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
  expect(listBody.next_cursor).toEqual(null);
  expect(listBody.tokens[0].token).toEqual(undefined);
  expect(listBody.tokens[0].name).toEqual("CLI");
  expect(listBody.tokens[0].workspace_id).toEqual("space_pat_owner");

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
  expect(introspectBody.takosumi).toEqual({ space_id: "space_pat_owner" });

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

test("accounts handler can bind PATs to control-plane owned Workspaces when the accounts index is stale", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_pat_owner");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    controlPlaneOperations: billingCheckoutOperations("tsub_pat_owner"),
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/account/tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Managed compat proof",
        scopes: ["read", "write"],
        workspace_id: "space_control_plane_owned",
      }),
    }),
  );

  expect(createResponse.status).toEqual(201);
  const createBody = await createResponse.json();
  expect(String(createBody.token).startsWith("takpat_")).toEqual(true);
  expect(createBody.token_record.subject).toEqual("tsub_pat_owner");
  expect(createBody.token_record.workspace_id).toEqual(
    "space_control_plane_owned",
  );
});

test("accounts handler paginates personal access token metadata", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_pat_page_owner",
    email: "page-owner@example.test",
    displayName: "Page Owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_pat_page_owner",
    subject: "tsub_pat_page_owner",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const handler = createAccountsHandler({ store });
  for (const name of ["Key 1", "Key 2", "Key 3"]) {
    const createResponse = await handler(
      new Request("https://accounts.example.test/v1/account/tokens", {
        method: "POST",
        headers: {
          authorization: "Bearer sess_pat_page_owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, scopes: ["read"] }),
      }),
    );
    expect(createResponse.status).toEqual(201);
  }

  const firstPage = await handler(
    new Request("https://accounts.example.test/v1/account/tokens?limit=2", {
      headers: {
        authorization: "Bearer sess_pat_page_owner",
      },
    }),
  );
  expect(firstPage.status).toEqual(200);
  const firstBody = await firstPage.json();
  expect(firstBody.tokens.length).toEqual(2);
  expect(typeof firstBody.next_cursor).toEqual("string");
  expect(
    firstBody.tokens.map((token: { token?: string }) => token.token),
  ).toEqual([undefined, undefined]);

  const secondPage = await handler(
    new Request(
      `https://accounts.example.test/v1/account/tokens?limit=2&cursor=${encodeURIComponent(
        firstBody.next_cursor,
      )}`,
      {
        headers: {
          authorization: "Bearer sess_pat_page_owner",
        },
      },
    ),
  );
  expect(secondPage.status).toEqual(200);
  const secondBody = await secondPage.json();
  expect(secondBody.tokens.length).toEqual(1);
  expect(secondBody.next_cursor).toEqual(null);
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

test("accounts handler rotates an AI Gateway runtime service token for an owned Capsule projection", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    clients: [
      {
        clientId: "takosumi-cloud-extensions",
        redirectUris: ["https://app.takosumi.test/oauth/callback"],
        clientSecret: "client-secret",
      },
    ],
    runtimeServiceTokens: {
      introspectionClientId: "takosumi-cloud-extensions",
    },
  });
  const sessionId = seedAccountSession(store, "tsub_runtime_owner");
  seedOwnedWorkspace(
    store,
    "tsub_runtime_owner",
    "acct_runtime",
    "space_runtime",
  );
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_runtime",
    accountId: "acct_runtime",
    workspaceId: "space_runtime",
    appId: "example.runtime",
    sourceGitUrl: "https://github.com/example/runtime",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:runtime",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_runtime_owner",
    createdAt: now,
    updatedAt: now,
  });

  const response = await handler(
    new Request(
      `${testIssuer}${takosumiAccountsCapsuleServiceRotateTokenPath(
        "inst_runtime",
        TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
      )}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scopes: ["ai.models.read", "ai.chat", "ai.embeddings"],
          ttlSeconds: 900,
        }),
      },
    ),
  );

  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.token_type).toEqual("Bearer");
  expect(body.token).toStartWith("taksrv_");
  expect(body.scope).toEqual("ai.models.read ai.chat ai.embeddings");
  expect(body.service).toEqual({
    id: "takosumi.ai.gateway",
    status: "active",
    scopes: ["ai.models.read", "ai.chat", "ai.embeddings"],
  });

  const introspection = await handler(
    new Request(`${testIssuer}/oauth/introspect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: body.token,
        client_id: "takosumi-cloud-extensions",
        client_secret: "client-secret",
      }),
    }),
  );
  expect(introspection.status).toEqual(200);
  const introspectionBody = await introspection.json();
  expect(introspectionBody).toMatchObject({
    active: true,
    client_id: "takosumi-cloud-extensions",
    sub: "svc:takosumi.ai.gateway:inst_runtime",
    scope: "ai.models.read ai.chat ai.embeddings",
    takosumi: {
      installation_id: "inst_runtime",
      app_id: "example.runtime",
      space_id: "space_runtime",
      role: "runtime",
    },
  });
});

test("accounts handler rotates a Cloudflare Workers provider-compat runtime service token", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    clients: [
      {
        clientId: "takosumi-cloud-extensions",
        redirectUris: ["https://app.takosumi.test/oauth/callback"],
        clientSecret: "client-secret",
      },
    ],
    runtimeServiceTokens: {
      introspectionClientId: "takosumi-cloud-extensions",
    },
  });
  const sessionId = seedAccountSession(store, "tsub_runtime_owner");
  seedOwnedWorkspace(
    store,
    "tsub_runtime_owner",
    "acct_runtime",
    "space_runtime",
  );
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_runtime",
    accountId: "acct_runtime",
    workspaceId: "space_runtime",
    appId: "example.runtime",
    sourceGitUrl: "https://github.com/example/runtime",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:runtime",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_runtime_owner",
    createdAt: now,
    updatedAt: now,
  });

  const response = await handler(
    new Request(
      `${testIssuer}${takosumiAccountsCapsuleServiceRotateTokenPath(
        "inst_runtime",
        TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_PROVIDER_COMPAT_CLOUDFLARE_WORKERS,
      )}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scopes: [
            "provider.compat.cloudflare_workers.read",
            "provider.compat.cloudflare_workers.write",
          ],
          ttlSeconds: 900,
        }),
      },
    ),
  );

  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.token_type).toEqual("Bearer");
  expect(body.token).toStartWith("taksrv_");
  expect(body.scope).toEqual(
    "provider.compat.cloudflare_workers.read provider.compat.cloudflare_workers.write",
  );
  expect(body.service).toEqual({
    id: "takosumi.provider_compat.cloudflare_workers",
    status: "active",
    scopes: [
      "provider.compat.cloudflare_workers.read",
      "provider.compat.cloudflare_workers.write",
    ],
  });

  const introspection = await handler(
    new Request(`${testIssuer}/oauth/introspect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: body.token,
        client_id: "takosumi-cloud-extensions",
        client_secret: "client-secret",
      }),
    }),
  );
  expect(introspection.status).toEqual(200);
  const introspectionBody = await introspection.json();
  expect(introspectionBody).toMatchObject({
    active: true,
    client_id: "takosumi-cloud-extensions",
    sub: "svc:takosumi.provider_compat.cloudflare_workers:inst_runtime",
    scope:
      "provider.compat.cloudflare_workers.read provider.compat.cloudflare_workers.write",
    takosumi: {
      installation_id: "inst_runtime",
      app_id: "example.runtime",
      space_id: "space_runtime",
      role: "runtime",
    },
  });
});

test("accounts handler constrains AI Gateway runtime service token rotation", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_runtime_owner");
  seedOwnedWorkspace(
    store,
    "tsub_runtime_owner",
    "acct_runtime",
    "space_runtime",
  );
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_runtime",
    accountId: "acct_runtime",
    workspaceId: "space_runtime",
    appId: "example.runtime",
    sourceGitUrl: "https://github.com/example/runtime",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:runtime",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_runtime_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.savePersonalAccessToken("takpat_read_runtime", {
    tokenId: "pat_read_runtime",
    tokenPrefix: "takpat_read",
    subject: "tsub_runtime_owner",
    name: "read only",
    scopes: ["read"],
    createdAt: now,
  });
  const path = `${testIssuer}${takosumiAccountsCapsuleServiceRotateTokenPath(
    "inst_runtime",
    TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
  )}`;
  const configuredHandler = createAccountsHandler({
    store,
    runtimeServiceTokens: {
      introspectionClientId: "takosumi-cloud-extensions",
    },
  });
  const unconfiguredHandler = createAccountsHandler({ store });

  const readOnlyPat = await configuredHandler(
    new Request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer takpat_read_runtime",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["ai.chat"], ttlSeconds: 900 }),
    }),
  );
  expect(readOnlyPat.status).toEqual(403);

  const invalidScope = await configuredHandler(
    new Request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["admin"], ttlSeconds: 900 }),
    }),
  );
  expect(invalidScope.status).toEqual(400);

  const unconfigured = await unconfiguredHandler(
    new Request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["ai.chat"], ttlSeconds: 900 }),
    }),
  );
  expect(unconfigured.status).toEqual(503);

  const unknownService = await configuredHandler(
    new Request(
      `${testIssuer}${takosumiAccountsCapsuleServiceRotateTokenPath(
        "inst_runtime",
        "takosumi.storage.workspace",
      )}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scopes: ["ai.chat"], ttlSeconds: 900 }),
      },
    ),
  );
  expect(unknownService.status).toEqual(404);
});

test("accounts handler records privacy export requests for the signed-in account", async () => {
  const store = new InMemoryAccountsStore();
  const ownerSession = seedAccountSession(store, "tsub_privacy_owner");
  const otherSession = seedAccountSession(store, "tsub_privacy_other");
  const handler = createAccountsHandler({
    store,
    privacyOperationsToken: "privacy-ops-token",
  });

  const unauthenticatedResponse = await handler(
    new Request(
      `https://accounts.example.test${TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "export" }),
      },
    ),
  );
  expect(unauthenticatedResponse.status).toEqual(401);

  const createResponse = await handler(
    new Request(
      `https://accounts.example.test${TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH}`,
      {
        method: "POST",
        headers: {
          ...accountSessionHeaders(ownerSession),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "export",
          request_summary: "staging export rehearsal",
        }),
      },
    ),
  );
  expect(createResponse.status).toEqual(201);
  const created = await createResponse.json();
  expect(String(created.request.request_id).startsWith("prq_")).toEqual(true);
  expect(created.request.subject).toEqual("tsub_privacy_owner");
  expect(created.request.kind).toEqual("export");
  expect(created.request.status).toEqual("received");
  expect(created.request.request_summary).toEqual("staging export rehearsal");
  expect(
    String(created.request.retention_record_id).startsWith(
      "ret_tsub_privacy_owner_",
    ),
  ).toEqual(true);

  const requestId = created.request.request_id as string;

  const listResponse = await handler(
    new Request(
      `https://accounts.example.test${TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH}`,
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(listResponse.status).toEqual(200);
  const listBody = await listResponse.json();
  expect(
    listBody.requests.map(
      (request: { request_id: string }) => request.request_id,
    ),
  ).toEqual([requestId]);

  const otherReadResponse = await handler(
    new Request(
      `https://accounts.example.test${takosumiAccountsPrivacyRequestPath(
        requestId,
      )}`,
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(otherReadResponse.status).toEqual(404);

  const invalidCompleteResponse = await handler(
    new Request(
      `https://accounts.example.test${takosumiAccountsPrivacyRequestCompletePath(
        requestId,
      )}`,
      {
        method: "POST",
        headers: {
          [TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER]: "privacy-ops-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "login_disabled" }),
      },
    ),
  );
  expect(invalidCompleteResponse.status).toEqual(400);

  const customerCompleteResponse = await handler(
    new Request(
      `https://accounts.example.test${takosumiAccountsPrivacyRequestCompletePath(
        requestId,
      )}`,
      {
        method: "POST",
        headers: {
          ...accountSessionHeaders(ownerSession),
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "exported" }),
      },
    ),
  );
  expect(customerCompleteResponse.status).toEqual(401);

  const completeResponse = await handler(
    new Request(
      `https://accounts.example.test${takosumiAccountsPrivacyRequestCompletePath(
        requestId,
      )}`,
      {
        method: "POST",
        headers: {
          [TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER]: "privacy-ops-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "exported",
          export_ref: "run://exports/privacy-rehearsal",
        }),
      },
    ),
  );
  expect(completeResponse.status).toEqual(200);
  const completed = await completeResponse.json();
  expect(completed.request.status).toEqual("exported");
  expect(completed.request.export_ref).toEqual(
    "run://exports/privacy-rehearsal",
  );
  expect(typeof completed.request.completed_at).toEqual("string");
});

test("accounts handler records privacy deletion requests with delete statuses", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_privacy_delete");
  const handler = createAccountsHandler({
    store,
    privacyOperationsToken: "privacy-ops-token",
  });

  const createResponse = await handler(
    new Request(
      `https://accounts.example.test${TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH}`,
      {
        method: "POST",
        headers: {
          ...accountSessionHeaders(sessionId),
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "delete" }),
      },
    ),
  );
  expect(createResponse.status).toEqual(201);
  const created = await createResponse.json();

  const invalidCompleteResponse = await handler(
    new Request(
      `https://accounts.example.test${takosumiAccountsPrivacyRequestCompletePath(
        created.request.request_id,
      )}`,
      {
        method: "POST",
        headers: {
          [TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER]: "privacy-ops-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "exported" }),
      },
    ),
  );
  expect(invalidCompleteResponse.status).toEqual(400);

  const completeResponse = await handler(
    new Request(
      `https://accounts.example.test${takosumiAccountsPrivacyRequestCompletePath(
        created.request.request_id,
      )}`,
      {
        method: "POST",
        headers: {
          [TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER]: "privacy-ops-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "login_disabled" }),
      },
    ),
  );
  expect(completeResponse.status).toEqual(200);
  expect((await completeResponse.json()).request.status).toEqual(
    "login_disabled",
  );
});

test("ephemeral accounts handler verifies PKCE S256 challenges", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_pkce");
  const handler = await createEphemeralAccountsHandler({
    issuer: "https://accounts.example.test",
    allowEphemeralKeyOnHttpsIssuer: true,
    platformAccess: testPlatformReadinessOpenAccess,
    store,
    clients: [
      {
        clientId: "takos-test",
        redirectUris: ["http://localhost:3000/callback"],
      },
    ],
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

  const authorizeResponse = await handler(
    new Request(authorizeUrl, { headers: accountSessionHeaders(sessionId) }),
  );
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

  const secondAuthorizeResponse = await handler(
    new Request(authorizeUrl, { headers: accountSessionHeaders(sessionId) }),
  );
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
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-1",
    ),
  );

  expect(response.status).toEqual(302);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toEqual(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(redirect.searchParams.get("client_id")).toEqual("google-client");
  const serverState = upstreamStateFromAuthorizeResponse(response);
  expect(serverState).not.toEqual("state-1");
  expect(response.headers.get("set-cookie") ?? "").toContain(
    encodeURIComponent(`google:${serverState}`),
  );
  expect(redirect.searchParams.get("redirect_uri")).toEqual(
    "https://accounts.example.test/v1/auth/upstream/callback",
  );
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
      providers: [
        {
          providerId: "keycloak",
          clientId: "keycloak-client",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
          provider,
        },
      ],
    },
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=keycloak&state=state-oidc",
    ),
  );

  expect(response.status).toEqual(302);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toEqual(
    "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
  );
  expect(redirect.searchParams.get("client_id")).toEqual("keycloak-client");
  const serverState = upstreamStateFromAuthorizeResponse(response);
  expect(serverState).not.toEqual("state-oidc");
  expect(response.headers.get("set-cookie") ?? "").toContain(
    encodeURIComponent(`keycloak:${serverState}`),
  );
});

test("accounts handler rejects retired custom upstream OIDC GitHub provider ids", async () => {
  const provider = customOidcOAuthProvider({
    id: "github",
    issuer: "https://github.com/login/oauth",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userInfoEndpoint: "https://api.github.com/user",
  });
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      providers: [
        {
          providerId: "github",
          clientId: "github-client",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
          provider,
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=github&state=state-github",
    ),
  );
  const callbackResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=github&code=code-github&state=state-github",
      {
        headers: {
          cookie: `takosumi_oauth_state=${encodeURIComponent("github:state-github")}`,
        },
      },
    ),
  );

  expect(authorizeResponse.status).toEqual(400);
  expect((await authorizeResponse.json()).error).toEqual("unknown_provider");
  expect(callbackResponse.status).toEqual(400);
  expect((await callbackResponse.json()).error).toEqual("unknown_provider");
});

test("accounts handler rejects custom upstream provider ids without provider objects", async () => {
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      providers: [
        {
          providerId: "keycloak",
          clientId: "keycloak-client",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
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
    if (request.url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("code")).toEqual("code-1");
      expect(body.get("client_id")).toEqual("google-client");
      expect(body.get("client_secret")).toEqual("google-secret");
      return Response.json({ access_token: "google-token" });
    }
    if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
      expect(request.headers.get("authorization")).toEqual(
        "Bearer google-token",
      );
      return Response.json({
        sub: "google-subject-123",
        name: "Google User",
        email: "google.user@example.test",
        email_verified: true,
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
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "http://accounts.internal/v1/auth/upstream/authorize?provider=google&state=state-google",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  expect(authorizeResponse.headers.get("set-cookie") ?? "").toContain("Secure");
  const response = await handler(
    new Request(
      `http://accounts.internal/v1/auth/upstream/callback?provider=google&code=code-1&state=${serverState}`,
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
  expect(body.provider_id).toEqual("google");
  // Agent 6 item 6: session_id must NOT be returned in the JSON body; the
  // server delivers it via an HttpOnly cookie. Extract the cookie from
  // the response's Set-Cookie headers and verify the persisted session
  // matches the subject.
  expect(body.session_id).toEqual(undefined);
  expect(store.findAccount(body.subject)?.email).toEqual(
    "google.user@example.test",
  );
  const sessionCookie = extractSessionCookieForTest(response);
  expect(typeof sessionCookie).toEqual("string");
  expect(response.headers.get("set-cookie") ?? "").toContain("Secure");
  expect(store.findAccountSession(sessionCookie!)?.subject).toEqual(
    body.subject,
  );
});

test("accounts handler rejects upstream OAuth login outside the pre-GA email allowlist", async () => {
  const store = new InMemoryAccountsStore();
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "google-token" });
    }
    if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({
        sub: "google-subject-123",
        name: "Google User",
        email: "someone-else@example.test",
        email_verified: true,
      });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const handler = createAccountsHandler({
    store,
    loginEmailAllowlist: { emails: ["shoutatomiyama0614@gmail.com"] },
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      sessionTtlMs: 60_000,
      fetch: fetchImpl,
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-google",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  const response = await handler(
    new Request(
      `https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1&state=${serverState}`,
      {
        headers: { cookie: authorizeResponse.headers.get("set-cookie") ?? "" },
      },
    ),
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error).toEqual("access_denied");
  expect(store.findAccountByVerifiedEmail("someone-else@example.test")).toEqual(
    undefined,
  );
  expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
});

test("accounts handler accepts the pre-GA email allowlist only when Google verifies the address", async () => {
  const store = new InMemoryAccountsStore();
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "google-token" });
    }
    if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({
        sub: "google-subject-allowed",
        name: "Allowed User",
        email: "SHOUTATOMIYAMA0614@gmail.com",
        email_verified: true,
      });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const handler = createAccountsHandler({
    store,
    loginEmailAllowlist: { emails: ["shoutatomiyama0614@gmail.com"] },
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      sessionTtlMs: 60_000,
      fetch: fetchImpl,
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-google",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  const response = await handler(
    new Request(
      `https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1&state=${serverState}`,
      {
        headers: { cookie: authorizeResponse.headers.get("set-cookie") ?? "" },
      },
    ),
  );

  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(store.findAccount(body.subject)?.email).toEqual(
    "SHOUTATOMIYAMA0614@gmail.com",
  );
  const sessionCookie = extractSessionCookieForTest(response);
  expect(typeof sessionCookie).toEqual("string");
  expect(store.findAccountSession(sessionCookie!)?.subject).toEqual(
    body.subject,
  );
});

test("accounts handler rejects allowlisted upstream OAuth emails when Google does not verify them", async () => {
  const store = new InMemoryAccountsStore();
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "google-token" });
    }
    if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({
        sub: "google-subject-unverified",
        name: "Unverified User",
        email: "shoutatomiyama0614@gmail.com",
        email_verified: false,
      });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const handler = createAccountsHandler({
    store,
    loginEmailAllowlist: { emails: ["shoutatomiyama0614@gmail.com"] },
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      sessionTtlMs: 60_000,
      fetch: fetchImpl,
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-google",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  const response = await handler(
    new Request(
      `https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1&state=${serverState}`,
      {
        headers: { cookie: authorizeResponse.headers.get("set-cookie") ?? "" },
      },
    ),
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error).toEqual("access_denied");
  expect(
    store.findAccountByVerifiedEmail("shoutatomiyama0614@gmail.com"),
  ).toEqual(undefined);
  expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
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

function upstreamStateFromAuthorizeResponse(response: Response): string {
  const location = response.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThan(20);
  return state;
}

test("accounts handler rejects upstream OAuth callback state mismatches", async () => {
  let upstreamFetchCalled = false;
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      fetch: () => {
        upstreamFetchCalled = true;
        return Promise.resolve(Response.json({ access_token: "google-token" }));
      },
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });
  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-owner",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  const stateCookie = authorizeResponse.headers.get("set-cookie") ?? "";
  expect(serverState).not.toEqual("state-owner");
  expect(stateCookie).toContain(encodeURIComponent(`google:${serverState}`));

  const mismatchResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1&state=state-attacker",
      { headers: { cookie: stateCookie } },
    ),
  );
  expect(mismatchResponse.status).toEqual(400);
  expect((await mismatchResponse.json()).error).toEqual("invalid_state");
  expect(upstreamFetchCalled).toEqual(false);

  const missingCookieResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1&state=${serverState}`,
    ),
  );
  expect(missingCookieResponse.status).toEqual(400);
  expect((await missingCookieResponse.json()).error).toEqual("invalid_state");
  expect(upstreamFetchCalled).toEqual(false);

  const missingStateResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1",
      { headers: { cookie: stateCookie } },
    ),
  );
  expect(missingStateResponse.status).toEqual(400);
  expect((await missingStateResponse.json()).error).toEqual("invalid_state");
  expect(upstreamFetchCalled).toEqual(false);
});

test("accounts handler does not leak upstream failure detail on a failed OAuth callback", async () => {
  // A thrown exchange error can carry the upstream token/userinfo endpoint, a
  // failed status line, or an internal host/IP from a network failure. The
  // (unauthenticated) callback must reflect only the typed code + a generic
  // description, never the thrown message.
  const secretDetail =
    "token exchange failed: connect ECONNREFUSED 10.0.0.7:443 oauth-internal.example";
  const handler = createAccountsHandler({
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      fetch: () => Promise.reject(new Error(secretDetail)),
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });
  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-fail",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  const stateCookie = authorizeResponse.headers.get("set-cookie") ?? "";
  expect(stateCookie).toContain(encodeURIComponent(`google:${serverState}`));

  const response = await handler(
    new Request(
      `https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1&state=${serverState}`,
      { headers: { cookie: stateCookie } },
    ),
  );
  expect(response.status).toEqual(502);
  const text = await response.text();
  expect(JSON.parse(text).error).toEqual("upstream_oauth_failed");
  expect(text).not.toContain(secretDetail);
  expect(text).not.toContain("10.0.0.7");
  expect(text).not.toContain("oauth-internal.example");
});

test("accounts handler does not launch-gate upstream OAuth authorize and callback when platform readiness access is closed", async () => {
  // Upstream OAuth is generic sign-in surface, not a platform-readiness surface:
  // the launch gate no longer applies. Authorize issues the provider redirect
  // and callback proceeds to normal state validation (400 without a state
  // cookie); neither leaks a launch_readiness_not_complete response.
  let upstreamFetchCalled = false;
  const handler = createAccountsHandler({
    platformAccess: { status: "closed" },
    upstreamOAuth: {
      subjectSecret: "subject-secret",
      fetch: () => {
        upstreamFetchCalled = true;
        return Promise.resolve(Response.json({ unexpected: true }));
      },
      providers: [
        {
          providerId: "google",
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=google&state=state-1",
    ),
  );
  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/callback?provider=google&code=code-1",
    ),
  );

  expect(authorizeResponse.status).toEqual(302);
  expect(authorizeResponse.headers.get("location") ?? "").toContain(
    "accounts.google.com",
  );
  expect(response.status).toEqual(400);
  expect((await response.json()).error).toEqual("invalid_state");
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
      expect(request.headers.get("authorization")).toEqual(
        "Bearer keycloak-token",
      );
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
      providers: [
        {
          providerId: "keycloak",
          clientId: "keycloak-client",
          clientSecret: "keycloak-secret",
          redirectUri:
            "https://accounts.example.test/v1/auth/upstream/callback",
          provider,
        },
      ],
    },
  });

  const authorizeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/upstream/authorize?provider=keycloak&state=state-keycloak",
    ),
  );
  const serverState = upstreamStateFromAuthorizeResponse(authorizeResponse);
  const response = await handler(
    new Request(
      `https://accounts.example.test/v1/auth/upstream/callback?provider=keycloak&code=code-oidc&state=${serverState}`,
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
  expect(store.findAccount(body.subject)?.email).toEqual(
    "keycloak@example.test",
  );
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
  expect(store.findPasskeyCredential("credential-1")?.subject).toEqual(
    "tsub_account",
  );

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
  expect(authenticationOptions.allowCredentials).toEqual([
    {
      id: "credential-1",
      type: "public-key",
    },
  ]);
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
      "http://accounts.internal/v1/auth/passkeys/authenticate/complete",
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
  expect(authenticationResponse.headers.get("set-cookie") ?? "").toContain(
    "Secure",
  );
  expect(store.findAccountSession(passkeySessionCookie!)?.subject).toEqual(
    "tsub_account",
  );
  expect(store.findPasskeyCredential("credential-1")?.signCount).toEqual(1);
});

test("accounts handler rejects passkey authentication outside the pre-GA email allowlist", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_blocked",
    email: "blocked@example.test",
    emailVerified: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  const enrolled = await createSignedAssertion({
    challenge: "ignored-during-seed",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 0,
  });
  store.savePasskeyCredential({
    credentialId: "credential-blocked",
    subject: "tsub_blocked",
    publicKeyJwk: enrolled.publicKeyJwk,
    signCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
  });
  const handler = createAccountsHandler({
    store,
    loginEmailAllowlist: { emails: ["shoutatomiyama0614@gmail.com"] },
    passkeys: {
      rpId: "accounts.example.test",
      rpName: "Takosumi Accounts",
      origin: "https://accounts.example.test",
      sessionTtlMs: 60_000,
    },
  });

  const authenticationOptionsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/authenticate/options",
      {
        method: "POST",
        body: JSON.stringify({ subject: "tsub_blocked" }),
      },
    ),
  );
  expect(authenticationOptionsResponse.status).toEqual(200);
  const authenticationOptions = await authenticationOptionsResponse.json();
  const serverAuthChallenge = authenticationOptions.challenge as string;
  const assertion = await createSignedAssertionWithKey({
    challenge: serverAuthChallenge,
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 1,
    keyPair: enrolled.keyPair,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/auth/passkeys/authenticate/complete",
      {
        method: "POST",
        body: JSON.stringify({
          credentialId: "credential-blocked",
          expectedChallenge: serverAuthChallenge,
          authenticatorData: base64UrlEncodeBytes(assertion.authenticatorData),
          clientDataJSON: base64UrlEncodeBytes(assertion.clientDataJSON),
          signature: base64UrlEncodeBytes(assertion.signature),
        }),
      },
    ),
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error.code).toEqual("login_not_allowed");
  expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
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
  expect((await missingFields.json()).error.code).toEqual("invalid_request");
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
  expect((await challengeOnly.json()).error.code).toEqual("invalid_request");
  expect(store.findPasskeyCredential("attacker-key")).toEqual(undefined);
});

test("accounts handler does not launch-gate passkey flows when platform readiness access is closed", async () => {
  // Passkeys are generic sign-in surface, not a platform-readiness surface: the
  // launch gate no longer applies. Each route proceeds to its normal
  // auth/validation behavior instead of returning launch_readiness_not_complete,
  // and no credential is persisted from these unauthenticated probes.
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
    passkeys: {
      rpId: "accounts.example.test",
      rpName: "Takosumi Accounts",
      origin: "https://accounts.example.test",
      sessionTtlMs: 60_000,
    },
  });

  const cases: { request: Request; status: number }[] = [
    {
      // Seeded account => registration options are issued normally.
      request: new Request(
        "https://accounts.example.test/v1/auth/passkeys/register/options",
        {
          method: "POST",
          body: JSON.stringify({
            subject: "tsub_account",
            challenge: "register-challenge",
          }),
        },
      ),
      status: 200,
    },
    {
      // Registration completion still requires a session => 401, not 503.
      request: new Request(
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
      status: 401,
    },
    {
      request: new Request(
        "https://accounts.example.test/v1/auth/passkeys/authenticate/options",
        {
          method: "POST",
          body: JSON.stringify({
            subject: "tsub_account",
            challenge: "challenge-1",
          }),
        },
      ),
      status: 200,
    },
    {
      // No registered credential => normal authentication validation (400).
      request: new Request(
        "https://accounts.example.test/v1/auth/passkeys/authenticate/complete",
        {
          method: "POST",
          body: JSON.stringify({ credentialId: "credential-1" }),
        },
      ),
      status: 400,
    },
  ];

  for (const { request, status } of cases) {
    const response = await handler(request);
    expect(response.status).toEqual(status);
    const body = await response.text();
    expect(body.includes("launch_readiness_not_complete")).toEqual(false);
  }
  expect(store.findPasskeyCredential("credential-1")).toEqual(undefined);
});

test("accounts handler manages AppCapsule lifecycle records", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const permissionDigest = await testPermissionDigest({
    serviceBindingKinds: ["identity.oidc", "auth.bootstrap_token"],
    serviceGrants: ["deploy.intent.write"],
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_1",
        accountId: "acct_1",
        workspaceId: "space_1",
        spaceKind: "personal",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        runtimeTarget: {
          runtimeTargetId: "rtb_1",
          targetType: "shared-cell",
          targetId: "tokyo-cell-01",
        },
        serviceBindings: [
          {
            serviceBindingId: "bind_auth",
            name: "auth",
            kind: "identity.oidc",
            configRef: "config://inst_1/auth",
          },
          {
            serviceBindingId: "bind_bootstrap",
            name: "bootstrap",
            kind: "auth.bootstrap_token",
            configRef: "config://inst_1/bootstrap",
          },
        ],
        oidcClients: [
          {
            namespacePath: "takosumi.identity.oidc",
            issuerUrl: "https://accounts.example.test",
            redirectUris: ["http://localhost:8787/auth/oidc/callback"],
            allowedScopes: ["openid", "profile"],
            subjectMode: "pairwise",
            tokenEndpointAuthMethod: "none",
          },
        ],
        serviceGrants: [
          {
            serviceGrantId: "grant_deploy",
            capability: "deploy.intent.write",
            scope: {
              pathPrefix: "deployments/",
              apiKey: "sk-raw-grant-scope",
              authorization: "Bearer raw-grant-scope-token",
              databaseUrl: "postgres://user:rawpass@db.example/takos",
            },
          },
        ],
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
  expect(createResponse.headers.get("location")).toEqual(
    "/v1/capsule-projections/inst_1",
  );
  const created = await createResponse.json();
  expect(created.installation.status).toEqual("installing");
  expect(created.oidc_client.namespacePath).toEqual("takosumi.identity.oidc");
  expect(created.oidc_client.allowed_scopes).toEqual(["openid", "profile"]);
  expect(created.oidc_client.token_endpoint_auth_method).toEqual("none");
  expect("oidc_client_secret" in created).toEqual(false);
  // Wave 6 (Phase E SQL drift fix): `service_bindings` / `service_grants` /
  // `runtime_target` were removed from the installation envelope. The
  // underlying in-memory ledger still tracks them so existing
  // materialize / launch token logic continues to function; we assert
  // ledger state directly instead of envelope fields.
  expect(store.findLedgerAccount("acct_1")?.legalOwnerSubject).toEqual(
    "tsub_owner",
  );
  expect(store.listServiceBindingMaterialsForCapsule("inst_1").length).toEqual(
    2,
  );
  expect(store.findOidcClientForCapsule("inst_1")?.issuerUrl).toEqual(
    "https://accounts.example.test",
  );
  const storedAuthBinding = store
    .listServiceBindingMaterialsForCapsule("inst_1")
    .find((binding) => binding.name === "auth");
  expect(storedAuthBinding?.configRef ?? "").toContain(
    "takosumi-accounts://installations/inst_1/service-bindings/auth/oidc-client/",
  );
  expect(storedAuthBinding?.secretRefs).toEqual([]);
  expect(
    store.listCapsuleEvents("inst_1").map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "installation.approved",
    "oidc_client.registered",
    "service_binding.materialized",
  ]);
  const ownerSession = seedAccountSession(store, "tsub_owner");
  const initialEventsResponse = await handler(
    new Request(`${testIssuer}${takosumiAccountsCapsuleEventsPath("inst_1")}`, {
      headers: accountSessionHeaders(ownerSession),
    }),
  );
  expect(initialEventsResponse.status).toEqual(200);
  const initialEventsText = JSON.stringify(await initialEventsResponse.json());
  expect(initialEventsText).not.toContain("secretRefs");
  expect(initialEventsText).not.toContain("secret_refs");
  expect(initialEventsText).not.toContain("client-secret");
  expect(initialEventsText).not.toContain("secret://");

  const updateResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready", reason: "healthcheck passed" }),
      },
    ),
  );
  expect(updateResponse.status).toEqual(200);
  expect((await updateResponse.json()).installation.status).toEqual("ready");

  const inspectResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections/inst_1", {
      headers: accountSessionHeaders(ownerSession),
    }),
  );
  expect(inspectResponse.status).toEqual(200);
  const inspected = await inspectResponse.json();
  expect(inspected.installation.id).toEqual("inst_1");
  // Wave 6 (Phase E SQL drift fix): `inspected.runtime_target` and
  // `inspected.service_grants` were removed from the envelope. Runtime
  // binding remains local orchestration state, while ServiceGrantMaterial persistence is
  // intentionally a no-op across all stores.
  expect(
    store.findRuntimeBinding(
      store.findAppCapsule("inst_1")?.runtimeBindingId ?? "",
    )?.targetId,
  ).toEqual("tokyo-cell-01");
  expect(store.listServiceGrantMaterialsForCapsule("inst_1")).toEqual([]);

  const eventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/events",
    ),
  );
  expect(eventsResponse.status).toEqual(200);
  const eventsBody = await eventsResponse.json();
  expect(eventsBody.hash_chain_valid).toEqual(true);
  expect(
    eventsBody.events.map((event: { type: string }) => event.type),
  ).toEqual([
    "installation.created",
    "installation.approved",
    "oidc_client.registered",
    "service_binding.materialized",
    "installation.status_changed",
  ]);
});

test("accounts handler validates install approval confirmation", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const permissionDigest = await testPermissionDigest({
    serviceBindingKinds: ["storage.sql"],
    serviceGrants: ["logs.read.own"],
  });

  const costResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_confirm_cost",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "example.db",
        source: {
          gitUrl: "https://github.com/example/db",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "database",
            kind: "storage.sql",
            configRef: "config://inst_confirm_cost/database",
          },
        ],
        serviceGrants: [{ capability: "logs.read.own", scope: {} }],
        confirm: {
          permissionDigest,
          costAck: false,
        },
      }),
    }),
  );
  expect(costResponse.status).toEqual(400);
  expect((await costResponse.json()).error.code).toEqual("cost_ack_required");

  const mismatchResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_confirm_mismatch",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "example.db",
        source: {
          gitUrl: "https://github.com/example/db",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "database",
            kind: "storage.sql",
            configRef: "config://inst_confirm_mismatch/database",
          },
        ],
        serviceGrants: [{ capability: "logs.read.own", scope: {} }],
        confirm: {
          permissionDigest:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          costAck: true,
        },
      }),
    }),
  );
  expect(mismatchResponse.status).toEqual(409);
  expect((await mismatchResponse.json()).error.code).toEqual(
    "approval_digest_mismatch",
  );
});

test("accounts handler requires account-session ownership for installation reads", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_tenant_read",
        accountId: "acct_tenant_read",
        workspaceId: "space_tenant_read",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_tenant_read",
    ),
  );
  expect(unauthenticated.status).toEqual(401);

  const ownerDetail = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_tenant_read",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(ownerDetail.status).toEqual(200);

  const crossDetail = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_tenant_read",
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(crossDetail.status).toEqual(404);
  expect((await crossDetail.json()).error.code).toEqual(
    "installation_not_found",
  );

  const ownerList = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections?space_id=space_tenant_read",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(ownerList.status).toEqual(200);
  expect((await ownerList.json()).installations.length).toEqual(1);

  const crossList = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections?space_id=space_tenant_read",
      { headers: accountSessionHeaders(otherSession) },
    ),
  );
  expect(crossList.status).toEqual(404);
  expect((await crossList.json()).error.code).toEqual("installation_not_found");
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
    platformAccess: testPlatformReadinessOpenAccess,
    store,
  });
  const createBody = {
    capsuleId: "inst_auth_write",
    accountId: "acct_auth_write",
    workspaceId: "space_auth_write",
    appId: "takos.chat",
    source: {
      gitUrl: "https://github.com/takos/takos",
      ref: "v1.2.3",
      commit: "abc123",
      planDigest: "sha256:app",
    },
    mode: "shared-cell",
    createdBySubject: "tsub_auth_owner",
  };

  const unauthenticatedCreate = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify(createBody),
    }),
  );
  expect(unauthenticatedCreate.status).toEqual(401);

  const crossCreate = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      headers: accountSessionHeaders(otherSession),
      body: JSON.stringify(createBody),
    }),
  );
  expect(crossCreate.status).toEqual(404);
  expect((await crossCreate.json()).error.code).toEqual("account_not_found");

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      headers: accountSessionHeaders(ownerSession),
      body: JSON.stringify(createBody),
    }),
  );
  expect(createResponse.status).toEqual(503);
  expect((await createResponse.json()).error.code).toEqual(
    "deploy_control_required",
  );

  const seeded = await maybeSeedLegacyProjectionFixtureForTest({
    request: new Request(
      "https://accounts.example.test/v1/capsule-projections",
      {
        method: "POST",
        body: JSON.stringify(createBody),
      },
    ),
    store,
    options: { store },
  });
  expect(seeded?.status).toEqual(202);

  const unauthenticatedStatus = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_auth_write/status",
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
      "https://accounts.example.test/v1/capsule-projections/inst_auth_write/status",
      {
        method: "PATCH",
        headers: { authorization: "Bearer takpat_read_auth" },
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(readPatStatus.status).toEqual(403);
  expect((await readPatStatus.json()).error.code).toEqual("insufficient_scope");

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
      "https://accounts.example.test/v1/capsule-projections/inst_auth_write/status",
      {
        method: "PATCH",
        headers: { authorization: "Bearer takpat_write_auth" },
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(writePatStatus.status).toEqual(200);
  expect(
    typeof store.findPersonalAccessToken("takpat_write_auth")?.lastUsedAt,
  ).toEqual("number");

  const crossStatus = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_auth_write/status",
      {
        method: "PATCH",
        headers: accountSessionHeaders(otherSession),
        body: JSON.stringify({ status: "suspended" }),
      },
    ),
  );
  expect(crossStatus.status).toEqual(404);
  expect((await crossStatus.json()).error.code).toEqual(
    "installation_not_found",
  );

  const unauthenticatedEvents = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_auth_write/events",
    ),
  );
  expect(unauthenticatedEvents.status).toEqual(401);

  const readPatEvents = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_auth_write/events",
      { headers: { authorization: "Bearer takpat_read_auth" } },
    ),
  );
  expect(readPatEvents.status).toEqual(200);
});

test("accounts handler rejects removed serviceId aliases in install OIDC client requests", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_oidc_alias_create",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        oidcClients: [
          {
            serviceId: "takosumi.identity.oidc",
            redirectUris: ["http://localhost:8787/auth/oidc/callback"],
          },
        ],
      }),
    }),
  );
  const body = await response.json();

  expect(response.status).toEqual(400);
  expect(body.error.code).toEqual("invalid_oidc_clients");
  expect(body.error.message).toEqual(
    "oidcClients entries use servicePath; serviceId/service_id are not accepted",
  );
  expect(store.findAppCapsule("inst_oidc_alias_create")).toEqual(undefined);
});

test("accounts handler creates Stripe Checkout Sessions without exposing price ids", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_billing_checkout");
  seedOwnedWorkspace(
    store,
    "tsub_billing_checkout",
    "acct_billing",
    "space_billing",
  );
  const stripeRequests: URLSearchParams[] = [];
  const handler = createAccountsHandler({
    store,
    controlPlaneOperations: billingCheckoutOperations("tsub_billing_checkout"),
    billingCheckout: {
      stripeSecretKey: "sk_test_checkout",
      plans: [
        {
          id: "lite",
          kind: "subscription",
          stripePriceId: "price_test_lite",
          usdMicros: 5_000_000,
        },
      ],
      redirectAllowlist: ["https://accounts.example.test"],
      fetch: async (_url, init) => {
        stripeRequests.push(new URLSearchParams(String(init?.body ?? "")));
        return new Response(
          JSON.stringify({
            id: "cs_test_checkout",
            url: "https://checkout.stripe.com/c/pay/cs_test_checkout",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: accountSessionHeaders(sessionId),
      body: JSON.stringify({
        subject: "tsub_billing_checkout",
        workspaceId: "space_billing",
        planId: "lite",
        successUrl:
          "https://accounts.example.test/workspace/settings/billing?checkout=success",
        cancelUrl:
          "https://accounts.example.test/workspace/settings/billing?checkout=cancel",
      }),
    }),
  );

  expect(response.status).toEqual(201);
  const body = await response.json();
  expect(body.session_id).toEqual("cs_test_checkout");
  expect(body.url).toEqual(
    "https://checkout.stripe.com/c/pay/cs_test_checkout",
  );
  expect(body).not.toHaveProperty("stripePriceId");
  expect(stripeRequests.length).toEqual(1);
  const params = stripeRequests[0]!;
  expect(params.get("mode")).toEqual("subscription");
  expect(params.get("line_items[0][price]")).toEqual("price_test_lite");
  expect(params.get("metadata[takosumi_subject]")).toEqual(
    "tsub_billing_checkout",
  );
  expect(params.get("metadata[takosumi_workspace_id]")).toEqual(
    "space_billing",
  );
  expect(params.get("metadata[takosumi_plan_id]")).toEqual("lite");
  expect(params.get("metadata[space_id]")).toEqual("space_billing");
  expect(params.get("metadata[plan_code]")).toEqual("lite");
  expect(params.get("metadata[usd_micros]")).toEqual("5000000");
  expect(params.get("subscription_data[metadata][takosumi_plan_id]")).toEqual(
    "lite",
  );
  expect(params.get("subscription_data[metadata][space_id]")).toEqual(
    "space_billing",
  );
  expect(params.get("subscription_data[metadata][usd_micros]")).toEqual(
    "5000000",
  );
});

test("accounts handler accepts signed Stripe webhooks and grants owner account credits once", async () => {
  const store = new InMemoryAccountsStore();
  seedAccountSession(store, "tsub_billing_webhook");
  store.saveBillingAccount({
    billingAccountId: "bill_billing_webhook",
    subject: "tsub_billing_webhook",
    provider: "stripe",
    stripeCustomerId: "cus_webhook",
    status: "past_due",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const topUps: {
    workspaceId: string;
    input: { usdMicros?: number; credits?: number };
  }[] = [];
  const operations = {
    ...billingCheckoutOperations("tsub_billing_webhook"),
    topUpWorkspaceCredits: async (
      workspaceId: string,
      input: { usdMicros?: number; credits?: number },
    ) => {
      topUps.push({ workspaceId, input });
      return {
        balance: {
          workspaceId,
          spaceId: workspaceId,
          availableUsdMicros: input.usdMicros ?? 0,
          reservedUsdMicros: 0,
          monthlyIncludedUsdMicros: 0,
          purchasedUsdMicros: input.usdMicros ?? 0,
          availableCredits: (input.usdMicros ?? 0) / 1_000_000,
          reservedCredits: 0,
          monthlyIncludedCredits: 0,
          purchasedCredits: (input.usdMicros ?? 0) / 1_000_000,
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      };
    },
  } as unknown as ControlPlaneOperations;
  const handler = createAccountsHandler({
    store,
    controlPlaneOperations: operations,
    billingWebhook: {
      webhookSecret: "whsec_test",
      plans: [
        {
          id: "lite",
          kind: "subscription",
          stripePriceId: "price_test_lite",
          usdMicros: 5_000_000,
        },
      ],
    },
  });
  const payload = JSON.stringify({
    id: "evt_invoice_paid_once",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_webhook",
        object: "invoice",
        customer: "cus_webhook",
        lines: { data: [{ period: { end: 1_800_000_000 } }] },
        subscription_details: {
          metadata: {
            takosumi_workspace_id: "space_billing",
            takosumi_plan_id: "lite",
            takosumi_usd_micros: "5000000",
          },
        },
      },
    },
  });
  const signature = await stripeSignature(payload, "whsec_test");

  const response = await handler(
    new Request("https://accounts.example.test/api/v1/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    }),
  );
  expect(response.status).toEqual(200);
  expect(await response.json()).toMatchObject({
    received: true,
    duplicate: false,
    event_id: "evt_invoice_paid_once",
    status: "processed",
  });
  expect(topUps).toEqual([
    {
      workspaceId: "space_billing",
      input: { usdMicros: 5_000_000 },
    },
  ]);
  expect(
    store.findBillingAccountByStripeCustomerId("cus_webhook")?.status,
  ).toEqual("active");

  const duplicate = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    }),
  );
  expect(duplicate.status).toEqual(200);
  expect(await duplicate.json()).toMatchObject({
    received: true,
    duplicate: true,
    event_id: "evt_invoice_paid_once",
  });
  expect(topUps).toHaveLength(1);
});

test("accounts handler creates Stripe Billing Portal Sessions for existing customers", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_billing_portal");
  store.saveBillingAccount({
    billingAccountId: "billing_portal",
    subject: "tsub_billing_portal",
    provider: "stripe",
    stripeCustomerId: "cus_portal",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const stripeRequests: URLSearchParams[] = [];
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
    billingCheckout: {
      stripeSecretKey: "sk_test_checkout",
      plans: [],
      redirectAllowlist: ["https://accounts.example.test"],
      fetch: async (url, init) => {
        expect(String(url)).toEqual(
          "https://api.stripe.com/v1/billing_portal/sessions",
        );
        stripeRequests.push(new URLSearchParams(String(init?.body ?? "")));
        return new Response(
          JSON.stringify({
            id: "bps_test_portal",
            url: "https://billing.stripe.com/p/session/bps_test_portal",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/portal", {
      method: "POST",
      headers: accountSessionHeaders(sessionId),
      body: JSON.stringify({
        subject: "tsub_billing_portal",
        returnUrl: "https://accounts.example.test/billing?portal=return",
      }),
    }),
  );

  expect(response.status).toEqual(201);
  const body = await response.json();
  expect(body.session_id).toEqual("bps_test_portal");
  expect(body.url).toEqual(
    "https://billing.stripe.com/p/session/bps_test_portal",
  );
  expect(stripeRequests.length).toEqual(1);
  const params = stripeRequests[0]!;
  expect(params.get("customer")).toEqual("cus_portal");
  expect(params.get("return_url")).toEqual(
    "https://accounts.example.test/billing?portal=return",
  );
});

test("accounts handler exposes Stripe subscription status and invoice history", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_billing_summary");
  store.saveBillingAccount({
    billingAccountId: "billing_summary",
    subject: "tsub_billing_summary",
    provider: "stripe",
    stripeCustomerId: "cus_summary",
    stripeSubscriptionId: "sub_summary",
    stripePriceId: "price_summary",
    planCode: "lite",
    currentPeriodEndUnix: 1_789_081_200,
    lastInvoiceId: "in_summary_1",
    status: "active",
    createdAt: 1_000,
    updatedAt: 2_000,
  });
  const stripeRequests: string[] = [];
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
    billingCheckout: {
      stripeSecretKey: "sk_test_checkout",
      plans: [],
      redirectAllowlist: ["https://accounts.example.test"],
      fetch: async function (this: unknown, url) {
        expect(this).toEqual(undefined);
        stripeRequests.push(String(url));
        const parsed = new URL(String(url));
        if (parsed.pathname === "/v1/subscriptions/sub_summary") {
          return Response.json({
            id: "sub_summary",
            status: "active",
            current_period_end: 1_789_081_200,
            cancel_at_period_end: false,
            metadata: { takosumi_plan_id: "lite" },
          });
        }
        if (parsed.pathname === "/v1/invoices") {
          expect(parsed.searchParams.get("customer")).toEqual("cus_summary");
          expect(parsed.searchParams.get("limit")).toEqual("10");
          return Response.json({
            data: [
              {
                id: "in_summary_1",
                number: "TS-0001",
                status: "paid",
                currency: "usd",
                amount_paid: 100,
                amount_due: 0,
                total: 100,
                hosted_invoice_url: "https://invoice.stripe.com/i/in_summary_1",
                invoice_pdf: "https://invoice.stripe.com/i/in_summary_1.pdf",
                created: 1_789_000_000,
                paid: true,
                subscription: "sub_summary",
              },
            ],
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/summary", {
      method: "GET",
      headers: accountSessionHeaders(sessionId),
    }),
  );

  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.billing.account.status).toEqual("active");
  expect(body.billing.subscription).toMatchObject({
    id: "sub_summary",
    status: "active",
    planCode: "lite",
    currentPeriodEnd: "2026-09-10T23:00:00.000Z",
  });
  expect(body.billing.invoices).toEqual([
    {
      id: "in_summary_1",
      number: "TS-0001",
      status: "paid",
      currency: "USD",
      amountPaidMinor: 100,
      amountDueMinor: 0,
      totalMinor: 100,
      amountPaidUsdMicros: 1_000_000,
      amountDueUsdMicros: 0,
      totalUsdMicros: 1_000_000,
      hostedInvoiceUrl: "https://invoice.stripe.com/i/in_summary_1",
      invoicePdfUrl: "https://invoice.stripe.com/i/in_summary_1.pdf",
      createdAt: "2026-09-10T00:26:40.000Z",
      paid: true,
      subscriptionId: "sub_summary",
    },
  ]);
  expect(stripeRequests).toHaveLength(2);
});

test("accounts handler lets billing checkout smoke bypass only launch readiness", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_billing_smoke");
  seedOwnedWorkspace(store, "tsub_billing_smoke", "acct_smoke", "space_smoke");
  let stripeRequestCount = 0;
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
    controlPlaneOperations: billingCheckoutOperations("tsub_billing_smoke"),
    billingCheckout: {
      stripeSecretKey: "sk_test_checkout",
      smokeToken: "smoke_token",
      plans: [
        {
          id: "lite",
          kind: "subscription",
          stripePriceId: "price_test_lite",
        },
      ],
      redirectAllowlist: ["https://accounts.example.test"],
      fetch: async (_url, init) => {
        stripeRequestCount += 1;
        const params = new URLSearchParams(String(init?.body ?? ""));
        expect(params.get("mode")).toEqual("subscription");
        expect(params.get("customer_creation")).toEqual(null);
        expect(
          params.get("subscription_data[metadata][takosumi_plan_id]"),
        ).toEqual("lite");
        return new Response(
          JSON.stringify({
            id: "cs_test_smoke",
            url: "https://checkout.stripe.com/c/pay/cs_test_smoke",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  });
  const requestBody = {
    subject: "tsub_billing_smoke",
    spaceId: "space_smoke",
    planId: "lite",
    successUrl:
      "https://accounts.example.test/workspace/settings/billing?checkout=success",
    cancelUrl:
      "https://accounts.example.test/workspace/settings/billing?checkout=cancel",
  };

  const blocked = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: accountSessionHeaders(sessionId),
      body: JSON.stringify(requestBody),
    }),
  );
  expect(blocked.status).toEqual(503);
  expect((await blocked.json()).error.code).toEqual(
    "launch_readiness_not_complete",
  );
  expect(stripeRequestCount).toEqual(0);

  const allowed = await handler(
    new Request("https://accounts.example.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: {
        ...accountSessionHeaders(sessionId),
        [TAKOSUMI_ACCOUNTS_BILLING_SMOKE_TOKEN_HEADER]: "smoke_token",
      },
      body: JSON.stringify(requestBody),
    }),
  );
  expect(allowed.status).toEqual(201);
  expect((await allowed.json()).session_id).toEqual("cs_test_smoke");
  expect(stripeRequestCount).toEqual(1);
});

test("accounts handler accepts billing usage reports from scoped installation tokens without ServiceGrantMaterial storage", async () => {
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
  store.saveAppCapsule({
    capsuleId: "inst_usage",
    accountId: "acct_1",
    workspaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_usage",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccessToken("access-usage", {
    clientId: "client_usage",
    subject: "pairwise_subject",
    takosumiSubject: "tsub_owner",
    capsuleId: "inst_usage",
    appId: "example.app",
    workspaceId: "space_1",
    role: "owner",
    scope: "openid billing.usage.report",
    expiresAt: now + 5 * 60 * 1000,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_usage/billing/usage-reports",
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
  expect(
    store
      .listBillingUsageRecordsForCapsule("inst_usage")
      .map((record) => record.meter),
  ).toEqual(["agent.compute.seconds"]);
  expect(
    store.listCapsuleEvents("inst_usage").map((event) => event.eventType),
  ).toEqual(["billing.usage_reported"]);

  const duplicate = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_usage/billing/usage-reports",
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
  expect(store.listBillingUsageRecordsForCapsule("inst_usage").length).toEqual(
    1,
  );
  expect(
    store.listCapsuleEvents("inst_usage").map((event) => event.eventType),
  ).toEqual(["billing.usage_reported"]);

  const internalBackendMeter = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_usage/billing/usage-reports",
      {
        method: "POST",
        headers: { authorization: "Bearer access-usage" },
        body: JSON.stringify({
          reportId: "usage_report_wfp",
          meter: "cloudflare.workers.for.platforms",
          quantity: 1,
          unit: "requests",
          idempotencyKey: "usage-window-wfp",
        }),
      },
    ),
  );

  expect(internalBackendMeter.status).toEqual(400);
  expect(store.listBillingUsageRecordsForCapsule("inst_usage").length).toEqual(
    1,
  );

  const conflictingIdempotency = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_usage/billing/usage-reports",
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
  expect((await conflictingIdempotency.json()).error.code).toEqual(
    "idempotency_key_conflict",
  );

  store.saveBillingAccount({
    billingAccountId: "bill_usage_2",
    subject: "tsub_owner",
    provider: "stripe",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppCapsule({
    capsuleId: "inst_usage_2",
    accountId: "acct_1",
    workspaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_usage_2",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveServiceGrantMaterial({
    grantId: "grant_usage_2",
    capsuleId: "inst_usage_2",
    capability: "billing.usage.report",
    scope: {},
    grantedAt: now,
  });
  store.saveAccessToken("access-usage-2", {
    clientId: "client_usage_2",
    subject: "pairwise_subject_2",
    takosumiSubject: "tsub_owner",
    capsuleId: "inst_usage_2",
    appId: "example.app",
    workspaceId: "space_1",
    role: "owner",
    scope: "openid billing.usage.report",
    expiresAt: now + 5 * 60 * 1000,
  });
  const crossCapsuleReportId = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_usage_2/billing/usage-reports",
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

  expect(crossCapsuleReportId.status).toEqual(409);
  expect((await crossCapsuleReportId.json()).error.code).toEqual(
    "usage_report_id_conflict",
  );
});

test("accounts handler no longer gates installation access tokens on ServiceGrantMaterial revocation (AC1)", async () => {
  // AC1 retirement: the dead `tokenScopesRemainGranted` grant-scope guard was
  // removed because `listServiceGrantMaterialsForCapsule` is a no-op on the durable
  // (D1 / Postgres) stores, so the guard rejected valid tokens on durable
  // stores while accepting them in-memory. Token authorization is now a
  // consistent absence across stores: an installation access token is gated by
  // its static scope (`includesScope`), not by a revocable grant row. A revoked
  // ServiceGrantMaterial therefore no longer blocks a usage report.
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
  store.saveAppCapsule({
    capsuleId: "inst_usage",
    accountId: "acct_1",
    workspaceId: "space_1",
    appId: "example.app",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "abc123",
    planDigest: "sha256:manifest",
    mode: "shared-cell",
    billingAccountId: "bill_usage",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveServiceGrantMaterial({
    grantId: "grant_usage",
    capsuleId: "inst_usage",
    capability: "billing.usage.report",
    scope: {},
    grantedAt: now,
    revokedAt: now + 1,
  });
  store.saveAccessToken("access-usage", {
    clientId: "client_usage",
    subject: "pairwise_subject",
    takosumiSubject: "tsub_owner",
    capsuleId: "inst_usage",
    appId: "example.app",
    workspaceId: "space_1",
    role: "owner",
    scope: "openid billing.usage.report",
    expiresAt: now + 5 * 60 * 1000,
  });

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_usage/billing/usage-reports",
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

  expect(response.status).toEqual(202);
  expect((await response.json()).usage_report.id).toEqual("usage_report_123");
  expect(
    store
      .listBillingUsageRecordsForCapsule("inst_usage")
      .map((record) => record.meter),
  ).toEqual(["agent.compute.seconds"]);
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_shared_auto",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
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
  // `installation` is still surfaced (it carries the account-plane ledger
  // reference for callers that need it during the transition).
  expect(created.installation.runtime_target_id).toEqual(
    "rtb_inst_shared_auto_shared_cell",
  );
  expect(
    store.findRuntimeBinding("rtb_inst_shared_auto_shared_cell")?.targetId,
  ).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_shared_auto");
  expect(
    store.listCapsuleEvents("inst_shared_auto").map((event) => event.eventType),
  ).toEqual(["installation.created", "runtime_target.assigned"]);

  const exhausted = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_shared_exhausted",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "def456",
          planDigest: "sha256:app2",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(exhausted.status).toEqual(503);
  expect((await exhausted.json()).error.code).toEqual(
    "shared_cell_capacity_unavailable",
  );
});

test("accounts handler records AppCapsule deployment and rollback revisions", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_revision",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos.git",
          ref: "v1.2.3",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          planDigest: "sha256:app-v123",
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
      "https://accounts.example.test/v1/capsule-projections/inst_revision/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(readyResponse.status).toEqual(200);

  const deploymentPlanRunResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision/revisions/plan-runs",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
            artifactDigest: "sha256:compiled-v124",
          },
        }),
      },
    ),
  );
  expect(deploymentPlanRunResponse.status).toEqual(200);
  const deploymentPlanRun = await deploymentPlanRunResponse.json();
  expect(deploymentPlanRun.operation).toEqual("revision");
  expect(deploymentPlanRun.expected.permissionDigest).toStartWith("sha256:");

  const deploymentResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
            artifactDigest: "sha256:compiled-v124",
          },
          confirm: {
            permissionDigest: deploymentPlanRun.expected.permissionDigest,
          },
          reason: "deployment v1.2.4 sk-deploy-raw-token",
        }),
      },
    ),
  );
  expect(deploymentResponse.status).toEqual(503);
  expect((await deploymentResponse.json()).error.code).toEqual(
    "deploy_control_required",
  );
  expect(store.findAppCapsule("inst_revision")?.sourceCommit).toEqual(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const rollbackResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision/rollback",
      {
        method: "POST",
        body: JSON.stringify({
          to: "v1.2.3",
          source: {
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            planDigest: "sha256:app-v123",
            artifactDigest: "sha256:compiled-v123",
          },
          reason: "operator rollback",
        }),
      },
    ),
  );
  expect(rollbackResponse.status).toEqual(503);
  expect((await rollbackResponse.json()).error.code).toEqual(
    "deploy_control_required",
  );

  const eventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision/events",
    ),
  );
  expect(eventsResponse.status).toEqual(200);
  const eventsBody = await eventsResponse.json();
  expect(eventsBody.hash_chain_valid).toEqual(true);
  expect(
    eventsBody.events.map((event: { type: string }) => event.type),
  ).toEqual(["installation.created", "installation.status_changed"]);
});

test("accounts handler brokers deployment and rollback through space deployControl", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_core_revision",
    accountId: "acct_1",
    workspaceId: "space_1",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos.git",
    sourceRef: "v1.2.3",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    planDigest: "sha256:app-v123",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  // Records each in-process deploy-control dispatch the facade makes, in order,
  // as `{ op, id?, body? }` — the operations-facade equivalent of the former
  // ordered HTTP-path/bearer assertion.
  const dispatchLog: Array<{
    op: string;
    id?: string;
    body?: Record<string, unknown>;
  }> = [];
  const handler = createAccountsHandler({
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getCapsule: (id) => {
          dispatchLog.push({ op: "getCapsule", id });
          return Promise.resolve({
            installation: {
              id: "inst_core_revision",
              workspaceId: "space_1",
              appId: "takos.chat",
              source: {
                kind: "git",
                url: "https://github.com/takos/takos.git",
                ref: "v1.2.3",
                commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
              runnerProfileId: "cloudflare-default",
              currentDeploymentId: "dep_old",
              status: "ready",
              createdAt: now,
              updatedAt: now,
            },
          } as unknown as GetCapsuleResponse);
        },
        createPlanRun: (request) => {
          dispatchLog.push({
            op: "createPlanRun",
            body: request as unknown as Record<string, unknown>,
          });
          const source =
            typeof request.source === "object" &&
            request.source !== null &&
            !Array.isArray(request.source)
              ? (request.source as Record<string, unknown>)
              : {
                  kind: "git",
                  url: "https://github.com/takos/takos.git",
                  ref: "v1.2.4",
                };
          const ref = typeof source.ref === "string" ? source.ref : "v1.2.4";
          const commit =
            ref === "v1.2.3"
              ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          const digest =
            ref === "v1.2.3" ? "sha256:app-v123" : "sha256:app-v124";
          return Promise.resolve({
            planRun: {
              id: `plan_${ref.replace(/[^0-9a-z]/gi, "")}`,
              workspaceId: "space_1",
              capsuleId: "inst_core_revision",
              installationCurrentDeploymentId: "dep_old",
              capsuleCurrentStateVersionId: "sv_old",
              source,
              operation: "update",
              runnerProfileId: "cloudflare-default",
              sourceDigest: `sha256:source-${ref.replace(/[^0-9a-z]/gi, "")}`,
              variablesDigest: `sha256:variables-${ref.replace(/[^0-9a-z]/gi, "")}`,
              policyDecisionDigest: `sha256:policy-${ref.replace(/[^0-9a-z]/gi, "")}`,
              variables: {},
              requiredProviders: [],
              status: "succeeded",
              policy: { status: "passed", reasons: [], checkedAt: now },
              planDigest: digest,
              planArtifact: {
                kind: "runner-local",
                ref: `runner-local://plan_${ref.replace(/[^0-9a-z]/gi, "")}/tfplan`,
                digest,
              },
              sourceCommit: commit,
              providerLockDigest: `sha256:lock-${ref}`,
              createdAt: now,
              updatedAt: now,
              finishedAt: now,
            },
            currentStateVersionId: "sv_old",
          } as unknown as PlanRunResponse);
        },
        getPlanRun: (planRunId) => {
          dispatchLog.push({ op: "getPlanRun", id: planRunId });
          const rollbackPlan = planRunId.includes("v123");
          const ref = rollbackPlan ? "v1.2.3" : "v1.2.4";
          const commit = rollbackPlan
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          const digest = rollbackPlan ? "sha256:app-v123" : "sha256:app-v124";
          return Promise.resolve({
            planRun: {
              id: planRunId,
              workspaceId: "space_1",
              capsuleId: "inst_core_revision",
              installationCurrentDeploymentId: rollbackPlan
                ? "dep_new"
                : "dep_old",
              source: {
                kind: "git",
                url: "https://github.com/takos/takos.git",
                ref,
              },
              operation: "update",
              runnerProfileId: "cloudflare-default",
              sourceDigest: `sha256:source-${planRunId}`,
              variablesDigest: `sha256:variables-${planRunId}`,
              policyDecisionDigest: `sha256:policy-${planRunId}`,
              requiredProviders: [],
              status: "succeeded",
              policy: { status: "passed", reasons: [], checkedAt: now },
              planDigest: digest,
              planArtifact: {
                kind: "runner-local",
                ref: `runner-local://${planRunId}/tfplan`,
                digest,
              },
              sourceCommit: commit,
              providerLockDigest: `sha256:lock-${ref}`,
              createdAt: now,
              updatedAt: now,
              finishedAt: now,
            },
          } as unknown as PlanRunResponse);
        },
        createApplyRun: (request) => {
          dispatchLog.push({
            op: "createApplyRun",
            body: request as unknown as Record<string, unknown>,
          });
          const planRunId =
            typeof request.planRunId === "string" ? request.planRunId : "";
          const rollbackApply = planRunId.includes("v123");
          const source = rollbackApply
            ? {
                kind: "git",
                url: "https://github.com/takos/takos.git",
                ref: "v1.2.3",
              }
            : {
                kind: "git",
                url: "https://github.com/takos/takos.git",
                ref: "v1.2.4",
              };
          const deploymentId = rollbackApply ? "dep_old" : "dep_new";
          const commit = rollbackApply
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          const digest = rollbackApply ? "sha256:app-v123" : "sha256:app-v124";
          return Promise.resolve({
            applyRun: {
              id: rollbackApply ? "apply_rollback" : "apply_new",
              planRunId,
              workspaceId: "space_1",
              capsuleId: "inst_core_revision",
              deploymentId,
              operation: "update",
              runnerProfileId: "cloudflare-default",
              status: "succeeded",
              createdAt: now + 1,
              updatedAt: now + 1,
              finishedAt: now + 1,
            },
            installation: {
              id: "inst_core_revision",
              workspaceId: "space_1",
              appId: "takos.chat",
              currentDeploymentId: deploymentId,
              status: "ready",
              createdAt: now,
              updatedAt: now + 1,
            },
            deployment: {
              id: deploymentId,
              capsuleId: "inst_core_revision",
              source,
              planDigest: digest,
              sourceCommit: commit,
              status: "succeeded",
              outputs: rollbackApply
                ? []
                : [
                    {
                      name: "takosumi_launch_url",
                      kind: "launch_url",
                      value: "https://takos-new.example.test",
                      sensitive: false,
                    },
                  ],
              createdAt: now + 1,
            },
          } as unknown as ApplyRunResponse);
        },
        listDeployments: (capsuleId) => {
          dispatchLog.push({ op: "listDeployments", id: capsuleId });
          return Promise.resolve({
            deployments: [
              {
                id: "dep_old",
                capsuleId: "inst_core_revision",
                planRunId: "plan_v123",
                applyRunId: "apply_old",
                source: {
                  kind: "git",
                  url: "https://github.com/takos/takos.git",
                  ref: "v1.2.3",
                },
                planDigest: "sha256:app-v123",
                sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                runnerProfileId: "cloudflare-default",
                status: "succeeded",
                outputs: {},
                createdAt: now,
              },
            ],
          } as unknown as ListDeploymentsResponse);
        },
      }),
    },
  });

  const planRunResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_core_revision/revisions/plan-runs",
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
  expect(planRunResponse.status).toEqual(200);
  const planRun = await planRunResponse.json();
  expect(planRun.expected.currentStateVersionId).toEqual("sv_old");
  expect(planRun.expected.sourceCommit).toEqual(
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  expect(typeof planRun.expected.permissionDigest).toEqual("string");

  const deployResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_core_revision/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            kind: "git",
            url: "https://github.com/takos/takos.git",
            ref: "v1.2.4",
          },
          expected: {
            planRunId: planRun.expected.planRunId,
            capsuleId: "inst_core_revision",
            runnerProfileId: planRun.expected.runnerProfileId,
            sourceDigest: planRun.expected.sourceDigest,
            variablesDigest: planRun.expected.variablesDigest,
            policyDecisionDigest: planRun.expected.policyDecisionDigest,
            planDigest: "sha256:app-v124",
            planArtifactDigest: planRun.expected.planArtifactDigest,
            sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            providerLockDigest: planRun.expected.providerLockDigest,
            currentStateVersionId: "sv_old",
          },
          confirm: {
            permissionDigest: planRun.expected.permissionDigest,
          },
          reason: "deployment v1.2.4 sk-deploy-raw-token",
        }),
      },
    ),
  );
  expect(deployResponse.status).toEqual(200);
  const deployed = await deployResponse.json();
  expect(deployed.installation.source.ref).toEqual("v1.2.4");
  expect(deployed.event.payload.coreDeployment.id).toEqual("dep_new");
  expect(deployed.event.payload.reason).toEqual("deployment v1.2.4 [REDACTED]");
  expect(JSON.stringify(deployed)).not.toContain("sk-deploy-raw-token");
  expect(deployed.installation.launch_url).toEqual(
    "https://takos-new.example.test",
  );

  const rollbackResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_core_revision/rollback",
      {
        method: "POST",
        body: JSON.stringify({
          deploymentId: "dep_old",
          planRunId: "plan_v123",
          expected: {
            planRunId: "plan_v123",
            capsuleId: "inst_core_revision",
            runnerProfileId: "cloudflare-default",
            sourceDigest: "sha256:source-plan_v123",
            variablesDigest: "sha256:variables-plan_v123",
            policyDecisionDigest: "sha256:policy-plan_v123",
            planDigest: "sha256:app-v123",
            planArtifactDigest: "sha256:app-v123",
            sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            providerLockDigest: "sha256:lock-v1.2.3",
            currentStateVersionId: "sv_new",
          },
          reason: "operator rollback ghp_abcdefghijklmnopqrstuvwxyz",
        }),
      },
    ),
  );
  expect(rollbackResponse.status).toEqual(200);
  const rolledBack = await rollbackResponse.json();
  expect(rolledBack.installation.source.ref).toEqual("v1.2.3");
  expect(rolledBack.installation.launch_url).toEqual(null);
  expect(rolledBack.event.payload.reason).toEqual(
    "operator rollback [REDACTED]",
  );
  expect(JSON.stringify(rolledBack)).not.toContain(
    "ghp_abcdefghijklmnopqrstuvwxyz",
  );
  expect(
    rolledBack.event.payload.coreDeployment.rollback.targetDeploymentId,
  ).toEqual("dep_old");
  expect(
    dispatchLog.map((call) => (call.id ? `${call.op}:${call.id}` : call.op)),
  ).toEqual([
    "getCapsule:inst_core_revision",
    "createPlanRun",
    "getPlanRun:plan_v124",
    "createApplyRun",
    "listDeployments:inst_core_revision",
    "getPlanRun:plan_v123",
    "createApplyRun",
  ]);
  expect(dispatchLog[3].body?.planRunId).toEqual("plan_v124");
  expect(dispatchLog[6].body?.planRunId).toEqual("plan_v123");
});

test("accounts handler rejects invalid AppCapsule revision mutations", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    deployControl: { operations: deployControlOperationsStub() },
  });
  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_revision_guard",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos.git",
          ref: "v1.2.3",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          planDigest: "sha256:app-v123",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const pendingDeployment = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision_guard/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
          },
        }),
      },
    ),
  );
  expect(pendingDeployment.status).toEqual(409);
  expect((await pendingDeployment.json()).error.code).toEqual("state_conflict");

  const readyResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision_guard/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
  );
  expect(readyResponse.status).toEqual(200);

  const missingConfirm = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision_guard/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
          },
        }),
      },
    ),
  );
  expect(missingConfirm.status).toEqual(400);
  expect((await missingConfirm.json()).error.code).toEqual("invalid_confirm");

  const digestMismatch = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision_guard/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
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
  expect((await digestMismatch.json()).error.code).toEqual(
    "approval_digest_mismatch",
  );

  const meteredBindingRequest = [
    {
      name: "database",
      kind: "storage.sql",
      configRef: "config://inst_revision_guard/database",
    },
  ];
  const meteredBindingRecords = meteredBindingRequest.map((binding) => ({
    ...binding,
    secretRefs: [],
  }));
  const meteredDigest = await testRevisionPermissionDigest({
    operation: "revision",
    capsuleId: "inst_revision_guard",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos.git",
    sourceRef: "v1.2.4",
    sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    planDigest: "sha256:app-v124",
    requestedBindings: meteredBindingRecords,
  });
  const missingCostAck = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision_guard/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
          },
          serviceBindings: meteredBindingRequest,
          confirm: {
            permissionDigest: meteredDigest,
          },
        }),
      },
    ),
  );
  expect(missingCostAck.status).toEqual(400);
  expect((await missingCostAck.json()).error.code).toEqual("cost_ack_required");

  const sourceMismatch = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_revision_guard/revisions",
      {
        method: "POST",
        body: JSON.stringify({
          source: {
            url: "https://github.com/example/other",
            ref: "v1.2.4",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            planDigest: "sha256:app-v124",
          },
        }),
      },
    ),
  );
  expect(sourceMismatch.status).toEqual(409);
  expect((await sourceMismatch.json()).error.code).toEqual("source_mismatch");
});

test("accounts handler does not launch-gate AppCapsule creation when platform readiness access is closed", async () => {
  // Generic Capsule create is platform surface, not a platform-readiness
  // surface: the launch gate no longer applies. An authorized create proceeds
  // and is persisted even while the platform readiness is closed.
  const store = new InMemoryAccountsStore();
  seedOwnedWorkspace(store, "tsub_owner", "acct_1", "space_1");
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_open_platform",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "example.app",
        source: {
          gitUrl: "https://github.com/example/app",
          ref: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:manifest",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );

  expect(response.status).toEqual(202);
  const body = await response.text();
  expect(body.includes("launch_readiness_not_complete")).toEqual(false);
  expect(store.findAppCapsule("inst_open_platform")?.appId).toEqual(
    "example.app",
  );
});

test("accounts handler does not expose retired installation projection import route", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections/import", {
      method: "POST",
      body: JSON.stringify({
        bundle: { kind: "takosumi.accounts.export-bundle@v1" },
        target: { issuer: "https://accounts.target.test" },
      }),
    }),
  );

  expect(response.status).toEqual(404);
  expect(matchCapsuleRoute("/v1/capsule-projections/import")).toEqual(null);
});

test("accounts handler keeps export un-launch-gated but gates materialize when platform readiness access is closed", async () => {
  const handler = createAccountsHandler({
    platformAccess: { status: "closed" },
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  });

  // Generic deployment / rollback / status / export mutations are platform
  // surfaces: the launch gate no longer applies, so they proceed to ownership
  // auth (401) when unauthenticated.
  const ungatedRequests = [
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/revisions",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/rollback",
      {
        method: "POST",
      },
    ),
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "ready" }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/status",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "installing" }),
      },
    ),
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/export",
      {
        method: "POST",
      },
    ),
  ];

  for (const request of ungatedRequests) {
    const response = await handler(request);
    expect(response.status).toEqual(401);
    expect((await response.json()).error).toEqual("invalid_token");
  }

  // The platform-cell materialize mutation is an offering surface and stays
  // launch-gated while the offering is closed.
  const gatedRequests = [
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_1/materialize",
      {
        method: "POST",
      },
    ),
  ];

  for (const request of gatedRequests) {
    const response = await handler(request);
    expect(response.status).toEqual(503);
    expect((await response.json()).error.code).toEqual(
      "launch_readiness_not_complete",
    );
  }
});

test("accounts handler lets operator materialize drill bypass only the readiness gate", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
    materializeDrillToken: "materialize_drill_token",
  });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_drill",
        accountId: "acct_materialize_drill",
        workspaceId: "space_materialize_drill",
        appId: "example.materialize-drill",
        source: {
          gitUrl: "https://github.com/example/materialize-drill",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize_drill",
      }),
    }),
  );

  const body = {
    mode: "dedicated",
    region: "tokyo",
    confirm: {
      costAck: true,
      permissionDigest: await testMaterializePermissionDigest({
        capsuleId: "inst_materialize_drill",
        region: "tokyo",
      }),
    },
  };

  const invalidToken = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_drill/materialize",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "idem-materialize-drill-invalid-token",
          [TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER]: "wrong",
        },
        body: JSON.stringify(body),
      },
    ),
  );
  expect(invalidToken.status).toEqual(503);
  expect((await invalidToken.json()).error.code).toEqual(
    "launch_readiness_not_complete",
  );

  const invalidSession = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_drill/materialize",
      {
        method: "POST",
        headers: {
          authorization: "Bearer invalid_session",
          "Idempotency-Key": "idem-materialize-drill-invalid-session",
          [TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER]: "materialize_drill_token",
        },
        body: JSON.stringify(body),
      },
    ),
  );
  expect(invalidSession.status).toEqual(401);
  expect((await invalidSession.json()).error).toEqual("invalid_token");

  const materializeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_drill/materialize",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "idem-materialize-drill",
          [TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER]: "materialize_drill_token",
        },
        body: JSON.stringify(body),
      },
    ),
  );
  expect(materializeResponse.status).toEqual(202);
  const operationId = (await materializeResponse.json()).operationId;

  const cancelResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_drill/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ready",
          operation: "materialize",
          operationId,
          reason: "materialize canceled before cutover",
        }),
      },
    ),
  );
  expect(cancelResponse.status).toEqual(200);
  const cancelBody = await cancelResponse.json();
  expect(cancelBody.installation.status).toEqual("ready");
  expect(cancelBody.installation.mode).toEqual("shared-cell");
  expect(cancelBody.event.type).toEqual("installation.materialize-failed");
  expect(
    store
      .listCapsuleEvents("inst_materialize_drill")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "installation.materialize-requested",
    "installation.materialize-failed",
  ]);
});

test("accounts handler allows authenticated owner export while platform readiness access is closed", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_closed_export",
        accountId: "acct_closed_export",
        workspaceId: "space_closed_export",
        appId: "example.closed-export",
        source: {
          gitUrl: "https://github.com/example/closed-export",
          ref: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:closed-export",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_closed_export",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_closed_export/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-closed-export" },
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
  const body = await exportResponse.json();
  expect(body.status).toEqual("preparing");
  expect(body.event.type).toEqual("installation.export-requested");
});

test("accounts handler mirrors control deploy projection and exports after apply success", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_owner");
  const operations = {
    spaces: {
      getWorkspace: async (id: string) => ({
        id,
        handle: "owner",
        displayName: "Owner",
        type: "personal" as const,
        ownerUserId: "tsub_owner",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getPlanRun: async () => ({
      planRun: {
        id: "plan_control_export",
        workspaceId: "space_control_export",
        capsuleId: "inst_control_export",
        sourceSnapshotId: "snap_control_export",
        source: {
          kind: "git" as const,
          url: "upload://space_control_export",
          commit:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        sourceDigest: `sha256:${"a".repeat(64)}`,
        operation: "create" as const,
        runnerProfileId: "rp_default",
        variablesDigest: `sha256:${"b".repeat(64)}`,
        requiredProviders: [],
        status: "succeeded" as const,
        policy: { status: "passed" as const, reasons: [], checkedAt: 0 },
        policyDecisionDigest: `sha256:${"c".repeat(64)}`,
        planDigest: `sha256:${"d".repeat(64)}`,
        planArtifact: {
          kind: "object-storage" as const,
          ref: "plans/plan_control_export.tfplan",
          digest: `sha256:${"d".repeat(64)}`,
        },
        auditEvents: [],
        createdAt: 0,
        updatedAt: 0,
      },
    }),
    getSourceSnapshot: async () => ({
      id: "snap_control_export",
      origin: "upload" as const,
      workspaceId: "space_control_export",
      url: "upload://space_control_export",
      ref: "upload",
      resolvedCommit:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      path: ".",
      archiveObjectKey:
        "spaces/space_control_export/uploads/snap_control_export/source.tar.zst",
      archiveDigest: `sha256:${"b".repeat(64)}`,
      archiveSizeBytes: 128,
      fetchedByRunId: "upload",
      fetchedAt: "2026-01-01T00:00:00Z",
    }),
    getRun: async () => ({
      id: "apply_control_export",
      workspaceId: "space_control_export",
      capsuleId: "inst_control_export",
      type: "apply" as const,
      status: "succeeded" as const,
      planDigest: `sha256:${"d".repeat(64)}`,
      createdBy: "test",
      createdAt: "2026-01-01T00:00:00Z",
    }),
  } as unknown as ControlPlaneOperations;
  const handler = createAccountsHandler({
    store,
    platformAccess: { status: "closed" },
    controlPlaneOperations: operations,
  });
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_control_export",
    accountId: "acct_control_export",
    workspaceId: "space_control_export",
    appId: "hello",
    sourceGitUrl: "https://github.com/example/hello",
    sourceRef: "main",
    sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    planDigest: `sha256:${"d".repeat(64)}`,
    mode: "shared-cell",
    status: "installing",
    createdBySubject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.appendCapsuleEvent({
    eventId: "evt_control_export_created",
    capsuleId: "inst_control_export",
    eventType: "installation.created",
    payload: { createdBySubject: "tsub_owner" },
    eventHash: `sha256:${"a".repeat(64)}`,
    createdAt: now,
  });
  expect(store.findAppCapsule("inst_control_export")?.status).toEqual(
    "installing",
  );

  const prematureExportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_control_export/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-control-export-early" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: { secrets: "templates-only" },
        }),
      },
    ),
  );
  expect(prematureExportResponse.status).toEqual(409);
  expect((await prematureExportResponse.json()).error.code).toEqual(
    "state_conflict",
  );

  const pollResponse = await handler(
    new Request(
      "https://accounts.example.test/api/v1/runs/apply_control_export",
      {
        headers: accountSessionHeaders(sessionId),
      },
    ),
  );
  expect(pollResponse.status).toEqual(200);
  expect(store.findAppCapsule("inst_control_export")?.status).toEqual("ready");

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_control_export/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-control-export-ready" },
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
  expect((await exportResponse.json()).status).toEqual("preparing");
});

test("accounts handler does not launch-gate core OAuth and PAT issuance when platform readiness access is closed", async () => {
  // OIDC sign-in and PAT issuance are generic platform surfaces, not
  // platform-readiness surfaces: the launch gate no longer applies. They proceed
  // to their normal behavior (OIDC flow unconfigured in this fixture, PAT
  // requires a session) instead of returning launch_readiness_not_complete.
  const handler = createAccountsHandler({
    platformAccess: { status: "closed" },
  });

  const cases: {
    request: Request;
    status: number;
    error: string;
    envelope?: boolean;
  }[] = [
    {
      request: new Request(
        "https://accounts.example.test/oauth/authorize?client_id=takos&redirect_uri=https%3A%2F%2Ftakos.example.test%2Fcallback&response_type=code&scope=openid",
      ),
      status: 503,
      error: "feature_unavailable",
      // mod.ts reserved-unavailable gate emits the canonical envelope.
      envelope: true,
    },
    {
      request: new Request("https://accounts.example.test/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "code",
        }),
      }),
      status: 503,
      error: "feature_unavailable",
      envelope: true,
    },
    {
      request: new Request("https://accounts.example.test/v1/account/tokens", {
        method: "POST",
        body: JSON.stringify({
          subject: "tsub_owner",
          label: "operator",
        }),
      }),
      status: 401,
      // bearerChallenge (RFC 6750 WWW-Authenticate) keeps the bare shape.
      error: "invalid_session",
    },
  ];

  for (const { request, status, error, envelope } of cases) {
    const response = await handler(request);
    expect(response.status).toEqual(status);
    const body = (await response.json()) as
      { error: string } | { error: { code: string } };
    if (envelope) {
      expect((body as { error: { code: string } }).error.code).toEqual(error);
    } else {
      expect((body as { error: string }).error).toEqual(error);
    }
  }
});

test("accounts handler completes AppCapsule ready suspended exported lifecycle", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_lifecycle",
        accountId: "acct_lifecycle",
        workspaceId: "space_lifecycle",
        appId: "example.lifecycle",
        source: {
          gitUrl: "https://github.com/example/lifecycle",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_lifecycle",
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  expect((await createResponse.json()).installation.status).toEqual(
    "installing",
  );

  for (const [status, reason] of [
    ["ready", "healthcheck passed"],
    ["suspended", "operator pause"],
    ["exported", "self-hosted export complete"],
  ] as const) {
    const response = await handler(
      new Request(
        "https://accounts.example.test/v1/capsule-projections/inst_lifecycle/status",
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
      "https://accounts.example.test/v1/capsule-projections/inst_lifecycle/status",
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
      "https://accounts.example.test/v1/capsule-projections/inst_lifecycle",
      { headers: accountSessionHeaders(ownerSession) },
    ),
  );
  expect(inspectResponse.status).toEqual(200);
  expect((await inspectResponse.json()).installation.status).toEqual(
    "exported",
  );

  const eventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_lifecycle/events",
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_failed_uninstall",
        accountId: "acct_failed_uninstall",
        workspaceId: "space_failed_uninstall",
        appId: "example.failed-uninstall",
        source: {
          gitUrl: "https://github.com/example/failed-uninstall",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_failed_uninstall",
      { method: "DELETE" },
    ),
  );
  expect(uninstallResponse.status).toEqual(410);
  expect((await uninstallResponse.json()).error.code).toEqual(
    "destroy_plan_required",
  );
  expect(store.findAppCapsule("inst_failed_uninstall")?.status).toEqual(
    "failed",
  );
});

test("accounts handler accepts AppCapsule materialize requests idempotently", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_request",
        accountId: "acct_materialize",
        workspaceId: "space_materialize",
        appId: "example.materialize",
        source: {
          gitUrl: "https://github.com/example/materialize",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
        serviceBindings: [
          {
            serviceBindingId: "bind_materialize_auth",
            name: "auth",
            kind: "identity.oidc",
            configRef:
              "takosumi-deploy-control://installable-app/example.materialize/service-bindings/auth",
          },
          {
            serviceBindingId: "bind_materialize_database",
            name: "database",
            kind: "storage.sql",
            configRef:
              "takosumi-deploy-control://installable-app/example.materialize/service-bindings/database",
          },
          {
            serviceBindingId: "bind_materialize_domain",
            name: "domain",
            kind: "protocol.http.api",
            configRef:
              "takosumi-deploy-control://installable-app/example.materialize/service-bindings/domain",
          },
        ],
        oidcClients: [
          {
            serviceBinding: "auth",
            namespacePath: "takosumi.identity.oidc",
            issuerUrl: "https://accounts.example.test",
            redirectUris: ["https://example.takosumi.test/auth/oidc/callback"],
            allowedScopes: ["openid", "profile"],
            subjectMode: "pairwise",
          },
        ],
      }),
    }),
  );

  const missingKeyResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
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
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
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
  expect((await missingPermissionDigestResponse.json()).error.code).toEqual(
    "invalid_confirm",
  );

  const mismatchedPermissionDigestResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
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
  expect((await mismatchedPermissionDigestResponse.json()).error.code).toEqual(
    "approval_digest_mismatch",
  );

  const materializePlan = {
    compute: "small",
    database: "small",
    objectStore: "standard",
  };
  const materializeCutover = { strategy: "blue-green", drainSeconds: 30 };
  const materializePermissionDigest = await testMaterializePermissionDigest({
    capsuleId: "inst_materialize_request",
    region: "tokyo",
    plan: materializePlan,
    cutover: materializeCutover,
  });
  const request = new Request(
    "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
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
  expect(accepted.capsuleId).toEqual("inst_materialize_request");
  expect(accepted.fromMode).toEqual("shared-cell");
  expect(accepted.toMode).toEqual("dedicated");
  expect(typeof accepted.preserveDigest).toEqual("string");
  expect(accepted.preserve.dataNamespace).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_materialize_request",
  );
  expect(accepted.preserve.oidcClient.issuerUrl).toEqual(
    "https://accounts.example.test",
  );
  expect(accepted.preserve.oidcClient.redirectUris).toEqual([
    "https://example.takosumi.test/auth/oidc/callback",
  ]);
  expect(
    accepted.preserve.serviceBindings.map(
      (serviceBinding: { name: string }) => serviceBinding.name,
    ),
  ).toEqual(["auth", "database", "domain"]);
  expect(accepted.preserve.serviceBindings[0].configRef).toContain(
    "takosumi-accounts://installations/inst_materialize_request/service-bindings/auth/oidc-client/",
  );
  expect(accepted.trackingUrl).toContain("installation.materialize-requested");

  const repeatedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
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
  expect((await repeatedResponse.json()).operationId).toEqual(
    accepted.operationId,
  );

  const bodyMismatchResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-1" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "osaka",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              capsuleId: "inst_materialize_request",
              region: "osaka",
            }),
          },
        }),
      },
    ),
  );
  expect(bodyMismatchResponse.status).toEqual(409);
  expect((await bodyMismatchResponse.json()).error.code).toEqual(
    "idempotency_key_conflict",
  );

  const conflictingResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-2" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              capsuleId: "inst_materialize_request",
              region: "tokyo",
            }),
          },
        }),
      },
    ),
  );
  expect(conflictingResponse.status).toEqual(409);
  expect(
    store
      .listCapsuleEvents("inst_materialize_request")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "oidc_client.registered",
    "service_binding.materialized",
    "installation.materialize-requested",
  ]);
  expect(store.findAppCapsule("inst_materialize_request")?.mode).toEqual(
    "shared-cell",
  );

  const filteredEventsResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/events?types=installation.materialize-requested",
    ),
  );
  expect(filteredEventsResponse.status).toEqual(200);
  const filteredEvents = await filteredEventsResponse.json();
  expect(filteredEvents.hash_chain_valid).toEqual(true);
  expect(
    filteredEvents.events.map((event: { type: string }) => event.type),
  ).toEqual(["installation.materialize-requested"]);
  expect(filteredEvents.events[0].payload.preserveDigest).toEqual(
    accepted.preserveDigest,
  );

  const mismatchedCompleteResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/status",
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
  expect((await mismatchedCompleteResponse.json()).error.code).toEqual(
    "preservation_mismatch",
  );

  const completeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/status",
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
  expect(complete.event.payload.preserveDigest).toEqual(
    accepted.preserveDigest,
  );
  expect(
    store.findRuntimeBinding("rtb_materialize_dedicated")?.targetId,
  ).toEqual("tokyo-dedicated-01");

  const repeatedCompleteResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_request/status",
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

test("accounts handler records AppCapsule materialize operation failures", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_failure",
        accountId: "acct_materialize_failure",
        workspaceId: "space_materialize_failure",
        appId: "example.materialize-failure",
        source: {
          gitUrl: "https://github.com/example/materialize-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_failure/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-failure" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              capsuleId: "inst_materialize_failure",
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
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_failure/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          operation: "materialize",
          operationId,
          reason:
            "dedicated runtime failed Authorization: Bearer materialize-status-token",
          error:
            "provider error DATABASE_URL=postgres://user:statuspass@db.example/takos apiKey=sk-status-raw",
        }),
      },
    ),
  );
  expect(failedResponse.status).toEqual(200);
  const failedBody = await failedResponse.json();
  expect(failedBody.event.type).toEqual("installation.materialize-failed");
  expect(failedBody.event.payload.reason).toEqual("materialize worker failed");
  expect(failedBody.event.payload.error).toEqual("materialize worker failed");
  expect(JSON.stringify(failedBody)).not.toContain("materialize-status-token");
  expect(JSON.stringify(failedBody)).not.toContain("statuspass");
  expect(JSON.stringify(failedBody)).not.toContain("sk-status-raw");
  const storedFailedEventsText = JSON.stringify(
    store.listCapsuleEvents("inst_materialize_failure"),
  );
  expect(storedFailedEventsText).not.toContain("materialize-status-token");
  expect(storedFailedEventsText).not.toContain("statuspass");
  expect(storedFailedEventsText).not.toContain("sk-status-raw");
  expect(
    store
      .listCapsuleEvents("inst_materialize_failure")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "installation.materialize-requested",
    "installation.status_changed",
    "installation.materialize-failed",
  ]);
});

test("accounts handler can close materialize operation before cutover without failing installation", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_cancel",
        accountId: "acct_materialize_cancel",
        workspaceId: "space_materialize_cancel",
        appId: "example.materialize-cancel",
        source: {
          gitUrl: "https://github.com/example/materialize-cancel",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_materialize_cancel",
      }),
    }),
  );

  const materializeResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_cancel/materialize",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-materialize-cancel" },
        body: JSON.stringify({
          mode: "dedicated",
          region: "tokyo",
          confirm: {
            costAck: true,
            permissionDigest: await testMaterializePermissionDigest({
              capsuleId: "inst_materialize_cancel",
              region: "tokyo",
            }),
          },
        }),
      },
    ),
  );
  expect(materializeResponse.status).toEqual(202);
  const operationId = (await materializeResponse.json()).operationId;

  const cancelResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_cancel/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ready",
          operation: "materialize",
          operationId,
          reason: "materialize canceled before cutover",
        }),
      },
    ),
  );
  expect(cancelResponse.status).toEqual(200);
  const cancelBody = await cancelResponse.json();
  expect(cancelBody.installation.status).toEqual("ready");
  expect(cancelBody.installation.mode).toEqual("shared-cell");
  expect(cancelBody.event.type).toEqual("installation.materialize-failed");
  expect(cancelBody.event.payload.reason).toEqual(
    "materialize canceled before cutover",
  );
  expect(store.findAppCapsule("inst_materialize_cancel")?.status).toEqual(
    "ready",
  );
  expect(store.findAppCapsule("inst_materialize_cancel")?.mode).toEqual(
    "shared-cell",
  );
  expect(
    store
      .listCapsuleEvents("inst_materialize_cancel")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "installation.materialize-requested",
    "installation.materialize-failed",
  ]);

  const repeatedCancelResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_cancel/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ready",
          operation: "materialize",
          operationId,
          reason: "materialize canceled before cutover",
        }),
      },
    ),
  );
  expect(repeatedCancelResponse.status).toEqual(409);
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
      const preserveBindings = Array.isArray(input.preserve.serviceBindings)
        ? (input.preserve.serviceBindings as readonly Record<string, unknown>[])
        : [];
      const preserveOidc =
        typeof input.preserve.oidcClient === "object" &&
        input.preserve.oidcClient !== null
          ? (input.preserve.oidcClient as { readonly issuerUrl?: unknown })
          : undefined;
      const preserveRuntime =
        typeof input.preserve.runtimeTarget === "object" &&
        input.preserve.runtimeTarget !== null
          ? (input.preserve.runtimeTarget as { readonly targetId?: unknown })
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
          sourceDataNamespace:
            typeof input.preserve.dataNamespace === "string"
              ? input.preserve.dataNamespace
              : null,
          oidcClient: preserveOidc
            ? ({ ...preserveOidc } as Record<string, unknown>)
            : null,
          preservedServiceBindings: preserveBindings.map((binding) => ({
            name: String(binding.name ?? ""),
            kind: String(binding.kind ?? "") as ServiceBindingMaterialKind,
            configRef: String(binding.configRef ?? ""),
            secretRefs: Array.isArray(binding.secretRefs)
              ? binding.secretRefs.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [],
          })),
          cutover: {
            fromTargetId:
              typeof preserveRuntime?.targetId === "string"
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_worker",
        accountId: "acct_materialize_worker",
        workspaceId: "space_materialize_worker",
        appId: "example.materialize-worker",
        source: {
          gitUrl: "https://github.com/example/materialize-worker",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
        serviceBindings: [
          {
            serviceBindingId: "bind_materialize_worker_auth",
            name: "auth",
            kind: "identity.oidc",
            configRef:
              "takosumi-deploy-control://installable-app/example.materialize-worker/service-bindings/auth",
          },
          {
            serviceBindingId: "bind_materialize_worker_domain",
            name: "domain",
            kind: "protocol.http.api",
            configRef:
              "takosumi-deploy-control://installable-app/example.materialize-worker/service-bindings/domain",
          },
        ],
        oidcClients: [
          {
            serviceBinding: "auth",
            namespacePath: "takosumi.identity.oidc",
            issuerUrl: "https://accounts.example.test",
            redirectUris: [
              "https://materialize-worker.example.test/auth/oidc/callback",
            ],
            allowedScopes: ["openid", "profile"],
            subjectMode: "pairwise",
          },
        ],
      }),
    }),
  );

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_worker/materialize",
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
              capsuleId: "inst_materialize_worker",
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
  expect(body.runtime_target.target_id).toEqual(
    "dedicated://tokyo/inst_materialize_worker",
  );
  expect(body.event.type).toEqual("installation.materialize-succeeded");
  expect(body.event.payload.preserveDigest).toEqual(body.preserveDigest);
  expect(captured.operationId).toEqual(body.operationId);
  expect(captured.dataNamespace).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_materialize_worker",
  );
  expect(captured.oidcIssuer).toEqual("https://accounts.example.test");
  expect(captured.bindingNames).toEqual(["auth", "domain"]);
  expect(
    store.findAppCapsule("inst_materialize_worker")?.runtimeBindingId,
  ).toEqual("rtb_materialize_worker_dedicated");
  expect(
    store.findRuntimeBinding("rtb_materialize_worker_dedicated")?.targetType,
  ).toEqual("dedicated");
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
        preservedServiceBindings: [],
        cutover: {
          fromTargetId: "shared-cell://wrong/namespaces/other",
          toTargetId: "dedicated://tokyo/inst_materialize_mismatch",
          ready: true,
        },
      },
    }),
  });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_mismatch",
        accountId: "acct_materialize_mismatch",
        workspaceId: "space_materialize_mismatch",
        appId: "example.materialize-mismatch",
        source: {
          gitUrl: "https://github.com/example/materialize-mismatch",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_mismatch/materialize",
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
              capsuleId: "inst_materialize_mismatch",
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
  expect(body.error).toEqual(
    "materialize worker continuity sourceDataNamespace mismatch",
  );
  expect(store.findAppCapsule("inst_materialize_mismatch")?.mode).toEqual(
    "shared-cell",
  );
  expect(
    store.findAppCapsule("inst_materialize_mismatch")?.runtimeBindingId,
  ).toEqual("rtb_materialize_mismatch_shared");
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialize_worker_failure",
        accountId: "acct_materialize_worker_failure",
        workspaceId: "space_materialize_worker_failure",
        appId: "example.materialize-worker-failure",
        source: {
          gitUrl: "https://github.com/example/materialize-worker-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_materialize_worker_failure/materialize",
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
              capsuleId: "inst_materialize_worker_failure",
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
  expect(body.error).toEqual("materialize worker failed");
  expect(body.event.type).toEqual("installation.materialize-failed");
  expect(body.event.payload.error).toEqual("materialize worker failed");
  expect(JSON.stringify(body)).not.toContain("copy failed");
  expect(store.findAppCapsule("inst_materialize_worker_failure")?.mode).toEqual(
    "shared-cell",
  );
  expect(
    store.findAppCapsule("inst_materialize_worker_failure")?.status,
  ).toEqual("ready");
  expect(
    store.findAppCapsule("inst_materialize_worker_failure")?.runtimeBindingId,
  ).toEqual("rtb_materialize_worker_failure_shared");
});

test("accounts handler rejects operation completion without request event", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_missing_operation",
        accountId: "acct_missing_operation",
        workspaceId: "space_missing_operation",
        appId: "example.missing-operation",
        source: {
          gitUrl: "https://github.com/example/missing-operation",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_missing_operation/status",
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
  expect((await exportedResponse.json()).error.code).toEqual(
    "operation_not_found",
  );
  expect(store.findAppCapsule("inst_missing_operation")?.status).toEqual(
    "ready",
  );

  const failedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_missing_operation/status",
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
  expect((await failedResponse.json()).error.code).toEqual(
    "operation_not_found",
  );
  expect(store.findAppCapsule("inst_missing_operation")?.status).toEqual(
    "ready",
  );
});

test("accounts handler accepts AppCapsule export requests and exposes pending operation", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    store,
    exportDownloadSigningSecret: "test-export-download-secret",
  });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_export_request",
        accountId: "acct_export",
        workspaceId: "space_export",
        appId: "example.export",
        source: {
          gitUrl: "https://github.com/example/export",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_export_request/export",
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
  expect(acceptedResponse.headers.get("location") ?? "").toContain(
    `/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}`,
  );

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  expect((await operationResponse.json()).operationId).toEqual(
    accepted.operationId,
  );

  const pendingDownloadResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}/download`,
    ),
  );
  expect(pendingDownloadResponse.status).toEqual(409);
  expect((await pendingDownloadResponse.json()).error.code).toEqual(
    "export_not_ready",
  );

  const repeatedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_request/export",
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
  expect((await repeatedResponse.json()).operationId).toEqual(
    accepted.operationId,
  );

  const bodyMismatchResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_request/export",
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
  expect((await bodyMismatchResponse.json()).error.code).toEqual(
    "idempotency_key_conflict",
  );

  const insecureExportedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "exported",
          reason: "bundle ready",
          operationId: accepted.operationId,
          downloadUrl: "http://downloads.example.test/export.tar.zst",
          downloadExpiresAt: "2999-05-10T00:00:00.000Z",
        }),
      },
    ),
  );
  expect(insecureExportedResponse.status).toEqual(400);
  expect((await insecureExportedResponse.json()).error.code).toEqual(
    "invalid_request",
  );

  const exportedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_request/status",
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "exported",
          reason: "bundle ready",
          operationId: accepted.operationId,
          downloadUrl: "https://downloads.example.test/export.tar.zst",
          downloadExpiresAt: "2999-05-10T00:00:00.000Z",
          archiveDigest: `sha256:${"c".repeat(64)}`,
        }),
      },
    ),
  );
  expect(exportedResponse.status).toEqual(200);
  const exportedStatusBody = await exportedResponse.json();
  expect(exportedStatusBody.event.type).toEqual("installation.exported");
  expect(exportedStatusBody.event.payload.downloadUrl).toEqual(
    `/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}/download`,
  );
  expect(exportedStatusBody.event.payload.archiveDigest).toEqual(
    `sha256:${"c".repeat(64)}`,
  );
  expect(JSON.stringify(exportedStatusBody.event)).not.toContain(
    "https://downloads.example.test",
  );

  const completedOperationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}`,
    ),
  );
  expect(completedOperationResponse.status).toEqual(200);
  const completedOperation = await completedOperationResponse.json();
  expect(completedOperation.status).toEqual("exported");
  expect(completedOperation.archiveDigest).toEqual(`sha256:${"c".repeat(64)}`);
  expect(completedOperation.downloadUrl).toEqual(
    `/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}/download`,
  );

  const downloadResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_request/exports/${accepted.operationId}/download`,
    ),
  );
  // The public operation status returns only the account-plane download route.
  // The handler keeps the raw artifact URL in the ledger and signs it only when
  // serving the authenticated download redirect.
  expect(downloadResponse.status).toEqual(302);
  const downloadLocation = downloadResponse.headers.get("location") ?? "";
  expect(downloadLocation).toContain(
    "https://downloads.example.test/export.tar.zst",
  );
  expect(downloadLocation).toContain("tk_sig=");
  expect(downloadLocation).toContain("tk_exp=");

  const repeatedExportedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_request/status",
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
  expect((await repeatedExportedResponse.json()).error.code).toEqual(
    "operation_already_closed",
  );

  expect(
    store
      .listCapsuleEvents("inst_export_request")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "installation.export-requested",
    "installation.status_changed",
    "installation.exported",
  ]);
});

test("accounts handler rejects data export without age encryption", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_export_plain_data",
        accountId: "acct_export_plain_data",
        workspaceId: "space_export_plain_data",
        appId: "example.export-plain-data",
        source: {
          gitUrl: "https://github.com/example/export-plain-data",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_export_plain_data",
      }),
    }),
  );

  const response = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_plain_data/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-plain-data" },
        body: JSON.stringify({
          includeData: true,
          format: "bundle",
          encryption: { method: "none" },
          scope: {},
        }),
      },
    ),
  );

  expect(response.status).toEqual(400);
  const body = await response.json();
  expect(body.error.code).toEqual("invalid_request");
  expect(body.error.message).toEqual(
    "export includeData requires age encryption",
  );
  expect(store.listCapsuleEvents("inst_export_plain_data").length).toEqual(1);
});

test("accounts handler rejects malformed export request fields", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_export_malformed",
        accountId: "acct_export_malformed",
        workspaceId: "space_export_malformed",
        appId: "example.export-malformed",
        source: {
          gitUrl: "https://github.com/example/export-malformed",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
          artifactDigest: "sha256:compiled",
        },
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_export_malformed",
      }),
    }),
  );

  const cases: readonly {
    readonly name: string;
    readonly body: unknown;
    readonly message: string;
  }[] = [
    {
      name: "array-body",
      body: [],
      message: "invalid request",
    },
    {
      name: "numeric-format",
      body: { format: 1, encryption: {}, scope: {} },
      message: "export requires format=bundle with object encryption and scope",
    },
    {
      name: "array-encryption",
      body: { format: "bundle", encryption: [], scope: {} },
      message: "export requires format=bundle with object encryption and scope",
    },
    {
      name: "numeric-method",
      body: { format: "bundle", encryption: { method: 1 }, scope: {} },
      message:
        "export encryption.method must be none or age; age requires recipients and none forbids recipients",
    },
    {
      name: "string-recipients",
      body: {
        format: "bundle",
        encryption: { method: "age", recipients: "age1not-an-array" },
        scope: {},
      },
      message:
        "export encryption.method must be none or age; age requires recipients and none forbids recipients",
    },
    {
      name: "none-with-recipients",
      body: {
        format: "bundle",
        encryption: { method: "none", recipients: ["age1unused"] },
        scope: {},
      },
      message:
        "export encryption.method must be none or age; age requires recipients and none forbids recipients",
    },
    {
      name: "string-include-data",
      body: {
        format: "bundle",
        includeData: "true",
        encryption: { method: "age", recipients: ["age1recipient"] },
        scope: {},
      },
      message: "export includeData must be a boolean",
    },
    {
      name: "array-scope",
      body: { format: "bundle", encryption: {}, scope: [] },
      message: "export requires format=bundle with object encryption and scope",
    },
  ];

  for (const testCase of cases) {
    const response = await handler(
      new Request(
        "https://accounts.example.test/v1/capsule-projections/inst_export_malformed/export",
        {
          method: "POST",
          headers: { "Idempotency-Key": `idem-export-${testCase.name}` },
          body: JSON.stringify(testCase.body),
        },
      ),
    );
    expect(response.status).toEqual(400);
    const body = await response.json();
    expect(body.error.code).toEqual("invalid_request");
    expect(body.error.message).toEqual(testCase.message);
  }

  expect(store.listCapsuleEvents("inst_export_malformed").length).toEqual(1);
});

test("accounts handler runs configured export worker and closes operation", async () => {
  const store = new InMemoryAccountsStore();
  const captured: {
    operationId?: string;
    requestIncludeData?: boolean;
    bundleKind?: string;
    sourceCommit?: string;
    serviceBindingNames?: readonly string[];
    serviceGrantIds?: readonly string[];
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
      captured.serviceBindingNames = input.bundle.serviceBindings.map(
        (serviceBinding) => serviceBinding.name,
      );
      captured.serviceGrantIds = input.bundle.serviceGrants.map(
        (scope) => scope.serviceGrantId,
      );
      captured.eventTypes = input.bundle.events.map((event) => event.type);
      return {
        downloadUrl: `https://downloads.example.test/${input.operationId}/takos-export.tar.zst`,
        downloadExpiresAt: "2999-05-10T00:00:00.000Z",
        archiveDigest: `sha256:${"b".repeat(64)}`,
      };
    },
  });

  const createResponse = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_export_worker",
        accountId: "acct_export_worker",
        workspaceId: "space_export_worker",
        appId: "example.export-worker",
        source: {
          gitUrl: "https://github.com/example/export-worker",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
        serviceBindings: [
          {
            serviceBindingId: "bind_export_auth",
            name: "auth",
            kind: "identity.oidc",
            configRef: "config://export/auth",
          },
        ],
        oidcClients: [
          {
            namespacePath: "takosumi.identity.oidc",
            issuerUrl: "https://accounts.example.test",
            redirectUris: ["https://app.example.test/auth/callback"],
            allowedScopes: ["openid", "profile"],
            subjectMode: "pairwise",
            tokenEndpointAuthMethod: "none",
          },
        ],
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_worker/export",
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
  expect(exported.downloadUrl).toEqual(
    `/v1/capsule-projections/inst_export_worker/exports/${exported.operationId}/download`,
  );
  expect(exported.archiveDigest).toEqual(`sha256:${"b".repeat(64)}`);
  expect(exported.event.type).toEqual("installation.exported");
  expect(exported.event.payload.downloadUrl).toEqual(
    `/v1/capsule-projections/inst_export_worker/exports/${exported.operationId}/download`,
  );
  expect(exported.event.payload.archiveDigest).toEqual(
    `sha256:${"b".repeat(64)}`,
  );
  expect(JSON.stringify(exported.event)).not.toContain(
    "https://downloads.example.test",
  );
  expect(captured.operationId).toEqual(exported.operationId);
  expect(captured.requestIncludeData).toEqual(false);
  expect(captured.bundleKind).toEqual(
    "takosumi.accounts.capsule-export-bundle@v1",
  );
  expect(captured.sourceCommit).toEqual(
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(captured.serviceBindingNames).toEqual(["auth"]);
  expect(captured.serviceGrantIds).toEqual([]);
  expect(captured.eventTypes).toEqual([
    "installation.created",
    "oidc_client.registered",
    "service_binding.materialized",
    "installation.export-requested",
  ]);
  expect(store.findAppCapsule("inst_export_worker")?.status).toEqual(
    "exported",
  );

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_worker/exports/${exported.operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  const operationBody = await operationResponse.json();
  expect(operationBody.status).toEqual("exported");
  expect(operationBody.archiveDigest).toEqual(`sha256:${"b".repeat(64)}`);

  const repeatedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_export_worker/export",
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
      `https://accounts.example.test/v1/capsule-projections/inst_export_worker/exports/${exported.operationId}/download`,
    ),
  );
  // Download endpoint signs the raw artifact URL only at redirect time.
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_export_worker_failure",
        accountId: "acct_export_worker_failure",
        workspaceId: "space_export_worker_failure",
        appId: "example.export-worker-failure",
        source: {
          gitUrl: "https://github.com/example/export-worker-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_export_worker_failure/export",
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
  expect(body.error).toEqual("export worker failed");
  expect(body.event.type).toEqual("installation.export-failed");
  expect(body.event.payload.error).toEqual("export worker failed");
  expect(JSON.stringify(body)).not.toContain("archive upload failed");
  expect(store.findAppCapsule("inst_export_worker_failure")?.status).toEqual(
    "failed",
  );

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_worker_failure/exports/${body.operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  const operationBody = await operationResponse.json();
  expect(operationBody.status).toEqual("failed");
  expect(operationBody.error).toEqual("export worker failed");
  expect(JSON.stringify(operationBody)).not.toContain("archive upload failed");
});

test("accounts handler moves AppCapsule through materialize and export lifecycle", async () => {
  const sourceStore = new InMemoryAccountsStore();
  let exportedBundle: AccountsCapsuleExportBundle | undefined;
  const sourceHandler = createAccountsHandler({
    issuer: "https://accounts.source.test",
    store: sourceStore,
    materializeWorker: (input) => {
      const preserveBindings = Array.isArray(input.preserve.serviceBindings)
        ? input.preserve.serviceBindings.filter(
            (binding): binding is Record<string, unknown> =>
              typeof binding === "object" && binding !== null,
          )
        : [];
      const preserveOidc =
        typeof input.preserve.oidcClient === "object" &&
        input.preserve.oidcClient !== null
          ? (input.preserve.oidcClient as Record<string, unknown>)
          : null;
      const preserveRuntime =
        typeof input.preserve.runtimeTarget === "object" &&
        input.preserve.runtimeTarget !== null
          ? (input.preserve.runtimeTarget as { readonly targetId?: unknown })
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
          sourceDataNamespace:
            typeof input.preserve.dataNamespace === "string"
              ? input.preserve.dataNamespace
              : null,
          oidcClient: preserveOidc ? { ...preserveOidc } : null,
          preservedServiceBindings: preserveBindings.map((binding) => ({
            name: String(binding.name ?? ""),
            kind: String(binding.kind ?? "") as ServiceBindingMaterialKind,
            configRef: String(binding.configRef ?? ""),
            secretRefs: Array.isArray(binding.secretRefs)
              ? binding.secretRefs.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : [],
          })),
          cutover: {
            fromTargetId:
              typeof preserveRuntime?.targetId === "string"
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
        downloadUrl: `https://downloads.source.test/${input.operationId}/takos-export.tar.zst`,
        downloadExpiresAt: "2999-05-10T00:00:00.000Z",
      };
    },
  });

  const createResponse = await sourceHandler(
    new Request("https://accounts.source.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_lifecycle",
        accountId: "acct_source",
        workspaceId: "space_source",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
        serviceBindings: [
          {
            serviceBindingId: "bind_lifecycle_auth",
            name: "auth",
            kind: "identity.oidc",
            configRef:
              "takosumi-deploy-control://installable-app/takos.chat/service-bindings/auth",
          },
        ],
        oidcClients: [
          {
            serviceBinding: "auth",
            namespacePath: "takosumi.identity.oidc",
            issuerUrl: "https://accounts.source.test",
            redirectUris: ["https://takos.example.test/auth/oidc/callback"],
            allowedScopes: ["openid", "profile"],
            subjectMode: "pairwise",
            tokenEndpointAuthMethod: "none",
          },
        ],
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);

  const materializeResponse = await sourceHandler(
    new Request(
      "https://accounts.source.test/v1/capsule-projections/inst_lifecycle/materialize",
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
              capsuleId: "inst_lifecycle",
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
  const lifecycleRtb =
    sourceStore.findAppCapsule("inst_lifecycle")?.runtimeBindingId;
  expect(
    sourceStore.findRuntimeBinding(lifecycleRtb ?? "")?.targetType,
  ).toEqual("dedicated");
  expect(sourceStore.findRuntimeBinding(lifecycleRtb ?? "")?.targetId).toEqual(
    "dedicated://tokyo/inst_lifecycle",
  );
  expect(materialized.event.type).toEqual("installation.materialize-succeeded");
  expect(sourceStore.findAppCapsule("inst_lifecycle")?.mode).toEqual(
    "dedicated",
  );

  const exportResponse = await sourceHandler(
    new Request(
      "https://accounts.source.test/v1/capsule-projections/inst_lifecycle/export",
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
  expect(exported.downloadUrl).toEqual(
    `/v1/capsule-projections/inst_lifecycle/exports/${exported.operationId}/download`,
  );
  if (!exportedBundle) {
    throw new Error("expected export worker to receive installation bundle");
  }
  expect(exportedBundle.installation.mode).toEqual("dedicated");
  expect(exportedBundle.runtimeTarget?.targetType).toEqual("dedicated");
  expect(exportedBundle.oidcClient?.issuerUrl).toEqual(
    "https://accounts.source.test",
  );
  expect(
    exportedBundle.serviceGrants.map((scope) => scope.serviceGrantId),
  ).toEqual([]);
  expect(exportedBundle.events.map((event) => event.type)).toEqual([
    "installation.created",
    "oidc_client.registered",
    "service_binding.materialized",
    "installation.materialize-requested",
    "installation.materialize-succeeded",
    "installation.export-requested",
  ]);
  expect(sourceStore.findAppCapsule("inst_lifecycle")?.status).toEqual(
    "exported",
  );

  const targetHandler = createAccountsHandler({
    issuer: "https://accounts.target.test",
  });
  const importResponse = await targetHandler(
    new Request("https://accounts.target.test/v1/capsule-projections/import", {
      method: "POST",
      body: JSON.stringify({
        bundle: exportedBundle,
        targetIssuer: "https://accounts.target.test",
        targetAccountId: "acct_target",
        targetWorkspaceId: "space_target",
        targetCapsuleId: "inst_lifecycle_imported",
        createdBySubject: "tsub_target",
      }),
    }),
  );
  expect(importResponse.status).toEqual(404);
});

test("accounts handler records AppCapsule export operation failures", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({ store });

  await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_export_failure",
        accountId: "acct_export_failure",
        workspaceId: "space_export_failure",
        appId: "example.export-failure",
        source: {
          gitUrl: "https://github.com/example/export-failure",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections/inst_export_failure/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-export-failure" },
        body: JSON.stringify({
          includeData: false,
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
      "https://accounts.example.test/v1/capsule-projections/inst_export_failure/status",
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
  expect((await failedResponse.json()).event.type).toEqual(
    "installation.export-failed",
  );

  const operationResponse = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_export_failure/exports/${operationId}`,
    ),
  );
  expect(operationResponse.status).toEqual(200);
  const operation = await operationResponse.json();
  expect(operation.status).toEqual("failed");
  expect(operation.error).toEqual("export failed");
  expect(JSON.stringify(operation)).not.toContain("bundle writer failed");
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_launch_binding",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            serviceBindingId: "bind_bootstrap",
            name: "bootstrap",
            kind: "auth.bootstrap_token",
            configRef:
              "takosumi-deploy-control://installable-app/takos.chat/service-bindings/bootstrap/sha256:pending",
          },
        ],
      }),
    }),
  );
  expect(createResponse.status).toEqual(202);
  const created = await createResponse.json();
  void created;
  // Wave 6 (Phase E SQL drift fix): `service_bindings` was removed from the
  // envelope. The materialize route still saves the binding in the
  // ledger so we assert via the in-memory store.
  const launchBinding = store
    .listServiceBindingMaterialsForCapsule("inst_launch_binding")
    .find((b) => b.name === "bootstrap");
  expect(launchBinding?.configRef).toEqual(
    [
      "takosumi-accounts://installations/inst_launch_binding",
      "service-bindings/bootstrap/launch-token",
    ].join("/"),
  );
  expect(launchBinding?.secretRefs).toEqual([]);
  expect(
    store
      .listCapsuleEvents("inst_launch_binding")
      .map((event) => event.eventType),
  ).toEqual(["installation.created", "service_binding.materialized"]);
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_shared_launch",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "bootstrap",
            kind: "auth.bootstrap_token",
            configRef:
              "takosumi-deploy-control://installable-app/takos.chat/service-bindings/bootstrap/sha256:pending",
          },
        ],
      }),
    }),
  );

  expect(createResponse.status).toEqual(202);
  const created = await createResponse.json();
  void created;
  // Wave 6 (Phase E SQL drift fix): `runtime_target` / `service_bindings`
  // were removed from the envelope; assert via the in-memory ledger.
  expect(
    store.findRuntimeBinding("rtb_inst_shared_launch_shared_cell")?.targetId,
  ).toEqual("shared-cell://tokyo-cell-01/namespaces/inst_shared_launch");
  const sharedLaunchBinding = store
    .listServiceBindingMaterialsForCapsule("inst_shared_launch")
    .find((b) => b.name === "bootstrap");
  expect(sharedLaunchBinding?.configRef).toEqual(
    [
      "takosumi-accounts://installations/inst_shared_launch",
      "service-bindings/bootstrap/launch-token",
    ].join("/"),
  );
  expect(
    store
      .listCapsuleEvents("inst_shared_launch")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "runtime_target.assigned",
    "service_binding.materialized",
  ]);
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
  async function createSharedInstall(capsuleId: string): Promise<unknown> {
    const response = await handler(
      new Request("https://accounts.example.test/v1/capsule-projections", {
        method: "POST",
        body: JSON.stringify({
          capsuleId,
          accountId: "acct_1",
          workspaceId: "space_1",
          appId: "takos.chat",
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.3",
            commit: "abc123",
            planDigest: "sha256:app",
          },
          mode: "shared-cell",
          status: "ready",
          createdBySubject: "tsub_owner",
          serviceBindings: [
            {
              name: "bootstrap",
              kind: "auth.bootstrap_token",
              configRef:
                "takosumi-deploy-control://installable-app/takos.chat/service-bindings/bootstrap/sha256:pending",
            },
          ],
        }),
      }),
    );
    expect(response.status).toEqual(202);
    return await response.json();
  }

  void (await createSharedInstall("inst_shared_a"));
  void (await createSharedInstall("inst_shared_b"));
  // Wave 6 (Phase E SQL drift fix): `runtime_target` was removed from
  // the envelope; assert via the in-memory ledger.
  const sharedABinding =
    store.findAppCapsule("inst_shared_a")?.runtimeBindingId;
  const sharedBBinding =
    store.findAppCapsule("inst_shared_b")?.runtimeBindingId;
  expect(store.findRuntimeBinding(sharedABinding ?? "")?.targetId).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_shared_a",
  );
  expect(store.findRuntimeBinding(sharedBBinding ?? "")?.targetId).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_shared_b",
  );
  expect(pool.availableSlots()).toEqual([
    {
      cellId: "tokyo-cell-01",
      capacity: 0,
    },
  ]);
  expect(
    store.listCapsuleEvents("inst_shared_b").map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "runtime_target.assigned",
    "service_binding.materialized",
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
    bindingMaterializer: ({
      installation,
      binding,
    }): ServiceBindingMaterializationResult | undefined => {
      if (binding.kind === "storage.sql") {
        return {
          configRef: `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/postgres/main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/secrets/password`,
          ],
          env: {
            DATABASE_HOST: "db.example.test",
            DATABASE_NAME: installation.capsuleId,
          },
        };
      }
      if (binding.kind === "storage.object") {
        return {
          configRef: `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/object-store/main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/secrets/access-key`,
          ],
          env: {
            BLOB_BUCKET: `${installation.capsuleId}-objects`,
          },
        };
      }
      return undefined;
    },
  });

  async function createIsolatedInstall(input: {
    capsuleId: string;
    billingAccountId: string;
    serviceGrantId: string;
  }): Promise<{
    installation: { billing_account_id: string };
    runtime_target: { target_id: string };
    service_bindings: readonly { name: string; config_ref: string }[];
    service_binding_env: Record<string, string>;
    oidc_client: { client_id: string; redirect_uris: readonly string[] };
    service_grants: readonly {
      id: string;
      installation_id: string;
      capability: string;
      scope: { capsuleId?: string };
      granted_at: string;
      revoked_at: string | null;
    }[];
  }> {
    const response = await handler(
      new Request("https://accounts.example.test/v1/capsule-projections", {
        method: "POST",
        body: JSON.stringify({
          capsuleId: input.capsuleId,
          accountId: "acct_1",
          workspaceId: "space_1",
          billingAccountId: input.billingAccountId,
          appId: "takos.chat",
          source: {
            gitUrl: "https://github.com/takos/takos",
            ref: "v1.2.3",
            commit: "abc123",
            planDigest: "sha256:app",
          },
          mode: "shared-cell",
          status: "ready",
          createdBySubject: "tsub_owner",
          serviceBindings: [
            {
              name: "auth",
              kind: "identity.oidc",
              configRef: `takosumi-deploy-control://installable-app/takos.chat/service-bindings/auth/${input.capsuleId}`,
            },
            {
              name: "database",
              kind: "storage.sql",
              configRef: `takosumi-deploy-control://installable-app/takos.chat/service-bindings/database/${input.capsuleId}`,
            },
            {
              name: "blob",
              kind: "storage.object",
              configRef: `takosumi-deploy-control://installable-app/takos.chat/service-bindings/blob/${input.capsuleId}`,
            },
          ],
          oidcClients: [
            {
              serviceBinding: "auth",
              namespacePath: "takosumi.identity.oidc",
              redirectUris: [
                `https://${input.capsuleId}.example.test/auth/oidc/callback`,
              ],
              allowedScopes: ["openid", "profile"],
              subjectMode: "pairwise",
            },
          ],
          serviceGrants: [
            {
              serviceGrantId: input.serviceGrantId,
              capability: "files:read",
              scope: { capsuleId: input.capsuleId },
            },
          ],
        }),
      }),
    );
    expect(response.status).toEqual(202);
    return await response.json();
  }

  const first = await createIsolatedInstall({
    capsuleId: "inst_iso_a",
    billingAccountId: "billing_inst_a",
    serviceGrantId: "grant_inst_a_files",
  });
  const second = await createIsolatedInstall({
    capsuleId: "inst_iso_b",
    billingAccountId: "billing_inst_b",
    serviceGrantId: "grant_inst_b_files",
  });

  expect(first.installation.billing_account_id).toEqual("billing_inst_a");
  expect(second.installation.billing_account_id).toEqual("billing_inst_b");
  expect(store.findAppCapsule("inst_iso_a")?.billingAccountId).toEqual(
    "billing_inst_a",
  );
  expect(store.findAppCapsule("inst_iso_b")?.billingAccountId).toEqual(
    "billing_inst_b",
  );
  expect(store.findBillingAccount("billing_inst_a")?.stripeCustomerId).toEqual(
    "cus_inst_a",
  );
  expect(store.findBillingAccount("billing_inst_b")?.stripeCustomerId).toEqual(
    "cus_inst_b",
  );
  expect(
    store.findBillingAccountByStripeCustomerId("cus_inst_a")?.billingAccountId,
  ).toEqual("billing_inst_a");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_inst_b")?.billingAccountId,
  ).toEqual("billing_inst_b");
  // Wave 6 (Phase E SQL drift fix): `runtime_target` / `service_bindings` /
  // `service_grants` were removed from the envelope. Per-isolation
  // assertions move to the in-memory ledger.
  const isoARtb = store.findAppCapsule("inst_iso_a")?.runtimeBindingId;
  const isoBRtb = store.findAppCapsule("inst_iso_b")?.runtimeBindingId;
  expect(store.findRuntimeBinding(isoARtb ?? "")?.targetId).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_iso_a",
  );
  expect(store.findRuntimeBinding(isoBRtb ?? "")?.targetId).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_iso_b",
  );
  expect(first.oidc_client.client_id === second.oidc_client.client_id).toEqual(
    false,
  );
  expect(first.oidc_client.redirect_uris).toEqual([
    "https://inst_iso_a.example.test/auth/oidc/callback",
  ]);
  expect(second.oidc_client.redirect_uris).toEqual([
    "https://inst_iso_b.example.test/auth/oidc/callback",
  ]);
  const isoADbBinding = store
    .listServiceBindingMaterialsForCapsule("inst_iso_a")
    .find((b) => b.name === "database");
  const isoBDbBinding = store
    .listServiceBindingMaterialsForCapsule("inst_iso_b")
    .find((b) => b.name === "database");
  expect(isoADbBinding?.configRef).toEqual(
    "takosumi-accounts://installations/inst_iso_a/service-bindings/database/postgres/main",
  );
  expect(isoBDbBinding?.configRef).toEqual(
    "takosumi-accounts://installations/inst_iso_b/service-bindings/database/postgres/main",
  );
  const isoABlobBinding = store
    .listServiceBindingMaterialsForCapsule("inst_iso_a")
    .find((b) => b.name === "blob");
  const isoBBlobBinding = store
    .listServiceBindingMaterialsForCapsule("inst_iso_b")
    .find((b) => b.name === "blob");
  expect(isoABlobBinding?.configRef).toEqual(
    "takosumi-accounts://installations/inst_iso_a/service-bindings/blob/object-store/main",
  );
  expect(isoBBlobBinding?.configRef).toEqual(
    "takosumi-accounts://installations/inst_iso_b/service-bindings/blob/object-store/main",
  );
  expect(first.service_binding_env.BLOB_BUCKET).toEqual("inst_iso_a-objects");
  expect(second.service_binding_env.BLOB_BUCKET).toEqual("inst_iso_b-objects");
  expect(store.listServiceGrantMaterialsForCapsule("inst_iso_a")).toEqual([]);
  expect(store.listServiceGrantMaterialsForCapsule("inst_iso_b")).toEqual([]);
});

test("accounts handler materializes configured provider env bindings", async () => {
  const store = new InMemoryAccountsStore();
  const seenDeclarations: Record<string, unknown>[] = [];
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    bindingMaterializer: ({
      installation,
      binding,
      declaration,
    }): ServiceBindingMaterializationResult | undefined => {
      seenDeclarations.push({ name: binding.name, declaration });
      if (binding.kind === "storage.sql") {
        return {
          configRef: `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/postgres/db-main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/secrets/password`,
          ],
          env: {
            DATABASE_HOST: "db.example.test",
            DATABASE_NAME: "takos",
            DATABASE_SSLMODE: "require",
          },
        };
      }
      if (binding.kind === "storage.object") {
        return {
          configRef: `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/object-store/blob-main`,
          secretRefs: [
            `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/secrets/secret-key`,
          ],
          env: {
            BLOB_ENDPOINT: "https://objects.example.test",
            BLOB_BUCKET: "inst-materialized",
          },
        };
      }
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_materialized",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "db",
            kind: "storage.sql",
            configRef:
              "takosumi-deploy-control://installable-app/takos.chat/service-bindings/db/sha256:pending",
            declaration: {
              type: "storage.sql",
              required: true,
              plan: "small",
            },
          },
          {
            name: "blob",
            kind: "storage.object",
            configRef:
              "takosumi-deploy-control://installable-app/takos.chat/service-bindings/blob/sha256:pending",
            declaration: {
              type: "storage.object",
              required: true,
              plan: "standard",
            },
          },
        ],
      }),
    }),
  );

  expect(response.status).toEqual(202);
  const body = await response.json();
  expect(body.service_binding_env).toEqual({
    DATABASE_HOST: "db.example.test",
    DATABASE_NAME: "takos",
    DATABASE_SSLMODE: "require",
    BLOB_ENDPOINT: "https://objects.example.test",
    BLOB_BUCKET: "inst-materialized",
  });
  // Wave 6 (Phase E SQL drift fix): `service_bindings` was removed from the
  // envelope; assert via the in-memory ledger.
  expect(
    store
      .listServiceBindingMaterialsForCapsule("inst_materialized")
      .map((b) => b.configRef),
  ).toEqual([
    "takosumi-accounts://installations/inst_materialized/service-bindings/db/postgres/db-main",
    "takosumi-accounts://installations/inst_materialized/service-bindings/blob/object-store/blob-main",
  ]);
  expect(
    store
      .listCapsuleEvents("inst_materialized")
      .map((event) => event.eventType),
  ).toEqual([
    "installation.created",
    "service_binding.materialized",
    "service_binding.materialized",
  ]);
  expect(seenDeclarations.map((entry) => entry.declaration)).toEqual([
    { type: "storage.sql", required: true, plan: "small" },
    { type: "storage.object", required: true, plan: "standard" },
  ]);
});

test("accounts handler rejects secret-bearing service binding env material", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
    bindingMaterializer: ({
      installation,
      binding,
    }): ServiceBindingMaterializationResult | undefined => {
      if (binding.kind !== "storage.sql") return undefined;
      return {
        configRef: `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/postgres/db-main`,
        secretRefs: [
          `takosumi-accounts://installations/${installation.capsuleId}/service-bindings/${binding.name}/secrets/password`,
        ],
        env: {
          DATABASE_URL:
            "postgres://takos:must-not-leak@db.example.test:5432/takos",
        },
      };
    },
  });

  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_secret_env_rejected",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "db",
            kind: "storage.sql",
            configRef:
              "takosumi-deploy-control://installable-app/takos.chat/service-bindings/db/sha256:pending",
          },
        ],
      }),
    }),
  );

  expect(response.status).toEqual(422);
  const text = await response.text();
  expect(text).toContain("invalid_binding_materialization");
  expect(text).toContain("DATABASE_URL may carry secret material");
  expect(text).not.toContain("must-not-leak");
});

test("accounts handler rejects internal ServiceBindingMaterial secretRefs in public request bodies", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_bad_empty_refs",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "bootstrap",
            kind: "auth.bootstrap_token",
            configRef: "config://inst_bad_empty_refs/bootstrap",
            secretRefs: [],
          },
        ],
      }),
    }),
  );

  expect(response.status).toEqual(422);
  const body = await response.json();
  expect(body.error.code).toEqual("invalid_service_bindings");
  expect(body.error.message).toContain("must not appear");
});

test("accounts handler rejects ServiceBindingMaterial secret handles in public request bodies", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_bad",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceBindings: [
          {
            name: "bootstrap",
            kind: "auth.bootstrap_token",
            configRef: "config://inst_bad/bootstrap",
            secretRefs: ["secret://inst_bad/bootstrap/private-key"],
          },
        ],
      }),
    }),
  );

  expect(response.status).toEqual(422);
  expect((await response.json()).error.code).toEqual(
    "invalid_service_bindings",
  );
});

test("accounts handler rejects ServiceGrantMaterial records outside the catalog contract", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_bad_grant",
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        createdBySubject: "tsub_owner",
        serviceGrants: [
          {
            serviceGrantId: "grant_unsafe",
            capability: "unsafe.scope",
            scope: {},
          },
        ],
      }),
    }),
  );

  expect(response.status).toEqual(422);
  expect((await response.json()).error.code).toEqual("invalid_service_grants");
});

test("ServiceGrantMaterial parser redacts secret-shaped scope metadata", () => {
  const records = serviceGrantMaterialRecordsFromValue({
    capsuleId: "inst_scope_redaction",
    now: Date.parse("2026-06-17T00:00:00.000Z"),
    value: [
      {
        serviceGrantId: "grant_scope_redaction",
        capability: "logs.read.own",
        scope: {
          pathPrefix: "logs/",
          apiKey: "sk-scope-raw",
          authorization: "Bearer scope-token",
          message: "DATABASE_URL=postgres://user:scopepass@db.example/takos",
        },
      },
    ],
  });
  expect(Array.isArray(records)).toEqual(true);
  const [record] = records as {
    readonly scope: Record<string, unknown>;
  }[];
  expect(record.scope.pathPrefix).toEqual("logs/");
  expect(record.scope.apiKey).toEqual("[REDACTED]");
  expect(record.scope.authorization).toEqual("[REDACTED]");
  expect(record.scope.message).toContain("DATABASE_URL=[REDACTED]");
  expect(JSON.stringify(record.scope)).not.toContain("sk-scope-raw");
  expect(JSON.stringify(record.scope)).not.toContain("scope-token");
  expect(JSON.stringify(record.scope)).not.toContain("scopepass");
});

test("accounts handler emits baseline browser security headers", async () => {
  const handler = createAccountsHandler();
  const response = await handler(
    new Request("https://accounts.example.test/healthz"),
  );

  expect(response.status).toEqual(200);
  expect(response.headers.get("x-content-type-options")).toEqual("nosniff");
  expect(response.headers.get("x-frame-options")).toEqual("DENY");
  expect(response.headers.get("referrer-policy")).toEqual(
    "strict-origin-when-cross-origin",
  );
  // HTTPS issuer in test fixtures => HSTS is emitted.
  expect(response.headers.get("strict-transport-security") ?? "").toContain(
    "max-age=31536000",
  );
  expect(response.headers.get("strict-transport-security") ?? "").toContain(
    "includeSubDomains",
  );
});

test("accounts handler omits HSTS for non-HTTPS issuers", async () => {
  const handler = createRawAccountsHandler({
    issuer: "http://localhost:8787",
    platformAccess: testPlatformReadinessOpenAccess,
  });
  const response = await handler(new Request("http://localhost:8787/healthz"));

  expect(response.status).toEqual(200);
  expect(response.headers.get("strict-transport-security")).toEqual(null);
  expect(response.headers.get("x-content-type-options")).toEqual("nosniff");
});

test("accounts handler paginates AppCapsule list via cursor and limit", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: "acct_page",
    legalOwnerSubject: "tsub_page_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveWorkspace({
    workspaceId: "space_page",
    accountId: "acct_page",
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
  const session = seedAccountSession(store, "tsub_page_owner");
  for (let i = 0; i < 5; i += 1) {
    store.saveAppCapsule({
      capsuleId: `inst_page_${i}`,
      accountId: "acct_page",
      workspaceId: "space_page",
      appId: `example.page-${i}`,
      sourceGitUrl: `https://github.com/example/page-${i}`,
      sourceRef: "v1.0.0",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      planDigest: "sha256:app",
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
      "https://accounts.example.test/v1/capsule-projections?space_id=space_page&limit=2",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(firstPage.status).toEqual(200);
  const firstBody = await firstPage.json();
  expect(firstBody.installations.length).toEqual(2);
  expect(typeof firstBody.next_cursor).toEqual("string");

  const secondPage = await handler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections?space_id=space_page&limit=2&cursor=${encodeURIComponent(
        firstBody.next_cursor,
      )}`,
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(secondPage.status).toEqual(200);
  const secondBody = await secondPage.json();
  expect(secondBody.installations.length).toEqual(2);
  // The serialized envelope exposes `id` (not `capsuleId`) for the
  // account-plane wire shape (see `serializeAppCapsule`).
  expect(secondBody.installations[0].id).toEqual("inst_page_2");

  const malformedCursor = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections?space_id=space_page&cursor=%21%21%21",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(malformedCursor.status).toEqual(400);

  const overlimit = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections?space_id=space_page&limit=-3",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(overlimit.status).toEqual(400);
});

test("accounts handler hides archived and destroyed core AppCapsule projections from the default list", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: "acct_projection_sync",
    legalOwnerSubject: "tsub_projection_sync",
    createdAt: now,
    updatedAt: now,
  });
  store.saveWorkspace({
    workspaceId: "space_projection_sync",
    accountId: "acct_projection_sync",
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
  const session = seedAccountSession(store, "tsub_projection_sync");
  for (const [index, status] of (
    [
      ["inst_projection_ready", "ready"],
      ["inst_projection_destroyed", "installing"],
      ["inst_projection_exported", "exported"],
    ] as const
  ).entries()) {
    store.saveAppCapsule({
      capsuleId: status[0],
      accountId: "acct_projection_sync",
      workspaceId: "space_projection_sync",
      appId: `example.${status[0]}`,
      sourceGitUrl: `https://github.com/example/${status[0]}`,
      sourceRef: "v1.0.0",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      planDigest: "sha256:app",
      mode: "shared-cell",
      status: status[1],
      createdBySubject: "tsub_projection_sync",
      createdAt: now + index,
      updatedAt: now + index,
    });
  }
  const handler = createAccountsHandler({
    store,
    deployControl: {
      operations: deployControlOperationsStub({
        getCapsule: (id) =>
          Promise.resolve({
            capsule: {
              id,
              workspaceId: "space_projection_sync",
              name: id,
              slug: id,
              installConfigId: "cfg_projection_sync",
              environment: "prod",
              currentStateGeneration: id === "inst_projection_ready" ? 1 : 0,
              status:
                id === "inst_projection_destroyed" ? "destroyed" : "active",
              createdAt: new Date(now).toISOString(),
              updatedAt: new Date(now).toISOString(),
            },
          } as unknown as GetCapsuleResponse),
      }),
    },
  });

  const visibleResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections?space_id=space_projection_sync",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(visibleResponse.status).toEqual(200);
  const visibleBody = await visibleResponse.json();
  expect(
    visibleBody.installations.map((item: { id: string }) => item.id),
  ).toEqual(["inst_projection_ready"]);
  expect(store.findAppCapsule("inst_projection_destroyed")?.status).toEqual(
    "exported",
  );

  const archivedResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections?space_id=space_projection_sync&include_exported=true",
      { headers: accountSessionHeaders(session) },
    ),
  );
  expect(archivedResponse.status).toEqual(200);
  const archivedBody = await archivedResponse.json();
  expect(
    archivedBody.installations.map((item: { id: string }) => item.id),
  ).toEqual([
    "inst_projection_ready",
    "inst_projection_destroyed",
    "inst_projection_exported",
  ]);
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
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_signed_download",
        accountId: "acct_signed_download",
        workspaceId: "space_signed_download",
        appId: "example.signed",
        source: {
          gitUrl: "https://github.com/example/signed",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_signed_download_owner",
      }),
    }),
  );
  const exportResponse = await handler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_signed_download/export",
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
      `https://accounts.example.test/v1/capsule-projections/inst_signed_download/exports/${exported.operationId}/download`,
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
      `https://accounts.example.test/v1/capsule-projections/inst_signed_download/exports/${exported.operationId}/download`,
    ),
  );
  expect(noSecretDownload.status).toEqual(503);

  const insecureStore = new InMemoryAccountsStore();
  const insecureHandler = createAccountsHandler({
    store: insecureStore,
    exportDownloadSigningSecret: "f6-test-signing-secret",
    exportWorker: () => ({
      downloadUrl: "http://downloads.example.test/signed/takos-export.tar.zst",
      downloadExpiresAt: "2999-05-10T00:00:00.000Z",
    }),
  });
  await insecureHandler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId: "inst_insecure_download",
        accountId: "acct_insecure_download",
        workspaceId: "space_insecure_download",
        appId: "example.signed",
        source: {
          gitUrl: "https://github.com/example/signed",
          ref: "v1.0.0",
          commit: "0123456789abcdef0123456789abcdef01234567",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_insecure_download_owner",
      }),
    }),
  );
  const insecureExportResponse = await insecureHandler(
    new Request(
      "https://accounts.example.test/v1/capsule-projections/inst_insecure_download/export",
      {
        method: "POST",
        headers: { "Idempotency-Key": "idem-insecure-export" },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: {},
        }),
      },
    ),
  );
  const insecureExported = await insecureExportResponse.json();
  expect(insecureExported.status).toEqual("failed");
  expect(insecureExported.downloadUrl).toEqual(null);
  expect(insecureExported.error).toEqual(
    "export worker returned an unsupported downloadUrl",
  );
  const insecureDownloadResponse = await insecureHandler(
    new Request(
      `https://accounts.example.test/v1/capsule-projections/inst_insecure_download/exports/${insecureExported.operationId}/download`,
    ),
  );
  expect(insecureDownloadResponse.status).toEqual(409);
  expect((await insecureDownloadResponse.json()).error.code).toEqual(
    "export_failed",
  );
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
        `${issuer}/oauth/authorize?response_type=code&client_id=rate-limit-client&redirect_uri=${encodeURIComponent(
          "https://app.example.test/callback",
        )}&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ&code_challenge_method=S256&scope=openid&state=rl-${i}`,
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

async function createReadyLaunchCapsule(
  handler: (request: Request) => Promise<Response>,
  capsuleId: string,
): Promise<void> {
  const response = await handler(
    new Request("https://accounts.example.test/v1/capsule-projections", {
      method: "POST",
      body: JSON.stringify({
        capsuleId,
        accountId: "acct_1",
        workspaceId: "space_1",
        appId: "takos.chat",
        source: {
          gitUrl: "https://github.com/takos/takos",
          ref: "v1.2.3",
          commit: "abc123",
          planDigest: "sha256:app",
        },
        mode: "shared-cell",
        status: "ready",
        createdBySubject: "tsub_owner",
      }),
    }),
  );
  expect(response.status).toEqual(202);
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
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
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
  const clientDataJSON = textEncoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: input.challenge,
      origin: input.origin,
    }),
  );
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
  return textEncoder.encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: input.challenge,
      origin: input.origin,
    }),
  );
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
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecodeText(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function base64UrlDecodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

test("handleUserInfo emits a flat space_memberships claim from the token's space", async () => {
  // Regression guard for the installable-app integration break: Office surfaces
  // read a flat `space_memberships`
  // claim for membership checks. UserInfo must expose it derived from the
  // token's accessible space, alongside the canonical `takosumi.space_id`
  // namespace claim.
  const store = new InMemoryAccountsStore();
  const accessToken = "access-membership-1";
  await store.saveAccessToken(accessToken, {
    clientId: "takos-office",
    scope: "openid profile",
    subject: "tsub_membership",
    capsuleId: "inst-membership",
    appId: "takos-office",
    workspaceId: "space-membership",
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

test("the consolidated /v1/connections edge is gone (Connections are /api/v1/connections only)", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = seedAccountSession(store, "tsub_conn_gone");
  const handler = createAccountsHandler({
    issuer: "https://accounts.example.test",
    store,
  });
  // The former account-plane connections edge no longer exists; every method on
  // `/v1/connections` (and item subroutes) falls through to the generic 404.
  for (const [method, path] of [
    ["GET", "/v1/connections?workspaceId=space_conn_gone"],
    ["POST", "/v1/connections"],
    ["POST", "/v1/connections/conn_x/test"],
    ["DELETE", "/v1/connections/conn_x"],
  ] as const) {
    const response = await handler(
      new Request(`https://accounts.example.test${path}`, {
        method,
        headers: {
          ...accountSessionHeaders(sessionId),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      }),
    );
    expect(response.status, `${method} ${path}`).toEqual(404);
  }
});
