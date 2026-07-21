import { expect, test } from "bun:test";
import {
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "../../../../core/domains/deploy-control/runner_profiles.ts";
import { evaluatePolicy } from "../../../../core/domains/deploy-control/policy.ts";

const SEEDS = createDefaultRunnerProfiles(123);

test("seeds one provider-neutral OpenTofu profile", () => {
  expect(SEEDS).toHaveLength(1);
  expect(SEEDS[0]).toMatchObject({
    id: DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: ["*"],
    requireProviderBindings: false,
    networkPolicy: { mode: "operator-managed" },
  });
  expect(SEEDS[0]?.labels).toBeUndefined();
  expect(SEEDS[0]?.networkPolicy?.allowedHosts).toBeUndefined();
  expect(SEEDS[0]?.networkPolicy?.allowedHostPatterns).toBeUndefined();
});

test("empty profile configuration selects the provider-neutral default", () => {
  for (const input of [undefined, "", "   ", " , ,"]) {
    expect(parseEnabledRunnerProfileIds(input)).toEqual([
      DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
    ]);
    expect(
      resolveEnabledRunnerProfiles(SEEDS, input).map((row) => row.id),
    ).toEqual([DEFAULT_OPENTOFU_RUNNER_PROFILE_ID]);
  }
});

test("explicit profile ids are trimmed, deduplicated, and operator-curated", () => {
  const privateNetwork = {
    ...SEEDS[0]!,
    id: "private-network",
    lifecycle: { state: "candidate" } as const,
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
  expect(enabled.every((row) => row.lifecycle.state === "active")).toBe(true);
  expect(enabled.every((row) => row.labels === undefined)).toBe(true);
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
  const candidate = {
    ...SEEDS[0]!,
    id: "candidate",
    lifecycle: { state: "candidate" } as const,
  };
  resolveEnabledRunnerProfiles([candidate], "candidate");
  expect(candidate.lifecycle.state).toBe("candidate");
  expect(candidate.labels).toBeUndefined();
});

test("reserved and unavailable profiles fail closed without label overrides", () => {
  const seed = SEEDS[0]!;
  expect(() =>
    resolveEnabledRunnerProfiles(
      [
        {
          ...seed,
          lifecycle: { state: "reserved", reason: "operator hold" },
        },
      ],
      seed.id,
    ),
  ).toThrow("reserved");
  expect(() =>
    resolveEnabledRunnerProfiles(
      [
        {
          ...seed,
          availability: { state: "unavailable", reason: "maintenance" },
          labels: { enabled: "true" },
        },
      ],
      seed.id,
    ),
  ).toThrow("maintenance");
});

test("labels cannot activate a candidate profile", () => {
  const profile = {
    ...SEEDS[0]!,
    lifecycle: { state: "candidate" } as const,
    labels: { enabled: "true", state: "active" },
  };
  const decision = evaluatePolicy({
    profile,
    requiredProviders: ["registry.example.com/acme/custom"],
    checkedAt: 123,
  });
  expect(decision.status).toBe("blocked");
  expect(decision.reasons.join("\n")).toContain("lifecycle is candidate");
});

test("a secret exposure policy the runner boundary cannot enforce fails closed", () => {
  const seed = SEEDS[0]!;
  const activate = (secretExposurePolicy: unknown) =>
    resolveEnabledRunnerProfiles(
      [
        {
          ...seed,
          secretExposurePolicy:
            secretExposurePolicy as typeof seed.secretExposurePolicy,
        },
      ],
      seed.id,
    );

  // An operator writing something stricter-sounding than the enforced set must
  // not get a profile that silently ignores it.
  expect(() =>
    activate({
      providerCredentials: "vault-only",
      tenantWorkerOperatorSecrets: "forbidden",
    }),
  ).toThrow("unenforceable secretExposurePolicy.providerCredentials");
  expect(() =>
    activate({
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "operator-audited",
    }),
  ).toThrow("unenforceable secretExposurePolicy.tenantWorkerOperatorSecrets");
  expect(() =>
    activate({
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: false,
    }),
  ).toThrow("cannot disable secretExposurePolicy.redactLogs");

  expect(
    activate({
      providerCredentials: "forbidden",
      tenantWorkerOperatorSecrets: "forbidden",
    })[0]?.secretExposurePolicy?.providerCredentials,
  ).toBe("forbidden");
});
