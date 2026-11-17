import { expect, test } from "bun:test";
import type { GitInstallPlanVariablePresentation, GitInstallPlanUserAction } from "takosumi-contract";
import { cloudflarePublicUrlDraft, connectionKey, continueVariables, isCloudflarePublicUrl } from "../../../../../dashboard/src/views/new/install-attempt.ts";

const row = { provider: "registry.opentofu.org/cloudflare/cloudflare", moduleLocalName: "cf", autoSelected: true,
  selectedConnectionId: "personal-a", candidates: [{ id: "personal-a", displayName: "Account A", scope: "personal", status: "verified" }] } as const;
const variable: GitInstallPlanVariablePresentation = { name: "arbitrary_endpoint", type: "string", required: true,
  sensitive: false, userEditable: true, format: "cloudflare-workers-url",
  publicEndpoint: { serviceNameVariable: "arbitrary_name", serviceNameSource: "capsule_name", suggestedName: "exact-compiler-name" } };
const action: Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }> = {
  kind: "provide_inputs", modulePath: ".", resources: [], interfaces: [], connections: [row], variables: [variable],
  name: { current: "Human-name", proposed: "Human-name", conflict: false }, missing: [],
};
const choice = { requirementKey: connectionKey(row), connectionId: row.selectedConnectionId, displayName: "Account A",
  provider: row.provider, moduleLocalName: row.moduleLocalName, value: { account_id: "a".repeat(32), workers_subdomain: "confirmed" } };

test("public URL uses the exact server name and one verified selected provider", () => {
  const draft = cloudflarePublicUrlDraft(action, variable, [choice])!;
  expect(draft.value).toBe("https://exact-compiler-name.confirmed.workers.dev");
  expect(continueVariables(action, { arbitrary_endpoint: draft })).toEqual({ ok: true, variables: { arbitrary_endpoint: draft.value } });
  expect(cloudflarePublicUrlDraft(action, variable, [])).toBeUndefined();
  expect(cloudflarePublicUrlDraft(action, variable, [choice, { ...choice, moduleLocalName: "other" }])).toBeUndefined();
  expect(cloudflarePublicUrlDraft(action, variable, [{ ...choice, connectionId: "unselected" }])).toBeUndefined();
  expect(cloudflarePublicUrlDraft(action, variable, [{ ...choice, value: { account_id: "a".repeat(32) } }])).toBeUndefined();
  const ambiguous = { ...action, connections: [row, { ...row, moduleLocalName: "second" }] };
  expect(cloudflarePublicUrlDraft(ambiguous, variable, [choice])).toBeUndefined();
  expect(continueVariables(ambiguous, { arbitrary_endpoint: draft })).toMatchObject({ ok: false, invalid: [variable.name] });
});

test("unknown formats, ordinary URLs and absent or unsafe declarations stay generic", () => {
  for (const field of [
    { ...variable, format: "url" }, { ...variable, format: "future-url" }, { ...variable, publicEndpoint: undefined },
    { ...variable, sensitive: true }, { ...variable, userEditable: false },
    { ...variable, defaultValue: "https://supplied.test" },
  ]) {
    expect(isCloudflarePublicUrl(field)).toBe(false);
    expect(cloudflarePublicUrlDraft(action, field, [choice])).toBeUndefined();
  }
  for (const name of ["", "-invalid", "invalid-", "x.y", "a".repeat(64)]) {
    expect(cloudflarePublicUrlDraft(action, { ...variable, publicEndpoint: { ...variable.publicEndpoint!, suggestedName: name } }, [choice])).toBeUndefined();
    expect(cloudflarePublicUrlDraft(action, variable, [{ ...choice, value: { workers_subdomain: name } }])).toBeUndefined();
  }
});

test("changed name, connection, status and unconfirmed metadata block stale automatic URLs", () => {
  const draft = cloudflarePublicUrlDraft(action, variable, [choice])!;
  for (const current of [
    { ...action, name: { ...action.name, current: "renamed" } },
    { ...action, connections: [{ ...row, selectedConnectionId: "personal-b" }] },
    { ...action, connections: [{ ...row, candidates: [{ ...row.candidates[0], status: "revoked" }] }] },
    { ...action, variables: [{ ...variable, publicEndpoint: { ...variable.publicEndpoint!, suggestedName: "renamed" } }] },
    { ...action, variables: [{ ...variable, format: "url" }] },
  ] as typeof action[]) {
    expect(continueVariables(current, { arbitrary_endpoint: draft })).toMatchObject({ ok: false, invalid: [variable.name] });
  }
  expect(continueVariables(action, { arbitrary_endpoint: { ...draft, publicEndpoint: { ...draft.publicEndpoint!, confirmed: false } } }))
    .toMatchObject({ ok: false, invalid: [variable.name] });
});

test("manual URLs keep ordinary submission and generated values survive same-state resubmission", () => {
  const draft = cloudflarePublicUrlDraft(action, variable, [choice])!;
  expect(continueVariables({ ...action, resubmitVariables: [variable.name] }, { arbitrary_endpoint: draft })).toMatchObject({ ok: true });
  const manual = { value: "https://my-domain.example", touched: true };
  expect(continueVariables({ ...action, name: { ...action.name, current: "renamed" } }, { arbitrary_endpoint: manual }))
    .toEqual({ ok: true, variables: { arbitrary_endpoint: manual.value } });
});
