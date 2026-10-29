import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyWorkspacePatAppConversion,
  dryRunWorkspacePatAppConversion,
  WorkspacePatAppConversionConflict,
  type TrustedWorkspaceAppInventory,
} from "../../../../accounts/service/src/pat-app-conversion.ts";
import {
  D1AccountsStore,
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type AccountsStore,
  type PostgresQueryClient,
} from "../../../../accounts/service/src/mod.ts";
import type { PersonalAccessTokenAppAttenuation } from "../../../../accounts/service/src/store.ts";
import { requireAccountsBearer } from "../../../../accounts/service/src/account-session.ts";
import { handleCurrentPersonalAccessTokenAuthority, handlePersonalAccessTokenInventory } from "../../../../accounts/service/src/pat-routes.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const subject = "tsub_pat_conversion";

async function stores(): Promise<readonly { name: string; store: AccountsStore; close: () => Promise<void> }[]> {
  const d1 = new D1AccountsStore(new SqliteFakeD1(), { sessionHashSalt: "isolated-pat-conversion-test-salt" });
  await d1.initialize();
  const db = new PGlite();
  await db.exec(`
    create schema accounts_v1;
    create table accounts_v1.personal_access_tokens (
      token_id text primary key, token_hash text not null, token_prefix text not null,
      subject text not null, name text not null, scopes text[] not null,
      workspace_id text, app_ids text[], created_at timestamptz not null,
      expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz
    );
  `);
  const client: PostgresQueryClient = {
    queryObject: async <T>(sql: string, args: readonly unknown[] = []) => {
      const result = await db.query<T>(sql, [...args]);
      return { rows: [...result.rows] };
    },
  };
  return [
    { name: "memory", store: new InMemoryAccountsStore(), close: async () => {} },
    { name: "d1", store: d1, close: async () => {} },
    { name: "postgres", store: new PostgresAccountsStore(client), close: async () => { await db.close(); } },
  ];
}

test("Workspace PAT conversion uses exact CAS and remains deny-all for empty app snapshots", async () => {
  for (const { name, store, close } of await stores()) {
    try {
      await store.savePersonalAccessToken(`secret-${name}-one`, {
        tokenId: "pat_one", tokenPrefix: "display", subject,
        name: "One", scopes: ["read"], workspaceId: "ws_with_apps", createdAt: 1_000,
      });
      await store.savePersonalAccessToken(`secret-${name}-empty`, {
        tokenId: "pat_empty", tokenPrefix: "display", subject,
        name: "Empty", scopes: ["write"], workspaceId: "ws_empty", createdAt: 2_000,
      });
      const inventory: TrustedWorkspaceAppInventory = {
        listWorkspaceApps: async (workspaceId) => ({
          workspaceId,
          appIds: workspaceId === "ws_with_apps" ? ["cap_b", "cap_a"] : [],
        }),
      };
      const dryRun = await dryRunWorkspacePatAppConversion({ store, reviewedSubjects: [subject], inventory });
      expect(dryRun.tokens).toEqual([
        { subject, tokenId: "pat_one", expectedWorkspaceId: "ws_with_apps", appIds: ["cap_a", "cap_b"] },
        { subject, tokenId: "pat_empty", expectedWorkspaceId: "ws_empty", appIds: [] },
      ]);
      expect(JSON.stringify(dryRun)).not.toContain(`secret-${name}`);
      expect((await store.findPersonalAccessTokenById?.(subject, "pat_one"))?.appIds).toBeUndefined();

      const attenuate = store.attenuatePersonalAccessTokenApps!;
      expect(await attenuate.call(store, { subject: "tsub_other", tokenId: "pat_one", expectedWorkspaceId: "ws_with_apps", appIds: [] })).toBe(false);
      expect(await attenuate.call(store, { subject, tokenId: "pat_one", expectedWorkspaceId: "ws_wrong", appIds: [] })).toBe(false);
      expect(await attenuate.call(store, { subject, tokenId: "pat_missing", expectedWorkspaceId: "ws_with_apps", appIds: [] })).toBe(false);
      expect(await applyWorkspacePatAppConversion({ store, plan: dryRun, inventory })).toEqual({ converted: 2 });
      expect(await attenuate.call(store, { subject, tokenId: "pat_one", expectedWorkspaceId: "ws_with_apps", appIds: ["cap_extra"] })).toBe(false);
      expect(await store.findPersonalAccessTokenById?.(subject, "pat_one")).toMatchObject({
        workspaceId: "ws_with_apps", appIds: ["cap_a", "cap_b"],
      });
      expect(await store.findPersonalAccessTokenById?.(subject, "pat_empty")).toMatchObject({
        workspaceId: "ws_empty", appIds: [],
      });
      if (name !== "postgres") {
        const now = Date.now();
        await store.saveAccount({ subject, createdAt: now, updatedAt: now });
        await store.saveAccountSession({
          sessionId: `sess_${name}_conversion`, subject, createdAt: now, expiresAt: now + 60_000,
        });
        const bearer = await requireAccountsBearer({
          request: new Request("https://accounts.example.test/api/v1/apps", {
            headers: { authorization: `Bearer secret-${name}-empty` },
          }),
          store, scope: "write",
        });
        expect(bearer.ok).toBe(true);
        if (bearer.ok) expect(bearer.auth.appIds).toEqual([]);
        const current = await handleCurrentPersonalAccessTokenAuthority({
          request: new Request("https://accounts.example.test/api/v1/account/tokens/current", {
            headers: { authorization: `Bearer secret-${name}-empty` },
          }),
          store,
          membershipReader: { getMember: async (workspaceId, accountId) => ({
            workspaceId, accountId, roles: ["owner"], status: "active",
          }) },
        });
        expect(current.status).toBe(200);
        expect(await current.json()).toMatchObject({ appIds: [], app_ids: [], workspace_id: "ws_empty" });
        const url = new URL("https://accounts.example.test/api/v1/account/tokens/inventory.v1");
        const inventoryResponse = await handlePersonalAccessTokenInventory({
          request: new Request(url, { headers: { authorization: `Bearer sess_${name}_conversion` } }),
          url, store,
        });
        expect(inventoryResponse.status).toBe(200);
        const inventoryBody = await inventoryResponse.json() as { tokens: { token_id: string; appIds?: string[]; app_ids?: string[] }[] };
        expect(inventoryBody.tokens.find((token) => token.token_id === "pat_empty"))
          .toMatchObject({ appIds: [], app_ids: [] });
      }
      const repeated = await dryRunWorkspacePatAppConversion({ store, reviewedSubjects: [subject], inventory });
      expect(repeated.tokens).toEqual([]);
      expect(await applyWorkspacePatAppConversion({ store, plan: repeated, inventory })).toEqual({ converted: 0 });
      await expect(applyWorkspacePatAppConversion({ store, plan: dryRun, inventory }))
        .rejects.toBeInstanceOf(WorkspacePatAppConversionConflict);
      await store.savePersonalAccessToken(`secret-${name}-race`, {
        tokenId: "pat_race", tokenPrefix: "display", subject,
        name: "Race", scopes: ["read"], workspaceId: "ws_with_apps", createdAt: 3_000,
      });
      const race = await Promise.all([
        attenuate.call(store, { subject, tokenId: "pat_race", expectedWorkspaceId: "ws_with_apps", appIds: ["cap_a"] }),
        attenuate.call(store, { subject, tokenId: "pat_race", expectedWorkspaceId: "ws_with_apps", appIds: ["cap_b"] }),
      ]);
      expect(race.filter(Boolean)).toHaveLength(1);
      expect((await store.findPersonalAccessTokenById?.(subject, "pat_race"))?.appIds).toHaveLength(1);
    } finally {
      await close();
    }
  }
});

