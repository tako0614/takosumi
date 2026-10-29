import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  attemptInputFacts,
  checkAttemptVariables,
  committedAttemptReviewSummary,
} from "../../../../accounts/service/src/control/install-attempt-facts.ts";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";

const publicUrlVariable = "public_url";
const acceptedProjections = (urlVariable = publicUrlVariable) => [
  { kind: "public_endpoint", variables: { url: urlVariable } },
  {
    kind: "oidc_client",
    variables: {
      accountsUrl: "accounts_url",
      issuerUrl: "issuer_url",
      clientId: "client_id",
      redirectUri: "redirect_uri",
    },
    callbackPath: "/auth/oidc/callback",
    scopes: ["openid"],
  },
] as const;

function config(options: {
  readonly accepted?: boolean;
  readonly repositoryProfile?: boolean;
  readonly requiredSetting?: boolean;
  readonly publicUrlVariable?: string;
  readonly variableMapping?: InstallConfig["variableMapping"];
  readonly installExperience?: InstallConfig["installExperience"];
} = {}): InstallConfig {
  const repositoryProfile = options.repositoryProfile ?? true;
  const endpointVariable = options.publicUrlVariable ?? publicUrlVariable;
  return {
    id: "cfg_install_attempt_variables",
    name: "install-attempt-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variableMapping: options.variableMapping ?? {},
    variablePresentation: [
      {
        name: endpointVariable,
        type: "string",
        required: false,
        label: { ja: "公開 URL", en: "Public URL" },
      },
      ...(endpointVariable === publicUrlVariable
        ? []
        : [{
            name: publicUrlVariable,
            type: "string" as const,
            required: false,
            label: { ja: "任意 URL", en: "Optional URL" },
          }]),
      {
        name: "optional_setting",
        type: "string",
        required: false,
        label: { ja: "任意設定", en: "Optional setting" },
      },
      {
        name: "required_setting",
        type: "string",
        required: options.requiredSetting === true,
        label: { ja: "必須設定", en: "Required setting" },
      },
      {
        name: "number_setting",
        type: "number",
        required: false,
        label: { ja: "数値設定", en: "Number setting" },
      },
    ],
    outputAllowlist: {},
    policy: {},
    ...(repositoryProfile
      ? {
          internal: {
            reason: "per_install_overrides" as const,
            sourceSnapshotId: "snapshot_install_attempt_variables",
            repositoryInstallUxDigest: `sha256:${"a".repeat(64)}`,
          },
        }
      : {}),
    installExperience: options.installExperience ?? {
      projections: acceptedProjections(endpointVariable),
      ...(options.accepted === false
        ? {}
        : { repositoryInstallUx: { status: "accepted" as const } }),
    },
  };
}

