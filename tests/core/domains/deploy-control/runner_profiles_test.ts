import { expect, test } from "bun:test";
import {
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "../../../../core/domains/deploy-control/mod.ts";
import { evaluatePolicy } from "../../../../core/domains/deploy-control/policy.ts";

const SEEDS = createDefaultRunnerProfiles(123);

test("seeds one provider-neutral OpenTofu profile", () => {
  expect(SEEDS).toHaveLength(1);
  expect(SEEDS[0]).toMatchObject({
    id: DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
    allowedProviders: ["*"],
    requireCredentialRefs: false,
    networkPolicy: { mode: "operator-managed" },
  });
  expect(SEEDS[0]?.labels).toMatchObject({
    "takosumi.com/opentofu-runner": "true",
    "takosumi.com/provider-installation": "direct-allowed",
  });
  expect(SEEDS[0]?.networkPolicy?.allowedHosts).toBeUndefined();
  expect(SEEDS[0]?.networkPolicy?.allowedHostPatterns).toBeUndefined();
});

test("empty profile configuration selects the provider-neutral default", () => {
  for (const input of [undefined, "", "   ", " , ,"]) {
    expect(parseEnabledRunnerProfileIds(input)).toEqual([
      DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
    ]);
    expect(resolveEnabledRunnerProfiles(SEEDS, input).map((row) => row.id)).toEqual(
      [DEFAULT_OPENTOFU_RUNNER_PROFILE_ID],
    );
  }
});

test("explicit profile ids are trimmed, deduplicated, and operator-curated", () => {
  const privateNetwork = {
    ...SEEDS[0]!,
    id: "private-network",
    networkPolicy: { mode: "operator-managed" },
  };
  const enabled = resolveEnabledRunnerProfiles(
    [...SEEDS, privateNetwork],
    " private-network, opentofu-default,private-network,missing ",
  );
  expect(enabled.map((row) => row.id)).toEqual([
    "private-network",
    DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  ]);
  expect(
    enabled.every(
      (row) => row.labels?.["takosumi.com/profile-enabled"] === "true",
    ),
  ).toBe(true);
});

test("an all-unknown explicit profile set fails closed", () => {
  expect(resolveEnabledRunnerProfiles(SEEDS, "missing,also-missing")).toEqual(
    [],
  );
});

test("the same profile admits known and arbitrary provider sources", () => {
  const profile = resolveEnabledRunnerProfiles(SEEDS, undefined)[0]!;
  for (const providers of [
    ["registry.opentofu.org/cloudflare/cloudflare"],
    ["registry.opentofu.org/vercel/vercel"],
    ["registry.opentofu.org/okta/okta"],
    ["registry.example.com/acme/custom"],
  ]) {
    expect(
      evaluatePolicy({ profile, requiredProviders: providers, checkedAt: 123 }),
    ).toMatchObject({ status: "passed", reasons: [] });
  }
});

test("an explicit provider deny remains authoritative", () => {
  const profile = {
    ...resolveEnabledRunnerProfiles(SEEDS, undefined)[0]!,
    deniedProviders: ["registry.opentofu.org/okta/okta"],
  };
  const decision = evaluatePolicy({
    profile,
    requiredProviders: ["registry.opentofu.org/okta/okta"],
    checkedAt: 123,
  });
  expect(decision.status).toBe("blocked");
  expect(decision.reasons.join("\n")).toContain("is denied");
});

test("enabling a profile does not mutate its seed", () => {
  resolveEnabledRunnerProfiles(SEEDS, undefined);
  expect(SEEDS[0]?.labels?.["takosumi.com/profile-enabled"]).toBeUndefined();
});
