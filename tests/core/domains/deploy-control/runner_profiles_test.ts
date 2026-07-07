import { expect, test } from "bun:test";
import {
  CREDENTIAL_FREE_UTILITY_PROVIDER_ADDRESSES,
  createDefaultRunnerProfiles,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "../../../../core/domains/deploy-control/mod.ts";
import { evaluatePolicy } from "../../../../core/domains/deploy-control/policy.ts";

// resolveEnabledRunnerProfiles is the operator-curated provider surface: it maps
// the CSV TAKOSUMI_ENABLED_RUNNER_PROFILES knob onto the default seeds, enabling
// only the listed ids and excluding the rest entirely so an unlisted provider
// never appears in /v1/runner-profiles or policy evaluation.

const SEEDS = createDefaultRunnerProfiles(123);

function idsOf(profiles: readonly { id: string }[]): readonly string[] {
  return profiles.map((profile) => profile.id);
}

test("defaults to cloudflare-default when env value is unset", () => {
  const enabled = resolveEnabledRunnerProfiles(SEEDS, undefined);
  expect(idsOf(enabled)).toEqual(["cloudflare-default"]);
});

test("defaults to cloudflare-default when env value is empty or whitespace", () => {
  expect(idsOf(resolveEnabledRunnerProfiles(SEEDS, ""))).toEqual([
    "cloudflare-default",
  ]);
  expect(idsOf(resolveEnabledRunnerProfiles(SEEDS, "   "))).toEqual([
    "cloudflare-default",
  ]);
  expect(idsOf(resolveEnabledRunnerProfiles(SEEDS, " , ,"))).toEqual([
    "cloudflare-default",
  ]);
});

test("includes multiple listed profiles in env order and excludes the rest", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,aws-provider-env-candidate,kubernetes-provider-env-candidate",
  );
  expect(idsOf(enabled)).toEqual([
    "cloudflare-default",
    "aws-provider-env-candidate",
    "kubernetes-provider-env-candidate",
  ]);
  // Unlisted seeds are excluded entirely.
  expect(idsOf(enabled)).not.toContain("azure-provider-env-candidate");
  expect(idsOf(enabled)).not.toContain("docker-custom-example");
  expect(idsOf(enabled)).not.toContain("generic-opentofu-provider");
});

test("trims whitespace and collapses duplicate ids (first wins)", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    " aws-provider-env-candidate , cloudflare-default , aws-provider-env-candidate ",
  );
  expect(idsOf(enabled)).toEqual([
    "aws-provider-env-candidate",
    "cloudflare-default",
  ]);
});

test("gcp candidate can be explicitly enabled", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "gcp-provider-env-candidate",
  );
  expect(idsOf(enabled)).toEqual(["gcp-provider-env-candidate"]);
  expect(enabled[0]?.labels?.["takosumi.com/profile-enabled"]).toEqual("true");
});

test("generic OpenTofu provider profile can be explicitly enabled", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "generic-opentofu-provider",
  );
  expect(idsOf(enabled)).toEqual(["generic-opentofu-provider"]);
  expect(enabled[0]?.allowedProviders).toEqual(["*"]);
  expect(enabled[0]?.requireCredentialRefs).toBe(false);
  expect(enabled[0]?.networkPolicy).toEqual({ mode: "operator-managed" });
  expect(enabled[0]?.labels?.["takosumi.com/provider-surface"]).toEqual(
    "generic",
  );
  expect(enabled[0]?.labels?.["takosumi.com/profile-enabled"]).toEqual("true");
});

test("Cloud GA surface admits arbitrary providers only through the generic env profile", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,generic-opentofu-provider",
  );
  const byId = new Map(enabled.map((profile) => [profile.id, profile]));
  const arbitraryProviders = [
    "registry.opentofu.org/vercel/vercel",
    "registry.opentofu.org/okta/okta",
  ];

  const cloudflareDecision = evaluatePolicy({
    profile: byId.get("cloudflare-default")!,
    requiredProviders: arbitraryProviders,
    checkedAt: 123,
  });
  expect(cloudflareDecision.status).toBe("blocked");
  expect(cloudflareDecision.reasons.join("\n")).toContain(
    "provider registry.opentofu.org/vercel/vercel is not allowed",
  );

  const utilityDecision = evaluatePolicy({
    profile: byId.get("cloudflare-default")!,
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/http",
    ],
    checkedAt: 123,
  });
  expect(utilityDecision.status).toBe("passed");
  expect(utilityDecision.reasons).toEqual([]);
  expect(byId.get("cloudflare-default")?.allowedProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
    ...CREDENTIAL_FREE_UTILITY_PROVIDER_ADDRESSES,
  ]);

  const genericDecision = evaluatePolicy({
    profile: byId.get("generic-opentofu-provider")!,
    requiredProviders: arbitraryProviders,
    checkedAt: 123,
  });
  expect(genericDecision.status).toBe("passed");
  expect(genericDecision.reasons).toEqual([]);
});

