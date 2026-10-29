import { expect, test } from "bun:test";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { validateUninstallRequester } from "../../../../accounts/service/src/uninstall-requester.ts";
import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

for (const credential of ["oauth", "session", "pat"] as const) {
  test(`public uninstall with ${credential} uses real scheduling admission`, async () => {
    const store = new InMemoryOpenTofuControlStore();
    const seeded = await seedCapsuleModel(store);
    await store.putCapsule({ ...seeded.capsule, status: "active", currentStateGeneration: 1 });
    const subject = `tsub_uninstall_${credential}` as const;
    await store.putWorkspace({ ...seeded.workspace, ownerUserId: subject });
    const now = Date.now();
    const accounts = new InMemoryAccountsStore();
    accounts.saveAccount({ subject, createdAt: now, updatedAt: now });
    const secret = `fixture-uninstall-${credential}-credential`;
    if (credential === "oauth") accounts.saveAccessToken(secret, {
      clientId: "fixture-client", subject: "fixture-pairwise-subject", takosumiSubject: subject,
      scope: "capsules:write", workspaceId: seeded.workspace.id, expiresAt: now + 5 * 60_000,
    });
    if (credential === "session") accounts.saveAccountSession({
      sessionId: secret, subject, createdAt: now, expiresAt: now + 5 * 60_000,
    });
    if (credential === "pat") accounts.savePersonalAccessToken(secret, {
      tokenId: "fixture-pat", tokenPrefix: "fixture", subject, name: "uninstall",
      scopes: ["write"], workspaceId: seeded.workspace.id, createdAt: now, expiresAt: now + 8 * 86_400_000,
    });
    const capsules = new CapsulesService({
      store,
      validateUninstallRequesterAt: (requester, workspaceId, validAtMs) =>
        validateUninstallRequester(accounts, requester, workspaceId, validAtMs),
    });
    const operations = {
      capsules, workspaces: new WorkspacesService({ store }), members: { listMembers: async () => [] },
    } as unknown as ControlPlaneOperations;
    const before = await store.getCapsule(seeded.capsule.id);
    const url = new URL(`https://example.test/api/v1/capsules/${seeded.capsule.id}/uninstall`);
    const response = await handleControlRoute({
      request: new Request(url, { method: "POST", headers: { authorization: `Bearer ${secret}` } }),
      url, store: accounts, operations,
    });
    expect(response).toBeDefined();
    const body = await response!.json();
    expect(JSON.stringify(body)).not.toContain(secret);
    if (credential === "oauth") {
      expect(response!.status).toBe(403);
      expect(body).toMatchObject({ error: {
        code: "forbidden",
      } });
      expect(body.error.message).toContain("session");
      expect(body.error.message).toContain("personal access token");
      expect(await store.getCapsule(seeded.capsule.id)).toEqual(before);
      expect(await store.listActivityEvents(seeded.workspace.id, { limit: 100 })).toHaveLength(0);
    } else {
      expect(response!.status).toBe(202);
      expect(body).toMatchObject({ capsule: { status: "uninstalled", uninstall: { phase: "scheduled" } }, graceDays: 7 });
      expect(body.capsule.uninstall).not.toHaveProperty("requester");
      expect((await store.getCapsule(seeded.capsule.id))?.uninstall?.requester).toEqual({
        subject, ...(credential === "pat" ? { grant: { kind: "personal-access-token", tokenId: "fixture-pat" } } : {}),
      });
    }
  });
}
