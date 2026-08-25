/**
 * Public projection of a service-side InstallConfig.
 *
 * `variableMapping` holds the values a member submitted at install time, and a
 * `variablePresentation` entry may declare an input `secret` — a catalog access
 * token, an upstream API key. Those values are write-only by contract
 * (`AGENTS.md`: "Secret values are write-only to APIs and redacted from logs"),
 * but the per-install config is addressable by id from the Capsule record and
 * authorized by Workspace membership alone, so returning the raw mapping hands
 * every member the plaintext. Both the accounts-plane and the deploy-control
 * capsule routes project through here so the two cannot drift.
 */
import type {
  InstallConfig,
  PublicInstallConfig,
} from "takosumi-contract/install-configs";
import {
  normalizeScopeBoundaryPolicy,
  type JsonValue,
} from "takosumi-contract";
import {
  isSecretKey,
  REDACTED_VALUE,
  redactJsonValue,
} from "takosumi-contract/redaction";

export function publicInstallConfigRecord(
  config: InstallConfig,
): PublicInstallConfig {
  const {
    runnerId: _runnerId,
    internal: _internal,
    requiredInterfaces: _requiredInterfaces,
    runtimeBindingMaterialization: _runtimeBindingMaterialization,
    ...publicRecord
  } = config;
  const store = config.store;
  return {
    ...publicRecord,
    policy: publicPolicyConfig(config.policy),
    variableMapping: redactedInstallConfigVariableMapping(config),
    ...(store ? { store } : {}),
  };
}

function publicPolicyConfig(
  policy: InstallConfig["policy"],
): InstallConfig["policy"] {
  const {
    providerCredentials,
    scopeBoundary: _scopeBoundary,
    ...publicPolicy
  } = policy;
  const normalizedProviderCredentials = providerCredentials
    ? {
        ...(providerCredentials.requiredProviders
          ? {
              requiredProviders: [...providerCredentials.requiredProviders],
            }
          : {}),
        ...(providerCredentials.allowedConnectionIds
          ? { allowedConnectionIds: [...providerCredentials.allowedConnectionIds] }
          : {}),
        ...(providerCredentials.forbiddenConnectionIds
          ? { forbiddenConnectionIds: [...providerCredentials.forbiddenConnectionIds] }
          : {}),
        ...(providerCredentials.requireTemporary === true
          ? { requireTemporary: true }
          : {}),
        ...(providerCredentials.requireTtlEnforced === true
          ? { requireTtlEnforced: true }
          : {}),
      }
    : undefined;
  const scopeBoundary = normalizeScopeBoundaryPolicy(policy.scopeBoundary);
  return {
    ...publicPolicy,
    ...(normalizedProviderCredentials
      ? { providerCredentials: normalizedProviderCredentials }
      : {}),
    ...(scopeBoundary ? { scopeBoundary } : {}),
  };
}

/**
 * Redacts every variable the operator declared `secret`, plus anything whose
 * name reads like a credential even without a declaration — an undeclared
 * `*_token` input is exactly the case a presentation-only check would miss.
 */
export function redactedInstallConfigVariableMapping(
  config: InstallConfig,
): Readonly<Record<string, unknown>> {
  const declaredSecret = new Set(
    (config.variablePresentation ?? [])
      .filter((entry) => entry.secret === true)
      .map((entry) => entry.name),
  );
  const redacted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(config.variableMapping)) {
    redacted[name] =
      declaredSecret.has(name) || isSecretKey(name)
        ? REDACTED_VALUE
        : redactJsonValue(value as JsonValue);
  }
  return redacted;
}
