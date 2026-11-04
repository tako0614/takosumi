import { expect, test } from "bun:test";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import { handleAuthenticatedControlRoute, handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { InMemoryOpenTofuControlStore, planRunExecutionInputsDigestMaterial } from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const OWNER = "tsub_approval_owner";
const MEMBER = "tsub_approval_member";
const CAPSULE = "cap_approval_reauthorization";
const PLAN = "plan_approval_reauthorization";
const TOKEN = "synthetic-approval-pat";
const TOKEN_ID = "pat_approval_reauthorization";
const SESSION_ID = "synthetic-approval-session";

async function fixture(credential: "pat" | "session" | "shared" = "pat") {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, { capsuleId: CAPSULE });
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    interfaceStores: createInMemoryInterfaceStores({ workspaceManagementAuthority: ledger }),
  });
  await core.appOwnership.initializeOwnershipIfMissing({
    capsuleId: CAPSULE, ownerAccountId: OWNER, ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: `apps/${CAPSULE}`,
  });
  await core.appOwnership.putMember({ capsuleId: CAPSULE, accountId: MEMBER, status: "active",
    addedBy: OWNER, createdAt: seeded.capsule.createdAt, updatedAt: seeded.capsule.updatedAt });
  const current = (await core.appOwnership.getOwnership(CAPSULE))!;
  const inputs = { planRunId: PLAN, variables: {} } as const;
  const plan: PlanRun = {
    id: PLAN, workspaceId: seeded.workspace.id, capsuleId: CAPSULE,
    capsuleContext: { workspaceId: seeded.workspace.id, capsuleId: CAPSULE, environment: seeded.capsule.environment },
    capsuleCurrentStateVersionId: null,
    capsuleExecutionAuthorityEpoch: (await ledger.getCapsuleExecutionAuthorityEpoch(CAPSULE))!,
    ownershipEpoch: current.ownershipEpoch, appManagementEpoch: current.managementEpoch,
    source: { kind: "git", url: "https://example.test/approval.git", commit: "a".repeat(40) },
    sourceDigest: "sha256:source", operation: "update", runnerProfileId: "opentofu-default",
    variablesDigest: await stableJsonDigest(inputs.variables),
    executionInputsDigest: await stableJsonDigest(planRunExecutionInputsDigestMaterial(inputs)),
    requiredProviders: [], status: "waiting_approval", requiresApproval: true,
    policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: "sha256:policy",
    planDigest: "sha256:plan", planArtifact: { kind: "runner-local", ref: "rl://approval", digest: "sha256:plan" },
    createdBy: OWNER, auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  const authority = (await ledger.getWorkspaceManagement(seeded.workspace.id))!;
  expect((await ledger.preparePlanRun({ run: plan, inputs,
    expectedWorkspaceManagementAuthority: { ...authority, managementState: "active" },
  })).status).toBe("created");
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject: MEMBER, createdAt: Date.now(), updatedAt: Date.now() });
  const pat = { tokenId: TOKEN_ID, tokenPrefix: "synthetic", subject: MEMBER, name: "approval",
    scopes: ["read", "write"] as const, appIds: [CAPSULE], createdAt: Date.now() };
  accounts.savePersonalAccessToken(TOKEN, pat);
  accounts.saveAccountSession({ sessionId: SESSION_ID, subject: MEMBER, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const membership = { id: "wsm_approval_shared", workspaceId: seeded.workspace.id, accountId: MEMBER,
    roles: ["admin"] as const, status: "active" as const, createdAt: seeded.capsule.createdAt, updatedAt: seeded.capsule.updatedAt };
  if (credential === "shared") await ledger.putWorkspaceMember(membership);
  const operations = {
    ...core,
    appAuthorization: {
      resolveAppAccess: (accountId: string, capsuleId: string) => core.appAccess.resolveAppAccess(accountId, capsuleId),
      listAccessibleApps: core.appAccess.listAccessibleApps.bind(core.appAccess),
    },
  } as unknown as ControlPlaneOperations;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { release = resolve; });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request(`https://app.takosumi.test/api/v1/runs/${PLAN}/approve`, {
    method: "POST", headers: { ...(credential === "pat" ? { authorization: `Bearer ${TOKEN}` }
      : { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION_ID}` }), "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }),
  });
  const clone = request.clone.bind(request);
  request.clone = () => { release(); return clone(); };
  const context = { request, url: new URL(request.url), store: accounts, operations };
  const pending = credential === "shared"
    ? handleAuthenticatedControlRoute({ ...context, subject: MEMBER, credential: "session", requireCurrentMembership: true })
    : handleControlRoute(context);
  return { ledger, core, accounts, pat, membership, pending,
    reading: Promise.race([reading, pending.then(async response => { throw new Error(`approval returned before body read: ${response?.status} ${await response?.clone().text()}`); })]),
    finishBody: () => { body.enqueue(new TextEncoder().encode('{"reason":"reviewed change"}')); body.close(); },
  };
}

for (const change of ["revoked", "expired"] as const) {
  test(`Run approval refuses a session ${change} while its request body is pending`, async () => {
    const h = await fixture("session");
    await h.reading;
    if (change === "revoked") h.accounts.deleteAccountSession(SESSION_ID);
    else h.accounts.saveAccountSession({ sessionId: SESSION_ID, subject: MEMBER, createdAt: 1, expiresAt: Date.now() - 1 });
    h.finishBody();
    expect((await h.pending)?.status).toBe(403);
    expect((await h.ledger.getPlanRun(PLAN))?.approval).toBeUndefined();
  });
}

test("shared-account Run approval retains the current Workspace membership intersection after the body", async () => {
  const h = await fixture("shared");
  await h.reading;
  await h.ledger.putWorkspaceMember({ ...h.membership, status: "suspended" });
  h.finishBody();
  expect((await h.pending)?.status).toBe(403);
  expect((await h.ledger.getPlanRun(PLAN))?.approval).toBeUndefined();
});

for (const credential of ["pat", "session", "shared"] as const) {
  test(`a current app member can approve after the body using ${credential}`, async () => {
    const h = await fixture(credential);
    await h.reading; h.finishBody();
    expect((await h.pending)?.status).toBe(200);
    const stored = (await h.ledger.getPlanRun(PLAN))!;
    expect(stored.status).toBe("succeeded");
    expect(stored.approval?.approvedBy).toBe(MEMBER);
  });
}

for (const change of ["member removed", "PAT revoked", "PAT expired", "PAT write scope removed", "PAT app restriction changed"] as const) {
  test(`Run approval refuses ${change} while its request body is pending`, async () => {
    const h = await fixture();
    await h.reading;
    if (change === "member removed") await h.core.appOwnership.deleteMember(CAPSULE, MEMBER);
    else if (change === "PAT revoked") h.accounts.revokePersonalAccessToken({ subject: MEMBER, tokenId: TOKEN_ID, revokedAt: Date.now() });
    else h.accounts.savePersonalAccessToken(TOKEN, { ...h.pat,
      ...(change === "PAT expired" ? { expiresAt: Date.now() - 1 } : {}),
      ...(change === "PAT write scope removed" ? { scopes: ["read"] } : {}),
      ...(change === "PAT app restriction changed" ? { appIds: ["cap_other"] } : {}),
    });
    h.finishBody();
    const response = await h.pending;
    const stored = (await h.ledger.getPlanRun(PLAN))!;
    expect({ approved: stored.approval !== undefined, status: stored.status,
      approvalAudit: stored.auditEvents.some(event => event.type === "plan.approved") })
      .toEqual({ approved: false, status: "waiting_approval", approvalAudit: false });
    expect(response!.status).toBe(403);
  });
}
