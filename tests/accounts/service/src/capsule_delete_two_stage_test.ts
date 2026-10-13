import { expect, test } from "bun:test";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

async function fixture() {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: "ws_delete424", capsuleId: "cap_delete424",
  });
  await ledger.putCapsule({ ...seeded.capsule, status: "active", currentStateGeneration: 1 });
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
  });
  const accounts = new InMemoryAccountsStore();
  const token = "delete424-session";
  accounts.saveAccount({ subject: "user_test", createdAt: Date.now(), updatedAt: Date.now() });
  accounts.saveAccountSession({ sessionId: token, subject: "user_test", createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  const effects = { immediatePlans: 0 };
  const operations = {
    ...core,
    createCapsuleDestroyPlan: async () => {
      effects.immediatePlans += 1;
      // The real owner-approval/Apply pipeline is separately covered by the
      // internal route E2E. This sentinel proves selection before any Run.
      throw new OpenTofuControllerError("failed_precondition", "explicit Plan path selected", { reason: "test_immediate_plan" });
    },
  } as unknown as ControlPlaneOperations;
  async function request(method: string, suffix = "", bearer = token) {
    const url = new URL(`https://app.example.test/api/v1/capsules/${seeded.capsule.id}${suffix}`);
    const response = await handleControlRoute({
      request: new Request(url, { method, headers: { authorization: `Bearer ${bearer}` } }),
      url, store: accounts, operations,
    });
    expect(response).toBeDefined();
    return response!;
  }
  return { ledger, accounts, core, effects, request, seeded };
}

test("public DELETE reserves seven days, replay preserves reservation, cancel restores, no destroy Plan", async () => {
  const h = await fixture();
  const first = await h.request("DELETE");
  expect(first.status).toBe(202);
  const body = await first.json();
  expect(body.run).toBeUndefined();
  expect(body.graceDays).toBe(7);
  expect(body.capsule.status).toBe("uninstalled");
  expect(body.capsule.uninstall.requester).toBeUndefined();
  expect((await h.ledger.getCapsule(h.seeded.capsule.id))?.uninstall?.requester).toEqual({ subject: "user_test" });
  expect(Date.parse(body.capsule.uninstall.scheduledDestroyAt) - Date.parse(body.capsule.uninstall.requestedAt)).toBe(604800000);
  const retries = await Promise.all([h.request("DELETE"), h.request("DELETE", "?immediate=false")]);
  for (const response of retries) {
    expect([202, 409]).toContain(response.status);
    if (response.status === 202) {
      expect((await response.json()).capsule.uninstall).toEqual(body.capsule.uninstall);
    }
  }
  const replay = await h.request("DELETE");
  expect(replay.status).toBe(202);
  expect((await replay.json()).capsule.uninstall).toEqual(body.capsule.uninstall);
  for (let n = 0; n < 2; n++) {
    const cancelled = await h.request("POST", "/cancel-uninstall");
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).capsule).toMatchObject({ status: "active", currentStateGeneration: 1, uninstall: { phase: "cancelled" } });
  }
  const events = await h.ledger.listActivityEvents(h.seeded.workspace.id);
  expect(events.filter(event => event.action === "capsule.uninstall_scheduled")).toHaveLength(1);
  expect(events.filter(event => event.action === "capsule.uninstall_cancelled")).toHaveLength(1);
  expect(events.filter(event => event.action.startsWith("capsule.uninstall_")).every(event => event.actorId === "user_test" && Boolean(event.createdAt))).toBe(true);
  expect(h.effects.immediatePlans).toBe(0);
  expect(await h.ledger.listRunsByWorkspace(h.seeded.workspace.id)).toHaveLength(0);
});

test("public DELETE explicit grace persists requester privately", async () => {
  const h = await fixture();
  const response = await h.request("DELETE", "?immediate=false");
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.capsule.uninstall.requester).toBeUndefined();
  expect((await h.ledger.getCapsule(h.seeded.capsule.id))?.uninstall?.requester).toEqual({ subject: "user_test" });
  expect(h.effects.immediatePlans).toBe(0);
  expect(await h.ledger.listRunsByWorkspace(h.seeded.workspace.id)).toHaveLength(0);
});

