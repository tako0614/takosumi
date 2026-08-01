import { expect, test } from "bun:test";

import {
  HOST_RUNTIME_MATERIALIZATION_CONTRACT,
  parseInstallConfigHostRuntimeMaterialization,
} from "../../contract/host-runtime-materialization.ts";

function declaration() {
  return {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    requirements: [
      {
        kind: "generated_secret",
        binding: "APP_SECRET",
        secretRef: "secret:app/main",
        bytes: 32,
        encoding: "base64url",
      },
      {
        kind: "resource_binding",
        binding: "RUNTIME_GATEWAY",
        connectionAlias: "queue",
        requiredPermission: "queue.consume",
      },
      {
        kind: "public_oidc",
        id: "identity",
        callbackPath: "/auth/callback",
        scopes: ["openid", "profile"],
        bindings: {
          issuerUrl: {
            binding: "OIDC_ISSUER",
            capabilityRef: "capability:oidc/issuer",
          },
          clientId: {
            binding: "OIDC_CLIENT_ID",
            capabilityRef: "capability:oidc/client-id",
          },
          ownerSubject: {
            binding: "OIDC_OWNER_SUB",
            capabilityRef: "capability:oidc/owner-subject",
          },
          redirectUri: {
            binding: "OIDC_REDIRECT_URI",
            capabilityRef: "capability:oidc/redirect-uri",
          },
        },
      },
    ],
    backgroundActivations: [
      {
        id: "delivery",
        sourceResourceKind: "Queue",
        sourceConnectionAlias: "queue",
        deadLetterConnectionAlias: "dead_letter",
        entrypoint: "deliver",
        retry: {
          maxAttempts: 4,
          retryDelaySeconds: 30,
          onExhausted: "dead_letter",
        },
      },
    ],
  };
}

test("DB-owned host runtime declaration contains refs only and parses strictly", () => {
  const parsed = parseInstallConfigHostRuntimeMaterialization(declaration());
  expect(parsed).toEqual(declaration());
  const encoded = JSON.stringify(parsed);
  expect(encoded).not.toContain("Bearer ");
  expect(encoded).not.toContain("cloudflare");
  expect(encoded).not.toContain("providerNativeId");
});

test("host runtime declaration rejects plaintext-shaped refs, duplicate bindings, and invalid retry", () => {
  const plaintext = structuredClone(declaration());
  plaintext.requirements[0]!.secretRef = "secret=plaintext";
  expect(() => parseInstallConfigHostRuntimeMaterialization(plaintext)).toThrow(
    "opaque ref",
  );

  const duplicate = structuredClone(declaration());
  duplicate.requirements[1]!.binding = "APP_SECRET";
  expect(() => parseInstallConfigHostRuntimeMaterialization(duplicate)).toThrow(
    "binding must be unique",
  );

  const retry = structuredClone(declaration());
  retry.backgroundActivations[0]!.retry.onExhausted = "dead_letter";
  delete retry.backgroundActivations[0]!.deadLetterConnectionAlias;
  expect(() => parseInstallConfigHostRuntimeMaterialization(retry)).toThrow(
    "retry policy",
  );

  const missingSourceKind = structuredClone(declaration()) as {
    backgroundActivations: Array<Record<string, unknown>>;
  };
  delete missingSourceKind.backgroundActivations[0]!.sourceResourceKind;
  expect(() =>
    parseInstallConfigHostRuntimeMaterialization(missingSourceKind),
  ).toThrow("source kind");

  const legacy = structuredClone(declaration()) as {
    requirements: Array<Record<string, unknown>>;
  };
  legacy.requirements[1]!.kind = "managed_connection";
  legacy.requirements[1]!.capabilityRef = "capability:queue/consumer";
  expect(() => parseInstallConfigHostRuntimeMaterialization(legacy)).toThrow(
    "kind is invalid",
  );
});
