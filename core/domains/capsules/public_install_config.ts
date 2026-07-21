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
import { isSecretKey, REDACTED_VALUE } from "takosumi-contract/redaction";

export function publicInstallConfigRecord(
  config: InstallConfig,
): PublicInstallConfig {
  const { runnerId: _runnerId, internal: _internal, ...publicRecord } = config;
  const store = config.store;
  return {
    ...publicRecord,
    variableMapping: redactedInstallConfigVariableMapping(config),
    ...(store ? { store } : {}),
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
      declaredSecret.has(name) || isSecretKey(name) ? REDACTED_VALUE : value;
  }
  return redacted;
}