test("conversion refuses changed Control inventory before any PAT mutation", async () => {
  const store = new InMemoryAccountsStore();
  store.savePersonalAccessToken("secret-drift", {
    tokenId: "pat_drift", tokenPrefix: "display", subject,
    name: "Drift", scopes: ["read"], workspaceId: "ws_drift", createdAt: 1_000,
  });
  let apps = ["cap_original"];
  const inventory: TrustedWorkspaceAppInventory = {
    listWorkspaceApps: async (workspaceId) => ({ workspaceId, appIds: apps }),
  };
  const plan = await dryRunWorkspacePatAppConversion({ store, reviewedSubjects: [subject], inventory });
  apps = ["cap_changed"];
  await expect(applyWorkspacePatAppConversion({ store, plan, inventory }))
    .rejects.toBeInstanceOf(WorkspacePatAppConversionConflict);
  expect(store.findPersonalAccessTokenById(subject, "pat_drift")?.appIds).toBeUndefined();
});

test("conversion reports an exact partial count when a token loses its CAS race", async () => {
  class RacingStore extends InMemoryAccountsStore {
    override attenuatePersonalAccessTokenApps(input: PersonalAccessTokenAppAttenuation): boolean {
      if (input.tokenId === "pat_second") {
        super.attenuatePersonalAccessTokenApps({ ...input, appIds: ["cap_concurrent"] });
      }
      return super.attenuatePersonalAccessTokenApps(input);
    }
  }
  const store = new RacingStore();
  for (const [tokenId, createdAt] of [["pat_first", 1_000], ["pat_second", 2_000]] as const) {
    store.savePersonalAccessToken(`secret-${tokenId}`, {
      tokenId, tokenPrefix: "display", subject, name: tokenId,
      scopes: ["read"], workspaceId: "ws_race", createdAt,
    });
  }
  const inventory: TrustedWorkspaceAppInventory = {
    listWorkspaceApps: async (workspaceId) => ({ workspaceId, appIds: ["cap_expected"] }),
  };
  const plan = await dryRunWorkspacePatAppConversion({ store, reviewedSubjects: [subject], inventory });
  let conflict: WorkspacePatAppConversionConflict | undefined;
  try {
    await applyWorkspacePatAppConversion({ store, plan, inventory });
  } catch (error) {
    if (error instanceof WorkspacePatAppConversionConflict) conflict = error;
    else throw error;
  }
  expect(conflict?.converted).toBe(1);
  expect(store.findPersonalAccessTokenById(subject, "pat_first")?.appIds).toEqual(["cap_expected"]);
  expect(store.findPersonalAccessTokenById(subject, "pat_second")?.appIds).toEqual(["cap_concurrent"]);
});
