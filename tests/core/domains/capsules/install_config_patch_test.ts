import { expect, test } from "bun:test";
import { INSTALL_CONFIG_PATCH_V1_KIND } from "takosumi-contract/install-configs";
import { parseInstallConfigPatchV1 } from "../../../../core/domains/capsules/install_config_patch.ts";

function patch() {
  return {
    kind: INSTALL_CONFIG_PATCH_V1_KIND,
    variableMapping: { target: "cloudflare" },
    variablePresentation: [
      {
        name: "project_name",
        type: "string",
        format: "subdomain",
        required: true,
        defaultValue: { source: "capsule_name" },
        label: { ja: "リソース名", en: "Resource name" },
      },
    ],
    installExperience: {
      projections: [
        { kind: "service_name", variable: "project_name" },
        {
          kind: "public_endpoint",
          variables: { url: "public_url" },
          baseDomain: "app.takos.jp",
        },
      ],
    },
    outputAllowlist: {
      launch_url: { from: "launch_url", type: "url", required: true },
    },
    interfaceBlueprints: [
      {
        key: "takos.launcher",
        name: "takos.launcher",
        spec: {
          type: "interface.ui.surface",
          version: "1",
          document: { launcher: true, display: { title: "Takos" } },
          inputs: {
            url: { source: "capsule_output", outputName: "launch_url" },
          },
          access: { visibility: "workspace" },
        },
      },
    ],
    lifecycleActions: [
      {
        apiVersion: "takosumi.dev/v1alpha1",
        kind: "command",
        id: "activate",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "scripts/control/takosumi-release.mjs", "production"],
        runnerCapability: "capsule.lifecycle.command.v1",
      },
    ],
    lifecycleActionPolicy: {
      allowedExecutors: ["operator"],
      allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
    },
  };
}

test("parses the complete Takos release InstallConfig contribution without translation", () => {
  expect(parseInstallConfigPatchV1(patch())).toEqual(patch());
});

test("rejects unknown patch versions and silently ignored fields", () => {
  expect(() =>
    parseInstallConfigPatchV1({
      ...patch(),
      kind: "takosumi.install-config-patch@v2",
    }),
  ).toThrow(/kind must be takosumi\.install-config-patch@v1/u);
  expect(() =>
    parseInstallConfigPatchV1({ ...patch(), releaseTag: "latest" }),
  ).toThrow(/unknown field releaseTag/u);
  expect(() =>
    parseInstallConfigPatchV1({
      ...patch(),
      outputAllowlist: {
        launch_url: {
          from: "launch_url",
          type: "url",
          repositoryManifest: true,
        },
      },
    }),
  ).toThrow(/unknown field repositoryManifest/u);
});

test("rejects an empty versioned patch", () => {
  expect(() =>
    parseInstallConfigPatchV1({ kind: INSTALL_CONFIG_PATCH_V1_KIND }),
  ).toThrow(/at least one mutable field/u);
});
