import { expect, test } from "bun:test";
import {
  handleCreatePrivacyRequest,
  normalizePrivacyRetentionPolicyRef,
} from "../../../../accounts/service/src/privacy-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

test("privacy requests persist the operator-configured opaque retention policy", async () => {
  const store = new InMemoryAccountsStore();
  const response = await handleCreatePrivacyRequest({
    request: new Request("https://accounts.example.test/v1/account/privacy-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "export" }),
    }),
    store,
    subject: "tsub_owner",
    policyRef: normalizePrivacyRetentionPolicyRef(
      "policy://operator/privacy-retention/v2",
    ),
    now: 1_700_000_000_000,
  });

  expect(response.status).toBe(201);
  const records = await store.listPrivacyRequestsForSubject("tsub_owner");
  expect(records).toHaveLength(1);
  expect(records[0]?.policyRef).toBe("policy://operator/privacy-retention/v2");
});

test("privacy request creation fails closed without a host retention policy", async () => {
  const store = new InMemoryAccountsStore();
  const response = await handleCreatePrivacyRequest({
    request: new Request("https://accounts.example.test/v1/account/privacy-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "delete" }),
    }),
    store,
    subject: "tsub_owner",
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: {
      code: "privacy_policy_unavailable",
      message: "privacy retention policy is not configured",
    },
  });
  expect(await store.listPrivacyRequestsForSubject("tsub_owner")).toEqual([]);
});

test("privacy retention policy references are opaque but strictly lexical", () => {
  expect(normalizePrivacyRetentionPolicyRef(" policy://team/retention@v3 ")).toBe(
    "policy://team/retention@v3",
  );
  expect(() => normalizePrivacyRetentionPolicyRef("cloud policy v1")).toThrow();
});