test("generic OpenTofu provider profile does not pretend to own provider API egress hosts", () => {
  const profile = createDefaultRunnerProfiles(123).find(
    (candidate) => candidate.id === "generic-opentofu-provider",
  );

  expect(profile?.allowedProviders).toEqual(["*"]);
  expect(profile?.networkPolicy?.mode).toBe("operator-managed");
  expect(profile?.networkPolicy?.allowedHosts).toBeUndefined();
  expect(profile?.networkPolicy?.allowedHostPatterns).toBeUndefined();
});

test("merges takosumi.com/profile-enabled=true into every enabled profile", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,aws-provider-env-candidate",
  );
  const byId = new Map(enabled.map((profile) => [profile.id, profile]));
  // cloudflare-default carries no candidate-state label but still gets enabled.
  expect(
    byId.get("cloudflare-default")?.labels?.["takosumi.com/profile-enabled"],
  ).toEqual("true");
  expect(
    byId.get("cloudflare-default")?.labels?.["takosumi.com/provider-runner"],
  ).toEqual("true");
  // aws-provider-env-candidate is a candidate seed; its candidate-state label is preserved and the
  // enabled label is merged on so the policy gate lets it pass.
  expect(
    byId.get("aws-provider-env-candidate")?.labels?.[
      "takosumi.com/profile-state"
    ],
  ).toEqual("candidate");
  expect(
    byId.get("aws-provider-env-candidate")?.labels?.[
      "takosumi.com/profile-enabled"
    ],
  ).toEqual("true");
});

test("does not mutate the input seed profiles", () => {
  const before = SEEDS.find(
    (profile) => profile.id === "aws-provider-env-candidate",
  )!;
  resolveEnabledRunnerProfiles(SEEDS, "aws-provider-env-candidate");
  expect(before.labels?.["takosumi.com/profile-enabled"]).toEqual(undefined);
});

test("skips unknown ids without throwing and keeps known ones", () => {
  const enabled = resolveEnabledRunnerProfiles(
    SEEDS,
    "cloudflare-default,does-not-exist,aws-provider-env-candidate",
  );
  expect(idsOf(enabled)).toEqual([
    "cloudflare-default",
    "aws-provider-env-candidate",
  ]);
});

test("returns an empty surface when every listed id is unknown", () => {
  const enabled = resolveEnabledRunnerProfiles(SEEDS, "nope,also-nope");
  expect(enabled).toEqual([]);
});

test("parseEnabledRunnerProfileIds normalizes CSV input", () => {
  expect(parseEnabledRunnerProfileIds(undefined)).toEqual([
    "cloudflare-default",
  ]);
  expect(parseEnabledRunnerProfileIds("")).toEqual(["cloudflare-default"]);
  expect(parseEnabledRunnerProfileIds("a, b ,a,,c")).toEqual(["a", "b", "c"]);
});

test("self-host default-enables the generic wildcard profile when opted in", () => {
  // Unset env + defaultEnableGenericProvider -> cloudflare-default AND the
  // wildcard generic-opentofu-provider surface, so a fresh self-host runs any
  // provider with the user's own key without an operator opt-in.
  expect(parseEnabledRunnerProfileIds(undefined, true)).toEqual([
    "cloudflare-default",
    "generic-opentofu-provider",
  ]);
  const enabled = resolveEnabledRunnerProfiles(SEEDS, undefined, {
    defaultEnableGenericProvider: true,
  });
  expect(idsOf(enabled)).toEqual([
    "cloudflare-default",
    "generic-opentofu-provider",
  ]);
  const generic = enabled.find(
    (profile) => profile.id === "generic-opentofu-provider",
  );
  expect(generic?.allowedProviders).toEqual(["*"]);
  expect(generic?.labels?.["takosumi.com/profile-enabled"]).toEqual("true");
});

test("defaultEnableGenericProvider only applies when the env is unset", () => {
  // An explicit CSV always wins over the self-host default, so an operator can
  // still curate a narrower surface (or omit the generic profile) on purpose.
  const enabled = resolveEnabledRunnerProfiles(SEEDS, "cloudflare-default", {
    defaultEnableGenericProvider: true,
  });
  expect(idsOf(enabled)).toEqual(["cloudflare-default"]);
});
