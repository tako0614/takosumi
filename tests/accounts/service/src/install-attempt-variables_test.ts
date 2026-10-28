import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  attemptInputFacts,
  checkAttemptVariables,
} from "../../../../accounts/service/src/control/install-attempt-facts.ts";

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
