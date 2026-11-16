import { expect, test } from "bun:test";
import type { ProviderConnection, GitInstallPlanConnectionRequirement } from "takosumi-contract";
import { connectionSettingChoices, continueVariables } from "../../../../../dashboard/src/views/new/install-attempt.ts";
const provider = "registry.opentofu.org/cloudflare/cloudflare";
const requirement: GitInstallPlanConnectionRequirement = { provider, moduleLocalName: "cf", autoSelected: false,
  selectedConnectionId: "a", candidates: [{ id: "a", displayName: "A", scope: "personal", status: "verified" }] };
const connection = { id: "a", providerSource: provider, ownerAccountId: "me", scope: "personal", status: "verified",
  scopeHints: { moduleInputDefaults: { cloudflare_account_id: "a".repeat(32), cloudflare_workers_subdomain: "my-workers", API_TOKEN: "must-not-leave" },
    providerSettings: { accountId: "a".repeat(32), workersSubdomain: "my-workers", access_token: "must-not-leave" } } } as unknown as ProviderConnection;
function choices(row: ProviderConnection = connection, req = requirement) { return connectionSettingChoices([req], [row], "me", "ws"); }
test("provider-owned projection offers only the exact public JSON and optional subdomain", () => {
  expect(choices()[0]?.value).toEqual({ account_id: "a".repeat(32), workers_subdomain: "my-workers" });
  expect(choices({ ...connection, scopeHints: { moduleInputDefaults: { cloudflare_account_id: "a".repeat(32) } } })[0]?.value).toEqual({ account_id: "a".repeat(32) });
  expect(JSON.stringify(choices())).not.toContain("must-not-leave");
});
test("wrong actor, scope, selected id, provider, status and inconsistent account fail closed", () => {
  for (const patch of [{ ownerAccountId: "other" }, { scope: "operator" }, { scope: "workspace", workspaceId: "other" },
    { id: "unselected" }, { providerSource: "registry.opentofu.org/hashicorp/aws" }, { status: "revoked" },
    { scopeHints: { moduleInputDefaults: { cloudflare_account_id: "a".repeat(32) }, providerSettings: { accountId: "b".repeat(32) } } },
    { scopeHints: { moduleInputDefaults: { cloudflare_workers_subdomain: "my-workers" } } }]) {
    expect(choices({ ...connection, ...patch } as ProviderConnection)).toEqual([]);
  }
  expect(choices(connection, { ...requirement, selectedConnectionId: "missing" })).toEqual([]);
});
test("provider instances remain distinct and stale generated settings never reach confirmation", () => {
  const alias = { ...requirement, childAlias: "second", rootAlias: "second" };
  const rows = connectionSettingChoices([requirement, alias], [connection], "me", "ws");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.requirementKey).not.toBe(rows[1]?.requirementKey);
  expect(rows[1]).toMatchObject({ childAlias: "second", rootAlias: "second" });
  const action = { kind: "provide_inputs", modulePath: ".", resources: [], connections: [requirement], interfaces: [],
    variables: [{ name: "not-a-provider-name", type: "json", required: true, sensitive: false }],
    name: { current: "x", proposed: "x", conflict: false }, missing: [] } as const;
  expect(continueVariables(action, {})).toMatchObject({ ok: false, missing: ["not-a-provider-name"] });
  const chosen = rows[0]!;
  const draft = { value: JSON.stringify(chosen.value), touched: true, connectionSetting: chosen };
  expect(continueVariables(action, { "not-a-provider-name": draft })).toMatchObject({ ok: true });
  expect(continueVariables({ ...action, connections: [{ ...requirement, selectedConnectionId: "other" }] }, { "not-a-provider-name": draft })).toMatchObject({ ok: false, invalid: ["not-a-provider-name"] });
});

test("a generated proposal cannot replace a changed sensitive, typed or supplied field", () => {
  const choice = choices()[0]!;
  const draft = { value: JSON.stringify(choice.value), touched: true, connectionSetting: choice };
  for (const variable of [
    { name: "deployment", type: "json", required: true, sensitive: true },
    { name: "deployment", type: "string", required: true, sensitive: false },
    { name: "deployment", type: "json", required: true, sensitive: false, defaultValue: { account_id: "already-provided" } },
    { name: "deployment", type: "json", required: true, sensitive: false, derivedDefault: "capsule_name" },
  ] as const) {
    const action = { kind: "provide_inputs", modulePath: ".", resources: [], connections: [requirement], interfaces: [],
      variables: [variable], name: { current: "x", proposed: "x", conflict: false }, missing: [] } as const;
    expect(continueVariables(action, { deployment: draft })).toMatchObject({ ok: false, invalid: ["deployment"] });
  }
});