function inputFacts(installConfig: InstallConfig = config()) {
  const result = attemptInputFacts({
    modulePath: ".",
    report: {
      rootProviderRequirements: [],
      resources: [],
      rootModuleVariableDeclarations: [],
    } as unknown as CapsuleCompatibilityReport,
    installConfig,
    baseConfig: installConfig,
    repositoryManifest: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected install attempt input facts");
  return result.facts;
}

test("committed review exposes only values backed by accepted non-secret repository presentation", () => {
  const installConfig: InstallConfig = {
    ...config({ variableMapping: {
      public_url: "https://app.example.test",
      api_token: "do-not-project-token",
      generic_setting: "do-not-project-generic",
    } }),
    variablePresentation: [
      { name: "public_url", type: "string", label: { ja: "URL", en: "URL" } },
      { name: "api_token", type: "string", label: { ja: "Token", en: "Token" } },
    ],
  };
  const plan = {
    sourceSnapshotId: "snapshot_install_attempt_variables",
    installConfigBaseId: "cfg_base",
    capsule: { name: "example", environment: "production" },
    options: { interfaceLinks: [
      { requirementKey: "storage", choice: { kind: "interface", interfaceId: "if_storage" } },
      { requirementKey: "cache", choice: { kind: "later" } },
    ] },
    autoSelectedInterfaceKeys: ["storage"],
    attemptFacts: { inputs: {
      modulePath: ".",
      requirements: [],
      resources: [],
      variables: [
        { name: "public_url", type: "string", required: false, sensitive: false },
        { name: "api_token", type: "string", required: false, sensitive: true },
        { name: "generic_setting", type: "string", required: false, sensitive: true },
      ],
    } },
  } as unknown as StoredGitInstallPlan;
  const bindingSet = {
    id: "pbs_review", workspaceId: "ws_review", capsuleId: "cap_review",
    environment: "production", bindings: [], createdAt: "", updatedAt: "",
  };
  const baseConfig: InstallConfig = {
    ...config(), id: "cfg_base", variableMapping: {}, variablePresentation: [],
  };
  const summary = committedAttemptReviewSummary({
    plan, installConfig, baseConfig, bindingSet, connections: [],
  });
  expect(summary.settings).toEqual([
    { name: "public_url", type: "string", required: false, sensitive: false, set: true,
      value: "https://app.example.test" },
    { name: "api_token", sensitive: true, set: true },
    { name: "generic_setting", sensitive: true, set: true },
  ]);
  expect(summary.interfaces).toEqual([
    { requirementKey: "storage", choice: { kind: "interface", interfaceId: "if_storage" }, autoSelected: true },
    { requirementKey: "cache", choice: { kind: "later" }, autoSelected: false },
  ]);
  expect(JSON.stringify(summary)).not.toContain("do-not-project");
  const untrusted = committedAttemptReviewSummary({
    plan, installConfig: {
      ...installConfig,
      internal: { reason: "per_install_overrides", genericOpenTofuVariableContractDigest: "digest" },
    },
    baseConfig, bindingSet, connections: [],
  });
  expect(untrusted.settings[0]).toEqual({ name: "public_url", sensitive: true, set: true });
  expect(JSON.stringify(untrusted)).not.toContain("https://app.example.test");
  const missingBase = committedAttemptReviewSummary({
    plan: { ...plan, installConfigBaseId: undefined }, installConfig,
    bindingSet, connections: [],
  });
  expect(missingBase.settings[0]).toEqual({ name: "public_url", sensitive: true, set: true });
  expect(JSON.stringify(missingBase)).not.toContain("https://app.example.test");
  const operatorOwned = committedAttemptReviewSummary({
    plan, installConfig,
    baseConfig: { ...baseConfig, variableMapping: { public_url: "operator-private-value" } },
    bindingSet, connections: [],
  });
  expect(operatorOwned.settings[0]).toEqual({ name: "public_url", sensitive: true, set: true });
  expect(JSON.stringify(operatorOwned)).not.toContain("operator-private-value");
});

test("provided accepted repository OIDC public URL must be a canonical HTTPS origin", () => {
  const facts = inputFacts();
  expect(
    checkAttemptVariables(facts, {
      [publicUrlVariable]: "https://app.example.test",
      optional_setting: "ordinary value",
    }),
  ).toEqual({ ok: true });

  for (const value of [
    "",
    " ",
    "https://app.example.test ",
    "http://app.example.test",
    "https://app.example.test/path",
    "https://app.example.test/",
    "https://app.example.test:443",
    "https://app.example.test:8443",
    "https://app.example.test?query=1",
    "https://app.example.test#fragment",
    "https://user@app.example.test",
    "https://user:pass@app.example.test",
    "https://APP.example.test",
  ]) {
    const result = checkAttemptVariables(facts, { [publicUrlVariable]: value });
    expect(result).toEqual({
      ok: false,
      reason: "install_variable_invalid",
      names: [publicUrlVariable],
    });
    if (value.length > 0) expect(JSON.stringify(result)).not.toContain(value);
  }
});

test("an absent optional endpoint remains allowed and existing required/type checks remain", () => {
  const facts = inputFacts();
  expect(checkAttemptVariables(facts, {})).toEqual({ ok: true });
  expect(checkAttemptVariables(facts, { number_setting: "wrong type" })).toEqual({
    ok: false,
    reason: "install_variable_type_mismatch",
    names: ["number_setting"],
  });
  expect(checkAttemptVariables(facts, { unrelated: "value" })).toEqual({
    ok: false,
    reason: "install_variable_unknown",
    names: ["unrelated"],
  });
  expect(
    checkAttemptVariables(inputFacts(config({ requiredSetting: true })), {}),
  ).toEqual({
    ok: false,
    reason: "install_variable_required",
    names: ["required_setting"],
  });

  const legacyFacts = {
    modulePath: ".",
    resources: [],
    requirements: [],
    variables: [
      {
        name: publicUrlVariable,
        type: "string" as const,
        required: false,
        sensitive: false,
      },
    ],
  };
  expect(
    checkAttemptVariables(legacyFacts, { [publicUrlVariable]: "http://legacy" }),
  ).toEqual({ ok: true });

  const operatorDefaults = config({
    repositoryProfile: false,
    variableMapping: { [publicUrlVariable]: "https://operator.example.test" },
  });
  expect(checkAttemptVariables(inputFacts(operatorDefaults), {})).toEqual({ ok: true });

  const renamedEndpointFacts = inputFacts(config({
    publicUrlVariable: "application_origin",
  }));
  expect(
    checkAttemptVariables(renamedEndpointFacts, {
      application_origin: "https://app.example.test",
      public_url: "http://ordinary-value",
    }),
  ).toEqual({ ok: true });
  expect(
    checkAttemptVariables(renamedEndpointFacts, {
      application_origin: "http://invalid.example.test",
      public_url: "https://ordinary-value",
    }),
  ).toEqual({
    ok: false,
    reason: "install_variable_invalid",
    names: ["application_origin"],
  });
});

test("manual, unaccepted and binding-delivered projections do not gain URL validation", () => {
  const manual = config({ repositoryProfile: false });
  expect(
    checkAttemptVariables(inputFacts(manual), { [publicUrlVariable]: "http://legacy" }),
  ).toEqual({ ok: true });

  const unaccepted = config({ accepted: false });
  expect(
    checkAttemptVariables(inputFacts(unaccepted), { [publicUrlVariable]: "http://legacy" }),
  ).toEqual({ ok: true });

  const bindingDelivered = config({
    installExperience: {
      projections: [
        {
          kind: "oidc_client",
          variables: {},
          callbackPath: "/auth/oidc/callback",
          scopes: ["openid"],
        },
      ],
      repositoryInstallUx: { status: "accepted" },
    },
  });
  expect(bindingDelivered.internal?.repositoryInstallUxDigest).toBe(
    `sha256:${"a".repeat(64)}`,
  );
  expect(
    checkAttemptVariables(inputFacts(bindingDelivered), {
      [publicUrlVariable]: "http://legacy",
    }),
  ).toEqual({ ok: true });
});

test("a malformed accepted repository profile fails closed without exposing parser details", () => {
  const malformed = config({
    installExperience: {
      projections: [
        ...acceptedProjections(),
        { kind: "public_endpoint", variables: { url: "second_url" } },
      ],
      repositoryInstallUx: { status: "accepted" },
    },
  });
  const result = attemptInputFacts({
    modulePath: ".",
    report: {
      rootProviderRequirements: [],
      resources: [],
      rootModuleVariableDeclarations: [],
    } as unknown as CapsuleCompatibilityReport,
    installConfig: malformed,
    baseConfig: malformed,
    repositoryManifest: true,
  });
  expect(result).toEqual({
    ok: false,
    code: "repository_install_ux_profile_invalid",
    message: "This app's reviewed sign-in settings are invalid.",
  });
  expect(JSON.stringify(result)).not.toContain("public_url");
});
