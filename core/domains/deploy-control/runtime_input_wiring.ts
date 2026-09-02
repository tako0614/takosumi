/**
 * Provider-instance selection for run-scoped sensitive inputs.
 *
 * Takosumi learns that a provider understands this protocol from ONE place: the
 * installed CredentialRecipe auth mode pinned on the resolved Provider
 * Connection. Core carries no provider identity of its own, so this module never
 * matches on a provider source, a URL, or a name — only on the pinned,
 * value-free descriptor.
 *
 * Plan and Apply share this selection so the reviewed generated root and the
 * Apply-time mint can never disagree about which provider instance is wired.
 */

import { isProviderRuntimeInputs } from "takosumi-contract/credential-recipes";
import { rootRuntimeInputsVariableName } from "takosumi-rootgen";
import type { ResolvedCapsuleProviderBinding } from "../connections/mod.ts";
import {
  OpenTofuControllerError,
  RUNTIME_INPUTS_AMBIGUOUS_PROVIDER_INSTANCE_REASON,
} from "./errors.ts";
import { runtimeInputProviderInstance } from "./runtime_input_materializer.ts";

/** One provider instance's value-free wiring for run-scoped sensitive inputs. */
export interface RuntimeInputProviderInstanceWiring {
  readonly moduleLocalName: string;
  readonly rootAlias?: string;
  /** Opaque `(moduleLocalName, rootAlias)` provider-instance identity. */
  readonly providerInstance: string;
  /** Exact generated-root ephemeral variable carrying the map. */
  readonly variableName: string;
  readonly nonceArgument: string;
  readonly mapArgument: string;
  /** Lowest exact provider version that accepts the two arguments. */
  readonly minimumProviderVersion: string;
}

/**
 * The single provider instance whose installed recipe mode declares the
 * protocol, or `undefined` when none does.
 *
 * The Capsule's runtime binding profile is one manifest-gated value set, so it
 * has no rule for splitting itself across two declaring providers. Two distinct
 * declaring instances therefore fail closed instead of silently handing the same
 * secrets to both.
 */
export function runtimeInputWiringFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): RuntimeInputProviderInstanceWiring | undefined {
  const byInstance = new Map<string, RuntimeInputProviderInstanceWiring>();
  for (const entry of resolved) {
    const declaration = entry.connection?.credentialRecipe?.runtimeInputs;
    if (!isProviderRuntimeInputs(declaration)) continue;
    const moduleLocalName = entry.moduleLocalName;
    if (entry.alias !== undefined || moduleLocalName === undefined) {
      // The same fence `providerBindingsFromResolved` applies: a deprecated
      // ambiguous alias cannot name an exact root provider instance.
      throw new OpenTofuControllerError(
        "failed_precondition",
        `ProviderBinding ${entry.provider} must declare an exact root provider instance before it can receive run-scoped sensitive inputs`,
        { reason: RUNTIME_INPUTS_AMBIGUOUS_PROVIDER_INSTANCE_REASON },
      );
    }
    const binding = {
      moduleLocalName,
      ...(entry.rootAlias ? { rootAlias: entry.rootAlias } : {}),
    };
    const providerInstance = runtimeInputProviderInstance(binding);
    byInstance.set(providerInstance, {
      ...binding,
      providerInstance,
      variableName: rootRuntimeInputsVariableName(binding),
      nonceArgument: declaration.nonceArgument,
      mapArgument: declaration.mapArgument,
      minimumProviderVersion: declaration.minimumProviderVersion,
    });
  }
  if (byInstance.size === 0) return undefined;
  if (byInstance.size > 1) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "more than one resolved Provider Connection declares run-scoped sensitive inputs; the Capsule runtime binding profile is a single value set with no rule for splitting it",
      { reason: RUNTIME_INPUTS_AMBIGUOUS_PROVIDER_INSTANCE_REASON },
    );
  }
  return byInstance.values().next().value;
}
