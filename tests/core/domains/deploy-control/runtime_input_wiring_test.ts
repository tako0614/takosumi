// takos-secret-scan: synthetic — every value here is a literal fixture string.
//
// The contract this file pins: a Provider Connection joins the run-scoped
// sensitive-input lane ONLY through the value-free descriptor pinned on its
// installed Credential Recipe mode. A hosted broker Connection therefore has to
// declare that descriptor to participate at all — and once two Connections
// declare it, the Capsule's single manifest-gated value set has no rule for
// splitting itself, so the ambiguity must stop the Run rather than pick one.
import { expect, test } from "bun:test";
import type { ResolvedCapsuleProviderBinding } from "../../../../core/domains/connections/mod.ts";
import { runtimeInputWiringFromResolved } from "../../../../core/domains/deploy-control/runtime_input_wiring.ts";
import { platformExtensionProviderCredentialComposition } from "../../../../deploy/platform/platform_extension_provider_credentials.ts";

const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const RUNTIME_INPUTS = {
  contract: "takosumi.provider-runtime-inputs/v1",
  nonceArgument: "runtime_input_nonce",
  mapArgument: "runtime_inputs",
  minimumProviderVersion: "4.0.0",
} as const;

function brokerRoutes(
  entries: readonly {
    readonly slug: string;
    readonly connectionId: string;
    readonly recipeId: string;
    readonly runtimeInputs?: unknown;
  }[],
): string {
  return JSON.stringify(
    entries.map((entry) => ({
      basePath: `/extensions/${entry.slug}/marketplace`,
      handlerKey: entry.slug.toUpperCase(),
      authDelivery: "context",
      requiredScopes: [],
      runCredential: {
        audience: `${entry.slug}.takoform.v1`,
        requiredScopes: ["takoform.run"],
      },
      providerCredentialBroker: {
        connectionId: entry.connectionId,
        recipeId: entry.recipeId,
        providerSource: PROVIDER_SOURCE,
        displayName: "Takoform broker",
        exchangePath: "/provider-credentials/takoform",
        publicInputExchangePath: "/public-inputs/http-endpoint",
        envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
        ...(entry.runtimeInputs === undefined
          ? {}
          : { runtimeInputs: entry.runtimeInputs }),
      },
    })),
  );
}

function resolved(
  moduleLocalName: string,
  runtimeInputs: unknown,
): ResolvedCapsuleProviderBinding {
  return {
    provider: PROVIDER_SOURCE,
    moduleLocalName,
    connection: {
      id: `conn_${moduleLocalName}Takoform001`,
      workspaceId: "operator",
      provider: PROVIDER_SOURCE,
      providerSource: PROVIDER_SOURCE,
      scope: { kind: "operator" },
      materialization: "run-issued",
      status: "verified",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      requiredEnvGroups: [["TAKOFORM_TOKEN"]],
      credentialRecipe: {
        id: "broker-takoform-run",
        authMode: "broker",
        ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
      },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    materialization: "run-issued",
  } as ResolvedCapsuleProviderBinding;
}

test("a broker recipe carries the descriptor its route declared, and nothing when it does not", () => {
  const declared = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: brokerRoutes([
      {
        slug: "hosted",
        connectionId: "conn_hostedTakoform0001",
        recipeId: "hosted-takoform-run",
        runtimeInputs: RUNTIME_INPUTS,
      },
    ]),
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  });
  expect(
    declared?.credentialRecipes[0]?.authModes.broker?.runtimeInputs,
  ).toEqual(RUNTIME_INPUTS);

  const silent = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: brokerRoutes([
      {
        slug: "hosted",
        connectionId: "conn_hostedTakoform0001",
        recipeId: "hosted-takoform-run",
      },
    ]),
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  });
  // OSS never infers the protocol from a provider source or a display name: an
  // undeclared mode stays inert instead of baking arguments into a reviewed
  // root that the provider would reject.
  expect(
    silent?.credentialRecipes[0]?.authModes.broker?.runtimeInputs,
  ).toBeUndefined();
});

test("the declaring broker Connection is the selected provider instance", () => {
  const wiring = runtimeInputWiringFromResolved([
    resolved("cloudflare", undefined),
    resolved("takoform", RUNTIME_INPUTS),
  ]);
  expect(wiring).toMatchObject({
    moduleLocalName: "takoform",
    nonceArgument: "runtime_input_nonce",
    mapArgument: "runtime_inputs",
    minimumProviderVersion: "4.0.0",
  });
  // Nothing declaring the protocol means the lane stays inert, not that some
  // provider is guessed into it.
  expect(
    runtimeInputWiringFromResolved([resolved("cloudflare", undefined)]),
  ).toBeUndefined();
});

test("two declaring Connections stop the Run with a legible reason", () => {
  // Both the OSS token recipe and a hosted broker recipe now declare the
  // protocol, so a Workspace that binds both Takoform Connections reaches this
  // fence. Splitting one value set across two providers would hand the same
  // secrets to both.
  let thrown: unknown;
  try {
    runtimeInputWiringFromResolved([
      resolved("takoform", RUNTIME_INPUTS),
      resolved("takoformHosted", RUNTIME_INPUTS),
    ]);
  } catch (error) {
    thrown = error;
  }
  expect(String(thrown)).toContain(
    "more than one resolved Provider Connection declares run-scoped sensitive inputs",
  );
  expect((thrown as { readonly details?: unknown }).details).toMatchObject({
    reason: "runtime_inputs_ambiguous_provider_instance",
  });
});