test("public immediate DELETE requires exact explicit opt-in; invalid/duplicate values do nothing", async () => {
  const h = await fixture();
  for (const suffix of ["?immediate=1", "?immediate=", "?immediate=TRUE", "?immediate=true&immediate=false", "?immediate=true&immediate=true"]) {
    const response = await h.request("DELETE", suffix);
    expect(response.status, suffix).toBe(400);
    expect(h.effects.immediatePlans).toBe(0);
    expect((await h.ledger.getCapsule(h.seeded.capsule.id))?.status).toBe("active");
  }
  const explicit = await h.request("DELETE", "?immediate=true");
  expect(explicit.status).toBe(409);
  expect((await explicit.json()).error.details.reason).toBe("test_immediate_plan");
  expect(h.effects.immediatePlans).toBe(1);
  expect((await h.ledger.getCapsule(h.seeded.capsule.id))?.status).toBe("active");
  const wrongMethod = await h.request("DELETE", "/uninstall");
  expect(wrongMethod.status).toBe(405);
  expect(h.effects.immediatePlans).toBe(1);
});

test("member cannot reserve/cancel/immediately delete and refusal records trusted actor and reason", async () => {
  const h = await fixture();
  const now = Date.now();
  h.accounts.saveAccount({ subject: "member424", createdAt: now, updatedAt: now });
  h.accounts.saveAccountSession({ sessionId: "member424-session", subject: "member424", createdAt: now, expiresAt: now + 60000 });
  await h.ledger.putWorkspaceMember({ id: "wsm_member424", workspaceId: h.seeded.workspace.id, accountId: "member424", roles: ["member"], status: "active", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
  for (const [method, suffix] of [["DELETE", ""], ["DELETE", "?immediate=true"], ["POST", "/cancel-uninstall"], ["POST", "/uninstall"], ["POST", "/destroy-plan"]]) {
    expect((await h.request(method!, suffix!, "member424-session")).status).toBe(403);
  }
  expect(h.effects.immediatePlans).toBe(0);
  expect((await h.ledger.getCapsule(h.seeded.capsule.id))?.status).toBe("active");
  const rejected = (await h.ledger.listActivityEvents(h.seeded.workspace.id)).filter(event => event.action === "capsule.deletion_rejected");
  expect(rejected).toHaveLength(5);
  expect(rejected.every(event => event.actorId === "member424" && Boolean(event.createdAt) && event.metadata?.reason === "workspace_access_denied")).toBe(true);
});

test("read-only PAT cannot delete, and scope rejection resolves no Capsule", async () => {
  const h = await fixture();
  h.accounts.savePersonalAccessToken("read424", { tokenId: "pat_read424", tokenPrefix: "display", subject: "user_test", name: "read only", scopes: ["read"], createdAt: Date.now() });
  for (const suffix of ["", "?immediate=true"]) {
    const response = await h.request("DELETE", suffix, "read424");
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("insufficient_scope");
  }
  expect(h.effects.immediatePlans).toBe(0);
  expect((await h.ledger.getCapsule(h.seeded.capsule.id))?.status).toBe("active");
  expect(await h.ledger.listActivityEvents(h.seeded.workspace.id)).toHaveLength(0);
});

test("destroyed public DELETE replay returns terminal Capsule and no reservation or Plan", async () => {
  const h = await fixture();
  const current = (await h.ledger.getCapsule(h.seeded.capsule.id))!;
  await h.ledger.putCapsule({ ...current, status: "destroyed" });
  for (const suffix of ["", "?immediate=true"]) {
    const response = await h.request("DELETE", suffix);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ alreadyDeleted: true, capsule: { status: "destroyed" } });
  }
  expect(h.effects.immediatePlans).toBe(0);
});
